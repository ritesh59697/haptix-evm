import { useEffect, useState } from 'react';
import { ArrowRight, Check, ClipboardPaste, Copy, Cpu, ExternalLink, KeyRound, Loader2, Plus, TriangleAlert } from 'lucide-react';
import { formatEther, formatUnits, getAddress, isAddress, type Address } from 'viem';
import type { Agent, Request, WalletState } from '../data/sample';
import type { SendStep } from '../chain/account';
import type { AgentRequest as AgentRequestData } from '../chain/agents';
import { copyText, decimalsFor, fmt, fmtExact, pct, shortAddr } from '../lib';
import { useNav, type Route } from '../nav';
import { network, useWallet, wallet } from '../wallet';
import { BottomNav, Btn, Header, Meter, PageTitle, Row, Rows, cx } from '../ui';
import { stepLabel } from './Wallet';

function AgentAvatar({ size = 32 }: { size?: number }) {
  return (
    <span className="flex shrink-0 items-center justify-center rounded-card bg-agent text-on-agent" style={{ width: size, height: size }}>
      <Cpu size={size / 2} />
    </span>
  );
}

/**
 * Granting, revoking and approving an agent need both keys. Chrome closes the toolbar
 * popup during the second-key prompt, so from the popup these open in the side panel.
 */
export function usePanelRoute() {
  const w = useWallet();
  const nav = useNav();
  const inPopup = document.body.classList.contains('popup') && typeof chrome !== 'undefined' && !!chrome.sidePanel;
  const [windowId, setWindowId] = useState<number | null>(null);
  useEffect(() => {
    if (inPopup) chrome.windows.getCurrent().then((win) => setWindowId(win.id ?? null));
  }, [inPopup]);
  return (route: Route) => {
    if (!inPopup) return nav.go(route);
    if (windowId !== null) w.openInPanel(route, windowId);
  };
}

function AgentCard({ agent, decimals }: { agent: Agent; decimals: number }) {
  const nav = useNav();
  const open = usePanelRoute();
  const used = pct(agent.spent24h, agent.budget24h);
  const full = agent.spent24h >= agent.budget24h;
  const active = (agent.status ?? 'active') === 'active';
  return (
    <article className={cx('flex flex-col gap-3 rounded-card border border-line bg-card p-3.5', !active && 'opacity-60')}>
      <div className="flex items-center gap-2.5">
        <AgentAvatar />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{agent.name}</div>
          <div className="truncate text-[11px] text-muted">{agent.scope}</div>
        </div>
        <span className={cx('text-[11px]', active ? 'text-agent' : 'text-muted')}>{active ? 'Active' : agent.status === 'revoked' ? 'Revoked' : 'Ended'}</span>
      </div>
      {active && (
        <div>
          <div className="flex justify-between text-xs">
            <span className="text-muted">Last 24h</span>
            <span>{fmt(agent.spent24h, decimals)} <span className="text-muted">/ {fmt(agent.budget24h, decimals)} {agent.token}</span></span>
          </div>
          <div className="mt-1.5"><Meter parts={[{ pct: used, className: 'bg-agent' }]} /></div>
        </div>
      )}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted">
          {!active ? (agent.address ? shortAddr(agent.address) : '') : full ? `Budget used up · resets in ${agent.resetsInHours}h` : `Ends in ${agent.endsInDays} days`}
        </span>
        {active && (
          <Btn variant="outline" size="sm" onClick={() => (agent.address ? open({ name: 'revokeAgent', address: agent.address }) : nav.run(() => wallet.declineRequest(agent.id)))}>
            Revoke
          </Btn>
        )}
      </div>
    </article>
  );
}

export function Agents({ state }: { state: WalletState }) {
  const open = usePanelRoute();
  // Agents spend without the wallet: read their budgets again whenever this screen opens.
  const { refresh } = useWallet();
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);
  const active = state.agents.filter((a) => (a.status ?? 'active') === 'active');
  const ended = state.agents.filter((a) => (a.status ?? 'active') !== 'active');
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-end justify-between px-4 pt-3.5">
        <PageTitle>Agents</PageTitle>
        <Btn size="sm" className="h-9" onClick={() => open({ name: 'newBudget' })}><Plus size={14} strokeWidth={2.5} />New budget</Btn>
      </div>
      <p className="m-0 mx-4 mt-2 text-xs leading-normal text-muted">Each agent spends from its own budget, enforced by the contract. Anything more needs both of your keys.</p>
      <button type="button" onClick={() => open({ name: 'agentPaste' })}
        className="mx-4 mt-2 flex items-center gap-1.5 self-start rounded-btn text-xs font-medium text-accent-text hover:underline">
        <ClipboardPaste size={13} aria-hidden="true" />Agent stopped by its budget? Paste its request
      </button>
      <main className="no-scrollbar flex flex-1 flex-col gap-2 overflow-y-auto px-4 pb-3 pt-3.5">
        {state.agents.length === 0 && <p className="text-sm text-muted">No agents yet. Give one a budget to let it pay without asking.</p>}
        {[...active, ...ended].map((a) => <AgentCard key={a.id} agent={a} decimals={Math.min(decimalsFor(state.assets, a.token), 4)} />)}
      </main>
      <BottomNav active="agents" />
    </div>
  );
}

function Progress({ step, label }: { step: SendStep | null; label?: string | null }) {
  if (!step && !label) return null;
  return (
    <div aria-live="polite" className="mt-2 flex items-center gap-2 rounded-card border border-line bg-card px-3.5 py-2.5 text-xs">
      <Loader2 size={14} className="animate-spin text-accent-text" />{label ?? stepLabel(step)}
    </div>
  );
}
const errorText = (e: unknown) => ((e as Error).name === 'NotAllowedError' ? 'The passkey prompt was closed or timed out. Nothing changed.' : (e as Error).message);

export function NewBudget({ state }: { state: WalletState }) {
  const nav = useNav();
  const w = useWallet();
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const [perPayment, setPerPayment] = useState('');
  const [days, setDays] = useState('7');
  const [recipients, setRecipients] = useState('');
  const tokens = state.assets.filter((a) => a.address);
  const canTrade = !!network.swapRouter && tokens.length >= 2;
  const [kind, setKind] = useState<'pay' | 'trade'>('pay');
  const [tokenIn, setTokenIn] = useState(tokens[0]?.symbol ?? '');
  const [tokenOut, setTokenOut] = useState(tokens[1]?.symbol ?? '');
  const trade = kind === 'trade';
  const unit = trade ? tokenIn : network.nativeSymbol;
  const [step, setStep] = useState<SendStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = recipients.split(/[\s,]+/).filter(Boolean);
  const validRecipients = trade ? tokenIn !== tokenOut : list.length > 0 && list.every((c) => isAddress(c));
  const per = perPayment || budget;
  const valid = name.trim() && Number(budget) > 0 && Number(per) > 0 && Number(per) <= Number(budget) && Number(days) > 0 && validRecipients;
  const field = 'h-11 rounded-btn border border-line bg-card px-4 text-sm text-fg outline-none placeholder:text-faint focus:border-accent';
  const grant = async () => {
    setError(null);
    try {
      const res = await w.grantBudget(
        { name, budget, perPayment: per, days: Number(days), recipients: trade ? [] : list.map((a) => getAddress(a) as Address), swap: trade ? { tokenIn, tokenOut } : undefined },
        setStep,
      );
      nav.reset({ name: 'agents' });
      nav.go({ name: 'agentKey', agentName: name.trim(), privateKey: res.privateKey, address: res.address, txHash: res.txHash });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStep(null);
    }
  };
  return (
    <div className="flex h-full flex-col">
      <Header title="New budget" />
      <form className="no-scrollbar flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4 pt-2" onSubmit={(e) => e.preventDefault()}>
        <label className="flex flex-col gap-1.5 text-xs text-muted">Agent name
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Bill payer" />
        </label>
        {canTrade && (
          <div role="radiogroup" aria-label="What the agent does" className="grid grid-cols-2 gap-1 rounded-btn border border-line bg-card p-1">
            {([['pay', `Pays in ${network.nativeSymbol}`], ['trade', 'Trades tokens']] as const).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={kind === v} onClick={() => setKind(v)}
                className={cx('flex h-8 items-center justify-center rounded-md text-xs', kind === v ? 'bg-fg font-medium text-bg' : 'text-muted hover:text-fg')}>{label}</button>
            ))}
          </div>
        )}
        {trade && (
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1.5 text-xs text-muted">It spends
              <select className={field} value={tokenIn} onChange={(e) => setTokenIn(e.target.value)}>{tokens.map((t) => <option key={t.symbol}>{t.symbol}</option>)}</select>
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-muted">To buy
              <select className={field} value={tokenOut} onChange={(e) => setTokenOut(e.target.value)}>{tokens.map((t) => <option key={t.symbol}>{t.symbol}</option>)}</select>
            </label>
          </div>
        )}
        {trade && tokenIn === tokenOut && <span className="-mt-1 text-[11px] text-both">Pick two different tokens.</span>}
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1.5 text-xs text-muted">Budget per 24h ({unit})
            <input className={field} inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.0005" />
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted">{trade ? 'Most per trade' : 'Most per payment'}
            <input className={field} inputMode="decimal" value={perPayment} onChange={(e) => setPerPayment(e.target.value.replace(/[^0-9.]/g, ''))} placeholder={budget || 'same as budget'} />
          </label>
        </div>
        {Number(per) > Number(budget) && <span className="-mt-1 text-[11px] text-both">{trade ? 'A trade' : 'A payment'} can't be more than the daily budget.</span>}
        {trade ? (
          <p className="m-0 text-[11px] leading-normal text-muted">
            It can only swap through {shortAddr(network.swapRouter ?? '')}, and what it buys always comes back to your account. Granting also approves that router for this budget; revoking takes the approval back.
          </p>
        ) : <label className="flex flex-col gap-1.5 text-xs text-muted">Addresses it may pay
          <textarea className="min-h-[72px] rounded-btn border border-line bg-card px-4 py-3 font-mono text-xs text-fg outline-none placeholder:text-faint focus:border-accent"
            value={recipients} onChange={(e) => setRecipients(e.target.value)} placeholder="0x… one per line" spellCheck={false} />
          {recipients && !validRecipients && <span className="text-[11px] text-both">Each line must be a full address.</span>}
        </label>}
        <label className="flex flex-col gap-1.5 text-xs text-muted">Ends after (days)
          <input className={field} inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ''))} />
        </label>
        <p className="m-0 text-[11px] leading-normal text-muted">
          The agent gets its own key, made on this device and shown once. Granting and revoking change your account's rules, so each needs both keys: Touch ID, then your {state.keys[1]?.label.toLowerCase() ?? 'second key'}.
        </p>
        {error && <div role="alert" className="rounded-card border border-both px-3.5 py-2.5 text-xs leading-snug text-both">{error}</div>}
        <Progress step={step} />
        <div className="flex-1" />
        <Btn variant="both" disabled={!valid || step !== null} onClick={grant}><KeyRound size={18} />Grant with both keys</Btn>
      </form>
    </div>
  );
}

/** Shown once, right after a grant. The key exists only in this screen's memory. */
export function AgentKeyShown({ agentName: name, privateKey, address, txHash }: { agentName: string; privateKey: string; address: string; txHash: string }) {
  const nav = useNav();
  const w = useWallet();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-h-full flex-col p-5">
      <span className="flex h-12 w-12 items-center justify-center rounded-card bg-agent text-on-agent"><Check size={24} strokeWidth={2.5} /></span>
      <div className="mt-4"><PageTitle>{name} has a budget</PageTitle></div>
      <p className="m-0 mt-2 text-[13px] leading-normal text-muted">Give this key to your agent. Haptix doesn't keep it and won't show it again. It can only spend what you allowed.</p>
      <div className="mt-4 break-all rounded-card border-[1.5px] border-agent bg-card p-3.5 font-mono text-xs leading-relaxed">{privateKey}</div>
      <Btn variant="outline" size="md" className="mt-2" onClick={async () => { if (await copyText(privateKey)) setCopied(true); }}>
        {copied ? <><Check size={16} />Copied</> : <><Copy size={16} />Copy agent key</>}
      </Btn>
      <div className="mt-3">
        <Rows>
          <Row label="Agent address"><span className="font-mono text-xs">{shortAddr(address)}</span></Row>
          <Row label="Your account"><span className="font-mono text-xs">{w.account ? shortAddr(w.account.address) : ''}</span></Row>
        </Rows>
      </div>
      <a href={w.explorerTx(txHash)} target="_blank" rel="noreferrer" className="mt-2 flex h-11 items-center justify-between rounded-btn border border-line bg-card px-3.5 text-[13px] text-fg no-underline hover:bg-raised">
        <span className="font-mono text-xs">{shortAddr(txHash)}</span>
        <span className="flex items-center gap-1.5 text-muted">Grant on explorer <ExternalLink size={13} /></span>
      </a>
      <div className="flex-1" />
      <Btn className="mt-4" onClick={() => nav.reset({ name: 'agents' })}>I saved it</Btn>
    </div>
  );
}

export function RevokeAgent({ state, address }: { state: WalletState; address: string }) {
  const nav = useNav();
  const w = useWallet();
  const agent = state.agents.find((a) => a.address === address);
  const [step, setStep] = useState<SendStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!agent) return <p className="p-5 text-sm text-muted">This agent isn't in this wallet.</p>;
  const revoke = async () => {
    setError(null);
    try {
      await w.revokeAgent(address as Address, setStep);
      setDone(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStep(null);
    }
  };
  return (
    <div className="flex min-h-full flex-col p-5">
      <div className="flex items-center gap-2.5"><AgentAvatar size={36} /><div className="text-sm font-semibold">{agent.name}</div></div>
      <div className="mt-[18px]"><PageTitle size="lg">{done ? `${agent.name} can't spend any more.` : `Revoke ${agent.name}?`}</PageTitle></div>
      <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">
        {done ? 'The contract now refuses its key.' : 'Its key stops working on chain right away. Anything it already paid stays paid.'}
      </p>
      {error && <div role="alert" className="mt-3 rounded-card border border-both px-3.5 py-2.5 text-xs leading-snug text-both">{error}</div>}
      <Progress step={step} />
      <div className="flex-1" />
      {done ? (
        <Btn onClick={() => nav.reset({ name: 'agents' })}>Done</Btn>
      ) : (
        <>
          <Btn variant="both" disabled={step !== null} onClick={revoke}><KeyRound size={18} />Revoke with both keys</Btn>
          <Btn variant="ghost" size="md" className="mt-1" disabled={step !== null} onClick={() => (nav.canGoBack ? nav.back() : nav.reset({ name: 'agents' }))}>Cancel</Btn>
        </>
      )}
    </div>
  );
}

/** An agent the contract stopped hands its request over as text; the owner pastes it here. */
export function AgentPaste() {
  const nav = useNav();
  const w = useWallet();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    setError(null);
    setBusy(true);
    try {
      nav.go({ name: 'agentApprove', request: await w.parseAgentRequest(text) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-full flex-col">
      <Header title="Agent request" />
      <div className="flex flex-1 flex-col px-4 pb-4 pt-2">
        <p className="m-0 text-[13px] leading-normal text-muted">When the contract stops an agent, the agent prints a request. Paste it here to see what it wants.</p>
        <textarea aria-label="Agent request" className="mt-3 min-h-[160px] rounded-btn border border-line bg-card px-3.5 py-3 font-mono text-[11px] text-fg outline-none placeholder:text-faint focus:border-accent"
          value={text} onChange={(e) => setText(e.target.value)} placeholder="eyJ2Ijox…" spellCheck={false} />
        {error && <div role="alert" className="mt-2 rounded-card border border-both px-3.5 py-2.5 text-xs leading-snug text-both">{error}</div>}
        <div className="flex-1" />
        <Btn disabled={!text.trim() || busy} onClick={check}>{busy ? <Loader2 size={18} className="animate-spin" /> : null}Check request</Btn>
      </div>
    </div>
  );
}

export function AgentApprove({ state, request }: { state: WalletState; request: AgentRequestData }) {
  const nav = useNav();
  const w = useWallet();
  const agent = state.agents.find((a) => a.address && getAddress(a.address) === getAddress(request.payload.agent));
  const [signing, setSigning] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ txHash: string; success: boolean } | null>(null);
  const s = request.swap;
  const amount = s ? Number(formatUnits(s.amountIn, s.tokenIn.decimals)) : Number(formatEther(request.valueWei));
  const symbol = s ? s.tokenIn.symbol : network.nativeSymbol;
  // The same display decimals as the Agents list, so one budget reads the same on both screens.
  const decimals = Math.min(decimalsFor(state.assets, symbol), 4);
  const amountText = s ? fmtExact(s.amountIn, s.tokenIn.decimals, decimals) : fmtExact(request.valueWei, 18, decimals);
  const approve = async () => {
    setError(null);
    try {
      setDone(await w.approveAgentRequest(request, setSigning));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSigning(null);
    }
  };
  if (!agent) return <p className="p-5 text-sm text-muted">This agent isn't in this wallet.</p>;
  if (done) {
    return (
      <div className="flex min-h-full flex-col p-5">
        <span className={cx('flex h-12 w-12 items-center justify-center rounded-card', done.success ? 'bg-both text-on-both' : 'bg-both text-on-both')}>
          {done.success ? <Check size={24} strokeWidth={2.5} /> : <TriangleAlert size={22} />}
        </span>
        <div className="mt-4"><PageTitle>{done.success ? 'Approved and paid' : 'It reverted on chain'}</PageTitle></div>
        <p className="m-0 mt-2 text-[13px] leading-normal text-muted">{done.success ? `${agent.name} ${s ? 'swapped' : 'paid'} ${amountText} ${symbol} with your approval. Its budget is unchanged.` : 'Gas was used but the payment failed. The explorer has the details.'}</p>
        <a href={w.explorerTx(done.txHash)} target="_blank" rel="noreferrer" className="mt-4 flex h-11 items-center justify-between rounded-btn border border-line bg-card px-3.5 text-[13px] text-fg no-underline hover:bg-raised">
          <span className="font-mono text-xs">{shortAddr(done.txHash)}</span>
          <span className="flex items-center gap-1.5 text-muted">View on explorer <ExternalLink size={13} /></span>
        </a>
        <div className="flex-1" />
        <Btn onClick={() => nav.reset({ name: 'agents' })}>Done</Btn>
      </div>
    );
  }
  const total = agent.spent24h + amount;
  const usedPct = pct(agent.spent24h, Math.max(total, agent.budget24h));
  const leftPct = pct(Math.max(0, agent.budget24h - agent.spent24h), Math.max(total, agent.budget24h));
  return (
    <div className="flex min-h-full flex-col p-5">
      <div className="flex items-center gap-2.5">
        <AgentAvatar size={36} />
        <div>
          <div className="text-sm font-semibold">{agent.name}</div>
          <div className="text-xs text-muted">Agent request</div>
        </div>
      </div>
      <div className="mt-[18px]"><PageTitle size="lg">{agent.name} wants to go past its limits.</PageTitle></div>
      <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">The contract stopped it. This one {s ? 'trade' : 'payment'} goes ahead only if you sign it with both keys.</p>

      <div className="mt-[18px] flex flex-col gap-3.5 rounded-card border border-line bg-card p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs text-muted">{s ? 'Swap' : 'Pay'}</div>
            <div className="font-mono text-[22px] font-medium leading-tight">{amountText} {symbol}</div>
          </div>
          <ArrowRight size={18} className="text-muted" />
          <div className="text-right">
            <div className="text-xs text-muted">{s ? 'For at least' : 'To'}</div>
            <div className="font-mono text-sm">{s ? `${fmtExact(s.amountOutMinimum, s.tokenOut.decimals, Math.min(decimalsFor(state.assets, s.tokenOut.symbol), 4))} ${s.tokenOut.symbol}` : shortAddr(request.to)}</div>
          </div>
        </div>
        <div>
          <Meter gap parts={[{ pct: usedPct, className: 'bg-agent' }, { pct: leftPct, className: 'bg-faint' }, { pct: Math.max(0, 100 - usedPct - leftPct), className: 'bg-both' }]} />
          <div className="mt-2 flex justify-between text-[11px] text-muted">
            <span>Budget {fmt(agent.budget24h, decimals)} · {fmt(agent.spent24h, decimals)} used</span>
            <span>{total > agent.budget24h ? `${fmt(total - agent.budget24h, decimals)} over` : `over its limit per ${s ? 'trade' : 'payment'}`}</span>
          </div>
        </div>
        {s && <div className="flex justify-between text-xs"><span className="text-muted">Through</span><span className="font-mono">{shortAddr(request.to)}</span></div>}
        {s && s.recipient.toLowerCase() !== (w.account?.address ?? '').toLowerCase() && (
          <div role="alert" className="text-xs leading-snug text-both">What it buys would go to {shortAddr(s.recipient)}, not your account. Don't approve this unless you meant it.</div>
        )}
      </div>

      {error && <div role="alert" className="mt-2 rounded-card border border-both px-3.5 py-2.5 text-xs leading-snug text-both">{error}</div>}
      <Progress step={null} label={signing === 2 ? 'Waiting for the chain…' : signing !== null ? `${w.account?.keys[signing]?.label ?? 'Key'}: confirm (${signing + 1} of 2)` : null} />
      <div className="flex-1" />
      <Btn variant="both" className="mt-4" disabled={signing !== null} onClick={approve}><KeyRound size={18} />Approve with both keys</Btn>
      <Btn variant="outline" size="md" className="mt-2" disabled={signing !== null} onClick={() => nav.reset({ name: 'agents' })}>Ignore</Btn>
    </div>
  );
}

/** Sample-mode design screen for the side panel's request list. */
export function AgentRequest({ state, request }: { state: WalletState; request: Extract<Request, { kind: 'agent-over-budget' }> }) {
  const nav = useNav();
  const agent = state.agents.find((a) => a.id === request.agentId);
  if (!agent) return <p className="p-5 text-sm text-muted">This agent no longer exists.</p>;
  const decimals = Math.min(decimalsFor(state.assets, agent.token), 3);
  return (
    <div className="flex min-h-full flex-col p-5">
      <div className="flex items-center gap-2.5"><AgentAvatar size={36} /><div className="text-sm font-semibold">{agent.name}</div></div>
      <div className="mt-[18px]"><PageTitle size="lg">{agent.name} wants to go over its budget.</PageTitle></div>
      <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">
        Swap {fmt(request.give, decimals)} {request.giveToken} for {request.getToken} on {shortAddr(request.contract)}. Sample data.
      </p>
      <div className="flex-1" />
      <Btn variant="both" onClick={() => nav.run(() => wallet.declineRequest(request))}><KeyRound size={18} />Approve with both keys</Btn>
      <Btn variant="outline" size="md" className="mt-2" onClick={() => nav.run(() => wallet.declineRequest(request))}>Decline</Btn>
    </div>
  );
}
