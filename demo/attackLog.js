'use strict';

// The demo's attack log, for the owner page (demo/owner.js): what was tried
// against the site, by the real client address (demo/clientAddress.js). One
// row per address and kind with a count, the first and last time, the last
// sample (a path, or what was refused: never a password or a body) and the
// user agent, both clipped. Repeats collapse into their row; at most maxRows
// rows (the oldest go first), none older than keepDays. Kept in the demo's
// state (demo/store.js), so it survives the demo's resets.
//
// What counts: public visits to the owner page, scanner paths, exploit
// patterns in paths, queries or form fields, malformed requests, writes the
// demo refused (demo/policy.js), rate-limit hits, wrong owner passwords,
// feedback spam and bans. Ordinary visits are never noted (only counted:
// distinct addresses a day, as salted hashes).

const crypto = require('crypto');
const { normalizeIp } = require('./clientAddress');

const MAX_ROWS = 5000;
const KEEP_DAYS = 30;
const VISITOR_DAYS = 30;
const MAX_VISITORS_A_DAY = 100_000;
const KINDS = ['owner-probe', 'scan', 'exploit', 'malformed', 'refused', 'rate-limit', 'login', 'spam', 'ban'];

// paths only scanners ask for (neither the app nor the demo has any of them)
const SCAN_PATHS = [
  /^\/wp-(admin|login|content|includes|json)\b/, /\/wp-login\.php/, /\/xmlrpc\.php/, /\/\.env(\.|\/|$)/, /\/\.git(\/|$)/,
  /\/\.(svn|hg|aws|ssh|docker)(\/|$)/, /\/\.ds_store$/, /\/\.ht(access|passwd)$/, /\/(phpmyadmin|pma|myadmin|adminer)(\/|$|\.php)/,
  /\/cgi-bin(\/|$)/, /\/boaform/, /\/hnap1/, /\/actuator(\/|$)/, /\/vendor\/phpunit/, /\/server-(status|info)$/, /\.php\d?$/,
  /\.(asp|aspx|jsp|cgi|pl|do|action)$/, /\/(solr|jenkins|geoserver|druid|telescope|_ignition|owa|ecp|autodiscover|goform|evox|mgmt)(\/|$)/,
  /\/manager\/html/, /\/remote\/login/, /\.(sql|bak|old|swp)(\.gz)?$/, /\/(backup|dump|db)\.(zip|tar|tgz|gz|sql)$/, /\/setup\.cgi/,
  /\/(config|credentials|secrets?)\.(ya?ml|ini|xml|php)$/, /\/sdk$/, /\/console(\/|$)/
];
// the app's own prefixes: never a scanner path (exploit patterns still count)
const APP_PREFIXES = ['/api/', '/web/', '/studio/', '/assets/', '/shared/', '/v/', '/demo/', '/.well-known/acme-challenge/'];

const EXPLOITS = [
  ['traversal', /\.\.[/\\]|[/\\]\.\.$|\/etc\/(passwd|shadow)|\/proc\/self\/|win\.ini|boot\.ini/i],
  ['traversal', /%2e%2e|\.\.%2f|%252e|%c0%ae/i],
  ['script', /<\s*script|javascript:|<[^>]*\bon(error|load|mouseover)\s*=/i],
  ['sql', /'\s*(or|and)\s+'?\w+'?\s*=\s*'?\w+|\bunion\b[\s\S]{0,20}\bselect\b|\bor\s+1\s*=\s*1\b|;\s*(drop|delete|insert|update)\s+\w|\bsleep\s*\(\s*\d+\s*\)|\bbenchmark\s*\(|waitfor\s+delay|'\s*--|"\s*or\s*"/i],
  ['jndi', /\$\{\s*(jndi|\$\{|lower:|upper:|env:|sys:|::-)/i],
  ['shell', /(;|\|\|?|&&|`)\s*(cat|wget|curl|sh|bash|nc|ncat|rm|chmod|uname|whoami|busybox|tftp|python3?|perl|powershell|id)(\s|$|;|\||`)|\$\(\s*[a-z]/i],
  ['null byte', /\0|%00/]
];
// form fields never looked at (their values may be secrets)
const SECRET_FIELD = /pass|secret|token|code|key|otp|totp|recovery/i;

const decodeOnce = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** A short, safe copy: control, bidi and invisible characters written as \u{..}, at most n characters. */
function clip(value, n = 160) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The exploit a text shows ('traversal', 'sql', ...), or null. */
function exploitIn(text) {
  const raw = String(text || '');
  const once = decodeOnce(raw.replace(/\+/g, ' '));
  const twice = decodeOnce(once);
  for (const [name, re] of EXPLOITS) if (re.test(raw) || re.test(once) || re.test(twice)) return name;
  return null;
}

/** Whether a path is one only scanners ask for. */
function isScanPath(pathname) {
  const p = decodeOnce(String(pathname || '')).toLowerCase();
  if (APP_PREFIXES.some((x) => p.startsWith(x))) return false;
  return SCAN_PATHS.some((re) => re.test(p));
}

/** What a request's raw URL is: { kind: 'exploit' | 'scan', detail } or null for an ordinary one. */
function classifyUrl(rawUrl) {
  const u = String(rawUrl || '');
  const q = u.indexOf('?');
  const pathPart = q < 0 ? u : u.slice(0, q);
  const what = exploitIn(u);
  if (what) return { kind: 'exploit', detail: `${what}: ${u}` };
  if (isScanPath(pathPart)) return { kind: 'scan', detail: u };
  return null;
}

/** An exploit pattern in a body's fields (secret fields skipped): { kind, detail } or null. */
function classifyFields(body, depth = 0) {
  if (!body || typeof body !== 'object' || depth > 1) return null;
  let n = 0;
  for (const [k, v] of Object.entries(body)) {
    if (++n > 50) break;
    if (SECRET_FIELD.test(k)) continue;
    if (typeof v === 'string') {
      const what = exploitIn(v.slice(0, 4000));
      if (what) return { kind: 'exploit', detail: `${what}: ${k}=${v}` };
    } else if (v && typeof v === 'object') {
      const hit = classifyFields(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** A CSV cell: quoted, and never read as a formula by a spreadsheet. */
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r|%]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * @param {{ store: ReturnType<import('./store').createStore>, addressOf: (req: any) => string, now?: () => number, maxRows?: number, keepDays?: number }} o
 */
function createAttackLog({ store, addressOf, now = () => Date.now(), maxRows = MAX_ROWS, keepDays = KEEP_DAYS }) {
  const doc = store.load('attack-log', null) || {};
  doc.rows = doc.rows && typeof doc.rows === 'object' ? doc.rows : {}; // "ip|kind" -> row
  doc.visitors = doc.visitors && typeof doc.visitors === 'object' ? doc.visitors : {}; // "YYYY-MM-DD" -> count
  doc.salt ||= crypto.randomBytes(16).toString('hex');
  const rows = new Map(Object.entries(doc.rows));
  let today = { day: '', seen: new Set() };
  let sincePrune = 0;
  // written out only when the store flushes (a flood of notes costs no copies)
  const snapshot = { toJSON: () => ({ rows: Object.fromEntries(rows), visitors: doc.visitors, salt: doc.salt }) };
  const persist = () => store.save('attack-log', snapshot);
  persist();

  function prune() {
    const cut = now() - keepDays * 86400_000;
    for (const [k, r] of rows) if (r.lastSeen < cut) rows.delete(k);
    if (rows.size > maxRows) {
      const oldest = [...rows].sort((a, b) => a[1].lastSeen - b[1].lastSeen).slice(0, rows.size - maxRows);
      for (const [k] of oldest) rows.delete(k);
    }
  }
  prune();

  const addressFrom = (req) => {
    if (typeof req === 'string') return normalizeIp(req) || clip(req, 64);
    try {
      return addressOf(req) || '?';
    } catch {
      return '?';
    }
  };

  /** One attempt of this kind from this request's address (detail: never a password). */
  function note(kind, req, detail = '') {
    const k = KINDS.includes(kind) ? kind : 'malformed';
    const ip = clip(addressFrom(req), 80);
    const agent = typeof req === 'string' ? '' : clip(req?.headers?.['user-agent'] || '', 200);
    const t = now();
    const key = `${ip}|${k}`;
    const r = rows.get(key);
    if (r) {
      r.count += 1;
      r.lastSeen = t;
      r.sample = clip(detail);
      if (agent) r.agent = agent;
      rows.delete(key); // newest last, for the cap
      rows.set(key, r);
    } else {
      rows.set(key, { address: ip, kind: k, count: 1, firstSeen: t, lastSeen: t, sample: clip(detail), agent });
      if (rows.size > maxRows) rows.delete(rows.keys().next().value);
    }
    if (++sincePrune >= 200) { sincePrune = 0; prune(); }
    persist();
  }

  /** Notes a scanner path or exploit pattern in this request's URL; the kind, or null. */
  function inspect(req) {
    const hit = classifyUrl(req.url);
    if (hit) note(hit.kind, req, hit.detail);
    return hit?.kind || null;
  }

  function inspectFields(req, body) {
    const hit = classifyFields(body);
    if (hit) note(hit.kind, req, hit.detail);
    return hit?.kind || null;
  }

  function entries({ kind = '', address = '' } = {}) {
    prune();
    return [...rows.values()]
      .filter((r) => (!kind || r.kind === kind) && (!address || r.address === address))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  /** Grouped by address, newest first ('newest') or most attempts first ('active'), at most `limit` addresses. */
  function list({ kind = '', address = '', sort = 'newest', limit = 300 } = {}) {
    const groups = new Map();
    for (const r of entries({ kind, address })) {
      let g = groups.get(r.address);
      if (!g) groups.set(r.address, (g = { address: r.address, count: 0, firstSeen: r.firstSeen, lastSeen: r.lastSeen, kinds: {}, entries: [] }));
      g.count += r.count;
      g.firstSeen = Math.min(g.firstSeen, r.firstSeen);
      g.lastSeen = Math.max(g.lastSeen, r.lastSeen);
      g.kinds[r.kind] = (g.kinds[r.kind] || 0) + r.count;
      g.entries.push({ ...r });
    }
    const out = [...groups.values()];
    out.sort(sort === 'active' ? (a, b) => b.count - a.count || b.lastSeen - a.lastSeen : (a, b) => b.lastSeen - a.lastSeen || b.count - a.count);
    return out.slice(0, Math.max(1, Math.min(Number(limit) || 300, 2000)));
  }

  function csv(filters = {}) {
    const lines = [['address', 'kind', 'count', 'first_seen', 'last_seen', 'sample', 'user_agent'].join(',')];
    for (const r of entries(filters)) {
      lines.push([r.address, r.kind, r.count, new Date(r.firstSeen).toISOString(), new Date(r.lastSeen).toISOString(), r.sample, r.agent].map(csvCell).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  /** Counts a visitor (distinct addresses a day: only a salted hash is held, and only today's). */
  function seen(req) {
    const day = new Date(now()).toISOString().slice(0, 10);
    if (today.day !== day) {
      today = { day, seen: new Set() };
      const keep = Object.keys(doc.visitors).sort().slice(-VISITOR_DAYS + 1);
      doc.visitors = Object.fromEntries(keep.map((d) => [d, doc.visitors[d]]));
      today.base = doc.visitors[day] || 0; // counted before a reset today (the hashes are not kept)
    }
    if (today.seen.size >= MAX_VISITORS_A_DAY) return;
    const h = crypto.createHash('sha256').update(`${doc.salt}|${addressFrom(req)}`).digest('base64').slice(0, 16);
    if (today.seen.has(h)) return;
    today.seen.add(h);
    doc.visitors[day] = (today.base || 0) + today.seen.size;
    persist();
  }

  function stats() {
    prune();
    const byKind = {};
    let last24h = new Set();
    const cut = now() - 86400_000;
    for (const r of rows.values()) {
      byKind[r.kind] = (byKind[r.kind] || 0) + r.count;
      if (r.lastSeen > cut) last24h.add(r.address);
    }
    const day = new Date(now()).toISOString().slice(0, 10);
    const addresses = new Set([...rows.values()].map((r) => r.address)).size;
    last24h = last24h.size;
    return { rows: rows.size, addresses, last24h, byKind, visitorsToday: doc.visitors[day] || 0, visitorDays: { ...doc.visitors } };
  }

  return { note, inspect, inspectFields, list, csv, stats, seen, prune, size: () => { prune(); return rows.size; } };
}

module.exports = { createAttackLog, classifyUrl, classifyFields, isScanPath, exploitIn, csvCell, clip, KINDS, MAX_ROWS, KEEP_DAYS };
