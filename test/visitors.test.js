'use strict';

// Visitor activity (demo/visitors.js): strict validation, caps, visits and
// active time on the server's clock, and the pages never opened.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVisitors, validPost, validEvent, readRoutes, allPages, ROUTES, MAX_POST_EVENTS } = require('../demo/visitors');
const { createStore } = require('../demo/store');

function setup(o = {}) {
  const store = createStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'demo-vis-')), delayMs: 10 });
  let t = Date.parse('2026-11-11T12:00:00Z');
  const clock = { now: () => t, add: (ms) => { t += ms; } };
  return { store, clock, vis: createVisitors({ store, now: clock.now, ...o }) };
}
const IP = '203.0.113.7';

test('only known event types, known pages and capped labels get through', () => {
  const pages = new Set(allPages(ROUTES));
  assert.equal(validEvent({ type: 'keydown', key: 'a' }, pages), null);
  assert.equal(validEvent({ type: 'view', page: 'original:../../etc' }, pages), null);
  assert.equal(validEvent({ type: 'view', page: 'horizon:nope' }, pages), null);
  assert.deepEqual(validEvent({ type: 'view', page: 'horizon:alerts' }, pages), { type: 'view', page: 'horizon:alerts' });
  assert.deepEqual(validEvent({ type: 'view', page: 'studio:encoder' }, pages), { type: 'view', page: 'studio:encoder' });
  assert.equal(validEvent({ type: 'click', kind: 'script', label: 'x' }, pages), null);
  assert.equal(validEvent({ type: 'click', kind: 'button', label: 42 }, pages), null);
  const long = validEvent({ type: 'click', kind: 'button', label: `  Save\n\n${'x'.repeat(200)}` }, pages);
  assert.equal(long.label.length, 60);
  assert.ok(long.label.startsWith('Save x'));
  assert.equal(validEvent({ type: 'beat', ui: 'aurora', ms: 1000 }, pages), null);
  assert.equal(validEvent({ type: 'beat', ui: 'original', ms: -5 }, pages), null);
  assert.equal(validEvent({ type: 'beat', ui: 'original', ms: 9e9 }, pages).ms, 20_000);
  assert.equal(validEvent({ type: 'swap', to: 'evil' }, pages), null);
  // the device: only the summary fields, clipped
  assert.equal(validEvent({ type: 'device', device: { os: 'iOS 18', browser: 'Safari 18', touch: 'yes (5 points)', gpu: 'Apple GPU' } }, pages).device, 'iOS 18 · Safari 18 · touch');
  // a post: an array of 1 to 60 events
  assert.equal(validPost({ events: [] }, pages), null);
  assert.equal(validPost({ events: 'x' }, pages), null);
  assert.equal(validPost({ events: Array(MAX_POST_EVENTS + 1).fill({ type: 'swap', to: 'horizon' }) }, pages), null);
  assert.equal(validPost({ events: [{ type: 'nope' }] }, pages), null);
});

test('a bad post is refused and makes no visitor; the address and time are the server\'s', () => {
  const { vis, clock } = setup();
  assert.equal(vis.record(IP, { events: [{ type: 'keydown' }] }).status, 400);
  assert.equal(vis.record(IP, null).status, 400);
  assert.equal(vis.count(), 0);
  assert.equal(vis.record(IP, { ip: '1.2.3.4', t: 1, events: [{ type: 'view', page: 'original:footage', t: 5 }] }).status, 200);
  const [v] = vis.list();
  assert.equal(v.ip, IP);
  assert.equal(v.first, clock.now());
  assert.deepEqual(vis.events(IP).at(-1), { t: clock.now(), type: 'view', detail: 'original:footage' });
});

test('visits: a new one after 30 minutes idle; active time never more than the server\'s clock', () => {
  const { vis, clock } = setup();
  const beat = (ms, ui = 'original') => vis.record(IP, { events: [{ type: 'beat', ui, ms }] });
  beat(15_000);
  clock.add(15_000); beat(15_000);
  clock.add(15_000); beat(15_000, 'horizon');
  // a client claiming 20 s when only 3 s passed gets about 3 (+2 s slack)
  clock.add(3_000); beat(20_000, 'horizon');
  let [v] = vis.list();
  assert.equal(v.visits, 1);
  assert.equal(v.active, 50_000);
  assert.deepEqual(v.time, { original: 30_000, horizon: 20_000 });
  clock.add(29 * 60_000); beat(1000);
  assert.equal(vis.list()[0].visits, 1);
  clock.add(31 * 60_000); beat(1000);
  clock.add(31 * 60_000); vis.record(IP, { events: [{ type: 'view', page: 'original:jobs' }] });
  v = vis.list()[0];
  assert.equal(v.visits, 3);
  assert.equal(vis.events(IP).filter((e) => e.type === 'visit').length, 3);
});

test('swaps, controls with counts, blocked changes and feedback', () => {
  const { vis } = setup();
  vis.record(IP, { events: [{ type: 'click', kind: 'button', label: 'Swap to Horizon UI' }, { type: 'swap', to: 'horizon' }, { type: 'click', kind: 'button', label: 'Swap to Horizon UI' }] });
  vis.blocked(IP, 'DELETE /api/vehicles/1');
  vis.blocked('198.51.100.9', 'POST /api/x'); // unknown: not made a visitor
  vis.feedback(IP);
  const [v] = vis.list();
  assert.equal(vis.count(), 1);
  assert.equal(v.swaps, 1);
  assert.equal(v.clicks['button|Swap to Horizon UI'], 2);
  assert.equal(v.blocked, 1);
  assert.equal(v.feedback, 1);
  assert.ok(vis.events(IP).some((e) => e.type === 'blocked' && e.detail === 'DELETE /api/vehicles/1'));
});

test('caps: 200 events each, the oldest visitors go past 2000, none older than 30 days', () => {
  const { vis, clock } = setup({ maxVisitors: 5, maxEvents: 10 });
  for (let i = 0; i < 30; i++) vis.record(IP, { events: [{ type: 'click', kind: 'link', label: `L${i}` }] });
  assert.equal(vis.events(IP).length, 10);
  assert.equal(vis.events(IP).at(-1).detail, 'link|L29');
  for (let i = 1; i <= 7; i++) { clock.add(1000); vis.record(`198.51.100.${i}`, { events: [{ type: 'view', page: 'original:bin' }] }); }
  assert.equal(vis.count(), 5);
  assert.equal(vis.events(IP), null); // the one idle longest went first
  clock.add(31 * 86400_000);
  vis.record('2001:db8::1', { events: [{ type: 'view', page: 'original:bin' }] });
  assert.deepEqual(vis.list().map((v) => v.ip), ['2001:db8::1']);
  // the real caps
  const { vis: big } = setup();
  for (let i = 0; i < 250; i++) big.record(IP, { events: [{ type: 'view', page: 'original:bin' }] });
  assert.equal(big.events(IP).length, 200);
});

test('the pages never opened: those of the interfaces used, and the Studio pages; every one seen ticks', () => {
  const { vis } = setup();
  vis.record(IP, { events: [{ type: 'view', page: 'original:overview' }, { type: 'view', page: 'original:footage' }] });
  let [v] = vis.list();
  assert.equal(v.sawAll, false);
  assert.ok(v.never.includes('original:settings'));
  assert.ok(v.never.includes('studio:viewer'));
  assert.ok(!v.never.some((p) => p.startsWith('horizon:')), 'Horizon never used: not listed');
  vis.record(IP, { events: [...ROUTES.original.map((r) => ({ type: 'view', page: `original:${r}` })), { type: 'view', page: 'studio:viewer' }, { type: 'view', page: 'studio:encoder' }] });
  v = vis.list()[0];
  assert.deepEqual(v.never, []);
  assert.equal(v.sawAll, true);
  // a swap to Horizon: its pages count too
  vis.record(IP, { events: [{ type: 'beat', ui: 'horizon', ms: 5000 }] });
  v = vis.list()[0];
  assert.equal(v.sawAll, false);
  assert.deepEqual(v.never, ROUTES.horizon.map((r) => `horizon:${r}`));
});

test('kept across resets (demo/store.js), and the nav routes read from the app', () => {
  const { vis, store } = setup();
  vis.record(IP, { events: [{ type: 'view', page: 'horizon:jobs' }] });
  store.flush();
  const again = createVisitors({ store: createStore({ dir: store.dir }) });
  assert.equal(again.list()[0].pages['horizon:jobs'], 1);
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-app-'));
  fs.mkdirSync(path.join(app, 'web'));
  fs.mkdirSync(path.join(app, 'examples/ui-packs/horizon/web/hz'), { recursive: true });
  fs.writeFileSync(path.join(app, 'web/index.html'), '<nav class="nav" id="nav"><a data-route="overview"></a><a data-route="footage"></a><a data-route="new-page"></a></nav><a data-route="outside">');
  fs.writeFileSync(path.join(app, 'examples/ui-packs/horizon/web/hz/main.js'), "export const PAGES = [\n  { id: 'dashboard', label: 'D' },\n  { id: 'viewer', label: 'V' },\n  { id: 'jobs', label: 'J' }\n];\n");
  assert.deepEqual(readRoutes(app), { original: ['overview', 'footage', 'new-page'], horizon: ['dashboard', 'viewer', 'jobs'] });
  assert.deepEqual(readRoutes(path.join(app, 'missing')), ROUTES);
});
