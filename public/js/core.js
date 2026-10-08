// Shared run logic used by the browser (runner + viewer) and the Node server.
// Keep this file dependency-free and environment-agnostic.

export const UNITS = {
  km: { meters: 1000, label: 'km', pace: '/km' },
  mi: { meters: 1609.344, label: 'mi', pace: '/mi' },
};

export const GOALS = {
  '5k': 5000,
  '10k': 10000,
  half: 21097.5,
  marathon: 42195,
};

// GPS quality filters.
export const MAX_ACCURACY_M = 50; // ignore fixes worse than this
export const MAX_SPEED_MPS = 12; // ~1:23/km; anything faster is a GPS jump
export const MIN_STEP_M = 2; // ignore jitter smaller than this
export const CURRENT_PACE_WINDOW_MS = 30_000;

const EARTH_RADIUS_M = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in meters between two {lat, lon} points. */
export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------
// Run state
//
// A run is driven by an ordered list of ops produced on the runner's phone:
//   { seq, type: 'status', status: 'running' | 'paused' | 'finished', at }
//   { seq, type: 'pt', at, lat, lon, acc }
// The same reducer runs on the phone (for its own display) and on the server
// (which then fans updates out to viewers). `seq` makes replays idempotent, so
// the phone can safely retry a batch after a flaky network request.
// ---------------------------------------------------------------------------

export function newRun({ id, name = '', unit = 'km', goal = null, createdAt = Date.now() } = {}) {
  return {
    id,
    name,
    unit: UNITS[unit] ? unit : 'km',
    goal: Number.isFinite(goal) && goal > 0 ? goal : null,
    status: 'ready',
    createdAt,
    startedAt: null,
    resumedAt: null,
    finishedAt: null,
    updatedAt: createdAt,
    activeMs: 0,
    seg: 0,
    lastSeq: 0,
    points: [],
  };
}

/** Run without the point list, for sending summaries around. */
export function runMeta(run) {
  const { points, ...meta } = run;
  return meta;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Apply one op to a run, mutating it. Returns the stored point for 'pt' ops,
 * true for an applied status change, or null when the op was ignored.
 */
export function applyOp(run, op) {
  if (!op || !Number.isInteger(op.seq) || op.seq <= run.lastSeq) return null;
  if (!Number.isFinite(op.at)) return null;
  run.lastSeq = op.seq;
  if (run.status === 'finished') return null;

  if (op.type === 'status') {
    const at = op.at;
    switch (op.status) {
      case 'running':
        if (run.status === 'running') return null;
        if (run.status === 'ready') run.startedAt = at;
        else run.seg += 1; // resuming from pause starts a new track segment
        run.status = 'running';
        run.resumedAt = at;
        break;
      case 'paused':
        if (run.status !== 'running') return null;
        run.activeMs += Math.max(0, at - run.resumedAt);
        run.resumedAt = null;
        run.status = 'paused';
        break;
      case 'finished':
        if (run.status === 'running') run.activeMs += Math.max(0, at - run.resumedAt);
        run.resumedAt = null;
        run.status = 'finished';
        run.finishedAt = at;
        break;
      default:
        return null;
    }
    run.updatedAt = at;
    return true;
  }

  if (op.type === 'pt') {
    if (run.status !== 'running') return null;
    const { lat, lon } = op;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    const pt = { t: op.at, lat: round6(lat), lon: round6(lon), seg: run.seg };
    if (Number.isFinite(op.acc)) pt.acc = Math.round(op.acc);
    run.points.push(pt);
    run.updatedAt = op.at;
    return pt;
  }

  return null;
}

/** Active (non-paused) time of the run at time `now`, in ms. */
export function elapsedMs(run, now = Date.now()) {
  const live = run.status === 'running' && run.resumedAt != null ? Math.max(0, now - run.resumedAt) : 0;
  return run.activeMs + live;
}

// ---------------------------------------------------------------------------
// Track statistics
// ---------------------------------------------------------------------------

/**
 * Filter raw points into a clean track annotated with cumulative distance `d`
 * (meters) and cumulative moving time `m` (ms). Time and distance across a
 * pause (segment change) are not counted.
 */
export function cleanTrack(points) {
  const out = [];
  let prev = null;
  for (const p of points) {
    if (Number.isFinite(p.acc) && p.acc > MAX_ACCURACY_M) continue;
    if (!prev) {
      prev = { ...p, d: 0, m: 0 };
      out.push(prev);
      continue;
    }
    if (p.seg !== prev.seg) {
      prev = { ...p, d: prev.d, m: prev.m };
      out.push(prev);
      continue;
    }
    const dt = p.t - prev.t;
    if (dt <= 0) continue;
    const dist = haversine(prev, p);
    if (dist < MIN_STEP_M) continue;
    if (dist / (dt / 1000) > MAX_SPEED_MPS) continue;
    prev = { ...p, d: prev.d + dist, m: prev.m + dt };
    out.push(prev);
  }
  return out;
}

/**
 * Compute display stats.
 * @param {object[]} track output of cleanTrack()
 * @param {object} opts { elapsedMs, unit, goal }
 */
export function computeStats(track, { elapsedMs: elapsed = 0, unit = 'km', goal = null } = {}) {
  const U = (UNITS[unit] || UNITS.km).meters;
  const last = track[track.length - 1];
  const distance = last ? last.d : 0;

  // Seconds per unit.
  const avgPace = distance >= 20 && elapsed > 0 ? elapsed / 1000 / (distance / U) : null;

  let currentPace = null;
  if (last) {
    let i = track.length - 1;
    while (i > 0 && last.m - track[i].m < CURRENT_PACE_WINDOW_MS) i--;
    const first = track[i];
    const dd = last.d - first.d;
    const dm = last.m - first.m;
    if (dd >= 10 && dm > 0) currentPace = dm / 1000 / (dd / U);
  }

  // Splits per full unit, using interpolated moving time at each boundary.
  const splits = [];
  let nextMark = U;
  let prevCross = 0;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    while (b.d >= nextMark && b.d > a.d) {
      const f = (nextMark - a.d) / (b.d - a.d);
      const cross = a.m + (b.m - a.m) * f;
      splits.push({ n: splits.length + 1, ms: cross - prevCross, totalMs: cross });
      prevCross = cross;
      nextMark += U;
    }
  }

  let projectedMs = null;
  if (goal && avgPace && distance < goal) {
    projectedMs = elapsed + (goal - distance) / U * avgPace * 1000;
  }

  return { distance, avgPace, currentPace, splits, projectedMs };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Pace in seconds per unit -> "m:ss". */
export function formatPace(secPerUnit) {
  if (!Number.isFinite(secPerUnit) || secPerUnit <= 0 || secPerUnit >= 60 * 60) return '--:--';
  const total = Math.round(secPerUnit);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function formatDistance(meters, unit = 'km') {
  const U = (UNITS[unit] || UNITS.km).meters;
  return (meters / U).toFixed(2);
}

export function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}
