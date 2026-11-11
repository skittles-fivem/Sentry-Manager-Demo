'use strict';

// The Viewer's car-data layout every visitor starts with (demo/viewerLayout.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { OWNER_BOARD, seedViewerLayout } = require('../demo/viewerLayout');
const { decide } = require('../demo/policy');

test("the owner's layout: three 3-in-1 blocks in order and no docked List, °F and mph", () => {
  const { boards, active } = OWNER_BOARD();
  assert.equal(active, 'default');
  const b = boards[0];
  assert.equal(b.metric, false, 'imperial: °F and mph');
  assert.deepEqual(b.blocks.map((x) => x.type), ['wide', 'wide', 'wide'], 'no List: docked, it squashed the Original Viewer\'s cameras');
  assert.deepEqual(b.blocks.slice(0, 3).map((x) => x.signals), [
    ['calc.battTemp', 'can.SmoothBattCurrent132', 'calc.batteryPower'],
    ['can.VCFRONT_tempCoolantBatInlet', 'can.v12vBattVoltage261', 'can.PCS_dcdcLvOutputCurrent'],
    ['can.VCFRONT_tempAmbientFiltered', 'can.VCRIGHT_hvacCabinTempEst', 'dash.steering']
  ]);
  // every id passes the manager's own check (server/index.js cleanBoards)
  for (const blk of b.blocks) for (const id of blk.signals) assert.match(id, /^[\w.:-]{1,80}$/);
});

test('set-up saves it through the API; a manager without stat boards is skipped', async () => {
  const calls = [];
  assert.equal(await seedViewerLayout(async (m, p, body) => { calls.push([m, p, body]); return body; }), true);
  assert.equal(calls[0][0], 'PUT');
  assert.equal(calls[0][1], '/api/dashboards');
  assert.equal(calls[0][2].boards[0].blocks.length, 3);
  const logs = [];
  assert.equal(await seedViewerLayout(async () => { throw Object.assign(new Error('nope'), { status: 404 }); }, (m) => logs.push(m)), false);
  assert.match(logs[0], /no stat boards/);
});

test("a visitor's own rearranging is answered as saved and forgotten", () => {
  assert.equal(decide('PUT', '/api/dashboards').quiet, true);
});
