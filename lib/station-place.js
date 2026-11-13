'use strict';

// Where "nearby" is measured from. The first one that is present and fresh
// wins, except a manual override, which always wins:
//   manual > phone GPS > this computer's location > IP geolocation > grid
//
// IP geolocation is city-level (tens of kilometres). The grid is the
// Maidenhead square in Settings. Nothing here contacts a network.

const { gridToLatLon } = require('./grid');

const PHONE_MAX_AGE_MS = 3 * 60 * 1000;
const OS_MAX_AGE_MS = 10 * 60 * 1000;
const IP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const IP_ACCURACY_M = 25000;

function finite(n) { return typeof n === 'number' && Number.isFinite(n); }

function validFix(fix) {
  if (!fix || typeof fix !== 'object') return null;
  const lat = Number(fix.lat);
  const lon = Number(fix.lon);
  if (!finite(lat) || !finite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return fix;
}

function fresh(fix, now, maxAge) {
  const f = validFix(fix);
  if (!f) return null;
  if (maxAge && f.at && now - Number(f.at) > maxAge) return null;
  return f;
}

/** Rough size of the Maidenhead square, so the UI can say how coarse it is. */
function gridAccuracyM(grid) {
  const n = String(grid || '').trim().length;
  if (n >= 6) return 8000;
  if (n >= 4) return 80000;
  return 0;
}

function accuracyText(m) {
  if (!(m > 0)) return '';
  if (m < 1000) return '±' + Math.round(m) + ' m';
  const km = m / 1000;
  return '±' + (km >= 10 ? Math.round(km) : km.toFixed(0)) + ' km';
}

/**
 * @param {object} input manual, phone, os, ip, grid, now
 * Each fix is { lat, lon, accuracyM, at, region, city }.
 */
function choosePlace(input) {
  const o = input || {};
  const now = Number(o.now) || Date.now();
  const manual = validFix(o.manual);
  if (manual) {
    return {
      source: 'manual', label: 'Manual override', lat: Number(manual.lat), lon: Number(manual.lon),
      accuracyM: null, at: now, region: manual.region || '', city: manual.city || '',
    };
  }
  const phone = fresh(o.phone, now, o.phoneMaxAgeMs || PHONE_MAX_AGE_MS);
  if (phone) {
    return {
      source: 'phone', label: 'Phone GPS', lat: Number(phone.lat), lon: Number(phone.lon),
      accuracyM: Number(phone.accuracyM) > 0 ? Number(phone.accuracyM) : 50,
      at: Number(phone.at) || now, region: phone.region || '', city: phone.city || '',
    };
  }
  const os = fresh(o.os, now, o.osMaxAgeMs || OS_MAX_AGE_MS);
  if (os) {
    return {
      source: 'os', label: 'This computer', lat: Number(os.lat), lon: Number(os.lon),
      accuracyM: Number(os.accuracyM) > 0 ? Number(os.accuracyM) : 100,
      at: Number(os.at) || now, region: os.region || '', city: os.city || '',
    };
  }
  const ip = fresh(o.ip, now, o.ipMaxAgeMs || IP_MAX_AGE_MS);
  if (ip) {
    return {
      source: 'ip', label: 'IP address, city-level', lat: Number(ip.lat), lon: Number(ip.lon),
      accuracyM: Number(ip.accuracyM) > 0 ? Number(ip.accuracyM) : IP_ACCURACY_M,
      at: Number(ip.at) || now, region: ip.region || '', city: ip.city || '',
    };
  }
  const grid = String(o.grid || '').trim();
  const g = grid ? gridToLatLon(grid) : null;
  if (g) {
    return {
      source: 'grid', label: 'Grid ' + grid.toUpperCase(), lat: g.lat, lon: g.lon,
      accuracyM: gridAccuracyM(grid), at: now, region: '', city: '',
    };
  }
  return null;
}

function describePlace(place) {
  if (!place) return 'No location yet. Set the grid in Settings, or enter a latitude and longitude.';
  const acc = accuracyText(place.accuracyM);
  const where = [place.city, place.region].filter(Boolean).join(', ');
  return place.label + (where ? ' (' + where + ')' : '') + (acc ? ', ' + acc : '');
}

/**
 * ipwho.is JSON. City-level. `success: false` and a missing latitude are
 * not a fix. A second provider can be added beside this without changing
 * the caller: pass its parse function into the service.
 */
function parseIpwho(body) {
  let j;
  try { j = typeof body === 'string' ? JSON.parse(body) : body; } catch { return null; }
  if (!j || j.success === false) return null;
  const lat = Number(j.latitude);
  const lon = Number(j.longitude);
  if (!finite(lat) || !finite(lon)) return null;
  return {
    lat, lon, accuracyM: IP_ACCURACY_M,
    city: String(j.city || ''), region: String(j.region || ''), country: String(j.country || ''),
  };
}

module.exports = {
  PHONE_MAX_AGE_MS, OS_MAX_AGE_MS, IP_MAX_AGE_MS, IP_ACCURACY_M,
  gridAccuracyM, accuracyText, choosePlace, describePlace, parseIpwho,
};
