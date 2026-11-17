// The seam between the screens and the chain. Screens read WalletState from
// useWallet() and call actions on it. Wired today: passkey onboarding, the
// account's address and balance, and native-token sends through the bundler.
// Sites connect and send transactions through src/background.ts; their requests are
// queued in session storage and decided here. Agents, guardian and freeze come next
// and say so when pressed.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  encodeFunctionData, erc20Abi, formatEther, formatUnits, getAddress, hashMessage, hashTypedData, parseEther, parseUnits, toHex,
  type Address, type Hex,
} from 'viem';
import { sample, type ActivityItem, type WalletState } from './data/sample';
import { getItem, keys as storeKeys, removeItem, setItem, setSession } from './chain/store';
import {
  approveAgentRequest, grantCall, grantSwapBatch, newAgentKey, parseAgentRequest, readAgent, revokeCall, revokeSwapBatch,
  type AgentRecord, type AgentRequest,
} from './chain/agents';
import { rpc as rpcCall } from './chain/rpc';
import { walletTokens } from './chain/token';
import {
  cancelRecoveryCall, encodeRecoveryRequest, freezeCall, isDeployedAt, readSecurity, readSigners, recoveryRequest,
  setGuardianCall, signersHash, unfreezeCall,
} from './chain/guardian';
import type { DappRequest } from './dapp/protocol';
import {
  connectSite, connectedSites, disconnectSite, listRequests, rejectRequest, resolveRequest, type Sites,
} from './dapp/queue';
import { createKey, type KeyKind, type StoredKey } from './chain/passkey';
import { rpc } from './chain/rpc';
import {
  checkSignature, getBalance, isDeployed, newSalt, predictAddress, readThreshold, sendCall, signHash, signatureVersion, signersNeeded,
  type Account, type SendStep,
} from './chain/account';

export const network = __HAPTIX_NETWORK__;

export class NotWiredError extends Error {
  constructor(action: string) {
    super(`${action} isn't connected yet.`);
    this.name = 'NotWiredError';
  }
}
const notWired = (action: string) => async (..._args: unknown[]): Promise<never> => {
  throw new NotWiredError(action);
};

/** Not built yet. Each throws NotWiredError, which the UI shows as a message. */
export const wallet = {
  setDailyLimit: notWired('Changing the limit'),
  declineRequest: notWired('Declining requests'),
  approveDapp: notWired('Token approvals with a cap'),
  signWithSecondKey: notWired('Signing a request from the side panel'),
};

interface Draft { keys: StoredKey[] }

interface WalletApi {
  loading: boolean;
  /** null until an account exists. */
  state: WalletState | null;
  account: Account | null;
  sampleMode: boolean;
  refresh: () => Promise<void>;
  // onboarding
  draftKeys: StoredKey[];
  createFirstKey: () => Promise<void>;
  /** allowShared skips the check that the second authenticator doesn't already hold key 1. */
  createSecondKey: (kind: Exclude<KeyKind, 'touchid'>, opts?: { allowShared?: boolean }) => Promise<void>;
  finishOnboarding: (perSendLimit: string) => Promise<void>;
  // sending
  /** Any token move needs both keys: the account sets no one-key limit on tokens. */
  needsBothKeys: (amount: string, token?: string) => boolean;
  send: (to: string, amount: string, token: string, onStep: (s: SendStep) => void) => Promise<{ txHash: Hex; success: boolean }>;
  /** Hand a both-key send to the side panel, which stays open during the second-key prompt. */
  handOffToPanel: (send: Omit<PendingSend, 'createdAt'>, windowId: number) => void;
  takePendingSend: () => Promise<PendingSend | null>;
  bundlerUrl: string;
  setBundlerUrl: (url: string) => Promise<void>;
  explorerTx: (hash: string) => string;
  explorerAddress: (addr: string) => string;
  // sites
  /** Site requests waiting for a decision, oldest first. */
  dappRequests: DappRequest[];
  sites: Sites;
  connectDapp: (req: Extract<DappRequest, { kind: 'dapp-connect' }>) => Promise<void>;
  rejectDapp: (req: DappRequest) => Promise<void>;
  /** Signer indexes this site transaction needs: [0] or [0, 1]. */
  dappSigners: (req: Extract<DappRequest, { kind: 'dapp-tx' }>) => number[];
  sendDappTx: (req: Extract<DappRequest, { kind: 'dapp-tx' }>, onStep: (s: SendStep) => void) => Promise<{ txHash: Hex; success: boolean }>;
  // agents
  /** Grant a budget with both keys; returns the agent's private key, which is shown once and never stored. */
  grantBudget: (form: BudgetForm, onStep: (s: SendStep) => void) => Promise<{ privateKey: Hex; address: Address; txHash: Hex }>;
  revokeAgent: (address: Address, onStep: (s: SendStep) => void) => Promise<{ txHash: Hex }>;
  parseAgentRequest: (text: string) => Promise<AgentRequest>;
  approveAgentRequest: (req: AgentRequest, onSigning: (index: number) => void) => Promise<{ txHash: Hex; success: boolean }>;
  // freeze, guardian, recovery
  freeze: (onStep: (s: SendStep) => void) => Promise<void>;
  unfreeze: (onStep: (s: SendStep) => void) => Promise<void>;
  /** null removes the guardian. */
  setGuardian: (guardian: Address | null, waitHours: number, onStep: (s: SendStep) => void) => Promise<void>;
  cancelRecovery: (onStep: (s: SendStep) => void) => Promise<void>;
  // restoring on a new device
  restore: RestoreDraft | null;
  /** Check the account can be recovered (on chain, with a guardian) and start a restore. */
  startRestore: (address: string) => Promise<void>;
  createRestoreKey: (kind: KeyKind, opts?: { allowShared?: boolean }) => Promise<void>;
  /** Text to give the guardian; null until both new keys exist. */
  restoreRequestText: string | null;
  /** Read the chain: pending recovery, and whether the new keys are installed (then the account opens). */
  checkRestore: () => Promise<RestoreStatus>;
  cancelRestore: () => Promise<void>;
  /** Popup only: open the side panel on a route, for actions that need both keys. */
  openInPanel: (route: object, windowId: number) => void;
  /** Which keys this message needs: one for personal_sign, both for typed data or while frozen. */
  dappSignSigners: (req: Extract<DappRequest, { kind: 'dapp-sign' }>) => number[];
  /** Sign a site's message and hand the signature to the site. */
  signDapp: (req: Extract<DappRequest, { kind: 'dapp-sign' }>) => Promise<void>;
  disconnectSite: (origin: string) => Promise<void>;
}

export interface RestoreDraft { address: Address; keys: StoredKey[] }
export type RestoreStatus =
  | { stage: 'waiting-for-guardian' }
  | { stage: 'waiting'; executeAfter: number }
  | { stage: 'other-keys'; executeAfter: number }
  | { stage: 'restored' };

export interface BudgetForm {
  name: string;
  budget: string;
  perPayment: string;
  days: number;
  /** Addresses an ETH-paying agent may pay. */
  recipients: Address[];
  /** A trading agent's pair, as symbols from the wallet's tokens. */
  swap?: { tokenIn: string; tokenOut: string };
}

/** The hash a site expects the account to have signed (EIP-191 or EIP-712). */
export function siteMessageHash(req: Extract<DappRequest, { kind: 'dapp-sign' }>): Hex {
  if (req.method === 'personal_sign') return hashMessage({ raw: req.message });
  const { types, domain, primaryType, message } = JSON.parse(req.typedData);
  // viem derives the domain type itself.
  const { EIP712Domain: _domain, ...rest } = types ?? {};
  return hashTypedData({ types: rest, domain, primaryType, message });
}

const Ctx = createContext<WalletApi | null>(null);
const chainId = network.chainId;
const ethNum = (wei: bigint) => Number(formatEther(wei));
const shortHex = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

async function upsertActivity(item: ActivityItem) {
  const list = (await getItem<ActivityItem[]>(storeKeys.activity(chainId))) ?? [];
  const i = list.findIndex((a) => a.id === item.id);
  if (i >= 0) list[i] = item;
  else list.unshift(item);
  await setItem(storeKeys.activity(chainId), list);
}

/** Sends recorded as pending (the window closed before the receipt came): ask the bundler again. */
async function resolvePending(bundlerUrl: string) {
  const list = (await getItem<ActivityItem[]>(storeKeys.activity(chainId))) ?? [];
  let changed = false;
  for (const a of list) {
    if (a.status !== 'pending' || !bundlerUrl) continue;
    try {
      const r = await rpc<{ success: boolean; receipt: { transactionHash: Hex } } | null>(bundlerUrl, 'eth_getUserOperationReceipt', [a.id]);
      if (r) {
        const call = a.title === 'Confirming'; // a site's transaction, see sendDappTx
        a.status = r.success ? 'ok' : 'failed';
        a.title = call ? (r.success ? 'Contract call' : 'Call failed') : r.success ? 'Sent' : 'Send failed';
        a.txHash = r.receipt.transactionHash;
        changed = true;
      }
    } catch {
      /* bundler unreachable: try again next time */
    }
  }
  if (changed) await setItem(storeKeys.activity(chainId), list);
}

export interface PendingSend { to: string; amount: string; token: string; createdAt: number }
/** A handed-off send older than this is ignored, so a stale one never pops up later. */
const PENDING_SEND_TTL_MS = 10 * 60_000;

const DAY = 86_400;
/** How often a visible wallet re-reads the chain. */
const CHAIN_REFRESH_MS = 15_000;

async function loadAgents(account: Account, deployed: boolean): Promise<WalletState['agents']> {
  const records = (await getItem<AgentRecord[]>(storeKeys.agents(chainId))) ?? [];
  const now = Math.floor(Date.now() / 1000);
  return Promise.all(records.map(async (r) => {
    const unit = r.swap ? r.swap.token.decimals : 18;
    const amount = (v: bigint) => Number(formatUnits(v, unit));
    const c = deployed ? await readAgent(account.address, r.address, r.swap?.token.address) : null;
    const status: 'active' | 'revoked' | 'expired' = c?.revoked || (c && !c.registered) ? 'revoked' : r.validUntil <= now ? 'expired' : 'active';
    return {
      id: r.address,
      address: r.address,
      name: r.name,
      scope: r.swap
        ? `Trades ${r.swap.token.symbol} for ${r.swap.tokenOut.symbol} · up to ${formatUnits(BigInt(r.perPaymentWei), unit)} each`
        : `Pays ${r.recipients.length} address${r.recipients.length === 1 ? '' : 'es'} · up to ${formatEther(BigInt(r.perPaymentWei))} each`,
      token: r.swap ? r.swap.token.symbol : network.nativeSymbol,
      spent24h: amount(c?.spentWei ?? 0n),
      budget24h: amount(BigInt(r.budgetWei)),
      endsInDays: Math.max(0, Math.ceil((r.validUntil - now) / DAY)),
      resetsInHours: Math.max(1, Math.ceil(((c?.resetsAt ?? now + r.windowSeconds) - now) / 3600)),
      status,
    };
  }));
}

async function buildState(account: Account, bundlerUrl: string): Promise<WalletState> {
  await resolvePending(bundlerUrl);
  const [balance, deployed, activity] = await Promise.all([
    getBalance(account.address),
    isDeployed(account.address),
    getItem<ActivityItem[]>(storeKeys.activity(chainId)),
  ]);
  const [agents, sec, tokens, sigVersion] = await Promise.all([
    loadAgents(account, deployed),
    readSecurity(account.address, deployed),
    walletTokens(account.address),
    signatureVersion(account, deployed),
  ]);
  const threshold = await readThreshold(account, deployed);
  return {
    account: account.address,
    assets: [
      { symbol: network.nativeSymbol, name: 'Ether', amount: ethNum(balance), decimals: 4 },
      ...tokens.map((t) => ({ symbol: t.symbol, name: t.name, amount: Number(formatUnits(t.balance, t.decimals)), decimals: 2, address: t.address, unitDecimals: t.decimals })),
    ],
    limit: { token: network.nativeSymbol, perSend: ethNum(threshold), daily: null },
    balanceHistory: [],
    agents,
    keys: account.keys.map((k) => ({ label: k.label, kind: k.kind, synced: k.synced })),
    guardian: sec.guardian,
    recoveryWaitHours: sec.guardian ? sec.waitSeconds / 3600 : null,
    minRecoveryWaitHours: sec.minWaitSeconds / 3600,
    frozen: sec.frozen,
    signatureVersion: sigVersion,
    pendingRecovery: sec.pending ? { executeAfter: sec.pending.executeAfter, ours: sec.pending.signersHash === signersHash(account.keys) } : null,
    deployed,
    activity: activity ?? [],
    requests: [],
  };
}

export function WalletProvider({ children, useSample = false }: { children: ReactNode; useSample?: boolean }) {
  const [loading, setLoading] = useState(true);
  const [account, setAccount] = useState<Account | null>(null);
  const [state, setState] = useState<WalletState | null>(useSample ? sample : null);
  const [draftKeys, setDraftKeys] = useState<StoredKey[]>([]);
  const [bundlerUrl, setBundler] = useState('');
  const [dappRequests, setDappRequests] = useState<DappRequest[]>([]);
  const [sites, setSites] = useState<Sites>({});
  const [restore, setRestore] = useState<RestoreDraft | null>(null);

  const refresh = useCallback(async () => {
    if (useSample) return setLoading(false);
    const [acct, draft, url] = await Promise.all([
      getItem<Account>(storeKeys.account(chainId)),
      getItem<Draft>(storeKeys.draft(chainId)),
      getItem<string>(storeKeys.bundlerUrl(chainId)),
    ]);
    const [reqs, connected, rd] = await Promise.all([listRequests(), connectedSites(), getItem<RestoreDraft>(storeKeys.restore(chainId))]);
    setRestore(rd ?? null);
    setDappRequests(reqs);
    setSites(connected);
    setAccount(acct ?? null);
    setDraftKeys(draft?.keys ?? []);
    setBundler(url ?? '');
    setState(acct ? await buildState(acct, url ?? '') : null);
    setLoading(false);
  }, [useSample]);

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [refresh]);

  // The chain moves while the side panel stays open: an agent trades, a guardian starts a
  // recovery. Read it again whenever the wallet comes back into view.
  useEffect(() => {
    if (useSample) return;
    const onShow = () => {
      if (document.visibilityState === 'visible') void refresh().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    // A side panel can stay in view for hours; a recovery alert can't wait for a click.
    const timer = window.setInterval(onShow, CHAIN_REFRESH_MS);
    return () => {
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', onShow);
      window.clearInterval(timer);
    };
  }, [useSample, refresh]);

  // New site requests arrive while the popup or side panel is open.
  useEffect(() => {
    if (useSample || typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    const qKey = storeKeys.dappRequests(chainId);
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[qKey]) setDappRequests((changes[qKey].newValue as DappRequest[] | undefined) ?? []);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [useSample]);

  const saveDraft = async (keys: StoredKey[]) => {
    await setItem<Draft>(storeKeys.draft(chainId), { keys });
    setDraftKeys(keys);
  };

  const api: WalletApi = {
    loading,
    state,
    account,
    sampleMode: useSample,
    refresh,
    draftKeys,
    createFirstKey: async () => {
      if (useSample) throw new NotWiredError('Creating keys in sample mode');
      await saveDraft([await createKey('touchid')]);
    },
    createSecondKey: async (kind, opts) => {
      if (draftKeys.length < 1) throw new Error('Create the Touch ID key first.');
      // excludeCredentials makes an authenticator that already holds key 1 refuse
      // (InvalidStateError): that's a phone sharing this Mac's password manager.
      await saveDraft([draftKeys[0], await createKey(kind, opts?.allowShared ? [] : [draftKeys[0]])]);
    },
    finishOnboarding: async (perSendLimit) => {
      if (draftKeys.length < 2) throw new Error('Both keys are needed before the account can be made.');
      const thresholdWei = parseEther(perSendLimit);
      const salt = newSalt();
      const address = await predictAddress(draftKeys, thresholdWei, salt);
      const acct: Account = { address, salt, thresholdWei: thresholdWei.toString(), keys: draftKeys, createdAt: Date.now(), factory: network.factory };
      await setItem(storeKeys.account(chainId), acct);
      await removeItem(storeKeys.draft(chainId));
      await refresh();
    },
    needsBothKeys: (amount, token) => {
      if (!state) return false;
      if (token && token !== network.nativeSymbol) return true;
      try {
        // The contract asks for both keys at the limit itself, not only above it.
        return state.frozen || parseEther(amount) >= parseEther(String(state.limit.perSend));
      } catch {
        return false;
      }
    },
    send: async (to, amount, token, onStep) => {
      const asset = state?.assets.find((a) => a.symbol === token);
      if (!asset) throw new Error(`This wallet doesn't hold ${token}.`);
      const recipient = getAddress(to) as Address;
      const res = await execute({
        ...(asset.address
          ? { to: asset.address, valueWei: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, parseUnits(amount, asset.unitDecimals ?? 18)] }), amountLabel: `−${amount} ${token}` }
          : { to: recipient, valueWei: parseEther(amount), data: '0x' as Hex }),
        signerIds: api.needsBothKeys(amount, token) ? [0, 1] : [0],
        detail: `${to.slice(0, 6)}…${to.slice(-4)}`,
        titles: ['Sending', 'Sent', 'Send failed'],
        onStep,
      });
      await removeItem(storeKeys.pendingSend(chainId));
      return res;
    },
    handOffToPanel: (send, windowId) => {
      // sidePanel.open must run in the click itself, so nothing here is awaited.
      void setItem<PendingSend>(storeKeys.pendingSend(chainId), { ...send, createdAt: Date.now() });
      void chrome.sidePanel.open({ windowId }).then(() => window.close());
    },
    takePendingSend: async () => {
      // Read once and clear, so a handed-off send opens exactly once.
      const p = await getItem<PendingSend>(storeKeys.pendingSend(chainId));
      if (!p) return null;
      await removeItem(storeKeys.pendingSend(chainId));
      return Date.now() - p.createdAt > PENDING_SEND_TTL_MS ? null : p;
    },
    bundlerUrl,
    setBundlerUrl: async (url) => {
      const u = url.trim();
      // Check it answers, accepts the key, and serves this chain before saving it.
      let served: string;
      try {
        served = await rpc<string>(u, 'eth_chainId', []);
      } catch (e) {
        throw new Error(`That bundler URL didn't work: ${(e as Error).message}`);
      }
      if (BigInt(served) !== BigInt(chainId)) {
        throw new Error(`That bundler serves chain ${BigInt(served)}, not ${network.name} (${chainId}).`);
      }
      await setItem(storeKeys.bundlerUrl(chainId), u);
      setBundler(u);
    },
    explorerTx: (hash) => `${network.explorerUrl.replace(/\/?$/, '/')}tx/${hash}`,
    explorerAddress: (addr) => `${network.explorerUrl.replace(/\/?$/, '/')}address/${addr}`,
    dappRequests,
    sites,
    connectDapp: async (req) => {
      if (!account) throw new Error('Set up the wallet first.');
      await connectSite(req.origin);
      setSites(await connectedSites());
      await resolveRequest(req, { result: [account.address] });
    },
    rejectDapp: (req) => rejectRequest(req),
    dappSigners: (req) => {
      if (!account || !state) return [0, 1];
      return signersNeeded(account, BigInt(req.tx.value), req.tx.data, parseEther(String(state.limit.perSend)), state.frozen);
    },
    sendDappTx: async (req, onStep) => {
      const res = await execute({
        to: req.tx.to,
        valueWei: BigInt(req.tx.value),
        data: req.tx.data,
        signerIds: api.dappSigners(req),
        detail: new URL(req.origin).host,
        titles: ['Confirming', req.tx.data === '0x' ? 'Sent' : 'Contract call', 'Call failed'],
        onStep,
      });
      // Same as any wallet: the site gets the transaction hash, reverted or not.
      await resolveRequest(req, { result: res.txHash });
      return res;
    },
    grantBudget: async (form, onStep) => {
      if (useSample || !account) throw new NotWiredError('Agent budgets in sample mode');
      const key = newAgentKey();
      const pick = (symbol: string) => {
        const a = state?.assets.find((x) => x.symbol === symbol);
        if (!a?.address) throw new Error(`${symbol} isn't a token this wallet knows.`);
        return { address: a.address, symbol: a.symbol, decimals: a.unitDecimals ?? 18 };
      };
      const swap = form.swap && network.swapRouter
        ? { router: network.swapRouter, token: pick(form.swap.tokenIn), tokenOut: pick(form.swap.tokenOut) }
        : undefined;
      if (form.swap && !swap) throw new Error(`${network.name} has no swap router set up.`);
      const unit = swap ? swap.token.decimals : 18;
      const record: AgentRecord = {
        address: key.address,
        name: form.name.trim(),
        recipients: form.recipients,
        swap,
        budgetWei: parseUnits(form.budget, unit).toString(),
        perPaymentWei: parseUnits(form.perPayment, unit).toString(),
        windowSeconds: DAY,
        validUntil: Math.floor(Date.now() / 1000) + form.days * DAY,
        grantedAt: Date.now(),
      };
      if (BigInt(record.perPaymentWei) > BigInt(record.budgetWei)) throw new Error('The most per payment can\'t be more than the daily budget.');
      const res = await execute({
        to: account.address, valueWei: 0n, data: grantCall(record), signerIds: [0, 1],
        callData: record.swap ? grantSwapBatch(account.address, record) : undefined,
        detail: record.name, titles: ['Granting budget', 'Agent budget granted', 'Grant failed'], onStep,
      });
      if (!res.success) throw new Error('The grant reverted on chain. Nothing was granted.');
      const list = (await getItem<AgentRecord[]>(storeKeys.agents(chainId))) ?? [];
      await setItem(storeKeys.agents(chainId), [record, ...list]);
      await refresh();
      return { privateKey: key.privateKey, address: key.address, txHash: res.txHash };
    },
    revokeAgent: async (address, onStep) => {
      if (useSample || !account) throw new NotWiredError('Revoking in sample mode');
      const name = state?.agents.find((a) => a.address === address)?.name ?? shortHex(address);
      const records = (await getItem<AgentRecord[]>(storeKeys.agents(chainId))) ?? [];
      const record = records.find((r) => r.address === address);
      const res = await execute({
        to: account.address, valueWei: 0n, data: revokeCall(address), signerIds: [0, 1],
        callData: record?.swap ? revokeSwapBatch(account.address, record) : undefined,
        detail: name, titles: ['Revoking', 'Agent revoked', 'Revoke failed'], onStep,
      });
      if (!res.success) throw new Error('The revoke reverted on chain. The agent can still spend.');
      return { txHash: res.txHash };
    },
    parseAgentRequest: async (text) => {
      if (!account) throw new Error('Set up the wallet first.');
      const req = await parseAgentRequest(text, account);
      await refresh(); // show what the agent has really spent, not what it had when the panel opened
      const known = state?.agents.some((a) => a.address && getAddress(a.address) === getAddress(req.payload.agent));
      if (!known) throw new Error('This request is from an agent this wallet didn\'t grant.');
      return req;
    },
    approveAgentRequest: async (req, onSigning) => {
      if (!account) throw new Error('Set up the wallet first.');
      if (!bundlerUrl) throw new Error('Add a bundler URL in Security first.');
      const userOpHash = await approveAgentRequest(req, account, bundlerUrl, onSigning);
      const name = state?.agents.find((a) => a.address && getAddress(a.address) === getAddress(req.payload.agent))?.name ?? 'Agent';
      const base = {
        detail: name,
        amount: req.swap ? `−${formatUnits(req.swap.amountIn, req.swap.tokenIn.decimals)} ${req.swap.tokenIn.symbol}` : `−${formatEther(req.valueWei)} ${network.nativeSymbol}`,
        approver: 'both' as const,
      };
      await upsertActivity({ id: userOpHash, title: 'Confirming', status: 'pending', ts: Date.now(), ...base });
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const r = await rpcCall<{ success: boolean; receipt: { transactionHash: Hex } } | null>(bundlerUrl, 'eth_getUserOperationReceipt', [userOpHash]);
        if (r) {
          await upsertActivity({ id: userOpHash, title: r.success ? 'Agent payment approved' : 'Agent payment failed', status: r.success ? 'ok' : 'failed', ts: Date.now(), txHash: r.receipt.transactionHash, ...base });
          await refresh();
          return { txHash: r.receipt.transactionHash, success: r.success };
        }
        await new Promise((ok) => setTimeout(ok, 2000));
      }
      throw new Error(`Submitted, but no receipt after 2 minutes. Look up ${userOpHash} on the explorer.`);
    },
    freeze: async (onStep) => {
      await ownerCall(freezeCall(), [0], ['Freezing', 'Wallet frozen', 'Freeze failed'], onStep);
    },
    unfreeze: async (onStep) => {
      await ownerCall(unfreezeCall(), [0, 1], ['Unfreezing', 'Wallet unfrozen', 'Unfreeze failed'], onStep);
    },
    setGuardian: async (g, waitHours, onStep) => {
      if (!state) throw new Error('Set up the wallet first.');
      const wait = Math.round(waitHours * 3600);
      if (g && wait < state.minRecoveryWaitHours * 3600) throw new Error(`The wait must be at least ${state.minRecoveryWaitHours} hours.`);
      if (g && account && getAddress(g) === getAddress(account.address)) throw new Error('The account can\'t be its own guardian.');
      await ownerCall(setGuardianCall(g, g ? wait : 0), [0, 1], g ? ['Setting guardian', 'Guardian set', 'Guardian change failed'] : ['Removing guardian', 'Guardian removed', 'Guardian change failed'], onStep);
    },
    cancelRecovery: async (onStep) => {
      await ownerCall(cancelRecoveryCall(), [0], ['Cancelling recovery', 'Recovery cancelled', 'Cancel failed'], onStep);
    },
    restore,
    startRestore: async (address) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address.trim())) throw new Error('That isn\'t a full address.');
      const a = getAddress(address.trim()) as Address;
      if (!(await isDeployedAt(a))) throw new Error(`There's no account at that address on ${network.name}.`);
      const sec = await readSecurity(a, true);
      if (!sec.guardian) throw new Error('That account has no guardian, so it can\'t be recovered. Only its own keys can open it.');
      const draft: RestoreDraft = { address: a, keys: [] };
      await setItem(storeKeys.restore(chainId), draft);
      setRestore(draft);
    },
    createRestoreKey: async (kind, opts) => {
      if (!restore) throw new Error('Start a restore first.');
      const key = await createKey(kind, kind === 'touchid' || opts?.allowShared ? [] : restore.keys.slice(0, 1));
      const draft = { ...restore, keys: kind === 'touchid' ? [key] : [restore.keys[0], key] };
      await setItem(storeKeys.restore(chainId), draft);
      setRestore(draft);
    },
    restoreRequestText: restore && restore.keys.length === 2 ? encodeRecoveryRequest(recoveryRequest(restore.address, restore.keys)) : null,
    checkRestore: async () => {
      if (!restore || restore.keys.length < 2) throw new Error('Create both new keys first.');
      const onChain = await readSigners(restore.address);
      const mine = restore.keys.map((k) => ({ x: BigInt(k.x), y: BigInt(k.y) }));
      const installed = onChain.length === mine.length && onChain.every((k, i) => k.x === mine[i].x && k.y === mine[i].y);
      if (installed) {
        const threshold = await readThreshold({ address: restore.address } as Account, true);
        const acct: Account = { address: restore.address, salt: toHex(0n, { size: 32 }), thresholdWei: threshold.toString(), keys: restore.keys, createdAt: Date.now() };
        await setItem(storeKeys.account(chainId), acct);
        await removeItem(storeKeys.restore(chainId));
        await refresh();
        return { stage: 'restored' };
      }
      const sec = await readSecurity(restore.address, true);
      if (!sec.pending) return { stage: 'waiting-for-guardian' };
      return sec.pending.signersHash === signersHash(restore.keys)
        ? { stage: 'waiting', executeAfter: sec.pending.executeAfter }
        : { stage: 'other-keys', executeAfter: sec.pending.executeAfter };
    },
    cancelRestore: async () => {
      await removeItem(storeKeys.restore(chainId));
      setRestore(null);
    },
    openInPanel: (route, windowId) => {
      // sidePanel.open must run in the click itself, so nothing here is awaited.
      void setSession(storeKeys.panelRoute(chainId), route);
      void chrome.sidePanel.open({ windowId }).then(() => window.close());
    },
    dappSignSigners: (req) => {
      // Accounts from the earlier factory accept (and only understand) one key.
      if (state && state.signatureVersion < 2) return [0];
      return req.method === 'personal_sign' && !state?.frozen ? [0] : [0, 1];
    },
    signDapp: async (req) => {
      if (useSample || !account || !state) throw new NotWiredError('Signing in sample mode');
      const hash = siteMessageHash(req);
      const { signature, deployed } = await signHash(account, hash, {
        signerIds: api.dappSignSigners(req),
        personalMessage: req.method === 'personal_sign' ? req.message : undefined,
        version: state.signatureVersion,
      });
      // A deployed account can check its own signature; refuse to hand over one it rejects.
      if (deployed && !(await checkSignature(account, hash, signature))) {
        throw new Error('The account did not accept this signature. Nothing was sent to the site.');
      }
      await resolveRequest(req, { result: signature });
    },
    disconnectSite: async (origin) => {
      await disconnectSite(origin);
      setSites(await connectedSites());
    },
  };

  /** A call from the account to itself (its own settings). */
  async function ownerCall(data: Hex, signerIds: number[], titles: [string, string, string], onStep: (s: SendStep) => void) {
    if (useSample || !account) throw new NotWiredError('Changing settings in sample mode');
    const res = await execute({ to: account.address, valueWei: 0n, data, signerIds, detail: 'Your account', titles, onStep });
    if (!res.success) throw new Error(`${titles[2]}: the call reverted on chain. Nothing changed.`);
  }

  /** Run one call from the account and keep Activity in step with it. */
  async function execute(o: {
    to: Address; valueWei: bigint; data: Hex; signerIds: number[]; detail: string;
    titles: [pending: string, ok: string, failed: string]; onStep: (s: SendStep) => void;
    callData?: Hex; amountLabel?: string;
  }) {
    if (useSample || !account) throw new NotWiredError('Sending in sample mode');
    if (!bundlerUrl) throw new Error('Add a bundler URL in Security first.');
    const base = {
      detail: o.detail,
      amount: o.amountLabel ?? (o.valueWei ? `−${formatEther(o.valueWei)} ${network.nativeSymbol}` : ''),
      approver: (o.signerIds.length > 1 ? 'both' : 'you') as ActivityItem['approver'],
    };
    const res = await sendCall({
      account,
      to: o.to,
      valueWei: o.valueWei,
      data: o.data,
      callData: o.callData,
      signerIds: o.signerIds,
      bundlerUrl,
      onStep: (s) => {
        // Record it the moment the bundler has it, so a closed window can't lose it.
        if (s.stage === 'confirming') {
          void upsertActivity({ id: s.userOpHash, title: o.titles[0], status: 'pending', ts: Date.now(), ...base });
        }
        o.onStep(s);
      },
    });
    await upsertActivity({
      id: res.userOpHash,
      title: res.success ? o.titles[1] : o.titles[2],
      status: res.success ? 'ok' : 'failed',
      ts: Date.now(),
      txHash: res.txHash,
      ...base,
    });
    await refresh();
    return res;
  }

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useWallet() {
  const w = useContext(Ctx);
  if (!w) throw new Error('useWallet outside WalletProvider');
  return w;
}
