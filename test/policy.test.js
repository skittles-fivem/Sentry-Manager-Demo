'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, standIn } = require('../demo/policy');

test('reads go through', () => {
  for (const p of ['/api/vehicles', '/api/vehicles/demo-car/days', '/api/telemetry?path=x', '/api/jobs', '/api/can/signals', '/api/events', '/api/media']) {
    assert.deepEqual(decide('GET', p), { ok: true }, p);
  }
  assert.deepEqual(decide('HEAD', '/api/media'), { ok: true });
});

test("the host's own details are stood in for", () => {
  for (const p of ['/api/logs', '/api/logs/download', '/api/support-bundle', '/api/security', '/api/accounts', '/api/nodes', '/api/auth/sessions', '/api/can/tokens', '/api/can/settings', '/api/snapshots', '/api/metrics/settings']) {
    const v = decide('GET', p);
    assert.equal(v.ok, false, p);
    assert.equal(v.hidden, true, p);
    assert.equal(typeof standIn(p), 'object', p);
  }
});

test('every change is refused', () => {
  const writes = [
    ['POST', '/api/vehicles'], ['PUT', '/api/vehicles/demo-car'], ['DELETE', '/api/vehicles/demo-car'],
    ['POST', '/api/vehicles/demo-car/trash'], ['POST', '/api/vehicles/demo-car/trash-days'], ['POST', '/api/bin/empty'],
    ['POST', '/api/bin/x/delete'], ['POST', '/api/studio/trashFolder'], ['POST', '/api/converter/invoke/start'],
    ['POST', '/api/converter/invoke/cancel'], ['POST', '/api/converter/invoke/runBenchmark'], ['POST', '/api/converter/invoke/setAuto'],
    ['POST', '/api/auth/logout'], ['POST', '/api/auth/password'], ['POST', '/api/accounts'], ['PUT', '/api/ui-packs/active'],
    ['POST', '/api/ui-packs/upload'], ['POST', '/api/can/enable'], ['POST', '/api/can/tokens'], ['POST', '/api/nodes'],
    ['POST', '/api/snapshots'], ['POST', '/api/logs/clear'], ['PUT', '/api/settings/power'], ['POST', '/api/stars'],
    ['POST', '/api/places'], ['POST', '/api/jobs/clear'], ['POST', '/api/updates/check'], ['PATCH', '/api/accounts/demo'],
    ['POST', '/api/vehicles/demo-car/scan'], ['POST', '/api/something-new-upstream']
  ];
  for (const [m, p] of writes) {
    const v = decide(m, p);
    assert.equal(v.ok, false, `${m} ${p}`);
    assert.equal(v.status, 403, `${m} ${p}`);
  }
});

test('reads sent as POST go through; exports are let through to the queue check', () => {
  for (const p of ['/api/studio/readDir', '/api/studio/readFile', '/api/studio/browse', '/api/converter/invoke/getCurrent', '/api/telemetry/speeds']) {
    assert.deepEqual(decide('POST', p), { ok: true }, p);
  }
  assert.deepEqual(decide('POST', '/api/vehicles/demo-car/exports'), { ok: true, export: true });
  assert.deepEqual(decide('POST', '/api/exports'), { ok: true, export: true });
  assert.deepEqual(decide('DELETE', '/api/exports/abc'), { ok: true });
});

test('preferences are answered as saved without saving', () => {
  assert.equal(decide('POST', '/api/studio/settings').quiet, true);
  assert.equal(decide('PUT', '/api/dashboards').quiet, true);
});

test('lookalike paths are refused', () => {
  for (const p of ['/api/studio/readDir/../trashFolder', '/api/studio/readDirX', '/api/converter/invoke/getCurrentX', '/api/exports/a/b']) {
    assert.equal(decide('POST', p).ok, false, p);
  }
});

// ---- Sentry USB: nothing about it changes (the demo has no Pi, only the info file it reads)
test('no Sentry USB change gets through; its pages read as usual', () => {
  for (const [m, p] of [['POST', '/api/sentryusb/pair'], ['DELETE', '/api/sentryusb/x'], ['POST', '/api/sentryusb/x/proxy/system/reboot'], ['PUT', '/api/sentryusb/security/settings']]) {
    assert.equal(decide(m, p).ok, false, `${m} ${p}`);
  }
  for (const p of ['/api/sentryusb', '/api/sentryusb/status']) assert.deepEqual(decide('GET', p), { ok: true }, p);
});
