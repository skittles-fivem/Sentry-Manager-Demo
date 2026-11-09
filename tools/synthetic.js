#!/usr/bin/env node
'use strict';

// Test footage for the demo: a short highway drive in the TeslaCam layout,
// six cameras per minute, with Tesla's per-frame telemetry (speed, GPS,
// gear, Autopilot, steering, acceleration) in every frame, as the car writes
// it. Nothing real: a test pattern on an empty road in the middle of nowhere.
// Used by the tests and to try the demo before real drives are in seed/.
//
//   node tools/synthetic.js <manager checkout> <out dir> [minutes]
//
// <manager checkout> is a clone of skittles-fivem/Sentry-Manager (its test
// fixtures put the telemetry into the clips).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [managerDir, outDir, minutesArg] = process.argv.slice(2);
if (!managerDir || !outDir) {
  process.stderr.write('usage: node tools/synthetic.js <manager checkout> <out dir> [minutes]\n');
  process.exit(2);
}
const { injectTeslaTelemetryIntoH264Mp4 } = require(path.resolve(managerDir, 'test/fixtures/fixtureBuilders.js'));

const MINUTES = Number(minutesArg || 4);
const FPS = Number(process.env.SYNTH_FPS || 10);
const SIZE = process.env.SYNTH_SIZE || '480x360';
// SYNTH_PROFILE=trip: a whole trip (town, a stop, highway, the exit, town
// again) to test the sanitizer; otherwise highway only
const TRIP = process.env.SYNTH_PROFILE === 'trip';
const CAMS = ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'];

// ---- a minimal protobuf writer for SeiMetadata (src/renderer/proto/dashcam.proto)
function varint(n) {
  let v = BigInt(n);
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}
const key = (field, wire) => varint((field << 3) | wire);
const f32 = (field, x) => { const b = Buffer.alloc(4); b.writeFloatLE(x); return Buffer.concat([key(field, 5), b]); };
const f64 = (field, x) => { const b = Buffer.alloc(8); b.writeDoubleLE(x); return Buffer.concat([key(field, 1), b]); };
const u = (field, x) => Buffer.concat([key(field, 0), varint(x)]);
// H.264 emulation prevention: 00 00 followed by 00-03 gets a 03 between
function escape(buf) {
  const out = [];
  let zeros = 0;
  for (const b of buf) {
    if (zeros >= 2 && b <= 3) { out.push(3); zeros = 0; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}
function sei(s) {
  return escape(Buffer.concat([
    u(1, 1), u(2, s.gear), u(3, s.seq), f32(4, s.speed), f32(5, s.pedal), f32(6, s.steer),
    ...(s.left ? [u(7, 1)] : []), ...(s.right ? [u(8, 1)] : []), ...(s.brake ? [u(9, 1)] : []),
    u(10, s.ap), f64(11, s.lat), f64(12, s.lon), f64(13, s.heading),
    f64(14, s.ax), f64(15, s.ay), f64(16, 9.81)
  ]));
}

// A straight stretch of empty interstate in west Texas, heading east at
// about 70 mph, with a lane change and some Autopilot.
const START = { lat: 31.0456, lon: -104.8301 };
const MPS = 31.3;
// trip: 0-30 s parked, town to 150 s (with a 40 s stop), highway, then town
// again for the last 150 s, parked for the last 30 s
function tripSpeed(t) {
  const end = MINUTES * 60;
  if (t < 30 || t > end - 30) return 0;
  if (t < 150) return t > 80 && t < 120 ? 0 : 12;
  if (t > end - 150) return 12;
  return MPS + Math.sin(t / 23) * 1.2;
}
function distAt(t) {
  if (!TRIP) return MPS * t;
  let d = 0;
  for (let x = 0; x < t; x += 1) d += tripSpeed(x);
  return d;
}
function stateAt(t, seq) {
  const lane = t > 95 && t < 101; // a lane change to the left
  const speed = TRIP ? tripSpeed(t) : MPS + Math.sin(t / 23) * 1.2;
  const dist = distAt(Math.floor(t));
  return {
    gear: 1, seq, speed, pedal: lane ? 34 : 22, steer: lane ? -6 * Math.sin((t - 95) / 6 * Math.PI) : Math.sin(t / 7) * 0.8,
    left: lane && Math.floor(t * 2) % 2 === 0, right: false, brake: false,
    ap: t > 130 ? 2 : t > 40 ? 3 : 0,
    lat: START.lat + dist * 0.0000004, lon: START.lon + dist / (111320 * Math.cos(START.lat * Math.PI / 180)),
    heading: 89.2, ax: Math.cos(t / 23) * 0.05, ay: lane ? 0.6 : 0.02
  };
}

const clips = path.join(outDir, 'TeslaCam', 'RecentClips');
fs.mkdirSync(clips, { recursive: true });
const day = new Date(Date.UTC(2026, 9, 18, 15, 2, 7));
const two = (n) => String(n).padStart(2, '0');
const keyOf = (d) => `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}_${two(d.getUTCHours())}-${two(d.getUTCMinutes())}-${two(d.getUTCSeconds())}`;
const tmp = path.join(outDir, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

for (let m = 0; m < MINUTES; m++) {
  const clipKey = keyOf(new Date(day.getTime() + m * 60_000));
  for (const [ci, cam] of CAMS.entries()) {
    const base = path.join(tmp, `${cam}.mp4`);
    const hue = ci * 55;
    const r = spawnSync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc2=duration=60:size=${SIZE}:rate=${FPS},hue=h=${hue}`,
      '-vf', `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${cam} ${clipKey}':x=10:y=10:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6`,
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '600k', '-g', String(FPS), '-bf', '0',
      '-pix_fmt', 'yuv420p', '-tag:v', 'avc1', '-use_editlist', '0', '-movflags', '+faststart', base
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status !== 0) {
      // no drawtext (no fonts): the plain pattern
      const r2 = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=duration=60:size=${SIZE}:rate=${FPS},hue=h=${hue}`,
        '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '600k', '-g', String(FPS), '-bf', '0', '-pix_fmt', 'yuv420p', '-tag:v', 'avc1', '-use_editlist', '0', '-movflags', '+faststart', base]);
      if (r2.status !== 0) throw new Error(`ffmpeg: ${r2.stderr}`);
    }
    const frames = 60 * FPS;
    const tele = Array.from({ length: frames }, (_, i) => sei(stateAt(m * 60 + i / FPS, m * frames + i)));
    const out = injectTeslaTelemetryIntoH264Mp4(fs.readFileSync(base), tele);
    fs.writeFileSync(path.join(clips, `${clipKey}-${cam}.mp4`), out);
  }
  process.stdout.write(`clip ${m + 1}/${MINUTES} ${clipKey}\n`);
}
fs.rmSync(tmp, { recursive: true, force: true });
