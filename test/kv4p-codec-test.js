#!/usr/bin/env node
'use strict';

// kv4p HT protocol, from firmware tag v2.0.0.1 (protocol.h, test_kiss_protocol.cpp,
// RadioAudioService / ToneHelper). Run: node test/kv4p-codec-test.js

const assert = require('assert');
const { EventEmitter } = require('events');
const P = require('../lib/codecs/kv4p-codec');
const { Kv4pClient } = require('../lib/kv4p-client');
const { probePlan } = require('../scripts/kv4p-probe');

let pass = 0, fail = 0;
function test(name, fn) {
  try { const r = fn(); if (r && typeof r.then === 'function') return r.then(() => { pass++; console.log('  ok  ' + name); }, (e) => { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); return; }
  pass++; console.log('  ok  ' + name);
}

console.log('=== wire sizes (firmware static_asserts) ===');
test('HostDesiredState 22, DeviceState 26, Version 17, Hello 43', () => {
  assert.strictEqual(P.HOST_DESIRED_LEN, 22);
  assert.strictEqual(P.DEVICE_STATE_LEN, 26);
  assert.strictEqual(P.VERSION_LEN, 17);
  assert.strictEqual(P.HELLO_LEN, 43);
  assert.strictEqual(P.packHostDesiredState({ sequence: 1, memoryId: -1, flags: 0, bw: 1, freqTx: 146.52, freqRx: 146.52, ctcssTx: 0, squelch: 1, ctcssRx: 0 }).length, 22);
  assert.strictEqual(P.packHello({ ver: 17, windowSize: 2048, minMhz: 134, maxMhz: 174 }, { appliedSequence: 0, memoryId: -1 }).length, 43);
});

test('desired state round-trips little-endian, including a byte that KISS must escape', () => {
  const state = { sequence: 0x01020304, memoryId: -1, flags: P.HOST_STATE_HIGH_POWER | P.HOST_STATE_TX_ALLOWED, bw: P.BW_25K, freqTx: 145.92, freqRx: 146.52, ctcssTx: 10, squelch: 0xC0, ctcssRx: 10 };
  const packed = P.packHostDesiredState(state);
  assert.strictEqual(packed.readUInt32LE(0), 0x01020304);
  assert.strictEqual(packed.readInt32LE(4), -1);
  assert.strictEqual(packed[20], 0xC0);
  const back = P.unpackHostDesiredState(packed);
  assert.strictEqual(back.sequence, state.sequence);
  assert.strictEqual(back.memoryId, -1);
  assert.strictEqual(back.squelch, 0xC0);
  assert.strictEqual(back.ctcssTx, 10);
  assert.ok(Math.abs(back.freqRx - P.f32(146.52)) < 1e-6);
  const frame = P.encodeDesiredStateFrame(state);
  assert.strictEqual(frame[0], 0xC0);
  assert.strictEqual(frame[1], 0x06);
  assert.ok(frame.includes(0xDB) && frame.includes(0xDC), '0xC0 inside the payload is escaped');
  const parsed = P.createParser().push(frame);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].command, P.CMD_HOST_DESIRED_STATE);
  assert.deepStrictEqual(P.unpackHostDesiredState(parsed[0].payload), back);
});

console.log('=== KISS fixtures from test_kiss_protocol.cpp ===');
test('DATA frame unescapes FEND and FESC', () => {
  // test_data_frame_unescapes_and_dispatches_ax25
  const frame = Buffer.from([0xC0, 0x00, 0x11, 0xDB, 0xDC, 0x22, 0xDB, 0xDD, 0xC0]);
  const out = P.createParser().push(frame);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'ax25');
  assert.deepStrictEqual([...out[0].payload], [0x11, 0xC0, 0x22, 0xDB]);
});

test('two frames in one buffer, and a frame split across reads', () => {
  // test_multiple_complete_frames_in_one_buffer
  const frames = Buffer.from([
    0xC0, 0x00, 0x11, 0x22, 0xC0,
    0xC0, 0x06, 0x4B, 0x56, 0x34, 0x50, 0x01, 0x0D, 0x33, 0x44, 0xC0,
  ]);
  const both = P.createParser().push(frames);
  assert.strictEqual(both[0].kind, 'ax25');
  assert.deepStrictEqual([...both[0].payload], [0x11, 0x22]);
  assert.strictEqual(both[1].command, 0x0D);
  assert.deepStrictEqual([...both[1].payload], [0x33, 0x44]);

  const p = P.createParser();
  assert.deepStrictEqual(p.push(Buffer.from([0xC0, 0x00, 0x11])), []);
  const rest = p.push(Buffer.from([0x22, 0xC0]));
  assert.deepStrictEqual([...rest[0].payload], [0x11, 0x22]);
});

test('ASCII before the first FEND is ignored (the boot banner)', () => {
  const banner = Buffer.from('===== kv4p serial output =====\r\n');
  const hello = P.encodeVendorFrame(P.CMD_HELLO, Buffer.alloc(P.HELLO_LEN, 0));
  const out = P.createParser().push(Buffer.concat([banner, hello]));
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].command, P.CMD_HELLO);
  assert.strictEqual(out[0].payload.length, P.HELLO_LEN);
});

test('a bad escape drops the frame', () => {
  const frame = Buffer.from([0xC0, 0x06, 0xDB, 0x00, 0xC0]);
  assert.deepStrictEqual(P.createParser().push(frame), []);
});

console.log('=== band, tone, time-out ===');
test('HELLO reports VHF; a setting is only the fallback', () => {
  const vhf = P.moduleFromHello({ rfModuleType: P.RF_SA818_VHF, minMhz: 134, maxMhz: 174 }, 'uhf');
  assert.strictEqual(vhf.id, 'vhf');
  assert.strictEqual(vhf.reported, true);
  const guessed = P.moduleFromHello({ rfModuleType: 9, minMhz: 400, maxMhz: 480 }, 'auto');
  assert.strictEqual(guessed.id, 'uhf');
  const forced = P.moduleFromHello(null, 'uhf');
  assert.strictEqual(forced.id, 'uhf');
  assert.strictEqual(forced.minMhz, 400);
});

test('RX outside the module is refused; weather RX is allowed but not TX; repeater offset is checked', () => {
  const module = P.moduleFromHello({ rfModuleType: P.RF_SA818_VHF, minMhz: 134, maxMhz: 174 }, 'auto');
  assert.strictEqual(P.planTune({ rxMhz: 14.074, offsetKhz: 0, module }).ok, false);
  const wx = P.planTune({ rxMhz: 162.55, offsetKhz: 0, module });
  assert.strictEqual(wx.ok, true);
  assert.strictEqual(wx.txAllowed, false);
  const rpt = P.planTune({ rxMhz: 146.52, offsetKhz: -600, module });
  assert.strictEqual(rpt.ok, true);
  assert.ok(Math.abs(rpt.txMhz - P.f32(145.92)) < 1e-4);
  assert.strictEqual(rpt.txAllowed, true);
  const past = P.planTune({ rxMhz: 173.8, offsetKhz: 600, module });
  assert.strictEqual(past.ok, false);
});

test('the rig editor tone list is the codec tone list', () => {
  const tones = require('../lib/kv4p-tones');
  assert.strictEqual(tones.CTCSS_HZ.length, P.CTCSS_HZ.length);
  assert.strictEqual(tones.CTCSS_HZ[12], 100);
});

test('SA818 group command matches arduino-dra818 sprintf, and 446.0000 is on both rasters', () => {
  // DRA818::group at 89582e3 (the commit firmware v2.0.0.1 vendors):
  //   dtostrf(freq, 8, 4) and AT+DMOSETGROUP=%01d,%s,%s,%04d,%c,%04d
  // DRA818U manual example uses GBW 0. GBW 1 is 25 kHz and some modules
  // answer "data out of range" to it.
  assert.strictEqual(
    P.sa818GroupCommand({ bw: P.BW_12K5, freqTx: 446, freqRx: 446, ctcssTx: 0, squelch: 0, ctcssRx: 0 }),
    'AT+DMOSETGROUP=0,446.0000,446.0000,0000,0,0000\r\n',
  );
  assert.strictEqual(
    P.sa818GroupCommand({ bw: P.BW_25K, freqTx: 446, freqRx: 446, ctcssTx: 0, squelch: 4, ctcssRx: 0 }),
    'AT+DMOSETGROUP=1,446.0000,446.0000,0000,4,0000\r\n',
  );
  const packed = P.packHostDesiredState({
    sequence: 1, memoryId: -1, flags: P.HOST_STATE_RADIO_CONFIG_VALID,
    bw: P.BW_12K5, freqTx: 446, freqRx: 446, ctcssTx: 0, squelch: 0, ctcssRx: 0,
  });
  assert.strictEqual(packed.length, 22);
  assert.strictEqual(packed[10], 0, 'bandwidth byte is 12.5 kHz, not 25');
  assert.strictEqual(packed.subarray(11, 15).toString('hex'), '0000df43', '446.0 MHz float32 little-endian');
  assert.strictEqual(packed.subarray(15, 19).toString('hex'), '0000df43');
  const back = P.unpackHostDesiredState(packed);
  assert.strictEqual(P.sa818GroupCommand(back).replace('freqTx', ''), P.sa818GroupCommand({
    bw: back.bw, freqTx: back.freqTx, freqRx: back.freqRx, ctcssTx: back.ctcssTx, squelch: back.squelch, ctcssRx: back.ctcssRx,
  }));
  assert.strictEqual(P.snapMhz(446, P.BW_12K5).text, '446.0000');
  assert.strictEqual(P.snapMhz(446, P.BW_25K).text, '446.0000');
  // 146.520 is the 2 m calling channel and is NOT a 12.5 kHz step. The module would NAK it.
  assert.notStrictEqual(P.snapMhz(146.52, P.BW_12K5).text, '146.5200');
  assert.strictEqual(P.bandwidthByte(undefined), null);
  assert.strictEqual(P.bandwidthByte('12.5'), P.BW_12K5);
  assert.strictEqual(P.bandwidthByte('25'), P.BW_25K);
});

test('CTCSS index matches ToneHelper (0 = none, 100.0 Hz is 100)', () => {
  assert.strictEqual(P.ctcssIndex('None'), 0);
  assert.strictEqual(P.ctcssIndex(0), 0);
  assert.strictEqual(P.ctcssIndex('100.0'), P.CTCSS_HZ.indexOf(100));
  assert.strictEqual(P.ctcssIndex('88.5'), P.CTCSS_HZ.indexOf(88.5));
  assert.strictEqual(P.ctcssLabel(P.ctcssIndex('123.0')), '123');
  assert.strictEqual(P.signedOffsetKhz({ offset: 'minus', offsetKhz: 600 }), -600);
  assert.strictEqual(P.signedOffsetKhz({ offset: 'simplex', offsetKhz: 600 }), 0);
});

test('transmit time-out defaults to 3 minutes and cannot be turned off', () => {
  assert.strictEqual(P.txTimeoutMs(undefined), 180000);
  assert.strictEqual(P.txTimeoutMs(0), 180000);
  assert.strictEqual(P.txTimeoutMs(30), 30000);
  assert.strictEqual(P.txTimeoutMs(9999), 600000);
});

test('a Linux permission error names uucp and dialout', () => {
  const text = P.openErrorHint(new Error('Permission denied'), 'linux');
  assert.ok(/uucp/.test(text) && /dialout/.test(text));
  assert.ok(!/uucp/.test(P.openErrorHint(new Error('Permission denied'), 'darwin')));
});

console.log('=== probe refuses to transmit unless --tx ===');
test('a kv4p target is a serial device the port watch can see', () => {
  const Presence = require('../lib/serial-port-presence');
  assert.strictEqual(Presence.portOfTarget({ type: 'kv4p', path: '/dev/ttyUSB0' }), '/dev/ttyUSB0');
  assert.strictEqual(Presence.portOfTarget({ type: 'kv4p', path: '/dev/cu.usbserial-1110' }), '/dev/cu.usbserial-1110');
});

test('probe plan', () => {
  assert.strictEqual(probePlan(['--port', '/dev/ttyUSB0']).tx, false);
  assert.strictEqual(probePlan(['--port', '/dev/cu.usbserial-1110', '--freq', '146.52', '--listen', '5']).tx, false);
  assert.strictEqual(probePlan(['--port', '/dev/ttyUSB0', '--freq', '146.52', '--tx', '--tx-ms', '200']).tx, true);
  assert.ok(probePlan(['--tx']).error);
  assert.ok(probePlan(['--port', '/dev/ttyUSB0', '--tx']).error);
});

console.log('=== client: hello, no TX, time-out, silence reset ===');
function fakePort() {
  const port = new EventEmitter();
  port.isOpen = false;
  port.writes = [];
  port.open = (cb) => { port.isOpen = true; cb(); };
  port.write = (buf) => { port.writes.push(Buffer.from(buf)); };
  port.set = (_s, cb) => { if (cb) cb(); };
  port.close = (cb) => { port.isOpen = false; if (cb) cb(); };
  return port;
}
function helloFrame(freq) {
  return P.encodeVendorFrame(P.CMD_HELLO, P.packHello({
    ver: 17, radioModuleStatus: P.RADIO_FOUND, windowSize: 2048,
    rfModuleType: P.RF_SA818_VHF, minMhz: 134, maxMhz: 174, features: 1,
  }, {
    appliedSequence: 3, memoryId: -1, flags: P.HOST_STATE_TX_ALLOWED, bw: P.BW_25K,
    freqTx: freq, freqRx: freq, ctcssTx: 0, squelch: 0, ctcssRx: 0,
    radioModuleStatus: P.RADIO_FOUND, mode: P.MODE_RX, lastError: 0, latestRssi: 40,
  }));
}
function lastDesired(port) {
  const parsed = [];
  const parser = P.createParser();
  for (const w of port.writes) parsed.push(...parser.push(w));
  const frames = parsed.filter((f) => f.command === P.CMD_HOST_DESIRED_STATE);
  return P.unpackHostDesiredState(frames[frames.length - 1].payload);
}

function clientOn(port) {
  const timers = [];
  const client = new Kv4pClient({
    openPort: () => port,
    sleep: async () => {},
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { if (t) t.cleared = true; },
  });
  return { client, timers };
}
async function flush() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
}

test('HELLO does not key the radio, and a stuck PTT is released', async () => {
  const port = fakePort();
  const { client, timers } = clientOn(port);
  const freqs = [];
  const timeouts = [];
  client.on('frequency', (hz) => freqs.push(hz));
  client.on('tx-timeout', (t) => timeouts.push(t));
  client.connect({ path: '/dev/ttyUSB0', band: 'auto', squelch: 2, offset: 'simplex', ctcss: '100.0', bandwidth: '25', txTimeoutSec: 180 });
  await flush();
  port.emit('data', helloFrame(146.52));
  assert.strictEqual(client.connected, true);
  assert.strictEqual(client.summary().firmware, 17);
  assert.strictEqual(client.summary().moduleId, 'vhf');
  const seeded = lastDesired(port);
  assert.strictEqual(seeded.flags & P.HOST_STATE_PTT_REQUESTED, 0, 'connect must not ask for PTT');
  assert.strictEqual(seeded.squelch, 2);
  assert.strictEqual(seeded.ctcssTx, P.ctcssIndex('100.0'));
  assert.ok(freqs[0] > 146e6 && freqs[0] < 147e6);

  assert.strictEqual(client.tune(14.074e6, 'USB'), false);
  assert.strictEqual(client.setTransmit(true), true, '146.52 is inside the 2 m segment');
  assert.ok(lastDesired(port).flags & P.HOST_STATE_PTT_REQUESTED);
  const txTimer = timers.filter((t) => !t.cleared && t.ms === 180000).pop();
  assert.ok(txTimer, 'the 3 minute time-out is armed');
  txTimer.fn();
  assert.strictEqual(client._keyed, false);
  assert.strictEqual(lastDesired(port).flags & P.HOST_STATE_PTT_REQUESTED, 0);
  assert.strictEqual(timeouts.length, 1);
  await client.disconnect();
});

test('eight seconds of silence resets the ESP32 without a new port', async () => {
  const port = fakePort();
  const { client, timers } = clientOn(port);
  let resets = 0;
  const orig = client._pulseReset.bind(client);
  client._pulseReset = async (p) => { resets++; return orig(p); };
  client.connect({ path: '/dev/ttyACM0', band: 'auto' });
  await flush();
  const opens = resets;
  port.emit('data', helloFrame(145.5));
  const silence = timers.filter((t) => !t.cleared && t.ms === 8000).pop();
  assert.ok(silence, 'silence watch is armed after HELLO');
  await silence.fn();
  assert.ok(resets > opens, 'the same port is reset');
  assert.strictEqual(port.isOpen, true);
  port.emit('data', helloFrame(145.5));
  assert.strictEqual(client.connected, true);
  await client.disconnect();
});

test('a tune keeps the radio bandwidth and a rejected group command is reported', async () => {
  const port = fakePort();
  const { client } = clientOn(port);
  const rejected = [];
  const freqs = [];
  client.on('tune-rejected', (info) => rejected.push(info));
  client.on('frequency', (hz) => freqs.push(hz));
  client.connect({ path: '/dev/ttyUSB0', band: 'uhf', offset: 'simplex' });
  await flush();
  const hello = P.encodeVendorFrame(P.CMD_HELLO, P.packHello({
    ver: 17, radioModuleStatus: P.RADIO_FOUND, windowSize: 2048,
    rfModuleType: P.RF_SA818_UHF, minMhz: 400, maxMhz: 480, features: 1,
  }, {
    appliedSequence: 2, memoryId: -1, flags: 0, bw: P.BW_12K5,
    freqTx: 441.45, freqRx: 441.45, ctcssTx: 0, squelch: 4, ctcssRx: 0,
    radioModuleStatus: P.RADIO_FOUND, mode: P.MODE_RX, lastError: 0, latestRssi: 0,
  }));
  port.emit('data', hello);
  const seeded = lastDesired(port);
  assert.strictEqual(seeded.bw, P.BW_12K5, 'do not force 25 kHz over the radio');
  assert.strictEqual(seeded.squelch, 4);
  assert.ok(Math.abs(seeded.freqRx - 441.45) < 0.001);
  assert.strictEqual(client.tune(446e6, 'FM'), true);
  const asked = lastDesired(port);
  assert.strictEqual(asked.bw, P.BW_12K5);
  assert.ok(Math.abs(asked.freqRx - 446) < 0.001, 'asked for 446');
  assert.strictEqual(P.sa818GroupCommand({
    bw: asked.bw, freqTx: asked.freqTx, freqRx: asked.freqRx,
    ctcssTx: asked.ctcssTx, squelch: asked.squelch, ctcssRx: asked.ctcssRx,
  }), 'AT+DMOSETGROUP=0,446.0000,446.0000,0000,4,0000\r\n');
  // The dial must not pretend the tune landed.
  assert.ok(freqs.every((hz) => hz < 442e6), 'UI still shows the radio, not 446');
  const state = P.encodeVendorFrame(P.CMD_DEVICE_STATE, P.packDeviceState({
    appliedSequence: asked.sequence, memoryId: -1, flags: asked.flags, bw: P.BW_12K5,
    freqTx: 441.45, freqRx: 441.45, ctcssTx: 0, squelch: 4, ctcssRx: 0,
    radioModuleStatus: P.RADIO_FOUND, mode: P.MODE_RX, lastError: P.ERROR_RADIO_CONFIG, latestRssi: 0,
  }));
  port.emit('data', state);
  assert.strictEqual(rejected.length, 1);
  assert.ok(/rejected 446\.0000/.test(rejected[0].message));
  assert.ok(/441\.4500/.test(rejected[0].message));
  await client.disconnect();
});

test('a dropped port schedules another open and does not transmit on the way', async () => {
  const ports = [];
  const { client } = clientOn(null);
  client._openPort = () => { const p = fakePort(); ports.push(p); return p; };
  client.connect({ path: '/dev/ttyUSB0' });
  await flush();
  ports[0].emit('data', helloFrame(146.52));
  client.setTransmit(true);
  ports[0].emit('error', new Error('EIO'));
  await flush();
  assert.strictEqual(client.connected, false);
  assert.strictEqual(client._keyed, false);
  const retry = client._retryTimer;
  assert.ok(retry, 'reconnect is scheduled');
  retry.fn();
  await flush();
  assert.ok(ports.length >= 2, 'the port is opened again');
  await client.disconnect();
});

Promise.resolve().then(() => {}).then(() => {
  // tests that return promises are tracked above; give them a turn
}).then(() => setTimeout(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 200));
