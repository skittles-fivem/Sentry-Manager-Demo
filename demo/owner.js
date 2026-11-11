'use strict';

// The demo's owner page: /owner and /api/owner/*, part of the demo layer
// (the manager knows nothing of it). It shows the attack log
// (demo/attackLog.js), visitor counts and activity (demo/visitors.js), bans, a Reset now button, the
// certificate, and the footage import (demo/importer.js).
//
// It exists only when DEMO_OWNER_PASSWORD is set (else /owner is passed to
// the app like any unknown path), and opens only:
// - from a private, LAN or loopback address (the real client address,
//   demo/clientAddress.js). A request through Cloudflare is public, and so is
//   the container's default gateway: Docker's proxy makes visitors from
//   outside look like it. Anyone else is sent to / with an ordinary 302, and
//   the attempt is noted as 'owner-probe';
// - over HTTPS (plain HTTP is sent to https://);
// - with the password (constant-time, rate-limited), which gives a session
//   cookie for /owner and /api/owner only (HttpOnly, Secure, SameSite=Strict).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeIp, isOwnerLocal, ownerLocal } = require('./clientAddress');

const COOKIE = 'sm_demo_owner';
const SESSION_MS = 8 * 3600_000;
const STATIC = { '/owner': ['owner.html', 'text/html; charset=utf-8'], '/owner/': ['owner.html', 'text/html; charset=utf-8'], '/owner/owner.js': ['owner.js', 'text/javascript; charset=utf-8'], '/owner/owner.css': ['owner.css', 'text/css; charset=utf-8'] };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

const isOwnerPath = (p) => p === '/owner' || p.startsWith('/owner/') || p === '/api/owner' || p.startsWith('/api/owner/');

function send(res, status, body, headers = {}) {
  const data = Buffer.from(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': data.length,
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP, ...headers
  });
  res.end(data);
}

/** A request body, at most `max` bytes (else 413). */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { reject(Object.assign(new Error('Too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, max = 64 * 1024) {
  const buf = await readBody(req, max);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Not JSON.'), { status: 400 });
  }
}

/** The certificate the manager serves (its TLS folder), and Let's Encrypt's state. */
function certificateStatus(tlsDir) {
  const out = { dir: tlsDir, kept: false };
  try {
    out.kept = fs.lstatSync(tlsDir).isSymbolicLink();
  } catch { /* none yet */ }
  for (const [name, source] of [['acme.crt', "Let's Encrypt"], ['server.crt', 'self-signed (the manager\'s own CA)']]) {
    try {
      const c = new crypto.X509Certificate(fs.readFileSync(path.join(tlsDir, name)));
      Object.assign(out, {
        source, issuer: c.issuer.split('\n').join(', '), validTo: c.validTo, expiresAt: Date.parse(c.validTo), fingerprint: c.fingerprint256,
        names: String(c.subjectAltName || '').split(',').map((s) => s.trim().replace(/^(DNS|IP Address):/, '')).filter(Boolean)
      });
      break;
    } catch { /* not this one */ }
  }
  try {
    const s = JSON.parse(fs.readFileSync(path.join(tlsDir, 'acme-state.json'), 'utf8'));
    out.acme = { domains: s.domains || null, issuedAt: s.issuedAt || null, failures: s.failures || 0, lastError: s.lastError || null, nextAttemptAt: s.nextAttemptAt || null };
  } catch { /* no Let's Encrypt */ }
  out.acmeDomain = process.env.TLS_ACME_DOMAIN || null;
  return out;
}

/**
 * o: password, store, attackLog, bans, limits (demo/rateLimit.js: 'owner'),
 * addressOf, net ({ proxy, listedProxies, gateways }), importer, tlsDir,
 * reset() (the demo starts over), resetHours, stateKept, standIn() (its
 * state), visitors (demo/visitors.js), log, now, webDir (the page's files).
 */
function createOwnerPage({
  password = '', store, attackLog, bans, limits, addressOf, net = {}, importer = null, tlsDir = '/data/tls', reset = null, resetHours = 24,
  standIn = () => null, feedbackOn = false, visitors = null, log = () => {}, now = () => Date.now(), webDir = path.join(__dirname, 'owner')
}) {
  const enabled = typeof password === 'string' && password.length > 0;
  const want = enabled ? crypto.createHash('sha256').update(password).digest() : null;
  const doc = store.load('owner', null) || {};
  doc.sessions = doc.sessions && typeof doc.sessions === 'object' ? doc.sessions : {}; // sha256(token) -> expires
  const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');
  const local = (req) => ownerLocal(req, net);
  const secure = (req) => Boolean(req.socket?.encrypted || req.stream?.session?.socket?.encrypted || req.httpVersionMajor === 2);

  const tokenOf = (req) => /(?:^|;\s*)sm_demo_owner=([A-Za-z0-9_-]{30,80})/.exec(String(req.headers.cookie || ''))?.[1] || null;
  function signedIn(req) {
    const t = tokenOf(req);
    if (!t) return false;
    const exp = doc.sessions[hash(t)];
    if (!exp || exp <= now()) { delete doc.sessions[hash(t)]; return false; }
    return true;
  }
  const cookies = (value, maxAge) => ['/owner', '/api/owner'].map((p) => `${COOKIE}=${value}; Path=${p}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`);
  const filters = (url) => ({ kind: String(url.searchParams.get('kind') || '').slice(0, 24), address: String(url.searchParams.get('address') || '').slice(0, 80), sort: url.searchParams.get('sort') === 'active' ? 'active' : 'newest' });

  /** Handles an owner path; false for any other path (or no owner page). */
  async function handle(req, res, p, url) {
    if (!enabled || !isOwnerPath(p)) return false;
    if (!local(req)) {
      attackLog?.note('owner-probe', req, `${req.method} ${req.url}`);
      req.resume();
      res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store', 'Content-Length': 0 });
      res.end();
      return true;
    }
    if (!secure(req)) {
      // the password never goes over plain HTTP
      req.resume();
      const host = String(req.headers.host || 'localhost').replace(/[^A-Za-z0-9.:[\]-]/g, '').slice(0, 255) || 'localhost';
      res.writeHead(308, { Location: `https://${host}${p}`, 'Cache-Control': 'no-store', 'Content-Length': 0 });
      res.end();
      return true;
    }
    try {
      if (!p.startsWith('/api/')) {
        const f = STATIC[p];
        if (!f || req.method !== 'GET') { send(res, 404, { error: 'Not found' }); return true; }
        send(res, 200, fs.readFileSync(path.join(webDir, f[0])), { 'Content-Type': f[1] });
        return true;
      }
      const m = req.method;
      if (m !== 'GET' && req.headers['x-requested-with'] !== 'sentry-six-manager') throw Object.assign(new Error('Missing X-Requested-With header.'), { status: 403 });
      if (p === '/api/owner/login' && m === 'POST') {
        const ip = addressOf(req);
        const lim = limits.take('owner', ip);
        if (lim.wait) {
          if (lim.first) attackLog?.note('rate-limit', req, 'owner password');
          throw Object.assign(new Error(`Too many attempts. Try again in ${lim.wait} s.`), { status: 429 });
        }
        const body = await readJson(req, 4096);
        const given = crypto.createHash('sha256').update(String(body?.password ?? '').slice(0, 1024)).digest();
        if (!crypto.timingSafeEqual(given, want)) {
          attackLog?.note('login', req, '(owner password)');
          log(`owner page: wrong password from ${ip}`);
          throw Object.assign(new Error('That password is not right.'), { status: 401 });
        }
        const token = crypto.randomBytes(32).toString('base64url');
        for (const [h, exp] of Object.entries(doc.sessions)) if (exp <= now()) delete doc.sessions[h];
        const keys = Object.keys(doc.sessions);
        if (keys.length >= 20) delete doc.sessions[keys[0]];
        doc.sessions[hash(token)] = now() + SESSION_MS;
        store.save('owner', doc);
        log(`owner page: signed in from ${ip}`);
        send(res, 200, { ok: true }, { 'Set-Cookie': cookies(token, SESSION_MS / 1000) });
        return true;
      }
      if (!signedIn(req)) throw Object.assign(new Error('Enter the owner password.'), { status: 401 });
      if (p === '/api/owner/logout' && m === 'POST') {
        const t = tokenOf(req);
        if (t) { delete doc.sessions[hash(t)]; store.save('owner', doc); }
        send(res, 200, { ok: true }, { 'Set-Cookie': cookies('', 0) });
        return true;
      }
      if (p === '/api/owner/state' && m === 'GET') {
        const st = attackLog.stats();
        send(res, 200, {
          log: attackLog.list(filters(url)), stats: st, visitors: { today: st.visitorsToday, days: st.visitorDays },
          bans: bans.list(), demo: { resetHours, resetAvailable: typeof reset === 'function', stateKept: store.writable, stateDir: store.dir, feedback: feedbackOn, standIn: standIn() },
          tls: certificateStatus(tlsDir), you: addressOf(req)
        });
        return true;
      }
      if (p === '/api/owner/visitors' && m === 'GET') {
        if (!visitors) throw Object.assign(new Error('No visitor activity here.'), { status: 409 });
        send(res, 200, { visitors: visitors.list(), pages: visitors.pages, you: addressOf(req) });
        return true;
      }
      if (p === '/api/owner/visitor' && m === 'GET') {
        const ev = visitors?.events(String(url.searchParams.get('ip') || '').slice(0, 80));
        if (!ev) throw Object.assign(new Error('No such visitor.'), { status: 404 });
        send(res, 200, { events: ev });
        return true;
      }
      if (p === '/api/owner/log.csv' && m === 'GET') {
        send(res, 200, attackLog.csv(filters(url)), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="attack-log-${new Date(now()).toISOString().slice(0, 10)}.csv"` });
        return true;
      }
      if (p === '/api/owner/ban' && m === 'POST') {
        const body = await readJson(req, 4096);
        const ip = normalizeIp(body?.address);
        if (!ip) throw Object.assign(new Error('Not an address.'), { status: 400 });
        if (isOwnerLocal(ip)) throw Object.assign(new Error('A local address is not banned from here.'), { status: 400 });
        const b = bans.ban(ip);
        attackLog.note('ban', ip, 'banned from the owner page');
        log(`owner page: banned ${b.key}`);
        send(res, 200, { ok: true, ban: b });
        return true;
      }
      if (p === '/api/owner/unban' && m === 'POST') {
        const body = await readJson(req, 4096);
        send(res, 200, { ok: bans.unban(String(body?.key || '').slice(0, 80)) });
        return true;
      }
      if (p === '/api/owner/reset' && m === 'POST') {
        if (typeof reset !== 'function') throw Object.assign(new Error('No reset here.'), { status: 409 });
        log('owner page: reset now');
        send(res, 200, { ok: true });
        store.flush();
        setTimeout(reset, 300);
        return true;
      }
      if (p.startsWith('/api/owner/import')) return await handleImport(req, res, p, url);
      send(res, 404, { error: 'Not found' });
      return true;
    } catch (err) {
      if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Internal error', ...(err.have !== undefined ? { have: err.have } : {}) });
      if (!err.status) log(`owner page: ${err.stack || err.message}`);
      return true;
    }
  }

  async function handleImport(req, res, p, url) {
    if (!importer) throw Object.assign(new Error('Footage import needs the /demo-state volume.'), { status: 409 });
    const m = req.method;
    if (p === '/api/owner/import' && m === 'GET') { send(res, 200, importer.status()); return true; }
    if (p === '/api/owner/import/plan' && m === 'POST') { send(res, 200, importer.plan((await readJson(req, 32 * 2 ** 20)).files)); return true; }
    if (p === '/api/owner/import/chunk' && m === 'PUT') {
      const rel = String(url.searchParams.get('path') || '');
      const offset = Number(url.searchParams.get('offset'));
      const size = Number(url.searchParams.get('size'));
      const data = await readBody(req, 8 * 2 ** 20);
      send(res, 200, importer.chunk(rel, offset, size, data));
      return true;
    }
    if (p === '/api/owner/import/process' && m === 'POST') {
      const body = await readJson(req);
      const started = importer.process(body);
      started.catch(() => {});
      send(res, 202, { ok: true, job: importer.job });
      return true;
    }
    if (p === '/api/owner/import/publish' && m === 'POST') { send(res, 200, importer.publish(await readJson(req))); return true; }
    if (p === '/api/owner/import/unpublish' && m === 'POST') { importer.unpublish(); send(res, 200, { ok: true }); return true; }
    if (p === '/api/owner/import/discard' && m === 'POST') { importer.discard((await readJson(req)).what); send(res, 200, { ok: true }); return true; }
    send(res, 404, { error: 'Not found' });
    return true;
  }

  return { enabled, handle, local, isOwnerPath };
}

module.exports = { createOwnerPage, certificateStatus, readBody, readJson, send, isOwnerPath, COOKIE, CSP };
