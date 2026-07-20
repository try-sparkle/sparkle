// The Credits settings pane (credits-menu spec §1–§2). State-aware on the entitlement store:
// signed-out/trial → the $99 upsell; signed-in-unpaid → upsell + promo box; entitled → balance,
// the five 1:1 top-up packs, and the promo box. Purchases ride the proven paywall rails — a
// Stripe Checkout URL opened in the system browser, with the copy/paste LaunchFallback whenever
// a launch fails, and a window-focus refresh to pick the new balance up on return.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { FiAlertTriangle } from "react-icons/fi";
import { C, ON_BRAND_FILL, DANGER } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { useAuthStore } from "../stores/authStore";
import { formatBalance } from "../services/creditPricing";
import { lastSignInUrl, openPaywall, openSignIn, PAYWALL_URL } from "../services/sparkleApi";
import {
  PACKS,
  checkoutGuidance,
  fetchAutoTopup,
  fetchHistory,
  historyLabel,
  lastCheckoutUrl,
  saveAutoTopup,
  startCardSetup,
  startTopup,
  type AutoTopup,
  type CheckoutGuidance,
  type LedgerEntry,
  type PackId,
} from "../services/creditsMenuApi";
import { PromoRedeem } from "./PromoRedeem";
import { SupportModal } from "./SupportModal";

/** Same recovery as AuthGate's fallback: when the system browser can't launch, show the URL
 *  selectable so the user can open it manually — never a dead button. */
function LaunchFallback({ url }: { url: string }) {
  return (
    <p style={{ color: DANGER, fontSize: 13, margin: 0, maxWidth: 420 }} role="alert">
      Couldn&apos;t open your browser. Open this link manually:{" "}
      <span style={{ color: C.cream, userSelect: "text", wordBreak: "break-all" }}>{url}</span>
    </p>
  );
}

/** "$10" … "$1,000" — packs are whole dollars, so no cents in the button label. */
const packLabel = (amountCents: number) => `$${(amountCents / 100).toLocaleString("en-US")}`;

export function CreditsPanel() {
  const me = useAuthStore((s) => s.me);
  const loading = useAuthStore((s) => s.loading);
  const tokenPresent = useAuthStore((s) => s.tokenPresent);
  const refresh = useAuthStore((s) => s.refresh);

  // While the pane is open, returning from the browser (Stripe checkout) should show the new
  // balance immediately. The sparkle://auth deep link also refreshes globally via AuthGate, but
  // that only fires when the user clicks "Return to Sparkle" — a plain ⌘-tab back must work too.
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // Pack whose checkout launch is in flight (all buttons disabled meanwhile), and the outcome
  // of the last attempt: quiet in-browser hint, launch-failure URL, or a diagnosed checkout failure.
  const [busyPack, setBusyPack] = useState<PackId | null>(null);
  const [launched, setLaunched] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [buyGuidance, setBuyGuidance] = useState<CheckoutGuidance | null>(null);
  // Support flow opened from a config-error's "Contact support" affordance. SupportModal is a
  // self-contained overlay (ModalShell), so it renders fine on top of the settings dialog.
  const [supportOpen, setSupportOpen] = useState(false);

  // fetchMe() resolves null on ANY auth/network failure, so `me === null` alone is NOT "signed
  // out": while the initial load is in flight show nothing pushy, and when a token is present a
  // null `me` is a transient failure (often an entitled user ⌘-tabbing back on a flaky link) —
  // offer a retry, never downgrade them to the $99 pitch.
  if (!me && loading) return <p style={quietHint}>Loading…</p>;
  if (!me && tokenPresent) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <p style={{ ...quietHint, color: DANGER }}>Couldn&apos;t load your account</p>
        <button
          type="button"
          style={smallBtn}
          aria-label="Retry account"
          onClick={() => void refresh()}
        >
          Retry
        </button>
      </div>
    );
  }
  if (!me || !me.entitled) return <Upsell unpaid={me !== null} refresh={refresh} />;

  const buy = async (pack: PackId) => {
    if (busyPack) return;
    setBusyPack(pack);
    setLaunched(false);
    setFailedUrl(null);
    setBuyGuidance(null);
    try {
      const ok = await startTopup(pack);
      if (ok) setLaunched(true);
      else setFailedUrl(lastCheckoutUrl());
    } catch (e) {
      // Diagnose the failure instead of a blanket "try again": the Rust command hands us a
      // structured error so we can distinguish an our-side config problem (the prod Stripe 403)
      // from offline vs. a lost session, and guide the user accordingly. Log the raw cause too so
      // field reports stay diagnosable.
      console.error("topup checkout failed:", e);
      setBuyGuidance(checkoutGuidance(e));
    } finally {
      // Always recover the button state — a failed checkout must never leave a stuck spinner.
      setBusyPack(null);
    }
  };

  // The session's expired (checkout reported not_signed_in): open the real sign-in → desktop
  // hand-off (state/PKCE-bound), surfacing the copy/paste URL if the browser can't launch — same
  // recovery the rest of the pane uses. NOT `refresh()`, which only re-reads a token we don't have.
  const signInAgain = async () => {
    setFailedUrl(null);
    const ok = await openSignIn();
    if (!ok) setFailedUrl(lastSignInUrl());
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={subLabel}>Balance</div>
        <div style={balanceText}>{formatBalance(me.balanceCents)}</div>
      </div>

      <div>
        <div style={subLabel}>Buy credits</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {PACKS.map((p) => (
            <button
              key={p.id}
              type="button"
              style={{ ...packBtn, opacity: busyPack ? 0.6 : 1 }}
              disabled={busyPack !== null}
              onClick={() => void buy(p.id)}
            >
              {packLabel(p.amountCents)}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {launched && (
            <p style={quietHint}>
              Complete the purchase in your browser — your balance updates when you return.
            </p>
          )}
          {buyGuidance && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 420 }}>
              <p style={{ color: DANGER, fontSize: 12, margin: 0 }} role="alert">
                {buyGuidance.message}
              </p>
              {buyGuidance.showSupport && (
                <button
                  type="button"
                  style={{ ...smallBtn, alignSelf: "flex-start" }}
                  onClick={() => setSupportOpen(true)}
                >
                  Contact support
                </button>
              )}
              {buyGuidance.needsSignIn && (
                <button
                  type="button"
                  style={{ ...smallBtn, alignSelf: "flex-start" }}
                  onClick={() => void signInAgain()}
                >
                  Sign in
                </button>
              )}
            </div>
          )}
          {failedUrl && <LaunchFallback url={failedUrl} />}
        </div>
      </div>

      {supportOpen && <SupportModal onClose={() => setSupportOpen(false)} />}

      <div>
        <div style={subLabel}>Auto-refill</div>
        <AutoTopupBlock fallback={me.autoTopup} />
      </div>

      <div>
        <div style={subLabel}>Promo code</div>
        <PromoRedeem refresh={refresh} />
      </div>

      <div>
        <div style={subLabel}>History</div>
        <HistoryBlock />
      </div>
    </div>
  );
}

// Threshold choices for "Auto-refill when low" (spec §3): label → cents.
const THRESHOLDS: { cents: number; label: string }[] = [
  { cents: 200, label: "below $2" },
  { cents: 500, label: "below $5" },
  { cents: 1000, label: "below $10" },
  { cents: 2500, label: "below $25" },
];

/** Cents for a pack id (labels only — the server owns the real table). */
function packCents(id: PackId): number {
  return PACKS.find((p) => p.id === id)?.amountCents ?? Number.MAX_SAFE_INTEGER;
}

/** Auto-refill settings (spec §3). The SERVER is authoritative: every change round-trips through
 *  saveAutoTopup and the block re-renders from the response — so e.g. a toggle the server refuses
 *  never sticks on. Enabling without a saved card first routes through the setup-mode checkout. */
function AutoTopupBlock({ fallback }: { fallback?: AutoTopup }) {
  const [settings, setSettings] = useState<AutoTopup | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // The user tried to enable with no saved card — show the "Save a card first" row. The toggle
  // stays OFF until a later refresh reports hasSavedCard (the focus-triggered reload after the
  // setup checkout in the browser).
  const [needCard, setNeedCard] = useState(false);
  const [cardBusy, setCardBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  const [cardFallbackUrl, setCardFallbackUrl] = useState<string | null>(null);

  // Guards the load/save race: a focus-triggered load can be in flight when the user saves;
  // if its (now stale) snapshot landed after the save response it would clobber the fresher
  // server state. A ref, not `saving`, so the in-flight load reads the CURRENT value.
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const s = await fetchAutoTopup();
      if (!savingRef.current) setSettings(s);
    } catch {
      if (savingRef.current) return;
      // Older /me responses may still carry the settings — better stale than a dead block.
      if (fallback) setSettings(fallback);
      else setLoadFailed(true);
    }
  }, [fallback]);
  // Load on mount AND on window focus: saving a card happens in the browser, so the return
  // (⌘-tab back) must re-read hasSavedCard or the "Save a card first" gate never clears.
  useEffect(() => {
    void load();
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const save = async (next: { enabled: boolean; thresholdCents: number; packId: PackId }) => {
    setSaving(true);
    savingRef.current = true;
    setSaveFailed(false);
    try {
      setSettings(await saveAutoTopup(next));
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
      savingRef.current = false;
    }
  };

  if (loadFailed) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <p style={{ ...quietHint, color: DANGER }} role="alert">
          Couldn&apos;t load auto-refill settings
        </p>
        <button
          type="button"
          style={smallBtn}
          aria-label="Retry auto-refill settings"
          onClick={() => void load()}
        >
          Retry
        </button>
      </div>
    );
  }
  if (!settings) return <p style={quietHint}>Loading…</p>;

  const onToggle = () => {
    if (saving) return;
    const enabling = !settings.enabled;
    if (enabling && !settings.hasSavedCard) {
      setNeedCard(true);
      return;
    }
    setNeedCard(false);
    void save({ enabled: enabling, thresholdCents: settings.thresholdCents, packId: settings.packId });
  };

  const saveCard = async () => {
    if (cardBusy) return; // double-clicks must not open multiple setup-checkout tabs
    setCardBusy(true);
    setCardFallbackUrl(null);
    setCardError(null);
    try {
      const ok = await startCardSetup();
      if (!ok) setCardFallbackUrl(lastCheckoutUrl());
    } catch (e) {
      console.error("card setup failed:", e);
      setCardError("Couldn't start card setup — try again.");
    } finally {
      setCardBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.cream, cursor: "pointer" }}>
        <input
          type="checkbox"
          aria-label="Auto-refill when low"
          checked={settings.enabled}
          disabled={saving}
          onChange={onToggle}
        />
        Auto-refill when low
      </label>

      {settings.enabled && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select
            aria-label="Refill threshold"
            style={selectStyle}
            value={String(settings.thresholdCents)}
            disabled={saving}
            onChange={(e) =>
              void save({
                enabled: true,
                thresholdCents: Number(e.target.value),
                packId: settings.packId,
              })
            }
          >
            {/* A server value outside the preset list still renders (and stays selectable). */}
            {!THRESHOLDS.some((t) => t.cents === settings.thresholdCents) && (
              <option value={String(settings.thresholdCents)}>
                below {formatBalance(settings.thresholdCents)}
              </option>
            )}
            {/* The server 400s a threshold one refill can't clear (runaway-charge guard), so
                thresholds above the selected pack are unpickable rather than save-and-fail. */}
            {THRESHOLDS.map((t) => (
              <option key={t.cents} value={String(t.cents)} disabled={t.cents > packCents(settings.packId)}>
                {t.label}
              </option>
            ))}
          </select>
          <span style={quietHint}>buy</span>
          <select
            aria-label="Refill pack"
            style={selectStyle}
            value={settings.packId}
            disabled={saving}
            onChange={(e) => {
              const nextPack = e.target.value as PackId;
              void save({
                enabled: true,
                // Shrinking the pack below the threshold would 400 server-side — clamp instead.
                thresholdCents: Math.min(settings.thresholdCents, packCents(nextPack)),
                packId: nextPack,
              });
            }}
          >
            {PACKS.map((p) => (
              <option key={p.id} value={p.id}>
                {packLabel(p.amountCents)}
              </option>
            ))}
          </select>
        </div>
      )}

      {needCard && !settings.hasSavedCard && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: C.cream }}>
              Save a card first — auto-refill charges it when your balance runs low.
            </span>
            <button
              type="button"
              style={smallBtn}
              disabled={cardBusy}
              onClick={() => void saveCard()}
            >
              Save card
            </button>
          </div>
          {cardError && (
            <p style={{ color: DANGER, fontSize: 12, margin: 0 }} role="alert">
              {cardError}
            </p>
          )}
          {cardFallbackUrl && <LaunchFallback url={cardFallbackUrl} />}
        </div>
      )}

      {settings.lastFailure && (
        <p style={warnRow} role="alert">
          <FiAlertTriangle size={14} style={{ flex: "none", marginTop: 2 }} />
          <span>
            Auto-refill failed ({settings.lastFailure}) — it&apos;s been turned off. Update your
            card and re-enable.
          </span>
        </p>
      )}

      {saveFailed && (
        <p style={{ color: DANGER, fontSize: 12, margin: 0 }} role="alert">
          Couldn&apos;t save auto-refill settings — try again.
        </p>
      )}
    </div>
  );
}

/** Transaction history (spec §4): newest-first ledger pages with signed color-coded amounts and
 *  a "Load more" while the server reports another page. Failures stay inside this block. */
function HistoryBlock() {
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const loadFirst = useCallback(async () => {
    setFailed(false);
    try {
      const page = await fetchHistory();
      setEntries(page.entries);
      setNextCursor(page.nextCursor);
    } catch {
      setFailed(true);
    }
  }, []);
  // First page on mount AND on window focus: a top-up completes in the browser, so the return
  // must show the new ledger entry (the ledger is newest-first, so page 1 is where it lands —
  // the reset of any expanded pagination is the price of freshness).
  useEffect(() => {
    void loadFirst();
    const onFocus = () => void loadFirst();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadFirst]);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setFailed(false);
    try {
      const page = await fetchHistory(nextCursor);
      setEntries((cur) => [...(cur ?? []), ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  // Inline error + retry. Rendered ALONE only before the first page arrives; a load-more
  // failure renders it BENEATH the already-loaded rows so they never vanish.
  const errorRow = (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <p style={{ ...quietHint, color: DANGER }} role="alert">
        Couldn&apos;t load history
      </p>
      <button
        type="button"
        style={smallBtn}
        aria-label="Retry history"
        onClick={() => void (entries === null ? loadFirst() : loadMore())}
      >
        Retry
      </button>
    </div>
  );
  if (entries === null) return failed ? errorRow : <p style={quietHint}>Loading…</p>;
  if (entries.length === 0 && !failed) return <p style={quietHint}>No activity yet.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {entries.map((e) => {
        const credit = e.deltaCents >= 0;
        // U+2212 minus (not a hyphen) so debits read as amounts, matching the design copy.
        const amount = `${credit ? "+" : "−"}$${(Math.abs(e.deltaCents) / 100).toFixed(2)}`;
        const label = historyLabel(e);
        return (
          <div key={e.id} style={historyRow}>
            <span style={{ color: C.muted, width: 76, flex: "none" }}>
              {new Date(e.createdAt).toLocaleDateString()}
            </span>
            {/* Clip to one line — a long AI `purpose` ("AI: …") must not wrap the row; full text on
                hover. Keeps the date | label | amount three-column layout unchanged. */}
            <span style={historyLabelCell} title={label}>
              {label}
            </span>
            <span style={{ color: credit ? C.teal : DANGER, fontVariantNumeric: "tabular-nums" }}>
              {amount}
            </span>
          </div>
        );
      })}
      {failed && errorRow}
      {!failed && nextCursor && (
        <button
          type="button"
          style={{ ...smallBtn, alignSelf: "flex-start", marginTop: 4 }}
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          Load more
        </button>
      )}
    </div>
  );
}

/** The not-yet-entitled card (spec §1): trial/anonymous get the $99 pitch; a signed-in unpaid
 *  user additionally gets the promo box. Same copy as AuthGate's paywall screen. */
function Upsell({ unpaid, refresh }: { unpaid: boolean; refresh: () => Promise<void> }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pay = async () => {
    if (busy) return; // double-clicks must not open multiple checkout tabs
    setBusy(true);
    setFailedUrl(null);
    try {
      const ok = await openPaywall();
      if (!ok) setFailedUrl(PAYWALL_URL);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
      <div style={{ fontSize: 14, fontWeight: FONT_WEIGHT.semibold, color: C.cream }}>
        Unlock Sparkle
      </div>
      <p style={{ margin: 0, fontSize: 13, color: C.muted, maxWidth: 380, lineHeight: 1.5 }}>
        One-time <strong style={{ color: C.cream }}>$99</strong> — includes{" "}
        <strong style={{ color: C.cream }}>$200 of AI credits</strong> to power building and
        thinking.
      </p>
      <button
        type="button"
        style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}
        disabled={busy}
        onClick={() => void pay()}
      >
        Pay $99 &amp; get $200 in credits
      </button>
      {failedUrl && <LaunchFallback url={failedUrl} />}
      {unpaid && <PromoRedeem refresh={refresh} />}
    </div>
  );
}

// ── styles (inline CSSProperties, matching SettingsDialog's pane idiom) ─────────────────────

const subLabel: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: C.muted,
  fontWeight: FONT_WEIGHT.semibold,
  marginBottom: 8,
};

const balanceText: CSSProperties = {
  fontSize: 28,
  fontWeight: FONT_WEIGHT.semibold,
  color: C.cream,
  fontVariantNumeric: "tabular-nums",
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const packBtn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: 13,
  fontVariantNumeric: "tabular-nums",
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const quietHint: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: C.muted,
};

const primaryBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 8,
  padding: "10px 18px",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const smallBtn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 12,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const selectStyle: CSSProperties = {
  background: C.forest,
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 12,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const warnRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 6,
  color: DANGER,
  fontSize: 12,
  margin: 0,
  maxWidth: 420,
};

const historyRow: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  fontSize: 12,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

// The middle (reason/description) column: takes the slack and clips to a single line so a long AI
// `purpose` ellipsizes instead of wrapping the row.
const historyLabelCell: CSSProperties = {
  color: C.cream,
  flex: 1,
  minWidth: 0,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
