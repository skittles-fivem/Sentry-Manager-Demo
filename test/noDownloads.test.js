'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { noDownloads, headersHaveAttachment } = require('../demo/noDownloads');

async function serve(handler) {
  const blocked = [];
  const srv = http.createServer((req, res) => { noDownloads(req, res, (r) => blocked.push(r.url)); handler(req, res); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: srv.address().port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
  return { get, blocked, close: () => srv.close() };
}

test('a file sent as an attachment comes back empty, however the app sends it', async () => {
  const s = await serve((req, res) => {
    if (req.url === '/head') { res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Disposition': 'attachment; filename="x.mp4"' }); res.write('secret'); res.end('more'); }
    else if (req.url === '/set') { res.setHeader('Content-Disposition', 'attachment; filename=d.txt'); res.setHeader('Content-Type', 'text/plain'); res.end('diagnostics'); }
    else if (req.url === '/inline') { res.writeHead(200, { 'Content-Disposition': 'inline', 'Content-Type': 'text/plain' }); res.end('page'); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }
  });
  try {
    for (const path of ['/head', '/set']) {
      const r = await s.get(path);
      assert.equal(r.status, 204);
      assert.equal(r.body, '');
      assert.equal(r.headers['content-disposition'], undefined);
    }
    assert.deepEqual(s.blocked, ['/head', '/set']);
    assert.equal((await s.get('/inline')).body, 'page');
    assert.equal((await s.get('/api/x')).body, '{"ok":true}');
  } finally { s.close(); }
});

test('headers given as an object or a raw list', () => {
  assert.equal(headersHaveAttachment({ 'content-disposition': 'ATTACHMENT' }), true);
  assert.equal(headersHaveAttachment(['Content-Disposition', 'attachment; x']), true);
  assert.equal(headersHaveAttachment({ 'Content-Type': 'text/html' }), false);
});
