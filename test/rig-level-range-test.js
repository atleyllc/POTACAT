#!/usr/bin/env node
'use strict';
// X6100 (Hamlib 3087) TX power is L RFPOWER on a 0.05..1 scale of 10 W,
// read back with l RFPOWER. A backend whose range is 0..0 (QDX SWR and
// RFPOWER) cannot set or report that level. Setting power never keys PTT.
// Run: node test/rig-level-range-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RigctldCodec } = require('../lib/codecs/rigctld-codec');
const { RIG_MODELS } = require('../lib/rig-models');
const {
  parseLevelRanges, rangeState, meterSupport, wattsToRfpower, rfpowerToWatts, connectPowerWatts,
} = require('../lib/rig-level-range');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e)); }
}

const X6100_DUMP = [
  'Get level: STRENGTH(-54..60/1) SWR(1..10/0.1) ALC(0..1/0.01) RFPOWER_METER(0..1/0)',
  'Set level: RFPOWER(0.05..1/0.01)',
].join('\n');
// What `rigctl -m 3087 -u` actually prints. The commands still work.
const X6100_REAL_CAPS = [
  'Level list:',
  '\tRFPOWER(0.000000..0.000000/0.000000)',
  '\tSWR(0.000000..0.000000/0.000000)',
  '\tALC(0.000000..0.000000/0.000000)',
  '\tRFPOWER_METER(0.000000..0.000000/0.000000)',
  '\tSTRENGTH(-54.000000..60.000000/1.000000)',
].join('\n');
const QDX_DUMP = 'Get level: STRENGTH(-54..20/1) SWR(0..0/0) ALC(0..0/0) RFPOWER_METER(0..0/0)\nSet level: RFPOWER(0..0/0)';

test('dump_caps ranges: X6100 RFPOWER is 0.05..1, QDX SWR and RFPOWER are dead', () => {
  const x = parseLevelRanges(X6100_DUMP);
  assert.deepStrictEqual(x.RFPOWER, { min: 0.05, max: 1 });
  assert.deepStrictEqual(x.SWR, { min: 1, max: 10 });
  const q = parseLevelRanges(QDX_DUMP);
  assert.strictEqual(meterSupport(x).swr, true);
  assert.strictEqual(meterSupport(x).rfpower, true);
  assert.strictEqual(meterSupport(q).swr, false);
  assert.strictEqual(meterSupport(q).alc, false);
  assert.strictEqual(meterSupport(q).fwdPower, false);
  assert.strictEqual(meterSupport(q).rfpower, false);
  assert.strictEqual(meterSupport(q).smeter, true);
  assert.strictEqual(meterSupport({}).swr, null);
  assert.strictEqual(rangeState(parseLevelRanges(X6100_REAL_CAPS).RFPOWER), 'unspecified');
  assert.strictEqual(rangeState(parseLevelRanges(X6100_REAL_CAPS).SWR), 'unspecified');
  // A model declaration wins over Hamlib's 0..0 placeholder.
  const declared = meterSupport(parseLevelRanges(X6100_REAL_CAPS), RIG_MODELS.X6100.meters);
  assert.strictEqual(declared.rfpower, true);
  assert.strictEqual(declared.swr, true);
  assert.strictEqual(declared.alc, true);
  assert.strictEqual(declared.fwdPower, true);
});

test('Min/Max blocks parse, and 5 W of 10 W is RFPOWER 0.500 clamped to 0.05', () => {
  const r = parseLevelRanges('Level: RFPOWER\nMin: 0.05\nMax: 1\n');
  assert.deepStrictEqual(r.RFPOWER, { min: 0.05, max: 1 });
  assert.strictEqual(wattsToRfpower(5, 10, r.RFPOWER), 0.5);
  assert.strictEqual(wattsToRfpower(0.1, 10, r.RFPOWER), 0.05);
  assert.strictEqual(wattsToRfpower(50, 10, r.RFPOWER), 1);
  assert.strictEqual(rfpowerToWatts(0.5, 10), 5);
});

test('connect power is unset until a percent is saved', () => {
  assert.strictEqual(connectPowerWatts({}, 10), null);
  assert.strictEqual(connectPowerWatts({ powerOnConnect: true }, 10), null);
  assert.strictEqual(connectPowerWatts({ defaultPowerPct: 40, powerOnConnect: false }, 10), null);
  assert.strictEqual(connectPowerWatts({ defaultPowerPct: 40 }, 10), 4);
  assert.strictEqual(connectPowerWatts({ defaultPowerPct: 40, powerOnConnect: true }, 10), 4);
});

function codec(model, opts) {
  const writes = [];
  const c = new RigctldCodec(model || { maxPower: 100, brand: 'Hamlib', protocol: 'rigctld' }, (d) => writes.push(String(d)), opts);
  return { c, writes, feed: (s) => c.onData(Buffer.from(s)) };
}

test('X6100 model is Hamlib 3087, 10 W, RFPOWER 0.05..1, and 5 W is L RFPOWER 0.500', () => {
  const m = RIG_MODELS.X6100;
  assert.strictEqual(m.protocol, 'rigctld');
  assert.strictEqual(m.hamlib.rigId, 3087);
  assert.strictEqual(m.hamlib.dtrOff, true);
  assert.strictEqual(m.maxPower, 10);
  assert.strictEqual(m.pollDuringTx, false);
  assert.strictEqual(m.caps.split, true);
  assert.strictEqual(m.cw.text, false, 'CW text is off on the rigctld X6100');
  assert.deepStrictEqual(m.rfpower, { min: 0.05, max: 1 });
  const { c, writes } = codec(m, { hamlibRigId: 3087 });
  c.setTxPowerWatts(5);
  assert.deepStrictEqual(writes, ['L RFPOWER 0.500\n']);
  assert.ok(!writes.some((w) => /^T /.test(w) || /set_ptt/i.test(w)), 'setting power does not key');
  let watts = null;
  c.on('power', (w) => { watts = w; });
  c.getPower();
  c.onData(Buffer.from('0.500\n'));
  assert.strictEqual(watts, 5);
});

test('a 0..0 range with no model declaration probes l RFPOWER, then greys when the read is refused', () => {
  const { c, writes, feed } = codec({ maxPower: 5, brand: 'QRP Labs', protocol: 'rigctld' }, { hamlibRigId: 2052 });
  let support = null;
  const fixed = [];
  c.on('meter-support', (s) => { support = s; });
  c.on('power-fixed', (v) => { fixed.push(v); });
  c.probeCaps();
  feed(QDX_DUMP + '\nRPRT 0\n');
  assert.strictEqual(support.swr, false);
  assert.strictEqual(support.alc, false);
  assert.strictEqual(support.rfpower, false);
  assert.strictEqual(support.smeter, true);
  assert.ok(writes.includes('l RFPOWER\n'), 'confirm with a read, not the caps line alone');
  assert.ok(!writes.some((w) => /^T /.test(w) || /^L RFPOWER/.test(w)), 'the probe does not set power or key');
  feed('RPRT -11\n');
  assert.strictEqual(fixed[fixed.length - 1], true);
  writes.length = 0;
  c.setTxPowerWatts(2);
  c.setTxPower(1);
  c.getSwr();
  c.getAlc();
  c.getPowerMeter();
  c.getSmeter();
  assert.deepStrictEqual(writes, ['l STRENGTH\n'], JSON.stringify(writes));
});

test('a 0..0 range whose l RFPOWER read returns a number is not power-fixed', () => {
  const { c, writes, feed } = codec({ maxPower: 5, brand: 'QRP Labs', protocol: 'rigctld' }, { hamlibRigId: 2052 });
  const fixed = [];
  c.on('power-fixed', (v) => { fixed.push(v); });
  c.probeCaps();
  feed(QDX_DUMP + '\nRPRT 0\n');
  feed('0.400\nRPRT 0\n');
  assert.strictEqual(c._powerFixed, false);
  assert.ok(fixed.includes(false));
  writes.length = 0;
  c.setTxPowerWatts(2);
  assert.ok(writes.some((w) => /^L RFPOWER /.test(w)) && !writes.some((w) => /^T /.test(w)));
});

test('real Hamlib 3087 caps (0..0) do not grey the X6100 or hide SWR', () => {
  const { c, writes, feed } = codec(RIG_MODELS.X6100, { hamlibRigId: 3087 });
  const fixed = [];
  let support = null;
  c.on('power-fixed', (v) => { fixed.push(v); });
  c.on('meter-support', (s) => { support = s; });
  c.probeCaps();
  feed(X6100_REAL_CAPS + '\nRPRT 0\n');
  assert.deepStrictEqual(fixed, [false], '0..0 must not mark power fixed');
  assert.strictEqual(c._powerFixed, false);
  assert.deepStrictEqual(c._rfpowerRange, { min: 0.05, max: 1 });
  assert.strictEqual(support.swr, true);
  assert.strictEqual(support.alc, true);
  assert.strictEqual(support.fwdPower, true);
  assert.ok(!writes.includes('l RFPOWER\n'), 'a declared range does not need the probe');
  writes.length = 0;
  c.setTxPowerWatts(5);
  c.getSwr();
  c.getAlc();
  c.getPowerMeter();
  assert.deepStrictEqual(writes, ['L RFPOWER 0.500\n', 'l SWR\n', 'l ALC\n', 'l RFPOWER_METER\n']);
  assert.ok(!writes.some((w) => /^T /.test(w)), 'never keys');
});

test('X6100 dump still polls SWR, ALC, the wattmeter and the S-meter, and none of them key', () => {
  const { c, writes, feed } = codec(RIG_MODELS.X6100, { hamlibRigId: 3087 });
  c.probeCaps();
  feed(X6100_DUMP + '\nRPRT 0\n');
  writes.length = 0;
  c.getSwr();
  c.getAlc();
  c.getPowerMeter();
  c.getSmeter();
  assert.deepStrictEqual(writes, ['l SWR\n', 'l ALC\n', 'l RFPOWER_METER\n', 'l STRENGTH\n']);
});

test('desktop and remote sliders grey a fixed power, and connect power never transmits', () => {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const web = fs.readFileSync(path.join(root, 'renderer', 'remote.js'), 'utf8');
  const webHtml = fs.readFileSync(path.join(root, 'renderer', 'remote.html'), 'utf8');
  assert.ok(main.includes('txpowerFixed'), 'capabilities tell the slider');
  assert.ok(main.includes('function maybeApplyPowerOnConnect'), 'connect applies a saved percent');
  const fn = main.slice(main.indexOf('function maybeApplyPowerOnConnect'), main.indexOf('function maybeApplyPowerOnConnect') + 900);
  assert.ok(!/setTransmit\(true\)|['"]T 1/.test(fn), 'connect power does not key');
  assert.ok(html.includes('power fixed by radio') && webHtml.includes('power fixed by radio'));
  assert.ok(app.includes('txpowerFixed') && web.includes('txpowerFixed'));
  assert.ok(web.includes('swr-warn') && web.includes('swr-alarm'));
  assert.ok(web.includes("case 'meter-caps':"));
  // Flex still sets power through SmartSDR, not L RFPOWER.
  assert.ok(/case 'set-tx-power':[\s\S]{0,400}gatedSmartSdrTxPower\(value\)/.test(main));
});

console.log(`\nrig level range: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
