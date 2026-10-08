import { UNITS, elapsedMs, cleanTrack, computeStats, formatAgo, formatDistance } from './core.js';
import { $, registerServiceWorker, unitPref, shareLink, flash } from './common.js';
import { renderStats, renderSplits, renderBadge } from './ui.js';
import { createRunMap } from './map.js';

registerServiceWorker();

const STALE_MS = 20_000;
const id = location.pathname.split('/').filter(Boolean)[1];

let run = null;
let clockOffset = 0; // server time - local time
let unit = unitPref.get();
let track = [];
let connected = false;
let es = null;
const map = createRunMap($('#map'), { followButton: $('#followBtn') });

const serverNow = () => Date.now() + clockOffset;

function setClock(serverTime) {
  if (Number.isFinite(serverTime)) clockOffset = serverTime - Date.now();
}

function displayUnit() {
  return unit || run?.unit || 'km';
}

function showError(text) {
  const box = $('#error');
  box.textContent = text;
  box.hidden = !text;
}

function onData() {
  track = cleanTrack(run.points);
  const last = run.points[run.points.length - 1] || null;
  map.update(track, last, { live: run.status === 'running', unitMeters: UNITS[displayUnit()].meters });
  render();
}

function render() {
  if (!run) return;
  const u = displayUnit();
  $('#unitBtn').textContent = UNITS[u].label;
  const name = run.name || 'Live run';
  $('#name').textContent = name;
  document.title = `${name} · OpenSplits Live`;
  renderBadge($('#badge'), run.status);
  $('#waiting').hidden = run.status !== 'ready';
  $('#projectedStat').hidden = !run.goal || run.status === 'finished';
  $('#goalWrap').hidden = !run.goal;
  if (run.goal) $('#goal').textContent = `${formatDistance(run.goal, u)} ${UNITS[u].label}`;

  const now = serverNow();
  const elapsed = elapsedMs(run, now);
  const stats = computeStats(track, { elapsedMs: elapsed, unit: u, goal: run.goal });
  const last = run.points[run.points.length - 1];
  const stale = run.status !== 'running' || !last || now - last.t > STALE_MS;
  renderStats($('#stats'), stats, { elapsedMs: elapsed, unit: u, stale });
  renderSplits($('#splits'), stats.splits, u);

  const lastUpdate = last ? last.t : run.updatedAt;
  $('#updated').textContent = run.status === 'ready' ? '--' : formatAgo(now - lastUpdate);

  let level = connected ? 'good' : 'bad';
  let text = connected ? 'live connection' : 'reconnecting…';
  if (connected && run.status === 'running' && last && now - last.t > 60_000) {
    level = 'ok';
    text = 'runner signal lost';
  }
  $('#connDot').className = `dot ${level}`;
  $('#connText').textContent = run.status === 'finished' ? 'run finished' : text;
  if (run.status === 'finished') $('#connDot').className = 'dot';
}

function connect() {
  es = new EventSource(`/api/runs/${encodeURIComponent(id)}/stream`);
  es.addEventListener('open', () => {
    connected = true;
    showError('');
    render();
  });
  es.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data);
    setClock(data.serverTime);
    run = data.run;
    onData();
    if (run.status === 'finished') es.close(); // nothing more will happen
  });
  es.addEventListener('update', (e) => {
    if (!run) return;
    const data = JSON.parse(e.data);
    setClock(data.serverTime);
    run = { ...run, ...data.run, points: run.points.concat(data.points) };
    onData();
    if (run.status === 'finished') {
      es.close();
      connected = false;
      render();
    }
  });
  es.addEventListener('viewers', (e) => {
    const { count } = JSON.parse(e.data);
    $('#viewersWrap').hidden = count < 2;
    $('#viewers').textContent = count;
  });
  es.addEventListener('error', async () => {
    connected = false;
    render();
    if (es.readyState === EventSource.CLOSED) {
      // The server refused the stream (e.g. unknown run). Find out why.
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(id)}`);
        if (res.status === 404) {
          showError('This run does not exist or has expired.');
          $('#name').textContent = 'Run not found';
          return;
        }
      } catch {
        /* offline */
      }
      showError('Connection lost. Retrying…');
      setTimeout(connect, 5000);
    }
  });
}

$('#unitBtn').addEventListener('click', () => {
  unit = displayUnit() === 'km' ? 'mi' : 'km';
  unitPref.set(unit);
  if (run) onData();
});

$('#shareBtn').addEventListener('click', async () => {
  const result = await shareLink(location.href, run?.name || 'Live run');
  if (result === 'copied') flash($('#shareBtn'), 'Copied!');
});

// Re-sync immediately when the tab comes back (mobile browsers suspend background tabs).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && run?.status !== 'finished') {
    es?.close();
    connect();
  }
});

setInterval(render, 1000);
if (id) connect();
else showError('Missing run code in the link.');
