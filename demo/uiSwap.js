'use strict';

// "Swap to Horizon UI" in the demo note: one browser sees the Horizon
// interface pack (built in with the app), everyone else what they saw. It is
// per browser only, a cookie (demo_ui=horizon): the app's chosen interface
// (uiPacks.setActive, PUT /api/ui-packs/active) is never touched, and the
// policy keeps refusing that route, so no visitor changes what others see.
//
// How, without changing the app: the app makes its interface packs with
// server/uiPacks.js createUiPacks(), and asks the result for active() and
// root(kind) while it serves a page. The layer wraps createUiPacks (before
// the app loads it) so those two answer "Horizon" inside a request from a
// browser with the cookie: the gate runs each request in an
// AsyncLocalStorage context that says which interface it asked for. The
// same way the app's own /original cookie gives one browser the built-in
// interface.
//
// POST /demo/ui {"ui": "horizon" | "original"} sets or clears the cookie.

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const COOKIE = 'demo_ui';
const PACK = 'horizon';
const UIS = ['horizon', 'original'];

const context = new AsyncLocalStorage();

/** The interface this request's browser asked for: 'horizon' or null (the app's own choice). */
function uiOf(req) {
  const m = /(?:^|;\s*)demo_ui=([a-z]{1,20})(?:;|$)/.exec(String(req?.headers?.cookie || ''));
  return m && m[1] === PACK ? PACK : null;
}

/** Runs fn with this request's interface known to the wrapped packs. */
const runFor = (req, fn) => context.run({ ui: uiOf(req) }, fn);

/**
 * Wraps a createUiPacks result: inside a request with the cookie, active()
 * is the Horizon pack and root(kind) its folder; everything else (setActive
 * included, and every request without the cookie) is the app's own.
 */
function wrapPacks(packs, { builtinDir }) {
  const horizonRoot = builtinDir ? path.join(builtinDir, PACK) : null;
  const hasHorizon = () => Boolean(horizonRoot) && packs.list().some((p) => p.id === PACK && p.builtin);
  const wanted = () => context.getStore()?.ui === PACK && hasHorizon();
  return {
    ...packs,
    active() {
      return wanted() ? PACK : packs.active();
    },
    root(kind) {
      if (!wanted()) return packs.root(kind);
      const folder = path.join(horizonRoot, String(kind));
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

/** The Set-Cookie for a choice ('horizon' sets it, 'original' clears it). */
function cookieFor(ui, secure) {
  const flags = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  return ui === PACK ? `${COOKIE}=${PACK}; ${flags}; Max-Age=${30 * 86400}` : `${COOKIE}=; ${flags}; Max-Age=0`;
}

/** POST /demo/ui: { status, body, cookie } for a parsed body (only "horizon" or "original"). */
function choose(body, { secure }) {
  const ui = body && typeof body === 'object' ? body.ui : null;
  if (typeof ui !== 'string' || !UIS.includes(ui)) return { status: 400, body: { error: 'ui is "horizon" or "original".' } };
  return { status: 200, body: { ok: true, ui }, cookie: cookieFor(ui, secure) };
}

module.exports = { uiOf, runFor, wrapPacks, install, choose, cookieFor, context, COOKIE, PACK };
