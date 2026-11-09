#!/usr/bin/env python3
"""Blurs other cars' license plates in the demo footage, keeping Tesla's
telemetry and frame timing (transplant.js puts them back after encoding).

    python3 blur.py <footage dir> [--every 3] [--tiles 2] [--score 0.25]

Works in place on a folder made by sanitize.js: every *.mp4 under it is
decoded, plates are found with a YOLO license-plate model (ONNX, run with
onnxruntime on the CPU) every --every frames, each box is held from the
detection before it to the one after (so a plate is never visible between
two looks), widened by a third and pixelated, then encoded again as H.264
and given the original's telemetry and timing back. A minute whose camera
cannot be done exactly (frames the decoder cannot show) is removed whole,
all six cameras: nothing goes out unblurred.

Run it in the blur image (tools/blur/Dockerfile), which has the model,
onnxruntime, OpenCV, ffmpeg and the manager's MP4 code.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

HERE = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument('footage')
ap.add_argument('--model', default=str(HERE / 'plates.onnx'))
ap.add_argument('--every', type=int, default=3, help='look for plates every N frames')
ap.add_argument('--tiles', type=int, default=2, help='split each frame into N columns (small, far plates)')
ap.add_argument('--score', type=float, default=0.25)
ap.add_argument('--crf', type=int, default=21)
ap.add_argument('--app', default=os.environ.get('APP_ROOT', '/app'))
a = ap.parse_args()

sess = ort.InferenceSession(a.model, providers=['CPUExecutionProvider'])
inp = sess.get_inputs()[0]
SIZE = inp.shape[2] if isinstance(inp.shape[2], int) else 640


def probe(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=width,height,avg_frame_rate', '-show_entries', 'packet=flags',
                          '-of', 'json', path], capture_output=True, check=True, text=True).stdout
    d = json.loads(out)
    st = d['streams'][0]
    flags = [p.get('flags', '') for p in d.get('packets', [])]
    first_key = next((i for i, f in enumerate(flags) if 'K' in f), None)
    num, den = (st.get('avg_frame_rate') or '36/1').split('/')
    fps = float(num) / float(den or 1) if float(den or 1) else 36.0
    return st['width'], st['height'], len(flags), first_key, fps or 36.0


def detect(frame):
    """Plate boxes (x0, y0, x1, y1) in frame pixels."""
    h, w = frame.shape[:2]
    boxes, scores = [], []
    n = max(1, a.tiles)
    tw = w // n
    pad = tw // 6
    for t in range(n):
        x0 = max(0, t * tw - pad)
        x1 = min(w, (t + 1) * tw + pad)
        tile = frame[:, x0:x1]
        th, tw2 = tile.shape[:2]
        s = SIZE / max(th, tw2)
        nh, nw = int(round(th * s)), int(round(tw2 * s))
        img = np.full((SIZE, SIZE, 3), 114, np.uint8)
        img[:nh, :nw] = cv2.resize(tile, (nw, nh), interpolation=cv2.INTER_LINEAR)
        blob = img[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32) / 255.0
        out = sess.run(None, {inp.name: blob})[0][0]  # (5, N): cx, cy, w, h, score
        if out.shape[0] > out.shape[1]:
            out = out.T
        keep = out[4] >= a.score
        for cx, cy, bw, bh, sc in out[:, keep].T:
            bx = (cx - bw / 2) / s + x0
            by = (cy - bh / 2) / s
            boxes.append([int(bx), int(by), int(bw / s), int(bh / s)])
            scores.append(float(sc))
    if not boxes:
        return []
    idx = cv2.dnn.NMSBoxes(boxes, scores, a.score, 0.45)
    res = []
    for i in np.array(idx).flatten():
        x, y, bw, bh = boxes[i]
        res.append((x, y, x + bw, y + bh))
    return res


def blur(frame, boxes):
    h, w = frame.shape[:2]
    for x0, y0, x1, y1 in boxes:
        mx, my = (x1 - x0) // 3 + 4, (y1 - y0) // 2 + 4
        x0, y0, x1, y1 = max(0, x0 - mx), max(0, y0 - my), min(w, x1 + mx), min(h, y1 + my)
        if x1 - x0 < 2 or y1 - y0 < 2:
            continue
        roi = frame[y0:y1, x0:x1]
        # pixelate to about 4 by 3 blocks, then soften: no character survives
        small = cv2.resize(roi, (max(1, min(4, (x1 - x0) // 8)), max(1, min(3, (y1 - y0) // 8))), interpolation=cv2.INTER_AREA)
        frame[y0:y1, x0:x1] = cv2.GaussianBlur(cv2.resize(small, (x1 - x0, y1 - y0), interpolation=cv2.INTER_LINEAR), (0, 0), max(2.0, (x1 - x0) / 20))


def process(path):
    w, h, packets, first_key, fps = probe(path)
    if first_key is None:
        return 'no keyframe'
    tmp = path.with_suffix('.blur.mp4')
    dec = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-flags2', '+showall', '-i', str(path), '-an',
                            '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-'],
                           stdout=subprocess.PIPE)
    enc = subprocess.Popen(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24',
                            '-s', f'{w}x{h}', '-r', f'{fps:.3f}', '-i', '-', '-an', '-c:v', 'libx264', '-preset', 'medium',
                            '-crf', str(a.crf), '-bf', '0', '-g', str(max(1, round(fps))), '-pix_fmt', 'yuv420p',
                            '-use_editlist', '0', '-tag:v', 'avc1', str(tmp)], stdin=subprocess.PIPE)
    size = w * h * 3
    every = max(1, a.every)
    frames, found = [], 0
    prev_boxes, n, first_good = [], 0, None

    def flush(next_boxes):
        nonlocal frames, prev_boxes
        for f in frames:
            blur(f, prev_boxes + next_boxes)
            enc.stdin.write(f.tobytes())
        frames = []
        prev_boxes = next_boxes

    while True:
        buf = dec.stdout.read(size)
        if len(buf) < size:
            break
        f = np.frombuffer(buf, np.uint8).reshape(h, w, 3).copy()
        # lead-in frames (before the first keyframe) only decode with the
        # previous minute: they show the first good frame instead, as the
        # manager's converter does
        if n < first_key:
            frames.append(None)
        else:
            if first_good is None:
                first_good = f
                frames = [first_good.copy() if x is None else x for x in frames]
            if (n - first_key) % every == 0:
                boxes = detect(f)
                found += len(boxes)
                flush(boxes)
            frames.append(f)
        n += 1
    flush([])
    dec.wait()
    enc.stdin.close()
    enc.wait()
    if dec.returncode or enc.returncode:
        tmp.unlink(missing_ok=True)
        return 'ffmpeg failed'
    if n != packets:
        tmp.unlink(missing_ok=True)
        return f'decoded {n} of {packets} frames'
    done = subprocess.run(['node', str(HERE / 'transplant.js'), str(path), str(tmp), str(path) + '.new', '--app', a.app],
                          capture_output=True, text=True)
    tmp.unlink(missing_ok=True)
    if done.returncode:
        Path(str(path) + '.new').unlink(missing_ok=True)
        return f'telemetry: {done.stderr.strip()[:200]}'
    os.replace(str(path) + '.new', path)
    return found


root = Path(a.footage)
files = sorted(root.rglob('*.mp4'))
KEY = re.compile(r'^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-')
bad_keys, report = set(), {}
for i, p in enumerate(files, 1):
    r = process(p)
    report[str(p.relative_to(root))] = r
    print(f'[{i}/{len(files)}] {p.name}: ' + (f'{r} plate boxes' if isinstance(r, int) else f'FAILED ({r})'), flush=True)
    if not isinstance(r, int):
        m = KEY.match(p.name)
        if m:
            bad_keys.add((p.parent, m.group(1)))
# a minute with a camera that could not be blurred goes, all cameras
for parent, key in bad_keys:
    for f in parent.glob(f'{key}-*.mp4'):
        f.unlink()
    print(f'removed minute {key} (a camera could not be blurred)')
total = sum(v for v in report.values() if isinstance(v, int))
print(f'{len(files)} files, {total} plate boxes blurred, {len(bad_keys)} minutes removed')
sys.exit(0)
