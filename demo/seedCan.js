'use strict';

// The demo's CAN Bridge data, sent the way the car's app sends it
// (docs/can-bridge-api.md upstream): uploads on, a token for the car,
// each log and sidecar uploaded, the car key tied to its vehicle, uploads
// off again (so the CAN port is closed for visitors). The sanitizer removes
// the signatures (the logs were changed: VIN frames and times), so the logs
// count as unsigned from an unpaired car, which the app uses.
//
//   seed/can/<vehicleKey>/<vehicleKey>_<UTC>_<seq>.log.xz (+ .json)
//   seed/can/map.json   { "<vehicleKey>": "<vehicle folder name>" }

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadCan({ api, canDir, vehicles, log }) {
  const keys = fs.readdirSync(canDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (!keys.length) return;
  let map = {};
  try { map = JSON.parse(fs.readFileSync(path.join(canDir, 'map.json'), 'utf8')); } catch { /* first vehicle */ }
  const vehicleFor = (key) => vehicles.find((v) => v.id === map[key]) || vehicles[0];

  const on = await api('POST', '/api/can/enable', { vehicleId: vehicleFor(keys[0])?.id });
  try {
    for (const key of keys) {
      const v = vehicleFor(key);
      const made = on.token && key === keys[0] ? { token: on.token } : await api('POST', '/api/can/tokens', { vehicleId: v?.id, label: `demo ${key}` });
      const auth = { Authorization: `Bearer ${made.token}`, 'X-Forwarded-Proto': 'https' };
      const files = fs.readdirSync(path.join(canDir, key)).filter((n) => n.endsWith('.log.xz') || n.endsWith('.log.xz.json')).sort();
      let sent = 0;
      for (const name of files) {
        const bytes = fs.readFileSync(path.join(canDir, key, name));
        const sha = crypto.createHash('sha256').update(bytes).digest('hex');
        for (let off = 0; off < bytes.length || off === 0; off += 16 * 1024 * 1024) {
          const chunk = bytes.subarray(off, off + 16 * 1024 * 1024);
          await api('POST', `/api/can/logs/${encodeURIComponent(name)}`, undefined, {
            raw: chunk,
            headers: { ...auth, 'Upload-Offset': String(off), 'Upload-Length': String(bytes.length), 'Upload-SHA256': sha }
          });
          if (!bytes.length) break;
        }
        sent += 1;
      }
      if (v) await api('POST', '/api/can/vehicle-map', { key, vehicleId: v.id });
      log(`CAN data: ${sent} files of ${key} uploaded${v ? ` for ${v.name}` : ''}`);
    }
  } finally {
    // the uploaded logs stay; the port and the upload API close
    await sleep(500);
    await api('POST', '/api/can/disable').catch((err) => log(`CAN uploads off: ${err.message}`));
  }
}

module.exports = { uploadCan };
