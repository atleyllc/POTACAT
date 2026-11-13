#!/usr/bin/env node
'use strict';
const { readSrc } = require('./_src');
// Xiegu G90 speaks CI-V, so the rig picker sets it up through Hamlib (3088,
// 19200 baud), the way potacat.com/remote/xiegu-g90/ says. It was 'kenwood'
// under Serial CAT, which could never drive it. Run: node test/g90-hamlib-model-test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { RIG_MODELS, getModelList, migrateX6100CatTarget } = require('../lib/rig-models');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

test('G90 is a Hamlib model: 3088 at 19200, no Kenwood CW text', () => {
  const g = RIG_MODELS.G90;
  assert.strictEqual(g.protocol, 'rigctld');
  assert.deepStrictEqual(g.hamlib, { rigId: 3088, baudRate: 19200 });
  assert.strictEqual(g.cw.text, false);
});

test('the model list carries the Hamlib setup for the picker', () => {
  const x = getModelList().find((b) => b.brand === 'Xiegu');
  assert.deepStrictEqual(x.hamlib, {
    G90: { rigId: 3088, baudRate: 19200 },
    X6100: { rigId: 3087, baudRate: 19200 },
  });
  assert.ok(!getModelList().find((b) => b.brand === 'Icom').hamlib, 'only models that declare it');
});

test('the rig editor picks Other Rig (Hamlib) and fills model + baud', () => {
  const app = readSrc(path.join(__dirname, '..', 'renderer', 'app.js'));
  assert.ok(/const hamlib = groupOf && groupOf\.hamlib && groupOf\.hamlib\[modelName\];/.test(app));
  assert.ok(/setRadioType\('hamlib'\);\s*hamlibFieldsLoaded = true;\s*await populateHamlibFields\(\{ rigId: hamlib\.rigId, baudRate: hamlib\.baudRate \}\);/.test(app));
});

test('X6100 is Hamlib 3087 at 19200, and a saved Kenwood serial target moves over', () => {
  const x = RIG_MODELS.X6100;
  assert.strictEqual(x.protocol, 'rigctld');
  assert.deepStrictEqual(x.hamlib, { rigId: 3087, baudRate: 19200 });
  assert.strictEqual(x.pollDuringTx, false);
  assert.strictEqual(x.cw.text, false);
  assert.ok(x.rxHz && x.rxHz.length >= 1);
  const rig = {
    model: 'X6100',
    catTarget: { type: 'serial', path: '/dev/cu.usbmodem58BE0317243', baudRate: 115200, dtrOff: false },
  };
  assert.strictEqual(migrateX6100CatTarget(rig), true);
  assert.deepStrictEqual(rig.catTarget, {
    type: 'rigctld', rigId: 3087, serialPort: '/dev/cu.usbmodem58BE0317243',
    baudRate: 19200, dtrOff: true, rigctldPort: 4532,
  });
  assert.strictEqual(migrateX6100CatTarget(rig), false, 'a second pass leaves the Hamlib target');
  const g90 = { model: 'G90', catTarget: { type: 'serial', path: '/dev/ttyUSB0' } };
  assert.strictEqual(migrateX6100CatTarget(g90), false);
  assert.strictEqual(g90.catTarget.type, 'serial');
  const flrig = { model: 'X6100', catTarget: { type: 'flrig', host: '127.0.0.1', port: 12345 } };
  assert.strictEqual(migrateX6100CatTarget(flrig), false);
  assert.ok(/migrateX6100CatTarget\(r\)/.test(readSrc(path.join(__dirname, '..', 'main.js'))), 'load migrates saved rigs');
  const xiegu = Object.entries(RIG_MODELS).filter(([, m]) => m.brand === 'Xiegu' && m.protocol === 'kenwood');
  assert.deepStrictEqual(xiegu, [], 'no Xiegu model is still Kenwood text');
});

console.log(`\nG90 Hamlib model: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
