'use strict';

/**
 * kv4p HT over USB serial. Firmware v2.0.0.1 (KISS + HOST_DESIRED_STATE).
 *
 * The ESP32 sends HELLO once, after it boots, so every connect pulses RTS
 * (EN) with DTR held off (GPIO0 stays in run mode, not the ROM bootloader).
 * That is the same reset python-kv4p and the CP2102 auto-program circuit use.
 *
 * The radio is one band, FM, 1 W. Receive audio is Opus at 48 kHz; transmit
 * audio is the same. This client turns those packets into Float32 PCM and
 * accepts 24 kHz Float32 from POTACAT's existing mic path (the VFO window
 * and the phone bridge both send that).
 *
 * It keeps itself up: a dropped port is reopened, an ESP32 that goes quiet
 * (the firmware's own watchdog reboot leaves the USB device in place) is
 * reset on the same port, and a key-down is forced back to receive after
 * txTimeoutSec (default 3 minutes) even if the phone never sends key-up.
 */

const { EventEmitter } = require('events');
const P = require('./codecs/kv4p-codec');

const HELLO_TIMEOUT_MS = 35000;
const SILENCE_RESET_MS = 8000;     // device-state heartbeats are every 500 ms
const RETRY_MAX_MS = 15000;
const WINDOW_CAP_MULT = 4;
const TX_RATE = 24000;

const DEFAULT_FLAGS = P.HOST_STATE_HIGH_POWER | P.HOST_STATE_RSSI_ENABLED | P.HOST_STATE_ENABLE_STATUS_REPORTS;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function defaultOpenPort(path) {
  const { SerialPort } = require('serialport');
  return new SerialPort({
    path,
    baudRate: P.BAUD_RATE,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    hupcl: false,
    rtscts: false,
    dtr: false,
    rts: false,
    autoOpen: false,
  });
}

class Kv4pClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.kv4p = true;
    this.connected = false;
    this._openPort = opts.openPort || defaultOpenPort;
    this._sleep = opts.sleep || sleep;
    this._setTimer = opts.setTimer || setTimeout;
    this._clearTimer = opts.clearTimer || clearTimeout;
    this._now = opts.now || Date.now;
    this._opusFactory = opts.opusFactory || null;
    this._target = null;
    this._wantOpen = false;
    this._opening = false;
    this._port = null;
    this._parser = P.createParser();
    this._hello = null;
    this._module = null;
    this._device = null;
    this._desired = null;
    this._lastSent = null;
    this._retries = 0;
    this._window = 0;
    this._windowMax = 2048;
    this._retryMs = 1000;
    this._retryTimer = null;
    this._helloTimer = null;
    this._silenceTimer = null;
    this._txTimer = null;
    this._txTimeoutMs = P.txTimeoutMs(180);
    this._keyed = false;
    this._offsetKhz = 0;
    this._ctcss = 0;
    this._squelch = 1;
    this._bw = P.BW_25K;
    this._highPower = true;
    this._preEmphasis = false;
    this._rxHz = 0;
    this._closedPromise = Promise.resolve(true);
    this._resampler = null;
    this._txRemainder = new Float32Array(0);
    this._enc = null;
    this._dec = null;
    this._decodeErrors = 0;
    this._audioFrames = 0;
    this._generation = 0; // bumps on every close so a late hello can't apply
  }

  _log(msg) { this.emit('log', '[kv4p] ' + msg); }

  summary() {
    const h = this._hello;
    const d = this._device;
    return {
      firmware: h ? h.version.ver : 0,
      module: this._module ? this._module.label : '',
      moduleId: this._module ? this._module.id : '',
      minMhz: this._module ? this._module.minMhz : 0,
      maxMhz: this._module ? this._module.maxMhz : 0,
      radio: h ? P.radioStatusLabel(h.version.radioModuleStatus) : '',
      rxMhz: d ? d.freqRx : 0,
      txMhz: d ? d.freqTx : 0,
      squelch: d ? d.squelch : this._squelch,
      rssi: d ? d.latestRssi : 0,
      mode: d ? P.modeLabel(d.mode) : '',
      keyed: this._keyed,
    };
  }

  /** Repeater offset (signed kHz) and CTCSS for the next tune, and for a retune now. */
  setRepeater({ offsetKhz = 0, tone = '', name = '' } = {}) {
    if (/^d/i.test(String(tone || '').trim())) {
      this._log(`${name || 'Channel'} uses DCS (${tone}). The kv4p HT only does CTCSS, so the tone is left off.`);
      this._ctcss = 0;
    } else {
      this._ctcss = P.ctcssIndex(tone);
    }
    this._offsetKhz = Number(offsetKhz) || 0;
    if (name) this._log(`${name}: offset ${this._offsetKhz || 0} kHz, CTCSS ${P.ctcssLabel(this._ctcss)}`);
    return { offsetKhz: this._offsetKhz, ctcss: this._ctcss };
  }

  connect(target) {
    this._target = Object.assign({}, target || {});
    this._wantOpen = true;
    this._txTimeoutMs = P.txTimeoutMs(this._target.txTimeoutSec);
    this._offsetKhz = P.signedOffsetKhz(this._target);
    this._ctcss = P.ctcssIndex(this._target.ctcss);
    this._squelch = Math.max(0, Math.min(8, Number(this._target.squelch) || 0));
    this._bw = P.bandwidthByte(this._target.bandwidth);
    this._highPower = this._target.highPower !== false;
    this._preEmphasis = !!this._target.preEmphasis;
    this._retryMs = 1000;
    return this._open();
  }

  disconnect() {
    this._wantOpen = false;
    this._keyed = false;
    this._clearRetry();
    this._clearHelloTimer();
    this._clearSilence();
    this._clearTxTimer();
    const gen = ++this._generation;
    const port = this._port;
    this._port = null;
    this.connected = false;
    this._dropAudio();
    this._closedPromise = new Promise((resolve) => {
      if (!port) { resolve(true); return; }
      let done = false;
      const finish = () => { if (done) return; done = true; resolve(true); };
      try { port.close(() => finish()); } catch { finish(); }
      this._setTimer(finish, 3000);
    });
    this._generation = gen;
    return this._closedPromise;
  }

  tune(frequencyHz, mode) {
    if (!P.isFmMode(mode)) {
      this._log(`FM only — not tuning to ${mode}. This radio is a 1 W ${this._module ? this._module.label : 'single-band'} FM handheld.`);
      return false;
    }
    if (!this.connected || !this._module) {
      this._log('Not tuning: the radio is not connected yet');
      return false;
    }
    const plan = P.planTune({ rxMhz: frequencyHz / 1e6, offsetKhz: this._offsetKhz, module: this._module });
    if (!plan.ok) { this._log(plan.error); return false; }
    this._applyTune(plan);
    return true;
  }

  setMode(mode) {
    if (P.isFmMode(mode)) return true;
    this._log(`FM only — leaving the radio in FM (asked for ${mode})`);
    return false;
  }

  setTransmit(on) {
    if (!this.connected || !this._desired) {
      if (on) this._log('PTT ignored: the radio is not connected');
      return false;
    }
    if (on) {
      const tx = this._desired.freqTx;
      if (!this._module || !P.inRange(tx, this._module.txMinMhz, this._module.txMaxMhz)) {
        this._log(`PTT refused: transmit ${Number(tx).toFixed(4)} MHz is outside the amateur segment for this module (${this._module ? this._module.txMinMhz + '–' + this._module.txMaxMhz : '?'} MHz)`);
        return false;
      }
      if (this._keyed) return true;
      this._keyed = true;
      this._txRemainder = new Float32Array(0);
      this._resampler = null; // each key-down starts at a sample boundary
      this._dropEncoder(); // a fresh Opus stream each key-down, so a day of RX does not carry into TX
      this._armTxTimer();
      this._patchFlags(P.HOST_STATE_PTT_REQUESTED | P.HOST_STATE_TX_ALLOWED, 0);
      this._log(`TX (unkeys itself after ${Math.round(this._txTimeoutMs / 1000)} s if nothing releases PTT)`);
      return true;
    }
    if (!this._keyed && (this._desired.flags & P.HOST_STATE_PTT_REQUESTED) === 0) return true;
    this._keyed = false;
    this._clearTxTimer();
    this._txRemainder = new Float32Array(0);
    this._patchFlags(0, P.HOST_STATE_PTT_REQUESTED);
    this._log('RX');
    return true;
  }

  /**
   * Mic audio from the VFO window or the phone bridge: 24 kHz mono Float32.
   * Resampled to 48 kHz and sent as 40 ms Opus frames, matching the Android app.
   */
  pushTxPcm24k(samples) {
    if (!this._keyed || !this.connected || !samples || !samples.length) return;
    const res = this._resampler || (this._resampler = new (require('./mercury-audio-bridge').StreamingResampler)(TX_RATE, P.AUDIO_SAMPLE_RATE));
    const up = res.process(samples);
    if (!up.length && !this._txRemainder.length) return;
    const merged = new Float32Array(this._txRemainder.length + up.length);
    merged.set(this._txRemainder, 0);
    merged.set(up, this._txRemainder.length);
    let off = 0;
    while (merged.length - off >= P.OPUS_FRAME_SAMPLES) {
      this._sendOpusFrame(merged.subarray(off, off + P.OPUS_FRAME_SAMPLES));
      off += P.OPUS_FRAME_SAMPLES;
    }
    const rest = merged.length - off;
    // One frame of remainder at most. A bug that stopped consuming would
    // otherwise grow this without bound over a stuck key-down.
    this._txRemainder = rest > 0 ? merged.slice(off) : new Float32Array(0);
  }

  // ── open / reconnect ────────────────────────────────────────────────────

  async _open() {
    if (!this._wantOpen || this._opening) return;
    const path = this._target && this._target.path;
    if (!path) {
      this._log('No serial port set. On Linux that is /dev/ttyUSB0 or /dev/ttyACM0; on a Mac, /dev/cu.usbserial-…');
      this.emit('status', { connected: false, error: 'No serial port' });
      return;
    }
    this._opening = true;
    const gen = this._generation;
    this._clearRetry();
    try {
      await this._closePort();
      if (!this._wantOpen || gen !== this._generation) return;
      const port = this._openPort(path);
      this._port = port;
      await this._waitOpen(port);
      if (!this._wantOpen || this._port !== port) return;
      port.on('data', (chunk) => this._onData(chunk));
      port.on('error', (err) => this._onPortDown(err));
      port.on('close', () => this._onPortDown(null));
      this._parser.reset();
      await this._pulseReset(port);
      this._armHelloTimer();
      this._log(`Opened ${path} at ${P.BAUD_RATE} baud. Waiting for the radio to finish starting (the SA818 handshake can take about 20 seconds).`);
    } catch (err) {
      this._log('Open failed: ' + P.openErrorHint(err));
      this.emit('status', { connected: false, error: P.openErrorHint(err) });
      this._scheduleRetry();
    } finally {
      this._opening = false;
    }
  }

  _waitOpen(port) {
    if (port.isOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      port.open((err) => err ? reject(err) : resolve());
    });
  }

  _setSignals(port, signals) {
    return new Promise((resolve) => {
      try { port.set(signals, () => resolve()); }
      catch { resolve(); }
    });
  }

  /** DTR stays off (run mode). RTS pulses EN. Same sequence as kv4p's desktop clients. */
  async _pulseReset(port) {
    await this._setSignals(port, { dtr: false, rts: false });
    await this._setSignals(port, { dtr: false, rts: true });
    await this._sleep(100);
    await this._setSignals(port, { dtr: false, rts: false });
    await this._sleep(50);
    this._parser.reset();
  }

  _onPortDown(err) {
    if (!this._port) return;
    const was = this.connected;
    this.connected = false;
    this._keyed = false;
    this._clearTxTimer();
    this._clearHelloTimer();
    this._clearSilence();
    this._dropAudio();
    if (err) this._log('Serial error: ' + P.openErrorHint(err));
    if (was) {
      this._log('Link lost. POTACAT will open the port again when the radio is back.');
      this.emit('status', { connected: false, error: err ? P.openErrorHint(err) : 'port closed' });
    }
    const port = this._port;
    this._port = null;
    try { if (port && port.isOpen) port.close(() => {}); } catch { /* already gone */ }
    this._scheduleRetry();
  }

  _scheduleRetry() {
    if (!this._wantOpen || this._retryTimer) return;
    const wait = this._retryMs;
    this._retryMs = Math.min(RETRY_MAX_MS, this._retryMs * 2);
    this._retryTimer = this._setTimer(() => {
      this._retryTimer = null;
      if (!this._wantOpen) return;
      this._open();
    }, wait);
  }

  _clearRetry() {
    if (this._retryTimer) { this._clearTimer(this._retryTimer); this._retryTimer = null; }
  }

  async _closePort() {
    const port = this._port;
    this._port = null;
    if (!port) return;
    await new Promise((resolve) => {
      try { port.close(() => resolve()); }
      catch { resolve(); }
    });
  }

  _armHelloTimer() {
    this._clearHelloTimer();
    this._helloTimer = this._setTimer(() => {
      this._helloTimer = null;
      if (this.connected || !this._wantOpen) return;
      this._log('No HELLO in 35 seconds. The firmware sends it once at boot; POTACAT will reset the ESP32 and try again. Firmware older than v2.0.0.1 speaks a different protocol and will not answer.');
      this._onPortDown(new Error('no HELLO'));
    }, HELLO_TIMEOUT_MS);
  }

  _clearHelloTimer() {
    if (this._helloTimer) { this._clearTimer(this._helloTimer); this._helloTimer = null; }
  }

  _armSilence() {
    this._clearSilence();
    this._silenceTimer = this._setTimer(() => this._onSilence(), SILENCE_RESET_MS);
  }

  _clearSilence() {
    if (this._silenceTimer) { this._clearTimer(this._silenceTimer); this._silenceTimer = null; }
  }

  async _onSilence() {
    this._silenceTimer = null;
    if (!this.connected || !this._wantOpen || !this._port) return;
    // The firmware reports state every 500 ms while we have asked for it.
    // Eight seconds of nothing is a hung or rebooted ESP32 whose USB device
    // node is still there (the usual watchdog reset). Pulse EN; HELLO follows.
    this._log('No traffic for 8 seconds. Resetting the ESP32 on the same port.');
    this.connected = false;
    this._keyed = false;
    this._clearTxTimer();
    this._dropAudio();
    this.emit('status', { connected: false, error: 'resetting the ESP32' });
    try { await this._pulseReset(this._port); } catch { /* the port error handler retries */ }
    this._armHelloTimer();
  }

  _armTxTimer() {
    this._clearTxTimer();
    this._txTimer = this._setTimer(() => {
      this._txTimer = null;
      if (!this._keyed) return;
      const secs = Math.round(this._txTimeoutMs / 1000);
      this._log(`Transmit time-out (${secs} s). Forcing receive so a remote PTT cannot stay keyed.`);
      this.setTransmit(false);
      this.emit('tx-timeout', { seconds: secs });
    }, this._txTimeoutMs);
  }

  _clearTxTimer() {
    if (this._txTimer) { this._clearTimer(this._txTimer); this._txTimer = null; }
  }

  // ── bytes in ────────────────────────────────────────────────────────────

  _onData(chunk) {
    if (this.connected) this._armSilence();
    let frames;
    try { frames = this._parser.push(chunk); }
    catch (err) { this._log('Parser: ' + err.message); return; }
    for (const f of frames) this._onFrame(f);
  }

  _onFrame(frame) {
    if (frame.kind === 'ax25') return; // packet path is the radio's own KISS TNC; voice ignores it
    const cmd = frame.command;
    const p = frame.payload;
    if (cmd === P.CMD_HELLO) {
      const hello = P.unpackHello(p);
      if (!hello) { this._log('HELLO was the wrong size; this firmware is not v2.0.0.1.'); return; }
      this._onHello(hello);
      return;
    }
    if (cmd === P.CMD_DEVICE_STATE) {
      const st = P.unpackDeviceState(p);
      if (st) this._onDeviceState(st);
      return;
    }
    if (cmd === P.CMD_RX_AUDIO) {
      this._onRxAudio(p);
      return;
    }
    if (cmd === P.CMD_WINDOW_UPDATE) {
      const w = P.unpackWindowUpdate(p);
      if (w) this._window = Math.min(this._windowMax, this._window + w.size);
      return;
    }
    if (cmd === P.CMD_DEBUG_ERROR || cmd === P.CMD_DEBUG_WARN) {
      const text = p.toString('utf8').replace(/[^\x20-\x7e]/g, ' ').trim();
      if (text) this._log((cmd === P.CMD_DEBUG_ERROR ? 'firmware error: ' : 'firmware: ') + text.slice(0, 240));
    }
  }

  _onHello(hello) {
    const again = !!this._hello;
    this._clearHelloTimer();
    this._hello = hello;
    this._windowMax = Math.max(2048, (hello.version.windowSize || 2048) * WINDOW_CAP_MULT);
    this._window = hello.version.windowSize || 2048;
    this._module = P.moduleFromHello(hello.version, this._target && this._target.band);
    this._device = hello.deviceState;
    this._retryMs = 1000;
    if (hello.version.radioModuleStatus === P.RADIO_NOT_FOUND) {
      this._log(`Firmware ${hello.version.ver} answered, but it cannot find the SA818 module.`);
    }
    const where = this._module.reported ? 'reported by the firmware' : `not reported; using the ${this._module.label} setting`;
    this._log(`Firmware ${hello.version.ver}, ${this._module.label} module, receive ${this._module.minMhz}–${this._module.maxMhz} MHz (${where}). ${P.radioStatusLabel(hello.version.radioModuleStatus)}.`);
    this._seedDesired(hello.deviceState);
    this.connected = true;
    this._armSilence();
    this.emit('status', { connected: true });
    const rxHz = Math.round(hello.deviceState.freqRx * 1e6);
    if (rxHz > 0) {
      this._rxHz = rxHz;
      this.emit('frequency', rxHz);
    }
    this.emit('mode', 'FM');
    if (hello.deviceState.latestRssi) this.emit('smeter', hello.deviceState.latestRssi);
    if (again) this._log('The ESP32 restarted. The frequency, squelch and tone are restored. PTT is released.');
  }

  _seedDesired(device) {
    const flags = (DEFAULT_FLAGS
      | (this._highPower ? P.HOST_STATE_HIGH_POWER : 0)
      | (this._preEmphasis ? P.HOST_STATE_FILTER_PRE : 0)
      | P.HOST_STATE_RX_AUDIO_OPEN
      | P.HOST_STATE_ENABLE_STATUS_REPORTS)
      & ~P.HOST_STATE_PTT_REQUESTED;
    // Keep the radio's own frequency until something tunes. Apply our squelch,
    // tone and bandwidth on top, and the repeater offset against that RX.
    const rx = device && device.freqRx > 1 ? P.f32(device.freqRx) : 0;
    const plan = rx ? P.planTune({ rxMhz: rx, offsetKhz: this._offsetKhz, module: this._module }) : null;
    this._desired = {
      sequence: device ? device.appliedSequence : 0,
      memoryId: -1,
      flags: flags | P.HOST_STATE_RADIO_CONFIG_VALID | (plan && plan.txAllowed ? P.HOST_STATE_TX_ALLOWED : 0),
      bw: this._bw,
      freqTx: plan ? plan.txMhz : rx,
      freqRx: plan ? plan.rxMhz : rx,
      ctcssTx: this._ctcss,
      squelch: this._squelch,
      ctcssRx: this._ctcss,
    };
    this._lastSent = null;
    this._retries = 0;
    this._commit();
  }

  _applyTune(plan) {
    if (!this._desired) return;
    this._desired.freqRx = plan.rxMhz;
    this._desired.freqTx = plan.txMhz;
    this._desired.ctcssTx = this._ctcss;
    this._desired.ctcssRx = this._ctcss;
    this._desired.squelch = this._squelch;
    this._desired.bw = this._bw;
    this._desired.flags |= P.HOST_STATE_RADIO_CONFIG_VALID | P.HOST_STATE_RX_AUDIO_OPEN | P.HOST_STATE_ENABLE_STATUS_REPORTS;
    if (plan.txAllowed) this._desired.flags |= P.HOST_STATE_TX_ALLOWED;
    else this._desired.flags &= ~P.HOST_STATE_TX_ALLOWED;
    const txNote = plan.txAllowed ? `TX ${plan.txMhz.toFixed(4)} MHz` : `TX ${plan.txMhz.toFixed(4)} MHz is outside ${this._module.txMinMhz}–${this._module.txMaxMhz}, so PTT stays off`;
    this._log(`RX ${plan.rxMhz.toFixed(4)} MHz, ${txNote}, CTCSS ${P.ctcssLabel(this._ctcss)}, squelch ${this._squelch}`);
    this._commit();
    this._rxHz = Math.round(plan.rxMhz * 1e6);
    this.emit('frequency', this._rxHz);
    this.emit('mode', 'FM');
  }

  _patchFlags(add, remove) {
    this._desired.flags = (this._desired.flags | add) & ~remove;
    this._commit();
  }

  _commit() {
    this._desired.sequence = (this._desired.sequence + 1) >>> 0;
    this._lastSent = Object.assign({}, this._desired);
    this._retries = 0;
    this._writeVendor(P.CMD_HOST_DESIRED_STATE, P.packHostDesiredState(this._desired));
  }

  _onDeviceState(st) {
    this._device = st;
    if (this._lastSent && !P.desiredMatchesDevice(this._lastSent, st) && this._retries < 3 && this._sameDesired(this._lastSent, this._desired)) {
      this._retries++;
      this._writeVendor(P.CMD_HOST_DESIRED_STATE, P.packHostDesiredState(this._lastSent));
    } else if (P.desiredMatchesDevice(this._lastSent, st)) {
      this._retries = 0;
    }
    if (st.lastError === P.ERROR_RADIO_CONFIG) this._log('The SA818 rejected the frequency or tone.');
    const rxHz = Math.round(st.freqRx * 1e6);
    if (rxHz > 0 && rxHz !== this._rxHz) {
      this._rxHz = rxHz;
      this.emit('frequency', rxHz);
    }
    this.emit('smeter', st.latestRssi & 0xFF);
    const keyed = st.mode === P.MODE_TX;
    if (keyed !== this._radioTx && this._radioTx !== undefined) this.emit('ptt', keyed);
    this._radioTx = keyed;
  }

  _sameDesired(a, b) {
    return a && b && a.sequence === b.sequence && a.flags === b.flags && a.freqRx === b.freqRx && a.freqTx === b.freqTx;
  }

  _onRxAudio(packet) {
    if (!packet || !packet.length || this._keyed) return;
    const dec = this._decoder();
    if (!dec) return;
    let pcm;
    try { pcm = dec.decode(packet); }
    catch {
      this._decodeErrors++;
      if (this._decodeErrors === 1 || this._decodeErrors % 50 === 0) this._log('Opus decode failed (' + this._decodeErrors + '). RX audio keeps going; the decoder is reset after a run of errors.');
      if (this._decodeErrors % 20 === 0) this._dec = null;
      return;
    }
    this._decodeErrors = 0;
    if (!pcm || pcm.length < 2) return;
    const n = pcm.length >> 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
    this._audioFrames++;
    this.emit('audio', out, P.AUDIO_SAMPLE_RATE);
  }

  _decoder() {
    if (this._dec) return this._dec;
    const Ctor = this._opusCtor();
    if (!Ctor) return null;
    try { this._dec = new Ctor(P.AUDIO_SAMPLE_RATE, 1); }
    catch (err) { this._log('Opus decoder: ' + err.message); return null; }
    return this._dec;
  }

  _encoder() {
    if (this._enc) return this._enc;
    const Ctor = this._opusCtor();
    if (!Ctor) return null;
    try {
      this._enc = new Ctor(P.AUDIO_SAMPLE_RATE, 1);
      // Android encodes VOIP, narrowband, VBR. The CTL numbers are opus_defines.h.
      const ctl = (id, val) => { try { this._enc.applyEncoderCTL(id, val); } catch { /* older builds omit it */ } };
      ctl(4000, 2048); // OPUS_SET_APPLICATION, VOIP
      ctl(4006, 1);    // OPUS_SET_VBR
      ctl(4004, 1101); // OPUS_SET_MAX_BANDWIDTH, NARROWBAND
    } catch (err) { this._log('Opus encoder: ' + err.message); return null; }
    return this._enc;
  }

  _opusCtor() {
    if (this._opusFactory) return this._opusFactory;
    try { return require('@discordjs/opus').OpusEncoder; }
    catch (err) {
      this._log('Opus is not available (' + err.message + '), so there is no audio. `npm install` builds it.');
      this._opusFactory = null;
      return null;
    }
  }

  _dropEncoder() { this._enc = null; }

  _dropAudio() {
    this._enc = null;
    this._dec = null;
    this._resampler = null;
    this._txRemainder = new Float32Array(0);
    this._decodeErrors = 0;
  }

  _sendOpusFrame(f32) {
    const enc = this._encoder();
    if (!enc) return;
    const pcm = Buffer.allocUnsafe(f32.length * 2);
    for (let i = 0; i < f32.length; i++) {
      let s = f32[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      pcm.writeInt16LE((s * 32767) | 0, i * 2);
    }
    let opus;
    try { opus = enc.encode(pcm); }
    catch (err) { this._log('Opus encode: ' + err.message); return; }
    if (opus && opus.length) this._writeVendor(P.CMD_HOST_TX_AUDIO, opus);
  }

  _writeVendor(command, payload) {
    if (!this._port || !this._port.isOpen) return;
    const frame = P.encodeVendorFrame(command, payload);
    // Flow control is optional in the firmware notes. Audio yields when the
    // window is empty so a stuck ESP32 cannot queue without limit. A tune or
    // a key-up always goes out: those frames are 40 bytes and the radio
    // cannot change state without them.
    const control = command !== P.CMD_HOST_TX_AUDIO;
    if (!control && this._window < frame.length) return;
    this._window = Math.max(0, this._window - frame.length);
    try { this._port.write(frame); }
    catch (err) { this._log('Write failed: ' + err.message); }
  }
}

/**
 * Open, wait for HELLO, optionally tune RX, optionally count audio frames.
 * Never transmits unless opts.tx is true (and then only for opts.txMs).
 */
function probe(opts = {}) {
  const timeoutMs = opts.helloTimeoutMs || HELLO_TIMEOUT_MS;
  const client = opts.client || new Kv4pClient(opts);
  const logs = [];
  client.on('log', (m) => logs.push(m));
  return new Promise((resolve) => {
    let settled = false;
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      try { await client.disconnect(); } catch { /* already closed */ }
      resolve(Object.assign({ logs }, result));
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'No HELLO. Check the port, the cable, and that the firmware is v2.0.0.1 or newer.' }), timeoutMs + 2000);
    client.on('status', async (s) => {
      if (!s.connected) return;
      const info = client.summary();
      try {
        if (opts.freqMhz) {
          const ok = client.tune(opts.freqMhz * 1e6, 'FM');
          if (!ok) { clearTimeout(timer); finish({ ok: false, error: 'Tune was refused. See the log.', info }); return; }
        }
        let audioFrames = 0;
        const onAudio = () => { audioFrames++; };
        client.on('audio', onAudio);
        if (opts.tx) {
          client.setTransmit(true);
          await sleep(Math.max(0, opts.txMs || 0));
          client.setTransmit(false);
        }
        if (opts.listenSec > 0) await sleep(opts.listenSec * 1000);
        client.removeListener('audio', onAudio);
        clearTimeout(timer);
        finish({ ok: true, info, audioFrames, tuned: !!opts.freqMhz, transmitted: !!opts.tx });
      } catch (err) {
        clearTimeout(timer);
        finish({ ok: false, error: err.message, info });
      }
    });
    client.connect(Object.assign({}, opts.target || {}, { path: opts.port, txTimeoutSec: opts.txTimeoutSec }));
  });
}

module.exports = { Kv4pClient, probe, HELLO_TIMEOUT_MS, SILENCE_RESET_MS };
