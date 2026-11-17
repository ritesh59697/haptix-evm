// Requests from websites: connecting, and transactions they ask the wallet to send.
import { useEffect, useState } from 'react';
import { Check, ChevronDown, ExternalLink, Fingerprint, Globe, KeyRound, Loader2, TriangleAlert, X } from 'lucide-react';
import { decodeFunctionData, erc20Abi, formatEther, formatUnits, hexToString, maxUint256, type Hex } from 'viem';
import { InsufficientFundsError, type SendStep } from '../chain/account';
import { tokenInfo } from '../chain/token';
import type { DappRequest } from '../dapp/protocol';
import { shortAddr } from '../lib';
import { useNav, type Route } from '../nav';
import { network, useWallet } from '../wallet';
import { Btn, PageTitle, Row, Rows, cx } from '../ui';
import { stepLabel } from './Wallet';

type Connect = Extract<DappRequest, { kind: 'dapp-connect' }>;
type Tx = Extract<DappRequest, { kind: 'dapp-tx' }>;
type Sign = Extract<DappRequest, { kind: 'dapp-sign' }>;

const host = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};
const inPopup = () => document.body.classList.contains('popup');

export const routeFor = (r: DappRequest): Route =>
  r.kind === 'dapp-connect' ? { name: 'dappConnect', request: r } : r.kind === 'dapp-sign' ? { name: 'dappSign', request: r } : { name: 'dappTx', request: r };

/** After a decision: the next waiting request, or close the popup, or back to the list. */
function useNext() {
  const nav = useNav();
  const w = useWallet();
  return (decided: DappRequest) => {
    const next = w.dappRequests.find((r) => r.id !== decided.id);
    if (next) nav.reset(routeFor(next));
    else if (inPopup()) window.close();
    else nav.reset(nav.homeRoute);
  };
}

function SitePill({ origin }: { origin: string }) {
  const secure = origin.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);
  return (
    <div className="flex h-11 items-center gap-2.5 rounded-btn border border-line bg-card px-3.5">
      <Globe size={16} className="text-muted" />
      <span className="flex-1 truncate font-mono text-[13px]">{host(origin)}</span>
      {!secure && <span className="flex items-center gap-1 text-[11px] text-both"><TriangleAlert size={12} />Not encrypted</span>}
    </div>
  );
}

export function DappConnect({ request }: { request: Connect }) {
  const nav = useNav();
  const w = useWallet();
  const next = useNext();
  return (
    <div className="flex min-h-full flex-col p-5">
      <SitePill origin={request.origin} />
      <div className="mt-5"><PageTitle size="lg">Connect to {host(request.origin)}?</PageTitle></div>
      <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">
        The site will see your address and balance, and can ask you to approve transactions. It can't move anything without you.
      </p>
      <div className="mt-[18px]">
        <Rows>
          <Row label="Account"><span className="font-mono text-xs">{w.account ? shortAddr(w.account.address) : '—'}</span></Row>
          <Row label="Network">{network.name}</Row>
        </Rows>
      </div>
      <div className="flex-1" />
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Btn variant="outline" onClick={() => nav.run(() => w.rejectDapp(request), undefined, () => next(request))}>Reject</Btn>
        <Btn onClick={() => nav.run(() => w.connectDapp(request), `Connected to ${host(request.origin)}`, () => next(request))}>Connect</Btn>
      </div>
    </div>
  );
}

interface Decoded { title: string; rows: { label: string; value: string; strong?: boolean; mono?: boolean }[] }

/** What the call does, decoded from the exact bytes that will be signed. */
function useDecoded(req: Tx): Decoded {
  const { to, value, data } = req.tx;
  const eth = `${formatEther(BigInt(value))} ${network.nativeSymbol}`;
  const [token, setToken] = useState<{ symbol: string; decimals: number } | null>(null);
  let call: ReturnType<typeof decodeFunctionData<typeof erc20Abi>> | null = null;
  try {
    call = data === '0x' ? null : decodeFunctionData({ abi: erc20Abi, data: data as Hex });
  } catch {
    call = null;
  }
  const isToken = call?.functionName === 'approve' || call?.functionName === 'transfer';
  useEffect(() => {
    if (isToken) void tokenInfo(to).then(setToken);
  }, [to, isToken]);

  const amt = (n: bigint) => (token ? `${formatUnits(n, token.decimals)} ${token.symbol}` : `${n} (raw units)`);
  if (data === '0x') return { title: `Send ${eth}`, rows: [{ label: 'To', value: to, mono: true }, { label: 'Amount', value: eth, strong: true }] };
  if (call?.functionName === 'approve') {
    const [spender, n] = call.args;
    return {
      title: `Let ${shortAddr(spender)} spend your ${token?.symbol ?? 'tokens'}?`,
      rows: [
        { label: 'Token', value: token?.symbol ?? to, mono: !token },
        { label: 'Spender', value: spender, mono: true },
        { label: 'Amount', value: n === maxUint256 ? 'Unlimited' : amt(n), strong: true },
      ],
    };
  }
  if (call?.functionName === 'transfer') {
    const [recipient, n] = call.args;
    return {
      title: `Send ${amt(n)}`,
      rows: [{ label: 'To', value: recipient, mono: true }, { label: 'Amount', value: amt(n), strong: true }, { label: 'Token', value: token?.symbol ?? to, mono: !token }],
    };
  }
  return {
    title: 'Call a contract',
    rows: [
      { label: 'Contract', value: to, mono: true },
      { label: 'Function', value: call ? call.functionName : data.slice(0, 10), mono: !call },
      { label: 'Sends', value: eth, strong: BigInt(value) > 0n },
    ],
  };
}

export function DappTx({ request }: { request: Tx }) {
  const nav = useNav();
  const w = useWallet();
  const next = useNext();
  const d = useDecoded(request);
  const both = w.dappSigners(request).length > 1;
  const [step, setStep] = useState<SendStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ txHash: string; success: boolean } | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const busy = step !== null;
  // Chrome closes the toolbar popup when the second-key prompt takes focus, so both-key
  // requests continue in the side panel, which stays open.
  const handOff = inPopup() && both && typeof chrome !== 'undefined' && !!chrome.sidePanel;

  const approve = async () => {
    setError(null);
    try {
      setDone(await w.sendDappTx(request, setStep));
    } catch (e) {
      if (e instanceof InsufficientFundsError) {
        setError(`Not enough ${network.nativeSymbol}. This needs about ${formatEther(e.needWei)} ${network.nativeSymbol} including gas; the account has ${formatEther(e.haveWei)}.`);
      } else if ((e as Error).name === 'NotAllowedError') {
        setError('The passkey prompt was closed or timed out. Nothing was sent; you can try again.');
      } else {
        setError((e as Error).message);
      }
    } finally {
      setStep(null);
    }
  };

  if (done) {
    return (
      <div className="flex min-h-full flex-col p-5">
        <span className={cx('flex h-12 w-12 items-center justify-center rounded-card', done.success ? 'bg-accent text-on-accent' : 'bg-both text-on-both')}>
          {done.success ? <Check size={24} strokeWidth={2.5} /> : <TriangleAlert size={22} />}
        </span>
        <div className="mt-4"><PageTitle>{done.success ? 'Done' : 'It reverted on chain'}</PageTitle></div>
        <p className="m-0 mt-2 text-[13px] leading-normal text-muted">
          {done.success ? `${host(request.origin)} has the transaction hash.` : 'Gas was used but the call failed. The explorer has the details.'}
        </p>
        <a href={w.explorerTx(done.txHash)} target="_blank" rel="noreferrer" className="mt-4 flex h-11 items-center justify-between rounded-btn border border-line bg-card px-3.5 text-[13px] text-fg no-underline hover:bg-raised">
          <span className="font-mono text-xs">{shortAddr(done.txHash)}</span>
          <span className="flex items-center gap-1.5 text-muted">View on explorer <ExternalLink size={13} /></span>
        </a>
        <div className="flex-1" />
        <Btn onClick={() => next(request)}>Done</Btn>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col p-5">
      <SitePill origin={request.origin} />
      <div className="mt-5"><PageTitle size="lg">{d.title}</PageTitle></div>
      <div className="mt-[18px]">
        <Rows>
          {d.rows.map((r) => (
            <Row key={r.label} label={r.label}>
              <span className={cx(r.mono && 'font-mono text-xs', r.strong && 'font-semibold', r.value === 'Unlimited' && 'text-both')} title={r.value}>
                {r.mono && r.value.startsWith('0x') ? shortAddr(r.value) : r.value}
              </span>
            </Row>
          ))}
        </Rows>
      </div>

      <div className={cx('mt-2 flex flex-col gap-1.5 rounded-card px-3.5 py-3', both ? 'border-[1.5px] border-both' : 'border border-line bg-card')}>
        <div className={cx('flex items-center gap-2 text-xs font-semibold', both ? 'text-both' : 'text-accent-text')}>
          {both ? <KeyRound size={14} /> : <Fingerprint size={14} />}{both ? 'Needs both keys' : 'One fingerprint'}
        </div>
        <div className="text-xs leading-snug text-muted">
          {both
            ? request.tx.data === '0x'
              ? `It's at or above your per-send limit. You'll confirm with Touch ID, then your ${w.account?.keys[1]?.label.toLowerCase() ?? 'second key'}.`
              : `Your account asks for both keys on every contract call, approval and token move. You'll confirm with Touch ID, then your ${w.account?.keys[1]?.label.toLowerCase() ?? 'second key'}.`
            : 'Within your per-send limit.'}
        </div>
      </div>

      <div className="mt-2 rounded-card border border-line bg-card px-3.5">
        <button type="button" aria-expanded={showRaw} onClick={() => setShowRaw((v) => !v)} className="flex h-11 w-full items-center justify-between text-[13px] text-muted">
          What you're signing <ChevronDown size={14} className={cx('transition-transform', showRaw && 'rotate-180')} />
        </button>
        {showRaw && (
          <div className="max-h-40 overflow-y-auto break-all pb-3.5 font-mono text-[11px] leading-relaxed text-muted">
            execute(to: {request.tx.to}, value: {request.tx.value} wei, data: {request.tx.data})<br />chain {network.chainId}
          </div>
        )}
      </div>

      {error && <div role="alert" className="mt-2 rounded-card border border-both px-3.5 py-2.5 text-xs leading-snug text-both">{error}</div>}
      {busy && (
        <div aria-live="polite" className="mt-2 flex items-center gap-2 rounded-card border border-line bg-card px-3.5 py-2.5 text-xs">
          <Loader2 size={14} className="animate-spin text-accent-text" />{stepLabel(step)}
        </div>
      )}

      <div className="flex-1" />
      <div className="mt-4 grid grid-cols-[auto_1fr] gap-2">
        <Btn variant="outline" disabled={busy} aria-label="Reject" onClick={() => nav.run(() => w.rejectDapp(request), undefined, () => next(request))}>
          <X size={18} />Reject
        </Btn>
        {handOff ? (
          <Btn variant="both" onClick={() => void chrome.sidePanel.open({ windowId: request.windowId }).then(() => window.close())}>
            <KeyRound size={18} />Sign in side panel
          </Btn>
        ) : (
          <Btn variant={both ? 'both' : 'primary'} disabled={busy} onClick={approve}>
            <Fingerprint size={18} />{both ? 'Sign with both keys' : 'Approve with Touch ID'}
          </Btn>
        )}
      </div>
    </div>
  );
}

/** Why this signature needs both keys. */
const whyBothKeys = (r: Sign) =>
  r.method === 'personal_sign'
    ? 'Your wallet is frozen, so every signature needs both keys.'
    : 'Signing structured data can authorize spending, so it needs both keys.';

/** The message as text when it is readable, otherwise as hex. */
function readable(hex: Hex) {
  try {
    const text = hexToString(hex);
    // Control characters other than line breaks and tabs mean it isn't meant to be read.
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

interface Typed { domain?: Record<string, unknown>; primaryType?: string; message?: Record<string, unknown> }

export function DappSign({ request }: { request: Sign }) {
  const nav = useNav();
  const w = useWallet();
  const next = useNext();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const both = w.dappSignSigners(request).length > 1;
  // Chrome closes the toolbar popup during the second-key prompt; the side panel stays open.
  const handOff = inPopup() && both && typeof chrome !== 'undefined' && !!chrome.sidePanel;
  const typed: Typed | null = request.method === 'eth_signTypedData_v4' ? JSON.parse(request.typedData) : null;
  const text = request.method === 'personal_sign' ? readable(request.message) : null;
  // Permits approve spending by signature. Accounts from the earlier factory accept one key
  // for any signature, so there these get around the both-keys rule for on-chain approvals.
  const permit = !!typed && (/permit/i.test(typed.primaryType ?? '') || (!!typed.message && 'spender' in typed.message));

  const signIt = async () => {
    setError(null);
    setBusy(true);
    try {
      await w.signDapp(request);
      nav.run(async () => undefined, 'Signed');
      next(request);
    } catch (e) {
      setError((e as Error).name === 'NotAllowedError' ? 'The passkey prompt was closed or timed out. Nothing was signed.' : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col p-5">
      <SitePill origin={request.origin} />
      <div className="mt-5"><PageTitle size="lg">{permit ? 'Sign a token approval?' : 'Sign this message?'}</PageTitle></div>
      <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">
        {permit
          ? 'This signature lets a contract spend your tokens later, without another prompt.'
          : 'Signing proves you own this account. It doesn\'t send anything or cost gas.'}
      </p>

      {typed ? (
        <div className="mt-[18px]">
          <Rows>
            {typeof typed.domain?.name === 'string' && <Row label="App">{typed.domain.name}</Row>}
            {typeof typed.domain?.verifyingContract === 'string' && (
              <Row label="Contract"><span className="font-mono text-xs" title={typed.domain.verifyingContract}>{shortAddr(typed.domain.verifyingContract)}</span></Row>
            )}
            <Row label="Type">{typed.primaryType ?? '—'}</Row>
          </Rows>
          <pre className="m-0 mt-2 max-h-32 overflow-auto rounded-card border border-line bg-card p-3.5 font-mono text-[11px] leading-relaxed text-muted">
            {JSON.stringify(typed.message ?? {}, null, 2)}
          </pre>
        </div>
      ) : (
        <pre className="m-0 mt-[18px] max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-card border border-line bg-card p-3.5 font-mono text-xs leading-relaxed">
          {text ?? (request.method === 'personal_sign' ? request.message : '')}
        </pre>
      )}

      {permit && !both && (
        <div className="mt-2 flex items-start gap-2 rounded-card border-[1.5px] border-both px-3.5 py-3 text-xs leading-snug text-both">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          This account was made before the rule that signed approvals need both keys, so one fingerprint is enough here. Only sign if you trust this site.
        </div>
      )}
      {both && (
        <div className="mt-2 flex items-start gap-2 rounded-card border-[1.5px] border-both px-3.5 py-3 text-xs leading-snug text-both">
          <KeyRound size={14} className="mt-0.5 shrink-0" />
          {whyBothKeys(request)} You'll confirm with Touch ID, then your {w.account?.keys[1]?.label.toLowerCase() ?? 'second key'}.
        </div>
      )}
      {error && <div role="alert" className="mt-2 rounded-card border border-both px-3.5 py-2.5 text-xs leading-snug text-both">{error}</div>}

      <div className="flex-1" />
      <div className="mt-4 grid grid-cols-[auto_1fr] gap-2">
        <Btn variant="outline" disabled={busy} onClick={() => nav.run(() => w.rejectDapp(request), undefined, () => next(request))}><X size={18} />Reject</Btn>
        {handOff ? (
          <Btn variant="both" onClick={() => void chrome.sidePanel.open({ windowId: request.windowId }).then(() => window.close())}>
            <KeyRound size={18} />Sign in side panel
          </Btn>
        ) : (
          <Btn variant={both || permit ? 'both' : 'primary'} disabled={busy} onClick={signIt}>
            {busy ? <Loader2 size={18} className="animate-spin" /> : both ? <KeyRound size={18} /> : <Fingerprint size={18} />}{both ? 'Sign with both keys' : 'Sign with Touch ID'}
          </Btn>
        )}
      </div>
    </div>
  );
}

/** Security screen section: sites that can see the account. */
export function ConnectedSites() {
  const w = useWallet();
  const nav = useNav();
  const list = Object.entries(w.sites).sort((a, b) => b[1].connectedAt - a[1].connectedAt);
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-xs text-muted">Connected sites</div>
      {list.length === 0 ? (
        <p className="m-0 text-[13px] text-muted">None yet. Sites ask to connect when you use them.</p>
      ) : (
        <div className="divide-y divide-hair rounded-card border border-line bg-card px-3.5">
          {list.map(([origin]) => (
            <div key={origin} className="flex h-11 items-center gap-2.5">
              <Globe size={14} className="text-muted" />
              <span className="flex-1 truncate font-mono text-xs">{host(origin)}</span>
              <Btn variant="ghost" size="sm" onClick={() => nav.run(() => w.disconnectSite(origin), `Disconnected ${host(origin)}`)}>Disconnect</Btn>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
