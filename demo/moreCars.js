'use strict';

// More cars for the demo, made from the owner's own footage only: each extra
// car gets a different slice of the main car's clips (other days, or other
// minutes when there is one day), as hard links into the demo's live footage
// folder (same disk: no extra space; a copy only where a link fails). One
// minute of each car (the main one too) is also filed as a Saved or Sentry
// event, linked as the car copies it, so those views and the Recycle Bin
// have something. Nothing is written to the seed or to /demo-import,
// and no video is made: with no footage of the owner's, there are no extra
// cars either. Built again at every start, like the rest of the live folder.

const fs = require('fs');
const path = require('path');

const CLIP = /^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})-[a-z_]+\.mp4$/;

// id, name, car model, and which kind of event its one event minute becomes
const EXTRA_CARS = [
  { id: 'demo-model-3', name: 'Demo Model 3', car: { model: '3', generation: 'auto' }, event: 'SavedClips', reason: 'user_interaction_dashcam_icon_tapped' },
  { id: 'demo-model-s', name: 'Demo Model S', car: { model: 'S', generation: 'auto' }, event: 'SentryClips', reason: 'sentry_aware_object_detection' },
  { id: 'demo-model-x', name: 'Demo Model X', car: { model: 'X', generation: 'auto' }, event: 'SentryClips', reason: 'sentry_aware_object_detection' }
];

/** The clips of a car folder's RecentClips: { minute: [file names] }, minutes sorted. */
function minutesOf(recentDir) {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(recentDir); } catch { return out; }
  for (const n of names.sort()) {
    const m = CLIP.exec(n);
    if (!m) continue;
    const key = `${m[1]}_${m[2]}`;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(n);
  }
  return out;
}

/**
 * Which minutes each extra car gets: by day when there are at least as many
 * days as cars (car i: every n-th day from i), else by minute the same way.
 * A car whose slice has fewer than two minutes gets up to three (they may
 * overlap another car's), so every car has footage to spare.
 */
function slices(minutes, n = EXTRA_CARS.length) {
  const all = [...minutes].sort();
  if (!all.length) return [];
  const days = [...new Set(all.map((k) => k.slice(0, 10)))];
  const out = [];
  for (let i = 0; i < n; i++) {
    let mine;
    if (days.length >= n) {
      const want = new Set(days.filter((_, j) => j % n === i));
      mine = all.filter((k) => want.has(k.slice(0, 10)));
    } else {
      mine = all.filter((_, j) => j % n === i);
    }
    // a car needs two recordings or more (one for the bin or a star, one
    // to play): with little footage, a run of up to three minutes from i on
    if (mine.length < 2) mine = all.length <= 3 ? all : [0, 1, 2].map((k) => all[(i + k) % all.length]).sort();
    out.push(mine);
  }
  return out;
}

function linkOrCopy(from, to) {
  try { fs.linkSync(from, to); return 'link'; } catch { fs.copyFileSync(from, to); return 'copy'; }
}

/** One event folder (as the car files it: copies of recent minutes, here links) with its event.json, no place in it. */
function addEvent({ root, kind, key, from, names, reason }) {
  const dir = path.join(root, kind, key);
  fs.mkdirSync(dir, { recursive: true });
  let copies = 0;
  for (const name of names) if (linkOrCopy(path.join(from, name), path.join(dir, name)) === 'copy') copies += 1;
  const ts = `${key.slice(0, 10)}T${key.slice(11).replace(/-/g, ':')}`;
  fs.writeFileSync(path.join(dir, 'event.json'), `${JSON.stringify({ timestamp: ts, city: '', street: '', reason, camera: '0' })}\n`);
  return { clips: names.length, copies };
}

/**
 * Builds the extra cars into `footage` from the main car's clips in
 * `seedCarDir` (<seed>/footage/demo-car), and gives the main car's live copy
 * (footage/demo-car, when there) a Saved and a Sentry event. Returns { meta:
 * { id: { name, timezone, car } }, cars: [{ id, minutes, clips, copies }] };
 * empty with no clips.
 */
function buildMoreCars({ seedCarDir, footage, timezone = 'America/Chicago', cars = EXTRA_CARS }) {
  const recent = path.join(seedCarDir, 'TeslaCam', 'RecentClips');
  const minutes = minutesOf(recent);
  const meta = {};
  const made = [];
  if (!minutes.size) return { meta, cars: made };
  const keys = [...minutes.keys()];
  // the main car: a Saved event (its middle minute) and a Sentry event (its last)
  const mainRoot = path.join(footage, 'demo-car', 'TeslaCam');
  if (fs.existsSync(path.join(mainRoot, 'RecentClips'))) {
    addEvent({ root: mainRoot, kind: 'SavedClips', key: keys[Math.floor(keys.length / 2)], from: recent, names: minutes.get(keys[Math.floor(keys.length / 2)]), reason: 'user_interaction_dashcam_icon_tapped' });
    addEvent({ root: mainRoot, kind: 'SentryClips', key: keys[keys.length - 1], from: recent, names: minutes.get(keys[keys.length - 1]), reason: 'sentry_aware_object_detection' });
  }
  const parts = slices(keys, cars.length);
  cars.forEach((c, i) => {
    const mine = parts[i];
    const root = path.join(footage, c.id, 'TeslaCam');
    fs.rmSync(path.join(footage, c.id), { recursive: true, force: true });
    const dir = path.join(root, 'RecentClips');
    fs.mkdirSync(dir, { recursive: true });
    let clips = 0;
    let copies = 0;
    for (const key of mine) {
      for (const name of minutes.get(key)) {
        if (linkOrCopy(path.join(recent, name), path.join(dir, name)) === 'copy') copies += 1;
        clips += 1;
      }
    }
    // the middle minute of its slice is also its event
    const eventAt = mine[Math.floor(mine.length / 2)];
    const ev = addEvent({ root, kind: c.event, key: eventAt, from: recent, names: minutes.get(eventAt), reason: c.reason });
    clips += ev.clips;
    copies += ev.copies;
    meta[c.id] = { name: c.name, timezone, car: c.car };
    made.push({ id: c.id, name: c.name, minutes: mine.length, clips, copies, event: c.event });
  });
  return { meta, cars: made };
}

module.exports = { buildMoreCars, slices, minutesOf, EXTRA_CARS };
