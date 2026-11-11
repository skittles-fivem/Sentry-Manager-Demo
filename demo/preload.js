'use strict';

// Demo mode for Sentry Six Manager, loaded into the app with
// NODE_OPTIONS=--require=/demo/preload.js. It changes nothing in the app's
// files: it signs every visitor in as "demo", puts a gate in front of the
// app's request handler (demo/policy.js), starts each run from a fresh copy of
// the demo footage, and adds the vehicle and its first scan through the app's
// own API. The app restarts itself every DEMO_RESET_HOURS (the supervisor
// starts it again), so whatever visitors left behind is gone.

// Only the web app: the supervisor and ffmpeg children load this too.
if (!/server[\\/]index\.js$/.test(process.argv[1] || '')) return;

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const http2 = require('http2');
const { decide, standIn } = require('./policy');
const { seed } = require('./seed');
const { createStore } = require('./store');
const { createImporter } = require('./importer');

// The owner's secrets are read once and taken out of the environment before
// the app starts, so neither the app nor anything it starts ever sees them.
const OWNER_PASSWORD = process.env.DEMO_OWNER_PASSWORD || '';
const FEEDBACK_WEBHOOK = process.env.DEMO_FEEDBACK_WEBHOOK || '';
delete process.env.DEMO_OWNER_PASSWORD;
delete process.env.DEMO_FEEDBACK_WEBHOOK;

const APP = process.env.APP_ROOT || '/app';
const DATA = process.env.DATA_PATH || '/data';
let FOOTAGE = process.env.FOOTAGE_ROOT || '/footage';
const RESET_HOURS = Number(process.env.DEMO_RESET_HOURS || 24);
const on = (v, dflt) => !/^(off|false|0|no)$/i.test(String(v ?? dflt));
const DEMO_USER = 'demo';
// requests the demo itself makes to set things up (loopback only)
const INTERNAL = crypto.randomBytes(24).toString('hex');
process.env.DEMO_INTERNAL_TOKEN = INTERNAL;

const say = (m) => process.stdout.write(`[demo] ${m}\n`);

// ---- what survives the resets (demo/store.js): the attack log, bans, the
// owner page, feedback limits, the imported seed and the certificates
const store = createStore({ log: say });
if (!store.writable) say(`${store.dir} is not writable: the attack log, bans, imported footage and certificates are not kept across resets (docker-compose.yml mounts it)`);
process.on('exit', () => store.flush());
const importer = store.writable ? createImporter({ stateDir: store.dir, log: say }) : null;
// the owner's imported footage when published (demo/importer.js), else the built-in seed
// The owner's prepared folder at /demo-import, used as it is: built into the
// seed before anything starts, so the first page already shows it
// (DEMO_IMPORT=off: never). It is checked again every 10 minutes (below).
if (importer && on(process.env.DEMO_IMPORT, 'auto')) {
  try { importer.autoImport({ name: process.env.DEMO_CAR_NAME || 'Demo Model Y' }); } catch (err) { say(`could not use /demo-import: ${err.message}`); }
}
// Only the owner's footage is shown; the image's test drives only with
// DEMO_BUILTIN_FOOTAGE=on (else no footage until /demo-import has some).
const SEED = importer?.activeSeed() || (on(process.env.DEMO_BUILTIN_FOOTAGE, 'off') ? process.env.DEMO_SEED || '/demo/seed' : path.join(__dirname, 'no-footage'));
if (!importer?.activeSeed()) say('no footage of yours yet: mount your prepared folder at /demo-import (docker-compose.yml)');
// The owner's footage can be far larger than the in-memory /footage (it counts
// against the container's memory): the app then reads it from the kept
// volume, as links to the published seed (no second copy), still fresh at
// every start.
if (importer && SEED === importer.activeSeed()) {
  FOOTAGE = path.join(store.dir, 'live-footage');
  process.env.FOOTAGE_ROOT = FOOTAGE;
}

// ---- a fresh start: no accounts, settings or footage from the last run.
// Only folders the demo made itself are ever emptied (they carry a marker):
// a real data or footage folder mounted here by mistake is left alone, and
// the demo does not start.
const MARK = '.sentry-manager-demo';
function emptyDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const names = fs.readdirSync(dir);
  if (names.length && !names.includes(MARK)) {
    process.stderr.write(`[demo] ${dir} has files the demo did not put there. The demo empties this folder at every start, so it will not run on it. Give it an empty folder (or none) instead.\n`);
    process.exit(78);
  }
  for (const name of names) {
    if (name === MARK) continue;
    const p = path.join(dir, name);
    // a link (the kept TLS folder) goes, never what it points to
    if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
    else fs.rmSync(p, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(dir, MARK), 'Sentry Six Manager demo: everything here is replaced at every start.\n');
}
emptyDir(DATA);
emptyDir(FOOTAGE);
// The manager keeps its certificates in <data>/tls (Let's Encrypt's too, with
// TLS_ACME_DOMAIN). /data starts over at every reset, and Let's Encrypt has
// rate limits, so that folder is a link into the kept state.
if (store.writable && on(process.env.DEMO_KEEP_TLS, 'on')) {
  try {
    const kept = store.path('tls');
    fs.mkdirSync(kept, { recursive: true, mode: 0o700 });
    fs.symlinkSync(kept, path.join(DATA, 'tls'), 'dir');
  } catch (err) {
    say(`certificates not kept across resets: ${err.code || err.message}`);
  }
}
/** A folder's files as hard links (same disk: no extra space), else copies. */
function linkOrCopy(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) linkOrCopy(a, b);
    else if (e.isFile()) { try { fs.linkSync(a, b); } catch { fs.copyFileSync(a, b); } }
  }
}
const seedFootage = path.join(SEED, 'footage');
if (fs.existsSync(seedFootage)) {
  for (const car of fs.readdirSync(seedFootage, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    linkOrCopy(path.join(seedFootage, car.name), path.join(FOOTAGE, car.name));
  }
  say(`footage copied from ${seedFootage}`);
} else say(`no footage in ${seedFootage}`);

// ---- "Swap to Horizon UI", per browser (demo/uiSwap.js): the app's packs
// answer Horizon inside a request from a browser with the demo's cookie
const uiSwap = require('./uiSwap');
try {
  uiSwap.install(APP);
} catch (err) {
  say(`Swap to Horizon UI is off: ${err.code || err.message}`);
}

// ---- everyone is the demo account
const { Auth } = require(path.join(APP, 'server/auth.js'));
const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const internalReq = (req) => req.headers['x-demo-internal'] === INTERNAL && isLoopback(req.socket?.remoteAddress);
Auth.prototype.user = function user() { return DEMO_USER; };
Auth.prototype.needsSetup = function needsSetup() { return false; };
// The demo's own set-up calls count as "password just confirmed"; so do the
// changes visitors may make to the stand-in Sentry USB (demo/policy.js: the
// app asks for a confirmed password before a settings save or a setup run).
const standInReqs = new WeakSet();
Auth.prototype.recentlyConfirmed = function recentlyConfirmed(req) { return Boolean(req && (internalReq(req) || standInReqs.has(req))); };
// no setup code in the log: there is nothing to sign in to
Auth.prototype.bootstrap = function bootstrap() {};

// The demo's cars are folders on the container's own disk, which the app
// rightly warns about at home ("Nothing is mounted..."). Here that is the
// point, so the warning is left out.
const { ShareManager } = require(path.join(APP, 'server/share.js'));
const checkHealth = ShareManager.prototype.checkHealth;
ShareManager.prototype.checkHealth = async function demoCheckHealth(...args) {
  const out = await checkHealth.apply(this, args);
  if (this.mode === 'local' && /^Nothing is mounted at /.test(this.state?.warning || '')) this.state.warning = null;
  return out;
};

// ---- the gate
const BANNER_JS = fs.readFileSync(path.join(__dirname, 'banner.js'));
const BANNER_CSS = fs.readFileSync(path.join(__dirname, 'banner.css'));
const json = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
};
const asset = (res, type, buf) => {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
};

// at most this many exports waiting or rendering, for everyone together
const EXPORT_QUEUE = Number(process.env.DEMO_EXPORT_QUEUE || 2);
let listenPort = null;
const exportsBusy = async () => {
  try {
    const { list } = require('./internalClient');
    const out = await list(listenPort, INTERNAL, '/api/exports');
    return (out?.exports || []).filter((x) => ['waiting', 'running'].includes(x.state)).length >= EXPORT_QUEUE;
  } catch {
    return false;
  }
};

/** Add the banner to the app's page (the response is held and rewritten). */
function withBanner(req, res, handler) {
  delete req.headers['accept-encoding'];
  const chunks = [];
  let head = null;
  const { writeHead, write, end, setHeader } = res;
  const headers = {};
  res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; return res; };
  res.writeHead = (status, a, b) => {
    const h = typeof a === 'object' && a ? a : (b || {});
    for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    head = status;
    return res;
  };
  res.write = (c) => { if (c) chunks.push(Buffer.from(c)); return true; };
  res.end = (c, ...rest) => {
    if (c && typeof c !== 'function') chunks.push(Buffer.from(c));
    let body = Buffer.concat(chunks);
    if (/text\/html/.test(String(headers['content-type'] || '')) && !headers['content-encoding']) {
      const html = body.toString('utf8');
      if (html.includes('id="app"') && html.includes('</head>')) {
        const ui = uiSwap.uiOf(req) || 'original';
        body = Buffer.from(html.replace('</head>', `  <link rel="stylesheet" href="/demo/banner.css">\n  <script src="/demo/device.js" defer></script>\n  <script src="/demo/banner.js" data-ui="${ui}" defer></script>\n</head>`));
      }
    }
    delete headers['content-length'];
    // the real methods back first: HTTP/2's end() calls writeHead() itself
    res.writeHead = writeHead;
    res.write = write;
    res.end = end;
    res.setHeader = setHeader;
    for (const [k, v] of Object.entries(headers)) setHeader.call(res, k, v);
    setHeader.call(res, 'content-length', body.length);
    writeHead.call(res, head || res.statusCode || 200);
    if (req.method === 'HEAD') return end.call(res);
    return end.call(res, body, ...rest);
  };
  return handler(req, res);
}

// ---- the pretend conversion with nodes (demo/fakeEncoder.js)
const { createFakeEncoder } = require('./fakeEncoder');
const { call } = require('./internalClient');
const FAKE_ENCODER = String(process.env.DEMO_FAKE_ENCODER || 'on').toLowerCase() !== 'off';
let fake = null;
const realJson = (pathAndQuery) => call(listenPort, INTERNAL, 'GET', pathAndQuery);
async function fakeAnswer(req, res, p, url) {
  const m = req.method;
  if (m === 'GET' && p === '/api/converter/events') { fake.attach(req, res); return true; }
  if (m === 'POST' && p === '/api/converter/invoke/getCurrent') { req.resume(); json(res, 200, fake.current()); return true; }
  if (m === 'POST' && p === '/api/converter/invoke/devices') { req.resume(); json(res, 200, fake.devices()); return true; }
  if (m === 'POST' && /^\/api\/converter\/invoke\/(subscribeProgress|unsubscribeProgress)$/.test(p)) { req.resume(); json(res, 200, { ok: true, value: null }); return true; }
  try {
    if (m === 'GET' && p === '/api/stats') { json(res, 200, fake.patchStats(await realJson(`${p}${url.search}`))); return true; }
    if (m === 'GET' && p === '/api/jobs') { json(res, 200, fake.patchJobs(await realJson(`${p}${url.search}`))); return true; }
    if (m === 'GET' && p === '/api/nodes') { json(res, 200, fake.nodesOverview((await realJson(p))?.worker || null)); return true; }
  } catch (err) {
    say(`pretend answer for ${p}: ${err.message}`);
  }
  return false;
}

// ---- who is asking (Cloudflare-aware), the attack log, bans and rate limits,
// the owner page and feedback: all the layer's own (demo/*.js), kept in the
// demo's state so a reset does not clear them
const { fromEnv, readGateways } = require('./clientAddress');
const { createAttackLog } = require('./attackLog');
const { createRateLimits, createBans } = require('./rateLimit');
const { createOwnerPage, readJson } = require('./owner');
const { createFeedback } = require('./feedback');
const who = fromEnv();
const attackLog = createAttackLog({ store, addressOf: who.of });
const bans = createBans({ store });
const limits = createRateLimits({
  // every request of one address (the Viewer asks for a lot: generous)
  any: [Number(process.env.DEMO_RATE_PER_MINUTE || 3000), 60_000],
  // changes to the stand-in Sentry USB
  standIn: [20, 60_000],
  // the owner password
  owner: [10, 15 * 60_000]
});
let standInRun = null; // demo/sentryUsb/launcher.js, once the demo is set up
const reset = (why) => {
  say(`reset: ${why}, starting over with fresh demo data`);
  store.flush();
  process.exit(0);
};
const feedback = createFeedback({ webhook: FEEDBACK_WEBHOOK, store, attackLog, addressOf: who.of, log: say });
const owner = createOwnerPage({
  password: OWNER_PASSWORD, store, attackLog, bans, limits, addressOf: who.of,
  net: { proxy: who.proxy, listedProxies: who.listedProxies, gateways: readGateways() }, importer,
  tlsDir: path.join(DATA, 'tls'), reset: () => reset('Reset now on the owner page'), resetHours: RESET_HOURS,
  standIn: () => (standInRun ? { name: 'Demo Model Y', paired: standInRun.paired } : null), feedbackOn: feedback.enabled, log: say
});
if (owner.enabled) say('owner page on at /owner (local network only)');
if (feedback.enabled) say('feedback on (Discord)');
const FEEDBACK_FILES = {
  '/demo/feedback': ['feedback.html', 'text/html; charset=utf-8'],
  '/demo/feedback.js': ['feedback.js', 'text/javascript; charset=utf-8'],
  '/demo/feedback.css': ['feedback.css', 'text/css; charset=utf-8'],
  '/demo/device.js': ['device.js', 'text/javascript; charset=utf-8']
};
const { send: sendLayer } = require('./owner');
const ACME = '/.well-known/acme-challenge/';

/** The layer's own checks before the app: bans, rate limits, the owner page, feedback. true when answered. */
async function layerFirst(req, res, p, url) {
  if (p.startsWith(ACME)) return false; // Let's Encrypt's check: always the app's
  const ip = who.of(req);
  attackLog.seen(req);
  attackLog.inspect(req);
  if (bans.banned(ip)) {
    attackLog.note('ban', req, `refused while banned: ${req.method} ${String(req.url).slice(0, 120)}`);
    req.resume();
    sendLayer(res, 403, p.startsWith('/api/') ? { error: 'This address is blocked.' } : 'This address is blocked.\n', p.startsWith('/api/') ? {} : { 'Content-Type': 'text/plain; charset=utf-8' });
    return true;
  }
  const lim = limits.take('any', ip);
  if (lim.wait) {
    if (lim.first) attackLog.note('rate-limit', req, `over ${limits.limits.any[0]} requests a minute`);
    req.resume();
    sendLayer(res, 429, { error: `Too many requests. Try again in ${lim.wait} s.` }, { 'Retry-After': String(lim.wait) });
    return true;
  }
  if (await owner.handle(req, res, p, url)) return true;
  // plain HTTP: the app's own redirect to https:// (and Let's Encrypt's check)
  if (!(req.socket?.encrypted || req.httpVersionMajor === 2)) return false;
  // this browser's interface: Horizon or the original (a cookie; never the app's choice for everyone)
  if (p === '/demo/ui') {
    if (req.method !== 'POST' || req.headers['x-requested-with'] !== 'sentry-six-manager') {
      req.resume();
      sendLayer(res, req.method === 'POST' ? 403 : 405, { error: 'POST {"ui": "horizon" | "original"}' });
      return true;
    }
    let body = null;
    try { body = await readJson(req, 1024); } catch { body = null; }
    const out = uiSwap.choose(body, { secure: true });
    sendLayer(res, out.status, out.body, out.cookie ? { 'Set-Cookie': out.cookie } : {});
    return true;
  }
  const f = FEEDBACK_FILES[p];
  if (f && (req.method === 'GET' || req.method === 'HEAD')) {
    sendLayer(res, 200, fs.readFileSync(path.join(__dirname, 'feedback', f[0])), { 'Content-Type': f[1], 'Cache-Control': 'no-cache' });
    return true;
  }
  if (p === '/api/demo/feedback') {
    if (req.method === 'GET') {
      sendLayer(res, 200, feedback.enabled ? { enabled: true, token: feedback.token() } : { enabled: false });
      return true;
    }
    if (req.method === 'POST' && req.headers['x-requested-with'] === 'sentry-six-manager') {
      let fields = null;
      try { fields = await readJson(req, 16 * 1024); } catch { fields = null; }
      if (fields) attackLog.inspectFields(req, { contact: fields.contact, page: fields.page });
      const out = await feedback.submit(req, fields);
      sendLayer(res, out.status, out.body);
      return true;
    }
    req.resume();
    sendLayer(res, 405, { ok: false, message: "Couldn't send, try again later" });
    return true;
  }
  return false;
}

function gate(handler) {
  const inner = gateInner(handler);
  // each request knows which interface its browser asked for (demo/uiSwap.js)
  return function demoGate(req, res) { return uiSwap.runFor(req, () => inner(req, res)); };
}

function gateInner(handler) {
  return async function demoGateInner(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      if (!internalReq(req)) attackLog.note('malformed', req, String(req.url || '').slice(0, 160));
      return handler(req, res);
    }
    const p = url.pathname;
    if (!internalReq(req) && await layerFirst(req, res, p, url)) return undefined;
    if (p === '/demo/banner.js') return asset(res, 'text/javascript; charset=utf-8', BANNER_JS);
    if (p === '/demo/banner.css') return asset(res, 'text/css; charset=utf-8', BANNER_CSS);
    // nothing to sign in to
    if (p === '/login' || p === '/login/code') {
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
      return res.end();
    }
    // the pretend conversion and nodes (demo/fakeEncoder.js) answer these
    if (fake && !internalReq(req)) {
      const answered = await fakeAnswer(req, res, p, url);
      if (answered) return undefined;
    }
    if (p.startsWith('/api/') && !internalReq(req)) {
      // the CAN Bridge's upload API takes its own token: never on the demo
      if (p === '/api/can/logs' || p.startsWith('/api/can/logs/')) return json(res, 404, { error: 'Not found' });
      const v = decide(req.method, p, { standInId: standInRun?.id || null });
      if (!v.ok && v.hidden) return json(res, 200, standIn(p));
      if (!v.ok && v.quiet) {
        req.resume();
        return json(res, 200, { ok: true });
      }
      if (!v.ok) {
        attackLog.note('refused', req, `${req.method} ${p}`);
        req.resume();
        return json(res, v.status, { error: v.error, code: 'DEMO' });
      }
      if (v.standIn) {
        // the stand-in Pi's changes: allowed, at a visitor's pace
        const lim = limits.take('standIn', who.of(req));
        if (lim.wait) {
          if (lim.first) attackLog.note('rate-limit', req, `stand-in Sentry USB: ${req.method} ${p}`);
          req.resume();
          return json(res, 429, { error: `Slow down a little: try again in ${lim.wait} s.`, code: 'DEMO_BUSY' });
        }
        standInReqs.add(req);
      }
      if (v.export && await exportsBusy()) return json(res, 429, { error: 'The demo is already making exports for other visitors. Try again in a few minutes.', code: 'DEMO_BUSY' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/' || p === '/index.html') return withBanner(req, res, handler);
    }
    return handler(req, res);
  };
}

// The app makes its servers with these; the gate goes in front of each.
const origHttp = http.createServer;
http.createServer = function createServer(...args) {
  const i = args.findIndex((a) => typeof a === 'function');
  if (i !== -1) args[i] = gate(args[i]);
  return origHttp.apply(this, args);
};
const origH2 = http2.createSecureServer;
http2.createSecureServer = function createSecureServer(...args) {
  const i = args.findIndex((a) => typeof a === 'function');
  if (i !== -1) args[i] = gate(args[i]);
  return origH2.apply(this, args);
};

// the CAN port (when the seed turns uploads on for a moment) uses https
const https = require('https');
const origHttps = https.createServer;
https.createServer = function createServer(...args) {
  const i = args.findIndex((a) => typeof a === 'function');
  if (i !== -1) args[i] = gate(args[i]);
  return origHttps.apply(this, args);
};

// Set up once the web port answers (the app serves HTTP and HTTPS on one
// port through its own front socket, so its servers never "listen" themselves).
listenPort = Number(process.env.PORT || 9000);
const net = require('net');
const waitForPort = () => new Promise((resolve) => {
  const tryOnce = () => {
    const s = net.connect({ host: '127.0.0.1', port: listenPort }, () => { s.destroy(); resolve(); });
    s.on('error', () => setTimeout(tryOnce, 1000));
  };
  tryOnce();
});
waitForPort().then(() => seed({ port: listenPort, token: INTERNAL, seedDir: SEED, footage: FOOTAGE, log: say }))
  .then((cars) => {
    const car = cars?.[0];
    if (FAKE_ENCODER && car) {
      fake = createFakeEncoder({ sourceRoot: car.studioRoot || path.join(FOOTAGE, car.id, 'TeslaCam'), vehicleId: car.id, vehicleName: car.name });
      say('pretend conversion on this server and two nodes started');
    }
    // the stand-in Sentry USB, paired through the app's API (demo/sentryUsb/)
    if (on(process.env.DEMO_SENTRYUSB, 'on')) {
      const { startStandIn } = require('./sentryUsb/launcher');
      standInRun = startStandIn({
        api: (method, p, body) => call(listenPort, INTERNAL, method, p, body), port: Number(process.env.CAN_PORT || 10000),
        stateDir: path.join(DATA, 'demo-sentryusb'), app: APP, log: say
      });
    }
    say('ready');
    // the owner's prepared folder at /demo-import: the demo builds itself from
    // it, now and whenever it changes (DEMO_IMPORT=off: never)
    if (importer && on(process.env.DEMO_IMPORT, 'auto')) {
      const check = () => importer.autoImport({ name: process.env.DEMO_CAR_NAME || 'Demo Model Y' })
        .then((fresh) => { if (fresh) reset('your footage folder was built into the demo'); })
        .catch((err) => say(`building the demo from /demo-import failed: ${err.message}`));
      check();
      setInterval(check, 10 * 60_000).unref();
    }
  })
  .catch((err) => say(`setting up the demo failed: ${err.stack || err.message}`));

// ---- start over every so often (the supervisor starts the app again)
if (RESET_HOURS > 0) {
  const t = setTimeout(() => reset(`${RESET_HOURS} h are up`), RESET_HOURS * 3600 * 1000);
  t.unref();
}
say(`demo mode on (reset every ${RESET_HOURS} h)`);
