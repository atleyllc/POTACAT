'use strict';

const Tones = require('../kv4p-tones');

/**
 * kv4p HT serial protocol (firmware v2.0.0.1 / firmware ver 17).
 *
 * Wire format, from microcontroller-src/kv4p_ht_esp32_wroom_32/protocol.h
 * and the matching Android Protocol.java at tag v2.0.0.1:
 *
 *   FEND 0x06 "KV4P" 0x01 <command> <payload> FEND
 *
 * KISS escaping: 0xC0 → DB DC, 0xDB → DB DD. Multi-byte fields are
 * little-endian. HostDesiredState is 22 bytes, DeviceState 26, Version 17,
 * Hello 43 (the firmware test static_asserts).
 *
 * Frequencies are MHz as IEEE-754 floats. The SA818 group command takes
 * them that way (134–174 VHF, 400–480 UHF). Audio payloads are raw Opus
 * packets, 48 kHz mono, 40 ms frames (1920 samples). This module does not
 * encode audio; it only frames bytes.
 *
 * Pure: no serial port, no Opus. lib/kv4p-client.js speaks it.
 */

const FEND = 0xC0;
const FESC = 0xDB;
const TFEND = 0xDC;
const TFESC = 0xDD;
const KISS_DATA = 0x00;
const KISS_SETHARDWARE = 0x06;
const PROTOCOL_VERSION = 0x01;
const VENDOR_PREFIX = Buffer.from('KV4P');
const VENDOR_HEADER_LEN = 6; // "KV4P" + version + command
const PROTO_MTU = 2048;
const KISS_MAX_FRAME = PROTO_MTU + 1 + VENDOR_HEADER_LEN;

const CMD_HOST_TX_AUDIO = 0x07;
const CMD_HOST_DESIRED_STATE = 0x0D;
const CMD_DEBUG_INFO = 0x01;
const CMD_DEBUG_ERROR = 0x02;
const CMD_DEBUG_WARN = 0x03;
const CMD_DEBUG_DEBUG = 0x04;
const CMD_DEBUG_TRACE = 0x05;
const CMD_HELLO = 0x06;
const CMD_RX_AUDIO = 0x07;
const CMD_WINDOW_UPDATE = 0x09;
const CMD_DEVICE_STATE = 0x0B;

const HOST_STATE_RADIO_CONFIG_VALID = 1 << 0;
const HOST_STATE_PTT_REQUESTED = 1 << 1;
const HOST_STATE_RX_AUDIO_OPEN = 1 << 2;
const HOST_STATE_HIGH_POWER = 1 << 3;
const HOST_STATE_RSSI_ENABLED = 1 << 4;
const HOST_STATE_FILTER_PRE = 1 << 5;
const HOST_STATE_FILTER_HIGH = 1 << 6;
const HOST_STATE_FILTER_LOW = 1 << 7;
const DEVICE_STATE_PHYS_PTT_DOWN = 1 << 8;
const DEVICE_STATE_TX_ACTIVE = 1 << 9;
const DEVICE_STATE_SQUELCHED = 1 << 10;
const HOST_STATE_TX_ALLOWED = 1 << 11;
const HOST_STATE_ENABLE_STATUS_REPORTS = 1 << 12;

const DESIRED_FLAGS_MASK =
  HOST_STATE_RADIO_CONFIG_VALID | HOST_STATE_PTT_REQUESTED | HOST_STATE_RX_AUDIO_OPEN |
  HOST_STATE_HIGH_POWER | HOST_STATE_RSSI_ENABLED | HOST_STATE_FILTER_PRE |
  HOST_STATE_FILTER_HIGH | HOST_STATE_FILTER_LOW | HOST_STATE_TX_ALLOWED |
  HOST_STATE_ENABLE_STATUS_REPORTS;

const BW_12K5 = 0x00;
const BW_25K = 0x01;

const RF_SA818_VHF = 0;
const RF_SA818_UHF = 1;

const RADIO_FOUND = 0x66; // 'f'
const RADIO_NOT_FOUND = 0x78; // 'x'

const MODE_TX = 0;
const MODE_RX = 1;
const MODE_STOPPED = 2;

const ERROR_NONE = 0;
const ERROR_RADIO_CONFIG = 1;
const ERROR_FILTERS = 2;

const HOST_DESIRED_LEN = 22;
const DEVICE_STATE_LEN = 26;
const VERSION_LEN = 17;
const HELLO_LEN = VERSION_LEN + DEVICE_STATE_LEN; // 43
const BAUD_RATE = 115200;
const AUDIO_SAMPLE_RATE = 48000;
const OPUS_FRAME_SAMPLES = 1920; // 40 ms at 48 kHz (RadioAudioService.OPUS_FRAME_SIZE)

// DRA818 tone index. Index 0 is no tone. The rest match ToneHelper.java at v2.0.0.1.
const CTCSS_HZ = Tones.CTCSS_HZ;

// Module edges from kv4p.ino moduleMinRadioFreq / moduleMaxRadioFreq.
// Amateur TX edges are the Android app's defaults (RadioAudioService):
// 144–148 and 420–450, which cover the US segments and the EU 2 m / 70 cm
// slices inside them. RX is the whole module range.
const MODULES = {
  vhf: { id: 'vhf', label: 'VHF (2 m)', rfType: RF_SA818_VHF, minMhz: 134, maxMhz: 174, txMinMhz: 144, txMaxMhz: 148 },
  uhf: { id: 'uhf', label: 'UHF (70 cm)', rfType: RF_SA818_UHF, minMhz: 400, maxMhz: 480, txMinMhz: 420, txMaxMhz: 450 },
};

function kissEscape(buf) {
  const src = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    if (b === FEND) out.push(FESC, TFEND);
    else if (b === FESC) out.push(FESC, TFESC);
    else out.push(b);
  }
  return Buffer.from(out);
}

/** One KV4P vendor frame, already escaped and wrapped in FEND. */
function encodeVendorFrame(command, payload) {
  const body = Buffer.alloc(VENDOR_HEADER_LEN + (payload ? payload.length : 0));
  VENDOR_PREFIX.copy(body, 0);
  body[4] = PROTOCOL_VERSION;
  body[5] = command & 0xFF;
  if (payload && payload.length) payload.copy(body, VENDOR_HEADER_LEN);
  const esc = kissEscape(body);
  const frame = Buffer.alloc(2 + esc.length + 1);
  frame[0] = FEND;
  frame[1] = KISS_SETHARDWARE;
  esc.copy(frame, 2);
  frame[frame.length - 1] = FEND;
  return frame;
}

function encodeDesiredStateFrame(state) {
  return encodeVendorFrame(CMD_HOST_DESIRED_STATE, packHostDesiredState(state));
}

function encodeTxAudioFrame(opus) {
  const payload = Buffer.isBuffer(opus) ? opus : Buffer.from(opus || []);
  const clipped = payload.length > PROTO_MTU ? payload.subarray(0, PROTO_MTU) : payload;
  return encodeVendorFrame(CMD_HOST_TX_AUDIO, clipped);
}

function packHostDesiredState(s) {
  const b = Buffer.alloc(HOST_DESIRED_LEN);
  b.writeUInt32LE((s.sequence >>> 0), 0);
  b.writeInt32LE(s.memoryId | 0, 4);
  b.writeUInt16LE(s.flags & 0xFFFF, 8);
  b[10] = s.bw & 0xFF;
  b.writeFloatLE(Number(s.freqTx) || 0, 11);
  b.writeFloatLE(Number(s.freqRx) || 0, 15);
  b[19] = s.ctcssTx & 0xFF;
  b[20] = s.squelch & 0xFF;
  b[21] = s.ctcssRx & 0xFF;
  return b;
}

function unpackHostDesiredState(buf, offset = 0) {
  if (!buf || buf.length < offset + HOST_DESIRED_LEN) return null;
  return {
    sequence: buf.readUInt32LE(offset),
    memoryId: buf.readInt32LE(offset + 4),
    flags: buf.readUInt16LE(offset + 8),
    bw: buf[offset + 10],
    freqTx: buf.readFloatLE(offset + 11),
    freqRx: buf.readFloatLE(offset + 15),
    ctcssTx: buf[offset + 19],
    squelch: buf[offset + 20],
    ctcssRx: buf[offset + 21],
  };
}

function unpackDeviceState(buf, offset = 0) {
  if (!buf || buf.length < offset + DEVICE_STATE_LEN) return null;
  return {
    appliedSequence: buf.readUInt32LE(offset),
    memoryId: buf.readInt32LE(offset + 4),
    flags: buf.readUInt16LE(offset + 8),
    bw: buf[offset + 10],
    freqTx: buf.readFloatLE(offset + 11),
    freqRx: buf.readFloatLE(offset + 15),
    ctcssTx: buf[offset + 19],
    squelch: buf[offset + 20],
    ctcssRx: buf[offset + 21],
    radioModuleStatus: buf[offset + 22],
    mode: buf[offset + 23],
    lastError: buf[offset + 24],
    latestRssi: buf[offset + 25],
  };
}

function unpackVersion(buf, offset = 0) {
  if (!buf || buf.length < offset + VERSION_LEN) return null;
  const features = buf[offset + 16];
  return {
    ver: buf.readUInt16LE(offset),
    radioModuleStatus: buf[offset + 2],
    windowSize: buf.readUInt32LE(offset + 3),
    rfModuleType: buf[offset + 7],
    minMhz: buf.readFloatLE(offset + 8),
    maxMhz: buf.readFloatLE(offset + 12),
    features,
    hasHl: (features & 0x01) !== 0,
    hasPhysPtt: (features & 0x02) !== 0,
    hasEsp32Afsk: (features & 0x04) !== 0,
  };
}

function unpackHello(buf, offset = 0) {
  if (!buf || buf.length < offset + HELLO_LEN) return null;
  const version = unpackVersion(buf, offset);
  const deviceState = unpackDeviceState(buf, offset + VERSION_LEN);
  if (!version || !deviceState) return null;
  return { version, deviceState };
}

function unpackWindowUpdate(buf, offset = 0) {
  if (!buf || buf.length < offset + 4) return null;
  return { size: buf.readUInt32LE(offset) };
}

function packDeviceState(s) {
  const b = Buffer.alloc(DEVICE_STATE_LEN);
  b.writeUInt32LE((s.appliedSequence >>> 0), 0);
  b.writeInt32LE(s.memoryId | 0, 4);
  b.writeUInt16LE((s.flags || 0) & 0xFFFF, 8);
  b[10] = (s.bw || 0) & 0xFF;
  b.writeFloatLE(Number(s.freqTx) || 0, 11);
  b.writeFloatLE(Number(s.freqRx) || 0, 15);
  b[19] = (s.ctcssTx || 0) & 0xFF;
  b[20] = (s.squelch || 0) & 0xFF;
  b[21] = (s.ctcssRx || 0) & 0xFF;
  b[22] = (s.radioModuleStatus || 0) & 0xFF;
  b[23] = (s.mode || 0) & 0xFF;
  b[24] = (s.lastError || 0) & 0xFF;
  b[25] = (s.latestRssi || 0) & 0xFF;
  return b;
}

function packVersion(v) {
  const b = Buffer.alloc(VERSION_LEN);
  b.writeUInt16LE((v.ver || 0) & 0xFFFF, 0);
  b[2] = (v.radioModuleStatus || 0) & 0xFF;
  b.writeUInt32LE((v.windowSize >>> 0), 3);
  b[7] = (v.rfModuleType || 0) & 0xFF;
  b.writeFloatLE(Number(v.minMhz) || 0, 8);
  b.writeFloatLE(Number(v.maxMhz) || 0, 12);
  b[16] = (v.features || 0) & 0xFF;
  return b;
}

function packHello(version, deviceState) {
  return Buffer.concat([packVersion(version), packDeviceState(deviceState)]);
}

/** Signed repeater offset in kHz. `minus`/`plus` use the magnitude; anything else is simplex. */
function signedOffsetKhz(target) {
  const t = target || {};
  const mag = Math.abs(Number(t.offsetKhz) || 0);
  if (t.offset === 'minus') return -mag;
  if (t.offset === 'plus') return mag;
  return 0;
}

/**
 * How long a key-down may last before the radio is forced back to receive.
 * Default 3 minutes. The box is 15 s to 10 min so a remote PTT cannot be
 * configured to stay keyed, and a blank or 0 keeps the default.
 */
function txTimeoutMs(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return 180000;
  return Math.round(Math.max(15, Math.min(600, n)) * 1000);
}

/** Words for an open() failure. Arch's serial group is uucp; Debian's is dialout. */
function openErrorHint(err, platform = process.platform) {
  const msg = String((err && err.message) || err || 'could not open the port');
  if (platform === 'linux' && /permission|eacces|access/i.test(msg)) {
    return msg + '. On Arch Linux add your user to the uucp group (`sudo usermod -aG uucp $USER`, then log out and back in). On Debian and Ubuntu the group is dialout. Then unplug the radio and plug it back in.';
  }
  return msg;
}

/**
 * Incremental KISS parser. Vendor frames come out as
 * { kind: 'vendor', command, payload }. AX.25 DATA frames as { kind: 'ax25', payload }.
 * Bytes before the first FEND (the firmware's ASCII boot banner) are ignored.
 */
function createParser() {
  let frame = [];
  let escape = false;
  let drop = false;
  let inFrame = false;

  function reset() {
    frame = [];
    escape = false;
    drop = false;
    inFrame = false;
  }

  function finish() {
    if (!frame.length || drop) return null;
    const kiss = frame[0];
    const port = kiss >> 4;
    const cmd = kiss & 0x0F;
    const payload = Buffer.from(frame.slice(1));
    if (port !== 0) return null;
    if (cmd === KISS_DATA) {
      if (payload.length > 0 && payload.length <= PROTO_MTU) return { kind: 'ax25', payload };
      return null;
    }
    if (cmd !== KISS_SETHARDWARE) return null;
    if (payload.length < VENDOR_HEADER_LEN) return null;
    if (payload[0] !== 0x4B || payload[1] !== 0x56 || payload[2] !== 0x34 || payload[3] !== 0x50) return null;
    if (payload[4] !== PROTOCOL_VERSION) return null;
    const command = payload[5];
    const body = payload.subarray(VENDOR_HEADER_LEN);
    if (body.length > PROTO_MTU) return null;
    return { kind: 'vendor', command, payload: Buffer.from(body) };
  }

  function push(bytes) {
    const src = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const b = src[i];
      if (b === FEND) {
        if (frame.length && !drop) {
          const msg = finish();
          if (msg) out.push(msg);
        }
        reset();
        inFrame = true;
        continue;
      }
      if (!inFrame || drop) continue;
      if (escape) {
        if (b === TFEND) frame.push(FEND);
        else if (b === TFESC) frame.push(FESC);
        else drop = true;
        escape = false;
        continue;
      }
      if (b === FESC) { escape = true; continue; }
      if (frame.length >= KISS_MAX_FRAME) { drop = true; continue; }
      frame.push(b);
    }
    return out;
  }

  return { push, reset };
}

function ctcssIndex(value) {
  if (value == null || value === '' || value === 'None' || value === 'none') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 1..38 is the DRA818 index (ToneHelper). 67 and up is a tone in Hz.
  if (Number.isInteger(n) && n >= 1 && n < CTCSS_HZ.length && n < CTCSS_HZ[1]) return n;
  let best = 0;
  let bestDist = 1.01;
  for (let i = 1; i < CTCSS_HZ.length; i++) {
    const d = Math.abs(CTCSS_HZ[i] - n);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function ctcssLabel(index) {
  const i = index & 0xFF;
  if (!i || i >= CTCSS_HZ.length) return 'None';
  const hz = CTCSS_HZ[i];
  return Number.isInteger(hz) ? String(hz) : String(hz);
}

function bandwidthByte(value) {
  if (value === BW_12K5 || value === '12.5' || value === '12.5k' || value === '12.5kHz') return BW_12K5;
  return BW_25K;
}

function moduleFromHello(version, bandSetting) {
  const forced = bandSetting === 'vhf' || bandSetting === 'uhf' ? bandSetting : '';
  let id = '';
  if (version && version.rfModuleType === RF_SA818_UHF) id = 'uhf';
  else if (version && version.rfModuleType === RF_SA818_VHF) id = 'vhf';
  else if (forced) id = forced;
  else if (version && Number.isFinite(version.minMhz) && version.minMhz >= 300) id = 'uhf';
  else if (version && Number.isFinite(version.minMhz) && version.minMhz > 0) id = 'vhf';
  else id = forced || 'vhf';
  const base = MODULES[id];
  const minMhz = version && Number.isFinite(version.minMhz) && version.minMhz > 1 ? version.minMhz : base.minMhz;
  const maxMhz = version && Number.isFinite(version.maxMhz) && version.maxMhz > minMhz ? version.maxMhz : base.maxMhz;
  return { ...base, minMhz, maxMhz, reported: !!(version && (version.rfModuleType === RF_SA818_VHF || version.rfModuleType === RF_SA818_UHF)) };
}

function inRange(mhz, min, max) {
  return Number.isFinite(mhz) && mhz >= min - 1e-4 && mhz <= max + 1e-4;
}

/** The float32 the firmware will store and echo. JS doubles do not compare equal to it. */
function f32(n) {
  const b = Buffer.alloc(4);
  b.writeFloatLE(Number(n) || 0, 0);
  return b.readFloatLE(0);
}

/**
 * RX is the dial. TX is the dial plus the repeater offset (kHz, signed:
 * minus is negative). Both must sit inside the module. TX is only *allowed*
 * inside the amateur segment; listening outside it (weather, the module's
 * extra range) still tunes, with transmit left off.
 */
function planTune({ rxMhz, offsetKhz, module }) {
  const rx = Number(rxMhz);
  const off = (Number(offsetKhz) || 0) / 1000;
  if (!module) return { ok: false, error: 'The radio has not reported its band yet' };
  if (!inRange(rx, module.minMhz, module.maxMhz)) {
    return { ok: false, error: `Receive ${rx.toFixed(4)} MHz is outside this ${module.label} module (${module.minMhz}–${module.maxMhz} MHz)` };
  }
  const tx = rx + off;
  if (!inRange(tx, module.minMhz, module.maxMhz)) {
    return { ok: false, error: `Transmit ${tx.toFixed(4)} MHz (offset ${offsetKhz || 0} kHz) is outside this ${module.label} module (${module.minMhz}–${module.maxMhz} MHz)` };
  }
  const txAllowed = inRange(tx, module.txMinMhz, module.txMaxMhz);
  return { ok: true, rxMhz: f32(rx), txMhz: f32(tx), txAllowed };
}

function isFmMode(mode) {
  const m = String(mode || '').toUpperCase();
  return m === '' || m === 'FM' || m === 'NFM';
}

/** Android RadioModuleController.isDeviceStateInSyncWithDesired, minus the retry policy. */
function desiredMatchesDevice(desired, device) {
  if (!desired || !device) return false;
  if (device.lastError) return false;
  if (device.appliedSequence !== desired.sequence) return false;
  if ((device.flags & DESIRED_FLAGS_MASK) !== (desired.flags & DESIRED_FLAGS_MASK)) return false;
  if ((desired.flags & HOST_STATE_RADIO_CONFIG_VALID) === 0) return true;
  return device.bw === desired.bw
    && device.memoryId === desired.memoryId
    && device.freqTx === desired.freqTx
    && device.freqRx === desired.freqRx
    && device.ctcssTx === desired.ctcssTx
    && device.squelch === desired.squelch
    && device.ctcssRx === desired.ctcssRx;
}

function radioStatusLabel(byte) {
  if (byte === RADIO_FOUND) return 'found';
  if (byte === RADIO_NOT_FOUND) return 'not found';
  return 'unknown';
}

function modeLabel(mode) {
  if (mode === MODE_TX) return 'TX';
  if (mode === MODE_RX) return 'RX';
  if (mode === MODE_STOPPED) return 'stopped';
  return 'unknown';
}

module.exports = {
  FEND, FESC, TFEND, TFESC, KISS_DATA, KISS_SETHARDWARE, PROTOCOL_VERSION,
  PROTO_MTU, VENDOR_HEADER_LEN, BAUD_RATE, AUDIO_SAMPLE_RATE, OPUS_FRAME_SAMPLES,
  CMD_HOST_TX_AUDIO, CMD_HOST_DESIRED_STATE, CMD_DEBUG_INFO, CMD_DEBUG_ERROR,
  CMD_DEBUG_WARN, CMD_DEBUG_DEBUG, CMD_DEBUG_TRACE, CMD_HELLO, CMD_RX_AUDIO,
  CMD_WINDOW_UPDATE, CMD_DEVICE_STATE,
  HOST_STATE_RADIO_CONFIG_VALID, HOST_STATE_PTT_REQUESTED, HOST_STATE_RX_AUDIO_OPEN,
  HOST_STATE_HIGH_POWER, HOST_STATE_RSSI_ENABLED, HOST_STATE_FILTER_PRE,
  HOST_STATE_FILTER_HIGH, HOST_STATE_FILTER_LOW, DEVICE_STATE_PHYS_PTT_DOWN,
  DEVICE_STATE_TX_ACTIVE, DEVICE_STATE_SQUELCHED, HOST_STATE_TX_ALLOWED,
  HOST_STATE_ENABLE_STATUS_REPORTS, DESIRED_FLAGS_MASK,
  BW_12K5, BW_25K, RF_SA818_VHF, RF_SA818_UHF, RADIO_FOUND, RADIO_NOT_FOUND,
  MODE_TX, MODE_RX, MODE_STOPPED, ERROR_NONE, ERROR_RADIO_CONFIG, ERROR_FILTERS,
  HOST_DESIRED_LEN, DEVICE_STATE_LEN, VERSION_LEN, HELLO_LEN,
  CTCSS_HZ, MODULES,
  kissEscape, encodeVendorFrame, encodeDesiredStateFrame, encodeTxAudioFrame,
  packHostDesiredState, unpackHostDesiredState, unpackDeviceState, unpackVersion,
  unpackHello, unpackWindowUpdate, createParser,
  ctcssIndex, ctcssLabel, bandwidthByte, moduleFromHello, planTune, isFmMode,
  desiredMatchesDevice, radioStatusLabel, modeLabel, inRange, f32,
  packDeviceState, packVersion, packHello, signedOffsetKhz, txTimeoutMs, openErrorHint,
};
