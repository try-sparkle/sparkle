// The concierge spend pill's data source (CM-U8, bead sparkle-4562.1). Mirrors the REAL
// cross-project Claude Code spend the Rust side computes (`accounts_spend` → getSpend), keeping a
// single live figure the pill subscribes to. The Rust side scans every account's transcripts and
// values them per-model at list price, so this store just holds the latest dollar figure and
// re-fetches it periodically (~60s) and on window focus — spend is ambient, not a hot path.
//
// The polling is a SHARED singleton driven by `useSpendPill`: the first mounted pill starts the
// interval + focus listener, the last to unmount stops them, so we never leave a timer running with
// no consumer and never run two intervals when (hypothetically) two pills mount.
import { useEffect } from "react";
import { create } from "zustand";
import { getSpend } from "../services/accountStore";

/** How often the mounted pill re-fetches spend. Ambient figure — a minute is plenty. */
export const SPEND_REFRESH_MS = 60_000;

interface SpendStore {
  /** Latest trailing-24h spend in DOLLARS, or null until the first successful read. */
  spendTodayUsd: number | null;
  /** True until the first read resolves (success or failure). */
  loading: boolean;
  /** The last read threw (IPC failure / Rust error). The pill keeps showing the placeholder. */
  error: boolean;
  /** Fetch the current spend and fold it into the store. Never throws (failures set `error`). */
  refresh: () => Promise<void>;
}

export const useSpendStore = create<SpendStore>((set) => ({
  spendTodayUsd: null,
  loading: true,
  error: false,
  refresh: async () => {
    try {
      const s = await getSpend();
      set({ spendTodayUsd: s.spendTodayUsd, loading: false, error: false });
    } catch (e) {
      // A spend read failing must never break the concierge — keep the last-known value (or the
      // placeholder) and just flag the error. The next tick/focus retries.
      console.warn("spend refresh failed; keeping the last-known figure:", e);
      set({ loading: false, error: true });
    }
  },
}));

/** Pre-formatted pill text: "$X.XX" for a known figure, "$—" while it's null (never loaded).
 *  Mirrors creditPricing.formatBalance's `$` + 2-decimals shape, but takes DOLLARS (spend), not
 *  cents, and renders the em-dash placeholder before the first successful read. Negative / non-finite
 *  inputs clamp to the placeholder-or-zero so the pill can never show a garbage amount. */
export function formatSpendText(usd: number | null): string {
  if (usd == null || !Number.isFinite(usd)) return "$—";
  return `$${Math.max(0, usd).toFixed(2)}`;
}

// ── Shared polling singleton ────────────────────────────────────────────────────────────────────
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let focusListener: (() => void) | null = null;
let inFlight = false;
let lastRefreshAt = 0;

/** Each refresh is a full cross-project transcript rescan, so coalesce: skip when one is already
 *  in flight or finished moments ago (rapid alt-tab focus events; roborev 46151). */
export const REFRESH_COALESCE_MS = 5_000;

function refreshNow(): void {
  const now = Date.now();
  if (inFlight || now - lastRefreshAt < REFRESH_COALESCE_MS) return;
  inFlight = true;
  void useSpendStore
    .getState()
    .refresh()
    .finally(() => {
      inFlight = false;
      lastRefreshAt = Date.now();
    });
}

function startPolling(): void {
  refreshNow(); // fetch immediately on first mount so the pill isn't stuck on "$—"
  timer = setInterval(refreshNow, SPEND_REFRESH_MS);
  focusListener = refreshNow;
  // `window` exists in the desktop renderer and jsdom; guard anyway so a non-DOM host can't throw.
  globalThis.addEventListener?.("focus", focusListener);
}

function stopPolling(): void {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
  if (focusListener != null) {
    globalThis.removeEventListener?.("focus", focusListener);
    focusListener = null;
  }
  // Full teardown resets the coalesce state so the next first-mount always fetches immediately.
  inFlight = false;
  lastRefreshAt = 0;
}

/** Subscribe the spend pill to the live cross-project spend figure. Starts a shared 60s poll +
 *  focus refresh on the first mount and tears it down when the last consumer unmounts. Returns the
 *  pre-formatted "$X.XX" (or "$—" until the first read). */
export function useSpendPill(): string {
  const spend = useSpendStore((s) => s.spendTodayUsd);
  useEffect(() => {
    if (subscribers === 0) startPolling();
    subscribers += 1;
    return () => {
      subscribers -= 1;
      if (subscribers === 0) stopPolling();
    };
  }, []);
  return formatSpendText(spend);
}
