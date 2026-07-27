// Pure display helpers for the History & Spend pane. Kept out of SpendPane.tsx so the
// number/label rules — which are where a spend view most easily lies to you — are unit-testable
// without rendering anything.

/** Compact token count: 1234 → "1.2K", 45_600_000 → "45.6M". Exact below 1000. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1_000)}K`;
  if (n < 1_000_000_000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1_000_000_000)}B`;
}

/** One decimal, but no trailing ".0" — "1.2K" and "45K", never "45.0K". */
function trim(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/**
 * USD for display. A nonzero amount that would round to $0.00 renders as "<$0.01" rather than
 * "$0.00" — a real (if tiny) cost must never be shown as free.
 */
export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Cost cell for a rollup row. Returns null when the row is entirely unpriced (unknown model), so
 * the caller can render an explicit "—" instead of a confident "$0.00".
 */
export function costCell(estimatedCostUsd: number, unpricedTokens: number): string | null {
  if (estimatedCostUsd <= 0 && unpricedTokens > 0) return null;
  return formatUsd(estimatedCostUsd);
}

/** "2026-07-24" → "Jul 24". Returns the input unchanged if it isn't a plain ISO date. */
export function shortDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(m[2]) - 1];
  if (!month) return iso;
  return `${month} ${Number(m[3])}`;
}

/**
 * Bar height as a percentage of the tallest day, floored at `minPct` for any NONZERO day so a
 * light-but-real day still paints a visible sliver. A zero day is exactly 0 — the floor must not
 * invent usage that didn't happen. An all-zero window yields all zeros (no divide-by-zero).
 */
export function barPercent(value: number, max: number, minPct = 2): number {
  if (!(max > 0) || value <= 0) return 0;
  return Math.max(minPct, Math.min(100, (value / max) * 100));
}

/** The largest daily total in the window; 0 when there is no usage at all. */
export function maxDaily(days: { tokens: { total: number } }[]): number {
  return days.reduce((m, d) => Math.max(m, d.tokens.total), 0);
}

/**
 * Which bars get an x-axis label. A 28-column chart can't carry 28 dates, so label roughly
 * `target` evenly spaced columns and always include the last (most recent) one.
 */
export function axisLabelIndexes(count: number, target = 5): Set<number> {
  const out = new Set<number>();
  if (count <= 0) return out;
  if (count <= target) {
    for (let i = 0; i < count; i++) out.add(i);
    return out;
  }
  const step = (count - 1) / (target - 1);
  for (let i = 0; i < target; i++) out.add(Math.round(i * step));
  out.add(count - 1);
  return out;
}
