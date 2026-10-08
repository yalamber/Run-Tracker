import {
  GOALS, UNITS, MAX_ACCURACY_M, newRun, applyOp, elapsedMs, cleanTrack, computeStats,
} from './core.js';
import {
  $, registerServiceWorker, storage, rememberRun, trackUrl, shareLink, copyText, flash, createWakeLock,
} from './common.js';
import { renderStats, renderSplits, renderBadge } from './ui.js';
import { createRunMap } from './map.js';

registerServiceWorker();

const SYNC_INTERVAL_MS = 3000;
const SYNC_BATCH = 500;
const MIN_POINT_INTERVAL_MS = 2000;
const STALE_MS = 20_000;

const activeStore = storage('os.activeRun', null);
const wakeLock = createWakeLock();

/** @type {{id:string, token:string, run:object, queue:object[], nextSeq:number} | null} */
let active = activeStore.get();
let lastPos = null;
let lastPointAt = 0;
let watchId = null;
let syncing = false;
let syncFatal = null;
let map = null;
let trackCache = { len: -1, track: [] };
let wasHidden = false;

// ---------------------------------------------------------------- persistence
let saveTimer = null;
function persist() {
  // A finished run whose data is all on the server no longer needs a local copy.
  const done = active?.run.status === 'finished' && !active.queue.length;
  activeStore.set(done ? null : active);
}
function save(now = false) {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (now) persist();
  else saveTimer = setTimeout(persist, 4000);
}
addEventListener('pagehide', () => active && save(true));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    wasHidden = true;
    if (active) save(true);
  } else {
    if (wasHidden && active?.run.status === 'running') $('#bgWarning').hidden = false;
    sync();
  }
});

// ---------------------------------------------------------------- screens
function show(id) {
  for (const s of ['setup', 'live', 'done']) $(`#${s}`).hidden = s !== id;
  $('#badge').hidden = id === 'setup';
}

function init() {
  if (!active) return showSetup();
  if (active.run.status === 'finished') return showDone();
  showLive();
}

// ---------------------------------------------------------------- setup
function showSetup() {
  show('setup');
  const unitSel = $('#unit');
  const guess = navigator.language === 'en-US' || navigator.language === 'en-GB' ? 'mi' : 'km';
  unitSel.value = storage('os.unit', guess).get() || guess;
  const syncCustom = () => {
    $('#customGoalRow').hidden = $('#goal').value !== 'custom';
    $('#customUnit').textContent = UNITS[unitSel.value].label;
  };
  $('#goal').addEventListener('change', syncCustom);
  unitSel.addEventListener('change', syncCustom);
  syncCustom();
}

$('#setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter || $('#setupForm button[type=submit]');
  const err = $('#setupError');
  err.hidden = true;
  const unit = $('#unit').value;
  const goalKey = $('#goal').value;
  let goal = null;
  if (goalKey === 'custom') goal = Number($('#customGoal').value) * UNITS[unit].meters || null;
  else if (goalKey) goal = GOALS[goalKey];
  const name = $('#name').value.trim();

  btn.disabled = true;
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, unit, goal }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const data = await res.json();
    storage('os.unit').set(unit);
    active = {
      id: data.id,
      token: data.token,
      run: newRun({ id: data.id, name: data.run.name, unit: data.run.unit, goal: data.run.goal, createdAt: Date.now() }),
      queue: [],
      nextSeq: 1,
    };
    save(true);
    rememberRun({ id: data.id, name: data.run.name, createdAt: Date.now() });
    showLive();
  } catch (error) {
    err.textContent = navigator.onLine
      ? `Could not create the run: ${error.message}`
      : 'You are offline. Connect to the internet to create a share link.';
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- live
function showLive() {
  show('live');
  const { run } = active;
  const url = trackUrl(active.id);
  $('#runName').textContent = run.name || 'Your run';
  $('#link').value = url;
  $('#projectedStat').hidden = !run.goal;
  if (!wakeLock.supported) $('#bgWarning').hidden = false;
  if (!map) map = createRunMap($('#map'), { followButton: $('#followBtn') });
  startGps();
  updateControls();
  render(true);
  if (run.status === 'running') wakeLock.on();
}

$('#shareBtn').addEventListener('click', async () => {
  const result = await shareLink(trackUrl(active.id), active.run.name || 'My run');
  if (result === 'copied') flash($('#shareBtn'), 'Copied!');
});
$('#link').addEventListener('focus', (e) => e.target.select());

function startGps() {
  if (watchId != null) return;
  const errBox = $('#gpsError');
  if (!window.isSecureContext) {
    errBox.textContent = 'Location needs a secure (https://) connection. Open this site over HTTPS.';
    errBox.hidden = false;
    return;
  }
  if (!('geolocation' in navigator)) {
    errBox.textContent = 'This browser does not support location tracking.';
    errBox.hidden = false;
    return;
  }
  watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 30_000,
  });
}

function stopGps() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function onGpsError(err) {
  const errBox = $('#gpsError');
  if (err.code === err.PERMISSION_DENIED) {
    errBox.textContent = 'Location permission was denied. Allow location access for this site in your browser settings, then reload.';
    errBox.hidden = false;
    setGps('bad', 'blocked');
  } else if (err.code === err.TIMEOUT) {
    setGps('ok', 'searching…');
  } else {
    setGps('bad', 'unavailable');
  }
}

function setGps(level, text) {
  $('#gpsDot').className = `dot ${level}`;
  $('#gpsText').textContent = text;
}

function onPosition(pos) {
  const { latitude: lat, longitude: lon, accuracy: acc } = pos.coords;
  lastPos = { lat, lon, acc, t: Date.now() };
  $('#gpsError').hidden = true;
  const level = acc <= 15 ? 'good' : acc <= MAX_ACCURACY_M ? 'ok' : 'bad';
  setGps(level, `±${Math.round(acc)} m`);

  if (active?.run.status === 'running') recordPoint();
  render(true);
}

function recordPoint(force = false) {
  if (!lastPos || lastPos.acc > MAX_ACCURACY_M) return;
  const now = Date.now();
  if (!force && now - lastPointAt < MIN_POINT_INTERVAL_MS) return;
  if (now - lastPos.t > 10_000) return; // stale fix
  lastPointAt = now;
  pushOp({ type: 'pt', at: now, lat: lastPos.lat, lon: lastPos.lon, acc: Math.round(lastPos.acc) });
}

function pushOp(op) {
  op.seq = active.nextSeq++;
  applyOp(active.run, op);
  active.queue.push(op);
  save(op.type === 'status');
}

function setStatus(status) {
  pushOp({ type: 'status', status, at: Date.now() });
  if (status === 'running') {
    recordPoint(true);
    wakeLock.on();
  } else {
    wakeLock.off();
  }
  updateControls();
  render(true);
  sync();
}

$('#startBtn').addEventListener('click', () => setStatus('running'));
$('#pauseBtn').addEventListener('click', () => setStatus('paused'));
$('#resumeBtn').addEventListener('click', () => setStatus('running'));
$('#finishBtn').addEventListener('click', () => {
  if (!confirm('Finish this run? Friends will see it as finished.')) return;
  setStatus('finished');
  stopGps();
  showDone();
});

function updateControls() {
  const s = active.run.status;
  $('#startBtn').hidden = s !== 'ready';
  $('#pauseBtn').hidden = s !== 'running';
  $('#resumeBtn').hidden = s !== 'paused';
  $('#finishBtn').hidden = s === 'ready' || s === 'finished';
  renderBadge($('#badge'), s);
}

function currentTrack() {
  const pts = active.run.points;
  if (trackCache.len !== pts.length) trackCache = { len: pts.length, track: cleanTrack(pts) };
  return trackCache.track;
}

function render(withMap = false) {
  if (!active) return;
  const { run } = active;
  const track = currentTrack();
  const elapsed = elapsedMs(run);
  const stats = computeStats(track, { elapsedMs: elapsed, unit: run.unit, goal: run.goal });
  const last = run.points[run.points.length - 1];
  const stale = run.status !== 'running' || !last || Date.now() - last.t > STALE_MS;
  const screen = run.status === 'finished' ? $('#summary') : $('#stats');
  renderStats(screen, stats, { elapsedMs: elapsed, unit: run.unit, stale });
  if (run.status !== 'finished') {
    renderSplits($('#splits'), stats.splits, run.unit);
    if (withMap && map) {
      map.update(track, lastPos, { live: run.status === 'running', unitMeters: UNITS[run.unit].meters });
    }
  }
  renderSync();
}

setInterval(() => render(false), 1000);

// ---------------------------------------------------------------- sync
function renderSync() {
  if (!active) return;
  const pending = active.queue.length;
  let level = 'good';
  let text = pending ? `${pending} pending` : 'up to date';
  if (syncFatal) {
    level = 'bad';
    text = syncFatal;
  } else if (!navigator.onLine) {
    level = 'bad';
    text = `offline · ${pending} queued`;
  } else if (pending > 20) {
    level = 'ok';
  }
  $('#syncDot').className = `dot ${level}`;
  $('#syncText').textContent = text;
  $('#doneSync').hidden = !pending || !!syncFatal;
}

async function sync() {
  if (!active || syncing || syncFatal || !active.queue.length) return;
  syncing = true;
  const batch = active.queue.slice(0, SYNC_BATCH);
  try {
    const res = await fetch(`/api/runs/${active.id}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${active.token}` },
      body: JSON.stringify({ ops: batch, sentAt: Date.now() }),
      keepalive: batch.length < 50, // lets the last batch finish if the page closes
    });
    if (res.status === 401 || res.status === 404) {
      syncFatal = res.status === 404 ? 'run expired on server' : 'not authorized';
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    active.queue = active.queue.filter((op) => op.seq > data.lastSeq);
    $('#viewersWrap').hidden = !data.viewers;
    $('#viewers').textContent = data.viewers;
    save(active.run.status === 'finished');
    if (active.run.status === 'finished' && !active.queue.length) finishCleanup();
  } catch {
    // Offline or flaky network; ops stay queued and we retry on the next tick.
  } finally {
    syncing = false;
    renderSync();
  }
  if (active?.queue.length >= SYNC_BATCH) setTimeout(sync, 200);
}

setInterval(sync, SYNC_INTERVAL_MS);
addEventListener('online', sync);

// ---------------------------------------------------------------- done
function showDone() {
  show('done');
  renderBadge($('#badge'), 'finished');
  $('#doneLink').href = `/t/${active.id}`;
  wakeLock.off();
  render();
  if (!active.queue.length) finishCleanup();
  else sync();
}

function finishCleanup() {
  // Everything is on the server; forget the local copy but keep the summary on screen.
  save(true);
}

$('#newRunBtn').addEventListener('click', () => {
  if (active?.queue.length && !syncFatal && !confirm('Some points have not uploaded yet. Discard them and start a new run?')) return;
  activeStore.set(null);
  location.reload();
});

init();
