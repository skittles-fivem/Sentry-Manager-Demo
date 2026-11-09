'use strict';

// What a demo visitor may do. Everything is readable except the parts that
// would show the demo host's own details (logs, sessions, certificates,
// nodes, CAN tokens). Of the requests that change something, only the ones
// that change nothing kept on the server are let through: the Viewer's file
// reads (sent as POST), the Encoder's status calls, telemetry lookups, and
// exports (rendered into a file that is gone after a day or the next reset).
// Anything not listed below is refused, so a new route upstream is refused
// until it is added here on purpose.

const READ_POSTS = [
  // the Viewer reads folders and files with POST
  /^\/api\/studio\/(browse|readDir|readFile|exists|stat|thumbnail)$/,
  // the Encoder page's status calls: what is running, what this server can do
  /^\/api\/converter\/invoke\/(subscribeProgress|unsubscribeProgress|getCurrent|getCapabilities|getAuto|devices)$/,
  // speeds for a list of clips (a lookup, nothing saved)
  /^\/api\/telemetry\/speeds$/,
  // what a Recycle Bin policy would move, without moving it
  /^\/api\/vehicles\/[^/]+\/trash-preview$/
];

// Exports: allowed, but the gate also checks the queue (exportsBusy).
const EXPORT_POSTS = [/^\/api\/exports$/, /^\/api\/vehicles\/[^/]+\/exports$/];
const EXPORT_CANCEL = /^\/api\/exports\/[^/]+$/;

// Reads that show the host, not the manager: answered with empty stand-ins.
const HIDDEN_GETS = [
  /^\/api\/logs(\/|$)/,
  /^\/api\/support-bundle(\/|$)/,
  /^\/api\/security(\/|$)/,
  /^\/api\/accounts(\/|$)/,
  /^\/api\/metrics(\/|$)/,
  /^\/api\/snapshots(\/|$)/,
  /^\/api\/nodes(\/|$)/,
  /^\/api\/auth\/(sessions|2fa)(\/|$)/,
  /^\/api\/can\/(settings|files|tokens|pairing|export)(\/|$)/
];

// Preferences the pages save as they go (the Viewer's layout, a dashboard's
// tiles): answered "saved" without saving, so the pages carry on quietly. The
// change lasts until the page is reloaded.
const QUIET_WRITES = [
  /^POST \/api\/studio\/settings$/,
  /^PUT \/api\/dashboards$/
];

const REFUSED = 'This is a demo, so changes are turned off. Everything else works as it does at home.';

/**
 * The verdict for one request: { ok: true }, { ok: true, export: true } (let
 * through if the export queue has room), or { ok: false, status, error,
 * stand-in } for a refusal.
 */
function decide(method, rawPath) {
  const m = String(method || '').toUpperCase();
  const p = String(rawPath || '');
  if (!p.startsWith('/api/')) return { ok: true };
  if (m === 'GET' || m === 'HEAD') {
    if (HIDDEN_GETS.some((re) => re.test(p))) return { ok: false, status: 200, hidden: true };
    return { ok: true };
  }
  if (QUIET_WRITES.some((re) => re.test(`${m} ${p}`))) return { ok: false, status: 200, quiet: true };
  if (m === 'POST' && READ_POSTS.some((re) => re.test(p))) return { ok: true };
  if (m === 'POST' && EXPORT_POSTS.some((re) => re.test(p))) return { ok: true, export: true };
  if (m === 'DELETE' && EXPORT_CANCEL.test(p)) return { ok: true };
  return { ok: false, status: 403, error: REFUSED };
}

/** What a hidden read answers instead: empty, so pages draw without errors. */
function standIn(rawPath) {
  const p = String(rawPath || '');
  if (/^\/api\/logs\/archive$/.test(p)) return { archives: [] };
  if (/^\/api\/logs\/search/.test(p)) return { lines: [], matches: 0 };
  if (/^\/api\/logs/.test(p)) return { lines: [], demo: true };
  if (/^\/api\/accounts/.test(p)) return { accounts: [{ username: 'demo', role: 'admin', twoFactor: false }] };
  if (/^\/api\/snapshots/.test(p)) return { snapshots: [], keep: 7 };
  if (/^\/api\/nodes/.test(p)) return { nodes: [], worker: null, demo: true };
  if (/^\/api\/auth\/sessions/.test(p)) return { sessions: [] };
  if (/^\/api\/auth\/2fa/.test(p)) return { enabled: false, recoveryLeft: 0 };
  if (/^\/api\/metrics/.test(p)) return { enabled: false };
  if (/^\/api\/security/.test(p)) return { demo: true, https: true, hostnames: [], tls: null };
  if (/^\/api\/can\/settings/.test(p)) return { enabled: false, demo: true };
  return { demo: true };
}

module.exports = { decide, standIn, REFUSED, HIDDEN_GETS, READ_POSTS };
