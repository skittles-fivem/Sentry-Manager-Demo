'use strict';

// The manager's archive-gap check (server/archiveGap.js) compares what the car
// did (CAN Bridge logs: driving; the clips' own speed: footage stopping while
// the car moves) with the footage on the share, and flags a day "only partly
// archived". The demo's footage is real drives cut down to highway minutes on
// purpose, so every cut looks like lost footage: Overview, the day cards and
// the notifications warned about it on every day. In the demo the check finds
// nothing: the app is handed a quiet stand-in with the same methods, before it
// loads. DEMO_ARCHIVE_GAP=on keeps the real check.

const path = require('path');

/** The stand-in: no day partial, no notification, nothing to tag. */
function quietArchiveGap() {
  const empty = () => ({ days: {}, stalled: null, signals: {}, checkedAt: Date.now() });
  return {
    check: async () => empty(),
    soon() {},
    results: async () => empty(),
    forDays: () => ({}),
    carFiles: () => null,
    indexed() {},
    forget() {}
  };
}

/** Makes the app's server/archiveGap.js hand out the stand-in (call before the app loads). Returns whether it did. */
function install(appRoot) {
  let mod;
  try { mod = require(path.join(appRoot, 'server', 'archiveGap.js')); } catch { return false; }
  if (typeof mod.createArchiveGap !== 'function') return false;
  if (!mod.createArchiveGap.demoQuiet) {
    const quiet = function createArchiveGap() { return quietArchiveGap(); };
    quiet.demoQuiet = true;
    mod.createArchiveGap = quiet;
  }
  return true;
}

module.exports = { install, quietArchiveGap };
