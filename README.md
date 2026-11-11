# Sentry Six Manager demo

[Sentry Six Manager](https://github.com/skittles-fivem/Sentry-Manager), the
real app, in demo mode: no sign-in, nothing can be changed, and real Tesla
drives that are **highway driving only**. Anyone can open it and try every
page: the six-camera Viewer with telemetry and the map, Footage, Drives, the
Encoder converting across nodes, Jobs, Policies, Recycle Bin, Health and
Settings.

It is the published manager image with a small layer on top (`demo/`). The
manager itself is not changed, and the image is rebuilt every night on the
newest manager, so the demo always shows the current version.

## Run it

```bash
curl -fsSLO https://raw.githubusercontent.com/skittles-fivem/Sentry-Manager-Demo/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/skittles-fivem/Sentry-Manager-Demo/main/.env.example
# fill in .env: the owner password, the feedback webhook, Let's Encrypt, Cloudflare
docker compose up -d
docker logs -f sentry-manager-demo     # "[demo] ready" when it is set up
```

Open `https://<server>` (ports 80 and 443 both go to the app's port 9000).
Without Let's Encrypt, continue past the one-time certificate warning. The
demo lives in memory and starts over every 24 hours and at every restart;
only the `demo-state` volume is kept (below).

### On the internet

**HTTPS built in (Let's Encrypt).** The manager gets and renews its own
Let's Encrypt certificate when `TLS_ACME_DOMAIN` is set:

1. Point the name's DNS at the server and publish ports 80 and 443 to the
   container's 9000 (`80:9000` and `443:9000`, as in the compose file):
   Let's Encrypt checks `http://<name>/.well-known/acme-challenge/…`, which
   the app answers on the same port; everything else on port 80 is sent to
   `https://`.
2. Set `TLS_ACME_DOMAIN=demo.example.com` (and `TLS_ACME_EMAIL` if you want
   Let's Encrypt's notices) in `.env`, then `docker compose up -d`.
3. **Behind Cloudflare** (orange cloud): SSL/TLS mode **Full** until the
   certificate is issued (Cloudflare accepts the self-signed one meanwhile),
   then **Full (strict)**. Set `TRUST_CLOUDFLARE=1`, so the demo sees each
   visitor's own address (`CF-Connecting-IP`, believed only from Cloudflare's
   published ranges) for its attack log, bans and rate limits.

The certificates (and the app's own CA) are kept in the `demo-state` volume,
`/demo-state/tls`: the manager keeps them in `/data/tls`, which the demo
starts over at every reset, so the demo links that folder into the volume
(`DEMO_KEEP_TLS=off` stops it). Restarts and resets never ask Let's Encrypt
again, so its rate limits are never hit.

**This needs a manager image with Let's Encrypt.** It is on the manager's
release branch and not yet in its `latest` image, which this demo is built
on; with an image that lacks it, `TLS_ACME_DOMAIN` does nothing and the
self-signed certificate is served (Cloudflare's **Full** works with that).
To use it before it is in `latest`, build the demo on a manager image that
has it: `docker build --build-arg MANAGER_TAG=<tag> -t sentry-manager-demo .`
(or the `build:` lines in `docker-compose.yml`). The stand-in Sentry USB
needs the same (below).

**Or** put it behind a reverse proxy that does HTTPS with a real certificate:

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
| Can | Swap their own browser to the Horizon interface and back; browse every page; play footage; scrub; see telemetry, the map and CAN data; read Drives, Moments and stats; watch the Encoder and Nodes at work; save no files: every download (footage, logs, the support bundle, CAN logs, the Sentry USB's diagnostics and backups) says downloads are off and the server sends such files back empty ([`demo/noDownloads.js`](demo/noDownloads.js)); make an export (pretend: it waits, renders and finishes, but nothing is rendered and Download only says downloads are off, [`demo/fakeExport.js`](demo/fakeExport.js)) |
| Can, on the demo's own Sentry USB | Change its settings, reboot it, shut it down, sync, re-run setup, check for and install updates, delete snapshots, back it up, gather diagnostics: the stand-in Pi carries them out, and forgets them at the reset |
| Cannot | Delete, move, protect, trash or restore anything; start, pause or cancel conversions; change any setting, vehicle, policy, place or account; pair, rename or unpair a Sentry USB; upload an interface; turn on CAN uploads; sign out |
| Never shown | The server's logs, sessions, certificates and CAN tokens (empty stand-ins), and the setup code (there is none) |

### The conversion on the Encoder page is pretend

So visitors see a whole archive converting the way it does at home, the
Encoder runs a pretend H.265 job ([`demo/fakeEncoder.js`](demo/fakeEncoder.js)):
5,400 clips, spread over this server's GPU (an RTX 4070, 6 at once, about 2,280 fps) and two
paired nodes, a **Garage PC** (RTX 3060, 4 at once, about 1,160 fps) and an **Office NAS**
(Intel Arc A380, 3 at once, about 930 fps). It moves in real time: clips finish, space
saved and energy add up, the Hardware panel shows every GPU and each
server's power, the Nodes page shows both nodes online and busy, and Jobs
lists it with two earlier runs. It takes about 45 minutes, shows its summary
for three minutes, and starts again. Nothing is encoded and no node exists:
the demo answers those pages' requests itself, in the shapes the app uses.

### The Sentry USB page has a live "Demo Model Y"

A stand-in Sentry USB, the Pi in the car
([`demo/sentryUsb/`](demo/sentryUsb/)), starts with the demo, as a child
process once the app is set up. It pairs the way a person does in Settings:
the demo opens a pairing slot through the app's API on localhost, and the
stand-in proves the code over the app's device port with the real link
protocol (v2, then its link key). Its settings file, logs, snapshots and
backups are in `/data`, so they start over at every reset.

Visitors may change it, and only it: [`demo/policy.js`](demo/policy.js)
lets through exactly the app's `/api/sentryusb/<its id>/proxy/...` routes
the stand-in carries out (settings saves, reboot, shut down, sync, setup,
updates, snapshot deletes, backups, diagnostics), 20 a minute per visitor.
It applies the Pi's own rules: only settable keys change, values are
checked, secrets are masked and kept when sent empty, and every change is
logged as the Pi logs it. A reboot comes back in 20 to 30 seconds, a shut
down after 3 minutes. It needs a manager image with the Sentry USB link
(the manager's release branch, `MANAGER_TAG`); without it the page is not
there and the stand-in does not start. `DEMO_SENTRYUSB=off` leaves it out.

### Swap to Horizon UI

The demo note has a **Swap to Horizon UI** button (and then **Swap to
original UI**): that browser alone is shown Horizon, the synthwave interface
pack that comes with the app, on every page. It is a cookie
(`demo_ui=horizon`, HttpOnly, SameSite=Strict, Secure), set by
`POST /demo/ui {"ui": "horizon" | "original"}`; the demo makes the app's
interface packs answer Horizon for requests that carry it
([`demo/uiSwap.js`](demo/uiSwap.js)), the way the app's own `/original`
cookie gives one browser the built-in interface. The interface chosen for
everyone is never changed, and `PUT /api/ui-packs/active` stays refused, so
no visitor changes what the others see.

### The Viewer starts with the owner's car-data layout

[`demo/viewerLayout.js`](demo/viewerLayout.js) saves it for the demo
account at every reset: three 3-in-1 blocks (Battery temp, HV Battery
Current, Battery power; Battery Coolant Temp, 12V Battery Voltage, 12V
Battery Current; Outside Temperature, Cabin Temperature, Steering), then
the *Every stat* List with *Changing only* ticked, in °F and mph. A
visitor's own rearranging is answered as saved and forgotten.

On the Viewer, at every window size and display scaling (checked from
1366×768 to 4K, 100 % to 300 %, in both interfaces), the cameras end above
the car-data bar and the Clips panel stops at it; the demo note folds to a
small "Demo" tab in the corner and the watermark moves under the sidebar's
demo card, so neither covers the playback controls ([`demo/banner.js`](demo/banner.js)).

### Feedback

The demo note links a feedback page (`/demo/feedback`): a message (2,000
characters at most), an optional name or contact, and the page it came from.
The demo sends it to the Discord webhook in `DEMO_FEEDBACK_WEBHOOK`
([`demo/feedback.js`](demo/feedback.js)); without one, the page says
feedback is off. The webhook's address never leaves the server: not in a
page, an answer or a log, and the browser only hears "Thanks, sent" or
"Couldn't send, try again later".

- One embed, with `allowed_mentions` empty (nobody is pinged), the text's
  Discord markdown escaped, mentions broken and links wrapped in `<…>` (no
  previews); the time, the page, the visitor's whole address and their
  machine as their browser describes it (OS, browser, device, CPU threads,
  memory, graphics, screen, window, language, time zone, user agent), for
  bugs that only show on their hardware. The form says this is sent.
- Feedback opens as a pop-up over the page (the Feedback link in the demo
  note); `/demo/feedback` is the same form as a page.
- At most 10 an hour from one address (the answer says how long to wait), no limit for everyone together; a
  hidden field only bots fill; at least 3 seconds on the page; no empty or
  link-only messages. Each hit is noted in the attack log.
- It is the only network call the demo makes: to
  `https://discord.com/api/webhooks/...` or `https://discordapp.com/api/webhooks/...`
  only, with an 8-second timeout, never following a redirect.

### The owner page

`/owner` is for whoever runs the demo, with `DEMO_OWNER_PASSWORD`
([`demo/owner.js`](demo/owner.js)). It opens only from a local address
(LAN or loopback) and over HTTPS; never through Cloudflare (a request with
Cloudflare's headers or from its addresses), and never from the container's
Docker gateway, which every visitor through Docker's port proxy looks like.
Anyone else is sent to `/`, and the attempt is noted. Open it from another
computer on your network, `https://<server's LAN address>/owner`.

- **The attack log:** visits to `/owner`, scanner paths, exploit patterns,
  writes the demo refused, rate-limit hits, wrong owner passwords, feedback
  spam and bans, by real address (Cloudflare-aware). Repeats collapse into a
  count per address and kind; each address folds open; at most 5,000 rows,
  30 days; filter, sort, CSV export, and a one-tap ban (30 days; every
  request from a banned address, or its IPv6 /64, is refused).
- **Live now:** who has the demo open, the page they are on (updated within a couple of seconds of moving) and their last 8 actions, refreshed every 4 s.
- **Visitors** ([`demo/visitors.js`](demo/visitors.js), tracker
  [`demo/track.js`](demo/track.js)): one row per address, newest first, in a
  scroll box of about six rows: first and last seen, visits (a new one after
  30 minutes idle), time actively in the demo (only while the tab is
  visible, heartbeats every ~15 s, never more than the server's clock),
  time per interface and swaps, pages opened and the nav pages never opened
  (a tick for every page), labels of the controls used (never what was
  typed), changes the demo blocked, device, country (Cloudflare's
  CF-IPCountry) and feedback sent (a count; the text stays in Discord). A
  row opens to its last 200 events. At most 2,000 visitors, 30 days. The
  demo note tells visitors that visits are logged.
- Visitor counts (distinct addresses a day, kept only as a count), Reset now,
  the certificate and Let's Encrypt's state, and the footage import (below).

### What is kept across resets

The `demo-state` volume (`/demo-state`, a fixed name:
`sentry-manager-demo-state`): the attack log, bans, visitor counts and activity, the
owner page's sessions, the feedback limits, the certificates, and your
imported footage. Everything else starts over. Without the volume the demo
still runs; those are then kept in memory only, until the next reset.

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
| `DEMO_FAKE_ENCODER` | `on` | The pretend conversion with nodes (`off`: the Encoder shows the real server) |
| `DEMO_FAKE_CLIPS` | `5400` | Clips in each pretend job |
| `DEMO_FAKE_MINUTES` | | Stretch a pretend job to this many minutes (unset: the GPUs' real speeds, about 45 minutes) |
| `DEMO_CONVERT` | `off` | A real H.265 conversion of the demo footage after each reset (default `on` when the pretend one is off) |
| `DEMO_CONVERT_PARALLEL` | `1` | Clips that conversion encodes at once |
| `DEMO_MORE_CARS` | `on` | Three more cars (Model 3, S, X) made from your footage as links, each a different slice (`off`: just the one car) |
| `DEMO_SHOWCASE` | `on` | At every start, through the app's API: each car's encoding settings, policies, saved places, stars, protected clips, a few recordings in the Recycle Bin and one export |
| `DEMO_IMPORT_DIR` | `/demo-import` | Where the prepared footage folder is mounted (for a local run) |
| `DEMO_SENTRYUSB` | `on` | The stand-in Sentry USB visitors may change (`off`: none) |
| `DEMO_OWNER_PASSWORD` | | The owner page's password (from `.env`); empty: no owner page |
| `DEMO_FEEDBACK_WEBHOOK` | | The Discord webhook for feedback (from `.env`); empty: feedback off |
| `TLS_ACME_DOMAIN`, `TLS_ACME_EMAIL` | | Let's Encrypt for this name (a manager image with it, see "On the internet") |
| `TRUST_CLOUDFLARE` | `0` | `1` behind Cloudflare's proxy: the visitor is `CF-Connecting-IP`, only from Cloudflare's ranges (`CLOUDFLARE_IPS` replaces them) |
| `DEMO_STATE` | `/demo-state` | What survives the resets |
| `DEMO_KEEP_TLS` | `on` | Keep the certificates in `DEMO_STATE` (`off`: they start over with the demo) |
| `DEMO_RATE_PER_MINUTE` | `3000` | Requests a minute from one address before it is told to wait |

The owner password and the webhook are read once at start and taken out of
the environment, so neither the app nor anything it starts sees them.

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

### Your own footage, from the owner page

The owner page takes your `highway_footage_with_can` folder and puts it
through the same pipeline before anyone sees it
([`demo/importer.js`](demo/importer.js)):

```
footage/YYYY-MM-DD/<YYYY-MM-DD_HH-MM-SS>-{front,back,left_repeater,right_repeater}.mp4   (local time, CST)
can_logs/*.log.xz, *.log.xz.json (canbridge-columns-xz/2), ids.csv, manifest.json
highway_stretches.csv, README.txt
```

1. **Upload it** (choose the folder: chunked, resumable, as large as the
   volume's free space; only those paths are taken, into
   `/demo-state/import`), **or mount it** read-only at `/demo-import` (the
   commented line in `docker-compose.yml`). `README.txt` and
   `highway_stretches.csv` are never uploaded or read: they name places.
2. **Sanitize:** `tools/sanitize.js` runs in the container with
   `--tz America/Chicago` and writes a new seed into `/demo-state/pending`:
   highway minutes only, no home, work or stops, dates moved, no VIN. Add
   your Home and Work coordinates (`lat,lon[,km]`) as places to keep out;
   they stay in the volume and are never published.
3. **License plates:** the blur needs the tools image, so the page says the
   plates are not blurred and shows the exact commands to blur the pending
   seed on the server (it then sees that every clip was re-encoded):

   ```bash
   docker build -t sentry-demo-tools tools/blur      # once, in a checkout of this repo
   docker run --rm --user 1000:1000 -v sentry-manager-demo-state:/state sentry-demo-tools python3 /tools/blur/blur.py /state/pending/footage
   ```

   Or blur the folder on your computer (below), tick "blurred before I
   uploaded it" and upload it again. Publishing unblurred footage needs an
   explicit tick.
4. **Publish:** only what the demo reads (the clips and `event.json`, the
   CAN logs and sidecars, `map.json`, `vehicles.json`) is copied into
   `/demo-state/seed`, which the demo then uses instead of its built-in drives
   from the next reset (Reset now). Never the report with the real times,
   `README.txt`, the coordinates or `highway_stretches.csv`. "Use the
   built-in drives again" goes back.

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
npm test                                         # the demo layer (MANAGER_ROOT=<manager checkout> for the Sentry USB tests)
node tools/synthetic.js <manager checkout> seed/footage/demo-car 4   # test footage
docker build -t manager-demo:dev .
docker run --rm -p 9000:9000 --read-only --user 1000:1000 --cap-drop ALL \
  --tmpfs /data:uid=1000,gid=1000 --tmpfs /footage:uid=1000,gid=1000 -v demo-dev-state:/demo-state \
  -e DEMO_OWNER_PASSWORD=dev manager-demo:dev
python3 tools/screens.py https://localhost:9000 shots/   # every page, desktop and phone
```

| | |
| --- | --- |
| `demo/preload.js` | Loaded into the app (`NODE_OPTIONS`): signs everyone in as `demo`, puts the gate in front of the app, starts fresh, resets |
| `demo/policy.js` | What a visitor may do |
| `demo/sentryUsb/` | The stand-in Sentry USB: the Pi's rules and actions (`standIn.js`), the link (`link.js`), its process (`child.js`), pairing it (`launcher.js`) |
| `demo/owner.js`, `demo/owner/` | The owner page |
| `demo/attackLog.js`, `demo/rateLimit.js`, `demo/clientAddress.js` | The attack log, rate limits and bans, the real (Cloudflare-aware) client address |
| `demo/importer.js` | The owner's footage: upload, sanitize, publish |
| `demo/visitors.js`, `demo/track.js` | Visitor activity for the owner page, and its tracker in every page |
| `demo/feedback.js`, `demo/feedback/` | The feedback page and its Discord webhook |
| `demo/viewerLayout.js` | The Viewer's car-data layout every visitor starts with |
| `demo/uiSwap.js` | Swap to Horizon UI, per browser |
| `demo/store.js` | What is kept across resets (`/demo-state`) |
| `demo/seed.js`, `demo/seedCan.js` | Adds the vehicle, scans and uploads the CAN data, all through the app's own API |
| `demo/fakeEncoder.js` | The pretend conversion and nodes |
| `demo/banner.*` | The demo note on the pages |
| `tools/sanitize.js` | Real drives to highway-only demo drives |
| `tools/blur/` | Plate blurring (`blur.py`), telemetry and timing put back (`transplant.js`), the tools image (`Dockerfile`) |
| `tools/synthetic.js` | Synthetic test footage with telemetry |
| `tools/screens.py` | Screenshots of every page, desktop and phone |

## License

MIT, like Sentry Six Manager. The viewer and converter inside are
[Sentry Studio](https://github.com/ChadR23/Sentry-Six) by Chad and Scott
Vandereems.
