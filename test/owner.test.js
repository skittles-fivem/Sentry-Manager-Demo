'use strict';

// The owner page (demo/owner.js): only from a local address (never through
// Cloudflare or Docker's gateway), only over HTTPS, only with the password;
// public visitors are sent to / and noted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createOwnerPage } = require('../demo/owner');
const { createAttackLog } = require('../demo/attackLog');
const { createRateLimits, createBans } = require('../demo/rateLimit');
const { createStore } = require('../demo/store');
const { clientAddress, cloudflareMatcher } = require('../demo/clientAddress');

const PASSWORD = 'correct horse battery';
const CF = '172.70.1.2';

function setup({ password = PASSWORD, trustCf = true } = {}) {
  const store = createStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'demo-state-')), delayMs: 10 });
  const proxy = { cloudflare: trustCf ? cloudflareMatcher() : null };
  const addressOf = (r) => clientAddress(r, proxy);
  const attackLog = createAttackLog({ store, addressOf });
  const bans = createBans({ store });
  const limits = createRateLimits({ owner: [5, 60_000] });
  let resets = 0;
  const owner = createOwnerPage({
    password, store, attackLog, bans, limits, addressOf, net: { proxy, gateways: ['172.18.0.1'] }, tlsDir: path.join(store.dir, 'tls'),
    reset: () => { resets++; }
  });
  return { owner, attackLog, bans, resets: () => resets };
}

/** A request through owner.handle: { status, headers, body (parsed when JSON) }. */
async function call(owner, { method = 'GET', url = '/owner', from = '192.168.1.20', tls = true, headers = {}, body = null } = {}) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req, { method, url, headers: { host: 'demo.example.com', ...(method !== 'GET' ? { 'x-requested-with': 'sentry-six-manager' } : {}), ...headers }, socket: { remoteAddress: from, encrypted: tls } });
  const out = { status: 0, headers: {}, body: null };
  const res = {
    headersSent: false,
    writeHead(s, h = {}) { out.status = s; Object.assign(out.headers, Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))); this.headersSent = true; },
    end(b) { const t = b ? Buffer.from(b).toString() : ''; try { out.body = JSON.parse(t); } catch { out.body = t; } }
  };
  const u = new URL(url, 'https://x');
  out.handled = await owner.handle(req, res, u.pathname, u);
  return out;
}

test('public visitors are sent to / and noted: the internet, Cloudflare, a tunnel, Docker\'s gateway', async () => {
  const { owner, attackLog } = setup();
  for (const [from, headers] of [['203.0.113.9', {}], [CF, { 'cf-connecting-ip': '192.168.1.20' }], ['192.168.1.20', { 'cf-ray': 'abc' }], ['172.18.0.1', {}]]) {
    for (const url of ['/owner', '/owner/owner.js', '/api/owner/state']) {
      const r = await call(owner, { url, from, headers });
      assert.equal(r.status, 302, `${from} ${url}`);
      assert.equal(r.headers.location, '/');
    }
  }
  const login = await call(owner, { method: 'POST', url: '/api/owner/login', from: '203.0.113.9', body: { password: PASSWORD } });
  assert.equal(login.status, 302, 'not even the right password from outside');
  assert.ok(!login.headers['set-cookie']);
  const probes = attackLog.list({ kind: 'owner-probe' });
  // (through Cloudflare the visitor is CF-Connecting-IP's; a tunnel's visitor is the tunnel's address)
  assert.deepEqual(probes.map((g) => g.address).sort(), ['172.18.0.1', '192.168.1.20', '203.0.113.9']);
});

test('without DEMO_OWNER_PASSWORD there is no owner page; other paths are never the page\'s', async () => {
  const { owner } = setup({ password: '' });
  assert.equal((await call(owner, {})).handled, false);
  assert.equal((await call(setup().owner, { url: '/ownerx' })).handled, false);
  assert.equal((await call(setup().owner, { url: '/api/vehicles' })).handled, false);
});

test('local, over HTTPS, with the password: a session cookie for /owner only; plain HTTP is sent to https', async () => {
  const { owner, attackLog } = setup();
  const plain = await call(owner, { tls: false });
  assert.equal(plain.status, 308);
  assert.equal(plain.headers.location, 'https://demo.example.com/owner');
  const page = await call(owner, {});
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.equal((await call(owner, { url: '/api/owner/state' })).status, 401);
  const wrong = await call(owner, { method: 'POST', url: '/api/owner/login', body: { password: 'nope' } });
  assert.equal(wrong.status, 401);
  assert.equal(attackLog.list({ kind: 'login' }).length, 1);
  const noHeader = await call(owner, { method: 'POST', url: '/api/owner/login', body: { password: PASSWORD }, headers: { 'x-requested-with': '' } });
  assert.equal(noHeader.status, 403);
  const ok = await call(owner, { method: 'POST', url: '/api/owner/login', body: { password: PASSWORD } });
  assert.equal(ok.status, 200);
  const cookies = ok.headers['set-cookie'];
  assert.ok(cookies.every((c) => /HttpOnly; Secure; SameSite=Strict/.test(c) && /Path=\/(owner|api\/owner);/.test(c)));
  const cookie = cookies[0].split(';')[0];
  const st = await call(owner, { url: '/api/owner/state', headers: { cookie } });
  assert.equal(st.status, 200);
  assert.equal(st.body.you, '192.168.1.20');
  assert.ok(Array.isArray(st.body.log) && st.body.tls && st.body.demo.resetAvailable);
  // the session is no good from outside
  assert.equal((await call(owner, { url: '/api/owner/state', from: '203.0.113.9', headers: { cookie } })).status, 302);
});

test('the password is rate-limited; bans and reset work from the page', async () => {
  const { owner, bans, resets } = setup();
  for (let i = 0; i < 5; i++) await call(owner, { method: 'POST', url: '/api/owner/login', body: { password: 'x' } });
  assert.equal((await call(owner, { method: 'POST', url: '/api/owner/login', body: { password: PASSWORD } })).status, 429);
  const { owner: o2, bans: b2, resets: r2 } = setup();
  const cookie = (await call(o2, { method: 'POST', url: '/api/owner/login', body: { password: PASSWORD } })).headers['set-cookie'][0].split(';')[0];
  assert.equal((await call(o2, { method: 'POST', url: '/api/owner/ban', body: { address: '203.0.113.9' }, headers: { cookie } })).status, 200);
  assert.equal(b2.banned('203.0.113.9'), true);
  assert.equal((await call(o2, { method: 'POST', url: '/api/owner/ban', body: { address: '192.168.1.5' }, headers: { cookie } })).status, 400, 'never a local address');
  const csv = await call(o2, { url: '/api/owner/log.csv', headers: { cookie } });
  assert.match(csv.headers['content-disposition'], /attack-log-/);
  assert.match(csv.body, /203\.0\.113\.9","ban"/);
  assert.equal((await call(o2, { method: 'POST', url: '/api/owner/reset', headers: { cookie } })).status, 200);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(r2(), 1);
  assert.equal(bans.banned('203.0.113.9'), false);
  assert.equal(resets(), 0);
});
