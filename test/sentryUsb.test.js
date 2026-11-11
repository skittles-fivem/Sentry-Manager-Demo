'use strict';

// The stand-in Sentry USB (demo/sentryUsb/): it keeps what the manager
// changes, with the Pi's rules, and pairs through the real link protocol.
// The protocol comes from the manager (server/sentryUsbLink.js), so these
// need a manager checkout with the Sentry USB link: MANAGER_ROOT, or
// ../Sentry-Manager next to this repo. Without one they are skipped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const MANAGER = process.env.MANAGER_ROOT || path.resolve(__dirname, '..', '..', 'Sentry-Manager');
const HAS_LINK = fs.existsSync(path.join(MANAGER, 'server', 'sentryUsbLink.js')) && fs.existsSync(path.join(MANAGER, 'server', 'wsFrames.js'));
const skip = HAS_LINK ? false : `no manager checkout with the Sentry USB link at ${MANAGER} (set MANAGER_ROOT)`;
process.env.APP_ROOT = MANAGER;

const quiet = { info() {}, warn() {}, debug() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error('timed out'); await wait(25); } };
const tmp = () => fsp.mkdtemp(path.join(os.tmpdir(), 'demo-pi-'));
const memDb = () => { const m = new Map(); return { get: (k, f = null) => (m.has(k) ? structuredClone(m.get(k)) : f), set: (k, v) => m.set(k, structuredClone(v)) }; };
const fullBody = (cfg) => Object.fromEntries(Object.entries(cfg).filter(([k, v]) => !k.endsWith('__set') && v.active).map(([k, v]) => [k, v.value]));

test('settings saves keep the Pi\'s rules, are logged, and secrets stay masked', { skip }, async () => {
  const { createDemoSentryUsb } = require('../demo/sentryUsb/standIn');
  const dir = await tmp();
  const pi = createDemoSentryUsb({ dir });
  const cfg = pi.answer({ method: 'GET', path: '/api/setup/config' }).body;
  assert.deepEqual(cfg.WIFIPASS, { value: '', active: true });
  assert.ok(!JSON.stringify(cfg).includes('correct-battery-staple'));
  const put = (b) => pi.answer({ method: 'PUT', path: '/api/setup/config', body: { ...fullBody(cfg), ...b } });
  assert.equal(put({ ARCHIVE_DELAY: '30', NTFY_TOKEN: 'tk_new_secret_value' }).status, 200);
  assert.equal(put({ CAM_SIZE: '50G' }).body.error, 'CAM_SIZE can only be changed on the Sentry USB itself');
  assert.equal(put({ SSID: 'OtherNet' }).body.error, 'SSID changed: enter WIFIPASS again to send it there');
  assert.equal(put({ ARCHIVE_DELAY: '2x' }).body.error, 'ARCHIVE_DELAY must be a whole number');
  const log = pi.answer({ method: 'GET', path: '/api/logs/setup' }).body;
  assert.match(log, /Setup config: ARCHIVE_DELAY changed 20 → 30 \(from Sentry Manager\)/);
  assert.ok(!log.includes('tk_new_secret_value'), 'a secret value is never logged');
  pi.close();
});

test('a shut down stand-in comes back by itself in the demo', { skip }, async () => {
  const { createDemoSentryUsb } = require('../demo/sentryUsb/standIn');
  const pi = createDemoSentryUsb({ dir: await tmp(), shutdownBackMs: 200 });
  const events = [];
  pi.on((e) => events.push(e.t));
  assert.equal(pi.answer({ method: 'POST', path: '/api/system/shutdown' }).status, 200);
  await until(() => events.includes('drop'), 3000);
  assert.ok(pi.down);
  await until(() => events.includes('up'), 3000);
  assert.equal(pi.down, null);
  pi.close();
});

test('the launcher pairs the stand-in through the manager\'s pairing slot; it then answers over the link', { skip, timeout: 60_000 }, async () => {
  const { TlsManager } = require(path.join(MANAGER, 'server', 'tls'));
  const L = require(path.join(MANAGER, 'server', 'sentryUsbLink'));
  const { startStandIn } = require('../demo/sentryUsb/launcher');
  const dir = await tmp();
  const t = new TlsManager({ dir: path.join(dir, 'tls'), log: quiet, hostnames: ['127.0.0.1'] });
  await t.ensure();
  const link = L.createSentryUsbLink({ db: memDb(), log: quiet });
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'tls', 'server.key')), cert: fs.readFileSync(path.join(dir, 'tls', 'server.crt')) }, (q, s) => s.end());
  srv.on('upgrade', (q, s, h) => link.handleUpgrade(q, s, h));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const calls = [];
  // the manager's POST /api/sentryusb/pair, as the layer calls it on localhost
  const api = async (method, p, body) => {
    calls.push(`${method} ${p}`);
    return { pairing: await link.openPairing({ ...body, by: 'demo' }).then(() => link.pairing({ codeFor: 'demo' })) };
  };
  const logs = [];
  const s = startStandIn({ api, port: srv.address().port, stateDir: path.join(dir, 'pi'), app: MANAGER, log: (m) => logs.push(m) });
  try {
    assert.match(s.id, /^[0-9a-f]{32}$/);
    await until(() => link.devices()[0]?.online && link.devices()[0]?.status);
    const d = link.devices()[0];
    assert.equal(d.id, s.id, 'the id the gate allows is the one that paired');
    assert.equal(d.name, 'Demo Model Y');
    assert.equal(d.status.sbc_model, 'Raspberry Pi 5 Model B Rev 1.0');
    assert.deepEqual(calls, ['POST /api/sentryusb/pair']);
    await until(() => s.paired);
    assert.equal((await link.request(d.id, { method: 'POST', path: '/api/system/trigger-sync' })).status, 200);
    await until(() => link.devices()[0].status.archiving === true);
    const cfg = (await link.request(d.id, { method: 'GET', path: '/api/setup/config' })).body;
    assert.equal(cfg.SENTRYUSB_HOSTNAME.value, 'sentryusb-modely');
  } finally {
    s.stop();
    link.close();
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});
