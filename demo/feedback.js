'use strict';

// Visitors' feedback (the page at /demo/feedback, linked from the demo note),
// sent to the owner's Discord webhook (DEMO_FEEDBACK_WEBHOOK). The webhook
// URL is read once at start and never leaves this module: not in an answer,
// a log line or an error. The browser only ever hears "Thanks, sent" or
// "Couldn't send, try again later".
//
// This is the only network call the demo layer makes: to
// https://discord.com/api/webhooks/... or https://discordapp.com/api/webhooks/...
// only, with a timeout, never following a redirect.
//
// Each message goes as one embed with allowed_mentions { parse: [] } (nobody
// is pinged, whatever the text says), the visitor's text with Discord
// markdown escaped, mentions broken and links wrapped in <...> (no preview),
// the page, the time and the visitor's address (the Cloudflare-aware one),
// whole, and the sender's
// machine as their browser describes it (OS, browser, screen, graphics...),
// which the form tells them is sent, for tracking down bugs on their hardware.
//
// Limits: per address 10 an hour and 40 a day, 200 an hour in all (the answer
// says how long to wait); a honeypot
// field; at least 3 s between opening the page and sending (a signed token);
// no empty or link-only messages. Hits are noted in the attack log; the
// counts are kept in the demo's state, so a reset does not lift them.

const crypto = require('crypto');
const https = require('https');
const net = require('net');
const { banKey, normalizeIp } = require('./clientAddress');

const MAX_MESSAGE = 2000;
const MAX_CONTACT = 100;
const MAX_PAGE = 200;
const MIN_MS = 3000;
const TOKEN_MS = 6 * 3600_000;
const LIMITS = { perHour: 10, perDay: 40, allPerHour: 200 };
const TIMEOUT_MS = 8000;
const SENT = 'Thanks, sent';
const FAILED = "Couldn't send, try again later";
const HOSTS = ['discord.com', 'discordapp.com'];

/** Whether a webhook URL is a Discord webhook (and nothing else): https, the two hosts, /api/webhooks/<id>/<token>. */
function validWebhook(value) {
  let u;
  try {
    u = new URL(String(value || '').trim());
  } catch {
    return false;
  }
  return u.protocol === 'https:' && !u.username && !u.password && HOSTS.includes(u.hostname) && (u.port === '' || u.port === '443')
    && /^\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/.test(u.pathname) && !u.search && !u.hash;
}

// ---- making visitors' text safe for Discord
const URL_RE = /\bhttps?:\/\/[^\s<>"]+/gi;
const MD = /[\\*_~`|>#[\]()<:-]/g;

/** One plain line or block of a visitor's text, markdown escaped, mentions broken (no links in it). */
function escapeText(s) {
  return s.replace(MD, (c) => `\\${c}`).replace(/@/g, '@\u200b');
}

/**
 * A visitor's text for an embed: control and invisible characters out, CRLF
 * as LF, Discord markdown escaped, @mentions (@everyone, @here, <@id>,
 * <@&id>, <#id>) broken, each link wrapped in <...> so it shows no preview.
 */
function discordSafe(value, max = MAX_MESSAGE) {
  let s = String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '');
  s = s.slice(0, max);
  let out = '';
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    let url = m[0];
    const trail = /[).,;:!?'\]]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    out += escapeText(s.slice(last, m.index));
    // a link: wrapped, so it is a plain link with no embed; '>' cannot be in it (URL_RE)
    out += `<${url.replace(/@/g, '%40')}>`;
    last = m.index + url.length;
  }
  return out + escapeText(s.slice(last));
}

/** Whether the text is empty or only links. */
function onlyLinks(value) {
  const rest = String(value ?? '').replace(URL_RE, ' ').replace(/[\s\p{P}\p{S}]/gu, '');
  return rest.length < 2;
}

/** The address as the owner sees it: shortened (IPv4 /24, IPv6 /48) and a hash, or whole. */
function shownAddress(ip, { showIp = false, salt = '' } = {}) {
  const a = normalizeIp(ip) || String(ip || '?').slice(0, 64);
  if (showIp) return a;
  const hash = crypto.createHash('sha256').update(`${salt}|${banKey(a)}`).digest('hex').slice(0, 8);
  let short = '?';
  if (net.isIPv4(a)) short = `${a.split('.').slice(0, 3).join('.')}.x`;
  else if (net.isIPv6(a)) short = `${banKey(a).replace(/::\/64$/, '').split(':').slice(0, 3).join(':')}::/48`;
  return `${short} #${hash}`;
}

// The sender's machine, as their browser describes it (sent with the message,
// the form says so): a few known keys, plain text, each line short.
const DEVICE_KEYS = {
  os: 'OS', browser: 'Browser', model: 'Device', arch: 'CPU arch', cores: 'CPU threads', memory: 'Memory', gpu: 'Graphics',
  screen: 'Screen', viewport: 'Window', touch: 'Touch', language: 'Language', timezone: 'Time zone', connection: 'Connection', ui: 'Interface'
};
/** The device lines for the embed, from what the browser sent (unknown keys dropped). */
function deviceLines(device) {
  if (!device || typeof device !== 'object' || Array.isArray(device)) return [];
  const out = [];
  for (const [k, label] of Object.entries(DEVICE_KEYS)) {
    const v = device[k];
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const text = discordSafe(String(v).replace(/\n/g, ' '), 120);
    if (text) out.push(`**${label}:** ${text}`);
  }
  return out;
}

/** The JSON Discord gets. */
function payload({ message, contact, page, address, at, device = null, userAgent = '' }) {
  const fields = [
    { name: 'From', value: escapeText(address), inline: true },
    { name: 'Time', value: escapeText(new Date(at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')), inline: true }
  ];
  if (contact) fields.push({ name: 'Contact', value: discordSafe(contact, MAX_CONTACT) });
  const lines = deviceLines(device);
  if (lines.length) fields.push({ name: 'Machine', value: lines.join('\n').slice(0, 1024) });
  if (userAgent) fields.push({ name: 'User agent', value: discordSafe(userAgent, 400) || '-' });
  return {
    username: 'Sentry Six Manager demo',
    allowed_mentions: { parse: [] },
    embeds: [{ title: 'Demo feedback', description: discordSafe(message), color: 0xf5b83d, fields, timestamp: new Date(at).toISOString() }]
  };
}

/** POSTs JSON to the webhook: resolves the HTTP status, or rejects with a network error code only. */
function post(url, body, { request = https.request, timeoutMs = TIMEOUT_MS } = {}) {
  const u = new URL(url);
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; fn(v); } };
    const req = request({
      method: 'POST', protocol: 'https:', hostname: u.hostname, port: 443, path: u.pathname, servername: u.hostname,
      headers: { Host: u.hostname, 'Content-Type': 'application/json', 'Content-Length': data.length, 'User-Agent': 'sentry-manager-demo (feedback)' },
      timeout: timeoutMs
    }, (res) => {
      // a redirect is not followed: it counts as a failure
      res.resume();
      res.on('end', () => finish(resolve, res.statusCode));
      res.on('error', () => finish(reject, Object.assign(new Error('response'), { code: 'RESPONSE' })));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (err) => finish(reject, Object.assign(new Error('network'), { code: String(err.code || 'NETWORK').slice(0, 24) })));
    req.end(data);
  });
}

/**
 * o: webhook, showIp, store (demo/store.js), attackLog, addressOf(req), now,
 * log, request (for tests: like https.request), secret (for the page tokens).
 */
function createFeedback({ webhook = '', showIp = true, store, attackLog = null, addressOf, now = () => Date.now(), log = () => {}, request = https.request, secret = null } = {}) {
  const url = validWebhook(webhook) ? String(webhook).trim() : null;
  if (webhook && !url) log('feedback is off: DEMO_FEEDBACK_WEBHOOK is not a https://discord.com/api/webhooks/... address');
  const doc = store.load('feedback', null) || {};
  doc.salt ||= crypto.randomBytes(16).toString('hex');
  doc.by = doc.by && typeof doc.by === 'object' ? doc.by : {}; // hashed address -> [times]
  doc.all = Array.isArray(doc.all) ? doc.all : [];
  store.save('feedback', doc);
  const key = secret || crypto.randomBytes(32);

  const sign = (t) => crypto.createHmac('sha256', key).update(`feedback|${t}`).digest('base64url').slice(0, 32);
  const token = () => { const t = now(); return `${t}.${sign(t)}`; };
  function tokenAge(value) {
    const m = /^(\d{10,16})\.([A-Za-z0-9_-]{32})$/.exec(String(value || ''));
    if (!m) return null;
    const a = Buffer.from(sign(Number(m[1])));
    const b = Buffer.from(m[2]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return now() - Number(m[1]);
  }

  const who = (req) => crypto.createHash('sha256').update(`${doc.salt}|${banKey(addressOf(req))}`).digest('base64url').slice(0, 22);
  function prune() {
    const day = now() - 86400_000;
    for (const [k, list] of Object.entries(doc.by)) {
      const keep = (Array.isArray(list) ? list : []).filter((t) => t > day);
      if (keep.length) doc.by[k] = keep; else delete doc.by[k];
    }
    doc.all = doc.all.filter((t) => t > now() - 3600_000);
  }
  /** Which limit this one would break and the minutes until it lifts, or null. */
  function over(req) {
    prune();
    const mine = doc.by[who(req)] || [];
    const mins = (t) => Math.max(1, Math.ceil((t - now()) / 60_000));
    const hour = mine.filter((t) => t > now() - 3600_000).sort((a, b) => a - b);
    if (hour.length >= LIMITS.perHour) return { why: `${LIMITS.perHour} an hour`, wait: mins(hour[hour.length - LIMITS.perHour] + 3600_000) };
    if (mine.length >= LIMITS.perDay) return { why: `${LIMITS.perDay} a day`, wait: mins([...mine].sort((a, b) => a - b)[mine.length - LIMITS.perDay] + 86400_000) };
    if (doc.all.length >= LIMITS.allPerHour) return { why: `${LIMITS.allPerHour} an hour in all`, wait: mins([...doc.all].sort((a, b) => a - b)[0] + 3600_000), all: true };
    return null;
  }
  function count(req) {
    const k = who(req);
    (doc.by[k] ||= []).push(now());
    doc.all.push(now());
    store.save('feedback', doc);
  }

  /**
   * One visitor's message: { status, body } for the browser (only the two
   * answers), after the checks. fields: message, contact, page, website
   * (the honeypot), token.
   */
  async function submit(req, fields) {
    const fail = (status) => ({ status, body: { ok: false, message: FAILED } });
    if (!url) return fail(503);
    const f = fields && typeof fields === 'object' ? fields : {};
    const message = typeof f.message === 'string' ? f.message.trim() : '';
    const contact = typeof f.contact === 'string' ? f.contact.trim() : '';
    const page = typeof f.page === 'string' ? f.page.trim() : '';
    // a bot that fills every field: answered as if sent, and noted
    if (typeof f.website === 'string' && f.website !== '') {
      attackLog?.note('spam', req, 'feedback: honeypot filled');
      return { status: 200, body: { ok: true, message: SENT } };
    }
    const age = tokenAge(f.token);
    if (age === null || age > TOKEN_MS) {
      attackLog?.note('spam', req, 'feedback: no valid page token');
      return fail(400);
    }
    if (age < MIN_MS) {
      attackLog?.note('spam', req, `feedback: sent ${age} ms after opening the page`);
      return { status: 429, body: { ok: false, message: 'Give it a couple of seconds, then press Send again.' } };
    }
    if (!message || message.length > MAX_MESSAGE || contact.length > MAX_CONTACT || page.length > MAX_PAGE) return fail(400);
    if (onlyLinks(message)) {
      attackLog?.note('spam', req, 'feedback: only links');
      return fail(400);
    }
    const limit = over(req);
    if (limit) {
      attackLog?.note('rate-limit', req, `feedback: over ${limit.why}`);
      const when = limit.wait >= 90 ? `about ${Math.round(limit.wait / 60)} h` : `about ${limit.wait} min`;
      return { status: 429, body: { ok: false, message: limit.all ? `Lots of feedback right now: try again in ${when}.` : `You've sent a lot of feedback, thanks! You can send more in ${when}.` } };
    }
    count(req);
    const body = payload({
      message, contact, page, address: shownAddress(addressOf(req), { showIp, salt: doc.salt }), at: now(),
      device: f.device, userAgent: String(req.headers?.['user-agent'] || '').slice(0, 400)
    });
    try {
      const status = await post(url, body, { request });
      if (status >= 200 && status < 300) return { status: 200, body: { ok: true, message: SENT } };
      log(`feedback not delivered (Discord answered HTTP ${status})`);
    } catch (err) {
      log(`feedback not delivered (${err.code || 'network error'})`);
    }
    return fail(502);
  }

  return { enabled: Boolean(url), token, submit, limits: LIMITS };
}

module.exports = { createFeedback, deviceLines, validWebhook, discordSafe, escapeText, onlyLinks, shownAddress, payload, post, LIMITS, MAX_MESSAGE, MAX_CONTACT, SENT, FAILED };
