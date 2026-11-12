'use strict';

// The Sentry USB tab's info, made up for each demo car. The manager reads what
// a Sentry USB (the Pi in the car) writes on the car's share:
// <share root>/.sentryusb/device-status.json, the share root being the folder
// that holds RecentClips/ (Sentry-Manager docs/sentry-usb.md, "The info file").
// The demo has no Pi, so it writes that file for every car at every start and
// again every few minutes, so the tab never says "not heard from". The values
// differ a little per car and drift a little over the day. Written the way the
// Pi does it: to device-status.json.tmp, then renamed. DEMO_SENTRYUSB=off: none.

const fs = require('fs');
const path = require('path');

const REFRESH_MS = 4 * 60_000;
const GB = 1024 ** 3;
// per car: storage, battery, temperatures and tires (kPa = psi x 6.894757)
const CARS = [
  { version: 'v3.28.10', total: 256060514304, used: 98.1e9, cam: 60, music: 4, lightshow: 1, cpu: 51.2, pct: 78, inC: 21.4, outC: 7.8, psi: [42, 42.1, 41, 42] },
  { version: 'v3.28.10', total: 128035676160, used: 51.6e9, cam: 40, music: 2, lightshow: 0, cpu: 48.6, pct: 64, inC: 19.8, outC: 8.4, psi: [41.5, 41.8, 41.2, 41.4] },
  { version: 'v3.28.9', total: 512110190592, used: 233.4e9, cam: 120, music: 8, lightshow: 2, cpu: 55.1, pct: 91, inC: 22.6, outC: 6.9, psi: [44.6, 44.4, 43.9, 44.1] },
  { version: 'v3.28.10', total: 256060514304, used: 140.2e9, cam: 80, music: 4, lightshow: 1, cpu: 53.4, pct: 52, inC: 20.1, outC: 7.2, psi: [43.1, 42.9, 42.7, 38.2] }
];
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

/** The info for car number i (any number of cars: the list repeats) at nowMs. */
function infoFor(i, nowMs = Date.now()) {
  const c = CARS[i % CARS.length];
  const now = Math.floor(nowMs / 1000);
  // a slow drift over the day, so the readings are not frozen
  const w = Math.sin((now / 86400) * 2 * Math.PI + i);
  const drives = [['cam', c.cam], ['music', c.music], ['lightshow', c.lightshow]].filter(([, g]) => g > 0).map(([name, g]) => ({ name, size_bytes: g * GB }));
  const used = Math.round(c.used + w * 1.5e9);
  const kpa = c.psi.map((p) => round(p * 6.894757, 1));
  // a tire below 40 psi asks to be checked (Tesla's own warning is lower)
  const tireState = c.psi.some((p) => p < 40) ? 'check' : 'optimal';
  return {
    schema: 1,
    written_unix: now,
    version: c.version,
    storage: { total_bytes: c.total, used_bytes: used, free_bytes: c.total - used },
    drives,
    cpu_temp_c: round(c.cpu + w * 2),
    car: {
      battery: { pct: Math.max(5, Math.min(100, Math.round(c.pct + w * 2))), charging: false, at: now - 300 },
      interior: { c: round(c.inC + w * 0.8), at: now - 300 },
      exterior: { c: round(c.outC + w * 3), at: now - 360 },
      tires: {
        fl: { kpa: kpa[0], at: now - 7200 }, fr: { kpa: kpa[1], at: now - 7200 },
        rl: { kpa: kpa[2], at: now - 7200 }, rr: { kpa: kpa[3], at: now - 7200 },
        state: tireState
      },
      drive: { state: 'parked', since: now - 9000 - i * 1800, at: now - 300 }
    }
  };
}

/** Writes one car's file atomically (the .tmp then a rename, as the Pi does). */
function writeInfo(shareRoot, info) {
  const dir = path.join(shareRoot, '.sentryusb');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'device-status.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(info));
  fs.renameSync(`${file}.tmp`, file);
  return file;
}

/**
 * Writes the info for every car now and every few minutes. cars: [{ name,
 * root }] (root: the share root, the folder holding RecentClips/). Returns
 * { stop, cars }.
 */
function startSentryUsbInfo({ cars, log = () => {}, now = () => Date.now(), everyMs = REFRESH_MS }) {
  const list = cars.filter((c) => c && c.root);
  const writeAll = () => {
    list.forEach((c, i) => {
      try { writeInfo(c.root, infoFor(i, now())); } catch (err) { log(`Sentry USB info for ${c.name}: ${err.message}`); }
    });
  };
  writeAll();
  const t = setInterval(writeAll, everyMs);
  t.unref?.();
  if (list.length) log(`Sentry USB info written for ${list.map((c) => c.name).join(', ')}`);
  return { stop: () => clearInterval(t), cars: list.map((c) => c.name) };
}

module.exports = { startSentryUsbInfo, infoFor, writeInfo, CARS };
