import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Activity, ChevronLeft, Cpu, Shield, Wallet } from 'lucide-react';
import type { Approver } from './data/sample';
import { useNav } from './nav';
import markUrl from './assets/haptix-mark.svg';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** The Haptix mark (the same file the website uses), drawn in the current text color. */
export function Logo({ size = 22 }: { size?: number }) {
  // Quoted: Vite inlines small SVGs as data URLs, which break an unquoted url().
  const mask = `url("${markUrl}") center / contain no-repeat`;
  return <span aria-hidden="true" className="inline-block shrink-0 bg-current" style={{ width: size, height: size, mask, WebkitMask: mask }} />;
}

type Variant = 'primary' | 'both' | 'outline' | 'ghost';
type Size = 'lg' | 'md' | 'sm';

export function Btn({
  variant = 'primary',
  size = 'lg',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-btn font-sans transition disabled:opacity-40',
        size === 'lg' && 'h-12 px-5 text-[15px]',
        size === 'md' && 'h-11 px-4 text-sm',
        size === 'sm' && 'h-8 px-3.5 text-xs',
        variant === 'primary' && 'bg-accent font-semibold text-on-accent hover:brightness-105',
        variant === 'both' && 'bg-both font-semibold text-on-both hover:brightness-110',
        variant === 'outline' && 'border border-line bg-card text-fg hover:bg-raised',
        variant === 'ghost' && 'text-muted hover:text-fg',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Header({ title, right, children }: { title?: string; right?: ReactNode; children?: ReactNode }) {
  const nav = useNav();
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 px-4 pt-2">
      {nav.canGoBack && (
        <button type="button" aria-label="Back" onClick={nav.back} className="-ml-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:text-fg">
          <ChevronLeft size={20} />
        </button>
      )}
      {title && <span className="text-[15px] font-semibold">{title}</span>}
      {children}
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}

export function PageTitle({ children, size = 'md' }: { children: ReactNode; size?: 'md' | 'lg' }) {
  return <h1 className={cx('m-0 font-semibold leading-[1.1] tracking-[-0.02em]', size === 'lg' ? 'text-[28px]' : 'text-[24px]')}>{children}</h1>;
}

/** A bar split into parts, each a share of the whole (0-100). */
export function Meter({ parts, track = 'bg-line', gap = false }: { parts: { pct: number; className: string }[]; track?: string; gap?: boolean }) {
  return (
    <div className={cx('flex h-1.5 overflow-hidden rounded-full', track, gap && 'gap-0.5')}>
      {parts.map((p, i) => (
        <div key={i} className={cx('h-1.5', p.className)} style={{ width: `${p.pct}%` }} />
      ))}
    </div>
  );
}

export function Amount({ value, unit, size = 40 }: { value: string; unit: string; size?: number }) {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span className="font-mono font-medium leading-none tracking-[-0.03em]" style={{ fontSize: size }}>{value}</span>
      <span className="text-[15px] font-medium text-muted">{unit}</span>
    </span>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return <dl className="m-0 divide-y divide-hair rounded-card border border-line bg-card px-3.5 text-[13px]">{children}</dl>;
}
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-11 items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

const approverStyle: Record<Approver, { label: string; dot: string }> = {
  agent: { label: 'Agent', dot: 'bg-agent' },
  you: { label: 'You', dot: 'bg-accent' },
  both: { label: 'Both keys', dot: 'bg-both' },
};
export function ApproverTag({ who }: { who: Approver }) {
  const s = approverStyle[who];
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
      <span className={cx('h-1.5 w-1.5 rounded-full', s.dot)} />
      {s.label}
    </span>
  );
}

const tabs = [
  { name: 'home', label: 'Wallet', Icon: Wallet },
  { name: 'activity', label: 'Activity', Icon: Activity },
  { name: 'agents', label: 'Agents', Icon: Cpu },
  { name: 'security', label: 'Security', Icon: Shield },
] as const;

export function BottomNav({ active }: { active: (typeof tabs)[number]['name'] }) {
  const nav = useNav();
  return (
    <nav aria-label="Main" className="grid h-14 shrink-0 grid-cols-4 border-t border-hair">
      {tabs.map(({ name, label, Icon }) => (
        <button
          key={name}
          type="button"
          aria-current={active === name ? 'page' : undefined}
          onClick={() => nav.reset({ name })}
          className={cx('flex flex-col items-center justify-center gap-1 text-[11px]', active === name ? 'text-accent-text' : 'text-muted hover:text-fg')}
        >
          <Icon size={18} />
          {label}
        </button>
      ))}
    </nav>
  );
}

export function Toast() {
  const { toast } = useNav();
  return (
    <div aria-live="polite" className="pointer-events-none absolute inset-x-3 bottom-[68px] flex justify-center">
      {toast && <div className="rounded-btn bg-fg px-4 py-2.5 text-center text-xs leading-snug text-bg shadow-lg">{toast}</div>}
    </div>
  );
}

export { cx };
