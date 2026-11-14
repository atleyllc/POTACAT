#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
/**
 * JS8 over ECHOCAT — the server half of the phone data path.
 *
 * The rules worth protecting: an owner's messages emit VERBATIM to main
 * (the host owns composition — a server that shapes text breaks
 * addressing); a Guest Pass session can browse but never key or configure
 * the transmitter, and every refusal answers on js8-send-result so the
 * guest UI shows why; hydration replays cached state so a suspended phone
 * reconnects to the inbox as it stands.
 *
 * Harness: drive _handleMessage with a stubbed socket, no network — the
 * same pattern as diagnostic-snapshot-test.js.
 *
 * Run: node test/js8-remote-test.js
 */

const assert = require('assert');
const { RemoteServer } = require('../lib/remote-server');
const protocol = require('../lib/echocat-protocol');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

function fakeWs() {
  const sent = [];
  return {
    _authenticated: true,
    readyState: 1,
    send: (w) => { try { sent.push(JSON.parse(w)); } catch {} },
    _sent: sent,
  };
}

// ── registry ─────────────────────────────────────────────────────────────────

test('every JS8 message is registered with the right direction', () => {
  for (const t of ['js8-start', 'js8-stop', 'js8-heartbeat', 'js8-send',
    'js8-thread-open', 'js8-thread-closed']) {
    assert.ok(protocol.isKnownType(t), t + ' missing from registry');
    assert.strictEqual(protocol.describe(t).dir, protocol.Dir.C2S, t + ' direction');
  }
  for (const t of ['js8-state', 'js8-threads', 'js8-heard', 'js8-thread',
    'js8-send-result']) {
    assert.ok(protocol.isKnownType(t), t + ' missing from registry');
    assert.strictEqual(protocol.describe(t).dir, protocol.Dir.S2C, t + ' direction');
  }
});

test('the server hello advertises the js8 capability', () => {
  const hello = protocol.buildServerHello({ capabilities: ['js8'] });
  assert.ok(hello.capabilities.includes('js8'));
});

test('js8-send validates with and without optional fields', () => {
  assert.ok(protocol.validate({ type: 'js8-send', text: 'SNR?' }, protocol.Dir.C2S).ok);
  assert.ok(protocol.validate({ type: 'js8-send', text: 'SNR?', to: 'KN4CRD', reqId: 'm1' }, protocol.Dir.C2S).ok);
  assert.ok(!protocol.validate({ type: 'js8-send' }, protocol.Dir.C2S).ok, 'text is required');
});

// ── owner path: emits verbatim ───────────────────────────────────────────────

test('an owner send emits text/to/reqId untouched', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  const events = [];
  rs.on('js8-send', (e) => events.push(e));
  rs._handleMessage(ws, { type: 'js8-send', text: '  spaced text ', to: '@ALLCALL', reqId: 'r7' }, {});
  assert.strictEqual(events.length, 1);
  assert.deepStrictEqual(events[0], { text: '  spaced text ', to: '@ALLCALL', reqId: 'r7' },
    'no trimming, no shaping — the host owns composition');
  assert.strictEqual(ws._sent.length, 0, 'no immediate reply; main answers via sendJs8SendResult');
});

test('owner lifecycle + heartbeat + thread messages all emit', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  const seen = [];
  for (const t of ['js8-start', 'js8-stop', 'js8-heartbeat', 'js8-thread-open', 'js8-thread-closed']) {
    rs.on(t, (e) => seen.push([t, e]));
  }
  rs._handleMessage(ws, { type: 'js8-start' }, {});
  rs._handleMessage(ws, { type: 'js8-heartbeat', enabled: true, intervalMin: 30 }, {});
  rs._handleMessage(ws, { type: 'js8-thread-open', id: 'KN4CRD' }, {});
  rs._handleMessage(ws, { type: 'js8-thread-closed' }, {});
  rs._handleMessage(ws, { type: 'js8-stop' }, {});
  assert.strictEqual(seen.length, 5);
  assert.deepStrictEqual(seen[1][1], { enabled: true, intervalMin: 30, reqId: undefined });
  assert.deepStrictEqual(seen[2][1], { id: 'KN4CRD', guest: false },
    'owner opens carry guest:false so main applies the read-marking path');
});

// ── guest path: browse yes, transmit no ─────────────────────────────────────

test('a guest send is refused on js8-send-result with the reqId', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  ws._passSession = { code: 'GUEST1' };
  rs._client = ws;
  let emitted = 0;
  rs.on('js8-send', () => { emitted++; });
  rs._handleMessage(ws, { type: 'js8-send', text: 'CQ CQ CQ', reqId: 'g1' }, {});
  assert.strictEqual(emitted, 0, 'guest send must NOT reach main');
  assert.strictEqual(ws._sent.length, 1, 'guest gets an immediate reply');
  assert.strictEqual(ws._sent[0].type, 'js8-send-result');
  assert.strictEqual(ws._sent[0].ok, false);
  assert.ok(ws._sent[0].error, 'refusal carries a reason');
  assert.strictEqual(ws._sent[0].reqId, 'g1', 'reply matches the tap');
});

test('guest start/stop/heartbeat are refused; thread browsing is not', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  ws._passSession = { code: 'GUEST1' };
  rs._client = ws;
  const emits = { start: 0, stop: 0, hb: 0, open: 0 };
  rs.on('js8-start', () => { emits.start++; });
  rs.on('js8-stop', () => { emits.stop++; });
  rs.on('js8-heartbeat', () => { emits.hb++; });
  rs.on('js8-thread-open', () => { emits.open++; });
  rs._handleMessage(ws, { type: 'js8-start' }, {});
  rs._handleMessage(ws, { type: 'js8-stop' }, {});
  rs._handleMessage(ws, { type: 'js8-heartbeat', enabled: true }, {});
  // Group browsing is the allowed read path (a bare callsign is a DM and
  // gets refused — pinned separately in the privacy section below).
  rs._handleMessage(ws, { type: 'js8-thread-open', id: '@ALLCALL' }, {});
  assert.deepStrictEqual(emits, { start: 0, stop: 0, hb: 0, open: 1 },
    'lifecycle refused, group browsing allowed');
  const refusals = ws._sent.filter((m) => m.type === 'js8-send-result' && m.ok === false);
  assert.strictEqual(refusals.length, 3, 'each refused message answers');
});

// ── broadcasts: cache for hydration ─────────────────────────────────────────

test('state/threads/heard broadcasts cache, and threads drops the delta', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  rs.broadcastJs8State({ running: true, tx: false, txQueue: 0, submode: 'NORMAL', heartbeat: false, heartbeatMin: 15, station: { call: 'K3SBP', grid: 'FN20' } });
  rs.broadcastJs8Threads({ list: [{ id: 'KN4CRD' }], unread: 2, changed: 'KN4CRD', thread: { id: 'KN4CRD', messages: [] } });
  rs.broadcastJs8Heard([{ call: 'W1AW', snr: -8, utc: 1, grid: '' }]);

  assert.strictEqual(rs._js8State.running, true);
  // The hydration cache holds STATE, not the moment's delta — a phone that
  // reconnects an hour later must not get a stale "this one just changed".
  assert.deepStrictEqual(rs._js8Threads, { list: [{ id: 'KN4CRD' }], unread: 2 });
  assert.strictEqual(rs._js8Heard.length, 1);

  // The live client saw all three, delta included.
  const types = ws._sent.map((m) => m.type);
  assert.deepStrictEqual(types, ['js8-state', 'js8-threads', 'js8-heard']);
  assert.strictEqual(ws._sent[1].changed, 'KN4CRD');
});

// ── the two gaps the mobile team found (docs/desktop-asks) ──────────────────

test('a guest auth gets the JS8 hydration trio, state first', () => {
  // js8-thread-open is deliberately ungated for guests — but browsing needs
  // an inbox to browse. The pass path used to stop at `status`, leaving the
  // guest's JS8 surface blank until the next live push (many minutes on a
  // quiet band). Hydration now flows through the SHARED helper so every
  // auth path gets it by construction — assert the guest path calls it,
  // and drive the helper itself for content + order.
  const src = readSrc(
    require('path').join(__dirname, '..', 'lib', 'remote-server.js'));
  // The pass hydration is one helper (_hydratePassClient), used at pass auth
  // and again when a paused guest gets the radio back.
  const at = src.indexOf('Guest Pass authenticated:');
  assert.ok(at > 0);
  assert.ok(src.slice(Math.max(0, at - 1600), at).includes('this._hydratePassClient(ws)'), 'pass auth hydrates through the helper');
  const h = src.slice(src.indexOf('  _hydratePassClient(ws) {'), src.indexOf('  _hydratePassClient(ws) {') + 900);
  assert.ok(h.includes("type: 'status'"), 'anchored at the pass status push');
  assert.ok(h.indexOf("type: 'status'") < h.indexOf('_sendJs8Hydration(ws)'),
    'guest auth must hydrate JS8 via the shared helper, after status');

  const rs = new RemoteServer();
  const ws = fakeWs();
  rs.broadcastJs8State({ running: true });
  rs.broadcastJs8Threads({ list: [], unread: 0 });
  rs.broadcastJs8Heard([{ call: 'W1AW', snr: -8, utc: 1, grid: '' }]);
  ws._sent.length = 0; // ignore the live pushes; test the hydration replay
  rs._sendJs8Hydration(ws);
  const types = ws._sent.map((m) => m.type);
  assert.deepStrictEqual(types, ['js8-state', 'js8-threads', 'js8-heard'],
    'state first, then content — the order the UI gates on');
});

test('lifecycle emits carry reqId so start failures attribute to the tap', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  const seen = {};
  for (const t of ['js8-start', 'js8-stop', 'js8-heartbeat']) {
    rs.on(t, (e) => { seen[t] = e; });
  }
  rs._handleMessage(ws, { type: 'js8-start', reqId: 'a1' }, {});
  rs._handleMessage(ws, { type: 'js8-stop', reqId: 'a2' }, {});
  rs._handleMessage(ws, { type: 'js8-heartbeat', enabled: true, reqId: 'a3' }, {});
  assert.strictEqual(seen['js8-start'].reqId, 'a1');
  assert.strictEqual(seen['js8-stop'].reqId, 'a2');
  assert.strictEqual(seen['js8-heartbeat'].reqId, 'a3');
});

test('reqId is declared on the lifecycle messages, not merely tolerated', () => {
  for (const t of ['js8-start', 'js8-stop', 'js8-heartbeat']) {
    const fields = protocol.describe(t).fields || {};
    assert.ok(fields.reqId, t + ' must declare reqId');
  }
});

// ── Guest Pass privacy: group nets only, No DMs (Casey 2026-08-09) ──────────
// docs/desktop-asks/js8-guest-pass-dm-privacy.md. Every non-group thread is
// a private exchange between the OWNER and one station; a pass session must
// never receive one through ANY door — hydration, live push, thread-open —
// and must never write owner state (mark-read, watchdog, open claim).

const OWNER_THREADS = {
  unread: 5,
  list: [
    { id: '@ALLCALL', call: '@ALLCALL', isGroup: true, unread: 1, lastText: 'CQ' },
    { id: '@HB', call: '@HB', isGroup: true, unread: 0, hbCount: 12 },
    { id: 'KN4CRD', call: 'KN4CRD', isGroup: false, unread: 3, lastText: 'private' },
    { id: 'W1AW', call: 'W1AW', isGroup: false, unread: 1, lastText: 'also private' },
  ],
};

test('guest hydration carries no DM rows and a recomputed unread', () => {
  const rs = new RemoteServer();
  rs.broadcastJs8State({ running: true });
  rs.broadcastJs8Threads(OWNER_THREADS);
  const guest = fakeWs();
  guest._passSession = { code: 'G' };
  guest._sent.length = 0;
  rs._sendJs8Hydration(guest);
  const threads = guest._sent.find((m) => m.type === 'js8-threads');
  assert.ok(threads);
  assert.ok(threads.list.every((t) => t.isGroup), 'no DM row may reach a guest');
  assert.strictEqual(threads.unread, 1,
    'unread recomputed over visible rows — the owner total is itself a disclosure');
});

test('live thread pushes are shaped per client; the cache stays owner-truth', () => {
  const rs = new RemoteServer();
  const guest = fakeWs();
  guest._passSession = { code: 'G' };
  rs._client = guest;
  rs.broadcastJs8Threads({ ...OWNER_THREADS, changed: 'KN4CRD', thread: { id: 'KN4CRD', isGroup: false, messages: [{ text: 'private' }] } });
  const got = guest._sent.find((m) => m.type === 'js8-threads');
  assert.ok(got.list.every((t) => t.isGroup));
  assert.strictEqual(got.changed, undefined, 'a delta the guest cannot see drops BOTH fields');
  assert.strictEqual(got.thread, undefined);
  // The hydration cache keeps the owner's full truth for the next paired connect.
  assert.strictEqual(rs._js8Threads.list.length, 4);
  assert.strictEqual(rs._js8Threads.unread, 5);
});

test('a group delta still reaches the guest intact', () => {
  const rs = new RemoteServer();
  const guest = fakeWs();
  guest._passSession = { code: 'G' };
  rs._client = guest;
  rs.broadcastJs8Threads({ ...OWNER_THREADS, changed: '@ALLCALL', thread: { id: '@ALLCALL', isGroup: true, messages: [] } });
  const got = guest._sent.find((m) => m.type === 'js8-threads');
  assert.strictEqual(got.changed, '@ALLCALL');
  assert.ok(got.thread);
});

test('guest js8-thread-open: DM refused, group allowed with the guest flag', () => {
  const rs = new RemoteServer();
  const guest = fakeWs();
  guest._passSession = { code: 'G' };
  rs._client = guest;
  const opens = [];
  rs.on('js8-thread-open', (e) => opens.push(e));
  rs._handleMessage(guest, { type: 'js8-thread-open', id: 'KN4CRD' }, {});
  assert.strictEqual(opens.length, 0, 'a DM open must never reach main');
  assert.strictEqual(guest._sent[0].type, 'js8-send-result');
  assert.strictEqual(guest._sent[0].ok, false);
  rs._handleMessage(guest, { type: 'js8-thread-open', id: '@ALLCALL' }, {});
  assert.deepStrictEqual(opens, [{ id: '@ALLCALL', guest: true }],
    'main must know it is a guest — the handler writes owner state otherwise');
});

test('guest js8-thread-closed is swallowed — it would clear the OWNER claim', () => {
  const rs = new RemoteServer();
  const guest = fakeWs();
  guest._passSession = { code: 'G' };
  rs._client = guest;
  let closed = 0;
  rs.on('js8-thread-closed', () => { closed++; });
  rs._handleMessage(guest, { type: 'js8-thread-closed' }, {});
  assert.strictEqual(closed, 0);
});

test('sendJs8Thread refuses to hand a DM body to a pass session', () => {
  const rs = new RemoteServer();
  const guest = fakeWs();
  guest._passSession = { code: 'G' };
  rs._client = guest;
  rs.sendJs8Thread({ id: 'KN4CRD', isGroup: false, messages: [{ text: 'private' }] });
  assert.strictEqual(guest._sent[0].thread, null, 'defense in depth behind the demux gate');
  rs.sendJs8Thread({ id: '@HB', isGroup: true, messages: [] });
  assert.ok(guest._sent[1].thread, 'group content still flows');
});

test('activity-state shapes detail.unread for guests, live and hydrated', () => {
  const rs = new RemoteServer();
  rs.broadcastJs8Threads(OWNER_THREADS);
  const guest = fakeWs();
  guest._passSession = { code: 'G' };
  rs._client = guest;
  rs.broadcastActivityState({ activity: 'js8', auto: false, since: 1, detail: { submode: 'NORMAL', unread: 5 }, busy: { tx: false, decoding: false } });
  const live = guest._sent.find((m) => m.type === 'activity-state');
  assert.strictEqual(live.detail.unread, 1, 'the owner total is a live private-mail counter');
  guest._sent.length = 0;
  rs._sendActivityHydration(guest);
  assert.strictEqual(guest._sent[0].detail.unread, 1);
  // The paired client still gets the owner truth.
  const owner = fakeWs();
  rs._client = owner;
  rs.broadcastActivityState({ activity: 'js8', auto: false, since: 2, detail: { submode: 'NORMAL', unread: 5 }, busy: { tx: false, decoding: false } });
  assert.strictEqual(owner._sent.find((m) => m.type === 'activity-state').detail.unread, 5);
});

// ── QSO logging over the wire ───────────────────────────────────────────────

test('js8-log-prefill is registered BOTH ways and refused for guests', () => {
  assert.ok(protocol.isKnownType('js8-log-prefill'));
  assert.strictEqual(protocol.describe('js8-log-prefill').dir, protocol.Dir.BOTH);

  const rs = new RemoteServer();
  const guest = fakeWs();
  guest._passSession = { code: 'G' };
  rs._client = guest;
  let emitted = 0;
  rs.on('js8-log-prefill', () => { emitted++; });
  rs._handleMessage(guest, { type: 'js8-log-prefill', id: 'KN4CRD', reqId: 'L1' }, {});
  assert.strictEqual(emitted, 0, 'logging writes the OWNER logbook — refused');
  assert.strictEqual(guest._sent[0].type, 'js8-send-result');
  assert.strictEqual(guest._sent[0].reqId, 'L1');

  const owner = fakeWs();
  rs._client = owner;
  rs._handleMessage(owner, { type: 'js8-log-prefill', id: 'KN4CRD' }, {});
  assert.strictEqual(emitted, 1, 'owner request reaches main');
  rs.sendJs8LogPrefill({ id: 'KN4CRD', prefill: { callsign: 'KN4CRD', rstSent: '-05' } });
  const reply = owner._sent.find((m) => m.type === 'js8-log-prefill');
  assert.strictEqual(reply.prefill.rstSent, '-05');
});

test('the prefill success emit carries reqId — not just the refusal', () => {
  // Third instance of the drop-on-success shape (mobile logging-gaps #2):
  // a declared field that only works on refusals reads as supported and
  // isn't, which is how the js8-start version went unnoticed.
  const rs = new RemoteServer();
  const owner = fakeWs();
  rs._client = owner;
  let seen = null;
  rs.on('js8-log-prefill', (e) => { seen = e; });
  rs._handleMessage(owner, { type: 'js8-log-prefill', id: 'KN4CRD', reqId: 'L9' }, {});
  assert.deepStrictEqual(seen, { id: 'KN4CRD', reqId: 'L9' });
});

test('js8-set-band: owner tunes, guest refused', () => {
  assert.ok(protocol.isKnownType('js8-set-band'));
  const rs = new RemoteServer();
  const guest = fakeWs();
  guest._passSession = { code: 'G' };
  rs._client = guest;
  let tuned = null;
  rs.on('js8-set-band', (e) => { tuned = e; });
  rs._handleMessage(guest, { type: 'js8-set-band', band: '20m', reqId: 'B1' }, {});
  assert.strictEqual(tuned, null, 'a guest must not retune the owner radio');
  assert.strictEqual(guest._sent[0].type, 'js8-send-result');
  assert.strictEqual(guest._sent[0].reqId, 'B1');
  const owner = fakeWs();
  rs._client = owner;
  rs._handleMessage(owner, { type: 'js8-set-band', band: '40m' }, {});
  assert.deepStrictEqual(tuned, { band: '40m' });
});

test('sendJs8Thread and sendJs8SendResult reach the live client', () => {
  const rs = new RemoteServer();
  const ws = fakeWs();
  rs._client = ws;
  rs.sendJs8Thread({ id: 'KN4CRD', messages: [] });
  rs.sendJs8SendResult({ ok: true, text: 'KN4CRD: SNR? ', frames: 1, reqId: 'm1' });
  assert.strictEqual(ws._sent[0].type, 'js8-thread');
  assert.strictEqual(ws._sent[1].type, 'js8-send-result');
  assert.strictEqual(ws._sent[1].frames, 1);
});

// ── multi-client: a JS8 bot and the phone see the same activity ─────────────

function admit(rs, ws) {
  ws._authenticated = true;
  rs._clients.add(ws);
  rs._client = ws;
}

test('two owner clients both receive the same JS8 activity; a guest does not see a DM', () => {
  const rs = new RemoteServer();
  rs.setMultiClient(true);
  const bot = fakeWs();
  const phone = fakeWs();
  const guest = fakeWs();
  guest._passSession = { code: 'G' };
  admit(rs, bot);
  admit(rs, phone); // newest primary; the bot must not be dropped
  admit(rs, guest);
  assert.strictEqual(rs._openClients().length, 3, 'admitting another client does not displace the others');

  rs.broadcastJs8State({ running: true, band: '20m', dialHz: 14078000, submode: 'NORMAL', station: { call: 'K3SBP' } });
  rs.broadcastJs8Activity({ kind: 'activity', text: 'CQ', from: 'W1AW', snr: -10, utc: 1 });
  rs.broadcastJs8Activity({ kind: 'directed', text: 'secret', from: 'K1A', to: 'K3SBP', snr: -8, utc: 2 });
  rs.broadcastJs8Activity({ kind: 'directed', text: 'hi all', from: 'K1A', to: '@ALLCALL', snr: -5, utc: 3 });

  const texts = (ws) => ws._sent.filter((m) => m.type === 'js8-activity').map((m) => m.text);
  assert.deepStrictEqual(texts(bot), ['CQ', 'secret', 'hi all']);
  assert.deepStrictEqual(texts(phone), ['CQ', 'secret', 'hi all'], 'the phone sees the same activity as the bot');
  assert.deepStrictEqual(texts(guest), ['CQ', 'hi all'], 'a directed call is a DM; @ALLCALL is a group');
  assert.strictEqual(bot._sent.find((m) => m.type === 'js8-state').band, '20m');
  assert.strictEqual(phone._sent.find((m) => m.type === 'js8-state').dialHz, 14078000);

  const late = fakeWs();
  late._authenticated = true;
  rs._sendJs8Hydration(late);
  const replay = late._sent.filter((m) => m.type === 'js8-activity');
  assert.deepStrictEqual(replay.map((m) => m.text), ['CQ', 'secret', 'hi all']);
  assert.ok(replay.every((m) => m.replay === true), 'a joiner gets the same tail, marked replay');

  const lateGuest = fakeWs();
  lateGuest._passSession = { code: 'G' };
  rs._sendJs8Hydration(lateGuest);
  assert.deepStrictEqual(
    lateGuest._sent.filter((m) => m.type === 'js8-activity').map((m) => m.text),
    ['CQ', 'hi all'],
  );
});

test('js8-send is refused while another device holds PTT, and that device stays', () => {
  const rs = new RemoteServer();
  rs.setMultiClient(true);
  const holder = fakeWs();
  const phone = fakeWs();
  admit(rs, holder);
  admit(rs, phone);
  rs._pttActive = true;
  rs._pttOwnerWs = holder;
  let emitted = 0;
  rs.on('js8-send', () => { emitted++; });
  rs.on('js8-send-hb', () => { emitted++; });
  rs._handleMessage(phone, { type: 'js8-send', text: 'SNR?', to: 'W1AW', reqId: 'p1' }, {});
  rs._handleMessage(phone, { type: 'js8-send-hb', reqId: 'p2' }, {});
  rs._handleMessage(phone, { type: 'js8-heartbeat', enabled: true, reqId: 'p3' }, {});
  assert.strictEqual(emitted, 0, 'nothing that keys the radio reaches main');
  const refused = phone._sent.filter((m) => m.type === 'ptt-refused');
  assert.strictEqual(refused.length, 3);
  assert.ok(/transmitting/.test(refused[0].message));
  assert.ok(rs._openClients().includes(holder) && rs._openClients().includes(phone));

  // Turning the scheduler off is not a transmission.
  let hb = null;
  rs.on('js8-heartbeat', (e) => { hb = e; });
  rs._handleMessage(phone, { type: 'js8-heartbeat', enabled: false, reqId: 'p4' }, {});
  assert.deepStrictEqual(hb, { enabled: false, intervalMin: undefined, reqId: 'p4' });
});

// ── the web chat screen: confirm before TX, no beacon, guests cannot send ──

test('the ECHOCAT JS8 tab confirms every send and does not transmit on its own', () => {
  const root = require('path').join(__dirname, '..');
  const html = readSrc(require('path').join(root, 'renderer', 'remote.html'));
  const css = readSrc(require('path').join(root, 'renderer', 'remote.css'));
  const web = readSrc(require('path').join(root, 'renderer', 'remote.js'));
  assert.ok(html.includes('data-tab="js8"'), 'tab button');
  assert.ok(html.includes('<button class="mp-btn" data-mode="JS8">JS8</button>'), 'mode picker still retunes; it is unchanged');
  for (const id of ['js8-view', 'js8-power', 'js8-band', 'js8-dial', 'js8-submode', 'js8-list', 'js8-heard', 'js8-to', 'js8-text', 'js8-send', 'js8-confirm', 'js8-confirm-to', 'js8-confirm-text', 'js8-confirm-go', 'js8-confirm-cancel']) {
    assert.ok(html.includes(`id="${id}"`), 'remote.html ' + id);
  }
  assert.ok(html.includes('value="@ALLCALL"'), 'compose defaults to @ALLCALL');
  assert.ok(css.includes('#js8-view') && css.includes('--ds-'), 'styles use the design tokens');
  assert.ok(web.includes("{ id: 'js8',      menuLabel: 'JS8' }"), 'TAB_DEFS');
  for (const id of ['spots', 'map', 'log', 'logbook', 'activate', 'ft8', 'dir', 'sstv']) {
    assert.ok(web.includes("id: '" + id + "'"), 'existing tab ' + id + ' still registered');
  }
  const block = web.slice(web.indexOf('// --- js8 remote chat ---'), web.indexOf('// --- end js8 remote chat ---'));
  assert.ok(block.length > 500, 'chat block present');
  assert.ok(block.includes("sendToServer({ type: 'js8-send', text: draft.text, to: draft.to, reqId: reqId })"), 'send passes text and to separately');
  assert.strictEqual(block.split("type: 'js8-send'").length, 2, 'the only transmit of a message is js8ConfirmGo');
  assert.ok(block.includes('function js8ConfirmGo'), 'confirm is a tap, not an automatic send');
  assert.ok(!/js8-heartbeat|js8-send-hb|js8-send-sms|js8-set-hback/.test(block), 'this screen never beacons, heartbeats, or auto-replies');
  assert.ok(!/remoteToken|console\.log\(/.test(block), 'the chat does not log, and does not touch the token');
  assert.ok(block.includes('js8Guest()') && block.includes('Guest Pass is receive-only'), 'guest sessions cannot transmit from the UI');
  assert.ok(/tab === 'js8'\) \{\s*\/\/ The chat only/.test(web), 'opening the tab does not start or tune');
  assert.ok(!/tab === 'js8'[\s\S]{0,180}js8-start/.test(web), 'switchTab does not start the engine');
  assert.ok(web.includes("case 'js8-state':") && web.includes("case 'js8-activity':") && web.includes("case 'js8-heard':") && web.includes("case 'js8-send-result':") && web.includes("case 'ptt-refused':"));
});

console.log(`\nJS8 remote: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
