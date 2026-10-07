// Settings and progress, kept in this browser.
const KEY = 'lego.settings.v1';

export const DEFAULTS = {
  set: '75192',
  mode: 'advance', // advance | pick | free
  booklet: 'right', // right | left | hidden
  hints: 'holding', // always | holding | off
  snap: 'normal', // easy | normal | hard
  animation: 'normal', // normal | slow | off
  autoCamera: true,
  autoAdvance: true,
  background: 'light', // light | dark
  quality: 'high', // high | fast
};

export const SNAP_PX = { easy: 90, normal: 55, hard: 28 };

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window: nothing is kept, everything still works */
  }
}

export function loadSettings() {
  return { ...DEFAULTS, ...read(KEY, {}) };
}

export function saveSettings(s) {
  write(KEY, s);
}

export function loadProgress(set) {
  return { step: 0, placed: [], free: [], ...read(`lego.progress.${set}`, {}) };
}

export function saveProgress(set, p) {
  write(`lego.progress.${set}`, p);
}
