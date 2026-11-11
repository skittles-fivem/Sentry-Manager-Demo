'use strict';

// No downloads on the demo: any answer to a visitor that the app sends as a
// file (Content-Disposition: attachment: footage, logs, the support bundle,
// CAN logs, the Sentry USB's diagnostics and backups, the certificate
// authority, ...) goes out as an empty 204 instead. The page says downloads
// are off (demo/banner.js). onBlock(req) is told each time.

const isAttachment = (k, v) => /^content-disposition$/i.test(String(k)) && /attachment/i.test(String(v));

function headersHaveAttachment(h) {
  if (!h || typeof h !== 'object') return false;
  if (Array.isArray(h)) {
    // [k, v, k, v] or [[k, v], ...]
    if (Array.isArray(h[0])) return h.some(([k, v]) => isAttachment(k, v));
    for (let i = 0; i + 1 < h.length; i += 2) if (isAttachment(h[i], h[i + 1])) return true;
    return false;
  }
  return Object.keys(h).some((k) => isAttachment(k, h[k]));
}

function noDownloads(req, res, onBlock = () => {}) {
  const writeHead = res.writeHead;
  const setHeader = res.setHeader;
  const write = res.write;
  const end = res.end;
  let blocked = false;
  let told = false;
  const block = () => {
    blocked = true;
    if (!told) { told = true; try { onBlock(req); } catch { /* never in the way */ } }
  };
  const empty = (self) => {
    for (const h of ['content-disposition', 'content-length', 'content-type', 'content-encoding', 'etag', 'last-modified']) {
      try { self.removeHeader(h); } catch { /* already gone */ }
    }
    return writeHead.call(self, 204, { 'Cache-Control': 'no-store', 'X-Demo': 'downloads are off' });
  };
  res.setHeader = function demoSetHeader(k, v) {
    if (isAttachment(k, v)) { block(); return this; }
    return setHeader.call(this, k, v);
  };
  res.writeHead = function demoWriteHead(status, ...rest) {
    if (blocked || rest.some(headersHaveAttachment)) { block(); return empty(this); }
    return writeHead.call(this, status, ...rest);
  };
  res.write = function demoWrite(...args) {
    if (!blocked) return write.apply(this, args);
    if (!this.headersSent) empty(this);
    return true;
  };
  res.end = function demoEnd(...args) {
    if (!blocked) return end.apply(this, args);
    if (!this.headersSent) empty(this);
    const cb = args.find((a) => typeof a === 'function');
    return end.call(this, cb);
  };
  return res;
}

module.exports = { noDownloads, headersHaveAttachment };
