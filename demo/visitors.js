'use strict';

// Visitor activity for the owner page (demo/owner.js): one record per real
// client address (demo/clientAddress.js), from what the demo's tracker
// (demo/track.js) sends to POST /api/demo/track, plus what the server sees
// itself (a change the demo refused, feedback sent).
//
// Kept: first and last seen, visits (a new one after 30 minutes idle), time
// actively in the demo (only while the tab is visible, from heartbeats every
// ~15 s, never more than the server's own clock allows), time per interface,
// swaps, pages opened, labels of the controls used (never what was typed),
// device summary, country (Cloudflare's CF-IPCountry, only through
// Cloudflare), feedback sent (a count; the text stays in Discord) and the last
// 200 events. At most 2000 visitors, none idle for more than 30 days. Kept in
// the demo's state (demo/store.js), so a reset does not clear it.

const fs = require('fs');
const path = require('path');

const MAX_VISITORS = 2000;
const MAX_EVENTS = 200;
const KEEP_DAYS = 30;
const VISIT_GAP_MS = 30 * 60_000;
const MAX_POST_EVENTS = 60;
const MAX_BEAT_MS = 20_000; // a heartbeat every ~15 s: at most this much counts
const MAX_LABEL = 60;
const MAX_PAGES = 80;
const MAX_CLICKS = 150;
const UIS = ['original', 'horizon'];
const TYPES = ['view', 'beat', 'click', 'swap', 'device', 'here', 'leave'];
// a visitor counts as live while the tracker was heard from this recently (a hidden tab may only say so once a minute)
const LIVE_MS = 75_000;
const CONTROL_KINDS = ['button', 'link', 'input', 'select', 'tab'];

// The main pages of each interface (their nav), read from the app when it is
// there (web/index.html's #nav for the original, Horizon's PAGES in
// examples/ui-packs/horizon/web/hz/main.js), else these.
const ROUTES = {
  original: ['overview', 'footage', 'viewer', 'encoder', 'policies', 'jobs', 'bin', 'notifications', 'sentryusb', 'health', 'account', 'settings'],
  horizon: ['dashboard', 'footage', 'viewer', 'encoder', 'policies', 'jobs', 'bin', 'alerts', 'sentryusb', 'health', 'account', 'settings']
};
const STUDIO = ['viewer', 'encoder']; // /studio/index.html (the Viewer) and /studio/encoder.html

/** The nav routes of both interfaces in the app at appRoot (missing ones: the built-in lists). */
function readRoutes(appRoot) {
  const out = { original: ROUTES.original.slice(), horizon: ROUTES.horizon.slice() };
  if (!appRoot) return out;
  const uniq = (a) => [...new Set(a)].filter((r) => /^[a-z][a-z0-9-]{0,30}$/.test(r));
  try {
    const html = fs.readFileSync(path.join(appRoot, 'web', 'index.html'), 'utf8');
    const nav = /id="nav"[\s\S]*?<\/nav>/.exec(html)?.[0] || '';
    const r = uniq([...nav.matchAll(/data-route="([^"]+)"/g)].map((m) => m[1]));
    if (r.length >= 3) out.original = r;
  } catch { /* the built-in list */ }
  try {
    const js = fs.readFileSync(path.join(appRoot, 'examples', 'ui-packs', 'horizon', 'web', 'hz', 'main.js'), 'utf8');
    const block = /export const PAGES = \[([\s\S]*?)\n\];/.exec(js)?.[1] || '';
    const r = uniq([...block.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1]));
    if (r.length >= 3) out.horizon = r;
  } catch { /* the built-in list */ }
  return out;
}

/** Every main page as "ui:route", plus the two Studio pages. */
const allPages = (routes) => [...UIS.flatMap((ui) => routes[ui].map((r) => `${ui}:${r}`)), ...STUDIO.map((s) => `studio:${s}`)];

/** A label: plain text, control and invisible characters gone, spaces collapsed, at most MAX_LABEL. */
function cleanLabel(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
}
const shortText = (v, n = 80) => (typeof v === 'string' ? cleanLabel(v).slice(0, n) : '');

/** The device summary from window.sentryDemoDevice(): OS, browser, model, touch only. */
function deviceSummary(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return '';
  const touch = typeof d.touch === 'string' && /^yes/.test(d.touch) ? 'touch' : '';
  return [shortText(d.os, 40), shortText(String(d.browser || '').split(',')[0], 60), shortText(d.model, 30), touch].filter(Boolean).join(' · ').slice(0, 160);
}

/**
 * Validates one event from the tracker; null when it is not one. Events are
 * [type, ...] objects: { type: 'view', page }, { type: 'beat', ui, ms },
 * { type: 'click', kind, label }, { type: 'swap', to }, { type: 'device', device }.
 */
function validEvent(e, pages) {
  if (!e || typeof e !== 'object' || Array.isArray(e) || !TYPES.includes(e.type)) return null;
  switch (e.type) {
    case 'view': return typeof e.page === 'string' && pages.has(e.page) ? { type: 'view', page: e.page } : null;
    case 'beat': {
      const ms = Number(e.ms);
      if (!UIS.includes(e.ui) || !Number.isFinite(ms) || ms <= 0) return null;
      return { type: 'beat', ui: e.ui, ms: Math.min(Math.round(ms), MAX_BEAT_MS) };
    }
    case 'click': {
      const label = cleanLabel(e.label);
      if (!label || !CONTROL_KINDS.includes(e.kind)) return null;
      return { type: 'click', kind: e.kind, label };
    }
    case 'swap': return UIS.includes(e.to) ? { type: 'swap', to: e.to } : null;
    case 'device': { const device = deviceSummary(e.device); return device ? { type: 'device', device } : null; }
    case 'here': return typeof e.page === 'string' && pages.has(e.page) ? { type: 'here', page: e.page, visible: e.visible === true } : null;
    case 'leave': return { type: 'leave' };
    default: return null;
  }
}

/** Validates a whole post: { events: [...] } with at most MAX_POST_EVENTS; null when it is not one. */
function validPost(body, pages) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.events)) return null;
  if (body.events.length === 0 || body.events.length > MAX_POST_EVENTS) return null;
  const events = body.events.map((e) => validEvent(e, pages)).filter(Boolean);
  return events.length ? events : null;
}

/**
 * o: store, routes ({ original, horizon }), now, and the caps (for tests).
 */
function createVisitors({ store, routes = ROUTES, now = () => Date.now(), maxVisitors = MAX_VISITORS, maxEvents = MAX_EVENTS, keepDays = KEEP_DAYS } = {}) {
  const PAGES = allPages(routes);
  const pageSet = new Set(PAGES);
  const loaded = store.load('visitors', null);
  const doc = loaded && typeof loaded === 'object' && loaded.v && typeof loaded.v === 'object' ? loaded : { v: {} };
  const v = doc.v;
  const save = () => store.save('visitors', doc);

  function prune() {
    const cutoff = now() - keepDays * 86400_000;
    for (const [ip, r] of Object.entries(v)) if (!r || r.last < cutoff) delete v[ip];
    const ips = Object.keys(v);
    if (ips.length > maxVisitors) {
      ips.sort((a, b) => v[a].last - v[b].last);
      for (const ip of ips.slice(0, ips.length - maxVisitors)) delete v[ip];
    }
  }

  /** The record for ip, made when `create`; a new visit after 30 minutes idle. */
  function touch(ip, create) {
    const t = now();
    let r = v[ip];
    if (!r) {
      if (!create) return null;
      if (Object.keys(v).length >= maxVisitors) prune();
      if (Object.keys(v).length >= maxVisitors) {
        // the one idle longest goes
        let oldest = null;
        for (const [k, x] of Object.entries(v)) if (!oldest || x.last < v[oldest].last) oldest = k;
        if (oldest) delete v[oldest];
      }
      r = v[ip] = { first: t, last: t, visits: 1, active: 0, time: { original: 0, horizon: 0 }, swaps: 0, pages: {}, clicks: {}, blocked: 0, feedback: 0, device: '', country: '', events: [[t, 'visit', '1']], beatAt: 0 };
      return r;
    }
    if (t - r.last > VISIT_GAP_MS) {
      r.visits += 1;
      r.beatAt = 0;
      push(r, t, 'visit', String(r.visits));
    }
    r.last = Math.max(r.last, t);
    return r;
  }
  function push(r, t, type, detail) {
    r.events.push([t, type, detail]);
    if (r.events.length > maxEvents) r.events.splice(0, r.events.length - maxEvents);
  }
  const bump = (map, key, cap) => {
    if (map[key] === undefined && Object.keys(map).length >= cap) return;
    map[key] = (map[key] || 0) + 1;
  };

  /**
   * A post from the tracker: { status, body }. The address and time are the
   * server's; country only as given by the caller (Cloudflare's header).
   */
  function record(ip, body, { country = '' } = {}) {
    if (!ip || ip === '?') return { status: 400, body: { ok: false } };
    const events = validPost(body, pageSet);
    if (!events) return { status: 400, body: { ok: false } };
    const r = touch(ip, true);
    const t = now();
    if (/^[A-Z]{2}$/.test(country) && country !== 'XX') r.country = country;
    r.heardAt = t;
    for (const e of events) {
      if (e.type === 'here') {
        r.here = { page: e.page, visible: e.visible, at: t };
      } else if (e.type === 'leave') {
        r.leftAt = t;
      } else if (e.type === 'beat') {
        // never more than the server's clock since the last heartbeat (plus a little)
        const allowed = r.beatAt ? Math.max(0, t - r.beatAt + 2000) : MAX_BEAT_MS;
        const ms = Math.min(e.ms, allowed);
        r.beatAt = t;
        r.active += ms;
        r.time[e.ui] = (r.time[e.ui] || 0) + ms;
      } else if (e.type === 'view') {
        bump(r.pages, e.page, MAX_PAGES);
        push(r, t, 'view', e.page);
      } else if (e.type === 'click') {
        bump(r.clicks, `${e.kind}|${e.label}`, MAX_CLICKS);
        push(r, t, 'click', `${e.kind}|${e.label}`);
      } else if (e.type === 'swap') {
        r.swaps += 1;
        push(r, t, 'swap', e.to);
      } else if (e.type === 'device') {
        if (r.device !== e.device) push(r, t, 'device', e.device);
        r.device = e.device;
      }
    }
    save();
    return { status: 200, body: { ok: true } };
  }

  /** A change the demo refused (policy 403), for a visitor already known. */
  function blocked(ip, what) {
    const r = touch(ip, false);
    if (!r) return;
    r.blocked += 1;
    push(r, now(), 'blocked', shortText(what, 120));
    save();
  }
  /** Feedback sent (only that it was: the text stays in Discord). */
  function feedback(ip) {
    const r = touch(ip, true);
    r.feedback += 1;
    push(r, now(), 'feedback', '');
    save();
  }

  /** The pages of the interfaces this visitor used (and the Studio pages) they never opened. */
  function neverOpened(r) {
    const used = UIS.filter((ui) => (r.time?.[ui] || 0) > 0 || Object.keys(r.pages || {}).some((p) => p.startsWith(`${ui}:`)));
    const wanted = PAGES.filter((p) => p.startsWith('studio:') || used.some((ui) => p.startsWith(`${ui}:`)));
    return wanted.filter((p) => !r.pages?.[p]);
  }

  /** Whether the visitor has the demo open now, where, and since when (this visit). */
  function liveOf(r) {
    const t = now();
    const live = Boolean(r.heardAt) && t - r.heardAt < LIVE_MS && !(r.leftAt && r.leftAt >= r.heardAt);
    if (!live) return { live: false };
    let since = r.first;
    for (const [at, type] of r.events) if (type === 'visit') since = at;
    let pageNow = r.here?.page || '';
    if (!pageNow) for (const [, type, detail] of r.events) if (type === 'view') pageNow = detail;
    return { live: true, pageNow, away: r.here ? !r.here.visible : false, since };
  }

  /** Every visitor, newest first, without the events. */
  function list() {
    prune();
    return Object.entries(v).sort((a, b) => b[1].last - a[1].last).map(([ip, r]) => {
      const never = neverOpened(r);
      return {
        ip, first: r.first, last: r.last, visits: r.visits, active: r.active, time: { ...r.time }, swaps: r.swaps, pages: { ...r.pages },
        clicks: { ...r.clicks }, blocked: r.blocked, feedback: r.feedback, device: r.device, country: r.country, never, sawAll: never.length === 0,
        events: r.events.length, ...liveOf(r)
      };
    });
  }
  /** One visitor's last events, oldest first. */
  function events(ip) {
    const r = v[ip];
    return r ? r.events.map(([t, type, detail]) => ({ t, type, detail })) : null;
  }

  return { record, blocked, feedback, list, events, neverOpened, prune, pages: PAGES, routes, count: () => Object.keys(v).length };
}

module.exports = {
  createVisitors, readRoutes, validEvent, validPost, cleanLabel, deviceSummary, allPages,
  ROUTES, STUDIO, MAX_VISITORS, MAX_EVENTS, MAX_POST_EVENTS, VISIT_GAP_MS, MAX_BEAT_MS
};
