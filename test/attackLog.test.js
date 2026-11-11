'use strict';

// The attack log (demo/attackLog.js): repeats collapse into one row per
// address and kind, rows are capped, samples clipped, CSV safe, and it
// survives the reset (the store).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAttackLog, classifyUrl, csvCell } = require('../demo/attackLog');
const { createStore } = require('../demo/store');

const tmpStore = () => createStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'demo-state-')), delayMs: 10 });
const req = (ip, url = '/', ua = 'curl/8') => ({ socket: { remoteAddress: ip }, headers: { 'user-agent': ua }, url });
const of = (r) => r.socket.remoteAddress;

test('repeats collapse: one row per address and kind, with a count; grouped by address', () => {
  let t = 1_000;
  const log = createAttackLog({ store: tmpStore(), addressOf: of, now: () => t });
  for (let i = 0; i < 50; i++) { t += 1; log.note('scan', req('203.0.113.9'), `/wp-login.php?${i}`); }
  t += 1;
  log.note('refused', req('203.0.113.9'), 'POST /api/bin/empty');
  t += 1;
  log.note('owner-probe', req('198.51.100.7'), 'GET /owner');
  assert.equal(log.size(), 3);
  const groups = log.list();
  assert.equal(groups[0].address, '198.51.100.7', 'newest first');
  const g = groups.find((x) => x.address === '203.0.113.9');
  assert.equal(g.count, 51);
  assert.deepEqual(g.kinds, { scan: 50, refused: 1 });
  assert.equal(g.entries.find((e) => e.kind === 'scan').sample, '/wp-login.php?49', 'the last sample kept');
  assert.equal(log.list({ sort: 'active' })[0].address, '203.0.113.9');
  assert.equal(log.list({ kind: 'owner-probe' }).length, 1);
});

test('caps: at most maxRows rows (the oldest go), old rows expire, samples and agents clipped', () => {
  let t = 1_000;
  const log = createAttackLog({ store: tmpStore(), addressOf: of, now: () => t, maxRows: 100, keepDays: 1 });
  for (let i = 0; i < 300; i++) { t += 1; log.note('scan', req(`10.9.${Math.floor(i / 250)}.${i % 250}`), '/.env'); }
  assert.equal(log.size(), 100);
  assert.ok(log.list({ limit: 2000 }).every((g) => g.lastSeen > 1_200), 'the newest kept');
  log.note('exploit', req('203.0.113.1', '/', 'x'.repeat(1000)), 'y'.repeat(1000));
  const e = log.list({ address: '203.0.113.1' })[0].entries[0];
  assert.ok(e.sample.length <= 160 && e.agent.length <= 200);
  log.note('exploit', req('203.0.113.2'), 'a‮b\u0000c');
  assert.equal(log.list({ address: '203.0.113.2' })[0].entries[0].sample, 'a\\u{202e}b\\u{0}c', 'invisible characters written out');
  t += 2 * 86400_000;
  log.note('scan', req('203.0.113.3'), '/x');
  assert.equal(log.size(), 1, 'older than keepDays: gone');
  assert.equal(log.list({ limit: 5000 }).length, 1);
});

test('the URL check: scanner paths and exploit patterns, never the app\'s own paths', () => {
  assert.equal(classifyUrl('/wp-admin/setup.php').kind, 'scan');
  assert.equal(classifyUrl('/.git/config').kind, 'scan');
  assert.equal(classifyUrl('/api/vehicles?x=1%27%20OR%20%271%27=%271').kind, 'exploit');
  assert.equal(classifyUrl('/x?q=${jndi:ldap://e}').kind, 'exploit');
  assert.equal(classifyUrl('/api/media?path=/footage/a.mp4'), null);
  assert.equal(classifyUrl('/demo/feedback'), null);
});

test('CSV cells are never formulas; the log and visitor counts survive a restart', async () => {
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-state-'));
  const store = createStore({ dir, delayMs: 10 });
  const log = createAttackLog({ store, addressOf: of });
  log.note('ban', '203.0.113.9', 'banned');
  log.seen(req('203.0.113.9'));
  log.seen(req('203.0.113.9'));
  log.seen(req('198.51.100.7'));
  assert.equal(log.stats().visitorsToday, 2);
  assert.match(log.csv(), /"203\.0\.113\.9","ban","1"/);
  store.flush();
  const again = createAttackLog({ store: createStore({ dir }), addressOf: of });
  assert.equal(again.size(), 1);
  assert.equal(again.stats().visitorsToday, 2);
  assert.ok(!fs.readFileSync(path.join(dir, 'attack-log.json'), 'utf8').includes('198.51.100.7'), 'visitors are only counted, as hashes');
});
