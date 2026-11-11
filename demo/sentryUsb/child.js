'use strict';

// The stand-in Sentry USB's process (forked by demo/sentryUsb/launcher.js,
// with an IPC channel). It asks the layer for a pairing code when it has no
// link key, and tells it when it paired. Settings: DEMO_SENTRYUSB_STATE (its
// folder, in tmpfs), DEMO_SENTRYUSB_ID, DEMO_SENTRYUSB_PORT (the manager's
// device port), DEMO_SENTRYUSB_SHUTDOWN_S.

const { createDemoSentryUsb, runDemoSentryUsb } = require('./standIn');

const env = process.env;
const pending = new Map();
let seq = 0;
const ask = (msg) => new Promise((resolve) => {
  const id = ++seq;
  pending.set(id, resolve);
  process.send({ ...msg, rid: id });
  setTimeout(() => { if (pending.delete(id)) resolve(null); }, 60_000).unref();
});
process.on('message', (m) => {
  const r = m && pending.get(m.rid);
  if (r) { pending.delete(m.rid); r(m.code || null); }
});

const pi = createDemoSentryUsb({ dir: env.DEMO_SENTRYUSB_STATE, id: env.DEMO_SENTRYUSB_ID, shutdownBackMs: Number(env.DEMO_SENTRYUSB_SHUTDOWN_S || 180) * 1000 });
const run = runDemoSentryUsb(pi, {
  host: '127.0.0.1',
  port: Number(env.DEMO_SENTRYUSB_PORT || 10000),
  getCode: ({ username, password }) => ask({ t: 'need-code', username, password }),
  onPaired: (id) => process.send({ t: 'paired', id })
});
const bye = () => { run.stop(); process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
process.on('disconnect', bye); // the manager went away (a reset): so does its Pi
