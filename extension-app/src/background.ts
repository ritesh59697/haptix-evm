// Background worker: answers sites' EIP-1193 requests. Reads go straight to the chain
// RPC. Anything that needs the user (connecting, sending) is queued and shown in the
// wallet, which answers the tab directly when the user decides. The worker keeps no
// state in memory, so Chrome can stop and restart it at any time.
import { getAddress, isAddress, isHex, toHex, type Address, type Hex } from 'viem';
import { rpc, RpcError } from './chain/rpc';
import { getItem, keys } from './chain/store';
import type { Account } from './chain/account';
import { ProviderError, READ_METHODS, type DappRequest, type RpcErrorShape } from './dapp/protocol';
import { connectedSites, updateRequests } from './dapp/queue';

const net = __HAPTIX_NETWORK__;

/** Returned for requests the user has to decide; the wallet answers the tab later. */
class Pending {
  constructor(public id: string) {}
}

class ProviderRpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const account = async () => (await getItem<Account>(keys.account(net.chainId)))?.address;

/**
 * What the toolbar icon opens. Before there is an account it opens the side panel, because
 * the popup closes during the second key's prompt (a phone QR code or a security key).
 * Once the account exists it opens
 * the popup again, which sites' requests also use.
 */
async function syncActionMode() {
  const hasAccount = !!(await account());
  await chrome.action.setPopup({ popup: hasAccount ? 'index.html' : '' });
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: !hasAccount });
}
void syncActionMode();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && keys.account(net.chainId) in changes) void syncActionMode();
});

async function connected(origin: string): Promise<Address | null> {
  const [addr, sites] = await Promise.all([account(), connectedSites()]);
  return addr && sites[origin] ? addr : null;
}

/** Show the request: the side panel shows it if it's open, otherwise open the popup. */
async function surface(windowId: number) {
  const panels = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.SIDE_PANEL] });
  if (panels.some((p) => p.windowId === windowId)) return;
  try {
    await chrome.action.openPopup({ windowId });
  } catch {
    // openPopup fails when the window isn't focused. The badge still shows the count.
  }
}

async function enqueue(req: DappRequest) {
  await updateRequests((list) => [...list, req]);
  await surface(req.windowId);
  return new Pending(req.id);
}

type Sender = { origin: string; tabId: number; windowId: number };

async function handle(method: string, params: unknown[], s: Sender): Promise<unknown> {
  const base = { id: crypto.randomUUID(), origin: s.origin, tabId: s.tabId, windowId: s.windowId, createdAt: Date.now() };
  switch (method) {
    case 'eth_chainId':
      return toHex(net.chainId);
    case 'net_version':
      return String(net.chainId);
    case 'eth_accounts': {
      const a = await connected(s.origin);
      return a ? [a] : [];
    }
    case 'eth_requestAccounts': {
      const a = await connected(s.origin);
      if (a) return [a];
      if (!(await account())) {
        await surface(s.windowId);
        throw new ProviderRpcError(ProviderError.unauthorized, 'Set up your Haptix wallet first, then connect again.');
      }
      return enqueue({ ...base, kind: 'dapp-connect' });
    }
    case 'wallet_switchEthereumChain':
    case 'wallet_addEthereumChain': {
      const want = (params[0] as { chainId?: string } | undefined)?.chainId;
      if (want && BigInt(want) === BigInt(net.chainId)) return null;
      throw new ProviderRpcError(ProviderError.unrecognizedChain, `Haptix is on ${net.name} (${net.chainId}) only.`);
    }
    case 'eth_sendTransaction': {
      const from = await connected(s.origin);
      if (!from) throw new ProviderRpcError(ProviderError.unauthorized, 'Connect this site to Haptix first.');
      const tx = (params[0] ?? {}) as { from?: string; to?: string; value?: string; data?: string; input?: string; chainId?: string };
      if (tx.from && (!isAddress(tx.from) || getAddress(tx.from) !== from)) {
        throw new ProviderRpcError(ProviderError.unauthorized, 'That transaction is from an account this site is not connected to.');
      }
      if (tx.chainId && BigInt(tx.chainId) !== BigInt(net.chainId)) {
        throw new ProviderRpcError(ProviderError.unrecognizedChain, `Haptix is on ${net.name} (${net.chainId}) only.`);
      }
      if (!tx.to || !isAddress(tx.to)) {
        throw new ProviderRpcError(ProviderError.unsupported, 'Haptix can\'t deploy contracts from a site. The transaction needs a "to" address.');
      }
      const data = (tx.data ?? tx.input ?? '0x') as Hex;
      if (!isHex(data)) throw new ProviderRpcError(ProviderError.invalidParams, 'Transaction data is not hex.');
      const value = tx.value ? BigInt(tx.value).toString() : '0';
      return enqueue({ ...base, kind: 'dapp-tx', tx: { to: getAddress(tx.to), value, data } });
    }
    case 'personal_sign': {
      const from = await connected(s.origin);
      if (!from) throw new ProviderRpcError(ProviderError.unauthorized, 'Connect this site to Haptix first.');
      // Spec order is [message, address]; some sites send them swapped.
      const [a, b] = params as string[];
      const message = isAddress(String(a)) && !isAddress(String(b)) ? b : a;
      const addr = message === a ? b : a;
      if (addr && (!isAddress(addr) || getAddress(addr) !== from)) {
        throw new ProviderRpcError(ProviderError.unauthorized, 'That message is for an account this site is not connected to.');
      }
      const hex = isHex(message) ? message : toHex(String(message ?? ''));
      return enqueue({ ...base, kind: 'dapp-sign', method: 'personal_sign', message: hex });
    }
    case 'eth_signTypedData_v3':
    case 'eth_signTypedData_v4': {
      const from = await connected(s.origin);
      if (!from) throw new ProviderRpcError(ProviderError.unauthorized, 'Connect this site to Haptix first.');
      const [addr, data] = params as [string, unknown];
      if (!isAddress(String(addr)) || getAddress(String(addr)) !== from) {
        throw new ProviderRpcError(ProviderError.unauthorized, 'That message is for an account this site is not connected to.');
      }
      const typedData = typeof data === 'string' ? data : JSON.stringify(data);
      let parsed: { domain?: { chainId?: string | number } };
      try {
        parsed = JSON.parse(typedData);
      } catch {
        throw new ProviderRpcError(ProviderError.invalidParams, 'Typed data is not valid JSON.');
      }
      const chain = parsed.domain?.chainId;
      if (chain !== undefined && BigInt(chain) !== BigInt(net.chainId)) {
        throw new ProviderRpcError(ProviderError.invalidParams, `That message is for chain ${BigInt(chain)}, not ${net.name} (${net.chainId}).`);
      }
      return enqueue({ ...base, kind: 'dapp-sign', method: 'eth_signTypedData_v4', typedData });
    }
    case 'eth_sign':
    case 'eth_signTypedData':
      // eth_sign signs a bare hash the user can't read; v1 typed data is obsolete.
      throw new ProviderRpcError(ProviderError.unsupported, `Haptix doesn't support ${method}. Use personal_sign or eth_signTypedData_v4.`);
  }
  if (READ_METHODS.has(method)) {
    try {
      return await rpc(net.rpcUrl, method, params);
    } catch (e) {
      if (e instanceof RpcError) throw new ProviderRpcError(e.code ?? ProviderError.internal, e.message);
      throw e;
    }
  }
  throw new ProviderRpcError(ProviderError.unsupported, `Haptix doesn't support ${method}.`);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'haptix:rpc') return;
  // Only content scripts in a tab carry a tab; the origin comes from Chrome, not the page.
  if (sender.id !== chrome.runtime.id || !sender.tab?.id || !sender.origin || sender.frameId !== 0) {
    sendResponse({ error: { code: ProviderError.unauthorized, message: 'Request not from a page.' } });
    return;
  }
  const s: Sender = { origin: sender.origin, tabId: sender.tab.id, windowId: sender.tab.windowId };
  const params = Array.isArray(msg.params) ? msg.params : [];
  handle(String(msg.method), params, s).then(
    (result) => sendResponse(result instanceof Pending ? { pending: result.id } : { result }),
    (e) => {
      const error: RpcErrorShape = e instanceof ProviderRpcError
        ? { code: e.code, message: e.message }
        : { code: ProviderError.internal, message: (e as Error).message };
      sendResponse({ error });
    },
  );
  return true; // answer asynchronously
});

// A closed tab can't receive an answer, so drop what it asked for.
chrome.tabs.onRemoved.addListener((tabId) => {
  void updateRequests((list) => list.filter((r) => r.tabId !== tabId));
});
