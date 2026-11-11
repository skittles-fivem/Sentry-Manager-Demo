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

// ---- the stand-in Sentry USB (demo/sentryUsb/): its changes, and only its
const PI = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
const px = (rest, id = PI) => `/api/sentryusb/${id}/proxy${rest}`;

test("the stand-in Sentry USB's changes go through, for its id only", () => {
  const allowed = [
    ['PUT', '/setup/config'], ['POST', '/setup/run'], ['POST', '/system/reboot'], ['POST', '/system/shutdown'], ['POST', '/system/trigger-sync'],
    ['POST', '/system/cancel-archive'], ['POST', '/system/toggle-drives'], ['POST', '/system/gadget-enable'], ['POST', '/system/gadget-disable'],
    ['POST', '/system/check-update'], ['POST', '/system/update'], ['POST', '/system/backup'], ['POST', '/diagnostics/refresh'],
    ['POST', '/diagnostics/download'], ['DELETE', '/snapshots/snap-000041']
  ];
  for (const [m, rest] of allowed) {
    assert.deepEqual(decide(m, px(rest), { standInId: PI }), { ok: true, standIn: true }, `${m} ${rest}`);
    // another Pi's id, or no stand-in: refused
    assert.equal(decide(m, px(rest, OTHER), { standInId: PI }).status, 403, `${m} ${rest} other id`);
    assert.equal(decide(m, px(rest)).status, 403, `${m} ${rest} without a stand-in`);
  }
});

test('nothing else about Sentry USBs changes: pairing, renaming, unpairing, the queue, other Pi routes, lookalikes', () => {
  const refused = [
    ['POST', '/api/sentryusb/pair'], ['DELETE', '/api/sentryusb/pair'], ['PATCH', `/api/sentryusb/${PI}`], ['DELETE', `/api/sentryusb/${PI}`],
    ['POST', `/api/sentryusb/${PI}/queue`], ['DELETE', `/api/sentryusb/${PI}/queue/q1`], ['PUT', '/api/sentryusb/security/settings'],
    ['PUT', px('/notifications/settings')], ['PUT', px('/system/update-source')], ['POST', px('/setup/test-archive')], ['PUT', px('/config/preference')],
    ['POST', px('/system/reboot/x')], ['POST', px('/system/../system/reboot')], ['POST', px('/system//reboot')],
    ['POST', `${px('/system/reboot')}%2F`], ['POST', px('/system/rebootx')], ['DELETE', px('/snapshots/../x')], ['PUT', px('/setup/config', PI.toUpperCase())],
    ['POST', `/api/sentryusb/${PI}x/proxy/system/reboot`], ['POST', `/api/sentryusb/${PI}/proxyx/system/reboot`]
  ];
  for (const [m, p] of refused) assert.equal(decide(m, p, { standInId: PI }).ok, false, `${m} ${p}`);
  // a bad stand-in id never opens anything
  assert.equal(decide('POST', px('/system/reboot', 'x'.repeat(32)), { standInId: 'x'.repeat(32) }).ok, false);
});

test("reading the Sentry USB pages stays allowed (the stand-in's status, logs, settings)", () => {
  for (const p of ['/api/sentryusb', px('/status'), px('/logs/setup/tail'), px('/setup/config'), '/api/sentryusb/security']) assert.deepEqual(decide('GET', p, { standInId: PI }), { ok: true }, p);
});
