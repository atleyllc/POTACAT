// Directory > Channels: RepeaterBook search, the Nearby bank, and scan.
// The desktop asks main (lib/repeater-service.js). Nothing in this file transmits.
(function () {
  'use strict';
  const el = (id) => document.getElementById(id);
  let api = null;
  let snap = null;
  let results = [];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function mhz(khz) { return (Number(khz) / 1000).toFixed(4); }
  function offsetText(k) {
    k = Number(k) || 0;
    if (!k) return 'simplex';
    const sign = k > 0 ? '+' : '−';
    const a = Math.abs(k);
    return a >= 1000 ? sign + (a / 1000) + ' MHz' : sign + a + ' kHz';
  }

  function fillStates(states, selected) {
    const sel = el('rb-state');
    if (!sel || sel.options.length > 1) return;
    const opts = ['<option value="">From location</option>'].concat((states || []).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`));
    sel.innerHTML = opts.join('');
    if (selected) sel.value = selected;
  }

  function paint(s) {
    snap = s || snap;
    if (!snap) return;
    const place = el('rb-place');
    if (place) place.textContent = snap.place ? ('Location: ' + snap.place.text) : 'Location: none yet';
    const ua = el('rb-ua');
    if (ua && snap.userAgent) ua.textContent = snap.userAgent;
    fillStates(snap.states, snap.stateId);
    const scan = el('rb-scan');
    if (scan) scan.textContent = snap.scanning ? 'Stop scan' : 'Scan';
    const load = el('rb-load');
    if (load && snap.count) load.textContent = 'Load nearest ' + snap.count;
    const cur = snap.current;
    if (cur && place && snap.channels && snap.channels.length) {
      const n = (snap.index || 0) + 1;
      place.textContent = (snap.place ? snap.place.text + ' · ' : '') + n + '/' + snap.channels.length + ' ' + cur.name + '  ' + mhz(cur.khz) + '  ' + offsetText(cur.offsetKhz) + (cur.tone ? '  CTCSS ' + cur.tone : '') + (snap.scanning ? '  · scanning' : '');
    }
  }

  function row(c, extra) {
    const div = document.createElement('div');
    div.className = 'rb-item';
    div.innerHTML = '<span class="rb-name"></span><span class="rb-freq"></span><span class="rb-meta"></span>' + (c.warning ? '<span class="rb-warn"></span>' : '') + '<span class="rb-tools"></span>';
    div.querySelector('.rb-name').textContent = c.name || '';
    div.querySelector('.rb-freq').textContent = mhz(c.khz) + '  ' + offsetText(c.offsetKhz) + (c.tone ? '  T' + c.tone : '  no tone');
    div.querySelector('.rb-meta').textContent = c.note || '';
    if (c.warning) div.querySelector('.rb-warn').textContent = c.warning;
    const tools = div.querySelector('.rb-tools');
    const tune = document.createElement('button');
    tune.type = 'button'; tune.className = 'chn-btn chn-btn-tint'; tune.textContent = 'Tune';
    tune.addEventListener('click', () => api.repeaterbookCommand({ op: 'tune', channel: c }));
    const save = document.createElement('button');
    save.type = 'button'; save.className = 'chn-btn'; save.textContent = 'Save';
    save.addEventListener('click', () => api.repeaterbookCommand({ op: 'save', channel: c }));
    tools.appendChild(tune);
    tools.appendChild(save);
    if (extra) tools.appendChild(extra);
    return div;
  }

  function paintResults(list) {
    results = list || [];
    const box = el('rb-list');
    if (!box) return;
    box.innerHTML = '';
    if (!results.length) return;
    results.forEach((c) => box.appendChild(row(c)));
  }

  async function askOs() {
    if (!navigator.geolocation || !api || !api.repeaterbookOs) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2500);
      navigator.geolocation.getCurrentPosition((pos) => {
        clearTimeout(timer);
        api.repeaterbookOs({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracyM: pos.coords.accuracy }).then(paint).catch(() => {});
        resolve();
      }, () => { clearTimeout(timer); resolve(); }, { enableHighAccuracy: false, maximumAge: 600000, timeout: 2000 });
    });
  }

  function queryBits() {
    return {
      stateId: (el('rb-state') || {}).value || '',
      county: (el('rb-county') || {}).value || '',
      radiusMiles: Number((el('rb-radius') || {}).value) || 0,
      count: Number((el('rb-count') || {}).value) || 10,
      dwellSec: Number((el('rb-dwell') || {}).value) || 5,
      resumeSec: Number((el('rb-resume') || {}).value) || 4,
    };
  }

  function init(opts) {
    api = opts && opts.api;
    if (!api || !api.repeaterbookCommand) return;
    const on = (id, fn) => { const b = el(id); if (b) b.addEventListener('click', fn); };
    on('rb-load', async () => {
      await askOs();
      const r = await api.repeaterbookCommand(Object.assign({ op: 'load' }, queryBits()));
      paint(r);
      if (r && r.error && el('rb-place')) el('rb-place').textContent = r.error;
    });
    on('rb-search', async () => {
      await askOs();
      const r = await api.repeaterbookCommand(Object.assign({ op: 'search' }, queryBits()));
      paint(r);
      paintResults(r && r.results);
      if (r && r.error) {
        const box = el('rb-list');
        if (box) box.textContent = r.error;
      }
    });
    on('rb-next', () => api.repeaterbookCommand({ op: 'next' }).then(paint));
    on('rb-prev', () => api.repeaterbookCommand({ op: 'prev' }).then(paint));
    on('rb-scan', () => {
      const start = !(snap && snap.scanning);
      api.repeaterbookCommand(Object.assign({ op: start ? 'scan-start' : 'scan-stop' }, queryBits())).then(paint);
    });
    on('rb-manual', () => {
      api.repeaterbookCommand({ op: 'manual', lat: (el('rb-lat') || {}).value, lon: (el('rb-lon') || {}).value }).then(paint);
    });
    on('rb-manual-clear', () => api.repeaterbookCommand({ op: 'manual', lat: '', lon: '' }).then(paint));
    on('rb-token-save', () => {
      const token = (el('rb-token') || {}).value || '';
      api.repeaterbookCommand({ op: 'token', token }).then((r) => {
        paint(r);
        if (el('rb-token')) el('rb-token').value = '';
        if (r && r.error && el('rb-place')) el('rb-place').textContent = r.error;
      });
    });
    if (api.onRepeaterBank) api.onRepeaterBank(paint);
    api.repeaterbookStatus().then(paint).catch(() => {});
  }

  window.RepeaterBookView = { init };
})();
