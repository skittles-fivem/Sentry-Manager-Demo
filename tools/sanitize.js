#!/usr/bin/env node
'use strict';

// Makes the demo's seed from real drives, keeping only highway driving.
//
// Run it inside the Sentry Six Manager image (it uses the app's own
// telemetry and CAN readers, and the image has ffmpeg and xz):
//
//   docker run --rm -v "<TeslaCam folder>:/in:ro" -v "<CAN logs folder>:/can:ro" \
//     -v "<this repo>/seed:/out" -v "<this repo>/tools:/tools:ro" \
//     ghcr.io/skittles-fivem/sentry-manager node /tools/sanitize.js \
//     --in /in --can /can --out /out --tz America/Chicago
//
// What it keeps, minute by minute (one Tesla clip = one minute, six cameras):
//
//   - only RecentClips and SavedClips; SentryClips (recorded parked) never;
//   - only minutes where the car drove at least --min-mph (default 50) for the
//     whole minute, read from the car's own per-frame telemetry, with GPS;
//   - never the first or last --trim-min minutes (default 3) of a drive;
//   - never a minute that passes within --stop-km (default 3 km) of any place
//     a drive started, ended or stood still for 30 s, or of an --avoid point;
//   - at most --max-minutes (default 30) in all, longest highway runs first.
//
// What it changes in what it keeps:
//
//   - every date moves by --shift-days (default: a random 60-400 days),
//     time of day kept, so the real dates are not in the demo;
//   - the MP4s' creation and modification times are zeroed;
//   - a Saved event's event.json is rewritten with only its time (shifted),
//     reason and position (on the highway); no city or street;
//   - CAN logs: only the seconds of the kept minutes; the VIN frames (0x405,
//     0x508) dropped; times shifted with the footage; the car key renamed;
//     a new sidecar without VIN or signature (the old one no longer matches).
//
// It writes report.private.json NEXT TO the output, not in it: what was
// kept and dropped and why, and the shift. Keep that file to yourself.
// --dry-run writes only the report.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ---- options
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? dflt : args[i + 1];
};
const many = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const flag = (name) => args.includes(`--${name}`);
const APP = opt('app', process.env.APP_ROOT || '/app');
const IN = many('in');
const CAN_IN = opt('can', null);
const OUT = opt('out', null);
const CAR = opt('car', 'demo-car');
const CAN_KEY = opt('can-key', 'demo-car');
const TZ = opt('tz', 'UTC');
const MIN_MPH = Number(opt('min-mph', 50));
const TRIM_MIN = Number(opt('trim-min', 3));
const STOP_KM = Number(opt('stop-km', 3));
const MAX_MIN = Number(opt('max-minutes', 30));
const MIN_RUN = Number(opt('min-run', 2));
const SHIFT_DAYS = opt('shift-days', null) === null ? 60 + crypto.randomInt(341) : Number(opt('shift-days'));
const DRY = flag('dry-run');
const AVOID = many('avoid').map((s) => {
  const [lat, lon, km] = s.split(',').map(Number);
  return { lat, lon, km: Number.isFinite(km) ? km : STOP_KM };
});
if (!IN.length || !OUT) {
  process.stderr.write('usage: sanitize.js --in <TeslaCam> [--in ...] [--can <CAN logs>] --out <seed dir> [--tz Area/City] [--dry-run]\n');
  process.exit(2);
}
if (!Number.isFinite(SHIFT_DAYS) || AVOID.some((a) => !Number.isFinite(a.lat) || !Number.isFinite(a.lon))) {
  process.stderr.write('bad --shift-days or --avoid (lat,lon[,km])\n');
  process.exit(2);
}

const { readSamples } = require(path.join(APP, 'server/speedReader.js'));
const { parseMp4, findBoxes } = require(path.join(APP, 'src/main/converter/mp4.js'));

const say = (m) => process.stdout.write(`${m}\n`);
const MIN_MPS = MIN_MPH * 0.44704;
const CAMS = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];
const CLIP_RE = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$/;
const two = (n) => String(n).padStart(2, '0');

// ---- clip keys as wall-clock times (the car's local time)
const keyMs = (k) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(k);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
};
const msKey = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}_${two(d.getUTCHours())}-${two(d.getUTCMinutes())}-${two(d.getUTCSeconds())}`;
};
const shiftKey = (k) => msKey(keyMs(k) + SHIFT_DAYS * 86400_000);
/** The UTC instant of a wall-clock time in TZ. */
function wallToUtc(wallMs) {
  // the offset at that moment, found by formatting a guess in the zone
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let guess = wallMs;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const asWall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    guess += wallMs - asWall;
  }
  return guess;
}

// ---- distances
const km = (a, b) => {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const hasGps = (s) => s && Number.isFinite(s.lat) && Number.isFinite(s.lon) && !(s.lat === 0 && s.lon === 0);

// ---- find the clips
function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}
const clips = new Map(); // key -> { key, cams: {cam: file}, category, event: dir|null }
let sentrySkipped = 0;
for (const root of IN) {
  for (const file of walk(root)) {
    const m = CLIP_RE.exec(path.basename(file));
    if (!m) continue;
    const parts = file.split(path.sep);
    if (parts.includes('SentryClips')) { sentrySkipped += 1; continue; }
    const saved = parts.includes('SavedClips');
    const c = clips.get(m[1]) || { key: m[1], cams: {}, category: 'Recent', event: null };
    // a Saved event's minutes are copies of Recent ones: either will do; the event is remembered
    if (!c.cams[m[2]] || saved) c.cams[m[2]] = file;
    if (saved) { c.category = 'Saved'; c.event = path.dirname(file); }
    clips.set(m[1], c);
  }
}
const keys = [...clips.keys()].sort();
say(`${keys.length} minutes of driving found (${sentrySkipped} Sentry files skipped)`);

(async () => {
  // ---- read each minute's telemetry (one record a second, front camera first)
  for (const [i, k] of keys.entries()) {
    const c = clips.get(k);
    let samples = null;
    for (const cam of CAMS) {
      if (!c.cams[cam]) continue;
      try { samples = await readSamples(c.cams[cam]); } catch { samples = null; }
      if (samples) break;
    }
    c.samples = samples || [];
    if ((i + 1) % 50 === 0) say(`  read ${i + 1}/${keys.length}`);
  }

  // ---- drives: minutes no more than 5 min apart
  const drives = [];
  for (const k of keys) {
    const last = drives[drives.length - 1];
    if (last && keyMs(k) - keyMs(last[last.length - 1]) <= 5 * 60_000 + 30_000) last.push(k);
    else drives.push([k]);
  }

  // ---- places to stay away from: where drives start, end or stand still
  const stops = [...AVOID];
  for (const d of drives) {
    const first = clips.get(d[0]).samples.find(hasGps);
    const lastC = clips.get(d[d.length - 1]).samples;
    const last = [...lastC].reverse().find(hasGps);
    if (first) stops.push({ ...first, km: STOP_KM, why: 'drive start' });
    if (last) stops.push({ ...last, km: STOP_KM, why: 'drive end' });
    for (const k of d) {
      const s = clips.get(k).samples;
      const still = s.filter((x) => x && x.v !== null && x.v < 1);
      if (still.length >= 30) {
        const at = still.find(hasGps);
        if (at) stops.push({ ...at, km: STOP_KM, why: 'stood still' });
      }
    }
  }

  // ---- judge every minute
  const verdict = new Map();
  for (const d of drives) {
    const t0 = keyMs(d[0]);
    const t1 = keyMs(d[d.length - 1]) + 60_000;
    for (const k of d) {
      const c = clips.get(k);
      const s = c.samples;
      const read = s.filter((x) => x && x.v !== null);
      const why = (() => {
        if (CAMS.some((cam) => !c.cams[cam]) && Object.keys(c.cams).length < 4) return 'too few cameras';
        if (s.length < 50 || read.length < s.length * 0.9) return 'no telemetry';
        if (read.some((x) => x.v < MIN_MPS)) return `below ${MIN_MPH} mph`;
        if (!s.some(hasGps)) return 'no GPS';
        if (keyMs(k) - t0 < TRIM_MIN * 60_000 || t1 - keyMs(k) - 60_000 < TRIM_MIN * 60_000) return 'start or end of a drive';
        const near = s.filter(hasGps).flatMap((x) => stops.filter((p) => km(x, p) < p.km));
        if (near.length) return `near a ${near[0].why || 'place to avoid'}`;
        return null;
      })();
      verdict.set(k, why);
    }
  }

  // ---- runs of kept minutes, longest first, up to the limit
  const runs = [];
  for (const d of drives) {
    let run = [];
    for (const k of d) {
      if (verdict.get(k) === null) run.push(k);
      else { if (run.length) runs.push(run); run = []; }
    }
    if (run.length) runs.push(run);
  }
  const usable = runs.filter((r) => r.length >= MIN_RUN).sort((a, b) => b.length - a.length);
  const kept = [];
  for (const r of usable) {
    if (kept.length >= MAX_MIN) break;
    kept.push(...r.slice(0, MAX_MIN - kept.length));
  }
  kept.sort();
  for (const k of keys) if (verdict.get(k) === null && !kept.includes(k)) verdict.set(k, 'over --max-minutes or a run too short');
  // a Saved event only when every minute of it is kept
  const events = new Map();
  for (const k of kept) {
    const c = clips.get(k);
    if (c.event) (events.get(c.event) || events.set(c.event, []).get(c.event)).push(k);
  }
  for (const [dir, ks] of [...events]) {
    const all = [...clips.values()].filter((c) => c.event === dir).map((c) => c.key);
    if (!all.every((k) => kept.includes(k))) events.delete(dir);
  }

  const report = {
    shiftDays: SHIFT_DAYS, tz: TZ, minMph: MIN_MPH, trimMin: TRIM_MIN, stopKm: STOP_KM,
    found: keys.length, sentrySkipped, drives: drives.length, stops: stops.length,
    kept: kept.map((k) => ({ from: k, as: shiftKey(k) })),
    savedEvents: [...events.keys()].map((d) => path.basename(d)),
    dropped: [...verdict].filter(([, w]) => w).reduce((acc, [, w]) => ({ ...acc, [w]: (acc[w] || 0) + 1 }), {})
  };
  say(`${kept.length} minutes kept in ${usable.length} highway runs; dropped: ${JSON.stringify(report.dropped)}`);
  // in the seed folder but never in the image or the repo (.dockerignore, .gitignore)
  const reportFile = path.join(OUT, 'report.private.json');
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 1)}\n`);
  say(`report: ${reportFile} (private: it has the real times)`);
  if (DRY || !kept.length) return;

  // ---- write the footage
  const carDir = path.join(OUT, 'footage', CAR, 'TeslaCam');
  fs.rmSync(path.join(OUT, 'footage', CAR), { recursive: true, force: true });
  const eventOf = new Map();
  for (const [dir, ks] of events) for (const k of ks) eventOf.set(k, dir);
  for (const [i, k] of kept.entries()) {
    const c = clips.get(k);
    const evDir = eventOf.get(k);
    const dest = evDir ? path.join(carDir, 'SavedClips', shiftKey(path.basename(evDir))) : path.join(carDir, 'RecentClips');
    fs.mkdirSync(dest, { recursive: true });
    for (const [cam, file] of Object.entries(c.cams)) {
      const buf = fs.readFileSync(file);
      clearTimes(buf);
      checkNoVin(buf, file);
      fs.writeFileSync(path.join(dest, `${shiftKey(k)}-${cam}.mp4`), buf);
    }
    say(`  minute ${i + 1}/${kept.length}`);
  }
  for (const [dir, ks] of events) writeEvent(dir, ks, path.join(carDir, 'SavedClips', shiftKey(path.basename(dir))));

  // ---- CAN logs: only the kept seconds
  if (CAN_IN) writeCan(kept);
  say('done');
})().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exit(1);
});

/** Creation and modification times in mvhd, tkhd and mdhd set to 0. */
function clearTimes(buf) {
  const tree = parseMp4(buf);
  for (const type of ['mvhd', 'tkhd', 'mdhd']) {
    for (const b of findBoxes(tree, type)) {
      const at = Number(b.contentStart);
      const version = buf[at];
      if (version === 1) buf.fill(0, at + 4, at + 20);
      else buf.fill(0, at + 4, at + 12);
    }
  }
}

/** Refuse a file that carries something like a Tesla VIN in its header or tail. */
function checkNoVin(buf, file) {
  const head = buf.subarray(0, Math.min(buf.length, 256 * 1024)).toString('latin1');
  const tail = buf.subarray(Math.max(0, buf.length - 256 * 1024)).toString('latin1');
  const vin = /(5YJ|7SA|LRW|XP7|7G2|SFZ)[A-HJ-NPR-Z0-9]{14}/;
  if (vin.test(head) || vin.test(tail)) throw new Error(`${file} seems to contain a VIN: not written. Tell whoever runs the demo.`);
}

/** event.json with only the shifted time, the reason and the position (on the highway). */
function writeEvent(dir, ks, dest) {
  let ev = {};
  try { ev = JSON.parse(fs.readFileSync(path.join(dir, 'event.json'), 'utf8')); } catch { /* none */ }
  const when = ev.timestamp && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(ev.timestamp)
    ? msKey(Date.parse(`${ev.timestamp}Z`) + SHIFT_DAYS * 86400_000).replace('_', 'T').replace(/-(\d{2})-(\d{2})$/, ':$1:$2')
    : shiftKey(path.basename(dir)).replace('_', 'T').replace(/-(\d{2})-(\d{2})$/, ':$1:$2');
  const at = clips.get(ks[ks.length - 1]).samples.filter(hasGps).pop();
  const out = {
    timestamp: when,
    reason: typeof ev.reason === 'string' && /^[a-z_]{1,60}$/.test(ev.reason) ? ev.reason : 'user_interaction_dashcam_icon_tapped',
    camera: typeof ev.camera === 'string' && /^\d{1,2}$/.test(ev.camera) ? ev.camera : '0',
    ...(at ? { est_lat: at.lat.toFixed(4), est_lon: at.lon.toFixed(4) } : {})
  };
  fs.writeFileSync(path.join(dest, 'event.json'), `${JSON.stringify(out)}\n`);
}

/** The CAN logs' frames of the kept minutes, VIN frames out, times and key changed. */
function writeCan(kept) {
  const LOG_RE = /^([A-Za-z0-9-]{1,64})_(\d{8}T\d{6}Z)_(\d{1,6})\.log\.xz$/;
  // kept seconds as UTC epoch ranges (the clips are in the car's local time)
  // Each kept minute's shift in UTC seconds: the wall-clock shift, corrected
  // for daylight saving time where the shifted date has the other offset, so
  // the CAN data lines up with the footage in the car's time zone.
  const ranges = kept.map((k) => {
    const s = wallToUtc(keyMs(k)) / 1000;
    const shift = wallToUtc(keyMs(k) + SHIFT_DAYS * 86400_000) / 1000 - s;
    return [s, s + 60, shift];
  });
  const rangeOf = (t) => ranges.find(([a, b]) => t >= a && t < b) || null;
  const inKept = (t) => rangeOf(t) !== null;
  const { isColumns, decodeColumns } = require(path.join(APP, 'server/canColumns.js'));
  const outDir = path.join(OUT, 'can', CAN_KEY);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let files = 0;
  let frames = 0;
  let vinDropped = 0;
  const logs = walk(CAN_IN).filter((f) => LOG_RE.test(path.basename(f))).sort();
  const lo = Math.min(...ranges.map((r) => r[0])) - 120;
  const hi = Math.max(...ranges.map((r) => r[1])) + 120;
  for (const file of logs) {
    const m = LOG_RE.exec(path.basename(file));
    const t = m[2];
    const started = Date.parse(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`) / 1000;
    if (started > hi || started < lo - 3600) continue;
    const xz = spawnSync('xz', ['-dc', file], { maxBuffer: 1024 * 1024 * 1024 });
    if (xz.status !== 0) { say(`  CAN ${path.basename(file)}: not readable, skipped`); continue; }
    let raw = xz.stdout;
    let text;
    try {
      if (isColumns(raw)) {
        const lines = [];
        decodeColumns(raw, (l) => lines.push(l));
        text = lines.join('\n');
      } else text = raw.toString('utf8');
    } catch (err) {
      say(`  CAN ${path.basename(file)}: ${err.message}, skipped`);
      continue;
    }
    raw = null;
    const out = [];
    let n = 0;
    let first = null;
    let fileShift = null;
    const notes = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      const f = /^\((\d+)\.(\d+)\) (\S+) ([0-9A-Fa-f]+)#(\S*)$/.exec(line);
      if (f) {
        const ts = Number(`${f[1]}.${f[2]}`);
        if (!inKept(ts)) continue;
        const id = f[4].toUpperCase().replace(/^0+(?=.)/, '');
        if (id === '405' || id === '508') { vinDropped += 1; continue; }
        const SHIFT_S = rangeOf(ts)[2];
        if (fileShift === null) fileShift = SHIFT_S;
        const shifted = `${Number(f[1]) + SHIFT_S}.${f[2]}`;
        if (first === null) first = Number(f[1]) + SHIFT_S;
        out.push(`(${shifted}) ${f[3]} ${f[4]}#${f[5]}`);
        n += 1;
        continue;
      }
      // the log's own notes: its version, and clock lines with their times moved
      if (/^# canbridge v\d+/.test(line)) notes.push(`${/^# canbridge v\d+/.exec(line)[0]} app=demo`);
      else if (/^# (clock|helper-clock) /.test(line)) notes.push((sh) => line.replace(/\b(wall)=(\d{9,10})(\.\d+)?/g, (_, k, s, frac = '') => `${k}=${Number(s) + sh}${frac}`));
      // other notes (dropped, not recorded) say nothing about the car; times in them move too
      else if (/^# (dropped|not recorded)\b/.test(line)) notes.push((sh) => line.replace(/\b(\d{10})(\.\d+)?\b/g, (_, s, frac = '') => `${Number(s) + sh}${frac}`));
    }
    if (!n) continue;
    // the notes (version, clock) first, with the file's shift
    out.unshift(...notes.map((x) => (typeof x === 'function' ? x(fileShift) : x)));
    const at = new Date(Math.floor(first) * 1000);
    const stamp = `${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}T${two(at.getUTCHours())}${two(at.getUTCMinutes())}${two(at.getUTCSeconds())}Z`;
    const name = `${CAN_KEY}_${stamp}_${files + 1}.log.xz`;
    const packed = spawnSync('xz', ['-6', '-c'], { input: `${out.join('\n')}\n`, maxBuffer: 1024 * 1024 * 1024 });
    if (packed.status !== 0) throw new Error(`xz failed on ${name}`);
    fs.writeFileSync(path.join(outDir, name), packed.stdout);
    const sidecar = { vehicle_key: CAN_KEY, format: 'canbridge-candump-xz/1', frames: n, closed_because: 'rotate', signed: false, note: 'demo: trimmed to highway minutes, VIN frames removed, times shifted' };
    fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(sidecar)}\n`);
    files += 1;
    frames += n;
  }
  fs.writeFileSync(path.join(OUT, 'can', 'map.json'), `${JSON.stringify({ [CAN_KEY]: CAR })}\n`);
  say(`CAN: ${files} logs, ${frames} frames kept, ${vinDropped} VIN frames dropped`);
}
