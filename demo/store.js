'use strict';

// What the demo keeps across its resets: the attack log, bans, visitor
// counts, feedback limits, the owner page's secret, the imported seed and
// the certificates. It lives in DEMO_STATE (default /demo-state, a small
// volume in docker-compose.yml); everything else is in tmpfs and starts over.
// Without a writable DEMO_STATE the layer still runs and keeps all of this in
// memory only (the owner page says so).
//
// Each document is one JSON file, replaced atomically (written next to it,
// then renamed), at most every `delayMs` and when the process ends.

const fs = require('fs');
const path = require('path');

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

function writeAtomic(file, text, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

function createStore({ dir = process.env.DEMO_STATE || '/demo-state', delayMs = 5000, log = () => {} } = {}) {
  const ok = writable(dir);
  const docs = new Map(); // name -> { value, dirty }
  let timer = null;
  const file = (name) => path.join(dir, `${name}.json`);

  function load(name, fallback) {
    if (docs.has(name)) return docs.get(name).value;
    let value = fallback;
    if (ok) {
      try {
        value = JSON.parse(fs.readFileSync(file(name), 'utf8'));
      } catch {
        // none yet, or unreadable: start from the fallback
      }
    }
    docs.set(name, { value, dirty: false });
    return value;
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!ok) return;
    for (const [name, d] of docs) {
      if (!d.dirty) continue;
      try {
        writeAtomic(file(name), JSON.stringify(d.value));
        d.dirty = false;
      } catch (err) {
        log(`could not keep ${name}: ${err.code || err.message}`);
      }
    }
  }

  /** Marks a document changed (the value is the one load() returned, changed in place, or a new one). */
  function save(name, value) {
    const d = docs.get(name) || { value, dirty: false };
    if (value !== undefined) d.value = value;
    d.dirty = true;
    docs.set(name, d);
    if (!timer) {
      timer = setTimeout(flush, delayMs);
      timer.unref?.();
    }
  }

  return { dir, writable: ok, load, save, flush, path: (...p) => path.join(dir, ...p) };
}

module.exports = { createStore, writeAtomic, writable };
