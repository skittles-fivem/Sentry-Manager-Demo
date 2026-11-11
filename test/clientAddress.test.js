'use strict';

// The real client address the layer uses (demo/clientAddress.js): the socket's
// own; CF-Connecting-IP only with TRUST_CLOUDFLARE and only from Cloudflare's
// ranges; and the owner page's "local" (never Cloudflare, never the gateway).

const test = require('node:test');
const assert = require('node:assert/strict');
const { clientAddress, cloudflareMatcher, fromEnv, ownerLocal, parseGateways, normalizeIp } = require('../demo/clientAddress');

const req = (from, headers = {}) => ({ socket: { remoteAddress: from }, headers });
const CF = '172.70.1.2'; // in 172.64.0.0/13
const cf = { cloudflare: cloudflareMatcher() };

test('CF-Connecting-IP counts only from Cloudflare, only with TRUST_CLOUDFLARE', () => {
  assert.equal(clientAddress(req(CF, { 'cf-connecting-ip': '198.51.100.7' }), cf), '198.51.100.7');
  assert.equal(clientAddress(req('2606:4700::1', { 'cf-connecting-ip': '2001:db8::5' }), cf), '2001:db8::5');
  // anyone else can send the header: ignored
  assert.equal(clientAddress(req('203.0.113.9', { 'cf-connecting-ip': '192.168.1.5' }), cf), '203.0.113.9');
  // TRUST_CLOUDFLARE off: the socket, even from Cloudflare
  assert.equal(clientAddress(req(CF, { 'cf-connecting-ip': '198.51.100.7' })), CF);
  // a header that is no address leaves Cloudflare's
  assert.equal(clientAddress(req(CF, { 'cf-connecting-ip': '<script>' }), cf), CF);
  assert.equal(normalizeIp('::ffff:172.70.1.2'), CF);
});

test('fromEnv reads TRUST_CLOUDFLARE and CLOUDFLARE_IPS; a bad range is an error', () => {
  const on = fromEnv({ TRUST_CLOUDFLARE: '1' });
  assert.equal(on.of(req(CF, { 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7');
  const off = fromEnv({});
  assert.equal(off.of(req(CF, { 'cf-connecting-ip': '198.51.100.7' })), CF);
  const own = fromEnv({ TRUST_CLOUDFLARE: 'true', CLOUDFLARE_IPS: '192.0.2.0/24' });
  assert.equal(own.of(req('192.0.2.10', { 'cf-connecting-ip': '198.51.100.7' })), '198.51.100.7');
  assert.equal(own.of(req(CF, { 'cf-connecting-ip': '198.51.100.7' })), CF, 'the list replaces the built-in ranges');
  assert.throws(() => fromEnv({ TRUST_CLOUDFLARE: '1', CLOUDFLARE_IPS: 'nonsense' }), /CLOUDFLARE_IPS/);
});

test("the owner page's local: LAN and loopback; never through Cloudflare, never Docker's gateway", () => {
  const gw = parseGateways('Iface\tDestination\tGateway\neth0\t00000000\t010012AC\t0003\n', '');
  assert.deepEqual(gw, ['172.18.0.1']);
  const net = { proxy: {}, gateways: gw };
  assert.equal(ownerLocal(req('192.168.1.20'), net), true);
  assert.equal(ownerLocal(req('127.0.0.1'), net), true);
  assert.equal(ownerLocal(req('203.0.113.9'), net), false);
  assert.equal(ownerLocal(req('172.18.0.1'), net), false, 'every visitor through docker-proxy looks like this');
  assert.equal(ownerLocal(req('192.168.1.20', { 'cf-ray': 'x' }), net), false, 'a tunnel on the LAN is still Cloudflare');
  assert.equal(ownerLocal(req('192.168.1.20', { 'cf-connecting-ip': '192.168.1.20' }), net), false);
  assert.equal(ownerLocal(req(CF, { 'cf-connecting-ip': '192.168.1.20' }), { ...net, proxy: cf }), false);
});
