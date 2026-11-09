# Sentry Six Manager demo

[Sentry Six Manager](https://github.com/skittles-fivem/Sentry-Manager), the
real app, in demo mode: no sign-in, nothing can be changed, and real Tesla
drives that are **highway driving only**. Anyone can open it and try every
page: the six-camera Viewer with telemetry and the map, Footage, Drives, the
Encoder running a real conversion, Jobs, Policies, Recycle Bin, Health and
Settings.

It is the published manager image with a small layer on top (`demo/`). The
manager itself is not changed, and the image is rebuilt every night on the
newest manager, so the demo always shows the current version.

## Run it

```bash
curl -fsSLO https://raw.githubusercontent.com/skittles-fivem/Sentry-Manager-Demo/main/docker-compose.yml
docker compose up -d
docker logs -f sentry-manager-demo     # "[demo] ready" when it is set up
```

Open `https://<server>:9000` and continue past the one-time certificate
warning. Everything lives in memory and starts over every 24 hours and at
every restart.

### On the internet

Put it behind a reverse proxy that does HTTPS with a real certificate:

- **Caddy:** `demo.example.com { reverse_proxy https://127.0.0.1:9000 { transport http { tls_insecure_skip_verify } } }`
- **Cloudflare Tunnel:** service `https://localhost:9000` with *No TLS Verify* on.
- **Or** set `TLS_MODE=off` and `TRUST_PROXY=1` in the compose file and
  proxy to `http://127.0.0.1:9000` (only from the proxy: do not publish the
  port to the internet then).

If you set `TRUSTED_HOSTS`, include `localhost`: the demo sets itself up
through the app's API on `localhost`.

## What visitors can and cannot do

| | |
| --- | --- |
| Can | Browse every page; play footage; scrub; see telemetry, the map and CAN data; read Drives, Moments and stats; watch the Encoder; make an export and download it (at most 2 waiting or rendering at once, for everyone) |
| Cannot | Delete, move, protect, trash or restore anything; start, pause or cancel conversions; change any setting, vehicle, policy, place or account; upload an interface; turn on CAN uploads; sign out |
| Never shown | The server's logs, sessions, certificates, nodes and CAN tokens (empty stand-ins), and the setup code (there is none) |

Anything not on the allowed list in [`demo/policy.js`](demo/policy.js) is
refused, so a new feature in the manager that changes something stays off in
the demo until it is added there on purpose. Preferences the pages save as
they go (the Viewer's layout) are answered as saved and forgotten.

The demo only ever empties `/data` and `/footage` if it made them itself
(they carry a `.sentry-manager-demo` marker). Pointed at a real data or
footage folder by mistake, it refuses to start instead.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `DEMO_RESET_HOURS` | `24` | Hours between fresh starts (`0`: only on restart) |
| `DEMO_EXPORT_QUEUE` | `2` | Exports waiting or rendering at once, for all visitors |
| `DEMO_CONVERT` | `on` | A real H.265 conversion of the demo footage after each reset (`off`: none) |
| `DEMO_CONVERT_PARALLEL` | `1` | Clips that conversion encodes at once |

Every [manager setting](https://github.com/skittles-fivem/Sentry-Manager/blob/main/docs/settings.md)
works too (`TZ`, GPUs for the Encoder, and so on).

## The demo drives

The footage and CAN data in `seed/` are real drives cut down to highway
driving by [`tools/sanitize.js`](tools/sanitize.js), so no home, work or other
place the car stops is in the demo. Per one-minute clip, it keeps only:

- RecentClips and SavedClips (SentryClips, recorded while parked, never);
- minutes driven at 50 mph or more for the whole minute, read from the car's
  own telemetry in every frame, with GPS;
- not the first or last 3 minutes of any drive;
- not within 3 km of anywhere a drive started, ended or stood still for 30
  seconds, or of any extra place you name with `--avoid lat,lon,km`.

And in what it keeps, it:

- moves every date by a random 60 to 400 days (time of day kept);
- zeroes the MP4 creation times, and refuses any file that holds a VIN;
- rewrites a Saved event's `event.json` with only its time, reason and
  highway position (no city or street);
- keeps only the CAN frames of the kept minutes, drops the VIN frames
  (0x405, 0x508), shifts the times to match the footage, renames the car key
  and writes a new sidecar without the VIN or signature.

Then [`tools/blur/blur.py`](tools/blur/blur.py) blurs other cars' license
plates in every frame it keeps (a YOLO license-plate model, looking every
3rd frame and holding each box from one look to the next, widened by a
third). Re-encoding would lose Tesla's per-frame telemetry and timing, so
[`transplant.js`](tools/blur/transplant.js) copies them back from the
original, byte for byte: the dashboard, map and sync work as before. A
minute where any camera cannot be done exactly is removed, all six cameras.

### Updating the drives

You need Docker. Build the tools image once (the manager image plus Python,
onnxruntime and the plate model):

```powershell
docker build -t sentry-demo-tools tools/blur
```

Then, on Windows in PowerShell (change the two input folders):

```powershell
# 1. highway minutes only (add --dry-run first to see what would be kept)
docker run --rm `
  -v "D:\TeslaCam:/in:ro" -v "D:\CAN logs:/can:ro" `
  -v "${PWD}\seed:/out" -v "${PWD}\tools:/tools:ro" `
  sentry-demo-tools node /tools/sanitize.js --in /in --can /can --out /out --tz America/Chicago

# 2. license plates blurred (slow: plan on several minutes per minute of footage)
docker run --rm -v "${PWD}\seed:/work" sentry-demo-tools python3 /tools/blur/blur.py /work/footage
```

`blur.py` takes `--every N` (look every N frames; fewer is faster, more
is safer), `--tiles N` (more catches smaller, farther plates) and `--score`.

Step 1 writes `seed/report.private.json`: what was kept and dropped, and the
real times. That file stays on your computer (it is in `.gitignore` and
`.dockerignore`). Then watch `seed/footage` yourself before publishing: the
filter works from GPS and speed and the plate model can miss one, and only
your eyes can tell whether a sign or an exit gives away more than you want.

The footage is too large for git. Pack it and attach it to the `seed`
release; the nightly build picks it up:

```bash
tar -cf seed.tar -C seed footage can vehicles.json
gh release create seed seed.tar --title "Demo drives" --notes "Highway-only demo drives" \
  || gh release upload seed seed.tar --clobber
```

## Development

```bash
npm test                                         # the demo policy
node tools/synthetic.js <manager checkout> seed/footage/demo-car 4   # test footage
docker build -t manager-demo:dev .
docker run --rm -p 9000:9000 --read-only --user 1000:1000 --cap-drop ALL \
  --tmpfs /data:uid=1000,gid=1000 --tmpfs /footage:uid=1000,gid=1000 manager-demo:dev
python3 tools/screens.py https://localhost:9000 shots/   # every page, desktop and phone
```

| | |
| --- | --- |
| `demo/preload.js` | Loaded into the app (`NODE_OPTIONS`): signs everyone in as `demo`, puts the gate in front of the app, starts fresh, resets |
| `demo/policy.js` | What a visitor may do |
| `demo/seed.js`, `demo/seedCan.js` | Adds the vehicle, scans, starts a conversion and uploads the CAN data, all through the app's own API |
| `demo/banner.*` | The demo note on the pages |
| `tools/sanitize.js` | Real drives to highway-only demo drives |
| `tools/blur/` | Plate blurring (`blur.py`), telemetry and timing put back (`transplant.js`), the tools image (`Dockerfile`) |
| `tools/synthetic.js` | Synthetic test footage with telemetry |
| `tools/screens.py` | Screenshots of every page, desktop and phone |

## License

MIT, like Sentry Six Manager. The viewer and converter inside are
[Sentry Studio](https://github.com/ChadR23/Sentry-Six) by Chad and Scott
Vandereems.
