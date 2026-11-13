'use strict';

// The desktop side of Find repeaters. Parsing and the scan machine are
// pure (lib/repeaterbook.js, lib/repeater-scan.js). This file is the only
// one that talks to RepeaterBook, the IP location service, and the disk
// cache. It never transmits: every tune plan has transmit: false, and a
// PTT event only stops the scan.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const RB = require('./repeaterbook');
const Place = require('./station-place');
const Scan = require('./repeater-scan');

const IP_URL = 'https://ipwho.is/';
const IP_HOST = 'ipwho.is';

function create(deps) {
  const d = deps || {};
  let phone = null;
  let osFix = null;
  let ip = null;
  let ipLoaded = false;
  let scan = Scan.createState([], {});
  let timer = null;
  let gate = { lastAt: 0, blockedUntil: 0 };
  let activity = null;
  let monitorWarned = false;
  let place = null;
  let stateId = '';
  let warning = '';

  function settings() { return (d.getSettings && d.getSettings()) || {}; }
  function log(msg) { try { if (d.log) d.log(msg); } catch { /* logging must not break a tune */ } }

  function httpsGet(url, headers) {
    const transport = d.transport || defaultTransport;
    return transport(url, headers || {});
  }

  function loadIp() {
    if (ipLoaded) return;
    ipLoaded = true;
    try {
      const raw = fs.readFileSync(path.join(cacheDir(), 'ip.json'), 'utf8');
      const j = JSON.parse(raw);
      if (j && Number.isFinite(Number(j.lat))) ip = j;
    } catch { /* no cache yet */ }
  }

  function cacheDir() {
    const dir = d.cacheDir ? d.cacheDir() : '';
    if (dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* read-only */ } }
    return dir;
  }

  function cachePath(key) {
    const dir = cacheDir();
    if (!dir) return '';
    const name = crypto.createHash('sha256').update(key).digest('hex') + '.json';
    return path.join(dir, name);
  }

  function readCache(key) {
    try {
      const j = JSON.parse(fs.readFileSync(cachePath(key), 'utf8'));
      if (j && typeof j.body === 'string') return j;
    } catch { /* miss */ }
    return null;
  }

  function writeCache(key, body) {
    const file = cachePath(key);
    if (!file) return;
    try { fs.writeFileSync(file, JSON.stringify({ at: Date.now(), body })); } catch { /* cache is optional */ }
  }

  async function fetchIp() {
    let res;
    try { res = await httpsGet(IP_URL, { 'User-Agent': RB.UA_PRODUCT + ' (+' + RB.UA_PAGE + ')', Accept: 'application/json' }); }
    catch (e) { log('[Repeaters] IP location failed: ' + (e && e.message ? e.message : e)); return null; }
    if (!res || res.status !== 200) return null;
    const fix = Place.parseIpwho(res.body);
    if (!fix) return null;
    ip = Object.assign({ at: Date.now(), source: 'ip' }, fix);
    try { fs.writeFileSync(path.join(cacheDir(), 'ip.json'), JSON.stringify(ip)); } catch { /* ignore */ }
    return ip;
  }

  async function locate() {
    loadIp();
    const s = settings();
    const manual = s.repeaterPlaceManual;
    const draft = Place.choosePlace({ manual, phone, os: osFix, ip, grid: s.grid, now: Date.now() });
    if (draft && draft.source !== 'grid') { place = draft; return draft; }
    if (!ip || !Place.choosePlace({ ip, now: Date.now() })) {
      await fetchIp();
    }
    place = Place.choosePlace({ manual, phone, os: osFix, ip, grid: s.grid, now: Date.now() });
    return place;
  }

  function guessState(explicit) {
    const picked = RB.stateIdFromName(explicit);
    if (picked) return picked;
    if (place && place.region) {
      const fromRegion = RB.stateIdFromName(place.region);
      if (fromRegion) return fromRegion;
    }
    const box = place ? RB.stateAt(place.lat, place.lon) : '';
    if (box) return box;
    return RB.stateIdFromName(settings().homeState || '');
  }

  async function query(opts) {
    const contact = RB.contactEmail(settings().repeaterbookContact);
    const ua = RB.userAgent(contact);
    if (!ua) {
      return { ok: false, needContact: true, error: 'RepeaterBook needs a contact email. Set Settings → RepeaterBook contact email. Nothing was sent. A CHIRP CSV import does not need one.' };
    }
    const token = String(settings().repeaterbookToken || '').trim();
    if (!token) {
      return { ok: false, needToken: true, error: 'RepeaterBook needs your own token. In Directory → Channels, paste the rbuapp_ token from repeaterbook.com → API Applications, after this fork is approved. A CHIRP CSV import works without one.' };
    }
    if (!/^rbuapp_[A-Za-z0-9._-]+$/.test(token)) {
      return { ok: false, needToken: true, error: 'That token is not a personal rbuapp_ token. RepeaterBook does not allow a shared app_ token in a desktop program. Generate your own, or import a CHIRP CSV.' };
    }
    const url = RB.exportUrl(opts);
    let host = '';
    try { host = new URL(url).hostname; } catch { host = ''; }
    if (host !== RB.EXPORT_HOST) return { ok: false, error: 'The RepeaterBook request was not sent: it has to stay on www.repeaterbook.com.' };
    const key = url;
    const cached = readCache(key);
    const now = Date.now();
    if (RB.cacheFresh(cached, now, RB.CACHE_TTL_MS)) {
      const parsed = RB.parseExport(cached.body);
      return Object.assign({ ok: !parsed.error, cached: true }, parsed);
    }
    const allow = RB.mayRequest(gate, now, RB.MIN_INTERVAL_MS);
    if (!allow.ok) {
      if (cached) return Object.assign({ ok: true, cached: true, stale: true }, RB.parseExport(cached.body));
      return { ok: false, error: 'Waiting a few seconds so RepeaterBook is not hammered.' };
    }
    gate.lastAt = now;
    let res;
    try {
      res = await httpsGet(url, {
        'User-Agent': ua,
        Accept: 'application/json',
        'X-RB-App-Token': token,
      });
    } catch (e) {
      if (cached) return Object.assign({ ok: true, cached: true, stale: true }, RB.parseExport(cached.body));
      return { ok: false, error: 'RepeaterBook could not be reached. ' + (e && e.message ? e.message : '') };
    }
    const err = RB.httpError(res.status, res.body);
    if (err) {
      if (err.retry) gate.blockedUntil = now + 60000;
      log('[Repeaters] ' + err.error);
      if (cached) return Object.assign({ ok: true, cached: true, stale: true, warning: err.error }, RB.parseExport(cached.body));
      return Object.assign({ ok: false }, err);
    }
    writeCache(key, res.body);
    const parsed = RB.parseExport(res.body);
    if (parsed.error) return { ok: false, error: parsed.error, code: parsed.code };
    return Object.assign({ ok: true }, parsed);
  }

  function filtered(repeaters, extra) {
    const o = extra || {};
    let list = RB.withDistance(repeaters, place);
    list = RB.filterRepeaters(list, {
      analog: o.analog !== false,
      status: o.status || 'On-air',
      reach: d.reach ? d.reach() : null,
      bands: d.bands ? d.bands() : null,
      radiusMiles: o.radiusMiles,
    });
    return RB.sortByDistance(list);
  }

  function remember(channels) {
    const api = d.channelsApi;
    const prev = api.sanitizeSaved(settings().channels);
    const next = api.sanitizeSaved(RB.replaceNearby(prev, channels));
    next.seeded = prev.seeded;
    next.removed = prev.removed;
    settings().channels = next;
    if (d.saveSettings) d.saveSettings();
    if (d.onChannels) d.onChannels(next);
  }

  function apply(ch) {
    if (!ch || !(ch.khz > 0)) return null;
    const plan = {
      khz: ch.khz, mode: 'FM', offsetKhz: ch.offsetKhz || 0,
      tone: ch.tone || '', toneRx: ch.toneRx || '', name: ch.name || '',
      warning: ch.warning || '', transmit: false,
    };
    try { if (d.tune) d.tune(plan); } catch (e) { log('[Repeaters] tune failed: ' + (e && e.message ? e.message : e)); }
    if (plan.warning) {
      warning = plan.warning;
      log('[Repeaters] ' + plan.warning);
      if (d.notify) d.notify(plan.warning);
    }
    return plan;
  }

  function lockoutMap() {
    const m = {};
    const ids = settings().repeaterLockouts;
    if (Array.isArray(ids)) for (const id of ids) m[id] = true;
    return m;
  }

  function dwellMs(msg) {
    const sec = msg && msg.dwellSec != null ? msg.dwellSec : settings().repeaterScanDwellSec;
    return Scan.createState([], { dwellMs: Number(sec) > 0 ? Number(sec) * 1000 : 5000 }).dwellMs;
  }
  function resumeMs(msg) {
    const sec = msg && msg.resumeSec != null ? msg.resumeSec : settings().repeaterScanResumeSec;
    return Scan.createState([], { resumeMs: Number(sec) >= 0 && sec != null && sec !== '' ? Number(sec) * 1000 : 4000 }).resumeMs;
  }

  function snapshot() {
    hydrate();
    loadIp();
    const s = settings();
    const preview = Place.choosePlace({
      manual: s.repeaterPlaceManual, phone, os: osFix, ip, grid: s.grid, now: Date.now(),
    });
    if (preview) place = preview;
    const ch = scan.channels || [];
    const cur = ch[scan.index] || null;
    const st = RB.stateById(stateId);
    return {
      place: place ? { source: place.source, text: Place.describePlace(place), lat: place.lat, lon: place.lon, accuracyM: place.accuracyM } : null,
      stateId,
      stateName: st ? st.name : '',
      channels: ch.map(publicChannel),
      index: scan.index,
      current: cur ? publicChannel(cur) : null,
      scanning: !!scan.running,
      phase: scan.phase,
      hasToken: !!String(settings().repeaterbookToken || '').trim(),
      hasContact: !!RB.contactEmail(settings().repeaterbookContact),
      count: Number(settings().repeaterNearbyCount) || 10,
      attribution: RB.ATTRIBUTION,
      userAgent: RB.UA_PRODUCT + ' (+' + RB.UA_PAGE + '; <contact email>)',
      warning,
      states: RB.STATES,
    };
  }

  function publish() {
    const snap = snapshot();
    try { if (d.onChange) d.onChange(snap); } catch { /* a closed window */ }
    return snap;
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function armTimer() {
    stopTimer();
    timer = setInterval(onTick, 250);
    if (timer.unref) timer.unref();
  }

  function onTick() {
    const sig = Scan.signalFromKv4p(activity);
    if (!sig.reliable) {
      if (sig.reason && !monitorWarned) { monitorWarned = true; warning = sig.reason; log('[Repeaters] ' + sig.reason); }
    } else {
      const heard = Scan.reduce(scan, { type: 'signal', now: Date.now(), active: sig.active });
      scan = heard.state;
    }
    const step = Scan.reduce(scan, { type: 'tick', now: Date.now() });
    scan = step.state;
    if (step.tune) apply(step.tune);
    if (step.stopped || !scan.running) stopTimer();
    publish();
  }

  async function loadNearest(msg) {
    const found = await locate();
    if (!found) return Object.assign({ ok: false, error: 'No location yet. Set the grid in Settings, enter a latitude and longitude, or connect the phone.' }, publish());
    stateId = guessState(msg && msg.stateId);
    if (!stateId) return Object.assign({ ok: false, error: 'RepeaterBook is searched by state. Pick a state under Find repeaters, or set Home state.' }, publish());
    const count = msg && msg.count != null ? msg.count : (settings().repeaterNearbyCount || 10);
    settings().repeaterNearbyCount = Math.max(1, Math.min(30, Math.round(Number(count) || 10)));
    const got = await query({ stateId, mode: 'analog' });
    if (!got.ok) return Object.assign(got, publish());
    const top = RB.nearest(filtered(got.repeaters, { analog: true, status: 'On-air' }), settings().repeaterNearbyCount);
    const channels = top.map((r) => RB.toChannel(r, RB.NEARBY_GROUP));
    remember(channels);
    scan = Scan.createState(channels, { lockouts: lockoutMap(), dwellMs: dwellMs(msg), resumeMs: resumeMs(msg) });
    warning = got.capped ? 'RepeaterBook returned its 3500-row cap, so a distant repeater may be missing.' : (got.warning || '');
    if (!channels.length) warning = warning || 'No on-air analog repeaters in range. The radio may be on a band this state has none of, or the token was refused.';
    if (channels[0]) apply(channels[0]);
    log('[Repeaters] Loaded ' + channels.length + ' nearby. ' + Place.describePlace(place) + '. Nothing transmitted.');
    return Object.assign({ ok: true }, publish());
  }

  async function search(msg) {
    const found = await locate();
    if (!found) return { ok: false, error: 'No location yet.' };
    stateId = guessState(msg && msg.stateId);
    if (!stateId) return { ok: false, error: 'Pick a state. RepeaterBook has no latitude search.' };
    const got = await query({ stateId, county: msg && msg.county, city: msg && msg.city, mode: msg && msg.analog === false ? '' : 'analog' });
    if (!got.ok) return Object.assign(got, publish());
    const list = filtered(got.repeaters, { analog: !(msg && msg.analog === false), status: (msg && msg.status) || 'On-air', radiusMiles: msg && msg.radiusMiles });
    const channels = list.slice(0, 200).map((r) => RB.toChannel(r, RB.SAVED_GROUP));
    return Object.assign({ ok: true, results: channels.map(publicChannel), capped: !!got.capped }, publish());
  }

  function hydrate() {
    if (scan.channels.length) return;
    const list = (settings().channels && settings().channels.list) || [];
    const nearby = list.filter((c) => c && c.group === RB.NEARBY_GROUP);
    if (!nearby.length) return;
    scan = Scan.createState(nearby, { lockouts: lockoutMap(), dwellMs: dwellMs(), resumeMs: resumeMs() });
  }

  function step(type, extra) {
    hydrate();
    if (extra && extra.dwellMs) scan.dwellMs = extra.dwellMs;
    if (extra && extra.resumeMs != null) scan.resumeMs = extra.resumeMs;
    const out = Scan.reduce(scan, Object.assign({ type, now: Date.now() }, extra || {}));
    scan = out.state;
    if (out.tune) apply(out.tune);
    if (type === 'start') { monitorWarned = false; armTimer(); }
    if (type === 'stop' || type === 'ptt' || out.stopped) stopTimer();
    if (out.error) warning = out.error;
    return Object.assign({ ok: !out.error, error: out.error }, publish());
  }

  function saveChannel(ch) {
    if (!ch || !(ch.khz > 0)) return { ok: false, error: 'Nothing to save' };
    const api = d.channelsApi;
    const prev = api.sanitizeSaved(settings().channels);
    const next = api.upsert(prev, Object.assign({}, ch, { group: RB.SAVED_GROUP, id: ch.id || api.newId() }));
    next.seeded = prev.seeded;
    settings().channels = next;
    if (d.saveSettings) d.saveSettings();
    if (d.onChannels) d.onChannels(next);
    log('[Repeaters] Saved ' + (ch.name || 'repeater') + ' to Channels. Nothing transmitted.');
    return { ok: true };
  }

  function setLock(id, on) {
    const ids = Array.isArray(settings().repeaterLockouts) ? settings().repeaterLockouts.slice() : [];
    const has = ids.indexOf(id) >= 0;
    if (on && !has) ids.push(id);
    if (!on && has) ids.splice(ids.indexOf(id), 1);
    settings().repeaterLockouts = ids.slice(0, 500);
    if (d.saveSettings) d.saveSettings();
    return step('lock', { id, on: !!on });
  }

  return {
    setPhone(fix) { phone = stamp(fix); publish(); },
    setOs(fix) { osFix = stamp(fix); publish(); },
    setManual(lat, lon) {
      const s = settings();
      if (lat == null || lat === '' || lon == null || lon === '') s.repeaterPlaceManual = null;
      else s.repeaterPlaceManual = { lat: Number(lat), lon: Number(lon) };
      if (d.saveSettings) d.saveSettings();
      return locate().then(() => publish());
    },
    setToken(token) {
      const s = settings();
      const t = String(token || '').trim();
      if (t && !/^rbuapp_[A-Za-z0-9._-]+$/.test(t)) {
        return { ok: false, error: 'Paste the personal rbuapp_ token from your RepeaterBook account. A shared app_ token is not stored.' };
      }
      s.repeaterbookToken = t;
      if (d.saveSettings) d.saveSettings();
      log(t ? '[Repeaters] RepeaterBook token saved on this computer.' : '[Repeaters] RepeaterBook token cleared.');
      return Object.assign({ ok: true }, publish());
    },
    setContact(email) {
      const s = settings();
      const raw = String(email || '').trim();
      if (raw && !RB.contactEmail(raw)) {
        return { ok: false, error: 'That is not an email address. Settings → RepeaterBook contact email stays empty, and the lookup stays off.' };
      }
      s.repeaterbookContact = raw;
      if (d.saveSettings) d.saveSettings();
      log(raw ? '[Repeaters] RepeaterBook contact email saved.' : '[Repeaters] RepeaterBook contact email cleared.');
      return Object.assign({ ok: true }, publish());
    },
    noteActivity(ev) { activity = ev; },
    ptt() { return step('ptt'); },
    stop(why) { return step('stop', { why: why || 'stop' }); },
    loadNearest, search,
    command(msg) {
      const op = msg && msg.op;
      if (op === 'load') return loadNearest(msg);
      if (op === 'search') return search(msg);
      if (op === 'next' || op === 'prev' || op === 'skip') return step(op);
      if (op === 'go') return step('go', { id: msg.id });
      if (op === 'scan-start') return step('start', { dwellMs: dwellMs(msg), resumeMs: resumeMs(msg) });
      if (op === 'scan-stop') return step('stop', { why: 'operator' });
      if (op === 'lock') return setLock(String(msg.id || ''), msg.on !== false);
      if (op === 'tune') {
        if (scan.running) step('stop', { why: 'tune' });
        apply(msg.channel);
        return publish();
      }
      if (op === 'save') return saveChannel(msg.channel);
      if (op === 'manual') return this.setManual(msg.lat, msg.lon);
      if (op === 'token') return this.setToken(msg.token);
      if (op === 'contact') return this.setContact(msg.email);
      return publish();
    },
    status() { return snapshot(); },
    // Tests read the plan shape. Production tune goes through deps.tune.
    apply,
  };
}

function stamp(fix) {
  if (!fix) return null;
  return { lat: Number(fix.lat), lon: Number(fix.lon), accuracyM: Number(fix.accuracyM) || 0, at: Date.now(), region: fix.region || '', city: fix.city || '' };
}

function publicChannel(c) {
  return {
    id: c.id, name: c.name, khz: c.khz, mode: c.mode || 'FM',
    offsetKhz: c.offsetKhz || 0, tone: c.tone || '', toneRx: c.toneRx || '',
    note: c.note || '', miles: c.miles, warning: c.warning || '', callsign: c.callsign || '',
    group: c.group || RB.NEARBY_GROUP,
  };
}

function defaultTransport(url, headers) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    if (u.protocol !== 'https:') { reject(new Error('HTTPS only')); return; }
    if (u.hostname !== RB.EXPORT_HOST && u.hostname !== IP_HOST) { reject(new Error('Host not allowed')); return; }
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers, timeout: 20000,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) { req.destroy(new Error('Response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timed out')));
    req.end();
  });
}

module.exports = { create, defaultTransport, IP_URL };
