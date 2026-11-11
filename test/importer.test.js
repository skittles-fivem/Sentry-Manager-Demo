'use strict';

// The owner's footage import (demo/importer.js): a strict path allowlist,
// resumable chunks, tools/sanitize.js run on it (America/Chicago), and only
// what sanitize wrote published, by an allowlist: never README.txt, the
// places, highway_stretches.csv or the private report.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createImporter, checkUploadPath, parseAvoid } = require('../demo/importer');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'demo-import-'));
const CLIP = 'footage/2026-11-10/2026-11-10_16-42-36-front.mp4';
const LOG = 'can_logs/modely_20261110T224236Z_0007.log.xz';

test('the upload allowlist: the folder\'s footage and CAN logs only; README.txt and highway_stretches.csv never', () => {
  for (const p of [CLIP, 'footage/2026-11-10/2026-11-10_16-42-36-left_repeater.mp4', LOG, `${LOG}.json`, 'can_logs/ids.csv', 'can_logs/manifest.json']) assert.equal(checkUploadPath(p).ok, true, p);
  for (const p of ['README.txt', 'highway_stretches.csv', 'readme.TXT']) assert.match(checkUploadPath(p).why, /never uploaded/, p);
  for (const p of [
    '../x.mp4', 'footage/../../etc/passwd', '/footage/2026-11-10/2026-11-10_16-42-36-front.mp4', 'footage/2026-11-10//2026-11-10_16-42-36-front.mp4',
    'footage/2026-11-11/2026-11-10_16-42-36-front.mp4', 'footage/2026-11-10/2026-11-10_16-42-36-front.mp4.exe', 'footage/2026-11-10/2026-11-10_16-42-36-left_pillar.mp4',
    'footage\\2026-11-10\\x.mp4', 'can_logs/x.sh', 'can_logs/../manifest.json', 'seed/vehicles.json', 'footage/2026-11-10/notes.txt', ''
  ]) assert.equal(checkUploadPath(p).ok, false, p);
});

test('chunks resume where the server is; a file is whole only when all of it arrived', () => {
  const imp = createImporter({ stateDir: tmp() });
  const data = Buffer.alloc(1000, 7);
  let plan = imp.plan([{ path: CLIP, size: 1000 }, { path: 'README.txt', size: 5 }, { path: '../evil', size: 1 }]);
  assert.deepEqual(plan.files.map((f) => [f.path, f.have]), [[CLIP, 0]]);
  assert.equal(plan.refused.length, 2);
  assert.deepEqual(imp.chunk(CLIP, 0, 1000, data.subarray(0, 400)), { have: 400, done: false });
  // a resend from the wrong place: told where to go on
  assert.throws(() => imp.chunk(CLIP, 0, 1000, data.subarray(0, 400)), (e) => e.status === 409 && e.have === 400);
  assert.throws(() => imp.chunk(CLIP, 400, 1000, Buffer.alloc(700)), (e) => e.status === 413);
  assert.throws(() => imp.chunk('README.txt', 0, 5, Buffer.from('home!')), (e) => e.status === 403);
  // the page comes back later: the plan says what is here
  plan = imp.plan([{ path: CLIP, size: 1000 }]);
  assert.equal(plan.files[0].have, 400);
  assert.deepEqual(imp.chunk(CLIP, 400, 1000, data.subarray(400)), { have: 1000, done: true });
  assert.equal(fs.readFileSync(path.join(imp.dirs.import, CLIP)).length, 1000);
  assert.equal(imp.plan([{ path: CLIP, size: 1000 }]).files[0].have, 1000);
  assert.equal(imp.status().upload.clips, 1);
});

/** A stand-in for running sanitize.js: records its arguments, writes what sanitize writes (and some things it must not publish). */
function fakeSanitize(calls, { kept = 3 } = {}) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const out = args[args.indexOf('--out') + 1];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      const rc = path.join(out, 'footage', 'demo-car', 'TeslaCam', 'RecentClips');
      fs.mkdirSync(rc, { recursive: true });
      for (let i = 0; i < kept; i++) fs.writeFileSync(path.join(rc, `2027-05-01_10-0${i}-00-front.mp4`), `clip ${i}`);
      const ev = path.join(out, 'footage', 'demo-car', 'TeslaCam', 'SavedClips', '2027-05-01_10-02-30');
      fs.mkdirSync(ev, { recursive: true });
      fs.writeFileSync(path.join(ev, 'event.json'), '{"timestamp":"2027-05-01T10:02:30"}');
      fs.mkdirSync(path.join(out, 'can', 'demo-car'), { recursive: true });
      fs.writeFileSync(path.join(out, 'can', 'demo-car', 'demo-car_20270501T150000Z_1.log.xz'), 'xz');
      fs.writeFileSync(path.join(out, 'can', 'demo-car', 'demo-car_20270501T150000Z_1.log.xz.json'), '{}');
      fs.writeFileSync(path.join(out, 'can', 'map.json'), '{"demo-car":"demo-car"}');
      fs.writeFileSync(path.join(out, 'report.private.json'), JSON.stringify({ kept: Array.from({ length: kept }, () => ({ from: '2026-11-10_16-44-36' })), dropped: { 'near a drive start': 4 }, found: 9 }));
      // things that must never reach the seed, whoever put them there
      fs.writeFileSync(path.join(out, 'README.txt'), 'Home: 41.1,-87.1  Work: 41.2,-87.2');
      fs.writeFileSync(path.join(out, 'highway_stretches.csv'), 'start,end,nearest place\n');
      fs.writeFileSync(path.join(out, 'footage', 'manifest.json'), '{"vin":"7SAYGDEE5PA000001"}');
      child.stdout.emit('data', `${kept} minutes kept\n`);
      child.emit('close', 0);
    });
    return child;
  };
}

test('sanitize.js is run on the upload with --tz America/Chicago, into a new seed; the places to avoid are passed and kept private', async () => {
  const state = tmp();
  const calls = [];
  const imp = createImporter({ stateDir: state, spawnImpl: fakeSanitize(calls), sanitize: '/demo/tools/sanitize.js', app: '/app' });
  imp.chunk(CLIP, 0, 3, Buffer.from('abc'));
  imp.chunk(LOG, 0, 2, Buffer.from('xz'));
  const job = await imp.process({ source: 'upload', avoid: '41.8781,-87.6298\n41.9,-87.7,5', maxMinutes: 20 });
  assert.equal(job.state, 'done', job.error);
  const { cmd, args } = calls[0];
  assert.equal(cmd, process.execPath, 'Node, in this container');
  assert.equal(args[0], '/demo/tools/sanitize.js');
  const arg = (n) => args[args.indexOf(`--${n}`) + 1];
  assert.equal(arg('tz'), 'America/Chicago');
  assert.equal(arg('in'), path.join(state, 'import', 'footage'));
  assert.equal(arg('can'), path.join(state, 'import', 'can_logs'));
  assert.equal(arg('out'), path.join(state, 'pending.new'));
  assert.equal(arg('max-minutes'), '20');
  assert.deepEqual(args.flatMap((a, i) => (a === '--avoid' ? [args[i + 1]] : [])), ['41.8781,-87.6298,3', '41.9,-87.7,5']);
  assert.ok(!args.some((a) => /README|highway_stretches/.test(a)));
  assert.ok(!job.args.some((a) => a.includes('41.8781')), 'the places are not in the status');
  // the report (real times) is gone from the seed
  assert.ok(!fs.existsSync(path.join(state, 'pending', 'report.private.json')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state, 'pending', 'vehicles.json'), 'utf8'))['demo-car'].timezone, 'America/Chicago');
  // the saved places are used next time when none are given
  calls.length = 0;
  await imp.process({ source: 'upload' });
  assert.equal(calls[0].args.filter((a) => a === '--avoid').length, 2);
  assert.throws(() => parseAvoid('home'), /not lat,lon/);
});

test('publishing: plates must be blurred or the tick given; only the allowlisted seed is published, nothing private', async () => {
  const state = tmp();
  const imp = createImporter({ stateDir: state, spawnImpl: fakeSanitize([]) });
  imp.chunk(CLIP, 0, 3, Buffer.from('abc'));
  await imp.process({ source: 'upload' });
  assert.equal(imp.status().pending.blurred, false);
  assert.throws(() => imp.publish({}), (e) => e.status === 409 && /not blurred/.test(e.message));
  assert.equal(imp.activeSeed(), null);
  assert.match(imp.status().blurCommand, /^docker run --rm --user 1000:1000 -v sentry-manager-demo-state:\/state sentry-demo-tools python3 \/tools\/blur\/blur\.py \/state\/pending\/footage$/);
  // the blur re-encodes every clip (here: rewritten, a newer time)
  const rc = path.join(state, 'pending', 'footage', 'demo-car', 'TeslaCam', 'RecentClips');
  for (const f of fs.readdirSync(rc)) { fs.writeFileSync(path.join(rc, f), 'blurred clip, longer'); fs.utimesSync(path.join(rc, f), new Date(), new Date(Date.now() + 5000)); }
  assert.equal(imp.status().pending.blur.done, true);
  const out = imp.publish({});
  assert.equal(out.blurred, true);
  const seed = imp.activeSeed();
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(path.relative(seed, p)); } };
  walk(seed);
  for (const f of files) assert.match(f, /^(vehicles\.json|can\/map\.json|can\/demo-car\/demo-car_\d{8}T\d{6}Z_\d+\.log\.xz(\.json)?|footage\/demo-car\/TeslaCam\/(RecentClips\/[^/]+\.mp4|SavedClips\/[^/]+\/(event\.json|[^/]+\.mp4)))$/, f);
  const all = files.map((f) => fs.readFileSync(path.join(seed, f), 'utf8')).join('\n');
  assert.ok(!/README|highway_stretches|report\.private|manifest/.test(files.join('\n')), 'no private file');
  assert.ok(!all.includes('41.1,-87.1') && !all.includes('7SAYGDEE5PA000001') && !all.includes('nearest place'), 'no place, VIN or nearest-place column');
  assert.ok(!fs.readdirSync(state).some((n) => /seed\.(new|old)/.test(n)));
});

test('publishing as is needs the explicit tick; the mount is processed the same way', async () => {
  const state = tmp();
  const mount = tmp();
  fs.mkdirSync(path.join(mount, 'footage', '2026-11-10'), { recursive: true });
  fs.writeFileSync(path.join(mount, 'README.txt'), 'Home: 41.1,-87.1');
  const calls = [];
  const imp = createImporter({ stateDir: state, mountDir: mount, spawnImpl: fakeSanitize(calls) });
  assert.equal(imp.status().mount.present, true);
  await imp.process({ source: 'mount' });
  assert.equal(calls[0].args[calls[0].args.indexOf('--in') + 1], path.join(mount, 'footage'));
  assert.throws(() => imp.publish({ unblurred: 'yes' }), /not blurred/);
  assert.equal(imp.publish({ unblurred: true }).blurred, false);
  assert.equal(imp.status().seed.blurred, false);
  imp.unpublish();
  assert.equal(imp.activeSeed(), null);
});

test('the prepared folder at /demo-import is used as it is, by itself, once per change; the files that name places are never copied', async () => {
  const state = tmp();
  const mount = tmp();
  const day = path.join(mount, 'footage', '2026-10-20');
  fs.mkdirSync(day, { recursive: true });
  for (const cam of ['front', 'back', 'left_repeater', 'right_repeater']) fs.writeFileSync(path.join(day, `2026-10-20_14-05-00-${cam}.mp4`), 'x');
  fs.writeFileSync(path.join(day, 'notes.txt'), 'not a clip');
  fs.mkdirSync(path.join(mount, 'can_logs'));
  fs.writeFileSync(path.join(mount, 'can_logs', 'HWY-car_20261020T190500Z_1.log.xz'), 'xz');
  fs.writeFileSync(path.join(mount, 'can_logs', 'HWY-car_20261020T190500Z_1.log.xz.json'), '{}');
  fs.writeFileSync(path.join(mount, 'README.txt'), 'Home: 41.1,-87.1');
  fs.writeFileSync(path.join(mount, 'highway_stretches.csv'), 'lat,lon');
  const imp = createImporter({ stateDir: state, mountDir: mount });
  assert.equal(imp.activeSeed(), null);
  assert.equal(await imp.autoImport({ name: 'My Y' }), true);
  const seed = imp.activeSeed();
  assert.ok(seed);
  const files = [];
  const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name), `${rel}${e.name}/`) : files.push(`${rel}${e.name}`); };
  walk(seed);
  assert.deepEqual(files.sort(), [
    'can/HWY-car/HWY-car_20261020T190500Z_1.log.xz', 'can/HWY-car/HWY-car_20261020T190500Z_1.log.xz.json', 'can/map.json',
    'footage/demo-car/TeslaCam/RecentClips/2026-10-20_14-05-00-back.mp4', 'footage/demo-car/TeslaCam/RecentClips/2026-10-20_14-05-00-front.mp4',
    'footage/demo-car/TeslaCam/RecentClips/2026-10-20_14-05-00-left_repeater.mp4', 'footage/demo-car/TeslaCam/RecentClips/2026-10-20_14-05-00-right_repeater.mp4',
    'vehicles.json'
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(seed, 'can', 'map.json'), 'utf8')), { 'HWY-car': 'demo-car' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(seed, 'vehicles.json'), 'utf8'))['demo-car'].name, 'My Y');
  // unchanged: nothing to do; a new clip: built again
  assert.equal(await imp.autoImport(), false);
  fs.writeFileSync(path.join(day, '2026-10-20_14-06-00-front.mp4'), 'y');
  assert.equal(await imp.autoImport(), true);
  assert.ok(fs.existsSync(path.join(imp.activeSeed(), 'footage/demo-car/TeslaCam/RecentClips/2026-10-20_14-06-00-front.mp4')));
});

test('an empty or missing /demo-import changes nothing', async () => {
  const imp = createImporter({ stateDir: tmp(), mountDir: path.join(tmp(), 'none') });
  assert.equal(await imp.autoImport(), false);
  assert.equal(imp.activeSeed(), null);
});
