import { $, registerServiceWorker, myRuns, storage } from './common.js';

registerServiceWorker();

if (storage('os.activeRun', null).get()) $('#resume').hidden = false;

$('#watch').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('#code').value.trim();
  const m = raw.match(/(?:\/t\/)?([A-Za-z0-9_-]{4,32})\/?$/);
  if (m) location.href = `/t/${m[1]}`;
  else $('#code').setCustomValidity('That does not look like a run link');
  $('#code').reportValidity();
});
$('#code').addEventListener('input', (e) => e.target.setCustomValidity(''));

const runs = myRuns.get();
if (runs.length) {
  $('#recent').hidden = false;
  const list = $('#recentList');
  for (const r of runs) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/t/${r.id}`;
    a.textContent = r.name || 'Run';
    const when = document.createElement('span');
    when.className = 'small muted';
    when.textContent = new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    li.append(a, when);
    list.appendChild(li);
  }
}

// Custom install prompt (Chrome/Android).
let deferred = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  $('#install').hidden = false;
});
$('#install').addEventListener('click', async () => {
  if (!deferred) return;
  deferred.prompt();
  await deferred.userChoice;
  deferred = null;
  $('#install').hidden = true;
});
