import test from 'node:test';
import assert from 'node:assert/strict';
import {
  haversine, newRun, applyOp, elapsedMs, cleanTrack, computeStats, formatDuration, formatPace,
} from '../public/js/core.js';

// ~1 m of latitude in degrees.
const M = 1 / 111_195;

/** Build a run going north at `speed` m/s with a fix every `step` ms. */
function simulate({ seconds, speed = 3, step = 2000, start = 1_000_000 }) {
  const run = newRun({ id: 'x', createdAt: start });
  let seq = 0;
  applyOp(run, { seq: ++seq, type: 'status', status: 'running', at: start });
  for (let t = 0; t <= seconds * 1000; t += step) {
    applyOp(run, { seq: ++seq, type: 'pt', at: start + t, lat: 51.5 + (speed * t / 1000) * M, lon: -0.1, acc: 5 });
  }
  return { run, seq, end: start + seconds * 1000 };
}

test('haversine matches a known distance', () => {
  const d = haversine({ lat: 51.5007, lon: -0.1246 }, { lat: 40.6892, lon: -74.0445 });
  assert.ok(Math.abs(d - 5_574_800) < 10_000, `got ${d}`);
});

test('status ops drive elapsed time and ignore pauses', () => {
  const run = newRun({ id: 'x', createdAt: 0 });
  applyOp(run, { seq: 1, type: 'status', status: 'running', at: 0 });
  assert.equal(elapsedMs(run, 10_000), 10_000);
  applyOp(run, { seq: 2, type: 'status', status: 'paused', at: 60_000 });
  assert.equal(elapsedMs(run, 999_999), 60_000);
  applyOp(run, { seq: 3, type: 'status', status: 'running', at: 120_000 });
  assert.equal(run.seg, 1);
  assert.equal(elapsedMs(run, 130_000), 70_000);
  applyOp(run, { seq: 4, type: 'status', status: 'finished', at: 150_000 });
  assert.equal(run.status, 'finished');
  assert.equal(elapsedMs(run, 999_999), 90_000);
});

test('ops are idempotent by seq and points need a running run', () => {
  const run = newRun({ id: 'x' });
  assert.equal(applyOp(run, { seq: 1, type: 'pt', at: 1, lat: 1, lon: 1 }), null);
  applyOp(run, { seq: 2, type: 'status', status: 'running', at: 2 });
  assert.ok(applyOp(run, { seq: 3, type: 'pt', at: 3, lat: 1, lon: 1 }));
  assert.equal(applyOp(run, { seq: 3, type: 'pt', at: 3, lat: 1, lon: 1 }), null);
  assert.equal(applyOp(run, { seq: 4, type: 'pt', at: 4, lat: 100, lon: 1 }), null);
  assert.equal(run.points.length, 1);
});

test('steady 3 m/s run gives 5:33/km pace and correct splits', () => {
  const { run, end } = simulate({ seconds: 1000, speed: 3 });
  const stats = computeStats(cleanTrack(run.points), { elapsedMs: elapsedMs(run, end), unit: 'km' });
  assert.ok(Math.abs(stats.distance - 3000) < 5, `distance ${stats.distance}`);
  assert.equal(formatPace(stats.avgPace), '5:33');
  assert.equal(formatPace(stats.currentPace), '5:33');
  assert.equal(stats.splits.length, 3);
  for (const s of stats.splits) assert.ok(Math.abs(s.ms - 333_333) < 1000, `split ${s.ms}`);
});

test('GPS jumps and inaccurate fixes are filtered out', () => {
  const { run, seq, end } = simulate({ seconds: 100, speed: 3 });
  // A 1 km teleport two seconds later is not a runner.
  applyOp(run, { seq: seq + 1, type: 'pt', at: end + 2000, lat: 51.5 + 1000 * M * 3, lon: -0.1, acc: 5 });
  // A fix with terrible accuracy is ignored.
  applyOp(run, { seq: seq + 2, type: 'pt', at: end + 4000, lat: 51.6, lon: -0.1, acc: 400 });
  const track = cleanTrack(run.points);
  assert.ok(Math.abs(track.at(-1).d - 300) < 5, `distance ${track.at(-1).d}`);
});

test('distance is not counted across a pause', () => {
  const run = newRun({ id: 'x' });
  applyOp(run, { seq: 1, type: 'status', status: 'running', at: 0 });
  applyOp(run, { seq: 2, type: 'pt', at: 0, lat: 0, lon: 0 });
  applyOp(run, { seq: 3, type: 'pt', at: 10_000, lat: 30 * M, lon: 0 });
  applyOp(run, { seq: 4, type: 'status', status: 'paused', at: 10_000 });
  applyOp(run, { seq: 5, type: 'status', status: 'running', at: 600_000 });
  applyOp(run, { seq: 6, type: 'pt', at: 600_000, lat: 5000 * M, lon: 0 }); // drove somewhere while paused
  applyOp(run, { seq: 7, type: 'pt', at: 610_000, lat: 5030 * M, lon: 0 });
  const track = cleanTrack(run.points);
  assert.ok(Math.abs(track.at(-1).d - 60) < 1, `distance ${track.at(-1).d}`);
  assert.equal(track.at(-1).m, 20_000);
});

test('projected finish uses average pace', () => {
  const { run, end } = simulate({ seconds: 1000, speed: 5 });
  const stats = computeStats(cleanTrack(run.points), { elapsedMs: elapsedMs(run, end), unit: 'km', goal: 10_000 });
  assert.ok(Math.abs(stats.projectedMs - 2_000_000) < 5000, `projected ${stats.projectedMs}`);
});

test('formatting', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65_000), '1:05');
  assert.equal(formatDuration(3_725_000), '1:02:05');
  assert.equal(formatPace(299.6), '5:00');
  assert.equal(formatPace(null), '--:--');
});
