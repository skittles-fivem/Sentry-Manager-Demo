'use strict';

// The demo's own calls to the app's API, over loopback, with the token that
// lets them past the gate (demo/preload.js). TLS: the app's certificate is
// its own, and this never leaves the container, so it is not checked.

const http = require('http');
const https = require('https');

let useTls = null;

function call(port, token, method, path, body, { raw = null, headers = {} } = {}) {
  const payload = raw ?? (body === undefined ? null : Buffer.from(JSON.stringify(body)));
  const attempt = (tls) => new Promise((resolve, reject) => {
    const lib = tls ? https : http;
    const req = lib.request({
      host: '127.0.0.1', port, method, path,
      rejectUnauthorized: false,
      headers: {
        Host: 'localhost',
        'X-Demo-Internal': token,
        'X-Requested-With': 'sentry-six-manager',
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': raw ? 'application/octet-stream' : 'application/json', 'Content-Length': payload.length } : {}),
        ...headers
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        // plain HTTP on the TLS port is answered with a redirect: try TLS
        if (!tls && (res.statusCode === 308 || res.statusCode === 301)) return reject(Object.assign(new Error('redirect'), { redirect: true }));
        let data = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        if (res.statusCode >= 400) return reject(Object.assign(new Error(`${method} ${path}: ${res.statusCode} ${data?.error || text.slice(0, 200)}`), { status: res.statusCode, data }));
        resolve(data);
      });
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error(`${method} ${path}: timed out`)));
    if (payload) req.write(payload);
    req.end();
  });
  if (useTls !== null) return attempt(useTls);
  return attempt(true).then((x) => { useTls = true; return x; }, (err) => {
    if (err.status) { useTls = true; throw err; }
    return attempt(false).then((x) => { useTls = false; return x; });
  });
}

const list = (port, token, path) => call(port, token, 'GET', path);

module.exports = { call, list, setTls: (v) => { useTls = v; } };
