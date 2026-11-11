'use strict';

// Something in every feature, set up at every start through the app's own
// API (the demo's loopback token, never a visitor): each car's Encoding per
// vehicle settings (Policies > Per car), retention policies, saved places,
// starred moments, protected recordings and recordings in the Recycle Bin.
// It works on the demo's live copy of the footage, which is made again at
// every start (the bin renames hard links there: the seed is not touched).
// A step that fails is logged and the rest carry on.

// Encoding per vehicle, one each, all different (saved, automatic off: the
// demo never converts on its own). Index = the car's place in the list.
const ENCODINGS = [
  { codec: 'h265', profileId: 'balanced', outputMode: 'replace', verifyMode: 'quick', includedGroups: ['RecentClips', 'SavedClips', 'SentryClips'], groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'], concurrency: 2 },
  { codec: 'av1', profileId: 'aggressive', outputMode: 'separate', verifyMode: 'full', includedGroups: ['RecentClips', 'SavedClips'], groupOrder: ['RecentClips', 'SavedClips', 'SentryClips'], concurrency: 1, keepOffTarget: true },
  { codec: 'h265', profileId: 'quality', qualityLevel: 'high', keepLarger: true, outputMode: 'separate', verifyMode: 'off', includedGroups: ['SentryClips', 'SavedClips'], groupOrder: ['SentryClips', 'SavedClips', 'RecentClips'], concurrency: 3 },
  { codec: 'av1', profileId: 'custom', bitrateKbps: 2500, outputMode: 'replace', verifyMode: 'full', includedGroups: ['RecentClips'], groupOrder: ['RecentClips', 'SavedClips', 'SentryClips'], concurrency: 4 }
];

// Saved places: public landmarks, never the owner's own places
const PLACES = [
  { name: 'Gigafactory Texas', lat: 30.2219, lon: -97.6195, radius: 400 },
  { name: 'Fremont Factory', lat: 37.4945, lon: -121.9446, radius: 400 },
  { name: 'Supercharger stop', lat: 39.7392, lon: -104.9903, radius: 150 }
];

const NOTES = ['Smooth merge onto the highway', 'Good view of the lane change', 'Nice light here', 'Car-data boxes worth a look'];

const daysAgo = (day, now) => Math.max(0, Math.round((now - Date.parse(`${day}T12:00:00Z`)) / 86400000));
const minuteOf = (rec) => {
  for (const rel of rec.files || []) {
    const m = /(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-[a-z_]+\.mp4$/.exec(rel);
    if (m) return m[1];
  }
  return null;
};

async function step(log, what, fn) {
  try {
    return await fn();
  } catch (err) {
    log(`showcase: ${what}: ${err.message}`);
    return null;
  }
}

/** All of a car's recordings, with their files (the list leaves them out). */
async function recordingsOf(api, id) {
  const out = await api('GET', `/api/vehicles/${encodeURIComponent(id)}/recordings?limit=500`);
  const list = out?.recordings || out?.items || [];
  const full = [];
  for (const r of list) {
    const one = await api('GET', `/api/vehicles/${encodeURIComponent(id)}/recordings/${encodeURIComponent(r.id)}`).catch(() => null);
    if (one) full.push({ ...r, files: (one.files || []).map((f) => f.rel), paths: (one.files || []).map((f) => f.path) });
  }
  return full.sort((a, b) => String(a.start || a.id).localeCompare(String(b.start || b.id)));
}

async function showcase({ api, cars, log = () => {}, now = Date.now() }) {
  if (!cars.length) return { cars: 0 };
  const done = { encodings: 0, policies: 0, places: 0, stars: 0, protected: 0, binned: 0, exports: 0 };
  const { vehicles } = await api('GET', '/api/vehicles');
  const ctx = await step(log, 'studio context', () => api('GET', '/api/studio/context'));
  const outRoot = ctx?.outputRoots?.[0] || null;
  const caps = await step(log, 'capabilities', () => api('POST', '/api/converter/invoke/getCapabilities'));
  const replaceOk = caps?.value?.replacement === 'available';

  // Encoding per vehicle
  for (const [i, car] of cars.entries()) {
    const v = vehicles.find((x) => x.id === car.id) || car;
    const folder = v.studioRoot || v.root;
    if (!folder) continue;
    const want = { ...ENCODINGS[i % ENCODINGS.length] };
    if (want.outputMode === 'replace' && !replaceOk) want.outputMode = 'separate';
    const config = {
      sourceRoot: folder, networkMode: 'auto', replacementConfirmed: want.outputMode === 'replace', ...want,
      destinationRoot: want.outputMode === 'separate' && outRoot ? `${outRoot}/${v.id}` : null
    };
    if (config.outputMode === 'separate' && !config.destinationRoot) continue;
    const out = await step(log, `encoding of ${v.name}`, () => api('POST', '/api/converter/invoke/saveVehicle', { config }));
    if (out?.ok === false) log(`showcase: encoding of ${v.name} not saved: ${out.error?.code}`);
    else if (out) done.encodings += 1;
  }

  // Saved places
  const have = (await step(log, 'places', () => api('GET', '/api/places')))?.places || [];
  for (const p of PLACES) {
    if (have.some((x) => x.name === p.name)) continue;
    if (await step(log, `place ${p.name}`, () => api('POST', '/api/places', p))) done.places += 1;
  }

  // Per car: stars (they protect their recording), one more protected, one in
  // the bin (only from a car with recordings to spare), and a retention policy
  for (const [i, car] of cars.entries()) {
    const recs = (await step(log, `recordings of ${car.name}`, () => recordingsOf(api, car.id))) || [];
    // stars on drives and Saved events (a Sentry event is left for the bin)
    const starable = recs.filter((r) => r.category !== 'Sentry');
    const starAt = starable.length > 2 ? [starable[starable.length - 1], starable[Math.floor(starable.length / 2)]] : starable.slice(-1);
    for (const [j, rec] of starAt.entries()) {
      const clip = minuteOf(rec);
      if (!clip || (i % 2 === 1 && j > 0)) continue;
      const ok = await step(log, `star on ${car.name}`, () => api('POST', '/api/stars', { vehicle: car.id, clip, second: 12 + 9 * j, note: NOTES[(i + j) % NOTES.length] }));
      if (ok) done.stars += 1;
    }
    // what the stars protected, as the app sees it now
    const after = (await step(log, `recordings of ${car.name}`, () => recordingsOf(api, car.id))) || recs;
    const spare = after.filter((r) => !r.protected).sort((a, b) => (a.category === 'Sentry') - (b.category === 'Sentry'));
    if (i === 2 && spare.length) {
      const ok = await step(log, `protect on ${car.name}`, () => api('POST', `/api/vehicles/${encodeURIComponent(car.id)}/protect`, { ids: [spare[0].id], protected: true }));
      if (ok) { done.protected += ok.count || 0; spare.shift(); }
    }
    // a short export of the main car's newest recording, for Exports
    if (i === 0 && starable.length) {
      const rec = starable[starable.length - 1];
      const clip = minuteOf(rec);
      const files = {};
      for (const f of rec.paths || []) {
        const m = /-(front|back|left_repeater|right_repeater)\.mp4$/.exec(f);
        if (m && f.includes(clip)) files[m[1]] = f;
      }
      if (clip && Object.keys(files).length) {
        const out = await step(log, `export on ${car.name}`, () => api('POST', `/api/vehicles/${encodeURIComponent(car.id)}/exports`, { clips: [{ key: clip, files, from: 0, to: 10 }], camera: 'grid', units: 'mph' }));
        if (out) done.exports += 1;
      }
    }
    // to the bin: a Sentry event when there is one, else the oldest spare
    // recording, always while the car keeps others to play
    const toBin = spare.find((r) => r.category === 'Sentry') || (i !== 0 ? spare[0] : null);
    if (i !== 2 && toBin && after.length >= 2) {
      const out = await step(log, `bin on ${car.name}`, () => api('POST', `/api/vehicles/${encodeURIComponent(car.id)}/trash`, { ids: [toBin.id] }));
      done.binned += out?.moved?.length || 0;
    }
    // a policy that keeps what the demo has (nothing is moved by it), all different
    const oldest = recs.reduce((d, r) => (r.day && (!d || r.day < d) ? r.day : d), null);
    const keep = (oldest ? daysAgo(oldest, now) : 0) + 30 + 30 * i;
    const policy = [
      { enabled: true, runAt: '03:30', keepDays: { Recent: keep, Sentry: keep + 60, Saved: null, Other: keep }, binDays: 30, maxGB: null },
      { enabled: true, runAt: '02:15', keepDays: { Recent: keep, Sentry: keep, Saved: keep + 335, Other: null }, binDays: null, maxGB: 500 },
      { enabled: false, runAt: '04:00', keepDays: { Recent: keep, Sentry: null, Saved: null, Other: null }, binDays: 14, maxGB: null },
      { enabled: true, runAt: '01:45', keepDays: { Recent: keep, Sentry: keep, Saved: keep, Other: keep }, binDays: 60, maxGB: 250 }
    ][i % 4];
    if (await step(log, `policy of ${car.name}`, () => api('PUT', `/api/vehicles/${encodeURIComponent(car.id)}/policy`, policy))) done.policies += 1;
  }
  log(`showcase: ${done.encodings} encoding settings, ${done.policies} policies, ${done.places} places, ${done.stars} stars, ${done.protected} protected, ${done.binned} in the bin, ${done.exports} export`);
  return done;
}

module.exports = { showcase, ENCODINGS, PLACES };
