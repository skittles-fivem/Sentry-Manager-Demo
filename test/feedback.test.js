'use strict';

// Visitors' feedback to the owner's Discord webhook (demo/feedback.js): the
// URL never reaches an answer or a log, only Discord webhook URLs are taken,
// text is made harmless (mentions, markdown, links), and the limits hold.
// A fake Discord (TLS, a throwaway certificate for discord.com) gets the JSON.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { createFeedback, validWebhook, discordSafe, onlyLinks, shownAddress, SENT, FAILED } = require('../demo/feedback');
const { createStore } = require('../demo/store');
const { createAttackLog } = require('../demo/attackLog');

const TOKEN = 'Zq9-secretWEBHOOKtoken_abcdefghijklmnopqrstuvwxyz0123456789';
const HOOK = `https://discord.com/api/webhooks/1234567890123/${TOKEN}`;
const tmpStore = () => createStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'demo-state-')), delayMs: 10 });
const req = (ip) => ({ socket: { remoteAddress: ip }, headers: { 'user-agent': 'test' }, url: '/api/demo/feedback' });

test('only Discord webhook URLs: https, discord.com or discordapp.com, /api/webhooks/<id>/<token>', () => {
  for (const u of [HOOK, HOOK.replace('discord.com', 'discordapp.com'), `https://discord.com:443/api/webhooks/1234567890123/${TOKEN}`]) assert.equal(validWebhook(u), true, u);
  for (const u of [
    HOOK.replace('https:', 'http:'), HOOK.replace('discord.com', 'evil.com'), HOOK.replace('discord.com', 'discord.com.evil.com'), HOOK.replace('discord.com', 'canary.discord.com'),
    `https://user:pw@discord.com/api/webhooks/1234567890123/${TOKEN}`, `https://discord.com:8443/api/webhooks/1234567890123/${TOKEN}`, `${HOOK}?wait=true`, `${HOOK}#x`,
    `${HOOK}/../../x`, 'https://discord.com/api/v10/users/@me', 'https://127.0.0.1/api/webhooks/1/x', '', 'not a url', 'https://discord.com/api/webhooks/123/short'
  ]) assert.equal(validWebhook(u), false, u);
});

test('text for Discord: mentions broken, markdown escaped, links wrapped (no preview)', () => {
  const zw = '\u200b';
  assert.equal(discordSafe('@everyone and @here'), `@${zw}everyone and @${zw}here`);
  assert.equal(discordSafe('<@123> <@&456> <#789>'), `\\<@${zw}123\\> \\<@${zw}&456\\> \\<\\#789\\>`);
  assert.equal(discordSafe('**bold** __u__ ~~s~~ `c` ||spoiler|| > quote # h'), '\\*\\*bold\\*\\* \\_\\_u\\_\\_ \\~\\~s\\~\\~ \\`c\\` \\|\\|spoiler\\|\\| \\> quote \\# h');
  assert.equal(discordSafe('see https://example.com/a_b.'), 'see <https://example.com/a_b>.');
  assert.equal(discordSafe('[click](https://evil.example/x)'), '\\[click\\]\\(<https://evil.example/x>\\)');
  assert.equal(discordSafe('mail https://a.example/@everyone'), 'mail <https://a.example/%40everyone>');
  assert.equal(discordSafe('a\u202eb\u0000c\r\nd'), 'abc\nd', 'control and bidi characters out');
  assert.equal(discordSafe('x'.repeat(3000)).length, 2000);
  assert.equal(onlyLinks('https://spam.example https://spam2.example !!'), true);
  assert.equal(onlyLinks('   '), true);
  assert.equal(onlyLinks('the map is slow https://x.example'), false);
  assert.equal(shownAddress('203.0.113.9', { salt: 's' }).replace(/#[0-9a-f]{8}$/, '#'), '203.0.113.x #');
  assert.equal(shownAddress('2001:db8:1:2::5', { salt: 's' }).replace(/#[0-9a-f]{8}$/, '#'), '2001:db8:1::/48 #');
  assert.equal(shownAddress('203.0.113.9', { showIp: true }), '203.0.113.9');
});

/** A fake Discord on 127.0.0.1 with a certificate for discord.com; `answer` sets its status. */
async function fakeDiscord(answer = () => 204) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-discord-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=discord.com', '-addext', 'subjectAltName=DNS:discord.com']);
  assert.equal(r.status, 0, String(r.stderr));
  const got = [];
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (q, s) => {
    const chunks = [];
    q.on('data', (c) => chunks.push(c));
    q.on('end', () => {
      got.push({ method: q.method, url: q.url, host: q.headers.host, type: q.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString()) });
      const status = answer(got.length);
      s.writeHead(status, status === 302 ? { Location: 'https://discord.com/elsewhere' } : {});
      s.end();
    });
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const ca = fs.readFileSync(path.join(dir, 'c.pem'));
  // what the layer would send to discord.com:443 goes here (certificate still checked for discord.com)
  const request = (opts, cb) => https.request({ ...opts, host: '127.0.0.1', hostname: '127.0.0.1', port: srv.address().port, ca }, cb);
  return { got, request, close: () => new Promise((res) => srv.close(res)) };
}

function feedbackWith({ discord, now = () => clock.t, webhook = HOOK, showIp = false } = {}) {
  const logs = [];
  const store = tmpStore();
  const attackLog = createAttackLog({ store, addressOf: (r) => r.socket.remoteAddress });
  const fb = createFeedback({ webhook, showIp, store, attackLog, addressOf: (r) => r.socket.remoteAddress, now, log: (m) => logs.push(m), request: discord?.request });
  return { fb, logs, attackLog };
}
const clock = { t: Date.UTC(2026, 10, 11, 12, 0, 0) };
const fields = (fb, extra = {}) => { const token = fb.token(); clock.t += 5000; return { message: 'The map is great @everyone **really** https://example.com/x', contact: 'Sam <@42>', page: '/#/viewer', token, ...extra }; };

test('a fake Discord gets the expected JSON: one embed, no mentions allowed, text escaped, the address shortened', async () => {
  const discord = await fakeDiscord();
  try {
    const { fb } = feedbackWith({ discord });
    const out = await fb.submit(req('203.0.113.9'), fields(fb));
    assert.deepEqual(out, { status: 200, body: { ok: true, message: SENT } });
    assert.equal(discord.got.length, 1);
    const g = discord.got[0];
    assert.equal(g.method, 'POST');
    assert.equal(g.url, `/api/webhooks/1234567890123/${TOKEN}`);
    assert.equal(g.host, 'discord.com');
    assert.match(g.type, /^application\/json/);
    assert.deepEqual(g.body.allowed_mentions, { parse: [] });
    assert.equal(g.body.content, undefined);
    const e = g.body.embeds[0];
    assert.equal(e.description, 'The map is great @\u200beveryone \\*\\*really\\*\\* <https://example.com/x>');
    const f = Object.fromEntries(e.fields.map((x) => [x.name, x.value]));
    assert.equal(f.Page, '/\\#/viewer');
    assert.equal(f.Contact, 'Sam \\<@\u200b42\\>');
    assert.match(f.From, /^203\.0\.113\.x \\#[0-9a-f]{8}$/);
    assert.match(f.Time, /^2026\\-11\\-11 12\\:00\\:05 UTC$/);
    assert.equal(e.timestamp, new Date(clock.t).toISOString());
    // DEMO_FEEDBACK_SHOW_IP=1: the whole address
    const full = feedbackWith({ discord, showIp: true });
    await full.fb.submit(req('203.0.113.9'), fields(full.fb));
    assert.equal(discord.got[1].body.embeds[0].fields.find((x) => x.name === 'From').value, '203.0.113.9');
  } finally {
    await discord.close();
  }
});

test('the webhook URL is never in an answer or a log, whatever happens; a redirect is not followed', async () => {
  let status = 500;
  const discord = await fakeDiscord(() => status);
  try {
    const { fb, logs } = feedbackWith({ discord });
    const answers = [];
    answers.push(await fb.submit(req('203.0.113.1'), fields(fb)));
    status = 302;
    answers.push(await fb.submit(req('203.0.113.2'), fields(fb)));
    assert.equal(discord.got.length, 2, 'the redirect was not followed');
    status = 204;
    answers.push(await fb.submit(req('203.0.113.3'), fields(fb)));
    // a network failure (nothing listens there)
    const dead = feedbackWith({ discord: { request: (o, cb) => https.request({ ...o, host: '127.0.0.1', hostname: '127.0.0.1', port: 1 }, cb) } });
    answers.push(await dead.fb.submit(req('203.0.113.4'), fields(dead.fb)));
    answers.push({ token: fb.token(), enabled: fb.enabled });
    const text = JSON.stringify(answers) + logs.join('\n') + dead.logs.join('\n');
    assert.ok(!text.includes(TOKEN) && !text.includes('1234567890123') && !text.includes('webhooks'), text);
    assert.deepEqual(answers.slice(0, 4).map((a) => a.body.message), [FAILED, FAILED, SENT, FAILED]);
    assert.match(logs.join('\n'), /HTTP 500/);
  } finally {
    await discord.close();
  }
});

test('limits: 3 an hour and 10 a day per address, 60 an hour in all; noted in the attack log', async () => {
  const discord = await fakeDiscord();
  try {
    const { fb, attackLog } = feedbackWith({ discord });
    for (let i = 0; i < 3; i++) assert.equal((await fb.submit(req('203.0.113.9'), fields(fb))).body.message, SENT);
    assert.deepEqual(await fb.submit(req('203.0.113.9'), fields(fb)), { status: 429, body: { ok: false, message: FAILED } });
    assert.match(attackLog.list({ kind: 'rate-limit' })[0].entries[0].sample, /3 an hour/);
    // the next hours: up to 10 a day
    for (let h = 0; h < 3; h++) { clock.t += 3600_000; for (let i = 0; i < 3; i++) await fb.submit(req('203.0.113.9'), fields(fb)); }
    clock.t += 3600_000;
    assert.equal((await fb.submit(req('203.0.113.9'), fields(fb))).status, 429);
    assert.match(attackLog.list({ kind: 'rate-limit' })[0].entries[0].sample, /10 a day/);
    assert.equal(discord.got.length, 10);
    // 60 an hour from everyone
    clock.t += 2 * 86400_000;
    const sent = [];
    for (let i = 0; i < 61; i++) sent.push((await fb.submit(req(`198.51.${Math.floor(i / 3)}.${i % 3 + 1}`), fields(fb))).status);
    assert.equal(sent.filter((s) => s === 200).length, 60);
    assert.equal(sent[60], 429);
  } finally {
    await discord.close();
  }
});

test('the honeypot, the time on the page, empty and link-only messages: nothing sent; off without a webhook', async () => {
  const discord = await fakeDiscord();
  try {
    const { fb, attackLog } = feedbackWith({ discord });
    // a bot fills the hidden field: told it was sent, nothing goes out
    assert.equal((await fb.submit(req('203.0.113.9'), fields(fb, { website: 'http://spam' }))).body.message, SENT);
    // sent a second after the page opened
    const token = fb.token();
    clock.t += 1000;
    assert.equal((await fb.submit(req('203.0.113.9'), { message: 'hello there', token })).status, 429);
    // no token, a forged one, an old one
    assert.equal((await fb.submit(req('203.0.113.9'), { message: 'hello there' })).status, 400);
    assert.equal((await fb.submit(req('203.0.113.9'), { message: 'hello there', token: `${clock.t - 10_000}.${'A'.repeat(32)}` })).status, 400);
    const old = fb.token();
    clock.t += 7 * 3600_000;
    assert.equal((await fb.submit(req('203.0.113.9'), { message: 'hello there', token: old })).status, 400);
    for (const message of ['', '   ', 'https://spam.example', 'https://a.example https://b.example !!', 'x'.repeat(2001)]) {
      assert.equal((await fb.submit(req('203.0.113.9'), fields(fb, { message }))).body.message, FAILED, JSON.stringify(message.slice(0, 20)));
    }
    assert.equal((await fb.submit(req('203.0.113.9'), fields(fb, { contact: 'c'.repeat(101) }))).status, 400);
    assert.equal(discord.got.length, 0);
    const kinds = attackLog.list()[0].kinds;
    assert.ok(kinds.spam >= 4, JSON.stringify(kinds));
    // no webhook (or a bad one): off, nothing sent
    for (const webhook of ['', 'https://example.com/api/webhooks/1234567890123/abcdefghijklmnopqrstuvwxyz']) {
      const off = feedbackWith({ discord, webhook });
      assert.equal(off.fb.enabled, false);
      assert.equal((await off.fb.submit(req('203.0.113.9'), fields(off.fb))).status, 503);
      assert.ok(!off.logs.join('').includes('example.com'));
    }
    assert.equal(discord.got.length, 0);
  } finally {
    await discord.close();
  }
});

test('the sender\'s machine goes to Discord as plain lines from known keys only', () => {
  const { deviceLines, payload } = require('../demo/feedback');
  const lines = deviceLines({ os: 'Windows 11', browser: 'Chrome 141', gpu: 'NVIDIA GeForce RTX 4070 *bold*', cores: 16, evil: 'x', screen: '2560×1440 at 1x' });
  assert.deepEqual(lines, ['**OS:** Windows 11', '**Browser:** Chrome 141', '**CPU threads:** 16', '**Graphics:** NVIDIA GeForce RTX 4070 \\*bold\\*', '**Screen:** 2560×1440 at 1x']);
  assert.deepEqual(deviceLines('nope'), []);
  const p = payload({ message: 'hi', page: '/', address: '203.0.113.9', at: 0, device: { os: 'Linux' }, userAgent: 'Mozilla/5.0 @everyone' });
  const f = Object.fromEntries(p.embeds[0].fields.map((x) => [x.name, x.value]));
  assert.equal(f.From, '203.0.113.9');
  assert.equal(f.Machine, '**OS:** Linux');
  assert.match(f['User agent'], /@​everyone/);
});
