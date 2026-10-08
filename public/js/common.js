// Browser helpers shared by every page.

export const $ = (sel, root = document) => root.querySelector(sel);

export function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW registration failed', err));
    });
  }
}

export function storage(key, fallback) {
  return {
    get() {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(value) {
      try {
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
      } catch (err) {
        console.warn('Could not save', key, err);
      }
    },
  };
}

export const unitPref = storage('os.unit', null);
export const myRuns = storage('os.myRuns', []);

export function rememberRun(entry) {
  const list = myRuns.get().filter((r) => r.id !== entry.id);
  list.unshift(entry);
  myRuns.set(list.slice(0, 20));
}

export function trackUrl(id) {
  return `${location.origin}/t/${id}`;
}

export async function shareLink(url, title) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text: `${title} — follow along live`, url });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  await copyText(url);
  return 'copied';
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

export function flash(button, text, ms = 1500) {
  const old = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = old), ms);
}

/** Keep the screen awake while the run is active (GPS stops when the screen locks on most phones). */
export function createWakeLock() {
  let lock = null;
  let wanted = false;
  async function acquire() {
    if (!wanted || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    } catch {
      lock = null;
    }
  }
  document.addEventListener('visibilitychange', acquire);
  return {
    get supported() {
      return 'wakeLock' in navigator;
    },
    async on() {
      wanted = true;
      if (!lock) await acquire();
    },
    async off() {
      wanted = false;
      await lock?.release().catch(() => {});
      lock = null;
    },
  };
}
