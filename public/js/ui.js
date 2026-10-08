// Rendering helpers shared by the runner and viewer screens.
import { UNITS, formatDistance, formatDuration, formatPace } from './core.js';

/** Write a stats object into elements marked with data-stat="...". */
export function renderStats(root, stats, { elapsedMs, unit, stale = false }) {
  const u = UNITS[unit] || UNITS.km;
  const set = (key, value) => root.querySelectorAll(`[data-stat="${key}"]`).forEach((el) => (el.textContent = value));
  set('time', formatDuration(elapsedMs));
  set('distance', formatDistance(stats.distance, unit));
  set('pace', stale ? '--:--' : formatPace(stats.currentPace));
  set('avg', formatPace(stats.avgPace));
  set('projected', stats.projectedMs ? formatDuration(stats.projectedMs) : '--');
  root.querySelectorAll('[data-unit]').forEach((el) => (el.textContent = el.dataset.unit === 'pace' ? u.pace : u.label));
}

export function renderSplits(table, splits, unit) {
  const tbody = table.tBodies[0];
  const label = (UNITS[unit] || UNITS.km).label;
  table.closest('[data-splits]')?.toggleAttribute('hidden', splits.length === 0);
  if (!splits.length) {
    tbody.innerHTML = '';
    return;
  }
  const max = Math.max(...splits.map((s) => s.ms));
  const best = Math.min(...splits.map((s) => s.ms));
  tbody.innerHTML = '';
  for (const s of splits) {
    const tr = document.createElement('tr');
    if (s.ms === best && splits.length > 1) tr.className = 'best';
    const cells = [`${s.n} ${label}`, formatPace(s.ms / 1000), formatDuration(s.totalMs)];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }
    const bar = document.createElement('td');
    bar.className = 'bar';
    const span = document.createElement('span');
    // Faster splits get longer bars.
    span.style.width = `${Math.max(8, Math.round((best / s.ms) * 100))}%`;
    span.style.opacity = max === best ? 0.85 : String(0.45 + 0.5 * ((max - s.ms) / (max - best)));
    bar.appendChild(span);
    tr.appendChild(bar);
    tbody.appendChild(tr);
  }
}

export function renderBadge(el, status) {
  const text = { ready: 'Not started', running: 'Live', paused: 'Paused', finished: 'Finished' }[status] || status;
  el.className = `badge ${status}`;
  el.textContent = text;
}
