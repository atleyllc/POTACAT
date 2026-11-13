'use strict';

// RepeaterBook export → POTACAT channels.
//
// The export API (https://www.repeaterbook.com/wiki/doku.php?id=api) is not
// open. Since 3 March 2026 a request needs an approved application and a
// token. A desktop app does not get one shared app_ token: each operator
// generates their own rbuapp_ token after RepeaterBook approves POTACAT,
// and sends it as X-RB-App-Token. The User-Agent has to match the approval.
// This module builds that request and parses the JSON. It does not fetch,
// and it does not scrape the website.
//
// North America is export.php (state_id, county, city, mode). Everywhere
// else is exportROW.php (country). Results are capped at 3500 with no
// flag. Frequency is the output you listen to; Input Freq is what you
// transmit. PL is the uplink CTCSS, TSQ the downlink. DCS is not CTCSS.

const { haversineDistanceMiles } = require('./grid');

// This fork, not upstream POTACAT. The contact address is the operator's
// setting. An empty address builds no User-Agent, and the lookup is refused.
const UA_PRODUCT = 'POTACAT-atleyllc/1';
const UA_PAGE = 'https://github.com/atleyllc/POTACAT';
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function contactEmail(value) {
  const email = String(value || '').trim();
  return EMAIL_RE.test(email) ? email : '';
}

function userAgent(contact) {
  const email = contactEmail(contact);
  if (!email) return '';
  return UA_PRODUCT + ' (+' + UA_PAGE + '; ' + email + ')';
}
const EXPORT_HOST = 'www.repeaterbook.com';
const NA_URL = 'https://www.repeaterbook.com/api/export.php';
const ROW_URL = 'https://www.repeaterbook.com/api/exportROW.php';
const NEARBY_GROUP = 'Nearby';
const SAVED_GROUP = 'Repeaters';
const ATTRIBUTION = 'Data courtesy of RepeaterBook.com';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 15000;
const RESULT_CAP = 3500;

// id, name, abbrev. US ids are FIPS, zero-padded. Canada and Mexico are
// RepeaterBook's own CA## / MX## values (not ISO). There is no CA06.
const STATE_TEXT = `
01 Alabama AL
02 Alaska AK
04 Arizona AZ
05 Arkansas AR
06 California CA
08 Colorado CO
09 Connecticut CT
10 Delaware DE
11 District of Columbia DC
12 Florida FL
13 Georgia GA
15 Hawaii HI
16 Idaho ID
17 Illinois IL
18 Indiana IN
19 Iowa IA
20 Kansas KS
21 Kentucky KY
22 Louisiana LA
23 Maine ME
24 Maryland MD
25 Massachusetts MA
26 Michigan MI
27 Minnesota MN
28 Mississippi MS
29 Missouri MO
30 Montana MT
31 Nebraska NE
32 Nevada NV
33 New Hampshire NH
34 New Jersey NJ
35 New Mexico NM
36 New York NY
37 North Carolina NC
38 North Dakota ND
39 Ohio OH
40 Oklahoma OK
41 Oregon OR
42 Pennsylvania PA
44 Rhode Island RI
45 South Carolina SC
46 South Dakota SD
47 Tennessee TN
48 Texas TX
49 Utah UT
50 Vermont VT
51 Virginia VA
53 Washington WA
54 West Virginia WV
55 Wisconsin WI
56 Wyoming WY
60 American Samoa AS
66 Guam GU
69 Northern Mariana Islands MP
72 Puerto Rico PR
78 U.S. Virgin Islands VI
CA01 Alberta AB
CA02 British Columbia BC
CA03 Manitoba MB
CA04 New Brunswick NB
CA05 Newfoundland and Labrador NL
CA07 Nova Scotia NS
CA08 Ontario ON
CA09 Prince Edward Island PE
CA10 Quebec QC
CA11 Saskatchewan SK
CA12 Yukon YT
CA13 Northwest Territories NT
CA14 Nunavut NU
MX14 Jalisco JA
`;

// Coarse boxes: id, south, north, west, east. A point on a border can land
// in the neighbour; the Find panel shows the state and can be changed.
// Smaller boxes win when two overlap, so DC beats Maryland.
const BOX_TEXT = `
01 30.2 35.0 -88.5 -84.9
02 51.2 71.5 -170.0 -129.9
04 31.3 37.0 -114.8 -109.0
05 33.0 36.5 -94.6 -89.6
06 32.5 42.0 -124.5 -114.1
08 37.0 41.0 -109.1 -102.0
09 41.0 42.1 -73.7 -71.8
10 38.4 39.8 -75.8 -75.0
11 38.79 39.00 -77.12 -76.90
12 24.5 31.0 -87.6 -80.0
13 30.4 35.0 -85.6 -80.8
15 18.9 22.3 -160.3 -154.8
16 42.0 49.0 -117.2 -111.0
17 37.0 42.5 -91.5 -87.5
18 37.8 41.8 -88.1 -84.8
19 40.4 43.5 -96.6 -90.1
20 37.0 40.0 -102.1 -94.6
21 36.5 39.2 -89.6 -81.9
22 28.9 33.0 -94.0 -88.8
23 43.0 47.5 -71.1 -66.9
24 37.9 39.7 -79.5 -75.0
25 41.2 42.9 -73.5 -69.9
26 41.7 48.3 -90.4 -82.1
27 43.5 49.4 -97.2 -89.5
28 30.2 35.0 -91.7 -88.1
29 36.0 40.6 -95.8 -89.1
30 44.4 49.0 -116.1 -104.0
31 40.0 43.0 -104.1 -95.3
32 35.0 42.0 -120.0 -114.0
33 42.7 45.3 -72.6 -70.6
34 38.9 41.4 -75.6 -73.9
35 31.3 37.0 -109.1 -103.0
36 40.5 45.0 -79.8 -71.8
37 33.8 36.6 -84.3 -75.4
38 45.9 49.0 -104.1 -96.6
39 38.4 42.0 -84.8 -80.5
40 33.6 37.0 -103.0 -94.4
41 42.0 46.3 -124.6 -116.4
42 39.7 42.3 -80.5 -74.7
44 41.3 42.0 -71.9 -71.1
45 32.0 35.2 -83.4 -78.5
46 42.5 45.9 -104.1 -96.4
47 34.9 36.7 -90.3 -81.6
48 25.8 36.5 -106.6 -93.5
49 37.0 42.0 -114.1 -109.0
50 42.7 45.0 -73.4 -71.5
51 36.5 39.5 -83.7 -75.2
53 45.5 49.0 -124.8 -116.9
54 37.2 40.6 -82.6 -77.7
55 42.5 47.1 -92.9 -86.2
56 41.0 45.0 -111.1 -104.0
CA01 49.0 60.0 -120.0 -110.0
CA02 48.3 60.0 -139.1 -114.1
CA08 41.7 56.9 -95.2 -74.3
CA10 45.0 62.6 -79.8 -57.1
MX14 18.9 22.8 -105.7 -101.5
`;

const STATES = STATE_TEXT.trim().split('\n').map((line) => {
  const parts = line.trim().split(' ');
  const id = parts[0];
  const abbrev = parts[parts.length - 1];
  const name = parts.slice(1, -1).join(' ');
  return { id, name, abbrev };
});

const BOXES = BOX_TEXT.trim().split('\n').map((line) => {
  const p = line.trim().split(/\s+/);
  return { id: p[0], s: +p[1], n: +p[2], w: +p[3], e: +p[4] };
});

function stateById(id) {
  const want = String(id || '').trim();
  return STATES.find((s) => s.id === want) || null;
}

function stateIdFromName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (stateById(raw)) return raw;
  const padded = /^\d$/.test(raw) ? '0' + raw : raw;
  if (stateById(padded)) return padded;
  const u = raw.toUpperCase();
  const byAbbr = STATES.find((s) => s.abbrev.toUpperCase() === u);
  if (byAbbr) return byAbbr.id;
  const byName = STATES.find((s) => s.name.toUpperCase() === u);
  return byName ? byName.id : '';
}

/** Smallest containing box. Empty when the point is in none of them. */
function stateAt(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return '';
  let best = null;
  for (const b of BOXES) {
    if (la < b.s || la > b.n || lo < b.w || lo > b.e) continue;
    const area = (b.n - b.s) * (b.e - b.w);
    if (!best || area < best.area) best = { id: b.id, area };
  }
  return best ? best.id : '';
}

function yes(v) {
  if (v === true || v === 1) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'yes' || s === '1' || s === 'true' || s === 'y';
}

function num(v) {
  const n = Number(String(v == null ? '' : v).trim());
  return Number.isFinite(n) ? n : NaN;
}

/** CTCSS hertz, DCS, none, or unknown. CSQ and blank are no tone. */
function parseTone(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || /^(csq|none|n\/a|carrier|0|0\.0)$/i.test(s)) return { kind: 'none', label: '' };
  const dcs = s.match(/^(?:d|dcs\s*)(\d{3})$/i);
  if (dcs) return { kind: 'dcs', label: 'D' + dcs[1] };
  const hz = num(s.replace(/hz$/i, '').trim());
  if (hz >= 67 && hz <= 254.1) {
    const label = Number.isInteger(hz) ? String(hz) : String(hz);
    return { kind: 'ctcss', hz, label };
  }
  return { kind: 'unknown', label: s };
}

function bandOfMhz(mhz) {
  if (mhz >= 50 && mhz < 54) return '6m';
  if (mhz >= 144 && mhz < 148) return '2m';
  if (mhz >= 222 && mhz < 225) return '1.25m';
  if (mhz >= 420 && mhz < 450) return '70cm';
  if (mhz >= 462 && mhz < 468) return 'gmrs';
  if (mhz >= 902 && mhz < 928) return '33cm';
  if (mhz >= 28 && mhz < 29.7) return '10m';
  return '';
}

function inReach(mhz, reach) {
  if (!Array.isArray(reach) || !reach.length) return true;
  const hz = mhz * 1e6;
  return reach.some((r) => Array.isArray(r) && r.length >= 2 && hz >= r[0] && hz <= r[1]);
}

function field(row, name) {
  if (!row || typeof row !== 'object') return '';
  if (row[name] != null) return row[name];
  return '';
}

function parseRow(row) {
  if (!row || typeof row !== 'object') return null;
  const output = num(field(row, 'Frequency'));
  const input = num(field(row, 'Input Freq'));
  if (!(output > 0)) return null;
  const lat = num(field(row, 'Lat'));
  const lon = num(field(row, 'Long'));
  return {
    stateId: String(field(row, 'State ID') || '').trim(),
    repeaterId: String(field(row, 'Rptr ID') || '').trim(),
    outputMhz: output,
    inputMhz: Number.isFinite(input) && input > 0 ? input : output,
    pl: field(row, 'PL'),
    tsq: field(row, 'TSQ'),
    city: String(field(row, 'Nearest City') || '').trim(),
    county: String(field(row, 'County') || '').trim(),
    state: String(field(row, 'State') || '').trim(),
    callsign: String(field(row, 'Callsign') || '').trim(),
    use: String(field(row, 'Use') || '').trim(),
    status: String(field(row, 'Operational Status') || '').trim(),
    analog: yes(field(row, 'FM Analog')),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    notes: String(field(row, 'Notes') || '').trim(),
  };
}

function parseExport(body) {
  let json = body;
  if (typeof body === 'string') {
    try { json = JSON.parse(body); } catch { return { repeaters: [], error: 'RepeaterBook did not return JSON.' }; }
  }
  if (!json || typeof json !== 'object') return { repeaters: [], error: 'RepeaterBook returned nothing.' };
  if (json.status === 'error' || json.error || json.error_code) {
    return { repeaters: [], error: String(json.message || json.error || json.error_code), code: json.error_code || json.error || '' };
  }
  const rows = Array.isArray(json.results) ? json.results : [];
  const repeaters = [];
  for (const row of rows) {
    const r = parseRow(row);
    if (r) repeaters.push(r);
  }
  const count = Number(json.count);
  return {
    repeaters,
    count: Number.isFinite(count) ? count : repeaters.length,
    capped: repeaters.length >= RESULT_CAP || count >= RESULT_CAP,
  };
}

function httpError(status, body) {
  const parsed = parseExport(body || '');
  const code = parsed.code || '';
  if (status >= 300 && status < 400) {
    return { error: 'RepeaterBook redirected the request. It was not followed, so the token stayed here.', code: 'redirect' };
  }
  if (code === 'auth_missing' || status === 401) {
    return { error: 'RepeaterBook wants a token. Paste your own rbuapp_ token from repeaterbook.com (API Applications) once POTACAT is listed there. Until then, import a CHIRP CSV.', code: code || 'auth_missing', needToken: true };
  }
  if (code === 'auth_invalid' || code === 'auth_inactive' || code === 'auth_revoked' || code === 'auth_scope_denied') {
    return { error: 'RepeaterBook refused that token (' + code + '). Generate a new one, or use a CHIRP CSV.', code, needToken: true };
  }
  if (code === 'ua_mismatch') {
    return { error: 'RepeaterBook refused the User-Agent. Approval has to name POTACAT-atleyllc/1 and the contact email in Settings → RepeaterBook contact email.', code };
  }
  if (status === 429 || code === 'rate_limited') {
    return { error: 'RepeaterBook asked POTACAT to slow down. The last saved copy is kept. Try again in a minute.', code: 'rate_limited', retry: true };
  }
  if (parsed.error && !parsed.repeaters.length) return { error: parsed.error, code };
  if (status && status !== 200) return { error: 'RepeaterBook returned HTTP ' + status + '.', code };
  return null;
}

function exportUrl({ stateId, county, city, mode, country } = {}) {
  const c = String(country || '').trim();
  const row = c && !/^(united states|usa|us|canada|mexico)$/i.test(c);
  const base = row ? ROW_URL : NA_URL;
  const q = new URLSearchParams();
  if (row) q.set('country', c);
  else if (stateId) q.set('state_id', String(stateId));
  if (!row && county) q.set('county', String(county).slice(0, 40));
  if (city) q.set('city', String(city).slice(0, 40));
  if (mode) q.set('mode', String(mode));
  const s = q.toString();
  return s ? base + '?' + s : base;
}

function withDistance(repeaters, origin) {
  return (repeaters || []).map((r) => {
    let miles = null;
    if (origin && r.lat != null && r.lon != null) miles = haversineDistanceMiles(origin.lat, origin.lon, r.lat, r.lon);
    return Object.assign({}, r, { miles });
  });
}

function filterRepeaters(repeaters, opts) {
  const o = opts || {};
  const bands = Array.isArray(o.bands) && o.bands.length ? o.bands : null;
  const analog = o.analog !== false;
  const status = o.status || 'On-air';
  const radius = Number(o.radiusMiles);
  return (repeaters || []).filter((r) => {
    if (analog && !r.analog) return false;
    if (status && status !== 'any' && String(r.status).toLowerCase() !== String(status).toLowerCase()) return false;
    const band = bandOfMhz(r.outputMhz);
    if (bands && bands.indexOf(band) < 0) return false;
    if (o.reach && !inReach(r.outputMhz, o.reach)) return false;
    if (radius > 0 && r.miles != null && r.miles > radius) return false;
    return true;
  });
}

function sortByDistance(repeaters) {
  return (repeaters || []).slice().sort((a, b) => {
    const am = a.miles == null ? 1e12 : a.miles;
    const bm = b.miles == null ? 1e12 : b.miles;
    if (am !== bm) return am - bm;
    return String(a.callsign).localeCompare(String(b.callsign));
  });
}

function nearest(repeaters, count) {
  const n = Math.max(1, Math.min(30, Math.round(Number(count) || 10)));
  return sortByDistance(repeaters).slice(0, n);
}

function toChannel(r, group) {
  const pl = parseTone(r.pl);
  const tsq = parseTone(r.tsq);
  const warnings = [];
  let tone = '';
  let toneRx = '';
  if (pl.kind === 'ctcss') tone = pl.label;
  else if (pl.kind === 'dcs') warnings.push(r.callsign + ' uses DCS ' + pl.label + '. CTCSS radios leave the tone off.');
  else if (pl.kind === 'unknown') warnings.push(r.callsign + ' has a tone POTACAT cannot set (' + pl.label + '). The tone is left off.');
  if (tsq.kind === 'ctcss' && tsq.label !== tone) toneRx = tsq.label;
  else if (tsq.kind === 'dcs') warnings.push('The downlink is DCS ' + tsq.label + ', which is left off.');
  const offsetKhz = Math.round((r.inputMhz - r.outputMhz) * 10000) / 10;
  const miles = r.miles == null ? '' : (r.miles < 10 ? r.miles.toFixed(1) : String(Math.round(r.miles))) + ' mi';
  const note = [miles, r.city, r.county, r.state, r.use, r.status, warnings[0]].filter(Boolean).join(' · ').slice(0, 300);
  const name = [r.callsign || r.city || 'Repeater', r.callsign && r.city ? r.city : ''].filter(Boolean).join(' ').slice(0, 40);
  return {
    id: 'rb_' + (r.stateId || 'x') + '_' + (r.repeaterId || Math.round(r.outputMhz * 1000)),
    name,
    khz: Math.round(r.outputMhz * 1000),
    mode: 'FM',
    offsetKhz,
    tone,
    toneRx,
    group: group || NEARBY_GROUP,
    note,
    src: 'user',
    mem: null,
    miles: r.miles,
    callsign: r.callsign,
    warning: warnings.join(' '),
    band: bandOfMhz(r.outputMhz),
  };
}

/** Drop the previous Nearby group and append these. Other groups stay. */
function replaceNearby(saved, channels) {
  const s = saved && typeof saved === 'object' ? saved : { v: 1, list: [], removed: [], seeded: 0 };
  const list = Array.isArray(s.list) ? s.list.filter((c) => !c || c.group !== NEARBY_GROUP) : [];
  for (const c of channels || []) {
    if (c) list.push(c);
  }
  return { v: 1, list, removed: Array.isArray(s.removed) ? s.removed.slice() : [], seeded: s.seeded || 0 };
}

function cacheFresh(entry, now, ttl) {
  if (!entry || entry.body == null) return false;
  return (Number(now) - Number(entry.at)) < (ttl || CACHE_TTL_MS);
}

function mayRequest(gate, now, minGap) {
  const g = gate || {};
  const t = Number(now) || 0;
  if (g.blockedUntil && t < g.blockedUntil) return { ok: false, retryAt: g.blockedUntil };
  const gap = minGap || MIN_INTERVAL_MS;
  if (g.lastAt && t - g.lastAt < gap) return { ok: false, retryAt: g.lastAt + gap };
  return { ok: true };
}

module.exports = {
  UA_PRODUCT, UA_PAGE, contactEmail, userAgent,
  EXPORT_HOST, NA_URL, ROW_URL, NEARBY_GROUP, SAVED_GROUP, ATTRIBUTION,
  CACHE_TTL_MS, MIN_INTERVAL_MS, RESULT_CAP, STATES,
  stateById, stateIdFromName, stateAt, parseTone, bandOfMhz, inReach,
  parseExport, httpError, exportUrl, withDistance, filterRepeaters, sortByDistance,
  nearest, toChannel, replaceNearby, cacheFresh, mayRequest, yes,
};
