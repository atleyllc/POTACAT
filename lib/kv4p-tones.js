/**
 * DRA818 / SA818 CTCSS indexes. Index 0 is no tone.
 * Same order as ToneHelper.java in kv4p HT v2.0.0.1.
 * Dual-mode: Node require, and a script tag for the rig editor.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Kv4pTones = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var CTCSS_HZ = [
    0,
    67, 71.9, 74.4, 77, 79.7, 82.5, 85.4, 88.5,
    91.5, 94.8, 97.4, 100, 103.5, 107.2, 110.9, 114.8,
    118.8, 123, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4,
    156.7, 162.2, 167.9, 173.8, 179.9, 186.2, 192.8, 203.5,
    210.7, 218.1, 225.7, 233.6, 241.8, 250.3,
  ];
  function label(index) {
    var i = Number(index) || 0;
    if (!i || i >= CTCSS_HZ.length) return 'None';
    var hz = CTCSS_HZ[i];
    return hz === Math.round(hz) ? String(hz) : String(hz);
  }
  return { CTCSS_HZ: CTCSS_HZ, label: label };
});
