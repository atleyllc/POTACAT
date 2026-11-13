#!/usr/bin/env node
'use strict';
// RepeaterBook export JSON → channel, distance order, Nearby replacement,
// and the receive-only scan machine. No network. The two live-shaped rows
// are the public examples from CHIRP bug 10962 and dmrfill issue 3.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RB = require('../lib/repeaterbook');
const Place = require('../lib/station-place');
const Scan = require('../lib/repeater-scan');
const Channels = require('../lib/channels');
const Svc = require('../lib/repeater-service');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n    ' + (e && e.stack || e)); }
}
const FIXTURE = {
  // Recorded public rows (CHIRP 10962, a Florida machine). Not a default state.
  count: 5,
  results: [
    { 'State ID': '12', 'Rptr ID': '9936', Frequency: '444.20000', 'Input Freq': '449.20000', PL: '100.0', TSQ: '100.0', 'Nearest City': 'Navarre', County: 'Santa Rosa', State: 'Florida', Lat: '30.43219948', Long: '-86.87329865', Callsign: 'K4ECR', Use: 'OPEN', 'Operational Status': 'On-air', 'FM Analog': 'Yes' },
    { 'State ID': '12', 'Rptr ID': '2', Frequency: '442.00000', 'Input Freq': '447.00000', PL: 'D023', TSQ: '', 'Nearest City': 'Pensacola', County: 'Escambia', State: 'Florida', Lat: '30.4213', Long: '-87.2169', Callsign: 'W4DCS', Use: 'OPEN', 'Operational Status': 'On-air', 'FM Analog': 'Yes' },
    { 'State ID': '23', 'Rptr ID': 21812, Frequency: '146.92500', 'Input Freq': '146.32500', PL: '103.5', TSQ: '', 'Nearest City': 'Lyman', County: 'York', State: 'Maine', Lat: '43.50189120', Long: '-70.72602590', Callsign: 'WJ1L', Use: 'OPEN', 'Operational Status': 'On-air', 'FM Analog': 'Yes' },
    { 'State ID': '12', 'Rptr ID': '9', Frequency: '444.80000', 'Input Freq': '449.80000', PL: '127.3', TSQ: '127.3', 'Nearest City': 'Navarre', Lat: '30.50', Long: '-86.87', Callsign: 'W4OFF', 'Operational Status': 'Off-air', 'FM Analog': 'Yes' },
    { 'State ID': '12', 'Rptr ID': '8', Frequency: '442.50000', 'Input Freq': '447.50000', PL: '', TSQ: '', 'Nearest City': 'Navarre', Lat: '30.44', Long: '-86.88', Callsign: 'W4DMR', 'Operational Status': 'On-air', 'FM Analog': 'No', DMR: 'Yes' },
  ],
};

console.log('=== parse, offset, tone ===');
test('the User-Agent names this fork and is empty without a contact address', () => {
  assert.strictEqual(RB.userAgent(''), '');
  assert.strictEqual(RB.userAgent('not-an-email'), '');
  assert.strictEqual(
    RB.userAgent('operator@example.com'),
    'POTACAT-atleyllc/1 (+https://github.com/atleyllc/POTACAT; operator@example.com)',
  );
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'repeaterbook.js'), 'utf8');
  assert.ok(!/casey@/.test(src) && !/potacat\.com/.test(src), 'no upstream contact is built in');
  assert.strictEqual(RB.stateIdFromName(''), '');
  assert.notStrictEqual(RB.stateIdFromName('Tennessee'), '12');
  assert.strictEqual(RB.stateIdFromName('TN'), '47');
});

test('export URL stays on www.repeaterbook.com and never carries a token', () => {
  const url = RB.exportUrl({ stateId: '12', mode: 'analog', county: 'Santa Rosa' });
  assert.strictEqual(url, 'https://www.repeaterbook.com/api/export.php?state_id=12&county=Santa+Rosa&mode=analog');
  assert.ok(!/token|rbuapp|app_/i.test(url));
  assert.strictEqual(new URL(RB.exportUrl({ country: 'Switzerland' })).pathname, '/api/exportROW.php');
});

test('fixture rows become channels with the offset sign and CTCSS', () => {
  const parsed = RB.parseExport(JSON.stringify(FIXTURE));
  assert.strictEqual(parsed.repeaters.length, 5);
  const origin = { lat: 30.4322, lon: -86.8733 };
  const list = RB.sortByDistance(RB.filterRepeaters(RB.withDistance(parsed.repeaters, origin), {
    analog: true, status: 'On-air', reach: [[400e6, 480e6]], bands: ['70cm'],
  }));
  assert.deepStrictEqual(list.map((r) => r.callsign), ['K4ECR', 'W4DCS']);
  assert.ok(list[0].miles < list[1].miles);
  const ch = RB.toChannel(list[0]);
  assert.strictEqual(ch.khz, 444200);
  assert.strictEqual(ch.offsetKhz, 5000);
  assert.strictEqual(ch.tone, '100');
  assert.strictEqual(ch.mode, 'FM');
  const dcs = RB.toChannel(list[1]);
  assert.strictEqual(dcs.tone, '');
  assert.ok(/DCS D023/.test(dcs.warning));
  const maine = parsed.repeaters.find((r) => r.callsign === 'WJ1L');
  assert.strictEqual(RB.toChannel(maine).offsetKhz, -600);
  assert.strictEqual(RB.parseTone('CSQ').kind, 'none');
  assert.strictEqual(RB.parseTone('D023').kind, 'dcs');
});

test('a UHF radio does not keep a 2 m repeater, and off-air and digital-only drop out', () => {
  const parsed = RB.parseExport(FIXTURE);
  const keep = RB.filterRepeaters(parsed.repeaters, { reach: [[400e6, 480e6]], bands: ['70cm'], analog: true, status: 'On-air' });
  assert.ok(keep.every((r) => r.outputMhz >= 400));
  assert.ok(!keep.some((r) => r.callsign === 'WJ1L' || r.callsign === 'W4OFF' || r.callsign === 'W4DMR'));
});

test('Seattle is Washington, and a manual place beats the phone', () => {
  assert.strictEqual(RB.stateAt(47.6062, -122.3321), '53');
  assert.strictEqual(RB.stateIdFromName('FL'), '12');
  assert.strictEqual(RB.stateIdFromName('Florida'), '12');
  const now = 1_000_000;
  const phone = { lat: 1, lon: 2, at: now, accuracyM: 12 };
  const manual = Place.choosePlace({ manual: { lat: 47.6, lon: -122.3 }, phone, ip: { lat: 3, lon: 4, at: now }, grid: 'FN20', now });
  assert.strictEqual(manual.source, 'manual');
  const noManual = Place.choosePlace({ phone, os: { lat: 9, lon: 9, at: now, accuracyM: 40 }, ip: { lat: 3, lon: 4, at: now }, grid: 'FN20', now });
  assert.strictEqual(noManual.source, 'phone');
  assert.strictEqual(noManual.accuracyM, 12);
  const stalePhone = Place.choosePlace({ phone: { lat: 1, lon: 2, at: now - 10 * 60 * 1000 }, os: { lat: 8, lon: 8, at: now, accuracyM: 30 }, now });
  assert.strictEqual(stalePhone.source, 'os');
  const ip = Place.choosePlace({ ip: { lat: 47.6, lon: -122.3, at: now, city: 'Seattle', region: 'Washington' }, grid: 'FN20', now });
  assert.strictEqual(ip.source, 'ip');
  assert.ok(/city-level/.test(Place.describePlace(ip)));
  assert.strictEqual(Place.choosePlace({ grid: 'FN20', now }).source, 'grid');
  const ipwho = Place.parseIpwho(JSON.stringify({ success: true, latitude: 47.6, longitude: -122.33, city: 'Seattle', region: 'Washington', country: 'United States' }));
  assert.strictEqual(ipwho.city, 'Seattle');
  assert.strictEqual(ipwho.accuracyM, 25000);
  assert.strictEqual(Place.parseIpwho('{"success":false}'), null);
});

console.log('=== bank and scan ===');
test('loading nearest replaces Nearby and leaves the rest of the chart', () => {
  const saved = Channels.sanitizeSaved({
    seeded: 3, removed: ['gone'],
    list: [
      { id: 'keep', name: 'NOAA', khz: 162550, mode: 'FM', group: 'Weather' },
      { id: 'old', name: 'OLD', khz: 146000, mode: 'FM', group: 'Nearby' },
    ],
  });
  const parsed = RB.parseExport(FIXTURE);
  const top = RB.nearest(RB.filterRepeaters(RB.withDistance(parsed.repeaters, { lat: 30.43, lon: -86.87 }), { analog: true, status: 'On-air' }), 10);
  const next = Channels.sanitizeSaved(RB.replaceNearby(saved, top.map((r) => RB.toChannel(r))));
  assert.ok(next.list.some((c) => c.id === 'keep'));
  assert.ok(!next.list.some((c) => c.name === 'OLD'));
  assert.ok(next.list.filter((c) => c.group === 'Nearby').length >= 2);
  assert.strictEqual(next.seeded, 3);
  assert.deepStrictEqual(next.removed, ['gone']);
  const k = next.list.find((c) => c.name.indexOf('K4ECR') === 0);
  assert.strictEqual(k.offsetKhz, 5000);
  assert.strictEqual(k.tone, '100');
});

test('scan dwells, holds on a signal, resumes, and PTT stops it without a tune', () => {
  let s = Scan.createState([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { dwellMs: 5000, resumeMs: 3000 });
  let r = Scan.reduce(s, { type: 'start', now: 0 });
  assert.strictEqual(r.tune.id, 'a');
  assert.strictEqual(r.state.running, true);
  r = Scan.reduce(r.state, { type: 'tick', now: 4999 });
  assert.strictEqual(r.tune, null);
  r = Scan.reduce(r.state, { type: 'tick', now: 5000 });
  assert.strictEqual(r.tune.id, 'b');
  r = Scan.reduce(r.state, { type: 'signal', now: 5100, active: true });
  assert.strictEqual(r.state.phase, 'hold');
  r = Scan.reduce(r.state, { type: 'tick', now: 20000 });
  assert.strictEqual(r.tune, null, 'a carrier holds the channel');
  r = Scan.reduce(r.state, { type: 'signal', now: 21000, active: false });
  assert.strictEqual(r.state.phase, 'resume');
  r = Scan.reduce(r.state, { type: 'tick', now: 23999 });
  assert.strictEqual(r.tune, null);
  r = Scan.reduce(r.state, { type: 'tick', now: 24000 });
  assert.strictEqual(r.tune.id, 'c');
  r = Scan.reduce(r.state, { type: 'ptt', now: 25000 });
  assert.strictEqual(r.state.running, false);
  assert.strictEqual(r.tune, null);
  assert.strictEqual(r.reason, 'ptt');
  assert.ok(!Object.prototype.hasOwnProperty.call(r, 'transmit'));
});

test('a locked-out channel is skipped', () => {
  let s = Scan.createState([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { dwellMs: 2000, lockouts: { b: true } });
  let r = Scan.reduce(s, { type: 'start', now: 0, index: 0 });
  r = Scan.reduce(r.state, { type: 'tick', now: 2000 });
  assert.strictEqual(r.tune.id, 'c');
});

test('squelch 0 is not a signal, squelch open is', () => {
  const monitor = Scan.signalFromKv4p({ squelch: 0, open: true });
  assert.strictEqual(monitor.reliable, false);
  assert.ok(/squelch is 0/i.test(monitor.reason));
  assert.strictEqual(Scan.signalFromKv4p({ squelch: 2, open: true }).active, true);
  assert.strictEqual(Scan.signalFromKv4p({ squelch: 2, flags: Scan.KV4P_SQUELCHED }).active, false);
});

test('a rate limit is remembered and a fresh cache is reused', () => {
  const now = 10_000;
  assert.strictEqual(RB.mayRequest({ lastAt: now - 1000 }, now, 15000).ok, false);
  assert.strictEqual(RB.mayRequest({ lastAt: now - 20000 }, now, 15000).ok, true);
  assert.strictEqual(RB.cacheFresh({ at: now - 1000, body: '{}' }, now, 5000), true);
  assert.strictEqual(RB.cacheFresh({ at: now - 9000, body: '{}' }, now, 5000), false);
  const err = RB.httpError(429, JSON.stringify({ error_code: 'rate_limited', message: 'slow down' }));
  assert.strictEqual(err.retry, true);
  const redir = RB.httpError(302, '');
  assert.strictEqual(redir.code, 'redirect');
});

(async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-'));
  const settings = { grid: 'FN20', repeaterbookToken: 'app_shared', channels: { v: 1, list: [], removed: [], seeded: 1 } };
  let calls = 0;
  try {
    const svc = Svc.create({
      getSettings: () => settings, saveSettings() {}, channelsApi: Channels, cacheDir: () => dir,
      transport() { calls++; return Promise.resolve({ status: 200, body: '{}' }); },
      tune() { throw new Error('should not tune'); },
    });
    svc.setPhone({ lat: 30.43, lon: -86.87, accuracyM: 10 });
    const noContact = await svc.loadNearest({ stateId: '12' });
    assert.strictEqual(noContact.ok, false);
    assert.strictEqual(calls, 0);
    assert.ok(/contact email/i.test(noContact.error));
    settings.repeaterbookContact = 'operator@example.com';
    const denied = await svc.loadNearest({ stateId: '12' });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(calls, 0);
    assert.ok(/rbuapp_/.test(denied.error));
    settings.repeaterbookToken = 'rbuapp_personaltoken';
    settings.repeaterbookContact = 'operator@example.com';
    const tunes = [];
    let rbCalls = 0;
    const svc2 = Svc.create({
      getSettings: () => settings, saveSettings() {}, channelsApi: Channels, cacheDir: () => dir,
      reach: () => [[400e6, 480e6]], bands: () => ['70cm'],
      transport(url, headers) {
        const host = new URL(url).hostname;
        if (host === 'ipwho.is') return Promise.resolve({ status: 200, body: '{"success":false}' });
        rbCalls++;
        calls++;
        assert.ok(!url.includes('rbuapp'));
        assert.strictEqual(headers['X-RB-App-Token'], 'rbuapp_personaltoken');
        assert.strictEqual(headers['User-Agent'], 'POTACAT-atleyllc/1 (+https://github.com/atleyllc/POTACAT; operator@example.com)');
        assert.strictEqual(host, 'www.repeaterbook.com');
        return Promise.resolve({ status: 200, body: JSON.stringify(FIXTURE) });
      },
      tune(plan) { tunes.push(plan); },
    });
    settings.grid = '';
    const noPlace = await svc2.loadNearest({});
    assert.strictEqual(noPlace.ok, false);
    assert.notStrictEqual(noPlace.stateId, '12');
    assert.strictEqual(rbCalls, 0, 'no state and no fix means no RepeaterBook request');
    settings.grid = 'FN20';
    svc2.setPhone({ lat: 30.4322, lon: -86.8733, accuracyM: 15 });
    const loaded = await svc2.loadNearest({ stateId: '12', count: 10 });
    assert.strictEqual(loaded.ok, true);
    assert.strictEqual(loaded.place.source, 'phone');
    assert.ok(tunes.length >= 1);
    assert.strictEqual(tunes[0].transmit, false);
    assert.ok(tunes[0].khz >= 400000);
    assert.strictEqual(settings.channels.list.some((c) => c.group === 'Nearby' && c.name.indexOf('K4ECR') === 0), true);
    svc2.ptt();
    assert.strictEqual(tunes.length, 1);
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'repeater-service.js'), 'utf8');
    assert.ok(!/setTransmit\(/.test(src));
    assert.ok(!/casey@/.test(src) && !/potacat\.com/.test(src));
    passed++;
    console.log('  ok  service: receive-only tune, token stays in the header');
  } catch (e) {
    failed++;
    console.log('  FAIL service\n    ' + (e && e.stack || e));
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
