import { useEffect, useRef, useState, type CSSProperties, type ComponentType } from "react";
import { FiZap, FiBell, FiCreditCard, FiEye, FiCpu, FiUsers, FiSliders, FiX, FiCommand, FiSmartphone } from "react-icons/fi";
import { C, ROW_ACTIVE_BUBBLE } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { openSignIn, signOut } from "../services/sparkleApi";
import { useAuthStore } from "../stores/authStore";
import { useUiStore, type CategoryId } from "../stores/uiStore";
import { AiFeaturesMenu } from "./AiFeaturesMenu";
import { NotificationsMenu } from "./NotificationsMenu";
import { ThemeToggle } from "./ThemeToggle";
import { AgentOrderToggle } from "./AgentOrderToggle";
import { BranchCleanupToggle } from "./BranchCleanupToggle";
import { WorkerLimitControl } from "./WorkerLimitControl";
import { AdvancedConfigMenu } from "./AdvancedConfigMenu";
import { MobileDevicesPane } from "./MobileDevicesPane";
import { KeyboardShortcutsMenu } from "./KeyboardShortcutsMenu";
import { CreditsPanel } from "./CreditsPanel";

// The ⋯ settings dialog. A focused, centered dialog with a left rail of categories driving a
// single right pane (the "macOS System Settings" pattern), replacing the old 80vw×80vh stack
// where every section was full-width and scrolled. Behavior is unchanged — every control is the
// same component reading/writing the same stores; this file only re-parents them into panes and
// owns the shell (backdrop, box, rail, close). Escape-to-close is still wired by the caller.

// Re-exported for this dialog's consumers; the union itself lives in uiStore (store layer must
// not import from components).
export type { CategoryId };

interface Category {
  id: CategoryId;
  label: string;
  Icon: ComponentType<{ size?: number }>;
  /** One-line description shown under the pane heading. */
  blurb: string;
}

const CATEGORIES: Category[] = [
  { id: "ai", label: "AI features", Icon: FiZap, blurb: "Each feature degrades to a non-AI baseline when off." },
  { id: "credits", label: "Credits", Icon: FiCreditCard, blurb: "Your AI credit balance, top-ups, and usage." },
  { id: "notifications", label: "Notifications", Icon: FiBell, blurb: "Which agent transitions raise a desktop banner." },
  { id: "appearance", label: "Appearance", Icon: FiEye, blurb: "Theme, text size, and how agents are ordered." },
  { id: "shortcuts", label: "Shortcuts", Icon: FiCommand, blurb: "Rebind keyboard shortcuts. Tap a modifier or press a combo." },
  { id: "workers", label: "Workers", Icon: FiCpu, blurb: "How many agents an orchestrator runs in parallel." },
  { id: "accounts", label: "Accounts", Icon: FiUsers, blurb: "Your Sparkle and Claude accounts." },
  { id: "mobile", label: "Mobile", Icon: FiSmartphone, blurb: "Pair your phone with this Mac and manage paired devices." },
  { id: "advanced", label: "Advanced", Icon: FiSliders, blurb: "Edit the configuration file directly." },
];

export interface SettingsDialogProps {
  /** Close the dialog (backdrop click, the ✕, or Escape — Escape is wired by the caller). */
  onClose: () => void;
  /** Open the existing Claude-accounts modal (the caller owns that modal + its login seam). */
  onManageAccounts: () => void;
  /** Which pane to open on (deep-open, e.g. BalanceBadge → Credits). Defaults to "ai". */
  initialCategory?: CategoryId;
}

export function SettingsDialog({ onClose, onManageAccounts, initialCategory }: SettingsDialogProps) {
  const [active, setActive] = useState<CategoryId>(initialCategory ?? "ai");
  // A deep-open request can also arrive while the dialog is ALREADY open (e.g. a future
  // low-balance toast while the user is in Settings) — follow the prop, don't just seed from it.
  useEffect(() => {
    if (initialCategory) setActive(initialCategory);
  }, [initialCategory]);
  // `active` is always one of CATEGORIES' ids, so find() can't miss.
  const current = CATEGORIES.find((c) => c.id === active) as Category;

  // Move keyboard focus into the dialog on open so screen-reader / keyboard users land inside
  // it (the trigger button keeps focus otherwise) and Escape/Tab anchor here.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <>
      <div data-testid="settings-backdrop" onClick={onClose} style={backdrop} />
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Settings" style={dialog}>
        <div style={titleBar}>
          <div style={{ fontSize: 15, fontWeight: FONT_WEIGHT.semibold }}>Settings</div>
          <button type="button" aria-label="Close settings" onClick={onClose} style={closeBtn}>
            <FiX size={18} />
          </button>
        </div>

        <div style={bodyRow}>
          {/* Category rail */}
          <nav aria-label="Settings categories" style={rail}>
            {CATEGORIES.map(({ id, label, Icon }) => {
              const selected = id === active;
              return (
                <button
                  key={id}
                  type="button"
                  aria-current={selected ? "page" : undefined}
                  onClick={() => setActive(id)}
                  style={{
                    ...railItem,
                    background: selected ? ROW_ACTIVE_BUBBLE : "transparent",
                    color: selected ? C.cream : C.muted,
                  }}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>

          {/* Active pane */}
          <section style={pane} aria-label={current.label}>
            <h2 style={paneHeading}>{current.label}</h2>
            <p style={paneBlurb}>{current.blurb}</p>
            <PaneBody id={active} onManageAccounts={onManageAccounts} />
          </section>
        </div>
      </div>
    </>
  );
}

/** Renders the controls for the selected category. Only the active pane mounts. */
function PaneBody({
  id,
  onManageAccounts,
}: {
  id: CategoryId;
  onManageAccounts: () => void;
}) {
  switch (id) {
    case "ai":
      return <AiFeaturesMenu />;
    case "credits":
      return <CreditsPanel />;
    case "notifications":
      return <NotificationsMenu />;
    case "appearance":
      return <AppearancePane />;
    case "shortcuts":
      return <KeyboardShortcutsMenu />;
    case "workers":
      return <WorkerLimitControl />;
    case "accounts":
      return <AccountsPane onManageAccounts={onManageAccounts} />;
    case "mobile":
      return <MobileDevicesPane />;
    case "advanced":
      return <AdvancedConfigMenu />;
  }
}

/** Sparkle account (sign in / sign out) on top, then the existing Claude/cloud accounts entry.
 *  Reads the auth store that AuthGate keeps fresh; sign-out clears the keychain token then
 *  resets the store, so AuthGate drops back to the welcome/trial view — that's expected. */
function AccountsPane({ onManageAccounts }: { onManageAccounts: () => void }) {
  const me = useAuthStore((s) => s.me);
  const tokenPresent = useAuthStore((s) => s.tokenPresent);
  const loading = useAuthStore((s) => s.loading);
  const [signingOut, setSigningOut] = useState(false);

  // Who to show: email is the identity users recognize; name and the raw Clerk id are
  // fallbacks. `me` can be null with a token present (e.g. offline) — still signed in,
  // just without a resolvable identity.
  const identity = me?.email ?? me?.name ?? me?.clerkUserId ?? null;

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut(); // clears the keychain token (best-effort, never rejects)
      useAuthStore.getState().reset();
    } catch (e) {
      // signOut's contract is never-reject; if that drifts, don't let the rejection escape the
      // void'd click handler unlogged — the button re-enabling below makes retry the recovery.
      console.error("Sign out failed:", e);
    } finally {
      // Always clear the flag: a rejection or a later sign-in from this same mounted pane must
      // not leave a wedged, disabled "Signing out…" button.
      setSigningOut(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <div style={subLabel}>Sparkle account</div>
        {loading ? (
          <div style={accountLine}>Checking sign-in status…</div>
        ) : tokenPresent ? (
          <div style={accountStack}>
            <div style={accountLine}>
              {identity ? (
                <>
                  Signed in as <span style={{ color: C.cream }}>{identity}</span>
                </>
              ) : (
                "Signed in"
              )}
            </div>
            <button
              type="button"
              style={fullButton}
              disabled={signingOut}
              onClick={() => void handleSignOut()}
            >
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        ) : (
          <div style={accountStack}>
            <div style={accountLine}>
              Not signed in — Sparkle is running in limited free-trial mode.
            </div>
            <button type="button" style={fullButton} onClick={() => void openSignIn()}>
              Sign in
            </button>
          </div>
        )}
      </div>
      <div>
        <div style={subLabel}>Cloud accounts</div>
        <div style={{ ...accountLine, marginBottom: 10 }}>
          The Claude accounts your agents run under.
        </div>
        <button type="button" style={fullButton} onClick={onManageAccounts}>
          Manage accounts…
        </button>
      </div>
    </div>
  );
}

/** Theme + Text size + Agent order, each under its own sub-label. */
function AppearancePane() {
  const zoom = useUiStore((s) => s.zoom);
  const zoomIn = useUiStore((s) => s.zoomIn);
  const zoomOut = useUiStore((s) => s.zoomOut);
  const resetZoom = useUiStore((s) => s.resetZoom);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={subLabel}>Theme</div>
        <ThemeToggle />
      </div>
      <div>
        <div style={subLabel}>Text size</div>
        {/* Right-sized stepper — no longer stretched across the whole panel. */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <button style={stepBtn} onClick={zoomOut} title="Zoom out (⌘−)">
            −
          </button>
          <button
            style={{ ...stepBtn, minWidth: 60, fontVariantNumeric: "tabular-nums" }}
            onClick={resetZoom}
            title="Reset to 100% (⌘0)"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button style={stepBtn} onClick={zoomIn} title="Zoom in (⌘+)">
            +
          </button>
        </div>
      </div>
      <div>
        <div style={subLabel}>Agent order</div>
        <AgentOrderToggle />
      </div>
      <div>
        <div style={subLabel}>After merge to main</div>
        <BranchCleanupToggle />
      </div>
    </div>
  );
}

// ── styles (inline CSSProperties, matching the file's existing convention) ──────────────────

const backdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 40,
  background: "rgba(0,0,0,0.55)",
};

const dialog: CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: 720,
  height: 520,
  maxWidth: "92vw",
  maxHeight: "86vh",
  display: "flex",
  flexDirection: "column",
  background: C.deepForest,
  border: `1px solid ${C.forest}`,
  borderRadius: 12,
  boxShadow: "0 24px 64px rgba(0,0,0,0.5)",
  zIndex: 41,
  overflow: "hidden",
  outline: "none", // focused on mount for a11y; no focus ring on the container itself
};

const titleBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 18px",
  borderBottom: `1px solid ${C.forest}`,
  flex: "none",
};

const closeBtn: CSSProperties = {
  display: "grid",
  placeItems: "center",
  background: "transparent",
  border: "none",
  color: C.muted,
  cursor: "pointer",
  padding: 4,
  borderRadius: 6,
};

const bodyRow: CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

const rail: CSSProperties = {
  width: 184,
  flex: "none",
  borderRight: `1px solid ${C.forest}`,
  background: C.forest,
  padding: "12px 9px",
  display: "flex",
  flexDirection: "column",
  gap: 3,
  overflowY: "auto",
};

const railItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 11,
  width: "100%",
  textAlign: "left",
  border: "none",
  borderRadius: 9,
  padding: "9px 11px",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  cursor: "pointer",
};

const pane: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "18px 20px",
  overflowY: "auto",
};

const paneHeading: CSSProperties = {
  margin: "0 0 3px",
  fontSize: 15,
  fontWeight: FONT_WEIGHT.semibold,
  color: C.cream,
};

const paneBlurb: CSSProperties = {
  margin: "0 0 16px",
  fontSize: 12,
  color: C.muted,
  lineHeight: 1.5,
};

const subLabel: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 1,
  color: C.muted,
  fontWeight: FONT_WEIGHT.semibold,
  marginBottom: 8,
};

const stepBtn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "6px 0",
  minWidth: 34,
  cursor: "pointer",
  fontSize: 14,
  fontFamily: '"IBM Plex Sans", sans-serif',
  textAlign: "center",
};

const accountStack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 10,
};

const accountLine: CSSProperties = {
  fontSize: 13,
  color: C.muted,
  lineHeight: 1.5,
};

const fullButton: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 8,
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  textAlign: "left",
};
