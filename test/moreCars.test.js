'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildMoreCars, slices, EXTRA_CARS } = require('../demo/moreCars');
const { showcase } = require('../demo/showcase');

const CAMS = ['front', 'back', 'left_repeater', 'right_repeater'];
function fakeSeed(minutes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'morecars-'));
  const recent = path.join(dir, 'seed', 'footage', 'demo-car', 'TeslaCam', 'RecentClips');
  fs.mkdirSync(recent, { recursive: true });
  for (const m of minutes) for (const c of CAMS) fs.writeFileSync(path.join(recent, `${m}-${c}.mp4`), `clip ${m} ${c}`);
  return { dir, seedCarDir: path.join(dir, 'seed', 'footage', 'demo-car'), footage: path.join(dir, 'live') };
}

test('slices: by day when there are enough days, different for each car', () => {
  const mins = ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'].flatMap((d) => [`${d}_14-05-00`, `${d}_14-06-00`]);
  const s = slices(mins, 3);
  assert.strictEqual(s.length, 3);
  assert.deepStrictEqual([...new Set(s[0].map((k) => k.slice(0, 10)))], ['2026-10-17', '2026-10-20']);
  assert.deepStrictEqual([...new Set(s[1].map((k) => k.slice(0, 10)))], ['2026-10-18']);
  assert.deepStrictEqual([...new Set(s[2].map((k) => k.slice(0, 10)))], ['2026-10-19']);
});

test('slices: with little footage every car still gets two minutes or more', () => {
  for (const s of slices(['2026-10-20_14-05-00', '2026-10-20_14-06-00'], 3)) assert.ok(s.length >= 2);
  assert.deepStrictEqual(slices([], 3), []);
});

test('buildMoreCars: hard links of the seed, one event each, nothing written to the seed', () => {
  const minutes = ['2026-10-20_14-05-00', '2026-10-20_14-06-00', '2026-10-20_14-07-00', '2026-10-20_14-08-00', '2026-10-20_14-09-00', '2026-10-20_14-10-00'];
  const { seedCarDir, footage } = fakeSeed(minutes);
  fs.mkdirSync(path.join(footage, 'demo-car', 'TeslaCam', 'RecentClips'), { recursive: true });
  const before = fs.readdirSync(path.join(seedCarDir, 'TeslaCam', 'RecentClips')).sort();
  const out = buildMoreCars({ seedCarDir, footage });
  assert.strictEqual(out.cars.length, EXTRA_CARS.length);
  assert.deepStrictEqual(Object.keys(out.meta).sort(), EXTRA_CARS.map((c) => c.id).sort());
  for (const c of out.cars) {
    assert.strictEqual(c.copies, 0);
    const root = path.join(footage, c.id, 'TeslaCam');
    const recent = fs.readdirSync(path.join(root, 'RecentClips'));
    assert.ok(recent.length > 0);
    const src = fs.statSync(path.join(seedCarDir, 'TeslaCam', 'RecentClips', recent[0]));
    const dst = fs.statSync(path.join(root, 'RecentClips', recent[0]));
    assert.strictEqual(src.ino, dst.ino, 'a hard link, not a copy');
    const ev = fs.readdirSync(path.join(root, c.event));
    assert.strictEqual(ev.length, 1);
    const evJson = JSON.parse(fs.readFileSync(path.join(root, c.event, ev[0], 'event.json'), 'utf8'));
    assert.ok(!('est_lat' in evJson) && !('est_lon' in evJson), 'no place in event.json');
  }
  // different slices
  const firsts = out.cars.map((c) => fs.readdirSync(path.join(footage, c.id, 'TeslaCam', 'RecentClips')).sort()[0]);
  assert.strictEqual(new Set(firsts).size, firsts.length);
  assert.deepStrictEqual(fs.readdirSync(path.join(seedCarDir, 'TeslaCam', 'RecentClips')).sort(), before);
  assert.deepStrictEqual(fs.readdirSync(seedCarDir), ['TeslaCam']);
  assert.deepStrictEqual(fs.readdirSync(path.join(seedCarDir, 'TeslaCam')), ['RecentClips']);
  // the main car's live copy gets a Saved and a Sentry event
  const main = path.join(footage, 'demo-car', 'TeslaCam');
  assert.strictEqual(fs.readdirSync(path.join(main, 'SavedClips')).length, 1);
  assert.strictEqual(fs.readdirSync(path.join(main, 'SentryClips')).length, 1);
});

test('buildMoreCars: no footage of the owner, no extra cars', () => {
  const { seedCarDir, footage } = fakeSeed([]);
  const out = buildMoreCars({ seedCarDir, footage });
  assert.deepStrictEqual(out, { meta: {}, cars: [] });
  assert.ok(!fs.existsSync(footage));
});

test('showcase: settings, places, stars, protect, bin and policies through the API', async () => {
  const calls = [];
  const recs = (id) => [
    { id: `${id}-a`, day: '2026-10-20', category: 'Recent', files: [`TeslaCam/RecentClips/2026-10-20_14-05-00-front.mp4`] },
    { id: `${id}-b`, day: '2026-10-20', category: 'Saved', files: [`TeslaCam/SavedClips/2026-10-20_14-06-00/2026-10-20_14-06-00-front.mp4`] },
    { id: `${id}-c`, day: '2026-10-20', category: 'Sentry', files: [`TeslaCam/SentryClips/2026-10-20_14-06-00/2026-10-20_14-06-00-front.mp4`] }
  ];
  const cars = ['demo-car', 'demo-model-3', 'demo-model-s', 'demo-model-x'].map((id) => ({ id, name: id }));
  const api = async (m, p, body) => {
    calls.push([m, p, body]);
    if (p === '/api/vehicles') return { vehicles: cars.map((c) => ({ ...c, studioRoot: `/f/${c.id}/TeslaCam` })) };
    if (p === '/api/studio/context') return { outputRoots: ['/data/converted'] };
    if (p === '/api/converter/invoke/getCapabilities') return { ok: true, value: { replacement: 'available' } };
    if (p === '/api/places' && m === 'GET') return { places: [] };
    let hit = /^\/api\/vehicles\/([^/]+)\/recordings\?/.exec(p);
    if (hit) return { recordings: recs(hit[1]).map(({ files, ...r }) => r) };
    hit = /^\/api\/vehicles\/([^/]+)\/recordings\/([^/]+)$/.exec(p);
    if (hit) return { files: recs(hit[1]).find((r) => r.id === hit[2]).files.map((rel) => ({ rel, path: `/f/${hit[1]}/${rel}` })) };
    if (/\/trash$/.test(p)) return { moved: body.ids };
    if (/\/protect$/.test(p)) return { ok: true, count: body.ids.length };
    return { ok: true };
  };
  const done = await showcase({ api, cars, now: Date.parse('2026-11-11T00:00:00Z') });
  assert.strictEqual(done.encodings, 4);
  const codecs = calls.filter(([, p]) => p === '/api/converter/invoke/saveVehicle').map(([, , b]) => b.config.codec);
  assert.ok(codecs.includes('h265') && codecs.includes('av1'));
  assert.strictEqual(done.policies, 4);
  assert.strictEqual(done.places, 3);
  assert.ok(done.stars >= 4);
  assert.strictEqual(done.protected, 1);
  assert.strictEqual(done.binned, 3);
  const binned = calls.filter(([, p]) => /\/trash$/.test(p));
  assert.ok(new Set(binned.map(([, p]) => p)).size >= 2, 'the bin on more than one car');
  assert.ok(binned.every(([, , b]) => b.ids[0].endsWith('-c')), 'Sentry events go to the bin, never the drives');
  assert.ok(calls.filter(([, p]) => p === '/api/stars').every(([, , b]) => b.clip), 'stars name a clip');
  // the policies keep what the demo has: no category shorter than the footage's age
  for (const [, p, b] of calls.filter(([m, p]) => m === 'PUT' && /\/policy$/.test(p))) {
    for (const v of Object.values(b.keepDays)) if (v !== null) assert.ok(v > 22, `${p}: ${v}`);
  }
  // only the app's API, never the demo-import folder or visitors' routes
  assert.ok(calls.every(([, p]) => p.startsWith('/api/')));
});
