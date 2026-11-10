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

const APP = process.env.APP_ROOT || '/app';
const DATA = process.env.DATA_PATH || '/data';
const FOOTAGE = process.env.FOOTAGE_ROOT || '/footage';
const SEED = process.env.DEMO_SEED || '/demo/seed';
const RESET_HOURS = Number(process.env.DEMO_RESET_HOURS || 24);
const DEMO_USER = 'demo';
// requests the demo itself makes to set things up (loopback only)
const INTERNAL = crypto.randomBytes(24).toString('hex');
process.env.DEMO_INTERNAL_TOKEN = INTERNAL;

const say = (m) => process.stdout.write(`[demo] ${m}\n`);

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
  for (const name of names) if (name !== MARK) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, MARK), 'Sentry Six Manager demo: everything here is replaced at every start.\n');
}
emptyDir(DATA);
emptyDir(FOOTAGE);
const seedFootage = path.join(SEED, 'footage');
if (fs.existsSync(seedFootage)) {
  for (const car of fs.readdirSync(seedFootage, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    fs.cpSync(path.join(seedFootage, car.name), path.join(FOOTAGE, car.name), { recursive: true });
  }
  say(`footage copied from ${seedFootage}`);
} else say(`no footage in ${seedFootage}`);

// ---- everyone is the demo account
const { Auth } = require(path.join(APP, 'server/auth.js'));
const isLoopback = (a) => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
const internalReq = (req) => req.headers['x-demo-internal'] === INTERNAL && isLoopback(req.socket?.remoteAddress);
Auth.prototype.user = function user() { return DEMO_USER; };
Auth.prototype.needsSetup = function needsSetup() { return false; };
// the demo's own set-up calls count as "password just confirmed"; visitors never do
Auth.prototype.recentlyConfirmed = function recentlyConfirmed(req) { return Boolean(req && internalReq(req)); };
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
        body = Buffer.from(html.replace('</head>', '  <link rel="stylesheet" href="/demo/banner.css">\n  <script src="/demo/banner.js" defer></script>\n</head>'));
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

function gate(handler) {
  return async function demoGate(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return handler(req, res);
    }
    const p = url.pathname;
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
      const v = decide(req.method, p);
      if (!v.ok && v.hidden) return json(res, 200, standIn(p));
      if (!v.ok && v.quiet) {
        req.resume();
        return json(res, 200, { ok: true });
      }
      if (!v.ok) return json(res, v.status, { error: v.error, code: 'DEMO' });
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
    say('ready');
  })
  .catch((err) => say(`setting up the demo failed: ${err.stack || err.message}`));

// ---- start over every so often (the supervisor starts the app again)
if (RESET_HOURS > 0) {
  const t = setTimeout(() => {
    say(`reset: ${RESET_HOURS} h are up, starting over with fresh demo data`);
    process.exit(0);
  }, RESET_HOURS * 3600 * 1000);
  t.unref();
}
say(`demo mode on (reset every ${RESET_HOURS} h)`);
