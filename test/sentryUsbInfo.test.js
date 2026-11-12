'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startSentryUsbInfo, infoFor } = require('../demo/sentryUsbInfo');

test('each car gets the info file the manager reads, within its documented ranges', () => {
  const now = Date.UTC(2026, 10, 12, 12);
  for (let i = 0; i < 4; i++) {
    const d = infoFor(i, now);
    assert.equal(d.schema, 1);
    assert.equal(d.written_unix, now / 1000);
    assert.ok(d.storage.used_bytes + d.storage.free_bytes === d.storage.total_bytes);
    assert.ok(d.drives.length <= 8 && d.drives.every((x) => ['cam', 'music', 'lightshow', 'boombox'].includes(x.name)));
    assert.ok(d.cpu_temp_c >= -40 && d.cpu_temp_c <= 125);
    assert.ok(d.car.battery.pct >= 0 && d.car.battery.pct <= 100);
    assert.ok(d.car.interior.c >= -60 && d.car.interior.c <= 100 && d.car.exterior.c >= -70 && d.car.exterior.c <= 70);
    for (const t of ['fl', 'fr', 'rl', 'rr']) assert.ok(d.car.tires[t].kpa > 0 && d.car.tires[t].kpa < 1000);
    assert.ok(['optimal', 'check', 'unsafe'].includes(d.car.tires.state));
    assert.ok(['parked', 'driving'].includes(d.car.drive.state));
    assert.ok(JSON.stringify(d).length < 16 * 1024);
    // no place, position, odometer or VIN
    assert.ok(!/lat|lon|odometer|vin/i.test(JSON.stringify(d)));
  }
  // the cars differ
  assert.notDeepEqual(infoFor(0, now).car, infoFor(1, now).car);
});

test('written at the share root as .sentryusb/device-status.json, with no .tmp left, and refreshed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-usb-'));
  let t = Date.UTC(2026, 10, 12, 12);
  const run = startSentryUsbInfo({ cars: [{ name: 'Demo Model Y', root }, { name: 'none', root: null }], now: () => t, everyMs: 20 });
  const file = path.join(root, '.sentryusb', 'device-status.json');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).written_unix, t / 1000);
  assert.ok(!fs.existsSync(`${file}.tmp`));
  assert.deepEqual(run.cars, ['Demo Model Y']);
  t += 300_000;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).written_unix, t / 1000);
  run.stop();
});
