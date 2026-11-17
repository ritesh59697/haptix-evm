// The queue of site requests waiting for the user, in session storage so the background
// worker can be stopped and restarted without losing them. Both the worker and the
// wallet pages use these helpers.
import { getItem, getSession, keys, setItem, setSession } from '../chain/store';
import { ProviderError, RESULT_MESSAGE, type DappRequest, type RpcErrorShape } from './protocol';

const chainId = __HAPTIX_NETWORK__.chainId;
const qKey = keys.dappRequests(chainId);

export async function listRequests(): Promise<DappRequest[]> {
  return (await getSession<DappRequest[]>(qKey)) ?? [];
}

/** Read-modify-write on the queue. Calls from one context run one at a time. */
let chain: Promise<unknown> = Promise.resolve();
export function updateRequests(fn: (list: DappRequest[]) => DappRequest[]): Promise<DappRequest[]> {
  const run = chain.then(async () => {
    const next = fn(await listRequests());
    await setSession(qKey, next);
    await showCount(next.length);
    return next;
  });
  chain = run.catch(() => undefined);
  return run;
}

async function showCount(n: number) {
  if (typeof chrome === 'undefined' || !chrome.action) return;
  await chrome.action.setBadgeText({ text: n ? String(n) : '' });
}

/** Answer the page that asked, then drop the request from the queue. */
export async function resolveRequest(req: DappRequest, answer: { result: unknown } | { error: RpcErrorShape }) {
  await updateRequests((list) => list.filter((r) => r.id !== req.id));
  if (typeof chrome === 'undefined' || !chrome.tabs) return;
  try {
    await chrome.tabs.sendMessage(req.tabId, { type: RESULT_MESSAGE, id: req.id, ...answer });
  } catch {
    // The tab closed or navigated away; nobody is waiting any more.
  }
}

export const rejectRequest = (req: DappRequest) =>
  resolveRequest(req, { error: { code: ProviderError.userRejected, message: 'You rejected the request in Haptix.' } });

// --- Connected sites -------------------------------------------------------

export type Sites = Record<string, { connectedAt: number }>;
const sitesKey = keys.sites(chainId);

export async function connectedSites(): Promise<Sites> {
  return (await getItem<Sites>(sitesKey)) ?? {};
}

export async function connectSite(origin: string) {
  const s = await connectedSites();
  s[origin] = { connectedAt: Date.now() };
  await setItem(sitesKey, s);
}

export async function disconnectSite(origin: string) {
  const s = await connectedSites();
  delete s[origin];
  await setItem(sitesKey, s);
}
