'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeEncoder } = require('../demo/fakeEncoder');

test('the pretend job runs on this server and the nodes, finishes, and starts again', () => {
  const f = createFakeEncoder({ sourceRoot: '/footage/demo-car/TeslaCam', vehicleId: 'demo-car', vehicleName: 'Demo', clips: 60, minutes: 2, initialProgress: 0 });
  let now = Date.now();
  f.tick(now);
  const first = f.job.id;
  const lanes = new Set(f._slots.filter((s) => s.item).map((s) => s.lane.device));
  assert.ok([...lanes].some((d) => d.startsWith('node:')), 'clips on a node');
  assert.ok([...lanes].some((d) => !d.startsWith('node:')), 'clips on this server');
  const stats = f.patchStats({ gpus: [], power: {} });
  assert.ok(stats.encoder.workers.some((w) => w.remote), 'remote workers in /api/stats');
  assert.equal(stats.power.nodes.length, 3);
  for (let i = 0; i < 400 && f.job.state !== 'completed'; i++) { now += 1000; f.tick(now); }
  assert.equal(f.job.state, 'completed');
  assert.ok(f.job.counters.savedBytes > 0);
  assert.equal(f.job.items.filter((x) => ['queued', 'processing'].includes(x.state)).length, 0);
  now += 4 * 60_000;
  f.tick(now);
  assert.notEqual(f.job.id, first, 'a new job after the summary');
  const jobs = f.patchJobs({ jobs: [{ id: 1, type: 'scan', startedAt: 1 }, { id: 2, type: 'conversion', startedAt: 2 }] });
  assert.equal(jobs.jobs.filter((j) => j.type === 'conversion' && j.id === 2).length, 0, 'the real conversion entry is replaced');
  assert.ok(jobs.jobs.some((j) => j.type === 'scan'));
});

test('nodes and devices look like paired, online nodes', () => {
  const f = createFakeEncoder({ sourceRoot: '/x', vehicleId: 'demo-car', vehicleName: 'Demo' });
  const o = f.nodesOverview({ available: true });
  assert.equal(o.nodes.length, 3);
  for (const n of o.nodes) {
    assert.match(n.id, /^[a-z0-9]{12}$/);
    assert.equal(n.online, true);
    assert.match(n.defaultLane, /^node:[a-z0-9]{12}@(pci:[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]|cpu)$/);
  }
  const d = f.devices().value.devices;
  assert.ok(d.some((x) => x.kind === 'node' && x.online));
  for (const lane of f.current().value.config.lanes) assert.match(lane.device, /^(pci:[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]|cpu|node:[a-z0-9]{12}(@(pci:[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]|cpu))?)$/);
});
