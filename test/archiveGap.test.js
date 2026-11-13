'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, quietArchiveGap } = require('../demo/archiveGap');

test('the stand-in finds no gap: no partial day, nothing to tag', async () => {
  const g = quietArchiveGap();
  assert.deepEqual((await g.check('v')).days, {});
  assert.deepEqual((await g.results('v')).days, {});
  assert.deepEqual(g.forDays('v'), {});
  assert.equal(g.carFiles('v'), null);
  g.soon('v'); g.indexed('k', 0, 1); g.forget('v');
});

test('install() replaces the app\'s createArchiveGap before the app loads it; no module: left alone', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'app-'));
  fs.mkdirSync(path.join(app, 'server'));
  fs.writeFileSync(path.join(app, 'server', 'archiveGap.js'), 'module.exports = { createArchiveGap: () => ({ real: true }), other: 1 };');
  assert.equal(install(app), true);
  const mod = require(path.join(app, 'server', 'archiveGap.js'));
  assert.equal(mod.createArchiveGap({}).real, undefined);
  assert.deepEqual(mod.createArchiveGap({}).forDays('v'), {});
  assert.equal(mod.other, 1);
  assert.equal(install(fs.mkdtempSync(path.join(os.tmpdir(), 'app-'))), false);
});
