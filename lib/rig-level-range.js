'use strict';
/**
 * Hamlib level ranges from a rigctld dump_caps, and the watts ↔ RFPOWER
 * fraction used by radios whose power is a fraction of full scale (Xiegu
 * X6100: 0.05..1 of 10 W).
 *
 * A range whose max is not above its min is UNSPECIFIED, not unsupported.
 * Hamlib 3087 prints RFPOWER(0.000000..0.000000/0.000000) — and the same
 * for SWR and ALC — while L RFPOWER and l SWR work on the radio. That
 * placeholder must not override a range the model declares. A rig with no
 * declaration (QDX, Hamlib 2052) still treats 0..0 as "not available"
 * until a live read says otherwise. This module only does maths.
 */

/** NAME(min..max) anywhere in a dump, plus "Min:"/"Max:" under a level name. */
function parseLevelRanges(text) {
  const ranges = {};
  const src = String(text || '');
  const inline = /\b([A-Z][A-Z0-9_]*)\(\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = inline.exec(src))) {
    ranges[m[1]] = { min: Number(m[2]), max: Number(m[3]) };
  }
  let current = null;
  for (const raw of src.split(/\r?\n/)) {
    const named = raw.match(/^\s*(?:Level:\s*)?([A-Z][A-Z0-9_]*)\s*:?\s*$/);
    if (named) { current = named[1]; continue; }
    if (!current) continue;
    const min = raw.match(/^\s*Min:\s*(-?\d+(?:\.\d+)?)/i);
    const max = raw.match(/^\s*Max:\s*(-?\d+(?:\.\d+)?)/i);
    if (min || max) {
      const prev = ranges[current] || { min: 0, max: 0 };
      ranges[current] = {
        min: min ? Number(min[1]) : prev.min,
        max: max ? Number(max[1]) : prev.max,
      };
    }
  }
  return ranges;
}

/** usable = max is above min. 0..0 is unspecified, not a real empty scale. */
function levelUsable(range) {
  return !!(range && range.max > range.min);
}

/** 'unknown' (not in the dump), 'usable', or 'unspecified' (0..0). */
function rangeState(range) {
  if (!range) return 'unknown';
  return levelUsable(range) ? 'usable' : 'unspecified';
}

const METER_LEVELS = {
  smeter: 'STRENGTH', swr: 'SWR', alc: 'ALC', fwdPower: 'RFPOWER_METER', rfpower: 'RFPOWER',
};

/**
 * Which meters to show.
 * true  = the model declares it, or the dump gave a real range.
 * false = the dump said 0..0 and the model did not declare it (hide / grey).
 * null  = the dump never named it.
 * A model declaration wins over 0..0. declared keys: smeter, swr, alc,
 * fwdPower, rfpower.
 */
function meterSupport(ranges, declared) {
  const r = ranges || {};
  const d = declared || {};
  const out = {};
  for (const [key, name] of Object.entries(METER_LEVELS)) {
    if (d[key] === true) { out[key] = true; continue; }
    if (!Object.prototype.hasOwnProperty.call(r, name)) { out[key] = null; continue; }
    out[key] = levelUsable(r[name]);
  }
  return out;
}

/** Watts → Hamlib RFPOWER fraction, clamped to the radio's range. */
function wattsToRfpower(watts, fullW, range) {
  const full = Number(fullW);
  const w = Math.max(0, Number(watts) || 0);
  if (!(full > 0)) return 0;
  let fraction = w / full;
  if (range && range.max > range.min) {
    fraction = Math.max(range.min, Math.min(range.max, fraction));
  } else {
    fraction = Math.max(0, Math.min(1, fraction));
  }
  return Math.round(fraction * 1000) / 1000;
}

/** Fraction from `l RFPOWER` back to watts on the same full-scale. */
function rfpowerToWatts(fraction, fullW) {
  const full = Number(fullW);
  if (!(full > 0)) return 0;
  const f = Math.max(0, Number(fraction) || 0);
  return Math.round(f * full * 10) / 10;
}

/**
 * Watts to set when a rig connects, or null when the option is unset.
 * defaultPowerPct is a percent of full power. powerOnConnect: false turns
 * it off even if a percent was saved. Never a transmit.
 */
function connectPowerWatts(rig, fullW) {
  if (!rig || rig.powerOnConnect === false) return null;
  const pct = Number(rig.defaultPowerPct);
  if (!Number.isFinite(pct)) return null;
  const full = Number(fullW);
  if (!(full > 0)) return null;
  const clamped = Math.max(0, Math.min(100, pct));
  return Math.round(clamped / 100 * full * 10) / 10;
}

module.exports = {
  parseLevelRanges, levelUsable, rangeState, meterSupport,
  wattsToRfpower, rfpowerToWatts, connectPowerWatts,
};
