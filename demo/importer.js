'use strict';

// The owner's own highway footage for the demo (the owner page, demo/owner.js):
// uploaded in chunks (resumable), or mounted read-only at /demo-import; then
// the repo's privacy pipeline before anything is public:
//
//   1. tools/sanitize.js in this container (Node only), --tz America/Chicago:
//      highway minutes only, no home, work or stops, dates shifted, no VIN.
//      It writes a new seed into <state>/pending.
//   2. License plates: the blur (tools/blur) needs the separate tools image,
//      so the owner page says the plates are not blurred, and offers the exact
//      docker command to blur <state>/pending on the server (this module sees
//      afterwards which clips it re-encoded), or publishing as is with an
//      explicit tick.
//   3. Publishing copies only what the demo reads (footage clips and event.json,
//      CAN logs and sidecars, map.json, vehicles.json) into <state>/seed, which
//      the demo then uses instead of its built-in seed from the next reset.
//
// The folder (highway_footage_with_can):
//   footage/YYYY-MM-DD/<YYYY-MM-DD_HH-MM-SS>-{front,back,left_repeater,right_repeater}.mp4  (local CST)
//   can_logs/*.log.xz, *.log.xz.json (canbridge-columns-xz/2), ids.csv, manifest.json
//   highway_stretches.csv, README.txt
// README.txt and highway_stretches.csv are never uploaded (the upload refuses
// them) and never read: they name places. Nothing of the upload is published
// as it is: the seed is only what sanitize.js wrote, copied by an allowlist.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const TZ = 'America/Chicago';
const CAMS = 'front|back|left_repeater|right_repeater';
const UPLOAD_RULES = [
  { re: new RegExp(`^footage\\/(\\d{4}-\\d{2}-\\d{2})\\/(\\d{4}-\\d{2}-\\d{2})_\\d{2}-\\d{2}-\\d{2}-(${CAMS})\\.mp4$`), max: 64 * 2 ** 30, check: (m) => m[1] === m[2] },
  { re: /^can_logs\/[A-Za-z0-9-]{1,64}_\d{8}T\d{6}Z_\d{1,6}\.log\.xz$/, max: 64 * 2 ** 30 },
  { re: /^can_logs\/[A-Za-z0-9-]{1,64}_\d{8}T\d{6}Z_\d{1,6}\.log\.xz\.json$/, max: 2 ** 20 },
  { re: /^can_logs\/(ids\.csv|manifest\.json)$/, max: 64 * 2 ** 20 }
];
const NEVER_UPLOADED = /^(README\.txt|highway_stretches\.csv)$/i;
const MAX_CHUNK = 8 * 2 ** 20;
// tools/sanitize.js: in the image at /demo/tools (Dockerfile), in a checkout at ../tools
const SANITIZE = [path.join(__dirname, 'tools', 'sanitize.js'), path.join(__dirname, '..', 'tools', 'sanitize.js')].find((f) => fs.existsSync(f)) || path.join(__dirname, 'tools', 'sanitize.js');
const MAX_FILES = 200_000;
const KEEP_FREE = 512 * 2 ** 20;
// what a published seed may hold (paths relative to the seed)
const SEED_RULES = [
  /^vehicles\.json$/,
  /^footage\/demo-car\/TeslaCam\/RecentClips\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-z_]+\.mp4$/,
  /^footage\/demo-car\/TeslaCam\/SavedClips\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\/(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-[a-z_]+\.mp4|event\.json)$/,
  /^can\/map\.json$/,
  /^can\/demo-car\/demo-car_\d{8}T\d{6}Z_\d{1,6}\.log\.xz(\.json)?$/
];

/** The rule a relative upload path matches: { ok: true, max } or { ok: false, why }. */
function checkUploadPath(rel) {
  const p = String(rel || '');
  if (!p || p.length > 300 || p.includes('\\') || p.includes('\0') || p.startsWith('/') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return { ok: false, why: 'not a plain relative path' };
  if (NEVER_UPLOADED.test(p)) return { ok: false, why: 'never uploaded: it names places' };
  for (const r of UPLOAD_RULES) {
    const m = r.re.exec(p);
    if (m && (!r.check || r.check(m))) return { ok: true, max: r.max };
  }
  return { ok: false, why: 'not part of the footage folder' };
}

function walk(dir, base = dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

const freeBytes = (dir) => {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
};

/** The mp4s of a seed folder: { rel: [size, mtimeMs] }. */
function clipStamps(dir) {
  const out = {};
  for (const rel of walk(dir)) {
    if (!rel.endsWith('.mp4')) continue;
    const s = fs.statSync(path.join(dir, rel));
    out[rel] = [s.size, Math.round(s.mtimeMs)];
  }
  return out;
}

/** Which of the clips sanitize wrote were re-encoded since (the blur): { total, changed, missing }. */
function blurState(dir, before) {
  const now = clipStamps(dir);
  const names = Object.keys(before || {});
  let changed = 0;
  let missing = 0;
  for (const n of names) {
    if (!now[n]) { missing += 1; continue; }
    if (now[n][0] !== before[n][0] || now[n][1] !== before[n][1]) changed += 1;
  }
  const left = names.length - missing;
  return { total: left, changed, missing, done: left > 0 && changed === left };
}

/** Copies a sanitized seed by the allowlist only; returns what was copied and skipped. */
function copySeed(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  const copied = [];
  const skipped = [];
  for (const rel of walk(from)) {
    if (!SEED_RULES.some((re) => re.test(rel))) { skipped.push(rel); continue; }
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, rel), dest);
    copied.push(rel);
  }
  return { copied, skipped };
}

/** "lat,lon[,km]" lines to sanitize's --avoid values (bad lines refused). */
function parseAvoid(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 50)) {
    const parts = line.split(/[,\s]+/).filter(Boolean).map(Number);
    const [lat, lon, km = 3] = parts;
    if (parts.length < 2 || parts.length > 3 || !(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 180) || !(km > 0 && km <= 50)) {
      throw Object.assign(new Error(`"${line.slice(0, 60)}" is not lat,lon or lat,lon,km`), { status: 400 });
    }
    out.push(`${lat},${lon},${km}`);
  }
  return out;
}

/**
 * o: stateDir (/demo-state), mountDir (/demo-import), sanitize (path to
 * tools/sanitize.js), app (the manager's folder), log, now, spawnImpl,
 * volume (the state volume's name, for the blur command).
 */
function createImporter({
  stateDir, mountDir = '/demo-import', sanitize = SANITIZE, app = process.env.APP_ROOT || '/app',
  log = () => {}, now = () => Date.now(), spawnImpl = spawn, volume = process.env.DEMO_STATE_VOLUME || 'sentry-manager-demo-state', node = process.execPath
}) {
  const dirs = {
    import: path.join(stateDir, 'import'), pending: path.join(stateDir, 'pending'), seed: path.join(stateDir, 'seed'),
    priv: path.join(stateDir, 'private')
  };
  const infoFile = (name) => path.join(dirs.priv, `${name}.json`);
  const readInfo = (name) => { try { return JSON.parse(fs.readFileSync(infoFile(name), 'utf8')); } catch { return null; } };
  const writeInfo = (name, v) => { fs.mkdirSync(dirs.priv, { recursive: true, mode: 0o700 }); fs.writeFileSync(infoFile(name), JSON.stringify(v)); };
  let job = { state: 'idle', lines: [] };

  // ---- upload
  function plan(files) {
    if (!Array.isArray(files) || files.length > MAX_FILES) throw Object.assign(new Error('Send the list of files (at most 200,000).'), { status: 400 });
    const out = [];
    const refused = [];
    for (const f of files) {
      const rel = String(f?.path || '');
      const size = Number(f?.size);
      const c = checkUploadPath(rel);
      if (!c.ok) { refused.push({ path: rel.slice(0, 300), why: c.why }); continue; }
      if (!Number.isSafeInteger(size) || size < 0 || size > c.max) { refused.push({ path: rel, why: 'size' }); continue; }
      out.push({ path: rel, size, have: have(rel, size) });
    }
    const need = out.reduce((n, f) => n + (f.size - f.have), 0);
    return { files: out, refused, need, free: freeBytes(stateDir) };
  }
  /** Bytes of this file already here (the whole size when it is done). */
  function have(rel, size) {
    const final = path.join(dirs.import, rel);
    try {
      if (fs.statSync(final).size === size) return size;
    } catch { /* not finished */ }
    try {
      const n = fs.statSync(`${final}.part`).size;
      return n <= size ? n : 0;
    } catch {
      return 0;
    }
  }
  /** One chunk at `offset` of the file `rel` (`size` in all): { have, done } or an error with .status (409 with .have when the offset is not where the file is). */
  function chunk(rel, offset, size, data) {
    const c = checkUploadPath(rel);
    if (!c.ok) throw Object.assign(new Error(`Refused: ${c.why}.`), { status: 403 });
    if (!Number.isSafeInteger(size) || size < 0 || size > c.max || !Number.isSafeInteger(offset) || offset < 0) throw Object.assign(new Error('Bad size or offset.'), { status: 400 });
    if (data.length > MAX_CHUNK || offset + data.length > size) throw Object.assign(new Error('Chunk too large.'), { status: 413 });
    const final = path.join(dirs.import, rel);
    const part = `${final}.part`;
    const now = have(rel, size);
    if (now === size) return { have: size, done: true };
    if (offset !== now) throw Object.assign(new Error('Resume from the server\'s offset.'), { status: 409, have: now });
    const free = freeBytes(stateDir);
    if (free !== null && free - data.length < KEEP_FREE) throw Object.assign(new Error('Not enough free disk on the server.'), { status: 507 });
    fs.mkdirSync(path.dirname(final), { recursive: true });
    if (now === 0) fs.rmSync(part, { force: true }); // a part longer than the file was: start over
    fs.appendFileSync(part, data);
    const got = fs.statSync(part).size;
    if (got === size) {
      fs.renameSync(part, final);
      return { have: size, done: true };
    }
    return { have: got, done: false };
  }
  function uploaded() {
    const files = walk(dirs.import);
    const done = files.filter((f) => !f.endsWith('.part'));
    let bytes = 0;
    for (const f of done) { try { bytes += fs.statSync(path.join(dirs.import, f)).size; } catch { /* gone */ } }
    return { files: done.length, clips: done.filter((f) => f.endsWith('.mp4')).length, logs: done.filter((f) => f.endsWith('.log.xz')).length, partial: files.length - done.length, bytes };
  }
  function mounted() {
    const present = fs.existsSync(path.join(mountDir, 'footage'));
    if (!present) return { present: false };
    const clips = walk(path.join(mountDir, 'footage')).filter((f) => f.endsWith('.mp4')).length;
    const logs = walk(path.join(mountDir, 'can_logs')).filter((f) => f.endsWith('.log.xz')).length;
    return { present, clips, logs };
  }

  // ---- step 1: sanitize
  /** Starts sanitize.js on the upload or the mount. o: source ('upload' | 'mount'), avoid (text), maxMinutes, name, blurredBefore. */
  function process_(o = {}) {
    if (job.state === 'running') throw Object.assign(new Error('Already processing.'), { status: 409 });
    const source = o.source === 'mount' ? 'mount' : 'upload';
    const root = source === 'mount' ? mountDir : dirs.import;
    const footage = path.join(root, 'footage');
    if (!fs.existsSync(footage)) throw Object.assign(new Error(source === 'mount' ? 'Nothing is mounted at /demo-import (footage/).' : 'Nothing uploaded yet (footage/).'), { status: 409 });
    const avoid = o.avoid === undefined ? (readInfo('avoid')?.lines || []) : parseAvoid(o.avoid);
    if (o.avoid !== undefined) writeInfo('avoid', { lines: avoid }); // kept for next time, never published
    const maxMinutes = Math.max(1, Math.min(Number(o.maxMinutes) || 30, 120));
    const name = String(o.name || 'Demo Model Y').replace(/[^\w .'-]/g, '').trim().slice(0, 40) || 'Demo Model Y';
    const out = `${dirs.pending}.new`;
    fs.rmSync(out, { recursive: true, force: true });
    const args = [sanitize, '--app', app, '--in', footage, '--out', out, '--tz', TZ, '--car', 'demo-car', '--can-key', 'demo-car', '--max-minutes', String(maxMinutes)];
    const can = path.join(root, 'can_logs');
    if (fs.existsSync(can)) args.push('--can', can);
    for (const a of avoid) args.push('--avoid', a);
    job = { state: 'running', source, startedAt: now(), lines: [], args: args.slice(1).map((a) => (avoid.includes(a) ? '(a place)' : a)) };
    const child = spawnImpl(node, args, { cwd: os.tmpdir(), env: { ...process.env, APP_ROOT: app, TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
    try { os.setPriority(child.pid, 10); } catch { /* not allowed: fine */ }
    const take = (buf) => {
      for (const line of String(buf).split('\n').filter(Boolean)) job.lines.push(line.slice(0, 300));
      if (job.lines.length > 60) job.lines.splice(0, job.lines.length - 60);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const current = job;
    return new Promise((resolve) => {
      child.on('error', (err) => { Object.assign(current, { state: 'failed', finishedAt: now(), error: err.code || err.message }); resolve(current); });
      child.on('close', (code) => {
        if (current.state !== 'running') return resolve(current);
        try {
          if (code !== 0) throw new Error(`sanitize.js ended with ${code}`);
          // the report has the real times: kept privately, never in the seed
          const report = path.join(out, 'report.private.json');
          let kept = 0;
          if (fs.existsSync(report)) {
            const r = JSON.parse(fs.readFileSync(report, 'utf8'));
            kept = Array.isArray(r.kept) ? r.kept.length : 0;
            writeInfo('report', { at: now(), source, kept, dropped: r.dropped || {}, found: r.found || 0 });
            fs.rmSync(report);
          }
          if (!kept || !fs.existsSync(path.join(out, 'footage'))) throw new Error('no highway minutes were kept');
          fs.writeFileSync(path.join(out, 'vehicles.json'), `${JSON.stringify({ 'demo-car': { name, timezone: TZ, car: { model: 'Y', generation: 'auto' } } })}\n`);
          fs.rmSync(dirs.pending, { recursive: true, force: true });
          fs.renameSync(out, dirs.pending);
          writeInfo('pending', { at: now(), source, kept, clips: clipStamps(dirs.pending), blurredBefore: Boolean(o.blurredBefore) });
          Object.assign(current, { state: 'done', finishedAt: now(), kept });
          log(`import: ${kept} highway minutes ready to publish`);
        } catch (err) {
          fs.rmSync(out, { recursive: true, force: true });
          Object.assign(current, { state: 'failed', finishedAt: now(), error: err.message });
          log(`import failed: ${err.message}`);
        }
        return resolve(current);
      });
    });
  }

  // ---- step 2 and 3: blur, publish
  function pendingState() {
    const info = readInfo('pending');
    if (!info || !fs.existsSync(dirs.pending)) return { exists: false };
    const blur = blurState(dirs.pending, info.clips);
    return { exists: true, at: info.at, source: info.source, minutes: info.kept, blur, blurredBefore: Boolean(info.blurredBefore), blurred: blur.done || Boolean(info.blurredBefore) };
  }
  function publish({ unblurred = false } = {}) {
    const p = pendingState();
    if (!p.exists) throw Object.assign(new Error('Nothing processed to publish.'), { status: 409 });
    if (!p.blurred && unblurred !== true) throw Object.assign(new Error('License plates are not blurred: blur it first, or tick "publish as is".'), { status: 409 });
    const next = `${dirs.seed}.new`;
    const { copied, skipped } = copySeed(dirs.pending, next);
    if (!copied.some((r) => r.endsWith('.mp4'))) { fs.rmSync(next, { recursive: true, force: true }); throw Object.assign(new Error('No footage to publish.'), { status: 409 }); }
    fs.rmSync(`${dirs.seed}.old`, { recursive: true, force: true });
    if (fs.existsSync(dirs.seed)) fs.renameSync(dirs.seed, `${dirs.seed}.old`);
    fs.renameSync(next, dirs.seed);
    fs.rmSync(`${dirs.seed}.old`, { recursive: true, force: true });
    writeInfo('seed', { at: now(), minutes: p.minutes, blurred: p.blurred, blurredBefore: p.blurredBefore, clips: copied.filter((r) => r.endsWith('.mp4')).length });
    log(`import: published ${p.minutes} minutes${p.blurred ? '' : ' (license plates not blurred)'}; shown from the next reset`);
    return { copied: copied.length, skipped: skipped.length, blurred: p.blurred };
  }
  function seedState() {
    const info = readInfo('seed');
    return fs.existsSync(path.join(dirs.seed, 'footage')) ? { active: 'imported', ...info } : { active: 'built-in' };
  }
  function unpublish() {
    fs.rmSync(dirs.seed, { recursive: true, force: true });
    fs.rmSync(infoFile('seed'), { force: true });
  }
  function discard(what) {
    if (what === 'upload') fs.rmSync(dirs.import, { recursive: true, force: true });
    else if (what === 'pending') { fs.rmSync(dirs.pending, { recursive: true, force: true }); fs.rmSync(infoFile('pending'), { force: true }); }
    else throw Object.assign(new Error('Discard what?'), { status: 400 });
  }

  const blurCommand = () => `docker run --rm --user 1000:1000 -v ${volume}:/state sentry-demo-tools python3 /tools/blur/blur.py /state/pending/footage`;

  function status() {
    return {
      upload: uploaded(), mount: mounted(), job: { ...job, lines: job.lines.slice(-40) }, report: readInfo('report'), pending: pendingState(), seed: seedState(),
      blurCommand: blurCommand(), buildTools: 'docker build -t sentry-demo-tools tools/blur', free: freeBytes(stateDir),
      avoidSaved: (readInfo('avoid')?.lines || []).length
    };
  }

  /** The seed the demo starts from: the published one, else null (the built-in). */
  const activeSeed = () => (fs.existsSync(path.join(dirs.seed, 'footage')) ? dirs.seed : null);

  return { plan, chunk, process: process_, publish, unpublish, discard, status, activeSeed, dirs, blurCommand, get job() { return job; } };
}

module.exports = { createImporter, checkUploadPath, copySeed, parseAvoid, blurState, clipStamps, SEED_RULES, UPLOAD_RULES, MAX_CHUNK, TZ };
