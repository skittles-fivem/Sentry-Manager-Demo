'use strict';

// The Pi's side of the Sentry USB link (the manager's docs/sentry-usb-link.md,
// protocol v2): TLS to the manager's device port, a WebSocket upgrade, the
// handshake (pair mode with the pairing code, or key mode with the link key
// and the pinned certificate), then answers to the manager's requests.
// Adapted from the manager's test/fixtures/fakeSentryUsb.js (not in its
// image). The protocol's crypto and framing come from the manager itself
// (server/sentryUsbLink.js, server/wsFrames.js), so the stand-in speaks
// exactly the version the running manager does; a manager without the
// Sentry USB link has neither file, and the stand-in stays off (available()).

const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIB = 1024 * 1024;
const APP = () => process.env.APP_ROOT || '/app';
const files = (app) => [path.join(app, 'server', 'sentryUsbLink.js'), path.join(app, 'server', 'wsFrames.js')];

/** Whether this manager has the Sentry USB link (its files are in the image). */
function available(app = APP()) {
  return files(app).every((f) => fs.existsSync(f));
}

function lib(app = APP()) {
  const [linkFile, wsFile] = files(app);
  return { L: require(linkFile), WsConnection: require(wsFile).WsConnection };
}

async function pairSecret(L, username, password, code, iterations) {
  const k = await L.pairingKey(username, password, iterations);
  return L.pairCodeSecret(k, L.normalizePairingCode(code) || String(code ?? ''));
}

/** An answer as the Pi sends it: JSON inline, anything else base64, in 1 MiB chunks when large. */
function sendAnswer(ws, id, a) {
  const buf = a.buf || (a.type !== 'application/json' && typeof a.body === 'string' ? Buffer.from(a.body, 'utf8') : null);
  if (!buf) return ws.send(JSON.stringify({ t: 'res', id, status: a.status, type: a.type, body: a.body }));
  if (buf.length <= MIB) return ws.send(JSON.stringify({ t: 'res', id, status: a.status, type: a.type, bodyB64: buf.toString('base64') }));
  ws.send(JSON.stringify({ t: 'res', id, status: a.status, type: a.type, chunked: true }));
  for (let seq = 0, off = 0; off < buf.length; seq++, off += MIB) ws.send(JSON.stringify({ t: 'chunk', id, seq, data: buf.subarray(off, off + MIB).toString('base64') }));
  return ws.send(JSON.stringify({ t: 'end', id }));
}

/**
 * Connects once. o: host, port, id (32 hex), name, version, mode ('pair' |
 * 'key'), username, password, code (pair), key (hex) and pin (fingerprint
 * hex, key mode), iterations, net (the network frame), answer(m) -> { status,
 * type, body | buf }, onClose(code), app (the manager's folder).
 * Resolves { result: 'ok' | 'denied' | 'refused' | 'closed' | 'pin mismatch' |
 * 'bad manager proof', why, linkKey, fp, ws, send, close }.
 */
function connectPi(o) {
  const { L, WsConnection } = lib(o.app);
  const host = o.host || '127.0.0.1';
  return new Promise((resolve, reject) => {
    // the first connection trusts the certificate and pins it, as the Pi does
    const sock = tls.connect({ host, port: o.port, rejectUnauthorized: false, minVersion: 'TLSv1.2', servername: host === '127.0.0.1' ? undefined : host });
    const out = { result: null, why: null, linkKey: null, fp: null, ws: null };
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    sock.setTimeout(30_000, () => sock.destroy(new Error('timed out')));
    sock.once('error', (err) => { if (!settled) { settled = true; reject(err); } });
    sock.once('secureConnect', () => {
      out.fp = L.fpHex(sock.getPeerCertificate().fingerprint256);
      if (o.mode === 'key' && o.pin && o.pin !== out.fp) { out.result = 'pin mismatch'; sock.destroy(); return done(out); }
      const wsKey = crypto.randomBytes(16).toString('base64');
      sock.write(`GET ${L.LINK_PATH || '/api/sentryusb/link'} HTTP/1.1\r\nHost: ${host}:${o.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      let head = Buffer.alloc(0);
      const onHead = (c) => {
        head = Buffer.concat([head, c]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) {
          if (head.length > 16 * 1024) sock.destroy();
          return;
        }
        sock.off('data', onHead);
        sock.setTimeout(0);
        if (Number(head.subarray(0, end).toString('latin1').split(' ')[1]) !== 101) { out.result = 'refused'; sock.destroy(); return done(out); }
        const ws = new WsConnection(sock, { role: 'client', maxMessage: 4 * MIB, head: head.subarray(end + 4) });
        out.ws = ws;
        out.close = (code = 1000, why = 'bye') => ws.close(code, why);
        out.send = (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
        ws.on('close', (code) => { if (!out.result) { out.result = 'closed'; done(out); } o.onClose?.(code); });
        let secret = null;
        let mNonce = null;
        const piNonce = crypto.randomBytes(32).toString('hex');
        ws.on('message', async (text) => {
          let m;
          try { m = JSON.parse(text); } catch { return undefined; }
          try {
            if (m.t === 'hello') {
              mNonce = m.nonce;
              if (m.v !== L.V) { out.result = 'denied'; out.why = 'version'; ws.send(JSON.stringify({ t: 'denied', why: 'version' })); ws.close(1008, 'denied'); return done(out); }
              secret = o.mode === 'key' ? Buffer.from(o.key, 'hex') : await pairSecret(L, o.username, o.password, o.code, o.iterations);
              return ws.send(JSON.stringify({ t: 'auth', v: L.V, id: o.id, mode: o.mode, nonce: piNonce, name: o.name, version: o.version, proof: L.piProof(secret, mNonce, piNonce, out.fp, o.id) }));
            }
            if (m.t === 'denied') { out.result = 'denied'; out.why = m.why; return done(out); }
            if (m.t === 'ok') {
              if (!L.sameHex(m.proof, L.managerProof(secret, mNonce, piNonce, out.fp, o.id))) { out.result = 'bad manager proof'; ws.close(1008, 'proof'); return done(out); }
              out.result = 'ok';
              out.linkKey = m.linkKey || o.key || null;
              if (o.net) ws.send(JSON.stringify({ t: 'net', ...o.net }));
              return done(out);
            }
            if (m.t === 'req') {
              const a = o.answer(m);
              return a ? sendAnswer(ws, m.id, a) : undefined;
            }
          } catch (err) {
            if (m.t === 'req') return sendAnswer(ws, m.id, { status: 500, type: 'application/json', body: { error: 'internal error' } });
            if (!settled) { settled = true; reject(err); }
          }
          return undefined;
        });
        return undefined;
      };
      sock.on('data', onHead);
    });
  });
}

module.exports = { available, lib, connectPi, sendAnswer };
