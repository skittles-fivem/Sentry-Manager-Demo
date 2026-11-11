'use strict';

// A pretend conversion for the demo: a big H.265 job spread over this
// server's GPU and two paired nodes (a "Garage PC" and an "Office NAS"),
// moving in real time, so visitors see what the Encoder, Nodes, Jobs and the
// Hardware panel look like when a whole archive converts. Nothing is encoded
// and no node exists: the demo answers the pages' requests for these with
// numbers made here, in the same shapes the app sends (the converter's job
// snapshot and live progress, the devices list, GET /api/nodes, /api/jobs,
// and the encoder, GPU and power parts of /api/stats).
//
// A job of DEMO_FAKE_CLIPS clips (default 4800: about 13 hours of driving, six
// cameras) takes about 45 minutes at the GPUs' real speeds (DEMO_FAKE_MINUTES
// stretches it to another length), shows its summary for three minutes, and
// the next one starts.

const crypto = require('crypto');

const FPS = 36;
const CLIP_US = 60_000_000;
// how long one minute-long clip (36 fps, 2160 frames) takes on one of a GPU's encodes, from its frames per second
const secsAt = (fpsPerEncode) => (60 * FPS) / fpsPerEncode;
const GPU = 'pci:0000:01:00.0';
const NODES = [
  {
    id: 'g4r4g3pc0001', name: 'Garage PC', host: '192.168.1.40', cpuName: 'AMD Ryzen 7 5800X',
    gpu: { id: 'pci:0000:2b:00.0', kind: 'nvidia', name: 'NVIDIA GeForce RTX 3060', h265: 'hevc_nvenc', av1: null }, slots: 4, mean: secsAt(275), idleW: 62, perClipW: 22
  },
  {
    id: 'o0ff1cen4s01', name: 'Office NAS', host: '192.168.1.25', cpuName: 'Intel Core i5-12400',
    gpu: { id: 'pci:0000:00:02.0', kind: 'dri', name: 'Intel Arc A380', h265: 'hevc_qsv', av1: 'av1_qsv' }, slots: 3, mean: secsAt(300), idleW: 28, perClipW: 11
  }
];
// realistic H.265 speeds for Tesla's clips with decoding on the GPU: an RTX 4070 about 1,800 fps over its
// 6 encodes, the RTX 3060 about 1,100 over 4, the Arc A380 about 900 over 3 (the front camera's bigger clip takes longer)
const LOCAL = { slots: 6, mean: secsAt(300), name: 'NVIDIA GeForce RTX 4070', encoder: 'hevc_nvenc' };
const CAMS = [['front', 1], ['back', 0.5], ['left_repeater', 0.5], ['right_repeater', 0.5], ['left_pillar', 0.5], ['right_pillar', 0.5]];

const two = (n) => String(n).padStart(2, '0');
const keyOf = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}_${two(d.getUTCHours())}-${two(d.getUTCMinutes())}-${two(d.getUTCSeconds())}`;
};
function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(n);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${u === 0 ? v : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[u]}`;
}

function createFakeEncoder({ sourceRoot, vehicleId, vehicleName, clips = Number(process.env.DEMO_FAKE_CLIPS || 4800), minutes = process.env.DEMO_FAKE_MINUTES ? Number(process.env.DEMO_FAKE_MINUTES) : null, initialProgress = 0.35 }) {
  // every lane slot, and how long a clip takes on it (at the GPUs' real speeds, or scaled so the job lasts `minutes` when given)
  const lanes = [
    { device: GPU, concurrency: LOCAL.slots, mean: LOCAL.mean, encoder: LOCAL.encoder, node: null, gpuName: LOCAL.name },
    ...NODES.map((n) => ({ device: `node:${n.id}@${n.gpu.id}`, concurrency: n.slots, mean: n.mean, encoder: n.gpu.h265, node: n, gpuName: n.gpu.name }))
  ];
  const perSecond = lanes.reduce((s, l) => s + l.concurrency / l.mean, 0);
  // clips / (perSecond / scale) = the job's length in seconds
  const scale = minutes ? (minutes * 60 * perSecond) / clips : 1;
  // how long the whole job takes (for the start a third of the way in)
  const jobMinutes = minutes || clips / perSecond / 60;
  const slots = lanes.flatMap((lane) => Array.from({ length: lane.concurrency }, (_, i) => ({ lane, i, item: null, start: 0, dur: 0, pid: 2000 + Math.floor(Math.random() * 60000) })));

  let job = null;
  let history = [];
  let jobsSeq = 9000;
  const clients = new Set();

  function newJob(now, prefill = 0) {
    // two hours of driving, a week before the job, six cameras a minute
    const first = Date.UTC(2027, 0, 26, 14, 2, 7) + Math.floor(Math.random() * 6) * 86400_000;
    const items = [];
    const minutesOfFootage = Math.ceil(clips / CAMS.length);
    for (let m = 0; m < minutesOfFootage && items.length < clips; m++) {
      const key = keyOf(first + m * 60_000);
      const saved = m % 37 === 11;
      for (const [cam, share] of CAMS) {
        if (items.length >= clips) break;
        const group = saved ? 'SavedClips' : 'RecentClips';
        const rel = saved ? `SavedClips/${key}/${key}-${cam}.mp4` : `RecentClips/${key}-${cam}.mp4`;
        const n = items.length + 1;
        items.push({
          id: `item-${String(n).padStart(6, '0')}`, state: 'queued', kind: 'video', group, eventId: saved ? key : null,
          relativePath: rel, sourcePath: `${sourceRoot}/${rel}`,
          sourceBytes: Math.round((share === 1 ? 78 : 39) * 1024 * 1024 * (0.93 + Math.random() * 0.1)),
          mtimeMs: first + m * 60_000 + 61_000, timestampKey: key, camera: cam, eligibleVideo: true, attempts: 0
        });
      }
    }
    const groups = Object.fromEntries(['RecentClips', 'SavedClips', 'SentryClips'].map((g) => [g, { files: 0, sourceBytes: 0, outputBytes: 0, savedBytes: 0 }]));
    jobsSeq += 1;
    job = {
      schemaVersion: 1, id: crypto.randomUUID(), state: 'encoding', revision: 1,
      config: {
        sourceRoot, destinationRoot: null, codec: 'h265', profileId: 'balanced', networkMode: 'direct', outputMode: 'replace',
        replacementConfirmed: true, includedGroups: ['RecentClips', 'SavedClips'], groupOrder: ['SavedClips', 'SentryClips', 'RecentClips'],
        concurrency: lanes.reduce((s, l) => s + l.concurrency, 0),
        lanes: lanes.map((l) => ({ device: l.device, concurrency: l.concurrency })), verifyMode: 'quick'
      },
      counters: { files: 0, sourceVideoBytes: 0, outputVideoBytes: 0, savedBytes: 0, copiedAssetBytes: 0, groups },
      summary: null, discoveryComplete: true, createdAt: now, updatedAt: now, activeItemId: null, items,
      // the demo's own bookkeeping (left out of what the pages get)
      _next: 0, _failed: 0, _skipped: 0, _doneAt: null, _wh: 0, _nodeWh: 0, _jobsId: jobsSeq
    };
    for (const s of slots) s.item = null;
    // the first job a visitor can meet is already some way along
    if (prefill > 0) {
      const done = Math.floor(items.length * prefill);
      const fakeSlot = { lane: lanes[0], item: null };
      for (let i = 0; i < done; i++) {
        const it = items[i];
        it.state = 'processing';
        fakeSlot.item = it;
        fakeSlot.lane = lanes[i % lanes.length];
        finish(fakeSlot, now);
      }
      job._next = done;
      const took = prefill * jobMinutes * 60_000;
      job.createdAt = now - took;
      job._wh = (95 + LOCAL.slots * 14) * took / 3_600_000;
      job._nodeWh = NODES.reduce((w, n) => w + n.slots * n.perClipW, 0) * took / 3_600_000;
    }
  }

  const strip = (j) => {
    const out = {};
    for (const [k, v] of Object.entries(j)) if (!k.startsWith('_')) out[k] = v;
    return out;
  };

  function finish(slot, now) {
    const it = slot.item;
    slot.item = null;
    const roll = Math.random();
    it.attempts = 1;
    it.encoder = slot.lane.encoder;
    if (roll < 0.03) {
      // a clip converted before (an earlier run): skipped, as the app does
      it.state = 'skipped';
      it.resultCode = 'already-converted';
      job._skipped += 1;
    } else if (roll < 0.035) {
      it.state = 'failed';
      it.resultCode = 'profile-size';
      it.failure = { code: 'profile-size', retryable: true };
      job._failed += 1;
    } else {
      const out = Math.round(it.sourceBytes * (0.29 + Math.random() * 0.07));
      it.state = 'completed';
      it.resultCode = 'converted';
      it.outputBytes = out;
      const c = job.counters;
      c.files += 1;
      c.sourceVideoBytes += it.sourceBytes;
      c.outputVideoBytes += out;
      c.savedBytes += it.sourceBytes - out;
      const g = c.groups[it.group];
      g.files += 1;
      g.sourceBytes += it.sourceBytes;
      g.outputBytes += out;
      g.savedBytes += it.sourceBytes - out;
    }
    job.updatedAt = now;
    job.revision += 1;
  }

  function tick(now = Date.now()) {
    if (!job) {
      // two earlier runs in Jobs, and this one already a third of the way
      for (const [daysAgo, files] of [[3, 2148], [1, 1386]]) {
        jobsSeq += 1;
        const started = now - daysAgo * 86400_000 - 5 * 3600_000;
        history.push({
          id: jobsSeq, type: 'conversion', vehicleId, status: 'done', title: `Convert ${vehicleName} to H.265`,
          detail: `done: ${files} converted, ${Math.round(files * 0.03)} skipped, 0 failed`,
          startedAt: started, finishedAt: started + files * 3_900, result: null, externalId: `converter:${crypto.randomUUID()}`
        });
      }
      newJob(now, initialProgress);
    }
    if (job.state === 'completed') {
      if (now - job._doneAt > 3 * 60_000) {
        history = [...history.slice(-4), jobsEntry()];
        newJob(now);
      } else return;
    }
    let changed = false;
    for (const s of slots) {
      if (s.item && now >= s.start + s.dur) { finish(s, now); changed = true; }
      if (!s.item && job._next < job.items.length) {
        const it = job.items[job._next];
        job._next += 1;
        it.state = 'processing';
        s.item = it;
        s.start = now;
        s.dur = Math.max(4, s.lane.mean * scale * (s.item.camera === 'front' ? 1.5 : 0.9) * (0.85 + Math.random() * 0.3)) * 1000;
        job.activeItemId = it.id;
        changed = true;
      }
    }
    // energy: this server and the nodes, from how many clips each is on
    const busyLocal = slots.filter((s) => s.item && !s.lane.node).length;
    const nodeW = NODES.reduce((w, n) => w + slots.filter((s) => s.item && s.lane.node === n).length * n.perClipW, 0);
    job._wh += (95 + busyLocal * 14) / 3600;
    job._nodeWh += nodeW / 3600;
    if (job._next >= job.items.length && slots.every((s) => !s.item)) {
      job.state = 'completed';
      job._doneAt = now;
      const c = job.counters;
      job.summary = {
        files: c.files, sourceVideoBytes: c.sourceVideoBytes, outputVideoBytes: c.outputVideoBytes, savedBytes: c.savedBytes, copiedAssetBytes: 0,
        source: formatBytes(c.sourceVideoBytes), output: formatBytes(c.outputVideoBytes), saved: formatBytes(c.savedBytes), copiedAssets: '0 B',
        groups: JSON.parse(JSON.stringify(c.groups))
      };
      job.revision += 1;
      changed = true;
    }
    if (changed) broadcast({ jobId: job.id, revision: job.revision, snapshot: strip(job) });
    else broadcast({ jobId: job.id, revision: job.revision, snapshot: { id: job.id, revision: job.revision, progress: { phase: 'continue', fps: Math.round(fpsNow() * 10) / 10, encodingNow: slots.filter((s) => s.item).length, waitingOnNode: 0, outTimeUs: Math.round(firstFraction(now) * CLIP_US) } } });
  }

  const firstFraction = (now) => {
    const s = slots.find((x) => x.item);
    return s ? Math.min(1, (now - s.start) / s.dur) : 0;
  };
  const speedOf = (s) => (60 / (s.dur / 1000));
  const fpsNow = () => slots.filter((s) => s.item).reduce((f, s) => f + speedOf(s) * FPS, 0);

  // ---- the converter's event stream for one page
  function broadcast(payload) {
    const data = `event: converter:progress\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) {
      try { res.write(data); } catch { clients.delete(res); }
    }
  }
  function attach(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.write('event: hello\ndata: {}\n\n');
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
    const done = () => { clearInterval(ping); clients.delete(res); };
    req.on('close', done);
    res.on?.('close', done);
  }

  // ---- answers
  const current = () => { tick(); return { ok: true, value: strip(job) }; };

  function devices() {
    const node = (n) => [
      { id: `node:${n.id}@${n.gpu.id}`, kind: 'node', nodeId: n.id, nodeName: n.name, deviceId: n.gpu.id, deviceKind: n.gpu.kind, deviceName: n.gpu.name,
        name: `${n.name} · ${n.gpu.name}`, isDefault: true, node: null, index: null, pci: null, slots: n.slots, online: true,
        encoders: { h265: n.gpu.h265, av1: n.gpu.av1 } },
      { id: `node:${n.id}@cpu`, kind: 'node', nodeId: n.id, nodeName: n.name, deviceId: 'cpu', deviceKind: 'cpu', deviceName: 'CPU',
        name: `${n.name} · CPU`, isDefault: false, node: null, index: null, pci: null, slots: 0, online: true,
        encoders: { h265: 'libx265', av1: 'libsvtav1' } }
    ];
    return {
      ok: true,
      value: {
        devices: [
          { id: GPU, kind: 'nvidia', vendor: 'nvidia', name: LOCAL.name, node: null, index: 0, pci: '0000:01:00.0', encoders: { h265: 'hevc_nvenc', av1: 'av1_nvenc' } },
          { id: 'cpu', kind: 'cpu', vendor: null, name: 'CPU (software encoder)', node: null, index: null, pci: null, encoders: { h265: 'libx265', av1: 'libsvtav1' } },
          ...NODES.flatMap(node)
        ],
        defaultDevice: GPU,
        defaultDevices: { h265: GPU, av1: GPU }
      }
    };
  }

  function nodesOverview(worker) {
    tick();
    const now = Date.now();
    return {
      nodes: NODES.map((n, i) => {
        const busy = slots.filter((s) => s.item && s.lane.node === n).length;
        return {
          id: n.id, name: n.name, address: n.host, pairedAt: now - (40 + i * 23) * 86400_000, online: true, error: null,
          encoders: { h265: n.gpu.h265, av1: n.gpu.av1 }, slots: n.slots, busy, encoding: busy,
          devices: [
            { id: n.gpu.id, lane: `node:${n.id}@${n.gpu.id}`, kind: n.gpu.kind, name: n.gpu.name, encoders: { h265: n.gpu.h265, av1: n.gpu.av1 }, slots: n.slots, isDefault: true },
            { id: 'cpu', lane: `node:${n.id}@cpu`, kind: 'cpu', name: n.cpuName, encoders: { h265: 'libx265', av1: 'libsvtav1' }, slots: 0, isDefault: false }
          ],
          defaultLane: `node:${n.id}@${n.gpu.id}`, defaultDeviceName: n.gpu.name,
          fingerprint: crypto.createHash('sha256').update(`demo-${n.id}`).digest('hex').toUpperCase().match(/../g).join(':'),
          cars: vehicleId ? [vehicleId] : [], trusted: true
        };
      }),
      worker
    };
  }

  function workers(now) {
    return slots.filter((s) => s.item).map((s) => {
      const f = Math.min(1, (now - s.start) / s.dur);
      const speed = Math.round(speedOf(s) * 10) / 10;
      return {
        jobId: job.id, itemId: s.item.id, relativePath: s.item.relativePath, encoder: s.lane.encoder, hardware: true,
        decode: 'gpu',
        device: null, node: s.lane.node ? `${s.lane.node.name} · ${s.lane.gpuName}` : null, deviceId: s.lane.device, remote: Boolean(s.lane.node),
        started: true, pid: s.pid, fps: Math.round(speed * FPS), speed, bitrateKbps: 3900 + Math.round(Math.random() * 400),
        frame: Math.round(f * FPS * 60), outTimeUs: Math.round(f * CLIP_US), durationUs: CLIP_US, dropFrames: 0, dupFrames: 0,
        totalSizeB: Math.round(s.item.sourceBytes * 0.32 * f)
      };
    });
  }

  /** /api/stats with the pretend job, this server's GPU and the nodes' power. */
  function patchStats(stats) {
    tick();
    const now = Date.now();
    const ws = job.state === 'completed' ? [] : workers(now);
    const local = ws.filter((w) => !w.remote).length;
    const gpu = {
      id: '0', name: LOCAL.name, vendor: 'nvidia', driver: '570.86.16', node: null,
      busy: local ? 18 + Math.round(Math.random() * 9) : 1, video: local ? Math.min(97, 40 + local * 9 + Math.round(Math.random() * 4)) : 0,
      vramUsedB: (local ? 2.1 + local * 0.35 : 0.4) * 1024 ** 3, vramTotalB: 12 * 1024 ** 3, clockMHz: local ? 2475 : 210,
      tempC: local ? 61 + Math.round(Math.random() * 4) : 38, powerW: local ? 92 + local * 6 + Math.round(Math.random() * 5) : 14, clients: null
    };
    const cpuW = Math.round((stats.power?.cpuW ?? 38) * 10) / 10 || 38;
    const own = { cpuW, gpuW: gpu.powerW, totalW: Math.round((cpuW + gpu.powerW) * 10) / 10, todayWh: Math.round(job._wh * 1000) / 1000 + 900, weekWh: 6400 };
    const nodeRows = NODES.map((n) => {
      const busy = ws.filter((w) => w.remote && w.deviceId.startsWith(`node:${n.id}`)).length;
      const gpuW = Math.round((busy * n.perClipW + 9) * 10) / 10;
      const totalW = Math.round((n.idleW + gpuW) * 10) / 10;
      return { id: n.id, name: n.name, online: true, known: true, cpuW: n.idleW, gpuW, totalW, todayWh: 700 + busy * 40, weekWh: 4100, cpuUnavailable: null, gpus: [{ name: n.gpu.name, w: gpuW }] };
    });
    const sum = (k) => Math.round((own[k] + nodeRows.reduce((s, r) => s + r[k], 0)) * 10) / 10;
    const devicesBlock = [
      { id: GPU, name: LOCAL.name, node: null, encoder: 'hevc_nvenc', hardware: true, workers: local, video: gpu.video, busy: gpu.busy },
      ...NODES.map((n) => ({ id: `node:${n.id}@${n.gpu.id}`, name: `${n.name} · ${n.gpu.name}`, node: null, encoder: n.gpu.h265, hardware: true, workers: ws.filter((w) => w.deviceId === `node:${n.id}@${n.gpu.id}`).length, video: null, busy: null }))
    ];
    return {
      ...stats,
      gpus: [gpu, ...(Array.isArray(stats.gpus) ? stats.gpus : [])],
      power: {
        ...(stats.power || {}), ...own, cpuSource: stats.power?.cpuSource || 'rapl', gpuSource: 'nvidia-smi',
        nodes: nodeRows, combined: { cpuW: sum('cpuW'), gpuW: sum('gpuW'), totalW: sum('totalW'), todayWh: sum('todayWh'), weekWh: sum('weekWh'), todayCost: null, weekCost: null }
      },
      encoder: {
        jobId: job.id, state: job.state, running: job.state !== 'completed', workers: ws, concurrency: job.config.concurrency,
        device: { encoder: 'hevc_nvenc', hardware: true, gpuName: LOCAL.name, node: null, decode: 'gpu' },
        devices: devicesBlock,
        run: {
          wh: Math.round((job._wh + job._nodeWh) * 10) / 10, avgW: Math.round(own.totalW + nodeRows.reduce((s, r) => s + r.totalW, 0)), cost: null,
          nodeWh: Math.round(job._nodeWh * 10) / 10, clips: job.counters.files, savedB: job.counters.savedBytes,
          // the energy those clips took (for clips and space saved per kWh)
          sinceWh: Math.round((job._wh + job._nodeWh) * 10) / 10, cpuMeasured: true, startedAt: job.createdAt
        }
      }
    };
  }

  function jobsEntry() {
    const done = job.state === 'completed';
    return {
      id: job._jobsId, type: 'conversion', vehicleId, status: done ? 'done' : 'running', title: `Convert ${vehicleName} to H.265`,
      detail: `${done ? 'done' : 'encoding'}: ${job.counters.files} converted, ${job._skipped} skipped, ${job._failed} failed`,
      startedAt: job.createdAt, finishedAt: done ? job._doneAt : null, result: null, externalId: `converter:${job.id}`
    };
  }

  /** /api/jobs: the pretend conversions in place of any real one. */
  function patchJobs(body) {
    tick();
    const real = (body?.jobs || []).filter((j) => j.type !== 'conversion');
    const all = [jobsEntry(), ...history.slice().reverse(), ...real];
    return { ...body, jobs: all.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)) };
  }

  const timer = setInterval(() => tick(), 1000);
  timer.unref();
  tick();
  return { current, devices, nodesOverview, patchStats, patchJobs, attach, tick, _slots: slots, get job() { return job; } };
}

module.exports = { createFakeEncoder, NODES, GPU };
