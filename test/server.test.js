import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.js';

async function start() {
  const app = createApp();
  const server = http.createServer(app.handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async stop() {
      app.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

const json = (body, headers = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/** Read SSE events from a stream until `count` named events have arrived. */
async function readEvents(url, count, onReady) {
  const res = await fetch(url);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  let ready = false;
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev) events.push({ ev, data: JSON.parse(data) });
    }
    if (!ready && events.length) {
      ready = true;
      onReady?.();
    }
  }
  await reader.cancel();
  return events;
}

test('create, sync and stream a run', async () => {
  const s = await start();
  try {
    const created = await (await fetch(`${s.base}/api/runs`, json({ name: 'Test run', unit: 'mi', goal: 5000 }))).json();
    assert.ok(created.id && created.token);
    assert.equal(created.run.unit, 'mi');

    const auth = { Authorization: `Bearer ${created.token}` };
    const t0 = Date.now();
    const ops = [
      { seq: 1, type: 'status', status: 'running', at: t0 },
      { seq: 2, type: 'pt', at: t0 + 1000, lat: 51.5, lon: -0.1, acc: 5 },
      { seq: 3, type: 'pt', at: t0 + 3000, lat: 51.5001, lon: -0.1, acc: 5 },
    ];

    const eventsP = readEvents(`${s.base}/api/runs/${created.id}/stream`, 3, async () => {
      const res = await fetch(`${s.base}/api/runs/${created.id}/sync`, json({ ops, sentAt: t0 + 3000 }, auth));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.lastSeq, 3);
      assert.equal(body.viewers, 1);
    });
    const events = await eventsP;
    assert.deepEqual(events.map((e) => e.ev), ['snapshot', 'viewers', 'update']);
    const update = events[2].data;
    assert.equal(update.run.status, 'running');
    assert.equal(update.points.length, 2);

    // Retrying the same batch is a no-op.
    const again = await (await fetch(`${s.base}/api/runs/${created.id}/sync`, json({ ops, sentAt: Date.now() }, auth))).json();
    assert.equal(again.lastSeq, 3);
    const snap = await (await fetch(`${s.base}/api/runs/${created.id}`)).json();
    assert.equal(snap.run.points.length, 2);
    assert.equal(snap.run.name, 'Test run');
  } finally {
    await s.stop();
  }
});

test('sync requires the runner token', async () => {
  const s = await start();
  try {
    const created = await (await fetch(`${s.base}/api/runs`, json({}))).json();
    const op = { seq: 1, type: 'status', status: 'running', at: Date.now() };
    const noAuth = await fetch(`${s.base}/api/runs/${created.id}/sync`, json({ ops: [op] }));
    assert.equal(noAuth.status, 401);
    const bad = await fetch(`${s.base}/api/runs/${created.id}/sync`, json({ ops: [op] }, { Authorization: 'Bearer nope' }));
    assert.equal(bad.status, 401);
    const missing = await fetch(`${s.base}/api/runs/doesnotexist`);
    assert.equal(missing.status, 404);
  } finally {
    await s.stop();
  }
});

test('serves the PWA shell and blocks path traversal', async () => {
  const s = await start();
  try {
    for (const p of ['/', '/run', '/t/abc123', '/manifest.webmanifest', '/sw.js', '/js/core.js', '/vendor/leaflet/leaflet.js']) {
      const res = await fetch(`${s.base}${p}`);
      assert.equal(res.status, 200, p);
      await res.arrayBuffer();
    }
    const res = await fetch(`${s.base}/..%2fserver.js`);
    assert.equal(res.status, 404);
    await res.arrayBuffer();
  } finally {
    await s.stop();
  }
});
