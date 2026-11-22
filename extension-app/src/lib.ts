import { formatUnits } from 'viem';
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Fixed decimals, trimmed only by what the caller asks for. */
export const fmt = (n: number, decimals: number) => n.toFixed(decimals);

/**
 * An exact on-chain amount for a signing screen: padded to the display decimals, but never
 * rounded, so the user always sees every digit they are approving.
 */
export const fmtExact = (value: bigint, unitDecimals: number, displayDecimals: number) => {
  const exact = formatUnits(value, unitDecimals);
  const [whole, frac = ''] = exact.split('.');
  return frac.length >= displayDecimals ? exact : `${whole}.${frac.padEnd(displayDecimals, '0')}`.replace(/\.$/, '');
};

/** Decimals for an amount of a token, from the asset list (defaults to 4). */
export const decimalsFor = (assets: { symbol: string; decimals: number }[], symbol: string) =>
  assets.find((a) => a.symbol === symbol)?.decimals ?? 4;

export const pct = (part: number, whole: number) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0);

/** SVG path for a sparkline through the points, scaled into width x height. */
export function sparkPath(points: number[], width: number, height: number, pad = 4) {
  if (points.length < 2) return '';
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  return points
    .map((p, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)} ${(pad + (1 - (p - min) / span) * (height - pad * 2)).toFixed(1)}`)
    .join(' ');
}

export const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/** "5m ago", "3h ago", "2d ago". */
export function ago(ts: number) {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
