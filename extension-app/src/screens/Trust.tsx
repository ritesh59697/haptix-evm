import { useState } from 'react';
import { getAppearance, setAppearance, type Appearance } from '../theme';
import { ChevronDown, ChevronRight, Cpu, Fingerprint, Globe, KeyRound, ShieldCheck, Smartphone, Snowflake, TriangleAlert } from 'lucide-react';
import type { KeyInfo, Request, WalletState } from '../data/sample';
import { fmt, shortAddr } from '../lib';
import { useNav } from '../nav';
import { network, useWallet, wallet } from '../wallet';
import { BottomNav, Btn, PageTitle, Row, Rows, cx } from '../ui';
import { ConnectedSites, routeFor } from './Sites';
import { SecurityBanners } from './Guard';
import { usePanelRoute } from './Agents';

export function DappRequest({ request }: { request: Extract<Request, { kind: 'dapp-approval' }> }) {
  const nav = useNav();
  const [cap, setCap] = useState(fmt(request.balance, 2));
  const [showRaw, setShowRaw] = useState(false);
  const n = Number(cap);
  return (
    <div className="flex min-h-full flex-col p-5">
      <div className="flex h-11 items-center gap-2.5 rounded-btn border border-line bg-card px-3.5">
        <Globe size={16} className="text-muted" />
        <span className="flex-1 truncate font-mono text-[13px]">{request.site}</span>
        <span className="text-[11px] text-muted">Address checked</span>
      </div>
      <div className="mt-5"><PageTitle size="lg">Let this site spend your {request.token}?</PageTitle></div>
      <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">This is a token approval. Nothing moves now, but the contract below can take {request.token} later without asking.</p>

      <div className="mt-[18px]">
        <Rows>
          <Row label="Token">{request.token}</Row>
          <Row label="Spender"><span className="font-mono text-xs">{shortAddr(request.spender)}</span></Row>
          <Row label="Asked for">
            <span className={cx('font-semibold', request.requested === 'unlimited' && 'text-both')}>
              {request.requested === 'unlimited' ? 'Unlimited' : `${fmt(request.requested, 2)} ${request.token}`}
            </span>
          </Row>
        </Rows>
      </div>

      <div className="mt-3 flex flex-col gap-1.5">
        <label htmlFor="cap" className="text-xs text-muted">Allow at most</label>
        <div className="flex h-12 items-center rounded-btn border-[1.5px] border-accent bg-card px-4">
          <input id="cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ''))}
            className="min-w-0 flex-1 border-0 bg-transparent text-[15px] text-fg outline-none" />
          <span className="text-[13px] text-muted">{request.token}</span>
        </div>
        <span className="text-[11px] text-muted">Your balance is {fmt(request.balance, 2)} {request.token}</span>
      </div>

      <div className="mt-3 rounded-card border border-line bg-card px-3.5">
        <button type="button" aria-expanded={showRaw} onClick={() => setShowRaw((v) => !v)} className="flex h-11 w-full items-center justify-between text-[13px] text-muted">
          Raw data <ChevronDown size={14} className={cx('transition-transform', showRaw && 'rotate-180')} />
        </button>
        {showRaw && <div className="break-all pb-3.5 font-mono text-[11px] leading-relaxed text-muted">approve(spender: {shortAddr(request.spender)}, amount: {cap || '0'} {request.token})</div>}
      </div>

      <div className="flex-1" />
      <div className="mt-4 grid grid-cols-2 gap-2">
        <Btn variant="outline" onClick={() => nav.run(() => wallet.declineRequest(request))}>Reject</Btn>
        <Btn disabled={!(n > 0)} onClick={() => nav.run(() => wallet.approveDapp({ request, cap: n }))}>
          <Fingerprint size={18} />Allow {n > 0 ? fmt(n, n % 1 ? 2 : 0) : ''} {request.token}
        </Btn>
      </div>
    </div>
  );
}

/** Host plus the last 4 characters of any API key, so you can tell which URL is saved without showing the key. */
function describeUrl(url: string) {
  try {
    const u = new URL(url);
    const key = u.searchParams.get('apikey');
    return `${u.host}${key ? ` · key …${key.slice(-4)}` : ''}`;
  } catch {
    return 'not a valid URL';
  }
}

function BundlerField() {
  const w = useWallet();
  const nav = useNav();
  const saved = w.customBundler ? w.bundlerUrl : '';
  const [value, setValue] = useState(saved);
  const dirty = value.trim() !== saved;
  return (
    <div className="mt-4 flex flex-col gap-1.5">
      <label htmlFor="bundler" className="text-xs text-muted">Bundler URL</label>
      <div className="flex gap-1.5">
        <input
          id="bundler"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`https://…/${network.chainId}/rpc?apikey=…`}
          className="h-10 min-w-0 flex-1 rounded-btn border border-line bg-card px-3 font-mono text-[11px] text-fg outline-none placeholder:text-faint focus:border-accent"
        />
        <Btn size="sm" className="h-10" disabled={!dirty} onClick={() => nav.run(() => w.setBundlerUrl(value), value.trim() ? 'Bundler URL saved' : 'Back to the default bundler')}>Save</Btn>
      </div>
      <span className="text-[11px] leading-snug text-muted">
        {w.customBundler
          ? `Using yours: ${describeUrl(w.bundlerUrl)}. `
          : network.defaultBundlerUrl
            ? `Using ${describeUrl(network.defaultBundlerUrl)}: no key needed, but rate-limited. Paste your own URL to use it instead. `
            : 'Not set. Sends need an ERC-4337 bundler for this network. '}
        Yours stays in this browser, and Save checks it first.
      </span>
      {w.customBundler && network.defaultBundlerUrl && (
        <button type="button" className="self-start text-[11px] text-accent-text underline-offset-2 hover:underline"
          onClick={() => { setValue(''); nav.run(() => w.setBundlerUrl(''), 'Back to the default bundler'); }}>
          Use the default instead
        </button>
      )}
    </div>
  );
}

function AppearancePicker() {
  const [value, setValue] = useState<Appearance>(getAppearance);
  const options: { v: Appearance; label: string }[] = [
    { v: 'system', label: 'System' },
    { v: 'light', label: 'Light' },
    { v: 'dark', label: 'Dark' },
  ];
  return (
    <fieldset className="m-0 mt-4 border-0 p-0">
      <legend className="mb-1.5 p-0 text-xs text-muted">Appearance</legend>
      <div className="grid grid-cols-3 gap-1 rounded-btn border border-line bg-card p-1">
        {options.map((o) => (
          <label key={o.v} className={cx('flex h-8 cursor-pointer items-center justify-center rounded-md text-xs', value === o.v ? 'bg-fg font-medium text-bg' : 'text-muted hover:text-fg')}>
            <input type="radio" name="appearance" className="sr-only" checked={value === o.v} onChange={() => { setValue(o.v); setAppearance(o.v); }} />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const keyIcon = (k: KeyInfo) => (k.kind === 'touchid' ? Fingerprint : k.kind === 'phone' ? Smartphone : KeyRound);

export function Security({ state }: { state: WalletState }) {
  const nav = useNav();
  const open = usePanelRoute();
  // Two keys are only independent if at most one of them syncs through a password manager.
  const independent = state.keys.length >= 2 && state.keys.filter((k) => k.synced).length <= 1;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-end justify-between px-4 pt-3.5">
        <PageTitle>Security</PageTitle>
        {state.frozen
          ? <Btn variant="both" size="sm" className="h-9" onClick={() => open({ name: 'unfreeze' })}><Snowflake size={14} />Unfreeze</Btn>
          : <Btn variant="outline" size="sm" className="h-9" onClick={() => nav.go({ name: 'freeze' })}><Snowflake size={14} />Freeze wallet</Btn>}
      </div>
      <SecurityBanners state={state} />
      <main className="no-scrollbar flex-1 overflow-y-auto px-4 pb-3">
        <div className={cx('mt-3.5 flex items-center gap-2.5 rounded-card px-3.5 py-3 text-[13px] font-medium', independent ? 'border border-line bg-card text-fg' : 'border-[1.5px] border-both text-both')}>
          {independent ? <ShieldCheck size={16} strokeWidth={2.2} className="text-accent-text" /> : <TriangleAlert size={16} />}
          {independent ? 'Your two keys live in different places' : 'Both keys sync through a password manager'}
        </div>

        <div className="mt-2 divide-y divide-hair rounded-card border border-line bg-card px-3.5">
          {state.keys.map((k, i) => {
            const Icon = keyIcon(k);
            return (
              <div key={k.label} className="flex h-[52px] items-center gap-3">
                <Icon size={18} className={i === 0 ? 'text-accent-text' : 'text-both'} />
                <div className="flex-1">
                  <div className="text-[13px] font-medium">{k.label}</div>
                  <div className="text-[11px] text-muted">{k.synced ? 'Synced by your password manager' : 'Stays on the device'}</div>
                </div>
                <span className="text-[11px] text-muted">Key {i + 1}</span>
              </div>
            );
          })}
        </div>

        <div className="mt-2 divide-y divide-hair rounded-card border border-line bg-card px-3.5">
          {[
            { title: 'Per-send limit', sub: 'One fingerprint below this', value: `${fmt(state.limit.perSend, 4)} ${state.limit.token}`, action: () => nav.run(() => wallet.setDailyLimit()) },
            { title: 'Guardian', sub: 'Can start a recovery; you can cancel it', value: state.guardian ? shortAddr(state.guardian) : 'Not set', mono: !!state.guardian, action: () => open({ name: 'guardian' }) },
            { title: 'Recovery wait', sub: 'Time you have to cancel a recovery', value: state.recoveryWaitHours ? `${state.recoveryWaitHours} hours` : 'Not set', action: () => open({ name: 'guardian' }) },
          ].map((r) => (
            <button key={r.title} type="button" onClick={r.action} className="flex h-[52px] w-full items-center gap-3 text-left">
              <div className="flex-1">
                <div className="text-[13px] font-medium">{r.title}</div>
                <div className="text-[11px] text-muted">{r.sub}</div>
              </div>
              <span className={cx('text-[13px]', r.mono && 'font-mono text-xs')}>{r.value}</span>
              <ChevronRight size={14} className="text-muted" />
            </button>
          ))}
        </div>
        <p className="m-0 mt-2.5 text-[11px] leading-normal text-muted">Changing any of these needs both keys.</p>
        <BundlerField />
        <ConnectedSites />
        <AppearancePicker />
      </main>
      <BottomNav active="security" />
    </div>
  );
}

/** Side panel home: what's waiting for you. */
export function Requests({ state }: { state: WalletState }) {
  const nav = useNav();
  const w = useWallet();
  const describe = (r: Request) => {
    if (r.kind === 'send-both-keys') return { Icon: KeyRound, tone: 'text-both', title: `Send ${fmt(r.amount, 2)} ${r.token}`, sub: 'Needs your second key' };
    if (r.kind === 'agent-over-budget') {
      const a = state.agents.find((x) => x.id === r.agentId);
      return { Icon: Cpu, tone: 'text-agent', title: `${a?.name ?? 'Agent'} wants more`, sub: `${fmt(r.give, 3)} ${r.giveToken} over its budget` };
    }
    return { Icon: Globe, tone: 'text-accent-text', title: `${r.site}`, sub: `Wants to spend your ${r.token}` };
  };
  const open = (r: Request) => {
    if (r.kind === 'send-both-keys') nav.go({ name: 'approve', request: r });
    else if (r.kind === 'agent-over-budget') nav.go({ name: 'agentRequest', request: r });
    else nav.go({ name: 'dappRequest', request: r });
  };
  return (
    <div className="flex min-h-full flex-col p-5">
      <PageTitle size="lg">Waiting for you</PageTitle>
      <p className="m-0 mt-2 text-[13px] text-muted">Requests from sites and agents open here, next to the page that asked.</p>
      <ul className="m-0 mt-5 flex list-none flex-col gap-2 p-0">
        {w.dappRequests.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => nav.go(routeFor(r))} className="flex w-full items-center gap-3 rounded-card border border-line bg-card px-3.5 py-3 text-left hover:bg-raised">
              <Globe size={18} className={r.kind === 'dapp-tx' ? 'text-both' : 'text-accent-text'} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{new URL(r.origin).host}</span>
                <span className="block truncate text-xs text-muted">{r.kind === 'dapp-connect' ? 'Wants to connect' : r.kind === 'dapp-sign' ? 'Wants you to sign a message' : 'Wants you to approve a transaction'}</span>
              </span>
              <ChevronRight size={14} className="text-muted" />
            </button>
          </li>
        ))}
        {state.requests.map((r) => {
          const d = describe(r);
          return (
            <li key={r.id}>
              <button type="button" onClick={() => open(r)} className="flex w-full items-center gap-3 rounded-card border border-line bg-card px-3.5 py-3 text-left hover:bg-raised">
                <d.Icon size={18} className={d.tone} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{d.title}</span>
                  <span className="block truncate text-xs text-muted">{d.sub}</span>
                </span>
                <ChevronRight size={14} className="text-muted" />
              </button>
            </li>
          );
        })}
      </ul>
      {state.requests.length + w.dappRequests.length === 0 && <p className="mt-6 text-sm text-muted">Nothing waiting.</p>}
    </div>
  );
}
