import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, ChevronRight, Copy, Cpu, ExternalLink, Fingerprint, KeyRound, Loader2, TriangleAlert } from 'lucide-react';
import type { SendStep } from '../chain/account';
import { InsufficientFundsError } from '../chain/account';
import { formatEther } from 'viem';
import type { Request, WalletState } from '../data/sample';
import { ago, copyText, decimalsFor, fmt, pct, shortAddr, sparkPath } from '../lib';
import { useNav } from '../nav';
import { network, useWallet, wallet } from '../wallet';
import { Amount, ApproverTag, BottomNav, Btn, Header, Logo, Meter, PageTitle, Row, Rows, cx } from '../ui';
import { SecurityBanners } from './Guard';

function AccountChip({ account }: { account: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyText(account)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        }
      }}
      className="flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-btn border border-line bg-card pl-1.5 pr-2.5 font-mono text-xs hover:bg-raised"
      aria-label={`Copy address ${account}`}
    >
      <Logo size={20} />
      {shortAddr(account)}
      {copied ? <Check size={13} className="text-accent-text" /> : <Copy size={13} className="text-muted" />}
    </button>
  );
}

function NetworkPill() {
  return (
    <span className="flex h-8 min-w-0 items-center gap-1.5 rounded-btn border border-line bg-card px-2.5 font-mono text-[11px] text-muted" title={`${network.name} (${network.chainId})`}>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
      <span className="truncate whitespace-nowrap">{network.name}</span>
    </span>
  );
}

/** How the limit applies: a rolling daily meter when the account has one, else the per-send line. */
function LimitCard({ limit, pending, note }: { limit: WalletState['limit']; pending?: number; note: string }) {
  if (!limit.daily) {
    return (
      <div className="flex flex-col gap-1.5 rounded-card border border-line bg-card px-3.5 py-3">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted">One fingerprint per send, up to</span>
          <span className="font-mono font-medium">{fmt(limit.perSend, 4)} {limit.token}</span>
        </div>
        <div className="text-[11px] leading-snug text-muted">{note}</div>
      </div>
    );
  }
  const { spent, cap } = limit.daily;
  const used = pct(spent, cap);
  const add = pending ? pct(spent + pending, cap) - used : 0;
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-card px-3.5 py-3">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted">{pending ? 'Daily limit after this' : 'Spent today with Touch ID'}</span>
        <span className="font-mono font-medium">{fmt(spent + (pending ?? 0), 2)} / {fmt(cap, 2)} {limit.token}</span>
      </div>
      <Meter parts={[{ pct: used, className: pending ? 'bg-accent/40' : 'bg-accent' }, ...(pending ? [{ pct: add, className: 'bg-accent' }] : [])]} />
      <div className="text-[11px] leading-snug text-muted">{note}</div>
    </div>
  );
}

export function Home({ state }: { state: WalletState }) {
  const nav = useNav();
  const native = state.assets[0];
  const activeAgents = state.agents.filter((a) => (a.status ?? 'active') === 'active');
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-4 pt-3">
        <AccountChip account={state.account} />
        <NetworkPill />
      </div>
      <main className="no-scrollbar flex-1 overflow-y-auto">
        <div className="px-4 pt-3.5">
          <div className="text-xs text-muted">Balance</div>
          <Amount value={fmt(native.amount, native.decimals)} unit={native.symbol} />
        </div>
        {state.balanceHistory.length > 1 && <svg width="100%" height="64" viewBox="0 0 360 64" preserveAspectRatio="none" aria-hidden="true" className="mt-1.5 block">
          <path d={sparkPath(state.balanceHistory, 360, 56)} fill="none" stroke="rgb(var(--accent))" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d="M0 60 H360" stroke="rgb(var(--line))" strokeDasharray="2 4" />
        </svg>}
        <SecurityBanners state={state} />
        {!state.deployed && (
          <p className="m-0 mx-4 mt-2 text-[11px] leading-snug text-muted">
            New account: it goes on chain with your first send. Add some {native.symbol} first to pay for it.
          </p>
        )}

        <div className="grid grid-cols-3 gap-2 px-4 pt-2.5">
          <Btn size="md" onClick={() => nav.go({ name: 'send' })}><ArrowUpRight size={16} strokeWidth={2.2} />Send</Btn>
          <Btn size="md" variant="outline" onClick={() => nav.go({ name: 'receive' })}><ArrowDownLeft size={16} />Receive</Btn>
          <Btn size="md" variant="outline" onClick={() => nav.reset({ name: 'agents' })}><Cpu size={16} />Agents</Btn>
        </div>

        <div className="mx-4 mt-3">
          <LimitCard limit={state.limit} note={state.limit.daily ? `Above ${fmt(state.limit.daily.cap, 2)} ${state.limit.token} in 24 hours, your second key is needed too.` : 'Bigger sends need your second key too.'} />
        </div>

        <button type="button" onClick={() => nav.reset({ name: 'agents' })} className="mx-4 mt-2 flex h-11 w-[calc(100%-2rem)] items-center gap-2.5 rounded-card border border-line bg-card px-3.5 text-left text-xs hover:bg-raised">
          <span className="h-2 w-2 shrink-0 rounded-full bg-agent" />
          <span className="flex-1">{activeAgents.length ? `${activeAgents.length} ${activeAgents.length === 1 ? 'agent' : 'agents'} active` : 'No active agents'}</span>
          <span className="text-muted">{activeAgents.length ? 'See budgets' : 'Give one a budget'}</span>
          <ChevronRight size={14} className="text-muted" />
        </button>

        <ul className="m-0 list-none px-4 pb-2 pt-1.5">
          {state.assets.map((a) => (
            <li key={a.symbol} className="flex h-11 items-center gap-3 border-b border-hair last:border-0">
              <span className="flex h-[30px] w-[30px] items-center justify-center rounded-full bg-raised text-[9px] font-semibold">{a.symbol}</span>
              <span className="flex-1 text-sm font-medium">{a.name}</span>
              <span className="text-sm">{fmt(a.amount, a.decimals)}</span>
            </li>
          ))}
        </ul>
      </main>
      <BottomNav active="home" />
    </div>
  );
}

export function Send({ state }: { state: WalletState }) {
  const nav = useNav();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [token, setToken] = useState(state.assets[0].symbol);
  const asset = state.assets.find((a) => a.symbol === token)!;
  const n = Number(amount);
  const validTo = /^0x[0-9a-fA-F]{40}$/.test(to.trim());
  const validAmount = n > 0 && n <= asset.amount;
  return (
    <div className="flex h-full flex-col">
      <Header title="Send" />
      <div className="flex flex-1 flex-col gap-4 px-4 pb-4 pt-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="to" className="text-xs text-muted">To</label>
          <input id="to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false}
            className="h-12 rounded-btn border border-line bg-card px-4 font-mono text-[13px] text-fg outline-none placeholder:text-faint focus:border-accent" />
          {to && !validTo && <span className="text-[11px] text-both">That isn't a full address.</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="amount" className="text-xs text-muted">Amount</label>
          <div className="flex h-16 items-center rounded-btn border border-line bg-card px-4 focus-within:border-accent">
            <input id="amount" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[28px] font-medium text-fg outline-none placeholder:text-faint" />
            <label className="relative flex items-center gap-1 text-sm text-muted">
              <span className="sr-only">Token</span>
              <select value={token} onChange={(e) => setToken(e.target.value)} className="appearance-none bg-transparent pr-4 text-sm text-fg outline-none">
                {state.assets.map((a) => <option key={a.symbol} value={a.symbol} className="bg-card">{a.symbol}</option>)}
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-0" />
            </label>
          </div>
          <button type="button" onClick={() => setAmount(String(asset.amount))} className="self-start text-[11px] text-muted hover:text-fg">
            Balance {fmt(asset.amount, asset.decimals)} {asset.symbol} · use max
          </button>
        </div>
        <div className="flex-1" />
        <Btn disabled={!validTo || !validAmount} onClick={() => nav.go({ name: 'review', to: to.trim(), amount, token })}>Review</Btn>
      </div>
    </div>
  );
}

export function stepLabel(step: SendStep | null) {
  if (!step) return '';
  if (step.stage === 'preparing') return 'Checking gas and balance…';
  if (step.stage === 'signing') return `${step.key.label}: confirm on your ${step.key.kind === 'touchid' ? 'Mac' : step.key.kind === 'phone' ? 'phone' : 'security key'}${step.of > 1 ? ` (${step.index + 1} of ${step.of})` : ''}`;
  if (step.stage === 'submitting') return 'Sending to the bundler…';
  return 'Waiting for the chain…';
}

export function Review({ state, to, amount, token }: { state: WalletState; to: string; amount: string; token: string }) {
  const nav = useNav();
  const w = useWallet();
  const { limit } = state;
  const n = Number(amount);
  const both = w.needsBothKeys(amount, token);
  const isToken = token !== network.nativeSymbol;
  const known = state.activity.some((a) => a.detail === shortAddr(to));
  const decimals = decimalsFor(state.assets, token);
  const [step, setStep] = useState<SendStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = step !== null;
  // Chrome closes the toolbar popup when the second-key prompt takes focus, so above the
  // limit the popup hands the send to the side panel, which stays open.
  const inPopup = document.body.classList.contains('popup') && typeof chrome !== 'undefined' && !!chrome.sidePanel;
  const [windowId, setWindowId] = useState<number | null>(null);
  useEffect(() => {
    if (inPopup && both) chrome.windows.getCurrent().then((win) => setWindowId(win.id ?? null));
  }, [inPopup, both]);
  const handOff = inPopup && both;

  const go = async () => {
    setError(null);
    try {
      const res = await w.send(to, amount, token, setStep);
      nav.reset(nav.homeRoute);
      nav.go({ name: 'sent', to, amount, token, txHash: res.txHash, success: res.success, both });
    } catch (e) {
      if (e instanceof InsufficientFundsError) {
        setError(`Not enough ${network.nativeSymbol} for this. It needs about ${fmt(Number(formatEther(e.needWei)), 5)} ${network.nativeSymbol} including gas; the account has ${fmt(Number(formatEther(e.haveWei)), 5)}.`);
      } else if ((e as Error).name === 'NotAllowedError') {
        setError('The passkey prompt was closed or timed out. Nothing was sent.');
      } else {
        setError((e as Error).message);
      }
    } finally {
      setStep(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <Header title="Review send" />
      <div className="no-scrollbar flex flex-1 flex-col overflow-y-auto px-4 pb-4">
        <div className="pt-3.5 text-center">
          <div className="text-xs text-muted">You send</div>
          <Amount value={fmt(n, Math.min(decimals, 4))} unit={token} size={48} />
        </div>
        <div className="mt-3.5">
          <Rows>
            <Row label="To"><span className="font-mono text-xs">{shortAddr(to)}</span></Row>
            <Row label="Network">{network.name}</Row>
            <Row label="Network fee">{state.deployed ? 'Paid from this account' : 'Includes creating the account'}</Row>
          </Rows>
        </div>
        {!known && (
          <div className="mt-2 flex items-start gap-2 px-3 py-2 text-xs leading-snug text-muted">
            <TriangleAlert size={14} className="mt-0.5 shrink-0 text-both" />
            You haven't sent to this address before. Check the first and last characters.
          </div>
        )}
        <div className="mt-1">
          {!both && <LimitCard limit={limit} pending={limit.daily ? n : undefined} note="Within your limit. One fingerprint is enough." />}
          {both && (
            <div className="flex flex-col gap-2 rounded-card border-[1.5px] border-both px-3.5 py-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-both"><KeyRound size={14} />{state.frozen ? 'Wallet frozen' : isToken ? 'Token send' : 'At or above your per-send limit'}</div>
              <div className="text-xs leading-snug text-muted">
                {state.frozen ? 'Every send needs both keys while frozen.' : isToken ? 'Token sends always need both keys.' : `Sends of ${fmt(limit.perSend, 4)} ${limit.token} or more need both keys.`} You'll confirm with Touch ID, then with your {state.keys[1]?.label.toLowerCase() ?? 'second key'}.
              </div>
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
        {handOff ? (
          <>
            <p className="m-0 mb-2 text-center text-[11px] leading-snug text-muted">Signing continues in the side panel, which stays open while you use your second key.</p>
            <Btn variant="both" disabled={windowId === null} onClick={() => windowId !== null && w.handOffToPanel({ to, amount, token }, windowId)}>
              <KeyRound size={18} />Continue in side panel
            </Btn>
          </>
        ) : (
          <Btn variant={both ? 'both' : 'primary'} disabled={busy} onClick={go}>
            <Fingerprint size={18} />{both ? 'Sign with both keys' : 'Send with Touch ID'}
          </Btn>
        )}
        <Btn variant="ghost" size="md" className="mt-1" disabled={busy} onClick={() => (nav.canGoBack ? nav.back() : nav.reset(nav.homeRoute))}>Cancel</Btn>
      </div>
    </div>
  );
}

export function Sent({ to, amount, token, txHash, success, both }: { to: string; amount: string; token: string; txHash: string; success: boolean; both: boolean }) {
  const nav = useNav();
  const w = useWallet();
  return (
    <div className="flex h-full flex-col px-4 pb-4 pt-6">
      <span className={cx('flex h-12 w-12 items-center justify-center rounded-card', success ? 'bg-accent text-on-accent' : 'bg-both text-on-both')}>
        {success ? <Check size={24} strokeWidth={2.5} /> : <TriangleAlert size={22} />}
      </span>
      <div className="mt-4"><PageTitle>{success ? 'Sent' : 'The send failed on chain'}</PageTitle></div>
      <p className="m-0 mt-2 text-[13px] leading-normal text-muted">
        {success ? `${amount} ${token} to ${shortAddr(to)}, signed with ${both ? 'both keys' : 'Touch ID'}.` : 'Gas was used but the transfer reverted. The explorer has the details.'}
      </p>
      <a href={w.explorerTx(txHash)} target="_blank" rel="noreferrer" className="mt-4 flex h-11 items-center justify-between rounded-btn border border-line bg-card px-3.5 text-[13px] text-fg no-underline hover:bg-raised">
        <span className="font-mono text-xs">{shortAddr(txHash)}</span>
        <span className="flex items-center gap-1.5 text-muted">View on explorer <ExternalLink size={13} /></span>
      </a>
      <div className="flex-1" />
      <Btn onClick={() => nav.reset(nav.homeRoute)}>Done</Btn>
    </div>
  );
}

export function Approve({ state, request }: { state: WalletState; request: Extract<Request, { kind: 'send-both-keys' }> }) {
  const nav = useNav();
  const { limit } = state;
  const total = request.amount;
  const within = pct(limit.perSend, total);
  const over = total - limit.perSend;
  const [showRaw, setShowRaw] = useState(false);
  return (
    <div className="flex min-h-full flex-col p-5">
      <span className="flex items-center gap-1.5 self-start rounded-md bg-both px-2 py-1 text-xs font-semibold text-on-both"><KeyRound size={13} strokeWidth={2.2} />Above your per-send limit</span>
      <div className="mt-3.5"><PageTitle size="lg">This send needs both keys.</PageTitle></div>

      <div className="mt-[18px] rounded-card border border-line bg-card p-4">
        <div className="text-xs text-muted">You send</div>
        <Amount value={fmt(request.amount, 2)} unit={request.token} size={44} />
        <div className="mt-2 flex justify-between text-[13px]">
          <span className="text-muted">To</span>
          <span className="font-mono text-xs">{shortAddr(request.to)}</span>
        </div>
        <div className="mt-3.5"><Meter gap parts={[{ pct: within, className: 'bg-accent' }, { pct: 100 - within, className: 'bg-both' }]} /></div>
        <div className="mt-2 flex justify-between text-[11px] text-muted">
          <span>Limit {fmt(limit.perSend, 2)} {limit.token} per send</span>
          <span>{fmt(over, 2)} {limit.token} over</span>
        </div>
      </div>

      <ol className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
        <li className={cx('flex items-center gap-3 rounded-card px-3.5 py-3', request.firstKeySigned ? 'border border-line' : 'border-[1.5px] border-accent')}>
          <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', request.firstKeySigned ? 'bg-accent text-on-accent' : 'border-[1.5px] border-accent text-accent-text')}>
            {request.firstKeySigned ? <Check size={16} strokeWidth={2.5} /> : <Fingerprint size={16} />}
          </span>
          <div className="flex-1">
            <div className="text-sm font-medium">Touch ID</div>
            <div className="text-xs text-muted">{request.firstKeySigned ? 'Signed' : 'Sign first on this Mac'}</div>
          </div>
          {!request.firstKeySigned && <Btn size="sm" onClick={() => nav.run(() => wallet.signWithSecondKey(request))}>Sign</Btn>}
        </li>
        <li className={cx('flex flex-col gap-3.5 rounded-card p-3.5', request.firstKeySigned ? 'border-[1.5px] border-both' : 'border border-line opacity-60')}>
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-[1.5px] border-both text-both"><KeyRound size={16} /></span>
            <div className="flex-1">
              <div className="text-sm font-medium">{state.keys[1]?.label ?? 'Second key'}</div>
              <div className="text-xs text-muted">Insert it and touch the metal contact</div>
            </div>
          </div>
          <Btn variant="both" size="md" disabled={!request.firstKeySigned} onClick={() => nav.run(() => wallet.signWithSecondKey(request))}>Use {state.keys[1]?.label.toLowerCase() ?? 'second key'}</Btn>
        </li>
      </ol>

      <div className="mt-2.5 rounded-card border border-line bg-card px-3.5">
        <button type="button" aria-expanded={showRaw} onClick={() => setShowRaw((v) => !v)} className="flex h-11 w-full items-center justify-between text-[13px] text-muted">
          What you're signing <ChevronDown size={14} className={cx('transition-transform', showRaw && 'rotate-180')} />
        </button>
        {showRaw && (
          <div className="pb-3.5 font-mono text-[11px] leading-relaxed text-muted">
            execute(to: {shortAddr(request.to)}, value: {fmt(request.amount, 2)} {request.token}, data: 0x)<br />chain {network.chainId}
          </div>
        )}
      </div>

      <div className="flex-1" />
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Btn variant="outline" size="md" onClick={() => nav.run(() => wallet.signWithSecondKey({ ...request, via: 'phone' }))}>Use phone instead</Btn>
        <Btn variant="outline" size="md" onClick={() => (nav.canGoBack ? nav.back() : nav.run(() => wallet.declineRequest(request)))}>Cancel send</Btn>
      </div>
    </div>
  );
}

export function Receive({ state }: { state: WalletState }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex h-full flex-col">
      <Header title="Receive" />
      <div className="flex flex-1 flex-col px-4 pb-4 pt-3">
        <PageTitle>Your address</PageTitle>
        <p className="m-0 mt-2 text-[13px] leading-normal text-muted">Only send assets on {network.name} to this address.</p>
        <div className="mt-5 break-all rounded-card border border-line bg-card p-5 font-mono text-[15px] leading-relaxed">{state.account}</div>
        {!state.deployed && <p className="m-0 mt-3 text-xs leading-normal text-muted">This address works before the account is on chain. Funds sent here wait for it.</p>}
        <div className="flex-1" />
        <Btn
          onClick={async () => {
            if (await copyText(state.account)) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }
          }}
        >
          {copied ? <><Check size={18} />Copied</> : <><Copy size={18} />Copy address</>}
        </Btn>
      </div>
    </div>
  );
}

export function ActivityScreen({ state }: { state: WalletState }) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pt-3.5"><PageTitle>Activity</PageTitle></div>
      <main className="no-scrollbar flex-1 overflow-y-auto px-4 pt-3">
        {state.activity.length === 0 && <p className="text-sm text-muted">Nothing yet. Sends from this wallet show up here.</p>}
        <ul className="m-0 list-none p-0">
          {state.activity.map((t) => (
            <li key={t.id} className="flex items-center gap-3 border-b border-hair py-3 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t.title}</div>
                <div className="truncate text-xs text-muted">{t.detail} · {ago(t.ts)}</div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="text-sm">{t.amount}</span>
                {t.status === 'pending' ? (
                  <span className="flex items-center gap-1 text-[11px] text-muted"><Loader2 size={11} className="animate-spin" />Confirming</span>
                ) : (
                  <ApproverTag who={t.approver} />
                )}
              </div>
            </li>
          ))}
        </ul>
      </main>
      <BottomNav active="activity" />
    </div>
  );
}
