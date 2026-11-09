#!/usr/bin/env node
'use strict';

// After a clip is re-encoded (plates blurred, tools/blur/blur.py), puts back
// what the car wrote that re-encoding loses: Tesla's telemetry record in
// every frame (its SEI NAL units, copied byte for byte) and every frame's
// own duration (Tesla's frame rate is not constant), so the clip plays, syncs
// and shows its dashboard exactly as the original did.
//
//   node transplant.js <original.mp4> <re-encoded.mp4> <out.mp4> [--app /app]
//
// The re-encoded file must have the same number of frames, no B-frames (so
// decode order is display order), one H.264 video track, one mdat, and its
// moov after the mdat (ffmpeg without +faststart).

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const ai = args.indexOf('--app');
const APP = ai === -1 ? (process.env.APP_ROOT || '/app') : args.splice(ai, 2)[1];
const [origPath, encPath, outPath] = args;
const { parseMp4, findBoxes, selectVideoTrack, buildSampleIndex, readChunkOffsets } = require(path.join(APP, 'src/main/converter/mp4.js'));

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

/** The length size of an avc1 track's NAL units (from its avcC). */
function nalLengthSize(buf, track) {
  const stsd = findBoxes(track, 'stsd')[0];
  const entry = Number(stsd.contentStart) + 8;
  const end = entry + buf.readUInt32BE(entry);
  for (let c = entry + 86; c < end;) {
    const size = buf.readUInt32BE(c);
    if (buf.toString('ascii', c + 4, c + 8) === 'avcC') return (buf.readUInt8(c + 8 + 4) & 3) + 1;
    if (size < 8) break;
    c += size;
  }
  throw new Error('no avcC: not an H.264 track');
}

/** Each sample's Tesla SEI NAL units (the whole NAL, without its length prefix). */
function teslaSeis(buf) {
  const tree = parseMp4(buf);
  const track = selectVideoTrack(tree);
  const ls = nalLengthSize(buf, track);
  return buildSampleIndex(track).map((s) => {
    const out = [];
    let p = Number(s.offset);
    const end = p + s.size;
    while (p + ls <= end) {
      const len = buf.readUIntBE(p, ls);
      const nal = buf.subarray(p + ls, p + ls + len);
      // SEI (type 6), user data unregistered (5), Tesla's 0x42 0x42 ... 0x69 prefix
      if ((nal[0] & 0x1f) === 6 && nal[1] === 5 && nal.includes(0x69) && nal[3] === 0x42) out.push(Buffer.from(nal));
      p += ls + len;
    }
    return out;
  });
}

/** The track's timing: timescale and every sample's duration, in decode order. */
function timing(buf) {
  const tree = parseMp4(buf);
  const track = selectVideoTrack(tree);
  const mdhd = findBoxes(track, 'mdhd')[0];
  const at = Number(mdhd.contentStart);
  const v = buf[at];
  const timescale = buf.readUInt32BE(at + (v === 1 ? 20 : 12));
  return { timescale, durations: buildSampleIndex(track).map((s) => Number(s.duration)) };
}

function transplant(orig, enc) {
  const seis = teslaSeis(orig);
  const t = timing(orig);
  let tree = parseMp4(enc);
  let track = selectVideoTrack(tree);
  let samples = buildSampleIndex(track);
  if (samples.length !== seis.length) throw new Error(`frame counts differ: original ${seis.length}, re-encoded ${samples.length}`);
  const mdats = findBoxes(tree, 'mdat');
  const moov = findBoxes(tree, 'moov')[0];
  if (mdats.length !== 1 || Number(moov.start) < Number(mdats[0].start)) throw new Error('need one mdat before the moov (encode without +faststart)');
  const ls = nalLengthSize(enc, track);

  // 1. the SEI NAL units in front of each sample's picture
  const prefix = seis.map((nals) => Buffer.concat(nals.flatMap((n) => { const l = Buffer.alloc(ls); l.writeUIntBE(n.length, 0, ls); return [l, n]; })));
  const parts = [];
  let cursor = 0;
  for (const [i, s] of samples.entries()) {
    const off = Number(s.offset);
    parts.push(enc.subarray(cursor, off), prefix[i]);
    cursor = off;
  }
  parts.push(enc.subarray(cursor));
  const out = Buffer.concat(parts);
  const added = (offset) => samples.reduce((n, s, i) => n + (Number(s.offset) < Number(offset) ? prefix[i].length : 0), 0);
  const grow = out.length - enc.length;
  // sample sizes, chunk offsets and the mdat's size (moov moved by `grow`)
  const shift = (box) => Number(box.contentStart) + grow;
  const stsz = findBoxes(track, 'stsz')[0];
  if (enc.readUInt32BE(Number(stsz.contentStart) + 4) !== 0) throw new Error('stsz has one size for all samples');
  for (const [i, s] of samples.entries()) out.writeUInt32BE(s.size + prefix[i].length, shift(stsz) + 12 + i * 4);
  const table = [...findBoxes(track, 'stco'), ...findBoxes(track, 'co64')][0];
  readChunkOffsets(tree, track.id).forEach((o, i) => {
    const moved = o + BigInt(added(o));
    if (table.type === 'co64') out.writeBigUInt64BE(moved, shift(table) + 8 + i * 8);
    else out.writeUInt32BE(Number(moved), shift(table) + 8 + i * 4);
  });
  const mdat = mdats[0];
  if (mdat.headerSize === 16n) out.writeBigUInt64BE(mdat.size + BigInt(grow), Number(mdat.start) + 8);
  else out.writeUInt32BE(Number(mdat.size) + grow, Number(mdat.start));

  // 2. the original timing: its timescale and every frame's duration
  tree = parseMp4(out);
  track = selectVideoTrack(tree);
  const runs = [];
  for (const d of t.durations) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0] += 1;
    else runs.push([1, d]);
  }
  const sttsBody = Buffer.concat([u32(0), u32(runs.length), ...runs.flatMap(([n, d]) => [u32(n), u32(d)])]);
  const total = t.durations.reduce((a, b) => a + b, 0);
  const stts = findBoxes(track, 'stts')[0];
  const mdhd = findBoxes(track, 'mdhd')[0];
  const at = Number(mdhd.contentStart);
  if (out[at] !== 0) throw new Error('mdhd version 1 is not handled');
  out.writeUInt32BE(t.timescale, at + 12);
  out.writeUInt32BE(total, at + 16);
  // movie and track durations are in the movie timescale
  const mvhd = findBoxes(tree, 'mvhd')[0];
  const mv = Number(mvhd.contentStart);
  const movieScale = out.readUInt32BE(mv + (out[mv] === 1 ? 20 : 12));
  const movieDur = Math.round(total * movieScale / t.timescale);
  if (out[mv] === 0) out.writeUInt32BE(movieDur, mv + 16);
  const tkhd = findBoxes(track, 'tkhd')[0];
  if (out[Number(tkhd.contentStart)] === 0) out.writeUInt32BE(movieDur, Number(tkhd.contentStart) + 20);
  // swap the stts box; every box around it grows or shrinks with it (moov is last)
  const oldStts = out.subarray(Number(stts.start), Number(stts.end));
  const newStts = Buffer.concat([u32(sttsBody.length + 8), Buffer.from('stts'), sttsBody]);
  const delta = newStts.length - oldStts.length;
  const result = Buffer.concat([out.subarray(0, Number(stts.start)), newStts, out.subarray(Number(stts.end))]);
  for (let n = stts.parent; n && n.type !== 'root'; n = n.parent) {
    if (n.headerSize === 16n) result.writeBigUInt64BE(n.size + BigInt(delta), Number(n.start) + 8);
    else result.writeUInt32BE(Number(n.size) + delta, Number(n.start));
  }
  parseMp4(result);
  return result;
}

if (require.main === module) {
  if (!origPath || !encPath || !outPath) {
    process.stderr.write('usage: transplant.js <original.mp4> <re-encoded.mp4> <out.mp4> [--app /app]\n');
    process.exit(2);
  }
  fs.writeFileSync(outPath, transplant(fs.readFileSync(origPath), fs.readFileSync(encPath)));
}

module.exports = { transplant, teslaSeis, timing };
