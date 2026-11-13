'use strict';

// One browser's own interface: "Swap to Horizon UI" in the demo note, and
// "Use this interface" in the app's own Settings > Look & interface. That
// browser sees the chosen built-in interface pack (Horizon, Aurora, Daylight,
// Flux), everyone else what they saw. It is per browser only, a cookie
// (demo_ui=<pack id>): the app's chosen interface (uiPacks.setActive) is
// never touched, so no visitor changes what others see, and there is no
// password to ask for.
//
// How, without changing the app: the app makes its interface packs with
// server/uiPacks.js createUiPacks(), and asks the result for active() and
// root(kind) while it serves a page. The layer wraps createUiPacks (before
// the app loads it) so those two answer the browser's pack inside a request
// from a browser with the cookie: the gate runs each request in an
// AsyncLocalStorage context that says which interface it asked for. The
// same way the app's own /original cookie gives one browser the built-in
// interface.
//
// POST /demo/ui {"ui": "<built-in pack id>" | "original"} sets or clears the
// cookie; so does the app's PUT /api/ui-packs/active {id} from a visitor
// (demo/preload.js), "original" or null being the interface everyone has.

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const COOKIE = 'demo_ui';
const PACK = 'horizon'; // the demo note's Swap button
const ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

const context = new AsyncLocalStorage();
// the built-in packs the app has (from the wrapped createUiPacks); Horizon until it is known
let builtins = new Set([PACK]);
// the pack everyone has (its own id, or null for the app's built-in interface)
let everyones = () => null;

/** Whether id is a built-in pack this browser may have. */
const isPack = (id) => typeof id === 'string' && ID_RE.test(id) && builtins.has(id);

/** The interface this request's browser asked for: a built-in pack's id, or null (the app's own choice). */
function uiOf(req) {
  const m = /(?:^|;\s*)demo_ui=([a-z0-9-]{1,40})(?:;|$)/.exec(String(req?.headers?.cookie || ''));
  return m && isPack(m[1]) && m[1] !== everyones() ? m[1] : null;
}

/** Runs fn with this request's interface known to the wrapped packs. */
const runFor = (req, fn) => context.run({ ui: uiOf(req) }, fn);

/**
 * Wraps a createUiPacks result: inside a request with the cookie, active()
 * is that pack and root(kind) its folder; everything else (setActive
 * included, and every request without the cookie) is the app's own.
 */
function wrapPacks(packs, { builtinDir }) {
  const learn = () => {
    try {
      const ids = packs.list().filter((p) => p.builtin && ID_RE.test(String(p.id))).map((p) => p.id);
      if (builtinDir) builtins = new Set(ids.filter((id) => fs.existsSync(path.join(builtinDir, id))));
    } catch { /* keep what was known */ }
  };
  learn();
  everyones = () => { try { return packs.active() || null; } catch { return null; } };
  const wanted = () => {
    const ui = context.getStore()?.ui;
    return ui && builtinDir && isPack(ui) ? ui : null;
  };
  return {
    ...packs,
    list(...a) { const out = packs.list(...a); learn(); return out; },
    active() {
      return wanted() || packs.active();
    },
    root(kind) {
      const ui = wanted();
      if (!ui) return packs.root(kind);
      const folder = path.join(builtinDir, ui, String(kind));
      return /^[a-z]+$/.test(String(kind)) && fs.existsSync(folder) ? folder : null;
    }
  };
}

/** Makes the app's server/uiPacks.js hand out wrapped packs (call before the app loads). */
function install(appRoot) {
  const mod = require(path.join(appRoot, 'server', 'uiPacks.js'));
  if (mod.createUiPacks.demoWrapped) return mod;
  const original = mod.createUiPacks;
  const wrapped = function createUiPacks(o = {}) {
    return wrapPacks(original.call(this, o), { builtinDir: o.builtinDir || null });
  };
  wrapped.demoWrapped = true;
  mod.createUiPacks = wrapped;
  return mod;
}

/** The Set-Cookie for a choice (a pack's id sets it, 'original' clears it). */
function cookieFor(ui, secure) {
  const flags = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  return isPack(ui) && ui !== everyones() ? `${COOKIE}=${ui}; ${flags}; Max-Age=${30 * 86400}` : `${COOKIE}=; ${flags}; Max-Age=0`;
}

/** A choice: { status, body, cookie }. ui: a built-in pack's id, or "original" / null for everyone's interface. */
function chooseUi(ui, { secure }) {
  if (ui === null || ui === 'original' || ui === everyones()) return { status: 200, body: { ok: true, ui: 'original', active: everyones() }, cookie: cookieFor('original', secure) };
  if (!isPack(ui)) return { status: 400, body: { error: 'Choose one of the built-in interfaces.' } };
  return { status: 200, body: { ok: true, ui, active: ui }, cookie: cookieFor(ui, secure) };
}

/** POST /demo/ui: { status, body, cookie } for a parsed body ({ ui }). */
function choose(body, { secure }) {
  const ui = body && typeof body === 'object' && !Array.isArray(body) ? body.ui : undefined;
  if (typeof ui !== 'string') return { status: 400, body: { error: 'ui is a built-in interface or "original".' } };
  return chooseUi(ui, { secure });
}

/** PUT /api/ui-packs/active from a visitor ({ id }): this browser only, as the app's answer. */
function chooseActive(body, { secure }) {
  const id = body && typeof body === 'object' && !Array.isArray(body) ? body.id ?? null : undefined;
  if (id !== null && typeof id !== 'string') return { status: 400, body: { error: 'Choose an interface.' } };
  const out = chooseUi(id, { secure });
  return out.status === 200 ? { ...out, body: { ok: true, active: out.body.active } } : out;
}

module.exports = { uiOf, runFor, wrapPacks, install, choose, chooseActive, cookieFor, context, COOKIE, PACK };
