import { useEffect, useMemo, useRef, useState, type CSSProperties, type ComponentType } from "react";
import { FiZap, FiBell, FiCreditCard, FiEye, FiCpu, FiUsers, FiSliders, FiX, FiCommand, FiSmartphone, FiMic, FiTool, FiSearch, FiCheckCircle, FiCloud, FiLock, FiTrendingUp } from "react-icons/fi";
import { C, ROW_ACTIVE_BUBBLE } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { openSignIn, signOut } from "../services/sparkleApi";
import { authIdentity } from "../services/entitlement";
import { fetchTrial } from "../services/trialApi";
import { useAuthStore } from "../stores/authStore";
import { useCloudAuthStore } from "../stores/cloudAuthStore";
import { useUiStore, type CategoryId } from "../stores/uiStore";
import { AiFeaturesMenu } from "./AiFeaturesMenu";
import { NotificationsMenu } from "./NotificationsMenu";
import { ThemeToggle } from "./ThemeToggle";
import { BranchCleanupToggle } from "./BranchCleanupToggle";
import { WorkerLimitControl } from "./WorkerLimitControl";
import { AdvancedConfigMenu } from "./AdvancedConfigMenu";
import { MobileDevicesPane } from "./MobileDevicesPane";
import { KeyboardShortcutsMenu } from "./KeyboardShortcutsMenu";
import { CreditsPanel } from "./CreditsPanel";
import { SpendPane } from "./SpendPane";
import { VoiceControlsMenu } from "./VoiceControlsMenu";
import { ToolsPane, TOOLS_SEARCH_ENTRIES } from "./ToolsPane";
import { categoryEntries, matchesAny, paneQueryFor } from "../engine/settingsSearch";
import { ApprovalsMenu } from "./ApprovalsMenu";
import { CloudAuthPane } from "./CloudAuthPane";
import { OnePasswordPane } from "./OnePasswordPane";
import { useCloudAgentsEnabled } from "../hooks/useCloudAgents";
import { useSettingsStore } from "../stores/settingsStore";

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
  /** Extra search terms the rail matches on, beyond the visible label — so e.g. "voice" or
   *  "review" or "github" surfaces the Tools category via the tools it contains. */
  keywords?: readonly string[];
  /** True for a category whose PANE filters its own rows with the same query (currently only
   *  Tools). Those categories are matched entry-by-entry, where an entry is one row's searchable
   *  text, so the rail asks what the pane will ask rather than an approximation of it.
   *
   *  Three rules together keep a searched pane from opening onto an empty state, and none is
   *  sufficient alone: per-entry matching (a cross-row query surfaces nothing), the label prefix in
   *  `categoryEntries` (so "tools github" doesn't lose the category), and `paneQuery` stripping the
   *  label terms and standing down when the query was about a DIFFERENT pane.
   *
   *  The third rule has a cost worth knowing: standing down means the pane shows rows the query
   *  excludes. That is right when the query named another category, and wrong the moment it is
   *  generalized — keying it on "the filter came back empty" instead made typing one character past
   *  the last match EXPAND the pane from one row to all of them. It keys on another category having
   *  survived for that reason.
   *
   *  A residual remains, and it is inherent rather than a bug to fix: a query that PIVOTS from this
   *  category to another necessarily widens this pane. On Tools, "b" narrows to 8 of 9 rows, and
   *  "bi" — which matches no Tools row but does match Credits ("billing") — stands the filter down
   *  and swings back to 9. Every alternative rule is worse: filtering by a query the user is now
   *  aiming at a different category is what produced the "No tools match" dead ends above. */
  filtersRows?: boolean;
}

/** The searchable identity of the Tools category, exported so tests build the rail's entries from
 *  the SAME values production does. A test that hand-writes `("Tools", …, true)` is a copy that
 *  stays exact until the label or the flag changes — the drift that had the invariant suite
 *  validating strings the rail no longer emitted. */
export const TOOLS_CATEGORY = {
  label: "Tools",
  keywords: TOOLS_SEARCH_ENTRIES,
  filtersRows: true,
} as const;

const CATEGORIES: Category[] = [
  { id: "ai", label: "AI features", Icon: FiZap, blurb: "Each feature degrades to a non-AI baseline when off.", keywords: ["composer dictation deepgram voice auto-rename suggested actions"] },
  { id: "tools", ...TOOLS_CATEGORY, Icon: FiTool, blurb: "The opinionated stack that powers Sparkle — toggle what you use." },
  { id: "credits", label: "Credits", Icon: FiCreditCard, blurb: "Your AI credit balance, top-ups, and usage.", keywords: ["balance top-up billing payment"] },
  { id: "spend", label: "History & Spend", Icon: FiTrendingUp, blurb: "Token usage and estimated cost, read locally from your Claude Code transcripts.", keywords: ["tokens spend cost usage analytics history transcripts money dollars burn rate cache model project session"] },
  { id: "notifications", label: "Notifications", Icon: FiBell, blurb: "Which agent transitions raise a desktop banner.", keywords: ["banner alerts desktop"] },
  { id: "appearance", label: "Appearance", Icon: FiEye, blurb: "Theme, text size, and how agents are ordered.", keywords: ["theme dark light text size zoom agent order"] },
  { id: "shortcuts", label: "Shortcuts", Icon: FiCommand, blurb: "Rebind keyboard shortcuts. Tap a modifier or press a combo.", keywords: ["keyboard keybindings hotkeys"] },
  { id: "workers", label: "Workers", Icon: FiCpu, blurb: "How many agents an orchestrator runs in parallel.", keywords: ["concurrency parallel agents"] },
  { id: "accounts", label: "Accounts", Icon: FiUsers, blurb: "Your Sparkle and Claude accounts.", keywords: ["sign in sign out claude sparkle login install id crash report support"] },
  { id: "cloudauth", label: "Claude auth for cloud agents", Icon: FiCloud, blurb: "The Claude credential your cloud agents run with. Stored encrypted; never shown again.", keywords: ["cloud agents anthropic api key byok subscription setup-token credential sandbox"] },
  { id: "onepassword", label: "1Password", Icon: FiLock, blurb: "Back your .env files up to a vault, and restore them into fresh agent worktrees.", keywords: ["1password onepassword op cli env dotenv secrets vault backup restore seed worktree"] },
  { id: "mobile", label: "Mobile", Icon: FiSmartphone, blurb: "Pair your phone with this Mac and manage paired devices.", keywords: ["phone pair devices"] },
  { id: "voice", label: "Voice controls", Icon: FiMic, blurb: "Wake word, stop word, and what happens when you submit.", keywords: ["wake word stop word dictation microphone"] },
  { id: "approvals", label: "Auto-approve", Icon: FiCheckCircle, blurb: "Auto-answer Claude Code permission prompts, and choose how to auto-resume large sessions.", keywords: ["auto-approve approvals permission prompts skills commands bash edits mcp tools fetch remember yes nudge resume session summary full continue"] },
  { id: "advanced", label: "Advanced", Icon: FiSliders, blurb: "Edit the configuration file directly.", keywords: ["config toml file raw editor"] },
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

  // Cloud Agents ships dark (spec §Feature flag): the "Claude auth for cloud agents" category
  // exists only for an account the SERVER has advertised the capability to. A local-only user must
  // see no trace of it — not in the rail, not in search results.
  const cloudEnabled = useCloudAgentsEnabled();
  // The 1Password pane follows its Tools switch: it only has anything to say once the user has
  // opted the tool in, and a rail entry for a tool you've never turned on is noise. Turning the
  // switch on makes it appear immediately (the Tools hint says where to go).
  const onepasswordEnabled = useSettingsStore((s) => s.onepasswordEnabled);
  const categories = useMemo(
    () =>
      CATEGORIES.filter(
        (c) =>
          (cloudEnabled || c.id !== "cloudauth") &&
          (onepasswordEnabled || c.id !== "onepassword"),
      ),
    [cloudEnabled, onepasswordEnabled],
  );
  // `active` is normally one of `categories`' ids — but a deep-link can name a category that this
  // account doesn't have (a cloudauth link resolved just as the capability went away), so fall back
  // to the first pane rather than rendering `undefined`.
  const current = categories.find((c) => c.id === active) ?? categories[0]!;

  // Rail search: filter the categories by label OR their keyword set, so "voice" surfaces both
  // "Voice controls" and "Tools" (Deepgram). The query is ALSO passed into the active pane so it
  // filters that pane's rows too (currently the Tools pane). Trimmed + lowercased once.
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      q
        ? categories.filter((c) => matchesAny(categoryEntries(c.label, c.keywords ?? [], c.filtersRows), q))
        : categories,
    [q, categories],
  );
  // What the PANE filters its rows by, which is not always what the rail matched on. See
  // `paneQueryFor`: the terms naming the category are dropped, because no row answers to them.
  //
  // The pane also stands down for a query that has nothing to do with it — type "credits" while
  // sitting on Tools and the rail correctly narrows to Credits, but the Tools pane is still mounted
  // and would render `No tools match "credits"`. That query was never about its rows.
  //
  // "Demonstrably about another pane" means ANOTHER CATEGORY MATCHED, not "the filter came back
  // empty". Those look alike and behave oppositely: a query matching nothing anywhere is still
  // about this pane — the user narrowed past the last row — so the pane must keep filtering and
  // show its empty state. Keying on the empty filter made typing one character past the last match
  // EXPAND Tools from one row to all eleven, next to a rail reading "No settings match".
  //
  // This lives in the dialog rather than the pane because both facts — the label, and whether some
  // other category was searched for — belong to the rail; a pane knows neither.
  const someOtherCategoryMatched = filtered.length > 0 && !filtered.some((c) => c.id === current.id);
  const paneQuery = someOtherCategoryMatched ? "" : paneQueryFor(current.label, q);

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
            <div style={searchWrap}>
              <FiSearch size={14} style={searchIcon} aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings…"
                aria-label="Search settings"
                spellCheck={false}
                style={searchInput}
              />
            </div>
            {filtered.length === 0 ? (
              <div style={railEmpty}>No settings match “{query.trim()}”.</div>
            ) : (
              filtered.map(({ id, label, Icon }) => {
                const selected = id === current.id;
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
              })
            )}
          </nav>

          {/* Active pane */}
          <section style={pane} aria-label={current.label}>
            <h2 style={paneHeading}>{current.label}</h2>
            <p style={paneBlurb}>{current.blurb}</p>
            {/* `current`, not `active`: when a deep-link names a category this account doesn't
                have, the heading and the body must agree on the fallback pane. */}
            <PaneBody id={current.id} query={paneQuery} onManageAccounts={onManageAccounts} />
          </section>
        </div>
      </div>
    </>
  );
}

/** Renders the controls for the selected category. Only the active pane mounts. */
function PaneBody({
  id,
  query,
  onManageAccounts,
}: {
  id: CategoryId;
  query: string;
  onManageAccounts: () => void;
}) {
  switch (id) {
    case "ai":
      return <AiFeaturesMenu />;
    case "tools":
      return <ToolsPane query={query} />;
    case "credits":
      return <CreditsPanel />;
    case "spend":
      return <SpendPane />;
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
    case "cloudauth":
      return <CloudAuthPane />;
    case "onepassword":
      return <OnePasswordPane />;
    case "mobile":
      return <MobileDevicesPane />;
    case "voice":
      return <VoiceControlsMenu />;
    case "approvals":
      return <ApprovalsMenu />;
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

  // Who to show — the SAME shared source as the TopBar avatar/label (authIdentity), so the two can
  // never disagree on precedence or blank-handling. It resolves name → email and returns null when
  // neither is present, so a token-present user with no resolvable identity (offline, or a degraded
  // /me whose Clerk profile lookup soft-failed) renders a clean "Signed in" rather than the opaque
  // `user_…` clerkUserId.
  const identity = authIdentity(me);

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      await signOut(); // clears the keychain token (best-effort, never rejects)
      useAuthStore.getState().reset();
      // The Claude-auth probe state is per-ACCOUNT: without this, the next account signed in on
      // this process inherits the previous account's "credential saved" reading and the cloud
      // creation gate skips its no_auth prompt into a guaranteed 400 (roborev 46287).
      useCloudAuthStore.getState().reset();
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
      <InstallIdRow />
    </div>
  );
}

/** This install's anonymous id (trial.rs mints one 32-hex value per install and persists it to
 *  trial.json). It is the identifier on every crash report and usage event we receive, and until
 *  now it was rendered NOWHERE — which made an emailed crash report unattributable even to
 *  yourself, and made "send me your install id" impossible to ask of a user.
 *
 *  Degrades quietly: outside the real Tauri webview (a plain-browser dev preview) there is no
 *  install id at all, and a throwing/empty command is treated the same way — render the
 *  unavailable line rather than an empty monospace box or a raw error. */
function InstallIdRow() {
  const [installId, setInstallId] = useState<string | null>(null);
  // "preview" (no Tauri) and "failed" (IPC threw / empty id) are DIFFERENT: inside the real app
  // "Not available in this preview" is factually wrong, and it would mislead exactly the user
  // who has been asked to read their install ID out to support.
  const [state, setState] = useState<"loading" | "ready" | "preview" | "failed">("loading");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    // Same guard usageTelemetry.ts uses: only resolve inside the real Tauri webview.
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
      setState("preview");
      return;
    }
    void fetchTrial()
      .then((t) => {
        if (!alive) return;
        if (t.installId) {
          setInstallId(t.installId);
          setState("ready");
        } else {
          setState("failed");
        }
      })
      .catch(() => {
        if (alive) setState("failed");
      });
    return () => {
      alive = false;
    };
  }, []);

  // Reset the confirmation after a moment so the button doesn't read "Copied" forever.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    if (!installId) return;
    try {
      await navigator.clipboard.writeText(installId);
      setCopied(true);
    } catch (e) {
      // A denied/absent clipboard must not throw out of the void'd click handler. The id stays
      // selectable on screen, so manual copy remains the recovery.
      console.error("Copy install ID failed:", e);
    }
  };

  return (
    <div>
      <div style={subLabel}>Install ID</div>
      <div style={{ ...accountLine, marginBottom: 10 }}>
        Identifies this install in crash and usage reports. It carries no personal information —
        safe to share with support.
      </div>
      {state === "ready" && installId ? (
        <div style={accountStack}>
          <code data-testid="install-id" style={installIdValue}>
            {installId}
          </code>
          <button type="button" style={fullButton} onClick={() => void handleCopy()}>
            {copied ? "Copied" : "Copy install ID"}
          </button>
        </div>
      ) : (
        <div style={accountLine}>
          {state === "loading"
            ? "Reading install ID…"
            : state === "preview"
              ? "Not available in this preview."
              : "Install ID unavailable. Restarting Sparkle usually fixes this."}
        </div>
      )}
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
  border: `1px solid ${C.hairline}`,
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
  borderBottom: `1px solid ${C.hairline}`,
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
  borderRight: `1px solid ${C.hairline}`,
  background: C.forest,
  padding: "12px 9px",
  display: "flex",
  flexDirection: "column",
  gap: 3,
  overflowY: "auto",
};

const searchWrap: CSSProperties = {
  position: "relative",
  marginBottom: 6,
  flex: "none",
};

const searchIcon: CSSProperties = {
  position: "absolute",
  left: 9,
  top: "50%",
  transform: "translateY(-50%)",
  color: C.muted,
  pointerEvents: "none",
};

const searchInput: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: C.deepForest,
  color: C.cream,
  // The FILL stays `deepForest` (a well sunk into the `forest` rail); the BORDER is a hairline.
  // Excluding this as "already zero-contrast" only held for the border against its OWN fill —
  // the field sits in a rail painted `C.forest`, and that pair fell from 1.50:1 to 1.11:1 with
  // the repaint, so the box had no outer boundary left either. See theme/colors `hairline`.
  border: `1px solid ${C.hairline}`,
  borderRadius: 8,
  padding: "7px 10px 7px 28px",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  outline: "none",
};

const railEmpty: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  padding: "8px 11px",
  lineHeight: 1.4,
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

const installIdValue: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  color: C.cream,
  letterSpacing: 0.5,
  userSelect: "text",
  wordBreak: "break-all",
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
