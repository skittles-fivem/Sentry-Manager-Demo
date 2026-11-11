'use strict';

// "Swap to Horizon UI" (demo/uiSwap.js): per browser only. A browser with the
// cookie is served the Horizon pack; without it, the original; the app's
// chosen interface for everyone never changes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uiOf, runFor, wrapPacks, install, choose, cookieFor } = require('../demo/uiSwap');
const { decide } = require('../demo/policy');

const MANAGER = process.env.MANAGER_ROOT || path.resolve(__dirname, '..', '..', 'Sentry-Manager');
const PACKS = path.join(MANAGER, 'server', 'uiPacks.js');
const req = (cookie) => ({ headers: cookie ? { cookie } : {} });

/** A built-in packs folder with a Horizon pack, and the app's createUiPacks shape around it. */
function fakePacks() {
  const builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packs-'));
  fs.mkdirSync(path.join(builtinDir, 'horizon', 'web'), { recursive: true });
  fs.writeFileSync(path.join(builtinDir, 'horizon', 'web', 'index.html'), '<div id="app">horizon</div>');
  const db = new Map();
  const writes = [];
  const packs = {
    list: () => [{ id: 'horizon', builtin: true }],
    active: () => db.get('ui-pack') ?? null,
    setActive: (id) => { writes.push(id); db.set('ui-pack', id); return id; },
    root: (kind) => (db.get('ui-pack') === 'horizon' ? path.join(builtinDir, 'horizon', kind) : null)
  };
  return { packs, builtinDir, writes, db };
}

test('the cookie: demo_ui=horizon only; anything else, or none, is the original', () => {
  assert.equal(uiOf(req('demo_ui=horizon')), 'horizon');
  assert.equal(uiOf(req('a=1; demo_ui=horizon; b=2')), 'horizon');
  for (const c of [null, '', 'demo_ui=original', 'demo_ui=aurora', 'demo_ui=horizonx', 'xdemo_ui=horizon', 'demo_ui=../horizon']) assert.equal(uiOf(req(c)), null, String(c));
});

test('a browser with the cookie is served Horizon; without it, the original; the pack chosen for everyone never changes', async () => {
  const { packs, builtinDir, writes, db } = fakePacks();
  const w = wrapPacks(packs, { builtinDir });
  assert.equal(w.root('web'), null, 'outside any request: the app\'s own');
  await runFor(req('demo_ui=horizon'), async () => {
    await new Promise((r) => setImmediate(r)); // (still known after an await, as in the app's handler)
    assert.equal(w.active(), 'horizon');
    assert.equal(w.root('web'), path.join(builtinDir, 'horizon', 'web'));
    assert.equal(w.root('studio'), null, 'Horizon has no studio folder: the built-in one');
    assert.equal(w.root('../x'), null);
  });
  await runFor(req(null), async () => {
    assert.equal(w.active(), null);
    assert.equal(w.root('web'), null);
  });
  // two browsers at once: each its own
  await Promise.all([
    runFor(req('demo_ui=horizon'), async () => { await new Promise((r) => setTimeout(r, 5)); assert.equal(w.active(), 'horizon'); }),
    runFor(req(null), async () => { await new Promise((r) => setTimeout(r, 5)); assert.equal(w.active(), null); })
  ]);
  assert.deepEqual(writes, [], 'setActive was never called');
  assert.equal(db.has('ui-pack'), false, 'the stored choice is untouched');
});

test('POST /demo/ui takes only "horizon" or "original"; the cookie is HttpOnly, SameSite=Strict, Secure on HTTPS', () => {
  const on = choose({ ui: 'horizon' }, { secure: true });
  assert.equal(on.status, 200);
  assert.match(on.cookie, /^demo_ui=horizon; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=\d+$/);
  const off = choose({ ui: 'original' }, { secure: true });
  assert.match(off.cookie, /^demo_ui=; .*Max-Age=0$/);
  assert.ok(!cookieFor('horizon', false).includes('Secure'));
  for (const body of [{ ui: 'aurora' }, { ui: 'HORIZON' }, { ui: '' }, { ui: ['horizon'] }, { ui: null }, {}, null, 'horizon', { ui: 'horizon ' }]) {
    const r = choose(body, { secure: true });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.cookie, undefined);
  }
  // and the app's own switch for everyone stays refused
  assert.equal(decide('PUT', '/api/ui-packs/active').status, 403);
  assert.equal(decide('POST', '/api/ui-packs/upload').status, 403);
});

test('install() wraps the app\'s createUiPacks before the app loads it, once', () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'app-'));
  fs.mkdirSync(path.join(app, 'server'));
  fs.writeFileSync(path.join(app, 'server', 'uiPacks.js'), "module.exports = { createUiPacks: (o) => ({ list: () => [], active: () => null, root: () => null, setActive: () => null, o }) };");
  const mod = install(app);
  assert.equal(mod.createUiPacks.demoWrapped, true);
  assert.equal(install(app).createUiPacks, mod.createUiPacks, 'not wrapped twice');
  assert.equal(typeof mod.createUiPacks({ builtinDir: '/x' }).root, 'function');
});

test('with the manager\'s own uiPacks and its built-in Horizon pack', { skip: fs.existsSync(PACKS) ? false : `no manager checkout at ${MANAGER} (set MANAGER_ROOT)` }, async () => {
  const { createUiPacks } = require(PACKS);
  const store = new Map();
  const writes = [];
  const db = { get: (k, d = null) => (store.has(k) ? store.get(k) : d), set: (k, v) => { writes.push([k, v]); store.set(k, v); } };
  const builtinDir = path.join(MANAGER, 'examples', 'ui-packs');
  const w = wrapPacks(createUiPacks({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'packs-')), db, builtinDir }), { builtinDir });
  assert.ok(w.list().some((p) => p.id === 'horizon' && p.builtin));
  await runFor(req('demo_ui=horizon'), () => {
    assert.equal(w.root('web'), path.join(builtinDir, 'horizon', 'web'));
    assert.ok(fs.readFileSync(path.join(w.root('web'), 'index.html'), 'utf8').includes('id="app"'), 'the banner can go in');
  });
  await runFor(req(null), () => assert.equal(w.root('web'), null));
  assert.equal(w.active(), null);
  assert.deepEqual(writes.filter(([k]) => k === 'ui-pack'), []);
});
