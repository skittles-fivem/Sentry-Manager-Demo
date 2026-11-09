'use strict';

// Sets the demo up through the app's own API, as a person would in Settings:
// one vehicle per folder in the seed footage, its first scan, and (when the
// seed has CAN logs) the CAN Bridge data, uploaded the way the car's app
// uploads it. demo/seed/vehicles.json names the cars:
//
//   { "demo-car": { "name": "Demo Model 3", "timezone": "America/Chicago",
//                   "car": { "model": "3", "generation": "auto" } } }

const fs = require('fs');
const path = require('path');
const { call } = require('./internalClient');
const { uploadCan } = require('./seedCan');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForJob(api, jobId, log, what, timeoutMs = 30 * 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { jobs } = await api('GET', '/api/jobs?limit=500');
    const j = (jobs || []).find((x) => x.id === jobId);
    if (j && !['running', 'waiting', 'queued'].includes(j.status)) {
      log(`${what}: ${j.status}${j.detail ? ` (${j.detail})` : ''}`);
      return j;
    }
    await sleep(2000);
  }
  log(`${what}: still running after ${Math.round(timeoutMs / 60000)} min, carrying on`);
  return null;
}

async function seed({ port, token, seedDir, footage, log }) {
  const api = (method, p, body, opts) => call(port, token, method, p, body, opts);
  // wait for the app to answer
  for (let i = 0; i < 60; i++) {
    try {
      await api('GET', '/api/auth/me');
      break;
    } catch (err) {
      if (i === 59) throw err;
      await sleep(1000);
    }
  }
  let names = {};
  try {
    names = JSON.parse(fs.readFileSync(path.join(seedDir, 'vehicles.json'), 'utf8'));
  } catch {
    // folder names it is
  }
  const cars = fs.existsSync(footage)
    ? fs.readdirSync(footage, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort()
    : [];
  if (!cars.length) log('no vehicles to add: put footage in seed/footage/<car>/ (see README)');
  const added = [];
  for (const dir of cars) {
    const meta = names[dir] || {};
    const v = await api('POST', '/api/vehicles', {
      id: dir,
      name: meta.name || dir,
      timezone: meta.timezone || process.env.TZ || 'UTC',
      source: { type: 'path', path: path.join(footage, dir) },
      ...(meta.car ? { car: meta.car } : {})
    });
    log(`vehicle "${v.name}" added (${v.id})`);
    added.push({ ...v, meta });
  }
  // a new vehicle's folder is checked within a few seconds; scan after that
  for (let i = 0; i < 60 && added.length; i++) {
    const { vehicles } = await api('GET', '/api/vehicles');
    if (added.every((a) => vehicles.find((x) => x.id === a.id)?.share?.healthy)) break;
    await sleep(1000);
  }
  for (const v of added) {
    const { jobId } = await api('POST', `/api/vehicles/${encodeURIComponent(v.id)}/scan`);
    await waitForJob(api, jobId, log, `scan of ${v.name}`);
  }
  // A real conversion of the demo's own copy (originals replaced by H.265,
  // telemetry kept), so the Encoder shows a job and Overview shows space
  // saved. It runs in the background at one clip at a time; DEMO_CONVERT=off
  // skips it.
  if (String(process.env.DEMO_CONVERT || 'on').toLowerCase() !== 'off') {
    for (const v of added) {
      const studioRoot = (await api('GET', '/api/vehicles')).vehicles.find((x) => x.id === v.id)?.studioRoot;
      if (!studioRoot) continue;
      const out = await api('POST', '/api/converter/invoke/start', {
        sourceRoot: studioRoot, destinationRoot: null, codec: 'h265', profileId: 'balanced', networkMode: 'direct',
        outputMode: 'replace', includedGroups: ['RecentClips', 'SavedClips'], replacementConfirmed: true,
        concurrency: Number(process.env.DEMO_CONVERT_PARALLEL || 1)
      });
      log(out?.ok === false ? `conversion of ${v.name} not started: ${out.error?.code}` : `conversion of ${v.name} started`);
      // one job at a time: the next car's starts on the next reset
      break;
    }
  }
  // CAN Bridge data, when the seed has it (seed/can/<vehicleKey>/...)
  const canDir = path.join(seedDir, 'can');
  if (fs.existsSync(canDir)) {
    try {
      await uploadCan({ api, canDir, vehicles: added, log });
    } catch (err) {
      log(`CAN data: ${err.message}`);
    }
  }
}

module.exports = { seed, waitForJob };
