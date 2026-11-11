'use strict';

// Starts the stand-in Sentry USB (child.js) once the manager is set up, and
// pairs it the way a person would in Settings -> Sentry USB: a pairing slot
// opened through the manager's own API on localhost (demo/internalClient.js),
// whose code the stand-in then proves it knows over the device port. Its id
// is made here, so the gate (demo/policy.js) knows from the start which Pi
// visitors may change. The child is started again if it stops; it goes with
// the manager at every reset (its state is in /data, in tmpfs).

const crypto = require('crypto');
const path = require('path');
const { fork } = require('child_process');
const { available } = require('./link');

const NAME = 'Demo Model Y';

/**
 * o: api(method, path, body) (the layer's internal calls), port (the device
 * port), stateDir, log, app (the manager's folder), env (extra for the child).
 * Returns null when this manager has no Sentry USB link, else { id, paired, stop }.
 */
function startStandIn({ api, port, stateDir, log = () => {}, app = process.env.APP_ROOT || '/app', name = NAME, shutdownSeconds = 180 }) {
  if (!available(app)) {
    log('Sentry USB stand-in: this manager image has no Sentry USB link (MANAGER_TAG with it, see README); not started');
    return null;
  }
  const id = crypto.randomBytes(16).toString('hex');
  let child = null;
  let stopped = false;
  let paired = false;
  let restarts = 0;

  async function code({ username, password }) {
    const out = await api('POST', '/api/sentryusb/pair', { name, username, password });
    return out?.pairing?.code || null;
  }

  function spawn() {
    if (stopped) return;
    // the child gets only what it needs (no owner password or webhook: those were never in process.env past start)
    const env = { ...process.env, APP_ROOT: app, DEMO_SENTRYUSB_STATE: stateDir, DEMO_SENTRYUSB_ID: id, DEMO_SENTRYUSB_PORT: String(port), DEMO_SENTRYUSB_SHUTDOWN_S: String(shutdownSeconds) };
    child = fork(path.join(__dirname, 'child.js'), [], { env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child.on('message', async (m) => {
      if (m?.t === 'need-code') {
        let c = null;
        try {
          c = await code(m);
        } catch (err) {
          if (err.data?.code === 'NO_HTTPS') {
            // TLS_MODE=off: a Pi pins the device port's certificate, so there is nothing to pair with
            log('Sentry USB stand-in: the manager runs without its own HTTPS (TLS_MODE=off), so a Sentry USB cannot pair; not started');
            stopped = true;
            child?.kill('SIGTERM');
            return;
          }
          log(`Sentry USB stand-in: pairing slot not opened: ${err.message}`);
        }
        if (child?.connected) child.send({ rid: m.rid, code: c });
      }
      if (m?.t === 'paired' && m.id === id) {
        paired = true;
        log(`Sentry USB stand-in "${name}" paired`);
      }
    });
    child.on('exit', (codeNum, signal) => {
      child = null;
      if (stopped) return;
      restarts += 1;
      const wait = Math.min(60_000, 2000 * restarts);
      log(`Sentry USB stand-in stopped (${signal || codeNum}); starting it again in ${Math.round(wait / 1000)} s`);
      setTimeout(spawn, wait).unref();
    });
  }
  spawn();
  return {
    id,
    get paired() { return paired; },
    stop() { stopped = true; child?.kill('SIGTERM'); }
  };
}

module.exports = { startStandIn, NAME };
