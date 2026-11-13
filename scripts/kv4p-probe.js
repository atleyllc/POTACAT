#!/usr/bin/env node
'use strict';

/**
 * Talk to a kv4p HT on a serial port, without starting POTACAT.
 *
 *   node scripts/kv4p-probe.js --port /dev/cu.usbserial-1110
 *   node scripts/kv4p-probe.js --port /dev/ttyUSB0 --freq 146.52 --listen 5
 *
 * Prints the firmware version and the band, tunes receive when --freq is
 * given, and counts Opus audio frames for --listen seconds.
 *
 * It does not transmit unless --tx is on the command line. --tx keys the
 * radio for --tx-ms milliseconds (default 500) and then releases PTT.
 * The driver's own time-out (default 3 minutes) still applies.
 *
 * Linux: the user running this must be allowed to open the port. On Arch
 * that is the uucp group; on Debian and Ubuntu it is dialout.
 */

const { probe } = require('../lib/kv4p-client');

function probePlan(argv) {
  const out = { port: '', freqMhz: 0, listenSec: 0, tx: false, txMs: 500, help: false };
  const args = argv.slice();
  while (args.length) {
    const a = args.shift();
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--port') out.port = args.shift() || '';
    else if (a === '--freq') out.freqMhz = Number(args.shift());
    else if (a === '--listen') out.listenSec = Math.max(0, Number(args.shift()) || 0);
    else if (a === '--tx') out.tx = true;
    else if (a === '--tx-ms') out.txMs = Math.max(0, Number(args.shift()) || 0);
    else if (a.startsWith('--port=')) out.port = a.slice(7);
    else if (a.startsWith('--freq=')) out.freqMhz = Number(a.slice(7));
    else if (a.startsWith('--listen=')) out.listenSec = Math.max(0, Number(a.slice(9)) || 0);
    else if (a.startsWith('--tx-ms=')) out.txMs = Math.max(0, Number(a.slice(8)) || 0);
    else return { error: 'Unknown argument ' + a };
  }
  if (out.help) return out;
  if (!out.port) return { error: 'Pass --port (macOS example: /dev/cu.usbserial-1110, Linux: /dev/ttyUSB0).' };
  if (out.freqMhz && !(out.freqMhz > 100 && out.freqMhz < 500)) return { error: '--freq is MHz, for example 146.52 or 446.0.' };
  if (out.tx && !out.freqMhz) return { error: '--tx also needs --freq, so the carrier is on a frequency you chose.' };
  return out;
}

function help() {
  return [
    'Usage: node scripts/kv4p-probe.js --port <device> [--freq MHz] [--listen seconds] [--tx] [--tx-ms N]',
    '',
    '  --port     Serial device. macOS: /dev/cu.usbserial-1110. Linux: /dev/ttyUSB0 or /dev/ttyACM0.',
    '  --freq     Tune receive to this MHz. Does not transmit.',
    '  --listen   After HELLO (and the tune), count RX audio frames for this many seconds.',
    '  --tx       Key the radio. Off unless you pass this flag.',
    '  --tx-ms    How long --tx stays keyed. Default 500.',
    '',
    'Linux permissions: Arch uses the uucp group, Debian and Ubuntu use dialout.',
  ].join('\n');
}

async function main(argv) {
  const plan = probePlan(argv);
  if (plan.help) { console.log(help()); return 0; }
  if (plan.error) { console.error(plan.error); console.error(help()); return 2; }
  if (plan.tx) console.log('TRANSMITTING for ' + plan.txMs + ' ms on ' + plan.freqMhz + ' MHz.');
  const result = await probe({
    port: plan.port,
    freqMhz: plan.freqMhz || undefined,
    listenSec: plan.listenSec,
    tx: plan.tx,
    txMs: plan.txMs,
  });
  for (const line of result.logs || []) console.log(line);
  if (!result.ok) { console.error(result.error || 'failed'); return 1; }
  const i = result.info || {};
  console.log(`firmware ${i.firmware}  ${i.module}  radio module ${i.radio}`);
  console.log(`range ${i.minMhz}–${i.maxMhz} MHz  RX ${Number(i.rxMhz).toFixed(4)}  TX ${Number(i.txMhz).toFixed(4)}  squelch ${i.squelch}`);
  if (plan.listenSec) console.log(`audio frames in ${plan.listenSec}s: ${result.audioFrames}`);
  if (!plan.tx) console.log('Did not transmit (no --tx).');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}

module.exports = { probePlan, help };
