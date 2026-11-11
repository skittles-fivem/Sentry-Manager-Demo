'use strict';

// Rate limits (fixed windows, in memory) and bans (kept in the demo's state,
// demo/store.js, so a reset does not lift them), both by the real client
// address (demo/clientAddress.js; IPv6 by its /64).

const { banKey, normalizeIp } = require('./clientAddress');

/**
 * limits: { name: [max, windowMs] }. take(name, key) counts one and returns
 * 0, or the seconds to wait when over; `first` is true only for the first
 * request over the limit in a window (to note it once).
 */
function createRateLimits(limits, { now = () => Date.now(), maxKeys = 50_000 } = {}) {
  const hits = new Map(); // "name|key" -> { n, until }
  function take(name, key) {
    const [max, windowMs] = limits[name];
    const t = now();
    const k = `${name}|${key}`;
    let h = hits.get(k);
    if (!h || h.until <= t) {
      if (hits.size >= maxKeys) for (const [kk, v] of hits) if (v.until <= t) hits.delete(kk);
      if (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
      h = { n: 0, until: t + windowMs };
      hits.set(k, h);
    }
    h.n += 1;
    if (h.n <= max) return { wait: 0, first: false };
    return { wait: Math.max(1, Math.ceil((h.until - t) / 1000)), first: h.n === max + 1 };
  }
  /** Whether one more would be over, without counting it. */
  function full(name, key) {
    const h = hits.get(`${name}|${key}`);
    return Boolean(h && h.until > now() && h.n >= limits[name][0]);
  }
  return { take, full, limits };
}

const BAN_DAYS = 30;

function createBans({ store, now = () => Date.now() }) {
  const doc = store.load('bans', null) || {};
  const bans = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
  const save = () => store.save('bans', bans);
  function prune() {
    const t = now();
    for (const [k, b] of Object.entries(bans)) if (!b || b.until <= t) delete bans[k];
  }
  return {
    banned(ip) {
      const b = bans[banKey(ip)];
      return Boolean(b && b.until > now());
    },
    ban(ip, reason = 'banned from the owner page', days = BAN_DAYS) {
      const a = normalizeIp(ip);
      if (!a) throw Object.assign(new Error('Not an address.'), { status: 400 });
      const key = banKey(a);
      bans[key] = { until: now() + days * 86400_000, reason: String(reason).slice(0, 120), at: now() };
      prune();
      save();
      return { key, ...bans[key] };
    },
    unban(key) {
      const had = Boolean(bans[key]);
      delete bans[key];
      save();
      return had;
    },
    list() {
      prune();
      return Object.entries(bans).map(([key, b]) => ({ key, ...b })).sort((a, b) => b.at - a.at);
    },
    keyOf: banKey
  };
}

module.exports = { createRateLimits, createBans, BAN_DAYS };
