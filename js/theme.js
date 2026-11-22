// Thema: 'system' (volgt het apparaat), 'light' of 'dark'. Keuze wordt onthouden.
const KEY = 'bs.theme';
const VALID = ['system', 'light', 'dark'];

export function getThemePref() {
  try {
    const v = localStorage.getItem(KEY);
    return VALID.includes(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setThemePref(pref) {
  if (!VALID.includes(pref)) return;
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* opslag niet beschikbaar: werkt alleen voor deze sessie */
  }
  applyTheme(pref);
}

export function applyTheme(pref = getThemePref()) {
  document.documentElement.dataset.theme = pref;
  const dark =
    pref === 'dark' ||
    (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (meta) meta.content = dark ? '#0e1013' : '#f3f4f6';
}

export function initTheme() {
  applyTheme();
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => applyTheme());
}
