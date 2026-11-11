'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createFakeExports } = require('../demo/fakeExport');

const req = (method, body) => Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method });
const res = () => { const r = { status: 0, ended: false, writeHead(s) { r.status = s; }, end() { r.ended = true; } }; return r; };
const BODY = { clips: [{ key: '2026-11-01_10-00-00', files: { front: '/x.mp4' }, from: 0, to: 30 }], camera: 'grid' };

test('an export waits, renders and is done on its clock; nothing is rendered', async () => {
  let t = 1_000_000;
  const fx = createFakeExports({ now: () => t });
  let sent = null;
  const send = (r, status, body) => { sent = { status, body }; };
  assert.equal(await fx.answer(req('POST', BODY), res(), '/api/vehicles/car1/exports', send), true);
  assert.equal(sent.status, 200);
  const { id } = sent.body;
  assert.equal(sent.body.state, 'waiting');
  assert.equal(sent.body.vehicleId, 'car1');
  assert.match(sent.body.name, /2026-11-01_10-00-00\.mp4$/);
  t += 1500 + 9000;
  assert.equal(await fx.answer(req('GET'), res(), `/api/exports/${id}`, send), true);
  assert.equal(sent.body.state, 'running');
  assert.ok(sent.body.progress > 0.4 && sent.body.progress < 0.6);
  t += 20_000;
  await fx.answer(req('GET'), res(), `/api/exports/${id}`, send);
  assert.equal(sent.body.state, 'done');
  assert.equal(sent.body.progress, 1);
});

test('the file is never sent, for any export; cancel; bad bodies; other ids pass through', async () => {
  const fx = createFakeExports();
  let sent = null;
  const send = (r, status, body) => { sent = { status, body }; };
  const r = res();
  assert.equal(await fx.answer(req('GET'), r, '/api/exports/abcdef/file', send), true);
  assert.equal(r.status, 204);
  await fx.answer(req('POST', BODY), res(), '/api/exports', send);
  const { id } = sent.body;
  await fx.answer(req('DELETE'), res(), `/api/exports/${id}`, send);
  assert.equal(sent.body.ok, true);
  assert.equal(fx.get(id).state, 'cancelled');
  await fx.answer(req('POST', { clips: [] }), res(), '/api/exports', send);
  assert.equal(sent.status, 400);
  assert.equal(await fx.answer(req('GET'), res(), '/api/exports/0123456789abcdef', send), false);
  assert.equal(await fx.answer(req('GET'), res(), '/api/exports', send), false);
});
