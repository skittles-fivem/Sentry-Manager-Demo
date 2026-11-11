'use strict';

// Exports on the demo are pretend: the panel shows the export waiting, then
// rendering, then ready, in about the time a real one takes, but nothing is
// rendered and nothing is ever downloaded. The file route of every export
// (pretend or the showcase's real one) answers 204, and the demo note's script
// stops the Download link and says downloads are off (demo/banner.js).

const crypto = require('crypto');

const POSTS = [/^\/api\/exports$/, /^\/api\/vehicles\/([^/]+)\/exports$/];
const ONE = /^\/api\/exports\/([0-9a-f]{16})$/;
const FILE = /^\/api\/exports\/[^/]+\/file$/;
const MAX = 500;
const KEEP_MS = 24 * 3600_000;
const MAX_BODY = 256 * 1024;

function createFakeExports({ now = () => Date.now() } = {}) {
  const all = new Map();

  // how far along an export is, from its clock
  function pub(x) {
    const t = now();
    let state = x.state;
    let progress = 0;
    if (state === 'waiting' || state === 'running') {
      const ran = t - x.createdAt - x.waitMs;
      if (ran < 0) state = 'waiting';
      else if (ran >= x.renderMs) { state = 'done'; progress = 1; x.state = 'done'; x.finishedAt = x.createdAt + x.waitMs + x.renderMs; }
      else { state = 'running'; progress = ran / x.renderMs; }
    } else if (state === 'done') progress = 1;
    else progress = x.progress || 0;
    return {
      id: x.id, vehicleId: x.vehicleId, state, seconds: x.seconds, done: Math.round(x.seconds * progress * 10) / 10, progress,
      bytes: Math.round(x.bytes * progress), error: null, name: x.name, title: x.title, notes: [], createdAt: x.createdAt,
      finishedAt: state === 'done' ? x.finishedAt : null, jobId: null
    };
  }

  function prune() {
    const cutoff = now() - KEEP_MS;
    for (const [id, x] of all) if (x.createdAt < cutoff) all.delete(id);
    while (all.size >= MAX) all.delete(all.keys().next().value);
  }

  /** A request body's clips and camera, or an error message. */
  function check(body) {
    const clips = Array.isArray(body?.clips) ? body.clips : null;
    if (!clips || !clips.length || clips.length > 200) return { error: 'Choose a part of a recording to export.' };
    let seconds = 0;
    for (const c of clips) {
      const from = Number(c?.from); const to = Number(c?.to);
      if (!c || typeof c.key !== 'string' || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return { error: 'Choose a part of a recording to export.' };
      seconds += Math.min(to - from, 3600);
    }
    return { seconds: Math.round(seconds * 10) / 10, key: clips[0].key, camera: typeof body.camera === 'string' ? body.camera : 'grid' };
  }

  function start(vehicleId, body) {
    const c = check(body);
    if (c.error) return { status: 400, body: { error: c.error } };
    prune();
    const id = crypto.randomBytes(8).toString('hex');
    const when = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/.exec(c.key)?.[0] || new Date(now()).toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    const x = {
      id, vehicleId: vehicleId || '', state: 'waiting', seconds: c.seconds, createdAt: now(),
      waitMs: 1500, renderMs: Math.min(90_000, Math.max(8_000, c.seconds * 600)),
      bytes: Math.round(c.seconds * (c.camera === 'grid' ? 1_400_000 : 700_000)),
      name: `Sentry export ${when}.mp4`, title: `Export: ${when.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')}`
    };
    all.set(id, x);
    return { status: 200, body: pub(x) };
  }

  /** Answers the request when it is an export's; false to let it through. */
  async function answer(req, res, p, send) {
    const m = req.method;
    if (m === 'POST') {
      const hit = POSTS.map((re) => re.exec(p)).find(Boolean);
      if (!hit) return false;
      let body = null;
      try { body = JSON.parse(await readBody(req)); } catch { send(res, 400, { error: 'Choose a part of a recording to export.' }); return true; }
      const out = start(hit[1] ? decodeURIComponent(hit[1]) : '', body);
      send(res, out.status, out.body);
      return true;
    }
    if ((m === 'GET' || m === 'HEAD') && FILE.test(p)) {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    const one = ONE.exec(p);
    if (!one || !all.has(one[1])) return false;
    const x = all.get(one[1]);
    if (m === 'GET') { send(res, 200, pub(x)); return true; }
    if (m === 'DELETE') {
      const cur = pub(x);
      const busy = ['waiting', 'running'].includes(cur.state);
      if (busy) { x.state = 'cancelled'; x.progress = cur.progress; }
      send(res, 200, { ok: busy });
      return true;
    }
    return false;
  }

  return { answer, start, get: (id) => (all.has(id) ? pub(all.get(id)) : null), size: () => all.size };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parts = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = { createFakeExports, FILE };
