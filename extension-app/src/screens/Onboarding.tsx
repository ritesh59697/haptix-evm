import { useState, type ReactNode } from 'react';
import { Check, Fingerprint, TriangleAlert } from 'lucide-react';
import { Btn, Header, Logo, PageTitle, cx } from '../ui';
import { useNav } from '../nav';
import { network, useWallet } from '../wallet';
import { usePanelRoute } from './Agents';

function Steps({ at }: { at: 1 | 2 | 3 }) {
  return (
    <div className="flex flex-1 items-center gap-3">
      <div className="grid flex-1 grid-cols-3 gap-1">
        {[1, 2, 3].map((n) => (
          <div key={n} className={cx('h-[3px] rounded-full', n <= at ? 'bg-accent' : 'bg-line')} />
        ))}
      </div>
      <span className="text-xs text-muted">{at} of 3</span>
    </div>
  );
}

export function Welcome() {
  const nav = useNav();
  const w = useWallet();
  // Restoring makes a second key on another authenticator; the popup closes during that prompt.
  const openPanel = usePanelRoute();
  const steps = ['Touch ID on this Mac', 'A second key that lives somewhere else', 'A limit for one-fingerprint sends'];
  return (
    <div className="flex h-full flex-col px-4 pb-4 pt-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">Haptix</span>
        </div>
        <span className="rounded-md border border-line bg-card px-2 py-1 font-mono text-[11px] text-muted">{network.shortName}</span>
      </div>

      <div className="grid-paper relative mt-4 flex h-[150px] items-center justify-center rounded-card border border-line bg-card">
        <span className="flex h-16 w-16 items-center justify-center rounded-card bg-accent text-on-accent">
          <Fingerprint size={34} strokeWidth={1.6} aria-hidden="true" />
        </span>
        <span className="absolute left-3 top-2.5 font-mono text-[10px] uppercase tracking-wider text-muted">passkey · p-256</span>
        <span className="absolute bottom-2.5 right-3 font-mono text-[10px] text-muted">chain {network.chainId}</span>
      </div>

      <h1 className="m-0 mt-5 text-[26px] font-semibold leading-[1.1] tracking-[-0.02em]">Open your wallet with a fingerprint.</h1>
      <p className="m-0 mt-2 text-[13px] leading-normal text-muted">No seed phrase. Your keys are passkeys, and your agents get budgets they can't go past.</p>

      <ol className="m-0 mt-4 flex list-none flex-col gap-2 p-0">
        {steps.map((s, i) => (
          <li key={s} className={cx('flex items-center gap-3 text-[13px]', i > 0 && 'text-muted')}>
            <span className={cx('flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md font-mono text-xs font-medium', i === 0 ? 'bg-fg text-bg' : 'border border-line')}>
              {i + 1}
            </span>
            {s}
          </li>
        ))}
      </ol>

      <div className="flex-1" />
      <Btn onClick={() => nav.run(() => w.createFirstKey(), undefined, () => nav.go({ name: 'secondKey' }))}>
        <Fingerprint size={18} /> Create with Touch ID
      </Btn>
      <Btn variant="ghost" size="md" className="mt-1" onClick={() => openPanel({ name: 'restore' })}>
        I already have an account
      </Btn>
    </div>
  );
}

type KeyChoice = 'security-key' | 'phone';

export function SecondKey() {
  const nav = useNav();
  const w = useWallet();
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<KeyChoice>('security-key');
  const [error, setError] = useState<{ name: string; message: string } | null>(null);
  const add = async (allowShared = false) => {
    setBusy(true);
    setError(null);
    try {
      await w.createSecondKey(choice, { allowShared });
      nav.go({ name: 'setLimit' });
    } catch (e) {
      setError({ name: (e as Error).name, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const shared = error?.name === 'InvalidStateError';
  const option = (value: KeyChoice, title: string, body: string, extra?: ReactNode) => (
    <label key={value} className={cx('flex cursor-pointer gap-3 rounded-card p-3.5', choice === value ? 'border-[1.5px] border-accent bg-card' : 'border border-line bg-card')}>
      <input type="radio" name="key2" checked={choice === value} onChange={() => { setChoice(value); setError(null); }} className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--accent))]" />
      <span className="flex flex-1 flex-col gap-1.5">
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">{title}</span>
          {value === 'security-key' && <span className="rounded-md bg-accent px-1.5 py-0.5 text-[11px] font-semibold text-on-accent">Most independent</span>}
        </span>
        <span className="text-xs leading-snug text-muted">{body}</span>
        {extra}
      </span>
    </label>
  );
  return (
    <div className="flex h-full flex-col">
      <Header><Steps at={2} /></Header>
      <div className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-3">
        <div className="mt-3"><PageTitle>Add a second key</PageTitle></div>
        <p className="m-0 mt-2 text-[13px] leading-normal text-muted">Sends above your per-send limit need both keys. Pick one that can't be copied along with the first.</p>

        <div className="mt-3.5 flex items-center gap-2.5 rounded-card border border-line bg-card px-3 py-2.5 text-[13px]">
          <Check size={16} strokeWidth={2.5} className="text-accent-text" />
          <span className="flex-1">Key 1: Touch ID on this Mac</span>
          <span className="text-xs text-muted">{w.draftKeys[0]?.synced === false ? 'This device only' : 'Synced'}</span>
        </div>

        <fieldset className="m-0 mt-3 flex flex-col gap-2 border-0 p-0">
          <legend className="sr-only">Second key</legend>
          {option('security-key', 'Security key', 'Plug it in and tap. The key never leaves it.')}
          {option(
            'phone',
            'Phone',
            'Scan a QR code. No app needed.',
            <span className="flex items-start gap-2 text-xs leading-snug text-both">
              <TriangleAlert size={14} className="mt-0.5 shrink-0" />
              If your phone and this Mac use the same password manager, both keys end up in one account.
            </span>,
          )}
          <div className="flex gap-3 rounded-card border border-dashed border-line p-3.5 text-muted" aria-disabled="true">
            <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-faint" />
            <span className="flex flex-1 flex-col gap-1">
              <span className="flex justify-between text-sm font-semibold">Haptix phone app <span className="text-[11px] font-normal">Later</span></span>
              <span className="text-xs leading-snug">Key stays in the phone's secure chip.</span>
            </span>
          </div>
        </fieldset>

        <div className="flex-1" />
        {error && (
          <div role="alert" className="mb-2.5 mt-3 rounded-card border border-both px-3.5 py-2.5 text-xs leading-snug">
            {shared ? (
              <>
                <div className="font-semibold text-both">This {choice === 'phone' ? 'phone' : 'key'} already holds your Touch ID key.</div>
                <div className="mt-1 text-muted">
                  It syncs with this Mac (iCloud Keychain or Google), so one account would hold both keys. Pick a security key or a phone on a different account, or continue for testing.
                </div>
              </>
            ) : error.name === 'NotAllowedError' ? (
              <span className="text-both">The prompt was closed or timed out. Nothing was saved. Try again.</span>
            ) : (
              <span className="text-both">{error.name}: {error.message}</span>
            )}
          </div>
        )}
      </div>
      <div className="shrink-0 px-5 pb-5">
        {shared ? (
          <Btn variant="outline" className="w-full" disabled={busy} onClick={() => add(true)}>Use it anyway (testing only)</Btn>
        ) : (
          <Btn className="w-full" disabled={busy} onClick={() => add()}>
            {choice === 'security-key' ? 'Add security key' : 'Show QR code'}
          </Btn>
        )}
      </div>
    </div>
  );
}

export function SetLimit() {
  const nav = useNav();
  const w = useWallet();
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState('');
  const valid = Number(value) > 0;
  return (
    <div className="flex h-full flex-col">
      <Header><Steps at={3} /></Header>
      <div className="flex flex-1 flex-col px-5 pb-5">
        <div className="mt-3"><PageTitle>Set your per-send limit</PageTitle></div>
        <p className="m-0 mt-2 text-[13px] leading-normal text-muted">Up to this much per send, one fingerprint is enough. Above it, you'll need both keys.</p>

        <label htmlFor="limit" className="mt-6 text-xs text-muted">Per-send limit</label>
        <div className="mt-1.5 flex h-14 items-center rounded-btn border-[1.5px] border-accent bg-card px-4">
          <input
            id="limit"
            inputMode="decimal"
            placeholder="0.00"
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, ''))}
            className="min-w-0 flex-1 border-0 bg-transparent font-mono text-[26px] font-medium text-fg outline-none placeholder:text-faint"
          />
          <span className="text-sm text-muted">{network.nativeSymbol}</span>
        </div>
        <p className="m-0 mt-3 text-xs leading-normal text-muted">Your address is worked out now; the account goes on chain with your first send. Raising the limit later needs both keys, so a stolen fingerprint can't raise it.</p>

        <div className="flex-1" />
        <Btn
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true);
            await nav.run(() => w.finishOnboarding(value), undefined, () => nav.reset({ name: 'home' }));
            setBusy(false);
          }}
        >
          Create account
        </Btn>
      </div>
    </div>
  );
}
