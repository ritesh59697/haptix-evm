// Appearance: follow the system, or force light/dark. Stored per browser profile;
// it's a display preference, so losing it only means falling back to "system".
export type Appearance = 'system' | 'light' | 'dark';
const KEY = 'haptix.appearance';

export function getAppearance(): Appearance {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyAppearance(a: Appearance = getAppearance()) {
  const root = document.documentElement;
  if (a === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', a);
}

export function setAppearance(a: Appearance) {
  try {
    if (a === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, a);
  } catch {
    /* storage blocked: the choice still applies to this page */
  }
  applyAppearance(a);
}
