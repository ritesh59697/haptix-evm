// Persistent wallet storage. chrome.storage.local inside the extension; localStorage
// on the dev server, where chrome.storage doesn't exist.
const hasChromeStorage = typeof chrome !== 'undefined' && !!chrome.storage?.local;

export async function getItem<T>(key: string): Promise<T | undefined> {
  if (hasChromeStorage) return (await chrome.storage.local.get(key))[key] as T | undefined;
  const raw = localStorage.getItem(key);
  return raw === null ? undefined : (JSON.parse(raw) as T);
}

export async function setItem<T>(key: string, value: T): Promise<void> {
  if (hasChromeStorage) return chrome.storage.local.set({ [key]: value });
  localStorage.setItem(key, JSON.stringify(value));
}

export async function removeItem(key: string): Promise<void> {
  if (hasChromeStorage) return chrome.storage.local.remove(key);
  localStorage.removeItem(key);
}

/**
 * Session storage: cleared when the browser closes, readable only by extension pages
 * and the background worker. Holds site requests waiting for a decision.
 */
const hasSession = typeof chrome !== 'undefined' && !!chrome.storage?.session;

export async function getSession<T>(key: string): Promise<T | undefined> {
  if (hasSession) return (await chrome.storage.session.get(key))[key] as T | undefined;
  const raw = sessionStorage.getItem(key);
  return raw === null ? undefined : (JSON.parse(raw) as T);
}

export async function setSession<T>(key: string, value: T): Promise<void> {
  if (hasSession) return chrome.storage.session.set({ [key]: value });
  sessionStorage.setItem(key, JSON.stringify(value));
}

/** Storage keys are scoped by chain so testnet and mainnet accounts never mix. */
export const keys = {
  /** A restore in progress on this device: the account and its new keys. */
  restore: (chainId: number) => `haptix.restore.${chainId}`,
  /** Agents granted from this wallet (names and limits; never their keys). */
  agents: (chainId: number) => `haptix.agents.${chainId}`,
  /** A route the popup hands to the side panel for a both-key action (session storage). */
  panelRoute: (chainId: number) => `haptix.panelRoute.${chainId}`,
  /** Origins the user connected, mapped to when. */
  sites: (chainId: number) => `haptix.sites.${chainId}`,
  /** Site requests waiting for a decision (session storage). */
  dappRequests: (chainId: number) => `haptix.dappRequests.${chainId}`,
  account: (chainId: number) => `haptix.account.${chainId}`,
  draft: (chainId: number) => `haptix.onboarding.${chainId}`,
  activity: (chainId: number) => `haptix.activity.${chainId}`,
  bundlerUrl: (chainId: number) => `haptix.bundlerUrl.${chainId}`,
  /** A both-key send handed from the popup to the side panel. */
  pendingSend: (chainId: number) => `haptix.pendingSend.${chainId}`,
};
