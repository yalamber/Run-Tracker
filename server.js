// OpenSplits Live server: static PWA + tiny JSON API + Server-Sent Events.
// No framework, no database: runs live in memory and are snapshotted to disk.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { newRun, applyOp, runMeta } from './public/js/core.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR = {
  '/vendor/leaflet/': path.join(ROOT, 'node_modules', 'leaflet', 'dist'),
};

const LIMITS = {
  bodyBytes: 512 * 1024,
  opsPerRequest: 2000,
  pointsPerRun: 100_000,
  runs: 10_000,
  viewersPerRun: 500,
  nameLength: 60,
  runTtlMs: 7 * 24 * 3600 * 1000,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data: https://*.tile.openstreetmap.org",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const randomId = (bytes) => crypto.randomBytes(bytes).toString('base64url');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function createApp({ dataFile = null, now = () => Date.now() } = {}) {
  /** @type {Map<string, {run: object, tokenHash: string}>} */
  const runs = new Map();
  /** @type {Map<string, Set<http.ServerResponse>>} */
  const viewers = new Map();

  // ---------------- persistence ----------------
  let saveTimer = null;
  function scheduleSave() {
    if (!dataFile || saveTimer) return;
    saveTimer = setTimeout(save, 2000);
    saveTimer.unref?.();
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!dataFile) return;
    const data = JSON.stringify([...runs.values()]);
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    const tmp = `${dataFile}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dataFile);
  }
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      for (const entry of JSON.parse(fs.readFileSync(dataFile, 'utf8'))) {
        runs.set(entry.run.id, entry);
      }
    } catch (err) {
      console.error(`Could not read ${dataFile}:`, err.message);
    }
  }

  function prune() {
    const cutoff = now() - LIMITS.runTtlMs;
    for (const [id, { run }] of runs) {
      if (run.updatedAt < cutoff && !viewers.get(id)?.size) runs.delete(id);
    }
  }
  const pruneTimer = setInterval(prune, 3600 * 1000);
  pruneTimer.unref?.();

  // ---------------- SSE ----------------
  function broadcast(id, event, payload) {
    const set = viewers.get(id);
    if (!set) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) res.write(msg);
  }
  const heartbeat = setInterval(() => {
    for (const set of viewers.values()) for (const res of set) res.write(`: ping ${now()}\n\n`);
  }, 25_000);
  heartbeat.unref?.();

  // ---------------- helpers ----------------
  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(data);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > LIMITS.bodyBytes) throw new HttpError(413, 'Request too large');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }

  function getEntry(id) {
    const entry = runs.get(id);
    if (!entry) throw new HttpError(404, 'Run not found');
    return entry;
  }

  function checkToken(req, entry) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const a = Buffer.from(hashToken(token));
    const b = Buffer.from(entry.tokenHash);
    if (!token || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      throw new HttpError(401, 'Invalid runner token');
    }
  }

  // ---------------- API ----------------
  async function createRun(req, res) {
    const body = await readJson(req);
    prune();
    if (runs.size >= LIMITS.runs) throw new HttpError(503, 'Server is full, try again later');
    const name = String(body.name ?? '').trim().slice(0, LIMITS.nameLength);
    const goal = Number(body.goal);
    let id;
    do id = randomId(6); while (runs.has(id));
    const token = randomId(24);
    const run = newRun({ id, name, unit: body.unit, goal: goal > 0 && goal <= 1e6 ? goal : null, createdAt: now() });
    runs.set(id, { run, tokenHash: hashToken(token) });
    scheduleSave();
    send(res, 201, { id, token, run: runMeta(run), serverTime: now() });
  }

  async function syncRun(req, res, id) {
    const entry = getEntry(id);
    checkToken(req, entry);
    const body = await readJson(req);
    const ops = Array.isArray(body.ops) ? body.ops.slice(0, LIMITS.opsPerRequest) : [];
    // Translate the phone's clock to server time so viewers see consistent times.
    const offset = Number.isFinite(body.sentAt) ? now() - body.sentAt : 0;
    const { run } = entry;
    const statusBefore = run.status;
    const newPoints = [];
    for (const raw of ops) {
      if (!raw || typeof raw !== 'object') continue;
      if (raw.type === 'pt' && run.points.length >= LIMITS.pointsPerRun) {
        // Still consume the seq so the phone stops retrying it.
        if (Number.isInteger(raw.seq) && raw.seq > run.lastSeq) run.lastSeq = raw.seq;
        continue;
      }
      const op = {
        seq: raw.seq,
        type: raw.type,
        status: raw.status,
        at: Math.min(Number(raw.at) + offset, now()),
        lat: Number(raw.lat),
        lon: Number(raw.lon),
        acc: raw.acc == null ? undefined : Number(raw.acc),
      };
      const result = applyOp(run, op);
      if (result && typeof result === 'object') newPoints.push(result);
    }
    if (ops.length) {
      scheduleSave();
      broadcast(id, 'update', { run: runMeta(run), points: newPoints, serverTime: now() });
      if (run.status === 'finished' && statusBefore !== 'finished') save();
    }
    send(res, 200, { lastSeq: run.lastSeq, run: runMeta(run), viewers: viewers.get(id)?.size || 0, serverTime: now() });
  }

  function getRun(res, id) {
    const { run } = getEntry(id);
    send(res, 200, { run, serverTime: now() });
  }

  function streamRun(req, res, id) {
    const { run } = getEntry(id);
    let set = viewers.get(id);
    if (!set) viewers.set(id, (set = new Set()));
    if (set.size >= LIMITS.viewersPerRun) throw new HttpError(503, 'Too many viewers');
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\nevent: snapshot\ndata: ${JSON.stringify({ run, serverTime: now() })}\n\n`);
    set.add(res);
    broadcast(id, 'viewers', { count: set.size });
    req.on('close', () => {
      set.delete(res);
      if (!set.size) viewers.delete(id);
      else broadcast(id, 'viewers', { count: set.size });
    });
  }

  // ---------------- static files ----------------
  async function serveFile(req, res, filePath) {
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const isVendor = filePath.includes(`${path.sep}node_modules${path.sep}`);
    const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': isVendor ? 'public, max-age=86400' : 'no-cache',
      ETag: etag,
    };
    if (path.basename(filePath) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }
    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(filePath).pipe(res);
    return true;
  }

  function safeJoin(base, rel) {
    const p = path.normalize(path.join(base, rel));
    return p === base || p.startsWith(base + path.sep) ? p : null;
  }

  async function serveStatic(req, res, pathname) {
    if (pathname === '/') pathname = '/index.html';
    else if (pathname === '/run' || pathname === '/run/') pathname = '/run.html';
    else if (/^\/t\/[A-Za-z0-9_-]+\/?$/.test(pathname)) pathname = '/track.html';

    for (const [prefix, dir] of Object.entries(VENDOR)) {
      if (pathname.startsWith(prefix)) {
        const file = safeJoin(dir, pathname.slice(prefix.length));
        if (file && (await serveFile(req, res, file))) return;
        return send(res, 404, { error: 'Not found' });
      }
    }
    const file = safeJoin(PUBLIC_DIR, pathname);
    if (file && (await serveFile(req, res, file))) return;
    send(res, 404, '<!doctype html><title>Not found</title><p>Not found. <a href="/">OpenSplits Live</a></p>', {
      'Content-Type': 'text/html; charset=utf-8',
    });
  }

  // ---------------- router ----------------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname === '/healthz') return send(res, 200, { ok: true, runs: runs.size });

      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/runs' && req.method === 'POST') return await createRun(req, res);
        const m = pathname.match(/^\/api\/runs\/([A-Za-z0-9_-]{1,32})(\/sync|\/stream)?$/);
        if (m) {
          const [, id, action] = m;
          if (!action && req.method === 'GET') return getRun(res, id);
          if (action === '/sync' && req.method === 'POST') return await syncRun(req, res, id);
          if (action === '/stream' && req.method === 'GET') return streamRun(req, res, id);
        }
        throw new HttpError(404, 'Not found');
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      let decoded;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        throw new HttpError(400, 'Bad request');
      }
      return await serveStatic(req, res, decoded);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal error' : err.message });
      else res.end();
    }
  }

  function close() {
    clearInterval(heartbeat);
    clearInterval(pruneTimer);
    for (const set of viewers.values()) for (const res of set) res.end();
    viewers.clear();
    save();
  }

  return { handle, close, runs };
}

// Start the server when run directly (not when imported by tests).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  const dataFile = process.env.DATA_FILE ?? path.join(ROOT, 'data', 'runs.json');
  const app = createApp({ dataFile: dataFile || null });
  const server = http.createServer(app.handle);
  server.listen(port, host, () => console.log(`OpenSplits Live on http://localhost:${port}`));
  const shutdown = () => {
    app.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
