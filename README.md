# OpenSplits Live

Live run tracking for [OpenSplits.com](https://opensplits.com). A runner starts tracking on their phone, shares one link, and friends watch in real time: position on a map, elapsed time, distance, current pace, average pace, per-km/mi splits and a projected finish time for a goal distance.

It's an installable PWA served by a small Node.js server. The server has no framework and no database.

## Features

**Runner (`/run`)**
- Create a run (name, km/mi, optional goal: 5K, 10K, half, marathon or custom) and get a share link (native share sheet or copy)
- GPS tracking with live accuracy indicator; poor fixes (>50 m) and GPS jumps are filtered out
- Start / pause / resume / finish; paused time and distance aren't counted
- Works on flaky networks: every update is queued on the phone and synced in batches. Retries are safe, and the queue survives a page reload.
- Keeps the screen awake (Wake Lock API) so the phone keeps sending GPS
- Shows how many friends are watching

**Viewer (`/t/<code>`)**
- Live map with route, start marker, split markers and the runner's current position
- Time, distance, current pace (30 s window), average pace, splits table, projected finish
- Updates are pushed over Server-Sent Events, with automatic reconnect and a "signal lost" warning
- km/mi toggle, follow-runner / free-pan map

**PWA**
- Manifest, maskable icons, offline app shell through a service worker (live data is never cached)
- "Install app" button on Android/Chrome, Add to Home Screen on iOS

## Run it

```bash
npm install
npm start            # http://localhost:3000
npm test             # unit + API tests (node:test)
```

Geolocation only works in a secure context. `localhost` counts as one. On a phone you need HTTPS, so deploy it or use a tunnel such as `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`.

### Configuration

| Env var     | Default           | Notes                                                   |
|-------------|-------------------|---------------------------------------------------------|
| `PORT`      | `3000`            |                                                         |
| `HOST`      | `0.0.0.0`         |                                                         |
| `DATA_FILE` | `data/runs.json`  | Snapshot file for runs. Set to empty to keep runs in memory only. |

Runs are removed 7 days after their last update.

### Docker

```bash
docker build -t opensplits-live .
docker run -p 3000:3000 -v opensplits-data:/data opensplits-live
```

Put it behind a TLS-terminating proxy (Caddy, nginx, Fly.io, Render, etc.). For nginx, disable buffering on `/api/runs/*/stream`. The server already sends `X-Accel-Buffering: no`.

## How it works

```
Runner phone ──POST /api/runs/:id/sync (batched ops, bearer token)──▶ Node server ──SSE /api/runs/:id/stream──▶ Viewers
```

- The phone records an ordered log of **ops**: `status` changes (`running`, `paused`, `finished`) and GPS `pt` fixes. Each op has an increasing `seq`.
- `public/js/core.js` holds the reducer that applies ops to a run, plus all the distance, pace and split math. It's the same file on the phone, the server and the viewer, so all three always agree.
- The server ignores ops whose `seq` it has already seen, so the phone can retry a batch blindly after a timeout.
- Phone clocks drift. The server shifts op timestamps into server time using the `sentAt` sent with each batch, and viewers correct for their own clock offset with `serverTime`.
- Anyone with the link can watch. Only the creator's phone holds the secret runner token needed to post updates, and the server stores just a SHA-256 hash of it.

### API

| Method | Path                       | Description                                        |
|--------|----------------------------|----------------------------------------------------|
| POST   | `/api/runs`                | `{name?, unit?, goal?}` → `{id, token, run}`       |
| POST   | `/api/runs/:id/sync`       | `Authorization: Bearer <token>`, `{ops, sentAt}` → `{lastSeq, run, viewers}` |
| GET    | `/api/runs/:id`            | Full run including points                          |
| GET    | `/api/runs/:id/stream`     | SSE: `snapshot`, `update`, `viewers` events        |
| GET    | `/healthz`                 | Health check                                       |

## Known limitations

- **Background tracking:** browsers suspend GPS for web apps when the screen is off or another app is in front. The app keeps the screen awake and warns the runner, but truly backgrounded tracking needs a native wrapper (e.g. Capacitor) later on.
- Map tiles come from the public OpenStreetMap servers, which is fine for light use. For production traffic, point `TILE_URL` in `public/js/map.js` at a tile provider you have an account with, and update the `img-src` CSP in `server.js` to match.
- Runs are kept in memory and snapshotted to a JSON file. That suits a single instance. Running several instances needs shared storage plus pub/sub (e.g. Redis).

## Project layout

```
server.js              HTTP server: static files, API, SSE, persistence
public/js/core.js      shared run reducer + stats + formatting (browser & Node)
public/js/runner.js    runner screen (GPS, offline queue, sync, wake lock)
public/js/viewer.js    live viewer screen (SSE)
public/js/map.js       Leaflet map wrapper
public/sw.js           service worker
scripts/make-icons.js  regenerate PNG icons from icon.svg (needs Playwright)
test/                  node:test suites
```
