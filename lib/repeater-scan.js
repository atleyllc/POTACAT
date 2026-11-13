'use strict';

// Receive-only scan of a repeater bank. The machine decides which channel
// to tune and when. It has no transmit action: a PTT event stops the scan
// and tunes nothing.
//
// Phases: idle, dwell (listening for dwellMs), hold (squelch is open),
// resume (squelch closed, wait resumeMs, then the next channel).

const KV4P_SQUELCHED = 1 << 10;

function clone(state) {
  return {
    running: !!state.running,
    phase: state.phase || 'idle',
    index: state.index | 0,
    since: state.since || 0,
    dwellMs: state.dwellMs || 5000,
    resumeMs: state.resumeMs || 4000,
    channels: state.channels || [],
    lockouts: Object.assign({}, state.lockouts || {}),
    signal: !!state.signal,
  };
}

function createState(channels, opts) {
  const o = opts || {};
  return {
    running: false,
    phase: 'idle',
    index: 0,
    since: 0,
    dwellMs: clampMs(o.dwellMs, 2000, 30000, 5000),
    resumeMs: clampMs(o.resumeMs, 0, 30000, 4000),
    channels: Array.isArray(channels) ? channels : [],
    lockouts: Object.assign({}, o.lockouts || {}),
    signal: false,
  };
}

function clampMs(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function nextOpen(state, from, dir) {
  const n = state.channels.length;
  if (!n) return -1;
  const step = dir < 0 ? -1 : 1;
  for (let i = 1; i <= n; i++) {
    const idx = ((from + step * i) % n + n) % n;
    const ch = state.channels[idx];
    if (ch && !state.lockouts[ch.id]) return idx;
  }
  return -1;
}

function reduce(state, ev) {
  const s = clone(state || createState());
  const e = ev || {};
  const now = Number(e.now) || 0;
  if (e.type === 'set-channels') {
    s.channels = Array.isArray(e.channels) ? e.channels : [];
    if (s.index >= s.channels.length) s.index = 0;
    return { state: s, tune: null };
  }
  if (e.type === 'lock') {
    if (e.on) s.lockouts[e.id] = true;
    else delete s.lockouts[e.id];
    return { state: s, tune: null };
  }
  if (e.type === 'ptt' || e.type === 'stop') {
    s.running = false;
    s.phase = 'idle';
    s.signal = false;
    return { state: s, tune: null, stopped: true, reason: e.type === 'ptt' ? 'ptt' : (e.why || 'stop') };
  }
  if (e.type === 'start' || e.type === 'next' || e.type === 'prev' || e.type === 'go' || e.type === 'skip') {
    let idx;
    if (e.type === 'go') {
      idx = s.channels.findIndex((c) => c && c.id === e.id);
      if (idx < 0) return { state: s, tune: null, error: 'That repeater is not in the nearby bank' };
    } else if (e.type === 'start') {
      idx = e.index != null ? (e.index | 0) : s.index;
      if (!s.channels[idx] || s.lockouts[s.channels[idx].id]) idx = nextOpen(s, idx, 1);
    } else {
      idx = nextOpen(s, s.index, e.type === 'prev' ? -1 : 1);
    }
    if (idx == null || idx < 0 || !s.channels[idx]) {
      return { state: s, tune: null, error: 'Every nearby channel is locked out' };
    }
    const keepRunning = e.type === 'start' || e.type === 'skip' || (s.running && e.type !== 'go');
    s.running = e.type === 'start' || e.type === 'skip' ? true : (e.type === 'go' ? false : keepRunning);
    if (e.type === 'next' || e.type === 'prev') s.running = !!state.running;
    s.phase = s.running ? 'dwell' : 'idle';
    s.index = idx;
    s.since = now;
    s.signal = false;
    return { state: s, tune: s.channels[idx] };
  }
  if (e.type === 'signal') {
    if (!s.running) return { state: s, tune: null };
    if (e.active) {
      s.signal = true;
      s.phase = 'hold';
      s.since = now;
      return { state: s, tune: null };
    }
    if (s.phase === 'hold') {
      s.signal = false;
      s.phase = 'resume';
      s.since = now;
    }
    return { state: s, tune: null };
  }
  if (e.type === 'tick') {
    if (!s.running) return { state: s, tune: null };
    if (s.phase === 'hold') return { state: s, tune: null };
    const wait = s.phase === 'resume' ? s.resumeMs : s.dwellMs;
    if (now - s.since < wait) return { state: s, tune: null };
    const idx = nextOpen(s, s.index, 1);
    if (idx < 0) {
      s.running = false;
      s.phase = 'idle';
      return { state: s, tune: null, stopped: true, reason: 'end' };
    }
    s.index = idx;
    s.phase = 'dwell';
    s.since = now;
    s.signal = false;
    return { state: s, tune: s.channels[idx] };
  }
  return { state: s, tune: null };
}

/**
 * kv4p device-state → whether a carrier is present. Squelch 0 is monitor:
 * the firmware sends audio all the time, so it cannot tell a signal from
 * silence. The scan still dwells, and the UI says to raise the squelch.
 */
function signalFromKv4p(ev) {
  if (!ev) return { active: false, reliable: false, reason: 'The radio has not reported squelch yet.' };
  const squelch = Number(ev.squelch);
  if (!Number.isFinite(squelch) || squelch <= 0) {
    return { active: false, reliable: false, reason: 'Squelch is 0 (monitor). Set it to 1 or higher so scan can stop on a signal.' };
  }
  const open = ev.open != null ? !!ev.open : ((Number(ev.flags) & KV4P_SQUELCHED) === 0);
  return { active: open, reliable: true, reason: '' };
}

module.exports = { createState, reduce, signalFromKv4p, KV4P_SQUELCHED };
