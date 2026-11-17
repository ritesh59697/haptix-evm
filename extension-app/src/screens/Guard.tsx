// Freeze, guardian, recovery alerts, and restoring an account on a new device.
import { useState } from 'react';
import { Check, Copy, Fingerprint, KeyRound, Loader2, ShieldAlert, Smartphone, Snowflake, TriangleAlert, Usb } from 'lucide-react';
import { isAddress, type Address } from 'viem';
import type { WalletState } from '../data/sample';
import type { SendStep } from '../chain/account';
import { copyText, shortAddr } from '../lib';
import { useNav } from '../nav';
import { network, useWallet, type RestoreStatus } from '../wallet';
import { Btn, Header, PageTitle, Row, Rows, cx } from '../ui';
import { stepLabel } from './Wallet';
import { usePanelRoute } from './Agents';

const errorText = (e: unknown) => ((e as Error).name === 'NotAllowedError' ? 'The passkey prompt was closed or timed out. Nothing changed.' : (e as Error).message);

/** "in 23 h 10 min", "now". */
function until(ts: number) {
  const s = ts - Math.floor(Date.now() / 1000);
  if (s <= 0) return 'now';
  const minutes = Math.ceil(s / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `in ${h} h ${m} min` : `in ${m} min`;
}

/** Run one owner action with progress and errors shown inline. */
function useAction() {
  const [step, setStep] = useState<SendStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const run = async (fn: (onStep: (s: SendStep) => void) => Promise<void>) => {
    setError(null);
    try {
      await fn(setStep);
      setDone(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStep(null);
    }
  };
  const status = (
    <>
      {error && <div role="alert" className="mt-3 rounded-card border border-both px-3.5 py-2.5 text-xs leading-snug text-both">{error}</div>}
      {step && (
        <div aria-live="polite" className="mt-3 flex items-center gap-2 rounded-card border border-line bg-card px-3.5 py-2.5 text-xs">
          <Loader2 size={14} className="animate-spin text-accent-text" />{stepLabel(step)}
        </div>
      )}
    </>
  );
  return { busy: step !== null, done, run, status };
}

// --- Banners on Home and Security -------------------------------------------

export function SecurityBanners({ state }: { state: WalletState }) {
  const nav = useNav();
  const open = usePanelRoute();
  return (
    <>
      {state.pendingRecovery && !state.pendingRecovery.ours && (
        <button type="button" onClick={() => nav.go({ name: 'recovery' })} className="mx-4 mt-3 flex w-[calc(100%-2rem)] items-start gap-2.5 rounded-card border-[1.5px] border-both px-3.5 py-3 text-left">
          <ShieldAlert size={18} className="mt-0.5 shrink-0 text-both" />
          <span className="text-xs leading-snug">
            <span className="block text-[13px] font-semibold text-both">Your guardian started a recovery</span>
            New keys take over {until(state.pendingRecovery.executeAfter)}. If this wasn't you, cancel it now.
          </span>
        </button>
      )}
      {state.frozen && (
        <button type="button" onClick={() => open({ name: 'unfreeze' })} className="mx-4 mt-3 flex w-[calc(100%-2rem)] items-start gap-2.5 rounded-card border border-line bg-card px-3.5 py-3 text-left">
          <Snowflake size={18} className="mt-0.5 shrink-0 text-accent-text" />
          <span className="text-xs leading-snug text-muted">
            <span className="block text-[13px] font-semibold text-fg">Wallet frozen</span>
            Every send needs both keys and agents can't spend. Tap to unfreeze.
          </span>
        </button>
      )}
    </>
  );
}

// --- Freeze / unfreeze ------------------------------------------------------

export function Freeze() {
  const nav = useNav();
  const w = useWallet();
  const a = useAction();
  return (
    <div className="flex h-full flex-col">
      <Header title="Freeze wallet" />
      <div className="flex flex-1 flex-col px-5 pb-5 pt-2">
        <PageTitle size="lg">{a.done ? 'Frozen.' : 'Freeze your wallet?'}</PageTitle>
        <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">
          {a.done
            ? 'Nothing leaves without both keys now.'
            : 'Use this if a key or device might be in the wrong hands. Freezing takes one fingerprint. Unfreezing takes both keys.'}
        </p>
        <ul className="m-0 mt-4 flex list-none flex-col gap-2 p-0 text-[13px]">
          {['Every send needs both keys', 'Agents can’t spend', 'A recovery can’t complete'].map((t) => (
            <li key={t} className="flex items-center gap-2.5"><Snowflake size={14} className="text-accent-text" />{t}</li>
          ))}
        </ul>
        {a.status}
        <div className="flex-1" />
        {a.done ? (
          <Btn onClick={() => nav.reset(nav.homeRoute)}>Done</Btn>
        ) : (
          <Btn disabled={a.busy} onClick={() => a.run(w.freeze)}><Fingerprint size={18} />Freeze with Touch ID</Btn>
        )}
      </div>
    </div>
  );
}

export function Unfreeze({ state }: { state: WalletState }) {
  const nav = useNav();
  const w = useWallet();
  const a = useAction();
  if (!state.frozen && !a.done) return <p className="p-5 text-sm text-muted">The wallet isn't frozen.</p>;
  return (
    <div className="flex min-h-full flex-col p-5">
      <PageTitle size="lg">{a.done ? 'Unfrozen.' : 'Unfreeze your wallet?'}</PageTitle>
      <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">
        {a.done ? 'Your normal limits apply again.' : `Your per-send limit and agent budgets apply again. This needs Touch ID, then your ${state.keys[1]?.label.toLowerCase() ?? 'second key'}.`}
      </p>
      {a.status}
      <div className="flex-1" />
      {a.done ? <Btn onClick={() => nav.reset(nav.homeRoute)}>Done</Btn> : <Btn variant="both" disabled={a.busy} onClick={() => a.run(w.unfreeze)}><KeyRound size={18} />Unfreeze with both keys</Btn>}
    </div>
  );
}

// --- Guardian ---------------------------------------------------------------

export function Guardian({ state }: { state: WalletState }) {
  const nav = useNav();
  const w = useWallet();
  const a = useAction();
  const [addr, setAddr] = useState(state.guardian ?? '');
  const [hours, setHours] = useState(String(state.recoveryWaitHours ?? state.minRecoveryWaitHours * 2));
  const h = Number(hours);
  const validAddr = isAddress(addr.trim());
  const valid = validAddr && h >= state.minRecoveryWaitHours;
  const field = 'h-11 rounded-btn border border-line bg-card px-4 text-sm text-fg outline-none placeholder:text-faint focus:border-accent';
  if (a.done) {
    return (
      <div className="flex min-h-full flex-col p-5">
        <span className="flex h-12 w-12 items-center justify-center rounded-card bg-accent text-on-accent"><Check size={24} strokeWidth={2.5} /></span>
        <div className="mt-4"><PageTitle>Saved</PageTitle></div>
        <p className="m-0 mt-2 text-[13px] leading-normal text-muted">The new guardian and wait are on chain.</p>
        <div className="flex-1" />
        <Btn onClick={() => nav.reset({ name: 'security' })}>Done</Btn>
      </div>
    );
  }
  return (
    <div className="flex min-h-full flex-col p-5">
      <PageTitle size="lg">Guardian</PageTitle>
      <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">
        If you lose both keys, your guardian can start a recovery that installs new ones. You get the whole wait to cancel it with one fingerprint, and freezing stops it too. A guardian can't move funds.
      </p>
      <label className="mt-4 flex flex-col gap-1.5 text-xs text-muted">Guardian address
        <input className={cx(field, 'font-mono text-xs')} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x… a wallet you or someone you trust controls" spellCheck={false} />
        {addr && !validAddr && <span className="text-[11px] text-both">That isn't a full address.</span>}
      </label>
      <label className="mt-3 flex flex-col gap-1.5 text-xs text-muted">Recovery wait (hours)
        <input className={field} inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value.replace(/[^0-9]/g, ''))} />
        <span className={cx('text-[11px]', h < state.minRecoveryWaitHours ? 'text-both' : 'text-muted')}>At least {state.minRecoveryWaitHours} hours; the contract refuses less. Longer gives you more time to notice.</span>
      </label>
      {state.pendingRecovery && <p className="m-0 mt-3 text-[11px] text-both">Saving also cancels the recovery in progress.</p>}
      {a.status}
      <div className="flex-1" />
      <Btn variant="both" className="mt-4" disabled={!valid || a.busy} onClick={() => a.run((s) => w.setGuardian(addr.trim() as Address, h, s))}>
        <KeyRound size={18} />Save with both keys
      </Btn>
      {state.guardian && (
        <Btn variant="ghost" size="md" className="mt-1" disabled={a.busy} onClick={() => a.run((s) => w.setGuardian(null, 0, s))}>Remove guardian</Btn>
      )}
    </div>
  );
}

// --- A recovery someone started -------------------------------------------------

export function RecoveryAlert({ state }: { state: WalletState }) {
  const nav = useNav();
  const w = useWallet();
  const cancel = useAction();
  const freeze = useAction();
  const p = state.pendingRecovery;
  if (!p && !cancel.done) return <p className="p-5 text-sm text-muted">No recovery is in progress.</p>;
  return (
    <div className="flex h-full flex-col">
      <Header title="Recovery in progress" />
      <div className="flex flex-1 flex-col px-5 pb-5 pt-2">
        <PageTitle size="lg">{cancel.done ? 'Recovery cancelled.' : 'Someone started a recovery of this wallet.'}</PageTitle>
        {!cancel.done && p && (
          <>
            <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">
              Your guardian ({state.guardian ? shortAddr(state.guardian) : 'unknown'}) asked to replace your keys. Unless you cancel, the new keys take over {until(p.executeAfter)} and these keys stop working.
            </p>
            <div className="mt-4"><Rows>
              <Row label="Takes effect">{new Date(p.executeAfter * 1000).toLocaleString()}</Row>
              <Row label="New keys">Not this device's</Row>
            </Rows></div>
            <p className="m-0 mt-3 text-[11px] leading-normal text-muted">If you lost your keys and asked for this, leave it. If not, cancel it, and think about changing your guardian.</p>
          </>
        )}
        {cancel.status}
        {freeze.status}
        <div className="flex-1" />
        {cancel.done ? (
          <Btn onClick={() => nav.reset(nav.homeRoute)}>Done</Btn>
        ) : (
          <>
            <Btn variant="both" disabled={cancel.busy || freeze.busy} onClick={() => cancel.run(w.cancelRecovery)}><Fingerprint size={18} />Cancel recovery with Touch ID</Btn>
            {!state.frozen && (
              <Btn variant="outline" size="md" className="mt-2" disabled={cancel.busy || freeze.busy} onClick={() => freeze.run(w.freeze)}>
                <Snowflake size={16} />{freeze.done ? 'Frozen' : 'Freeze instead (also stops it)'}
              </Btn>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// --- Restore on a new device ------------------------------------------------------

export function Restore() {
  const nav = useNav();
  const w = useWallet();
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorName, setErrorName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<RestoreStatus | null>(null);
  const r = w.restore;
  const go = async (fn: () => Promise<unknown>) => {
    setError(null);
    setErrorName(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErrorName((e as Error).name);
      setError((e as Error).name === 'InvalidStateError'
        ? 'That authenticator already holds your Touch ID key (they sync through one password manager), so the two keys wouldn\'t be independent. Use another, or press the same button again to use it anyway.'
        : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const field = 'h-11 rounded-btn border border-line bg-card px-4 font-mono text-xs text-fg outline-none placeholder:text-faint focus:border-accent';
  const errorBox = error && <div role="alert" className="mt-3 rounded-card border border-both px-3.5 py-2.5 text-xs leading-snug text-both">{error}</div>;

  if (!r) {
    return (
      <div className="flex min-h-full flex-col p-5">
        <PageTitle size="lg">Restore an account</PageTitle>
        <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">
          Lost your keys? If the account has a guardian, this device makes two new keys and your guardian installs them. It takes the account's recovery wait.
        </p>
        <label className="mt-4 flex flex-col gap-1.5 text-xs text-muted">Account address on {network.name}
          <input className={field} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" spellCheck={false} />
        </label>
        {errorBox}
        <div className="flex-1" />
        <Btn className="mt-4" disabled={!address.trim() || busy} onClick={() => go(() => w.startRestore(address))}>Continue</Btn>
        <Btn variant="ghost" size="md" className="mt-1" onClick={() => nav.reset({ name: 'welcome' })}>Back</Btn>
      </div>
    );
  }

  if (r.keys.length < 2) {
    const shared = errorName === 'InvalidStateError';
    return (
      <div className="flex min-h-full flex-col p-5">
        <PageTitle size="lg">{r.keys.length === 0 ? 'Make your new first key' : 'Now a second key'}</PageTitle>
        <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">
          These replace the lost keys on {shortAddr(r.address)}. {r.keys.length === 0 ? 'Start with Touch ID on this Mac.' : 'Use a security key, or a phone with a different password manager from this Mac, so the two keys are independent.'}
        </p>
        {errorBox}
        <div className="flex-1" />
        {r.keys.length === 0 ? (
          <Btn className="mt-4" disabled={busy} onClick={() => go(() => w.createRestoreKey('touchid'))}><Fingerprint size={18} />Create with Touch ID</Btn>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <Btn variant="outline" disabled={busy} onClick={() => go(() => w.createRestoreKey('security-key', { allowShared: shared }))}><Usb size={18} />Security key</Btn>
            <Btn variant="outline" disabled={busy} onClick={() => go(() => w.createRestoreKey('phone', { allowShared: shared }))}><Smartphone size={18} />Phone</Btn>
          </div>
        )}
        <Btn variant="ghost" size="md" className="mt-1" disabled={busy} onClick={() => go(w.cancelRestore)}>Start over</Btn>
      </div>
    );
  }

  const describe = (s: RestoreStatus | null) => {
    if (!s) return null;
    if (s.stage === 'waiting-for-guardian') return 'Your guardian hasn\'t started the recovery yet.';
    if (s.stage === 'waiting') return `Recovery started. Your guardian can finish it ${until(s.executeAfter)}.`;
    if (s.stage === 'other-keys') return 'A recovery is in progress, but for different keys than this device made. Ask your guardian.';
    return null;
  };
  return (
    <div className="flex min-h-full flex-col p-5">
      <PageTitle size="lg">Send this to your guardian</PageTitle>
      <p className="m-0 mt-2.5 text-[13px] leading-normal text-muted">
        They paste it into the Haptix guardian page and start the recovery from their own wallet. After the wait, they finish it, and this device opens the account.
      </p>
      <div className="mt-4 max-h-28 overflow-y-auto break-all rounded-card border border-line bg-card p-3 font-mono text-[10px] leading-relaxed text-muted">{w.restoreRequestText}</div>
      <Btn variant="outline" size="md" className="mt-2" onClick={async () => { if (w.restoreRequestText && (await copyText(w.restoreRequestText))) setCopied(true); }}>
        {copied ? <><Check size={16} />Copied</> : <><Copy size={16} />Copy request</>}
      </Btn>
      {status && describe(status) && <p className="m-0 mt-3 flex items-start gap-2 text-xs leading-snug text-muted"><TriangleAlert size={14} className="mt-0.5 shrink-0" />{describe(status)}</p>}
      {errorBox}
      <div className="flex-1" />
      <Btn className="mt-4" disabled={busy} onClick={() => go(async () => {
        const s = await w.checkRestore();
        setStatus(s);
        if (s.stage === 'restored') nav.reset({ name: 'home' });
      })}>
        {busy ? <Loader2 size={18} className="animate-spin" /> : null}Check status
      </Btn>
      <Btn variant="ghost" size="md" className="mt-1" disabled={busy} onClick={() => go(w.cancelRestore)}>Start over</Btn>
    </div>
  );
}
