import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { FiAlertTriangle, FiPause, FiRotateCw, FiSlash, FiUserPlus } from "react-icons/fi";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { FONT_UI, PILL, TYPE } from "../theme/scale";
import { tag } from "./labelTreatment";
import { AccountSpawnLog } from "./AccountSpawnLog";
import { MODAL_PADDING } from "./ModalShell";
import { readSpawnLog } from "../services/accountLedger";
import {
  listAccounts,
  getUsage,
  getIdentities,
  listCeilings,
  addAccount,
  setNickname,
  removeAccount,
  accountDisplay,
  forkNotice,
  duplicateAccountGroups,
  loginSiblingIds,
  identityKey,
  getPreferredAccountId,
  clearPreferredAccount,
  // The OBSERVED rate limit, shared with the spawn path's own fleet-target gates — see
  // `honouredFleetTarget`. One definition, so the header cannot disagree with the router about
  // whether an account is at its wall.
  isAccountExhausted,
  // The ROUTER's own definition of "signed in", shared for the same reason — see
  // `honouredFleetTarget`. Deliberately NOT the card-level `isSignedIn`: these are two different
  // predicates (email vs uuid-or-email) and the header must not hold the second opinion.
  signedInAccountIds,
  signedInFilterApplies,
  clearSwitchWrittenPins,
  getPin,
  setPin,
  clearPin,
  type Account,
  type Usage,
  type Identity,
  type LiveUsage,
} from "../services/accountStore";
import {
  stickyAccountSnapshot,
  isStickyAccountKey,
  CONCIERGE_ACCOUNT_KEY,
  SPARKLE_SELF_ACCOUNT_PREFIX,
} from "../services/accountSelection";
import { activateAccount } from "../hooks/useAccountSwitch";
import { paneAccountMap } from "../services/paneControl";
import { useProjectStore } from "../stores/projectStore";
import {
  assessHeadroom,
  rotationReadiness,
  exhaustionOutlook,
  switchRecommendation,
  describeRecommendation,
  leadName,
  type Ceiling,
} from "../services/headroom";
import {
  getAccountUsageLive,
  getAccountUsageLiveForced,
  isUsageUnknownError,
  isUsageRateLimitError,
  type AccountUsageLive,
} from "../services/accountUsage";
import {
  checkClaudeAuthStatus,
  authIsDefinitelyExpired,
  type ClaudeAuthStatus,
} from "../preflight";
import {
  orderBySpace,
  usageColor,
  USAGE_COLOR_HEX,
  formatResetCaption,
  collapsedRunningAgents,
  signInStalled,
  PENDING_NICKNAME,
  // Still read here for the expired-login card title, which renders it as a red status with a real
  // `reconnect` button rather than as a nickname. main dropped this import when it deleted the
  // rotation-box bullets that were the other reader.
  EXPIRED_LOGIN_NICKNAME,
  STALLED_SIGN_IN_TITLE,
  SIGN_IN_STALL_SECONDS,
} from "./accountsView";
import {
  accountRotationState,
  rotationLabel,
  rotationReasonLabel,
  rotationOutIds,
  electRotationPool,
  setAccountInRotation,
  rotationPause,
  pauseRotation,
  resumeRotation,
} from "../services/rotationState";

// Accounts settings screen for multi Claude Max account support (design spec
// docs/superpowers/specs/2026-06-26-multi-max-account-design.md). Lists each registered Claude
// config dir with its nickname, a "default" tag, per-window usage bars (5h / 7d) and an
// exhausted-until indicator; supports add / inline-rename / remove (the default can't be removed).
//
// ── The onLogin SEAM ──────────────────────────────────────────────────────────────────────────
// "Add account" creates an empty config dir via addAccount(), then needs to run the real
// `claude auth login` flow in that dir's CLAUDE_CONFIG_DIR so the user can OAuth into a Max account.
// Spawning the PTY lives on the spawn path (claudeSpawn / AgentPane), which this component must NOT
// import. So we hand the freshly-created Account back through the required `onLogin(account)` prop;
// the integrator wires it to a PTY `claude auth login` (env CLAUDE_CONFIG_DIR=account.configDir) —
// see AccountLoginModal, which owns the PTY and reports the identity that actually resolved.
//
// `onLogin` MAY return a promise that settles when the login window closes. When it does, we
// re-read identities afterwards, so the row shows the email the user just signed in as instead of
// the nickname they typed — and shows an explicit not-signed-in state when nothing resolved.
// Nothing here caps the number of accounts: add is a plain create-and-refresh loop, unbounded.

const DEPS = {
  listAccounts,
  getUsage,
  getIdentities,
  // Per-account LEARNED ceilings. Without these the screen can show how accounts compare to EACH
  // OTHER (the removed relative bars) but never how close any of them is to its OWN limit — which is
  // the number that decides whether rotation is about to matter.
  listCeilings,
  // REAL live per-account usage (Anthropic's own 5h/7d utilization), fetched per account by config
  // dir. Augments the relative token-tally bars with each account's ACTUAL server-side percent +
  // reset time. Injectable/mockable like every other IO; a per-account failure degrades that row to
  // "usage unavailable" and never blocks the screen (the local-tally `getUsage` stays the fallback).
  //
  // THE QUIET READER. It takes no `force` argument and cannot reach the keychain, so the mount
  // effect below — which re-fires on every account add/remove and every login — can never raise a
  // macOS confidential-information prompt. An account whose cached token has lapsed rejects with
  // `usage unknown: ` and its row degrades to the "usage unknown" affordance, which POINTS AT the
  // ⋮ → "Check usage levels" gesture rather than pretending something is broken.
  getUsageLive: getAccountUsageLive,
  // THE INTERACTIVE READER, and the ONLY dep on this screen that may prompt. Bound to exactly one
  // call site — the per-card ⋮ → "Check usage levels" handler, a click. Separate from `getUsageLive`
  // on purpose (see accountUsage.ts's header): with force as a boolean parameter, a later refactor
  // could hand a timer the loud behaviour by flipping an argument and nothing would fail. Wiring
  // THIS into an effect, poll or interval reintroduces `sparkle-dkxuf6` — don't.
  getUsageLiveForced: getAccountUsageLiveForced,
  // LIVE per-account login health: `claude auth status --json` for one config dir. This is what
  // tells an EXPIRED login (was signed in, the CLI now says no — `authIsDefinitelyExpired`) apart
  // from one that was NEVER signed in, so the card can say "reconnect" honestly instead of "never
  // completed" and offer a Renew Login control. NOT the stale recorded flag. Injectable like the
  // rest; a per-account failure degrades that row to its recorded state and never blocks the screen.
  getAuthStatus: checkClaudeAuthStatus,
  addAccount,
  setNickname,
  removeAccount,
  // The spawn ledger read. Injectable like every other IO on this screen — without it the panel
  // fell back to the real `invoke("accounts_spawn_log")` inside a component suite that mocks no
  // Tauri bridge, so the call rejected, resolved to [] outside `act()` after the assertions had
  // run, and the mount could not be asserted at all.
  readSpawnLog,
  // ── "Activate this account" and the who-runs-where list ───────────────────────────────────────
  // All module-level state readers rather than IPC, but injected for exactly the same reason the
  // IO above is: a component test that cannot substitute them has to reach into three global
  // registries to set up one assertion.
  /** Records the fleet-wide preference AND migrates already-running agents at safe boundaries. */
  activateAccount,
  getPreferredAccountId,
  clearPreferredAccount,
  /** Which account each MOUNTED pane is running under. See the coverage caveat rendered on screen. */
  paneAccountMap,
  /** The two sticky consumers' current accounts + their explicit pins. */
  stickyAccountSnapshot,
  getPin,
  setPin,
  clearPin,
  /** agentId → the name the user sees in the sidebar, so the list reads "Stripe Checkout Flow"
   *  rather than a uuid. Missing ids fall back to the id itself. */
  agentNames: (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of useProjectStore.getState().projects) {
      for (const a of p.agents ?? []) out[a.id] = a.name;
    }
    return out;
  },
  /** Drops the pins a PREVIOUS activation's migration wrote, so "Back to automatic" is actually
   *  automatic. Clearing the preference alone is not enough: a pin outranks it, and every mounted
   *  pane an activation moved carries one. */
  clearSwitchWrittenPins,
};
export type AccountsDeps = typeof DEPS;

export interface AccountsScreenProps {
  /** Integrator seam: invoked with the Account to launch the `claude auth login` PTY in
   *  `account.configDir`. See the block comment above. May return a promise that settles when the
   *  login window closes — we re-read identities after it, so the list reflects the identity that
   *  actually resolved rather than the one the user hoped for. */
  onLogin: (account: Account) => void | Promise<void>;
  /** IO overrides — defaults to the real accountStore functions. Injectable for tests. */
  deps?: Partial<AccountsDeps>;
  /** The account agents are actually running under, for the runway warning (AC9). Omitted, it is
   *  derived from `pickAccount` — the account a NEW spawn would land on right now — which is the
   *  honest answer this screen can compute without importing the spawn path. */
  currentAccountId?: string | null;
}

const fontStack = FONT_UI;

// How often the Accounts screen re-reads each dir's `.claude.json` to keep the DISPLAYED EMAIL live.
// The identity map is otherwise written only by `refresh()` (mount / add / rename / remove / login),
// so a login that swaps a dir's login from OUTSIDE this screen — a terminal `claude login`, an
// automatic rotation/failover, an expiry-and-reauth — would leave the row showing the PREVIOUS
// account's email until the user happened to trigger one of those gestures. A slow poll of the light
// `.claude.json`-only read (no keychain, no transcripts) keeps the shown email tracking the dir's
// CURRENT login instead of a stale cache. Slow on purpose: the email rarely changes, and this is a
// freshness backstop, not a hot path.
export const IDENTITY_REFRESH_MS = 15_000;

const card: CSSProperties = {
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: 12,
  marginBottom: 10,
  fontFamily: fontStack,
  color: C.cream,
};

const smallBtn: CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  color: C.cream,
  fontSize: 12,
  fontFamily: fontStack,
  padding: "4px 10px",
  cursor: "pointer",
};

const primaryBtn: CSSProperties = {
  ...smallBtn,
  background: C.teal,
  borderColor: C.teal,
  color: ON_BRAND_FILL,
};

/** A borderless inline text link (e.g. the "+ N more" / "Collapse" toggles in the running-agents
 *  list). Reads as a link, not a button, and inherits the surrounding font size. */
const linkBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: 0,
  margin: 0,
  // tealInk, not teal: `C.teal` is a FILL token (for painting a surface behind on-brand text), and
  // underlined link TEXT has to sit on a verifiable ink tier to stay legible on the page ground.
  color: C.tealInk,
  font: "inherit",
  cursor: "pointer",
  textDecoration: "underline",
};

/** One option inside the ⋮ kebab dropdown — full-width, left-aligned, borderless. */
const menuItem: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  color: C.cream,
  fontFamily: fontStack,
  fontSize: 12,
  padding: "8px 12px",
  cursor: "pointer",
};

const tagStyle: CSSProperties = { ...tag(C.accentInk), borderColor: C.teal };

// The "PRIMARY" badge was REMOVED (founder's overhaul): the list now reads as a flat, equal rotation
// with no crowned account. The activation MECHANISM stays — the per-card "Manual Override" button and
// the subtle inline "Active — new agents run here" indicator below it — but the badge/terminology is
// gone. `default` keeps its own outline tag (a different idea the founder did not ask to remove).

/** The screen's title bar, PINNED. "+ Add account" is the remedy every banner on this screen
 *  recommends, and it used to scroll with the page: the spawn ledger at the bottom grew unbounded,
 *  the dialog outgrew the window, and the one control the founder needed went off the top edge —
 *  in a panel whose own copy was telling him to sign in another account.
 *
 *  Two details are load-bearing, and each is a way this has already failed:
 *
 *  • FULL BLEED, SIDES ONLY. The scrollport is `ModalShell`'s body, which carries the dialog's
 *    inset. A sticky header that respects the SIDE inset leaves a `MODAL_PADDING`-wide gutter down
 *    each side with live content sliding up through it, so the horizontal inset is cancelled with
 *    negative left/right margins and re-added as padding — the header spans the card edge-to-edge
 *    while its content stays aligned with the rows below.
 *  • OPAQUE. `sticky` does not imply a background. Without one the ledger rows scroll straight
 *    THROUGH the title and the button, which is worse than the overflow it replaced.
 *
 *  NO NEGATIVE TOP MARGIN. It used to cancel the top inset too, to sit flush against the card's top
 *  edge — but paired with `position: sticky` that laid the following content out `MODAL_PADDING`px
 *  HIGHER than the header pins to when stuck, so the stuck header painted over the first rows: the
 *  intro line and the account cards' action buttons scrolled UNDER it (the founder's screenshot).
 *  With `margin-top: 0` the header reserves its own space cleanly and its stuck position matches
 *  that reserved space, so content passes below it rather than behind it. It sits at the
 *  scrollport's own top inset, which reads as ordinary breathing room above the title. The `top: 0`
 *  pin, the opaque plane and the z-index are unchanged — see AccountsScreen.reachability.test.tsx,
 *  which pins that contract.
 *
 *  THE `MODAL_PADDING` BAND ABOVE THE STUCK HEADER — see `headerTopCover`. This app runs in
 *  WKWebView (macOS Tauri), and WebKit resolves a sticky `top: 0` against the scroll container's
 *  CONTENT box, not its padding box: the scrollport here (`ModalShell`'s body) carries a
 *  `MODAL_PADDING` top inset, so the header pins `MODAL_PADDING`px BELOW the card's top edge and the
 *  rows scroll UP THROUGH that uncovered band — the green rotation/routing text bleeding above the
 *  title in the founder's report (measured in WKWebView: band = MODAL_PADDING; Chromium pins at the
 *  padding box and the band is 0, which is why it never reproduced in a browser preview). `top: 0`
 *  with a negative top margin cannot fix it — WebKit still pins at the content box, so that just
 *  brings back the overlap the note above records. The band is covered by an opaque plane instead. */
const stickyHeader: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  background: C.dialogSurface,
  margin: `0 -${MODAL_PADDING}px 10px`,
  padding: `0 ${MODAL_PADDING}px 8px`,
  borderBottom: `1px solid ${C.muted}`,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

/** The opaque plane that fills the `MODAL_PADDING` band between the card's top edge and where the
 *  sticky header pins in WebKit (see the `stickyHeader` note). It is a CHILD of the sticky header,
 *  positioned ABSOLUTELY so it adds no layout — reserving no flow space is what keeps it from
 *  reintroducing the overlap a negative top margin caused.
 *
 *  `left: 0 / right: 0`, NOT a negative bleed: the cover is positioned against the header's PADDING
 *  box, and the header is ALREADY full-bleed (`margin: 0 -${MODAL_PADDING}px …`), so that padding box
 *  already spans the modal body's scrollport edge-to-edge — `0/0` covers the side gutters too.
 *  Pulling it out another `MODAL_PADDING` per side pushes the right edge past the scrollport, and the
 *  body is `overflow-y: auto` (so `overflow-x` computes to `auto`): the overhang then makes the whole
 *  dialog horizontally scrollable, and a sideways swipe re-exposes the very gutters this covers
 *  (measured: +MODAL_PADDING of horizontal scrollable overflow in WKWebView).
 *
 *  Since it sits inside the header's `z-index: 2` stacking context it paints above the static rows
 *  scrolling underneath with no z-index of its own. Verified topmost across the full band width, with
 *  zero horizontal overflow, in WKWebView. */
const headerTopCover: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  top: -MODAL_PADDING,
  height: MODAL_PADDING,
  background: C.dialogSurface,
};

const inputStyle: CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  color: C.cream,
  fontSize: 13,
  fontFamily: fontStack,
  padding: "4px 8px",
};

/** The human-readable cause of a rejected IO call, or `fallback` when there is genuinely nothing.
 *
 * ══ A TAURI COMMAND REJECTS WITH A STRING, NOT AN `Error` ═══════════════════════════════════════
 * `Err(String)` on the Rust side arrives here as a bare JS string, so the reflex
 * `e instanceof Error ? e.message : "Failed to …"` is FALSE on exactly the errors this screen
 * exists to report — and it then discards the real message and shows its own generic one.
 *
 * That is not cosmetic. The founder hit a repeated "Failed to remove" that succeeded on a later
 * attempt, and the cause could not be recovered afterwards: the string Rust produced ("read
 * accounts.json: …", "rename accounts.json into place: …") was thrown away at this line, and the
 * generic fallback is not written to the log either. A whole class of backend failure on this
 * screen was unreportable by construction. Every catch site here now routes through this, so the
 * message the user sees is the message the backend actually sent.
 *
 * Deliberately not `String(e)`, which renders a plain object as "[object Object]" — that is how a
 * useless message gets ANOTHER way to happen. */
function errText(e: unknown, fallback: string): string {
  if (typeof e === "string" && e.trim() !== "") return e;
  if (e instanceof Error && e.message.trim() !== "") return e.message;
  return fallback;
}

/** Wall-clock time in the user's own locale ("8:20 PM"). One formatter, so the per-account line and
 *  the all-exhausted banner can never quote the same instant two different ways. */
function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Fixed width of the metric-label column so the Session and Weekly bars line up vertically. */
const USAGE_LABEL_WIDTH = 84;
/** Bar thickness — 2× the original 6px (overhaul item 8). */
const USAGE_BAR_HEIGHT = 12;

/** A REAL usage bar filled by Anthropic's actual utilization percent (0–100). Overhaul items 8/9/12/
 *  15: one ROW — label │ bar (flex) │ % — with the bar 2× thick and COLOUR-CODED by its own used
 *  percent, and a right-aligned reset caption on its own line beneath. `percent: null` (a window the
 *  server didn't report) renders "—" and an empty muted bar, never a fabricated 0%. `now` is passed
 *  in (never read from the clock here) so the caption is deterministic/testable. */
function LiveUsageBar({
  label,
  percent,
  resetsAt,
  now,
}: {
  label: string;
  percent: number | null;
  resetsAt: string | null;
  now: number;
}) {
  const known = percent != null;
  const pct = known ? Math.max(0, Math.min(100, percent)) : 0;
  const resetMs = resetsAt ? Date.parse(resetsAt) : NaN;
  // The reset caption is independent of the percent: each window's percent and reset instant are
  // separately nullable on the wire (accountUsage.ts), so a payload can carry "when do I get capacity
  // back" without a utilization figure. Gate the caption on the RESET parsing, not on `known`, so that
  // "when it resets" signal isn't dropped just because the percent for that window was omitted.
  const caption = !Number.isNaN(resetMs) ? formatResetCaption(now, resetMs) : null;
  // Colour by the account's OWN used percent (item 9); an unknown window stays muted.
  const barColor = known ? USAGE_COLOR_HEX[usageColor(pct)] : C.muted;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, color: C.muted, width: USAGE_LABEL_WIDTH, flexShrink: 0 }}>
          {label}
        </span>
        <div
          role="progressbar"
          aria-label={`${label} real usage`}
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          style={{
            flex: 1,
            minWidth: 0,
            height: USAGE_BAR_HEIGHT,
            // PILL, not `USAGE_BAR_HEIGHT / 2`: a capsule is the shape intended, and the scale
            // ratchet reads every numeric literal in the expression — the `2` counts as an
            // off-scale radius even though the value it computes (6) is on the scale.
            borderRadius: PILL,
            background: C.deepForest,
            border: `1px solid ${C.muted}`,
            overflow: "hidden",
          }}
        >
          <div style={{ width: `${pct}%`, height: "100%", background: barColor }} />
        </div>
        <span style={{ fontSize: 12, color: C.muted, width: 40, textAlign: "right", flexShrink: 0 }}>
          {known ? `${Math.round(percent)}%` : "—"}
        </span>
      </div>
      {caption && (
        <div style={{ fontSize: TYPE.micro, color: C.muted, marginTop: 2, textAlign: "right" }}>
          {caption}
        </div>
      )}
    </div>
  );
}

/** What one row's live-usage cell can hold. `"unknown"` and `"error"` are DELIBERATELY distinct —
 *  see {@link LiveUsageSection}. */
export type LiveUsageCell = AccountUsageLive | "error" | "unknown" | undefined;

/** The payload in a live cell, or null when the cell holds no figures (loading / unknown / error).
 *  One helper so every derivation that projects percentages folds the non-data states identically —
 *  a site that only checked `!== "error"` would read the string `"unknown"` as a usage object. */
function liveUsageData(live: LiveUsageCell): AccountUsageLive | null {
  return live === undefined || live === "error" || live === "unknown" ? null : live;
}

/** The REAL live-usage block for one account row. FOUR states, none of which may break the screen:
 *   - `undefined` (not fetched yet) → a muted "Loading real usage…";
 *   - `"unknown"` — the QUIET read had no usable cached token (`usage unknown: `). This is the
 *     ordinary, expected outcome for a healthy account whose cached OAuth token has lapsed: reading
 *     the keychain would answer it, and a background poll must never do that (see accountUsage.ts).
 *     So the row says so plainly and names the gesture that trues it up. It is NOT an error, and
 *     must not read like one — the polled path hits this constantly, and "check your connection or
 *     sign in again" would send the user chasing a problem that does not exist;
 *   - `"error"` (offline / 401 / unparseable body) → "Real usage unavailable", a genuine failure;
 *   - data → the two real percent bars.
 *
 *  In every non-data state the relative token-tally bars below remain the fallback. */
function LiveUsageSection({
  live,
  accountId,
  now,
}: {
  live: LiveUsageCell;
  accountId: string;
  now: number;
}) {
  if (live === undefined) {
    return (
      <div style={{ marginTop: 6, fontSize: 12, color: C.muted }}>Loading real usage…</div>
    );
  }
  if (live === "unknown") {
    return (
      <div
        data-testid={`account-usage-unknown-${accountId}`}
        style={{ marginTop: 6, fontSize: 12, color: C.muted }}
      >
        <span style={{ marginRight: 6 }}>—</span>
        Usage unknown. Use “Check usage levels” in this card’s ⋮ menu to true it up.
      </div>
    );
  }
  if (live === "error") {
    return (
      <div
        data-testid={`account-usage-unavailable-${accountId}`}
        style={{ marginTop: 6, fontSize: 12, color: C.muted }}
      >
        Real usage unavailable.
      </div>
    );
  }
  // The "REAL USAGE (ANTHROPIC)" section label was removed (overhaul item 5) — the two labelled bars
  // speak for themselves. The bars themselves stay.
  return (
    <div style={{ marginTop: 6 }}>
      <LiveUsageBar
        label="Session (5h)"
        percent={live.fiveHourPercent}
        resetsAt={live.fiveHourResetsAt}
        now={now}
      />
      <LiveUsageBar
        label="Weekly (7d)"
        percent={live.sevenDayPercent}
        resetsAt={live.sevenDayResetsAt}
        now={now}
      />
      {/* The "Billing: subscription / usage credits disarmed" MeterLine was REMOVED at the founder's
          instruction (2026-08-21 live session) — the billing/credit lines were noise on this screen.
          The usage bars stay; the credits meter still gates advisor passes in spendGate.ts. */}
    </div>
  );
}

// The fleet-level `AdvisorGateLine` ("Advisor passes are SKIPPING — …" / "Advisor passes can run
// — …") was REMOVED at the founder's instruction (2026-08-21 live session): the message was
// unintelligible to users and, as a top-of-view banner, disconnected from the account that caused
// it. Its unanimity fold (`checkSpendGateForAccounts`) still gates advisor passes in production
// (services/advisor/spendGate.ts) — only the on-screen sentence is gone.



function exhaustedLabel(usage: Usage | undefined, now: number): string | null {
  if (!usage?.exhaustedUntil || usage.exhaustedUntil <= now) return null;
  return `Exhausted until ${clockTime(usage.exhaustedUntil)}`;
}

/** True when a live-usage rejection means the account's LOGIN is dead, as opposed to a transient
 *  network/timeout/5xx or a "we couldn't answer" keychain miss (that last one is
 *  {@link isUsageUnknownError}, handled first and separately).
 *
 *  The one authoritative shape is the terminal-401 string `src-tauri/src/account_usage.rs` returns
 *  after it has dropped the cached token, re-read from source, and STILL been refused: `usage fetch
 *  failed: unauthorized after keychain re-read`. That is a cross-language contract — a proven-dead
 *  bearer token — so it, and not a generic network error, is what routes the "sign in again" remedy.
 *  Tolerates the three shapes a rejected Tauri `invoke` hands back, exactly like
 *  {@link isUsageUnknownError}. Anything else is NOT an auth failure and stays a transient error. */
function isUsageAuthError(err: unknown): boolean {
  const msg =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : typeof (err as { message?: unknown } | null)?.message === "string"
          ? (err as { message: string }).message
          : "";
  return msg.toLowerCase().includes("unauthorized");
}

/** A bordered notice in one ink — the shape every banner on this screen takes. */
function noticeCard(ink: string): CSSProperties {
  return { ...card, borderColor: ink, color: ink, fontSize: 12, lineHeight: 1.5 };
}

// ── The estimated "usual limit" HEADROOM BAR was REMOVED here (founder's instruction) ───────────
// `HeadroomLine` + its `HEADROOM_TONE` rendered a yellow "Close to its limit — 6.8M of about 7.5M ·
// 90% of its usual limit / Stops taking new agents at 90% of that" bar on every account card. It was
// the LEARNED-CEILING estimate, and it misfired: it screamed "90%, close to the wall" while the REAL
// USAGE (ANTHROPIC) section right below it — the `LiveUsageSection` that STAYS — showed the account
// comfortably clear (session 39% / weekly 71% on the founder's card). A confident estimate that
// contradicts the real number beside it is a liability, not a fallback, so the real Anthropic
// figures are the source of truth for this card now. The estimate no longer drives BEHAVIOUR either
// — see `accountStore.partitionAccounts` (the spawn gate) and `headroom.switchRecommendation` (the
// proactive nudge), both of which stopped acting on it in the same change.

/** THE HEADLINE OF THIS SCREEN: how many accounts can actually receive a spawn.
 *
 *  It exists because the count a user can SEE (rows in the list) is not the count that governs
 *  rotation (distinct signed-in logins), and on the machine this was built for those numbers were 2
 *  and 1. With a pool of one, `pickAccount` returns the same account every single time — rotation is
 *  not failing, it is arithmetically impossible — and nothing on screen said so, so the visible
 *  evidence supported exactly the wrong diagnosis.
 *
 *  Counting is delegated to {@link rotationReadiness}, which derives signed-in-ness from the same
 *  predicate selection uses and sameness from the canonical grouping. This component only renders. */

// ── THE BULLET LIST IS GONE ──────────────────────────────────────────────────────────────────────
// `groupExcluded` and the "counted out" `<ul>` lived here. They named every registration that did not
// count toward rotation and why — "“Signing in…” is registered but has never been signed in, so it
// cannot receive agents", "N accounts are the same Claude login…" — and the founder read that block
// out loud and could not parse it: "I don't know what that means. I don't know what sign ing in is.
// I don't know what log in is."
//
// He was right, and the reason is structural rather than a matter of wording. The bullets described
// ACCOUNTS from a banner sitting several rows above them, so each one had to re-identify its subject
// by quoting a nickname — and the nicknames it was quoting are the generic placeholders
// ("Signing in…", "Login expired — reconnect") that two different rows can share, which is why the
// block needed collapsing logic and a paragraph of comments about React keys in the first place. The
// information is not lost: every one of those facts is now a dot and a two-word label on the card it
// is ABOUT, derived from `accountRotationState`, where it needs no quoting and cannot collide.

/** THE GLANCE, at the top of the screen and above the fold: is rotation running, how many accounts
 *  can actually receive a spawn, and where the next agent goes.
 *
 *  The founder's layout, in his words: "the green circular icon … make that bigger and put it to the
 *  left of where it says cloud accounts, and then below it, it should say rotation active in green".
 *  And the control: "there would just be a pause button. And I could pause the fleet rotation … then
 *  it would say rotation paused, and it would have the two line pause icon instead of rotation
 *  active. And if I click it again, then it goes back to rotation active."
 *
 *  THE ICON IS THE BUTTON. He described the big icon and the pause control in the same place, one
 *  after the other, and two adjacent controls that both mean "rotation" would be one too many: the
 *  icon already shows the state, so making it the toggle means the thing you look at to know and the
 *  thing you press to change it are the same object.
 *
 *  THE COUNT IS THE POOL, NOT THE ROSTER. `available` is passed in already netted of manual
 *  opt-outs — see its use in `AccountsScreen`. A header reading "6 accounts available" over rows
 *  marked out of rotation is precisely the contradiction this screen was rebuilt to stop. */
function RotationGlance({
  available,
  soleName,
  paused,
  onToggle,
  onAdd,
  adding,
  loading,
  overrideName,
  anySignedIn,
  expiredOut,
  takenOut,
}: {
  /** How many accounts can receive a spawn right now: signed in, not a duplicate, not taken out. */
  available: number;
  /** The one account's verified name when `available === 1` — never the nickname, which is
   *  user-typed and proves nothing about which login a config dir holds. */
  soleName: string | null;
  /** Whether ANY account is signed in, before the pool's exclusions. */
  anySignedIn: boolean;
  /** How many signed-in logins are out of the pool because their live session is DEAD, and how many
   *  for any other reason the user can reverse. The empty-pool copy is built from the mix rather
   *  than asserting a single cause — see the derivation in `AccountsScreen`. */
  expiredOut: number;
  takenOut: number;
  paused: boolean;
  /** The account a MANUAL OVERRIDE is sending every new agent to, or null when routing is automatic.
   *
   *  Distinct from the pause and it has to be: a pause HOLDS new agents entirely, an override
   *  replaces the ranking with one account. The reason it is stated up here at all is that without it the header
   *  reads "Rotation active: 2 accounts available" while a card down the list is quietly taking every
   *  spawn — the same count-contradicts-the-rows defect the count itself was fixed for, arriving
   *  from the other direction. Only ever set when the override names an account that is genuinely in
   *  the router would actually honour — see `honouredFleetTarget`, which applies exactly the gates
   *  `usablePreferredAccount` applies, no more and no less. Stricter would be as wrong as looser:
   *  dropping the line for a target the router IS using says routing is automatic when it is not. */
  overrideName: string | null;
  onToggle: () => void;
  onAdd: () => void;
  adding: boolean;
  /** The first accounts read has not resolved yet. Every count below is 0 in that state and would
   *  read as "No account is signed in" — the same false-empty flash the list's own skeleton guards
   *  against, and worse here because this is the line stating the fleet's health. */
  loading: boolean;
}) {
  const rotates = !loading && available >= 2;
  const Icon = loading
    ? FiRotateCw
    : paused
      ? FiPause
      : available === 0
        ? FiSlash
        : rotates
          ? FiRotateCw
          : FiAlertTriangle;
  // GREEN ONLY FOR A POOL THAT ACTUALLY ROTATES. "Do not display status as green when the account has
  // not yet been signed in" was said about a card, but the same rule has to hold here or the header
  // becomes the last green thing on a screen full of red ones.
  const ink = loading || paused ? C.muted : rotates ? C.successInk : C.dangerInk;
  const stateLabel = loading
    ? "reading accounts"
    : paused
      ? "rotation paused"
      : rotates
        ? "rotation active"
        : "rotation stalled";

  const headline = loading
    ? "Reading your accounts…"
    : paused
    ? "Rotation paused — new agents are held"
    : available === 0
      ? // See `expiredOut` / `takenOut` for why this is a mix rather than a single cause.
        expiredOut > 0 && takenOut === 0
        ? expiredOut === 1
          ? "This account's login has expired"
          : "Every account's login has expired"
        : anySignedIn
          ? "No account is in rotation"
          : "No account is signed in"
      : available === 1
        ? "Only 1 account is in rotation"
        : `Rotation active: ${available} accounts available`;

  // ORDER IS LOAD-BEARING, and getting it wrong put two contradicting sentences on screen. The
  // the fleet-target line (`overrideName`) used to be evaluated FIRST, and once
  // `honouredFleetTarget` was loosened to match the router it can name an account that is NOT in the
  // pool — a duplicate, or one whose live session is dead. On a one-account install with a dead
  // session and that account preferred (which the auto-switch path writes on its own), the header
  // read "Every account's login has expired" over "Manual override: every new agent runs on Only…",
  // and the reconnect remedy the copy points at was unreachable.
  //
  // AN EMPTY POOL IS THE MORE FUNDAMENTAL FACT and it is the one carrying a remedy, so it wins.
  // Nothing is hidden by the reorder: the headline still reads "Rotation paused" when it is, and the
  // card holding the override still reads "Back to automatic".
  const body = loading
    ? "Nothing is claimed about the pool until that read comes back."
    : available === 0
      ? anySignedIn
        ? // BUILT FROM THE MIX. Each clause names only what is actually true, and each names the
          // remedy that applies to IT — a reconnect for a dead session, the ⋮ menu for an opt-out.
          // Naming the menu for an expired row sends the user to a control that is greyed out for
          // exactly the reason they are standing there.
          [
            expiredOut > 0
              ? `${expiredOut === 1 ? "One account's session is" : `${expiredOut} accounts' sessions are`} dead — reconnect from the card.`
              : null,
            takenOut > 0
              ? `${takenOut === 1 ? "One account is" : `${takenOut} accounts are`} out of rotation by your own choice — put one back from its ⋮ menu.`
              : null,
            // WHERE THE WORK IS ACTUALLY GOING, and it is not always least-bad. Neither
            // `usablePreferredAccount` nor `usablePausedAccount` gates on duplication or on the auth
            // probe, so a fleet target routinely SURVIVES an empty pool — an expired account that
            // also holds the preference (which the auto-switch arm writes without anyone clicking)
            // takes every spawn while this line, unconditionally, said least-bad. That is the
            // inverse contradiction the previous commit removed from the non-empty case, walking
            // back in through the one state the user is most likely to be reading.
            overrideName
              ? `Every new agent still runs on ${overrideName} — the manual override outranks all of this.`
              : paused
                ? "New agents are held by the pause — none will start until you restart rotation."
                : "New agents still run on the least-bad account until then.",
          ]
            .filter(Boolean)
            .join(" ")
        : "Agents will run on whatever your terminal is logged into. Sparkle has no account of its own to hand them."
      : // THE OVERRIDE OUTRANKS THE PAUSE, matching the router: `chooseAccountForAgent` consults the
        // preference BEFORE the freeze, so an activation made while paused really does win. Stated
        // the other way round, the header read "New agents stay on X until you resume" while every
        // spawn was going to Y — and an accepted `switch_all` from the concierge reaches exactly that
        // state without anyone touching this screen.
        overrideName
        ? `Manual override: every new agent runs on ${overrideName} until you switch that card back to automatic.${paused ? " Rotation is paused, and this override outranks the hold." : ""}`
        : paused
          ? "New agents are held — none will start, and no new account spend begins, until you restart. Running agents keep going."
          : available === 1
            ? `Every agent runs on ${soleName ?? "it"} until it hits its limit. Sign in another account to enable rotation.`
            : "New agents go to whichever account has the most room left.";

  return (
    <div data-testid="accounts-header" style={stickyHeader}>
      {/* Opaque cover for the WebKit sticky band above the header — see `headerTopCover`. Presentational
          only; kept out of the accessibility tree. */}
      <div aria-hidden data-testid="accounts-header-top-cover" style={headerTopCover} />
      <button
        type="button"
        data-testid="rotation-toggle"
        aria-pressed={paused}
        onClick={onToggle}
        title={
          paused
            ? "Restart rotation — resume handing accounts to new agents so the fleet can spawn again."
            : "Pause rotation — hold new agents so no new account spend starts. Running agents keep going; restart any time."
        }
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 2,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
          color: ink,
          fontFamily: fontStack,
          flexShrink: 0,
        }}
      >
        <Icon size={22} aria-hidden />
        <span data-testid="rotation-state-label" style={{ fontSize: 10, fontWeight: 600 }}>
          {stateLabel}
        </span>
      </button>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Claude accounts</div>
        <div data-testid="rotation-headline" style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
          {headline}
        </div>
        <div style={{ fontSize: 12, color: C.muted }}>{body}</div>
      </div>
      {/* The per-account "counted out" bullets were REMOVED from the rotation box at the founder's
          instruction (2026-08-21 live session): the terminology was unclear and the box should be a
          simple non-scrolling headline + routing line. WHY each account is out of rotation belongs on
          that account's own row — main's note here called that "a later chunk", and it is the
          per-account rotation dot this branch adds. */}
      {/* The global "Refresh usage" button was replaced by a per-card "Check usage levels" item in
          each card's ⋮ kebab menu (overhaul item 14).

          ONE LABEL, ALWAYS. The banner this header replaced varied its CTA by state — "Add an
          account" / "Add another account" — which made sense inside a banner whose whole subject was
          the missing account. Up here it is the screen's standing action, and a control that renames
          itself as the fleet changes is harder to find, not easier. The icon carries the urgency
          instead: it is red with a slash when nothing is signed in. */}
      {!adding && (
        <button type="button" style={primaryBtn} onClick={onAdd}>
          <FiUserPlus size={12} aria-hidden style={{ verticalAlign: "-1px", marginRight: 4 }} />
          + Add account
        </button>
      )}
    </div>
  );
}

// The "Adding a Claude account takes two minutes" step list and the "Each account is a separate
// Claude login…" paragraph both lived here. Both are DELETED at the founder's instruction
// (sparkle-cjpte): the controls carry the meaning now. "+ Add account", the account rows, the
// per-row "Finish sign-in" and the usage bars are all unchanged — only the prose that described
// them is gone.

/** Whether this account has a real Claude login. Derived from accountUuid OR email: the Rust
 *  `AccountIdentity` allows those independently, and `duplicateAccountGroups` matches on the
 *  identity key (uuid when recorded, else email — see `accountStore.identityKey`),
 *  so keying the login button on email alone could render "Log in" for an account that IS signed in
 *  (and even tint it as a duplicate at the same time). One definition, shared by every affordance. */
function isSignedIn(identity: Identity | undefined): boolean {
  return !!(identity?.accountUuid || identity?.email);
}

/** The row's effective login health, folding the LIVE `claude auth status` probe over the recorded
 *  identity. `signedIn` is the identity read (a live `oauthAccount` in the config dir). `auth` is
 *  the CLI probe: an answer, `"error"` (couldn't run), or `undefined` (not probed yet).
 *
 *  The probe is authoritative only where it is DECISIVE, and only to make things worse, never better:
 *  it can flag an account that reads "signed in" as actually EXPIRED — the case the recorded identity
 *  misses, and the whole reason this exists (a dead OAuth session whose `.claude.json` still names an
 *  email). A probe that errored or is pending defers to `signedIn`, so a flaky `claude auth status`
 *  can never manufacture a false EXPIRED and never downgrade a genuinely healthy account.
 *
 *   • "healthy"   — usable now;
 *   • "expired"   — was signed in, the CLI now says the session is dead (`authIsDefinitelyExpired`);
 *   • "signedOut" — no live login and the probe didn't contradict it (never completed, or expired
 *                   and Claude Code already cleared `oauthAccount`). */
export type RowLogin = "healthy" | "expired" | "signedOut";
export function deriveRowLogin(
  signedIn: boolean,
  auth: ClaudeAuthStatus | "error" | undefined,
): RowLogin {
  const probed = auth && auth !== "error" ? auth : null;
  // The one thing the probe adds over identity: catching a "signed-in"-looking but dead session.
  if (probed && authIsDefinitelyExpired(probed)) return "expired";
  if (signedIn) return "healthy";
  // Not signed in per the live identity read — decisive on its own; the probe only refines WHY.
  return "signedOut";
}

/** What the identity slot says for a login that IS real (it has an `accountUuid`) but carries no
 *  readable email. It is neither the email (there isn't one) nor "Not signed in" (that would be a
 *  lie in the other direction) nor the nickname (never evidence of anything).
 *
 *  NOTE this state is currently UNREACHABLE from the Rust side — `read_oauth_identity_at` refuses
 *  an `oauthAccount` with no non-empty `emailAddress`, so a non-null `accountUuid` implies a
 *  non-null `email` on the wire. It is rendered anyway because `isSignedIn` below (which predates
 *  this and drives the Log in / Switch login buttons) already treats the fields as independent, so
 *  without this arm a uuid-only identity would fall through to "Not signed in" while its own button
 *  read "Switch login". See the same note on `resolveLoginOutcome`.
 *
 *  Exported and shared with {@link AccountLoginModal} so the list and the login verdict cannot give
 *  opposite answers for the same identity. When §4c's `accountDisplay` lands in accountStore this
 *  belongs there, beside `NOT_SIGNED_IN`, and both callers should defer to it. */
export const SIGNED_IN_NO_EMAIL = "Signed in — no email on this login";

/** Everything the modal knows about WHERE WORK ACTUALLY RUNS, read in one go.
 *
 *  Held as one state object rather than six because every field comes from the same instant and is
 *  re-read by the same actions; splitting them invites a render where the PRIMARY badge has moved
 *  and the consumer lists underneath it have not. */
interface RoutingSnapshot {
  /** The fleet-wide activated account, if any. */
  preferredId?: string;
  /** agentId → accountId, for MOUNTED panes only (see the caveat rendered on screen). */
  panes: Record<string, string | undefined>;
  /** agentId → the name shown in the sidebar. */
  names: Record<string, string>;
  /** Explicit pins on the two sticky keys — what the selects below show as their value. */
  conciergePin?: string;
  sparklePin?: string;
  /** What those two keys are currently parked on, pin or not. */
  conciergeOn?: string;
  sparkleOn?: string;
}

/** The two consumers that are sticky by design and are NOT moved by "Activate this account". */
const STICKY_CONSUMERS = [
  {
    key: CONCIERGE_ACCOUNT_KEY,
    label: "Concierge",
    note: "Moving it mid-conversation drops its session and re-probes.",
  },
  {
    key: SPARKLE_SELF_ACCOUNT_PREFIX,
    label: "Improve Sparkle",
    note: "The hourly pass and its pane share one worktree, so they must share one account.",
  },
] as const;

export function AccountsScreen({ onLogin, deps, currentAccountId }: AccountsScreenProps) {
  const io: AccountsDeps = { ...DEPS, ...deps };
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [usage, setUsage] = useState<Usage[]>([]);
  // Learned per-account ceilings. Empty is a valid state and means "unknown for every account",
  // which the headroom line says in words rather than rendering as 0%.
  const [ceilings, setCeilings] = useState<Ceiling[]>([]);
  // Real authenticated identity (email + org) per account id — the trustworthy label read from each
  // account's own .claude.json oauthAccount. The nickname is only a secondary alias.
  const [identities, setIdentities] = useState<Identity[]>([]);
  // REAL live usage per account id. A value is Anthropic's own utilization; the literal "unknown"
  // means the QUIET read had no usable cached token (`usage unknown: `) and the row shows the "—
  // Usage unknown" affordance; the literal "error" means a GENUINE failure (offline / 401 /
  // unparseable body) and the row shows "usage unavailable"; a MISSING entry is "not fetched yet".
  // Kept separate from the token-tally `usage` above because it fetches per account and each account
  // can fail independently without blanking the others.
  const [liveUsage, setLiveUsage] = useState<Record<string, AccountUsageLive | "error" | "unknown">>(
    {},
  );
  // LIVE login health per account id, from `claude auth status --json` for that config dir. This is
  // the signal that catches the case the recorded identity CANNOT: an account whose `.claude.json`
  // still shows an email (so it reads "signed in") while its OAuth session is actually dead. A value
  // is the CLI's own answer; "error" means the probe couldn't run (degrade to the recorded identity,
  // never a false alarm); a MISSING entry is "not probed yet". Fed through `deriveRowLogin` below.
  const [authStatus, setAuthStatus] = useState<Record<string, ClaudeAuthStatus | "error">>({});
  // Bumped after every completed `onLogin` (handleAdd / handleLogin) to re-drive the live-usage
  // effect — the trigger a login provides that the account SET does not (see the effect below).
  const [liveNonce, setLiveNonce] = useState(0);
  // ── Per-card "Check usage levels" (item 14): a cache-bypassing re-read of ONE account's real
  // Anthropic levels, surfaced from that card's ⋮ kebab. `checkingUsage[id]` drives the in-flight
  // line; `usageError[id]` is that card's inline failure. Both are keyed by account id and kept
  // separate from the per-account `liveUsage` map so a check never blanks the row while it runs —
  // the row keeps its last figures and updates in place when the forced fetch returns. Replaces the
  // old global "Refresh usage" button — each card checks its own account independently.
  //
  // THE ONLY PROMPT-CAPABLE PATH ON THIS SCREEN. Everything else reads usage quietly, so this menu
  // item is also the remedy the "usage unknown" row points at: it is what a user with a lapsed cached
  // token clicks to true their figures up.
  const [checkingUsage, setCheckingUsage] = useState<Record<string, boolean>>({});
  // The outcome note for the LAST check on that card, or null. DISCRIMINATED rather than a bare
  // string because the two outcomes must not read alike: `"error"` is a genuine failure and gets the
  // amber `role="alert"` treatment, while `"unknown"` means the read could not produce a token at all
  // and gets a muted `role="status"` — telling a user with a merely-lapsed token to check their
  // connection is worse than saying nothing.
  // FOUR kinds now, because "a forced usage read failed" has four different causes and only ONE of
  // them is "sign in again": `unknown` (no readable credential — muted status), `exhausted` (the
  // account is signed in and healthy, just rate-limited — a neutral note naming the reset, never an
  // alarm), `signedout` (a proven-dead login — the amber "sign in again" remedy), and `error` (a
  // transient network/timeout/5xx — amber "try again"). Routing them apart is what stops a
  // rate-limited-but-signed-in account being told to sign in again (the contradiction the founder saw).
  const [usageError, setUsageError] = useState<
    Record<
      string,
      { kind: "error" | "unknown" | "exhausted" | "signedout"; text: string } | null
    >
  >({});
  // Which card's ⋮ kebab menu is open (item 11); only one at a time, null = none.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  // PER-CARD expand state for the "Running agents" one-line collapse (item 13): the set of account
  // ids whose running-agents list is currently expanded to the full comma list.
  const [expandedRunning, setExpandedRunning] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  // ── LOADING vs LOADED-EMPTY, kept DISTINCT so the modal never flashes a false "No accounts yet" ──
  // `accounts` starts `[]` and stays `[]` until the first `refresh()` resolves, and a transient read
  // failure leaves it `[]` too — so gating the empty CTA on `accounts.length === 0` alone renders
  // "No accounts yet" mid-load and on error, the intermittent empty flicker the founder hits (opens
  // the modal, sees nothing; reopens, sees all six). `loaded` flips true ONLY after a read that
  // DEFINITIVELY completed, so three states are separable: not-yet-loaded → a skeleton; loaded with
  // rows → the list; loaded with zero → the empty CTA, the one case it is honest. It never flips back
  // to false, so a later transient error keeps the last-known list rather than blanking to empty.
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  // Synchronous mirror of the active rename id. The state closures captured by the
  // input's onBlur/onKeyDown are stale by the time blur fires on unmount, so we
  // gate commit/cancel on this ref instead: Enter and Escape both clear it BEFORE
  // the resulting blur runs, which lets handleRename short-circuit a double-commit
  // (Enter) or a cancelled-edit save (Escape).
  const editingIdRef = useRef<string | null>(null);
  // ── THE CLOCK BEHIND "Trouble signing in" ───────────────────────────────────────────────────
  //
  // Whether a pending row has stalled is a function of TIME, not of any state this screen holds, so
  // without a tick the title would only flip when something unrelated happened to re-render — which
  // on a screen the user is staring at may be never. The interval runs ONLY while a row is actually
  // pending (that is the `pendingCount` dependency), so a fleet of settled accounts costs nothing.
  const [signInNow, setSignInNow] = useState(() => Date.now());
  // Signed-in rows are excluded: a RECOVERED account keeps the placeholder as its stored nickname
  // until `handleLogin`'s best-effort rename lands, and counting it here would keep this interval
  // running forever on a healthy row for a title that is no longer derived from it.
  const pendingCount = accounts.filter(
    (a) => a.nickname === PENDING_NICKNAME && !isSignedIn(identities.find((i) => i.id === a.id)),
  ).length;
  useEffect(() => {
    if (pendingCount === 0) return;
    // A quarter of the stall window: fine enough that the flip lands close to the deadline, coarse
    // enough to be a handful of renders rather than a per-second re-layout of every card.
    const every = Math.max(1000, (SIGN_IN_STALL_SECONDS * 1000) / 4);
    const t = setInterval(() => setSignInNow(Date.now()), every);
    return () => clearInterval(t);
  }, [pendingCount]);

  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  // Two-step confirm for re-logging in the DEFAULT account, whose config dir is the user's real
  // ~/.claude — see the button below.
  const [confirmLogin, setConfirmLogin] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // THE RENDER'S SUBSCRIPTION TO A STORE WITH NO SUBSCRIBE. The rotation opt-outs and the pause live
  // in `localStorage` (see `services/rotationState.ts`) because the SPAWN PATH has to read them and
  // it is not React. Nothing re-renders when they are written, so without this the kebab toggle and
  // the header's pause button would both appear to do nothing until an unrelated state change
  // happened to repaint the screen — a control that looks broken while working correctly, which on
  // this particular surface is the exact complaint being fixed. Bumping a counter is the smallest
  // honest fix; the values themselves are still read fresh on every render, never cached here.
  const [, setRotationTick] = useState(0);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  // Depend on the individual functions actually used, not the whole `deps` object —
  // so an integrator passing an inline `deps={{...}}` literal (new object each render)
  // with stable function refs doesn't recreate `refresh` and spin the effect below.
  // The default (no `deps`) path resolves to the module-level DEPS, which are stable.
  const listAccountsFn = deps?.listAccounts ?? DEPS.listAccounts;
  const getUsageFn = deps?.getUsage ?? DEPS.getUsage;
  const getIdentitiesFn = deps?.getIdentities ?? DEPS.getIdentities;
  const listCeilingsFn = deps?.listCeilings ?? DEPS.listCeilings;
  const getUsageLiveFn = deps?.getUsageLive ?? DEPS.getUsageLive;
  // The interactive reader. Deliberately NOT wired into any effect below — `checkUsageLevels` (a
  // click handler) is its only caller, and that is the property that keeps the keychain quiet.
  const getUsageLiveForcedFn = deps?.getUsageLiveForced ?? DEPS.getUsageLiveForced;
  const getAuthStatusFn = deps?.getAuthStatus ?? DEPS.getAuthStatus;
  // ── REMOVED IDS, SO A STALE RE-READ CANNOT RESURRECT A ROW ──────────────────────────────────
  //
  // `refresh()` writes `setAccounts(a)` unconditionally, and six things call it (the mount effect,
  // rename, add, login ×2, remove). Any of them already in flight when a remove is confirmed
  // resolves afterwards with a list that STILL contains the removed id and puts the card back —
  // then it vanishes again when this remove's own refresh lands. That flicker is the same "did my
  // click do anything?" shape the optimistic drop exists to remove, and the window is a
  // `listAccounts` + `getIdentities` round trip (a per-account `.claude.json` read).
  //
  // Same idea as `liveGenRef` below, keyed by id rather than by generation because what must be
  // suppressed is one ROW, not one batch.
  //
  // An id is NOT cleared on success, deliberately. It is a tombstone: the account is gone from the
  // backend, so nothing legitimate can reintroduce it, and holding the id is what keeps a read that
  // STARTED before the delete from resurrecting it when it lands afterwards. Ids are random, so a
  // future account cannot collide with one. It IS cleared when the delete fails, because then the
  // account genuinely still exists and must be allowed back.
  const removingRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [a, ids, cs] = await Promise.all([
        listAccountsFn(),
        getIdentitiesFn(),
        // Ceilings are an ENRICHMENT, not a prerequisite: they add the "% of its own limit" numbers.
        // Sharing the rejection path with `listAccounts` would let a backend that cannot answer
        // `accounts_ceilings` blank the entire account list — trading a missing percentage for a
        // screen that shows no accounts at all. Degrade to "unknown" per account instead.
        listCeilingsFn().catch(() => [] as Ceiling[]),
      ]);
      setAccounts(a.filter((x) => !removingRef.current.has(x.id)));
      setIdentities(ids);
      setCeilings(cs);
      // The read DEFINITIVELY completed — from here the empty CTA is honest and the skeleton stops.
      // Set only on success: a first-load rejection lands in `catch` below and must NOT unlock the
      // empty state. Never reset to false, so a later transient failure can't blank a known list.
      setLoaded(true);
      // ══ THE LOCAL TALLY IS NO LONGER AWAITED — THIS IS THE TEN-SECOND LOAD ═══════════════════
      // `accounts_usage` walks EVERY account's `projects/**/*.jsonl` and sums tokens. On the
      // founder's machine that is 17,316 files and 5.7 GB for the default account alone, which is
      // the ten seconds the screen took to appear. Nothing above needs it, and since the two
      // "(local estimate)" bars were removed the only thing that still does is the amber
      // "Exhausted until …" line — a detail, not a reason to hold the whole screen blank.
      //
      // Note which call was actually slow: the REAL Anthropic fetch was never the problem. It was
      // already concurrent per account and already off this path, so removing the local bars makes
      // the screen faster rather than more network-bound, which is the opposite of the obvious
      // guess. Fired without `await`, its own `catch` so a failed tally cannot fail the load.
      void getUsageFn()
        .then((u) => setUsage(u))
        .catch(() => {
          /* the exhausted line simply does not render; the screen is already up */
        });
      // NOTE: the REAL live-usage fetch is deliberately NOT awaited here. It reads each account's
      // cached OAuth token and hits the network per account — up to 15s each — so folding it into
      // refresh's critical path would gate every add/rename/remove/login flow (each awaits refresh)
      // behind N blocking round-trips. It runs in its own effect below, keyed on the account SET so a
      // rename doesn't re-hit the endpoint. It does NOT read the keychain and cannot raise a macOS
      // prompt — that is the quiet reader's guarantee; only the ⋮ "Check usage levels" gesture can.
    } catch (e) {
      setError(errText(e, "Failed to load accounts"));
    }
  }, [listAccountsFn, getUsageFn, getIdentitiesFn, listCeilingsFn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ── REAL live usage, best-effort, OUT of refresh's critical path ──────────────────────────────
  // Re-fetches on exactly the events that change what the endpoint would return, and NOT on a plain
  // rename. Two triggers:
  //   • `accountsKey` — the account SET (id + configDir): add / remove.
  //   • `liveNonce`   — bumped after EVERY completed `onLogin` (see handleAdd / handleLogin). This is
  //     the fix for the post-login regression: a login changes neither id nor configDir, so keying
  //     on the set alone never re-fetched after one — a just-signed-in account stayed "unavailable"
  //     and a switched account kept the PREVIOUS login's numbers. Crucially the nonce fires for
  //     EVERY login, including (a) an email-only login that records no `accountUuid` (so an
  //     identity-signature key would miss it — `accountStore.identityKey` exists precisely because
  //     the uuid is null for such logins) and (b) re-authenticating the SAME account after a 401 /
  //     offline error, the recovery path a user actually takes from the "unavailable" row.
  //   • a plain RENAME calls neither, so it still doesn't re-hit the endpoint.
  // NONE of these reach the keychain: `getUsageLiveFn` is the QUIET reader, which takes no force
  // argument and stops at Sparkle's token cache / the account's creds file. That is why re-firing it
  // on every add / remove / login is safe — it cannot raise a macOS prompt however often it runs. An
  // account whose cached token has lapsed rejects with `usage unknown: ` and lands "unknown", not
  // "error": the row asks the user to check it by hand rather than reporting a failure that isn't
  // one. The keychain-touching read lives in `checkUsageLevels` below, behind a click.
  // Each result is written per-id as it settles, so rows fill independently and one hung account
  // doesn't blank the column. A generation ref discards a stale batch's late results (and any write
  // after unmount): with a 15s-per-account window an older batch can resolve after a newer one.
  const accountsKey = accounts.map((a) => `${a.id} ${a.configDir}`).join("|");
  const liveGenRef = useRef(0);
  useEffect(() => {
    if (accounts.length === 0) return;
    const gen = ++liveGenRef.current;
    for (const acct of accounts) {
      getUsageLiveFn(acct.configDir)
        .then((r) => {
          if (liveGenRef.current === gen) setLiveUsage((prev) => ({ ...prev, [acct.id]: r }));
        })
        .catch((e: unknown) => {
          // The ONE place the two rejection classes part company on the quiet path. `usage unknown: `
          // is the expected answer for a lapsed cached token — degrade to "unknown". Anything else
          // (network, 401, unparseable body) is a real error and keeps the error state honest.
          const cell = isUsageUnknownError(e) ? "unknown" : "error";
          if (liveGenRef.current === gen) setLiveUsage((prev) => ({ ...prev, [acct.id]: cell }));
        });
    }
    // `accountsKey` is the content signature of the account SET (not the array identity, so a rename
    // doesn't re-fire); `liveNonce` re-fires after any login. `accounts`/`getUsageLiveFn` read inside.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsKey, liveNonce, getUsageLiveFn]);

  // ── LIVE login health, best-effort, per account ────────────────────────────────────────────────
  // Same shape as the live-usage effect: fetch `claude auth status` per config dir, write per-id as
  // each settles (one hung/failed probe never blanks the column), guard stale batches with a
  // generation ref. Re-fires on the account SET and after any login (`liveNonce`) — a just-renewed
  // account must re-probe or it would keep showing EXPIRED. A probe failure records "error", which
  // `deriveRowLogin` treats as "no decisive signal" and falls back to the recorded identity, so a
  // flaky `claude auth status` can never manufacture a false EXPIRED.
  const authGenRef = useRef(0);
  useEffect(() => {
    if (accounts.length === 0) return;
    const gen = ++authGenRef.current;
    for (const acct of accounts) {
      getAuthStatusFn(acct.configDir)
        .then((s) => {
          if (authGenRef.current === gen) setAuthStatus((prev) => ({ ...prev, [acct.id]: s }));
        })
        .catch(() => {
          if (authGenRef.current === gen) setAuthStatus((prev) => ({ ...prev, [acct.id]: "error" }));
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsKey, liveNonce, getAuthStatusFn]);

  // ── LIVE identity re-read: keep the DISPLAYED EMAIL current with each dir's `.claude.json` ────────
  // The email a card shows is `accountDisplay(...).primary`, read from `identities`. That map is
  // written by `refresh()` (mount / add / rename / remove / login), so a login that swaps a dir's
  // `.claude.json` from OUTSIDE this screen never reached it — the row kept the PREVIOUS account's
  // email until the user happened to trigger one of those gestures. This poll re-reads identities on
  // a slow interval so the shown email tracks the dir's CURRENT login rather than a stale cache.
  //
  // NO immediate re-read here: mount and every login already read identities through `refresh()`, so
  // firing one on effect-setup would only duplicate that read (and would perturb the exact call
  // counts `AccountsScreen.relogin.test.tsx` pins). The interval is the only new fetch — the "live"
  // part `refresh()` cannot provide, since nothing calls it on a background `.claude.json` change.
  // `accounts_identities` opens only each dir's small `.claude.json` (no keychain, no transcripts),
  // off the event-loop thread. A generation ref discards a stale batch's late write and any write
  // after unmount; a failed read keeps the last-known labels rather than blanking them.
  const identityGenRef = useRef(0);
  useEffect(() => {
    if (accounts.length === 0) return;
    const reread = () => {
      const gen = ++identityGenRef.current;
      getIdentitiesFn()
        .then((ids) => {
          if (identityGenRef.current === gen) setIdentities(ids);
        })
        .catch(() => {
          /* keep the last-known identities; a transient read must not blank the labels */
        });
    };
    const t = setInterval(reread, IDENTITY_REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsKey, liveNonce, getIdentitiesFn]);

  // ── "Check usage levels" — per-card, on-demand true-up of ONE account's REAL usage (item 14) ─────
  // The founder's ask, surfaced from each card's ⋮ menu. THE ONLY CALLER of the interactive reader
  // anywhere in the app: `getUsageLiveForcedFn` bypasses the cached OAuth token and re-reads the
  // account's credentials, keychain included, so the macOS prompt that may raise here is the
  // acknowledged, wanted signal of a real re-check — the user just asked for it by clicking.
  //
  // WHY THIS IS A DIFFERENT DEP AND NOT A BOOLEAN: everything else that fetches live usage runs on a
  // timer (this screen's mount effect, and `refreshLiveUsage` behind three separate polls), and a
  // prompt raised by a timer is the constant-keychain-dialog bug (`sparkle-dkxuf6`). With `force` as
  // a parameter, prose was the only thing keeping those callers honest; with two exports, a timer
  // holds a reference to a function that CANNOT prompt. Do not call `getUsageLiveForcedFn` from an
  // effect, an interval, or anything else that is not a gesture.
  //
  // HONEST SCOPE: the cache holds only the TOKEN, never the usage numbers (`account_usage_live` hits
  // Anthropic on every call), so forcing guarantees a fresh credential-backed token read rather than
  // adding data freshness. Shares the live effect's `liveGenRef` guard so a login that re-fires the
  // effect mid-check discards this late write; the in-flight flag is always cleared so it can't wedge.
  async function checkUsageLevels(a: Account) {
    setOpenMenuId(null);
    if (checkingUsage[a.id]) return;
    setCheckingUsage((m) => ({ ...m, [a.id]: true }));
    setUsageError((m) => ({ ...m, [a.id]: null }));
    const gen = ++liveGenRef.current;
    try {
      const r = await getUsageLiveForcedFn(a.configDir);
      if (liveGenRef.current === gen) setLiveUsage((prev) => ({ ...prev, [a.id]: r }));
    } catch (e: unknown) {
      if (liveGenRef.current === gen) {
        // Same split as the quiet path, but the FORCED read has a WIDER unknown set — and getting
        // that set wrong is what this branch exists to avoid. Three Rust outcomes are "we could not
        // ANSWER", none of them "your connection is broken": no token even interactively
        // (`usage unknown: `), the user DECLINED the keychain prompt or a prior decline is still
        // suppressed (`keychain access not granted`), and a read refused for running on the main
        // thread (`keychain read refused on the main thread`, our bug, not their account).
        // `isUsageUnknownError` matches all three; it once matched only the first, which showed
        // someone who had just answered a dialog an amber "check your connection or sign in again".
        const unknown = isUsageUnknownError(e);
        if (unknown) {
          setLiveUsage((prev) => ({ ...prev, [a.id]: "unknown" }));
          setUsageError((m) => ({
            ...m,
            [a.id]: {
              kind: "unknown" as const,
              text: "Usage unknown — Sparkle couldn't read this account's saved credentials. Allow the keychain prompt when it appears, or sign in to this account again.",
            },
          }));
        } else {
          // A GENUINE failure — but "sign in again" is right for only ONE of its three causes, so
          // route the message from the actual cause instead of asserting the worst one for all. The
          // old single string told a rate-limited (signed-in, healthy) account to sign in again,
          // contradicting the "Exhausted until …" line right beside it.
          setLiveUsage((prev) => ({ ...prev, [a.id]: "error" }));
          const exReset = exhaustedLabel(
            usage.find((u) => u.id === a.id),
            Date.now(),
          );
          // A proven-dead token from the fetch itself (a terminal 401), OR the row's own login read
          // (identity + `claude auth status`) saying the session is gone. Either is decisive that
          // "sign in again" is the correct remedy; a mere network error is neither.
          const identity = identities.find((i) => i.id === a.id);
          const loginDead =
            isUsageAuthError(e) ||
            deriveRowLogin(isSignedIn(identity), authStatus[a.id]) !== "healthy";
          if (isUsageRateLimitError(e)) {
            // Anthropic 429'd the usage read: the account is at (or over) a session/weekly cap. It is
            // signed in and authenticating fine — a 429 PROVES that — so this must NOT read as "sign
            // in again" (loginDead) or "check your connection" (generic error). It is the founder's
            // exact incident: a weekly-capped account showing a connectivity error. The calm
            // `exhausted` status is the honest one; it wins over both branches below precisely because
            // a live rate-limit is more authoritative than a stale local wall or a login heuristic.
            setUsageError((m) => ({
              ...m,
              [a.id]: {
                kind: "exhausted" as const,
                text: "Couldn't fetch live usage right now — Anthropic rate-limited the usage read. This account is signed in and still working; try again shortly.",
              },
            }));
          } else if (exReset) {
            setUsageError((m) => ({
              ...m,
              [a.id]: {
                kind: "exhausted" as const,
                text: `${exReset} — this account is signed in; its limit resets then.`,
              },
            }));
          } else if (loginDead) {
            setUsageError((m) => ({
              ...m,
              [a.id]: {
                kind: "signedout" as const,
                text: "This account is signed out. Sign in again to see its usage.",
              },
            }));
          } else {
            setUsageError((m) => ({
              ...m,
              [a.id]: {
                kind: "error" as const,
                text: "Couldn't refresh usage — a temporary problem reaching Anthropic. Try again in a moment.",
              },
            }));
          }
        }
      }
    } finally {
      setCheckingUsage((m) => ({ ...m, [a.id]: false }));
    }
  }

  // Close the open ⋮ kebab menu on an outside click or Escape (item 11). Only bound while a menu is
  // open. The menu button and dropdown stopPropagation their own clicks, so an in-menu click never
  // reaches this document handler.
  useEffect(() => {
    if (openMenuId === null) return;
    const onDown = () => setOpenMenuId(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMenuId(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenuId]);

  // ── Where work actually runs ────────────────────────────────────────────────────────────────
  // Same "pull the individual functions" discipline as `refresh` above: an integrator passing an
  // inline `deps={{…}}` literal must not respin these on every render.
  const activateAccountFn = deps?.activateAccount ?? DEPS.activateAccount;
  const getPreferredAccountIdFn = deps?.getPreferredAccountId ?? DEPS.getPreferredAccountId;
  const clearPreferredAccountFn = deps?.clearPreferredAccount ?? DEPS.clearPreferredAccount;
  const clearSwitchWrittenPinsFn = deps?.clearSwitchWrittenPins ?? DEPS.clearSwitchWrittenPins;
  const paneAccountMapFn = deps?.paneAccountMap ?? DEPS.paneAccountMap;
  const stickySnapshotFn = deps?.stickyAccountSnapshot ?? DEPS.stickyAccountSnapshot;
  const getPinFn = deps?.getPin ?? DEPS.getPin;
  const setPinFn = deps?.setPin ?? DEPS.setPin;
  const clearPinFn = deps?.clearPin ?? DEPS.clearPin;
  const agentNamesFn = deps?.agentNames ?? DEPS.agentNames;

  const readRouting = useCallback(
    (): RoutingSnapshot => ({
      preferredId: getPreferredAccountIdFn(),
      panes: paneAccountMapFn(),
      names: agentNamesFn(),
      conciergePin: getPinFn(CONCIERGE_ACCOUNT_KEY),
      sparklePin: getPinFn(SPARKLE_SELF_ACCOUNT_PREFIX),
      conciergeOn: stickySnapshotFn(CONCIERGE_ACCOUNT_KEY),
      sparkleOn: stickySnapshotFn(SPARKLE_SELF_ACCOUNT_PREFIX),
    }),
    [getPreferredAccountIdFn, paneAccountMapFn, agentNamesFn, getPinFn, stickySnapshotFn],
  );
  const [routing, setRouting] = useState<RoutingSnapshot>({ panes: {}, names: {} });
  useEffect(() => {
    setRouting(readRouting());
  }, [readRouting]);

  /** Make this account the fleet's primary. The preference is persisted by `activateAccount` even
   *  when no switch controller is mounted — that half is what governs agents that don't exist yet,
   *  which is the whole ask. */
  function handleActivate(id: string) {
    activateAccountFn(id);
    setRouting(readRouting());
  }

  /** Back to automatic: unpreferred, so every unpinned spawn returns to lowest-usage auto-pick.
   *  Agents already running stay where they are — nothing is re-spawned to undo a preference.
   *
   *  BOTH WRITES, because clearing the preference alone does not make anything automatic. The
   *  activation this undoes had two durable effects: the preference, and a per-agent pin on every
   *  pane its migration moved (`moveAgent` → `setPinFromSwitch`). A pin OUTRANKS the preference in
   *  `chooseAccountForAgent`, so dropping only the preference leaves each of those agents spawning
   *  on the activated account forever — the button reports success and the fleet does not move.
   *  Provenance-keyed, so a per-agent override a HUMAN set (the pane picker, the sticky consumers'
   *  own controls) survives: this undoes the machinery's choice, not theirs. */
  function handleClearPreferred() {
    clearPreferredAccountFn();
    clearSwitchWrittenPinsFn();
    setRouting(readRouting());
  }

  /** Park a sticky consumer on one account, or `""` to hand it back to automatic. Writes a PIN on
   *  that consumer's key rather than touching the fleet preference, which is exactly the
   *  distinction the section explains on screen. */
  function handleStickyChoice(key: string, accountId: string) {
    if (accountId) setPinFn(key, accountId);
    else clearPinFn(key);
    setRouting(readRouting());
  }

  const usageFor = (id: string) => usage.find((u) => u.id === id);
  const identityFor = (id: string) => identities.find((i) => i.id === id);
  // Registrations that resolve to the SAME Anthropic account (same identity key: uuid when
  // recorded, else the verified email) — see the
  // banner below and `duplicateAccountGroups`.
  const duplicates = duplicateAccountGroups(accounts, identities);
  const duplicateIds = new Set(duplicates.flatMap((g) => g.accounts.map((a) => a.id)));
  const now = Date.now();
  // The cross-account peaks that scaled the relative usage bars are gone with the bars themselves.
  // `usage` is still read, for ONE thing: the amber "Exhausted until …" line, which reports an
  // OBSERVED rate limit rather than a token estimate.

  // ── Rotation visibility ─────────────────────────────────────────────────────────────────────
  // Every number below is DERIVED from the same pure policy the spawn path uses. Nothing here
  // decides anything; it reports what selection is already doing, which is the entire point — the
  // bug was never that selection was wrong, it was that its input pool was invisible.
  const displayFor = (a: Account) => accountDisplay(a, identityFor(a.id));
  /** How an account reads as one entry in a PICKER — deliberately not `displayFor().primary`.
   *
   *  That field is an IDENTITY SLOT's text, and its `email ?? NOT_SIGNED_IN` fallback is honest
   *  there and wrong here twice over. An option's job is to NAME the thing you are choosing, so:
   *
   *   • "Not signed in" is not a name. Worse, it is a false one for an `oauthAccount` that carries a
   *     uuid but no readable email — an account that IS signed in — which is exactly the state
   *     `SIGNED_IN_NO_EMAIL` exists to describe. Falling back to the NICKNAME says which config dir
   *     this is without claiming anything about its login, which the row above already reports.
   *   • Two accounts with no email would both render "Not signed in" and be indistinguishable in
   *     the list — a picker in which the options are not telling apart is not a picker.
   *
   *  Carrying BOTH parts when both exist also keeps each option's text distinct from the identity
   *  slot's, so a query for an email still resolves to the one element that is claiming to be that
   *  account's identity rather than to a menu entry that merely mentions it. */
  const accountOptionLabel = (a: Account) => {
    const d = displayFor(a);
    return d.signedIn ? `${d.nickname} — ${d.primary}` : d.nickname;
  };
  /** How an account id reads in a sentence ("On <name>"), or null when the id names nothing.
   *
   *  Uses the same label as the picker beside it, for the reason above and one more: the sentence
   *  and the `<select>` describe the SAME choice, so naming one account two ways across two
   *  adjacent controls reads as two different accounts. */
  const nameOfAccount = (id: string | undefined) => {
    const a = id ? accounts.find((x) => x.id === id) : undefined;
    return a ? accountOptionLabel(a) : null;
  };
  /** Everything currently running on this account, by the name the user knows it by.
   *
   *  THE FOUNDER'S ACTUAL QUESTION — "Then what actual agents would go on to that account? It's not
   *  clear to me." The two sticky consumers are appended after the agents because they are the two
   *  that "Activate this account" will NOT move, and seeing them listed on an account is what makes
   *  their separate control below make sense. */
  /*  A STICKY CONSUMER CAN ALSO BE A MOUNTED PANE, so the pane map is not a list of "other" agents.
   *  Improve Sparkle's pane is an ordinary `AgentPane` whose `agent.id` IS `SPARKLE_AGENT_ID`
   *  (`sparkleAgent.ts`), so `registerPaneAccount` files it under the sticky key itself. Listing the
   *  pane map verbatim and THEN appending the sticky labels therefore printed it twice — once as the
   *  raw internal id `__sparkle_self__`, which names nothing the user has ever seen, since
   *  `routing.names` only carries sidebar agents. So sticky keys are pulled out of the pane list and
   *  folded into the one label each.
   *
   *  Presence is the OR of the two sources rather than the snapshot alone, and that matters for
   *  satellite windows: those panes register under a `-win-<uuid>` variant while
   *  `stickyAccountSnapshot` is read on the BASE key, so a variant that resolved without the base
   *  key ever resolving would drop off the list entirely if the pane evidence were discarded. */
  const stickyLabel = (paneId: string): string | null => {
    if (paneId === CONCIERGE_ACCOUNT_KEY) return "Concierge";
    return isStickyAccountKey(paneId) ? "Improve Sparkle" : null;
  };
  const consumersOn = (accountId: string): string[] => {
    const here = Object.entries(routing.panes).filter(([, acct]) => acct === accountId);
    // ONE function decides which sticky consumer a pane id is, so the exclusion below and the
    // inclusion under it cannot disagree about the same id — the way to get the duplicate back.
    const agents = here
      .filter(([id]) => stickyLabel(id) == null)
      .map(([id]) => routing.names[id] ?? id)
      .sort((x, y) => x.localeCompare(y));
    const paneHere = (label: string) => here.some(([id]) => stickyLabel(id) === label);
    // The two sticky consumers last: they are the two "Activate this account" will NOT move, and
    // seeing them here is what makes their separate control below make sense.
    //
    // ASYMMETRIC ON PURPOSE. The concierge has no pane — `registerPaneAccount`'s only production
    // caller is `AgentPane`, keyed by `agent.id`, and the concierge is `controlListener`'s caller
    // identity rather than anything mounted — so its account is knowable only from the snapshot. An
    // `|| paneHere("Concierge")` arm here would read as symmetry with the line below while being
    // unreachable by construction, which is worse than the asymmetry: it would tell a later reader
    // that both consumers are covered by pane evidence when only one can be.
    if (routing.conciergeOn === accountId) agents.push("Concierge");
    if (routing.sparkleOn === accountId || paneHere("Improve Sparkle"))
      agents.push("Improve Sparkle");
    return agents;
  };
  const readiness = rotationReadiness(accounts, identities);
  // ── THE ROTATION POOL, AS THE HEADER AND EVERY CARD BOTH SEE IT ──────────────────────────────
  // `rotationReadiness` answers "which accounts COULD rotate" from identity alone. The user's own
  // opt-outs are the other half, and netting them off HERE — once — is what stops the header
  // claiming "6 accounts available" over rows that say "out of rotation". That contradiction is the
  // specific thing the founder screenshotted, so it gets one source of truth rather than two reads.
  //
  // `rotationTick` exists because both facts live in `localStorage`, outside React: nothing
  // re-renders when the kebab writes one, so the toggle would appear to do nothing until an
  // unrelated state change happened to repaint. Bumping it is the render's subscription to a store
  // that has no subscribe.
  const outOfRotation = rotationOutIds();
  // PROBE-EXPIRED ROWS ARE NOT IN THE POOL EITHER, and this is the one exclusion `rotationReadiness`
  // structurally cannot make: it decides `usable` from `signedInAccountIds`, i.e. an email being
  // present, while `authIsDefinitelyExpired` exists precisely to catch a row whose recorded identity
  // still carries an email over a dead OAuth session. Without this the header reads "Rotation active:
  // 2 accounts available" directly above a card reading "out of rotation · login expired" — the exact
  // count-contradicts-the-rows defect this screen was rebuilt to remove.
  //
  // Derived from `deriveRowLogin`, the SAME per-row function the card calls, so the two cannot drift.
  const probeExpired = new Set(
    accounts
      .filter((a) => deriveRowLogin(isSignedIn(identityFor(a.id)), authStatus[a.id]) === "expired")
      .map((a) => a.id),
  );
  // THE POOL IS PER LOGIN, AND THE REPRESENTATIVE IS RE-ELECTED WITH THE EXCLUSIONS IN HAND.
  // Filtering `readiness.usable` after the fact was wrong in a way that depended on registration
  // order: `rotationReadiness` picks each login's representative by input order, before anything
  // about the user's choices is known, so taking THAT row out dropped the whole login from the count
  // while agents could still reach it through its sibling — and taking the sibling out instead
  // correctly changed nothing. `electRotationPool` redoes the election, so a login leaves the pool
  // only when every registration of it is excluded. See its docblock.
  const groupKeyById = new Map<string, string>();
  for (const g of duplicateAccountGroups(accounts, identities)) {
    for (const a of g.accounts) groupKeyById.set(a.id, g.key);
  }
  const excludedFromPool = new Set([...outOfRotation, ...probeExpired]);
  const elected = electRotationPool(
    [...readiness.usable, ...readiness.redundant],
    groupKeyById,
    excludedFromPool,
  );
  const rotationPool = elected.pool;
  /** WHY THE POOL IS EMPTY, when it is. Three different situations with three different remedies,
   *  and every collapse of them has produced a false sentence in the one line that states the fleet's
   *  health:
   *
   *    • nothing signed in at all       → add or sign in an account
   *    • everything signed in has EXPIRED → reconnect one, from the button its card is already showing
   *    • everything else                → put one back from its ⋮ menu
   *
   *  The middle case is the one a two-way split gets wrong, and it is not exotic: a one-account
   *  install whose OAuth session died is `usable` by identity (an email is recorded) and out of the
   *  pool by probe. Told it had "been taken out or is a duplicate", the user is sent to a menu item
   *  that does not apply, past the Reconnect button that does. */
  const anySignedIn = readiness.usable.length > 0;
  /** Of the signed-in logins, how many are out for each reason. An empty pool is almost never
   *  single-cause once there is more than one account, and asserting one cause is how the copy
   *  ends up false: with A expired and B taken out, "every signed-in account has been taken out or
   *  is a duplicate" is wrong about A — and sends the user to A's ⋮ menu, where the toggle it names
   *  is greyed out precisely BECAUSE A is expired. */
  const excludedUsable = readiness.usable.filter((a) => excludedFromPool.has(a.id));
  const expiredOut = excludedUsable.filter((a) => probeExpired.has(a.id)).length;
  const takenOut = excludedUsable.length - expiredOut;
  // THE REDUNDANT HALF OF A DUPLICATE PAIR, not both halves. `duplicateAccountIds` names every row
  // in a shared-login group, which is the right set for "which rows are worth re-logging" (the
  // kebab tints them) and the WRONG set here: marking both rows "out of rotation · duplicate" would
  // report a pool of zero for a login that is perfectly usable — the first claim on it still routes.
  // `rotationReadiness` already draws that line, keeping the first and filing the rest under
  // `redundant`, and reading it here is what makes the dots add up to the header's count.
  // FROM THE ELECTION, not from `readiness.redundant` — otherwise a row that was promoted into the
  // pool because its sibling was taken out would still render "out of rotation · duplicate" while
  // being counted, which is the count-contradicts-the-rows defect inside one login group.
  const redundantIds = new Set(elected.redundant.map((a) => a.id));
  const paused = rotationPause();
  /** Would the spawn path actually honour this account as a fleet-level target right now?
   *
   *  THE HEADER MUST NOT NAME AN ACCOUNT ROUTING HAS ALREADY DISCARDED. `usablePreferredAccount` and
   *  `usablePausedAccount` both decline for an account that is gone, signed out, taken out of
   *  rotation, or at an OBSERVED rate limit — and the header used to apply only the first two, so a
   *  rate-limited preferred account rendered "every new agent runs on X" while every spawn had
   *  already fallen through to auto-pick somewhere else. That is the loudest line on the screen being
   *  wrong about the one thing it exists to state.
   *
   *  Deliberately the OBSERVED wall (`isAccountExhausted`) and not the wider `eligibleAccounts` test:
   *  near-cap and near-ceiling are estimates, and the two gates on the spawn path stop at observed
   *  fact for exactly that reason. Same rule here, or the header disagrees with them again. */
  const honouredFleetTarget = (id: string | null | undefined): Account | null => {
    if (!id) return null;
    // THE ROUTER'S GATES, EXACTLY — present, signed in, not taken out, not at an observed wall. An
    // earlier cut looked the id up in `rotationPool`, which was STRICTER than the router in two ways
    // and produced the inverse contradiction: `rotationPool` also drops duplicates and probe-expired
    // rows, while `usablePreferredAccount` / `usablePausedAccount` know about neither. Activating the
    // redundant half of a duplicate pair is one click (the Manual Override button gates on
    // `display.signedIn` alone), and the router really does send every spawn there — so a header that
    // dropped the override line and printed "New agents go to whichever account has the most room
    // left" was saying routing was automatic while a fleet target was in force.
    //
    // Matching the router in BOTH directions is the point. The header is a report on where agents go,
    // not a second opinion about where they should.
    const a = accounts.find((x) => x.id === id);
    if (!a) return null;
    // `signedInAccountIds` + `signedInFilterApplies`, NOT the card-level `isSignedIn`. They are two
    // different predicates and the difference bites in both directions: `isSignedIn` is uuid OR
    // email, while the router keys on email alone and DEGRADES OPEN when no listed account has one.
    // So a uuid-only login passed here and was dropped by the router (header announces an override
    // that is not in force), and on an install where nothing parsed an `oauthAccount` the router
    // honoured the preference unconditionally while this returned null (header says routing is
    // automatic when it is not). Sharing the functions is the only way these agree by construction
    // rather than by inspection.
    const signedInIds = signedInAccountIds(identities);
    if (signedInFilterApplies(accounts, signedInIds) && !signedInIds.includes(id)) return null;
    if (outOfRotation.has(id)) return null;
    return isAccountExhausted(usage, id, now) ? null : a;
  };
  /** Pause is a SPEND HALT: while it is on, `chooseAccountForAgent` HOLDS every brand-new rotation
   *  spawn instead of handing it an account, so no new build agent starts and no new account spend
   *  begins until Restart. It does not touch running agents, an agent resuming its own conversation,
   *  a hand pin, the fleet preference, or the sticky concierge / Improve Sparkle keys — so nothing is
   *  "frozen onto" any account any more and the pause records no target. */
  const handleToggleRotation = () => {
    if (paused) resumeRotation();
    else pauseRotation(null, now);
    setRotationTick((t) => t + 1);
  };
  const handleToggleAccountRotation = (id: string, inRotation: boolean) => {
    setAccountInRotation(id, inRotation);
    setRotationTick((t) => t + 1);
  };
  // The REAL Anthropic rows we have fetched, in the shape selection uses. Feeding these into the
  // AC8 verdict keeps "all accounts are at their limit" tracking the SAME signal the spawn gate now
  // excludes on (`partitionAccounts` → `isLiveSpent`), rather than only the observed wall — so the
  // banner and the gate cannot disagree. Rows still loading ("undefined"), unknown ("unknown") or
  // failed ("error") are
  // simply absent, which reads as "no live evidence" for that account, never as spent. So are rows
  // that came back "unknown" (a lapsed cached token on the quiet path) — an account we could not read
  // without prompting is one we know NOTHING about, which is the opposite of "at its limit".
  const liveRows: LiveUsage[] = Object.entries(liveUsage)
    .filter((e): e is [string, AccountUsageLive] => e[1] !== "error" && e[1] !== "unknown")
    .map(([id, l]) => ({
      id,
      fiveHourPercent: l.fiveHourPercent,
      sevenDayPercent: l.sevenDayPercent,
    }));
  // id → login-group siblings, so AC8 judges the live signal PER LOGIN exactly as
  // `switchRecommendation` and the spawn gate do (a duplicate's missing live row is covered by its
  // twin's), keeping the deduped banner from disagreeing with them.
  const siblingIds = loginSiblingIds(accounts, identities);
  const outlook = exhaustionOutlook(
    readiness.usable.map((a) => a.id),
    usage,
    ceilings,
    now,
    liveRows,
    siblingIds,
  );
  // AC9 — the runway warning, raised BEFORE the wall.
  //
  // WHICH ACCOUNT(S) TO WARN ABOUT. An integrator that knows the fleet's real account names it via
  // `currentAccountId` and only that one is judged. Absent that, this screen warns about EVERY
  // account in the rotation pool that is running out — deliberately NOT about `pickAccount`'s
  // answer, which was the first cut and is unreachable by construction: `pickAccount` returns the
  // HEALTHIEST account, so it is never the one approaching its ceiling, and a warning keyed on it
  // could only ever fire in the all-bad fallback that AC8's banner already covers. The pool is what
  // agents actually run on over time, so the pool is what has runway.
  // Observed-exhaustion state per account, for the no-target fallback below. `switchRecommendation`
  // owns the SAME live rows the spawn gate uses, so a runway target it returns is never one AC8 just
  // called walled.
  const headroomById = new Map(assessHeadroom(usage, ceilings, now).map((h) => [h.accountId, h]));
  const runwayIds = currentAccountId ? [currentAccountId] : readiness.usable.map((a) => a.id);
  const runways = runwayIds
    .map((id) => ({
      account: accounts.find((a) => a.id === id),
      headroom: headroomById.get(id),
      // `switchRecommendation` + `describeRecommendation` ARE the policy and the sentence. This
      // screen does not get a second opinion about either. It gets the SAME `liveRows`, so its target
      // choice cannot contradict AC8's live-aware verdict.
      recommendation: switchRecommendation(id, accounts, usage, ceilings, identities, now, liveRows),
      // For the no-target fallback: does this account share a login with another slot (a shared quota
      // is why there is nowhere to move), and — preferring a member that actually HAS a readable email
      // — what is that email? `duplicates` is the canonical grouping already computed above. The email
      // is chosen by SIGNED-IN member, not array order: a uuid-only sibling registered first must not
      // blank the email and revert the copy to the false "no other signed-in account".
      ...(() => {
        const group = duplicates.find((g) => g.accounts.some((a) => a.id === id));
        const others = (group?.accounts ?? []).filter((a) => a.id !== id);
        const email = others.map((a) => identityFor(a.id)?.email).find((e) => e != null) ?? null;
        return { hasSameLoginSibling: others.length > 0, sameLoginSiblingEmail: email };
      })(),
    }))
    .filter(
      (r) =>
        r.account != null &&
        (r.recommendation != null ||
          // NO-TARGET FALLBACK. An account hit a REAL wall but there is nothing to move to. This is
          // NOT redundant with AC8: `switchRecommendation` also drops a candidate that is the SAME
          // LOGIN as `from` (a shared quota is no escape), and `exhaustionOutlook` — judging the
          // login-deduped `usable` set — knows nothing about that. So a walled account whose only
          // alternative is its own duplicate has no recommendation AND is not `allAtLimit`: without
          // this row the screen goes silent while the fleet sits behind a five-hour wall (the
          // founder's blind spot). Suppressed when AC8 is already saying it about the whole pool.
          (!outlook.allAtLimit && r.headroom?.state === "exhausted")),
    );

  async function handleAdd() {
    const nickname = newName.trim();
    if (!nickname || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await io.addAccount(nickname);
      setAdding(false);
      setNewName("");
      await refresh();
      // Hand off to the integrator to run `claude auth login` in the new config dir (block comment
      // above). The account exists at this point but is a folder with no login in it.
      await onLogin(created);
      // The login attempt has ended. Re-read — never infer. A closed login window is not evidence
      // of a sign-in (it is equally what a cancelled OAuth, a failed one, and a `claude` that
      // exited on an unknown subcommand all look like), so the only way the list can be truthful
      // is to ask for the identities again. Whatever comes back drives the row: the resolved email
      // if there is one, an explicit "Not signed in" if there isn't.
      await refresh();
      // IDENTITY-KEYED RECONCILIATION. `claude auth login` grants whatever identity the browser is
      // currently signed into at claude.ai — it does NOT force account selection — so "Add account"
      // routinely resolves to a login the user ALREADY has, producing a duplicate slot that shares
      // one quota (the founder hit this four times over on one identity). The rule is one identity =
      // one account: if this fresh slot shares a login with a PRE-EXISTING account, discard the
      // redundant slot silently and tell the user which account it already is + how to add a
      // different one. A cancelled/failed login has no resolved identity, so `duplicateAccountGroups`
      // never groups it — that path is untouched and the slot stays as an un-signed-in row.
      const [freshAccounts, freshIdentities] = await Promise.all([
        listAccountsFn(),
        getIdentitiesFn(),
      ]);
      const dupGroup = duplicateAccountGroups(freshAccounts, freshIdentities).find((g) =>
        g.accounts.some((x) => x.id === created.id),
      );
      if (dupGroup) {
        // The group only exists because `created` matched an existing login, so there is always at
        // least one OTHER account in it — name it so the message is actionable.
        const existing = dupGroup.accounts.find((x) => x.id !== created.id);
        await io.removeAccount(created.id);
        await refresh();
        setError(
          existing
            ? `You're already signed in to this account as “${existing.nickname}”. To add a different account, switch accounts in your browser (or use a private window) and try again.`
            : `You're already signed in to this account. To add a different one, switch accounts in your browser (or use a private window) and try again.`,
        );
        return;
      }
      // ══ A SIGN-IN THAT NEVER LANDED LEAVES NO ROW ═══════════════════════════════════════════
      // The founder, looking at two cards reading "Trouble signing in / Not signed in": "if I say
      // add account and it doesn't add… it just shouldn't create the account in the first place. And
      // so I could get an error when I try to add it, but then if I'm not signed in, I probably
      // shouldn't even see it there. Like, it should just silently go away. I shouldn't have to
      // remove the account."
      //
      // He is right that those rows are worse than nothing: a registration with no login looks
      // exactly like a working account while being unable to receive a single agent, which is the
      // resemblance that let a never-signed-in dir pass for a second Max account on his machine.
      //
      // WHY IT CANNOT LITERALLY BE "don't create it". `addAccount` has to make the config dir BEFORE
      // `claude auth login` can run in it — the dir is the thing being logged into. So the honest
      // shape is create, attempt, and UNDO on failure, which is what this does. The undo is the same
      // `removeAccount` the duplicate branch above already uses.
      //
      // SCOPED TO THIS ADD, AND TO THIS ADD ONLY. The rule applies to the slot we just created and
      // watched fail, never to a row that was signed in before — "if I was signed in and then I
      // signed out, then it should have the account information still… and I should have a sign in
      // again". `handleLogin` (the re-login path) deliberately never deletes, for exactly that
      // reason, and the Rust side RETAINS a dir whose login expired rather than dropping it.
      const stillNoLogin = !isSignedIn(freshIdentities.find((i) => i.id === created.id));
      if (stillNoLogin) {
        await io.removeAccount(created.id);
        await refresh();
        // NOT silent, despite his word for it. He also said "I could get an error when I try to add
        // it", and the two together mean: no orphan ROW, but say what happened — a create that
        // vanishes with no explanation is indistinguishable from a button that did nothing.
        setError(
          `“${nickname}” was not added — the Claude sign-in did not complete, so there was no account to keep. Try adding it again.`,
        );
        return;
      }
      // A login just completed — re-fetch live usage for it. The account's id/configDir did not
      // change, so only this nonce moves the live-usage effect (covers a null-uuid email-only login
      // and a same-account re-login, neither of which an identity-signature key would catch).
      setLiveNonce((n) => n + 1);
    } catch (e) {
      setError(errText(e, "Failed to add account"));
    } finally {
      setBusy(false);
    }
  }

  // Re-login on an EXISTING account. Same rule as the add flow: the window closing is not a
  // verdict, so wait for it and re-read. Without this the row keeps showing the identity from
  // before the switch — which, for a user who just re-pointed an account at a different Claude
  // login, is the wrong email presented as the current one.
  //
  // IDENTITY-KEYED RECONCILIATION on re-login (the twin of handleAdd's guard, for the EXISTING-slot
  // path). `claude auth login` grants whatever identity the browser is signed into at claude.ai — it
  // does NOT force account selection — so re-authing slot A while the browser is signed into a
  // DIFFERENT identity Y silently overwrites slot A's login: its old identity X is gone from the
  // config dir, and if Y is one another slot already holds you now have two slots on one login. The
  // add path could just discard the redundant slot; here the user deliberately acted on an EXISTING
  // account, so we never auto-delete it — we surface every identity change loudly instead, so a
  // wrong-browser re-login can neither silently duplicate nor silently lose an account.
  async function handleLogin(a: Account) {
    try {
      // What slot A was signed into BEFORE this re-login — the yardstick for "did the identity
      // change". Read from the last-refreshed identities state (closed over fresh each render).
      const priorKey = identityKey(identities.find((i) => i.id === a.id));

      await onLogin(a);
      await refresh();

      // Re-read — never infer (same reasoning as handleAdd). A closed login window is equally a
      // cancelled OAuth, a failed one, and a real sign-in; only re-fetching identities tells them
      // apart. Fetch synchronously here because refresh()'s setState above is not yet visible.
      const [freshAccounts, freshIdentities] = await Promise.all([
        listAccountsFn(),
        getIdentitiesFn(),
      ]);
      const newIdentity = freshIdentities.find((i) => i.id === a.id);
      const newKey = identityKey(newIdentity);

      // Nothing resolved (cancelled/failed login, or a login that recorded no identity): leave the
      // slot exactly as it was — unchanged, as before this guard existed. Still bump live-usage in
      // case this was a same-account re-auth recovering a 401/offline row.
      if (newKey == null) {
        setLiveNonce((n) => n + 1);
        return;
      }

      // A row still carrying the sign-in PLACEHOLDER — or the EXPIRED-login placeholder — has just
      // been recovered by this login, so give it its real name. `AccountLimitModal.onSignedIn` is the
      // only other place that renames, and it is bound to that modal's own `pending` state — so an
      // account rescued from THIS card's "Finish sign-in" or "reconnect" button would otherwise keep
      // its placeholder ("Signing in…" / "Login expired — reconnect") as its stored nickname forever.
      // The expired case is the founder's "clicked reconnect, it didn't do anything": the reconnect
      // persisted the token but nothing rewrote the sticky `EXPIRED_LOGIN_NICKNAME`, so the card kept
      // offering "reconnect" even after the account authenticated again. Best-effort on purpose: a
      // failed rename must not fail a login that actually succeeded, and the card's own display rule
      // already refuses to show a stale placeholder on a signed-in row.
      if (
        (a.nickname === PENDING_NICKNAME || a.nickname === EXPIRED_LOGIN_NICKNAME) &&
        newIdentity?.email
      ) {
        try {
          await io.setNickname(a.id, newIdentity.email);
          await refresh();
        } catch {
          /* display rule covers it; nothing to tell the user about a cosmetic rename */
        }
      }

      // Case 1 — SAME identity as before. The legit "my token expired, re-auth" case: nothing to
      // warn about. (A slot that had NO prior identity falls through to the change handling below,
      // where the "account lost" branch is suppressed because there was no X to lose.)
      //
      // DELIBERATELY ORG-BLIND (raw `identityKey` equality). ALL organization-awareness on the
      // RE-LOGIN path is deferred to `organizationUuid` (bead sparkle-hli8pu), because the mutable
      // `organizationName` cannot drive it safely:
      //   • gating this on `accountsAreSame` false-alarms on an ordinary org RENAME (a single-dir
      //     token refresh comparing a cached name against a freshly-written one), and its fall-through
      //     lands in Case 3 whose copy names both sides by the same email;
      //   • detecting the "Team→Personal re-login onto ANOTHER slot's account" duplicate from a change
      //     in `duplicateAccountGroups` membership false-alarms just as badly — that membership flips
      //     when an org merely becomes `null` (a documented state for a completed login; see
      //     `splitGroupByOrganization`: "null is unknown, never a difference"), so an unchanged account
      //     whose org went unreadable would raise a false "wrong account" warning on a routine refresh.
      // A false alarm on the most routine action is worse than missing a rare deliberate re-login, so
      // this stays key-based until a stable `organizationUuid` is plumbed. The ADD path still
      // refuses/permits the two-org case via `accountsAreSame` (`adoptionOutcome` /
      // `duplicateAccountGroups`), which is the founder's actual blocker.
      if (priorKey != null && newKey === priorKey) {
        setLiveNonce((n) => n + 1);
        return;
      }

      // The identity CHANGED (or slot A had none before and now resolves one). Two sub-cases, and
      // both are surfaced loudly — a re-login must never silently duplicate or lose an account.

      // Case 2 — the new identity is one ANOTHER slot already holds → a duplicate-via-relogin. Do
      // NOT leave two slots on one login pretending all is well, and do NOT auto-delete slot A (the
      // user acted on it deliberately). Make it loud and recoverable: the row now shows Y and the
      // duplicate banner lights up, and this message names the slot Y already is.
      const dupGroup = duplicateAccountGroups(freshAccounts, freshIdentities).find((g) =>
        g.accounts.some((x) => x.id === a.id),
      );
      if (dupGroup) {
        const existing = dupGroup.accounts.find((x) => x.id !== a.id);
        const asLabel = newIdentity?.email ?? "another account you already have";
        setLiveNonce((n) => n + 1);
        setError(
          existing
            ? `This logged in as ${asLabel}, which is already “${existing.nickname}”. Switch your browser to the account you meant and try again.`
            : `This logged in as ${asLabel}, which is already one of your other accounts. Switch your browser to the account you meant and try again.`,
        );
        return;
      }

      // Case 3 — a DIFFERENT identity no other slot holds. The slot's account genuinely changed,
      // which just made the OLD identity X disappear from the account set. When there WAS a prior
      // identity, warn loudly so a wrong-browser login can't silently drop an account — the founder
      // can see it happened and re-add X. When there was NO prior identity (an empty slot getting
      // its first login), nothing was lost, so this is an ordinary successful login.
      if (priorKey != null) {
        const priorLabel =
          identities.find((i) => i.id === a.id)?.email ?? "its previous account";
        const newLabel = newIdentity?.email ?? "a different account";
        setError(
          `“${a.nickname}” was signed into ${priorLabel}; it's now ${newLabel}. ${priorLabel} is no longer in your accounts — switch your browser to it and re-add it if that wasn't intended.`,
        );
      }
      // A login just completed — re-fetch live usage for the (now changed) account.
      setLiveNonce((n) => n + 1);
    } catch (e) {
      setError(errText(e, "Failed to log in"));
    }
  }

  function startRename(a: Account) {
    editingIdRef.current = a.id;
    setEditingId(a.id);
    setDraftName(a.nickname);
  }

  // Single exit point for the rename input — clears the ref (so a trailing
  // unmount-blur bails the guard in handleRename), the editing state, and the draft.
  // Used by both cancel (Escape) and commit (Enter / blur).
  function exitRename() {
    editingIdRef.current = null;
    setEditingId(null);
    setDraftName("");
  }

  async function handleRename(id: string) {
    // Commit only if this is still the active edit. Enter and Escape both exit (which
    // clears editingIdRef) first, so the trailing blur (fired as the input unmounts)
    // finds a mismatch and bails — preventing Enter's double-commit and Escape's
    // save-on-cancel.
    if (editingIdRef.current !== id) return;
    const nickname = draftName.trim();
    exitRename();
    if (!nickname) return;
    try {
      await io.setNickname(id, nickname);
      await refresh();
    } catch (e) {
      setError(errText(e, "Failed to rename"));
    }
  }

  async function handleRemove(id: string) {
    setConfirmRemove(null);
    // ── OPTIMISTIC: THE ROW LEAVES NOW, NOT WHEN THE BACKEND ANSWERS ────────────────────────────
    //
    // `removeAccount` deletes a config DIRECTORY (`remove_dir_all` over a tree that can hold
    // thousands of transcript files) and then rewrites `accounts.json`, so the round trip is
    // visibly slow. Awaiting it before dropping the row left the card on screen looking untouched:
    // the founder read that as "the click did nothing", clicked Remove a second time, and the
    // second call landed on an id the first had already deleted — surfacing `account not found:
    // a7a45c3f2396de7b` in an error box, for a delete that had actually succeeded.
    //
    // Removing it from local state first makes the click feel instantaneous AND removes the second
    // click entirely, because there is no longer a row to click. `remove_account_at` is idempotent
    // as well (accounts.rs), so the two fixes are independent: this one stops the double click
    // happening, that one stops it mattering if it ever does.
    // Captured BEFORE the filter, so the row can be put back even if the re-read below cannot
    // supply it (see the catch).
    const removed = accounts.find((a) => a.id === id);
    removingRef.current.add(id);
    setAccounts((prev) => prev.filter((a) => a.id !== id));
    try {
      await io.removeAccount(id);
    } catch (e) {
      // A GENUINE failure — the account is still there, so the row must come BACK.
      //
      // Clear the tombstone FIRST: while the id is in that set, `refresh()` filters it out, so a
      // re-read done before this line could not restore the row it is being asked to restore.
      removingRef.current.delete(id);
      // Prefer the backend's own answer — it is the source of truth and also picks up whatever else
      // changed while the call was in flight. ORDER MATTERS: `refresh()` opens with
      // `setError(null)`, so the message has to be set after it or it is wiped and the failure is
      // silent.
      await refresh();
      // …but `refresh()` CANNOT REPORT ITS OWN FAILURE: it swallows the error into `setError` and
      // returns without touching `accounts`, leaving the optimistic filter standing. The rejections
      // that bring us here are exactly the ones that also reject `listAccounts` — IPC unavailable,
      // the accounts lock held, an unparseable accounts.json — so relying on the re-read alone
      // would delete the card from the screen while the account still exists on disk, which is the
      // silent-loss outcome the optimistic drop must never be able to cause. Restore explicitly,
      // and only if the re-read did not already do it.
      if (removed) {
        setAccounts((prev) => (prev.some((a) => a.id === id) ? prev : [...prev, removed]));
      }
      setError(errText(e, "Failed to remove"));
      return;
    }
    await refresh();
  }

  // Render the rows "most space first" (item 1): accounts with the most REAL Anthropic headroom on
  // top, unknown-usage below them, signed-out last. Only the RENDER order changes — every other
  // derivation above (readiness, duplicates, headroom) still reads the unordered `accounts`, which
  // are order-independent. The projection reads live usage + sign-in exactly as the row render does.
  const freshOrder = orderBySpace(accounts, (a) => {
    const data = liveUsageData(liveUsage[a.id]);
    return {
      id: a.id,
      alias: displayFor(a).nickname || displayFor(a).primary || a.id,
      usable: isSignedIn(identityFor(a.id)),
      sessionUsedPct: data ? data.fiveHourPercent : null,
      weeklyUsedPct: data ? data.sevenDayPercent : null,
    };
  });
  // FREEZE the order while a rename is in progress. The sort key depends on liveUsage/identities
  // that arrive asynchronously, one account at a time — so a SIBLING account's fetch landing while
  // the user is mid-rename would re-sort the list, and because rows are keyed by `a.id` React
  // re-parents the moved row, which blurs the focused rename `<input>`; its `onBlur` then commits
  // the half-typed draft with no user action. Holding the last settled order stable while
  // `editingId` is set removes that race without freezing the list the rest of the time. New rows
  // (added mid-edit) fall to the end in their fresh relative order rather than being dropped.
  const lastOrderRef = useRef<string[]>([]);
  let orderedAccounts = freshOrder;
  if (editingId !== null && lastOrderRef.current.length > 0) {
    const rank = new Map(lastOrderRef.current.map((id, i) => [id, i] as const));
    const freshIndex = new Map(freshOrder.map((a, i) => [a.id, i] as const));
    orderedAccounts = [...accounts].sort((x, y) => {
      const rx = rank.has(x.id) ? rank.get(x.id)! : Number.POSITIVE_INFINITY;
      const ry = rank.has(y.id) ? rank.get(y.id)! : Number.POSITIVE_INFINITY;
      if (rx !== ry) return rx - ry;
      return (freshIndex.get(x.id) ?? 0) - (freshIndex.get(y.id) ?? 0);
    });
  }
  // Record the order actually rendered, but only when NOT frozen, so the frozen snapshot stays the
  // pre-edit order and cannot drift under the open input.
  if (editingId === null) lastOrderRef.current = orderedAccounts.map((a) => a.id);

  return (
    <div style={{ fontFamily: fontStack, color: C.cream }}>
      {/* THE GLANCE, folded INTO the header rather than sitting under it — the founder asked for the
          rotation icon to the left of "Claude accounts" with its state in green underneath, and for
          the whole thing not to scroll. `stickyHeader` is what makes that last part true.

          NOT gated on `loaded`, unlike the banner it replaces: this IS the header now, and hiding it
          would make the title disappear on first paint. The first-read state is handled INSIDE it
          instead: `loading` keeps every count and colour neutral, because `rotationPool` is empty
          until the read resolves and "No account is signed in" is exactly the false-empty flash the
          list's own skeleton already guards against. */}
      <RotationGlance
        loading={!loaded}
        available={rotationPool.length}
        anySignedIn={anySignedIn}
        expiredOut={expiredOut}
        takenOut={takenOut}
        soleName={rotationPool.length === 1 ? displayFor(rotationPool[0]!).primary : null}
        paused={paused != null}
        // Only when the override names an account genuinely in the pool — the same gate
        // `usablePreferredAccount` applies on the spawn path. A preference can outlive the login it
        // pointed at (nothing clears it when an account signs out), and routing silently discards it
        // there; the header must discard it too rather than announce an override that is not in force.
        overrideName={(() => {
          const pref = honouredFleetTarget(routing.preferredId);
          return pref ? displayFor(pref).primary : null;
        })()}
        onToggle={handleToggleRotation}
        onAdd={() => setAdding(true)}
        adding={adding}
      />

      {/* AC8 — every usable account is out of room. Deliberately does NOT claim spawns are blocked:
          `pickAccount` still returns an account rather than refusing, so promising a block would be
          false, and so would implying everything is fine.

          ON THE WORDING: the "least-used account" sentence below is the founder's, chosen to settle a
          contradiction between two older strings (sparkle-cjpte) — `pickAccount` IS lowest-usage in
          general, but in THIS branch the pick is the least-bad fallback rather than a genuinely
          least-used one. That sentence is deliberate and not re-voiced here. The HEADLINE now
          distinguishes an observed wall ("at its limit") from live-utilization-only ("near its
          limit") — see the render below — because the 90 avoid threshold can fire this on accounts
          that are high but not walled, where "at its limit" would overstate. */}
      {outlook.allAtLimit && (
        <div data-testid="all-at-limit-banner" role="alert" style={noticeCard(C.dangerInk)}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
            <FiAlertTriangle size={13} aria-hidden />
            {/* "at its limit" only when there is an OBSERVED WALL (earliestReset set). When the banner
                fires on live utilization alone — high real usage but no rate-limit event — the account
                is NEAR its limit, not at it, and agents are still spawning. Saying "at its limit … no
                reset time" there overstates a wall that has not been hit; this matters more now that
                the avoid threshold is 90 (see LIVE_AVOID_PERCENT), so the banner can fire with up to
                10% real quota left. */}
            {outlook.earliestReset != null
              ? readiness.usableLogins === 1
                ? `Your only signed-in account is at its limit. It frees up at ${clockTime(outlook.earliestReset)}.`
                : `All accounts are at their limit. The first frees up at ${clockTime(outlook.earliestReset)}.`
              : readiness.usableLogins === 1
                ? "Your only signed-in account is near its limit — high real usage, but no hard wall yet."
                : "All accounts are near their limit — high real usage, but no hard wall yet."}
          </div>
          <div style={{ marginTop: 4 }}>Sparkle spawns new agents in the least-used account.</div>
        </div>
      )}

      {/* AC9 — the runway warning, BEFORE the wall. Where a target exists the sentence is
          `describeRecommendation`'s, not a second copy of that policy written here. */}
      {runways.map((r) => (
        <div
          key={r.account!.id}
          data-testid={`runway-warning-${r.account!.id}`}
          role="alert"
          style={noticeCard(C.amberInk)}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <FiAlertTriangle size={13} aria-hidden />
            {r.recommendation ? (
              describeRecommendation(r.recommendation, displayFor)
            ) : (
              // The no-target fallback (see the runway filter): a real wall with nowhere safe to go.
              // The subject is named by `leadName` — the SAME rule the recommendation sentence uses —
              // so a uuid-only login never reads the false "Not signed in has hit its limit". And the
              // reason is stated honestly: this row fires only when the sole other usable account is
              // the SAME Claude login (a shared quota is no escape — `switchRecommendation` excludes
              // it, `exhaustionOutlook` can't see it), so saying "no other signed-in account" would
              // contradict the duplicate banner above. Where that sibling is known, name it.
              <span>
                {leadName(displayFor(r.account!))} has hit its limit
                {r.hasSameLoginSibling
                  ? `, and another registration of the same Claude login${
                      r.sameLoginSiblingEmail ? ` (${r.sameLoginSiblingEmail})` : ""
                    } shares this limit. Sign in a different account to keep working.`
                  : ", and there is no other signed-in account to move to."}
              </span>
            )}
          </div>
        </div>
      ))}

      {adding && (
        <div style={{ ...card, display: "flex", gap: 8, alignItems: "center" }}>
          <input
            autoFocus
            aria-label="New account nickname"
            placeholder="Nickname (e.g. Personal Max)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleAdd();
              if (e.key === "Escape") {
                setAdding(false);
                setNewName("");
              }
            }}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button type="button" style={primaryBtn} disabled={busy || !newName.trim()} onClick={() => void handleAdd()}>
            Create &amp; log in
          </button>
          <button type="button" style={smallBtn} onClick={() => { setAdding(false); setNewName(""); }}>
            Cancel
          </button>
        </div>
      )}

      {error && (
        <div role="alert" style={{ ...card, borderColor: C.amber, color: C.amber, fontSize: 12 }}>
          {error}
        </div>
      )}

      {/* THE DUPLICATE-LOGIN BANNERS WERE HERE and are deleted. Each read "2 accounts are the same
          Claude login (name@example.com). X and Y share one usage quota, so switching between them
          gains you nothing — they hit the limit together. Log one of them into a different Claude
          account, or remove it." The founder: "there's just too much text here… don't put something
          at the top that says all this text. I think just put in the second box duplicate."

          The fact is still surfaced, on the card that has it: the duplicate row now reads a red dot,
          "out of rotation", and the word "duplicate" underneath, and its rotation toggle is greyed
          out because putting a shared quota back in the pool would buy nothing. That is strictly more
          actionable than the banner was — the banner had to name its subjects by NICKNAME, which is
          user-typed and is exactly the thing that cannot tell two registrations of one login apart.

          `duplicateIds` is still derived and still drives the card; only this restatement is gone. */}

      {/* THREE EXPLICIT STATES, never collapsed (the intermittent false-empty the founder hit):
          • not yet loaded, no error → a skeleton, NEVER the empty CTA;
          • loaded with zero accounts → the empty CTA, the one case it is honest;
          • loaded with accounts → the rows below.
          A first-load error shows the error banner above, not the CTA (`loaded` is still false). */}
      {!loaded && !error && !adding && (
        <div
          data-testid="accounts-loading"
          style={{ ...card, color: C.muted, fontSize: 13 }}
          role="status"
          aria-busy="true"
        >
          Loading your accounts…
        </div>
      )}
      {loaded && accounts.length === 0 && !adding && (
        <div data-testid="accounts-empty" style={{ ...card, color: C.muted, fontSize: 13 }}>
          No accounts yet. Add one to get started.
        </div>
      )}

      {/* The "lists below cover agents with an open tab in this window…" coverage caption was
          removed (overhaul item 7) at the founder's instruction. */}

      {/* The fleet-level "Advisor passes are SKIPPING — …" line was REMOVED at the founder's
          instruction (2026-08-21 live session): the message was unintelligible to users and, being a
          top-of-view banner, disconnected from the account that caused it. Any error now belongs on
          the specific account row where it occurred. */}

      {orderedAccounts.map((a) => {
        const u = usageFor(a.id);
        const identity = identityFor(a.id);
        const exhausted = exhaustedLabel(u, now);
        const isEditing = editingId === a.id;
        // The identity slot renders a VERIFIED identity or an explicit not-signed-in state — never
        // the user-typed nickname, which is not evidence of anything (contract §5). This row is how
        // an account with no `oauthAccount` in its config dir came to be displayed as "DROdio
        // Gmail": an unauthenticated registration presented as a login.
        //
        // `accountDisplay` is the shared authority (§4c) so this screen, the pane badge and the
        // switch banner cannot drift. THREE states, not two, though: `display.signedIn` is
        // email-only, while `isSignedIn` is WIDER (uuid OR email). A login carrying a uuid but no
        // readable email IS a real sign-in, so labelling it "Not signed in" would be the same lie
        // pointed the other way — it gets its own honest string instead.
        const display = accountDisplay(a, identity);
        const signedIn = isSignedIn(identity);
        // Effective login health, folding the live `claude auth status` probe over the identity read
        // (see `deriveRowLogin`). Drives the EXPIRED card below — including the case an account reads
        // signed-in but its session is actually dead.
        const rowLogin = deriveRowLogin(signedIn, authStatus[a.id]);
        const loginExpired = rowLogin === "expired";
        // THE DOT'S ANSWER, and the header's, from one function — see `services/rotationState.ts`.
        // Deriving it here rather than inline is what makes "in rotation" a single claim: the count
        // in the header nets off the SAME `outOfRotation` set this reads, so a card cannot say it is
        // out while the header counts it in.
        const rotation = accountRotationState({
          signedIn,
          loginExpired,
          // `duplicate` is suppressed for a row the user took out THEMSELVES, and that is a deliberate
          // reading of the precedence rather than a bypass of it. `accountRotationState` puts `duplicate`
          // ahead of `manual` because a structural block is the more fundamental fact — but it also makes
          // `duplicate` disable the toggle, and a row that is BOTH would then be permanently marked out
          // with no control to undo it. Between "the toggle may not visibly change anything" and "the
          // user cannot reverse their own action", the second is the one that traps someone.
          duplicate: redundantIds.has(a.id) && !outOfRotation.has(a.id),
          manuallyOut: outOfRotation.has(a.id),
        });
        // Can this account be made PRIMARY? Narrower than `signedIn` on purpose — see the Activate
        // button below: `usablePreferredAccount` gates on `signedInAccountIds`, which keys on email.
        const canBePrimary = display.signedIn;
        const primary = display.signedIn
          ? display.primary
          : signedIn
            ? SIGNED_IN_NO_EMAIL
            : display.primary;
        // Overhaul items 3 & 4: the NICKNAME is the bold card title; the verified email (or the
        // honest sign-in status for a uuid-only / not-signed-in account) is the secondary line
        // beneath. When the account has no nickname, the title falls back to the identity string and
        // there is no separate secondary line. The organization sub-line was removed entirely.
        // A sign-in that never finished stops claiming to be in progress. `signInStalled` reads
        // the row's own `createdAt`, so nothing extra is persisted; `signInTick` below is what makes
        // the flip happen on its own rather than waiting for the next unrelated re-render.
        // Gated on NOT being signed in. `signInStalled` reads only the placeholder nickname and
        // `createdAt`, and neither changes when a login is RECOVERED: `handleLogin` (the card's own
        // "Finish sign-in" button) never renames the row — the only rename lives in
        // `AccountLimitModal.onSignedIn`, bound to that modal's own pending state. So without this
        // guard a recovered account would show a verified email on its secondary line under a title
        // reading "Trouble signing in", forever — a card contradicting itself, which is the very
        // defect class this screen was just cleaned of (roborev 65218).
        const stalledSignIn = !signedIn && signInStalled(a.nickname, a.createdAt, signInNow);
        // A RECOVERED sign-in must stop showing the placeholder too, not merely stop calling it a
        // failure. Gating `stalledSignIn` alone would leave a signed-in account titled "Signing in…"
        // above its own verified email — the same self-contradiction, one word milder. The row keeps
        // the placeholder as its stored nickname until something renames it (handleLogin now does,
        // best-effort), so this display rule is what guarantees the card is right either way.
        const pendingPlaceholder = a.nickname === PENDING_NICKNAME;
        // A row still STORING the expired-login placeholder but now actually signed in — a reconnect
        // that just succeeded, in the window before its rename persists, or one whose cosmetic rename
        // write failed — must stop rendering "Login expired — reconnect", exactly as the pending
        // placeholder is suppressed on a recovered row. Without this the card keeps offering the
        // reconnect affordance over an account that authenticates fine, so a successful reconnect
        // reads on screen as "did nothing". A genuinely expired login is NOT `signedIn`, so it still
        // shows the reconnect card. (bug: login-expired reconnect does not take)
        const recoveredExpiredPlaceholder = a.nickname === EXPIRED_LOGIN_NICKNAME && signedIn;
        const titleText = stalledSignIn
          ? STALLED_SIGN_IN_TITLE
          : (pendingPlaceholder && signedIn) || recoveredExpiredPlaceholder
            ? primary
            : display.nickname || primary;
        const secondaryText = titleText === primary ? null : primary;
        return (
          <div key={a.id} data-testid={`account-row-${a.id}`} style={card}>
            {/* ══ HEADER ROW: `default` badge (LEFT) │ Manual Override + ⋮ kebab (RIGHT) ═══════════
                Rename / Switch login / Remove moved INTO the ⋮ kebab (item 11); the activate toggle
                and the kebab form the top-right cluster (item 11 layout refinement). */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {/* TOP LEFT: the dot and the two words. The founder's ask, verbatim — "let's just have
                  a green dot and have it say in rotation… if it's not in rotation, for some reason,
                  give it a red dot and say out of rotation" — and, for the duplicate case, "below
                  that say duplicate". The reason line generalises that to every out-of-rotation
                  cause, in the same two-word register: the card already carries a full explanation
                  for each of them in its own banner below, and repeating it here would rebuild the
                  wall of text he asked to have taken off the top of this screen. */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                <span
                  data-testid={`account-rotation-${a.id}`}
                  style={{ display: "flex", alignItems: "baseline", gap: 5, minWidth: 0 }}
                >
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      flexShrink: 0,
                      alignSelf: "center",
                      background: rotation.inRotation ? C.successInk : C.dangerInk,
                    }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: rotation.inRotation ? C.successInk : C.dangerInk,
                        display: "block",
                      }}
                    >
                      {rotationLabel(rotation)}
                    </span>
                    {rotationReasonLabel(rotation) && (
                      <span
                        data-testid={`account-rotation-reason-${a.id}`}
                        // TYPE.micro, not a literal 11: `theme/scale.test.ts` ratchets off-scale
                        // font sizes to zero, and a one-off between micro and small is exactly the
                        // sprawl it exists to stop.
                        style={{ fontSize: TYPE.micro, color: C.muted, display: "block" }}
                      >
                        {rotationReasonLabel(rotation)}
                      </span>
                    )}
                  </span>
                </span>
                {a.isDefault && <span style={tagStyle}>default</span>}
              </div>
              {/* Manual Override = the activate/deactivate toggle. Hidden while renaming. */}
              {!isEditing &&
                (routing.preferredId === a.id ? (
                  <button
                    type="button"
                    style={smallBtn}
                    onClick={handleClearPreferred}
                    title="Stop sending new agents here. Agents already running stay where they are."
                  >
                    Back to automatic
                  </button>
                ) : (
                  <button
                    type="button"
                    style={canBePrimary ? primaryBtn : { ...smallBtn, opacity: 0.5 }}
                    disabled={!canBePrimary}
                    onClick={() => handleActivate(a.id)}
                    title={
                      canBePrimary
                        ? "Manually override rotation to run agents on this account. New agents start here; ones already running move as each finishes its turn."
                        : "Sign in to this account first — it cannot receive agents yet."
                    }
                  >
                    Manual Override
                  </button>
                ))}
              {/* ⋮ kebab: Rename / Remove / Switch login / Check usage levels. Its own click and its
                  menu's clicks stopPropagation so they neither select the card nor trip the
                  outside-click close. Positioned right-aligned so the dropdown can't clip the edge. */}
              {!isEditing && (
                <div style={{ position: "relative" }} onMouseDown={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    aria-label="Account actions"
                    aria-haspopup="menu"
                    aria-expanded={openMenuId === a.id}
                    data-testid={`account-menu-button-${a.id}`}
                    style={{ ...smallBtn, padding: "4px 9px", lineHeight: 1 }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenuId((cur) => (cur === a.id ? null : a.id));
                    }}
                  >
                    ⋮
                  </button>
                  {openMenuId === a.id && (
                    <div
                      role="menu"
                      data-testid={`account-menu-${a.id}`}
                      style={{
                        position: "absolute",
                        right: 0,
                        top: "calc(100% + 4px)",
                        zIndex: 5,
                        minWidth: 168,
                        background: C.dialogSurface,
                        border: `1px solid ${C.muted}`,
                        borderRadius: 6,
                        overflow: "hidden",
                        boxShadow: "0 6px 18px rgba(0,0,0,0.45)",
                      }}
                    >
                      <button
                        role="menuitem"
                        type="button"
                        style={menuItem}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuId(null);
                          startRename(a);
                        }}
                      >
                        Rename
                      </button>
                      {!a.isDefault && (
                        <button
                          role="menuitem"
                          type="button"
                          style={menuItem}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuId(null);
                            setConfirmRemove(a.id);
                          }}
                        >
                          Remove
                        </button>
                      )}
                      {/* IN / OUT OF ROTATION. "In the three dot menu, give me the option to take it
                          out of rotation if it's in rotation or put it in rotation if it's out of
                          rotation." Greyed rather than hidden when the state is structural — the
                          founder asked for that on duplicates ("the ability to put it into rotation
                          would be grayed out… because it's a duplicate") and the same holds for a
                          row that is out because it has no login: an enabled control that cannot
                          change the outcome is a lie about what the user controls, and a HIDDEN one
                          leaves them wondering where the option went. The title says what would fix
                          it instead. */}
                      <button
                        role="menuitem"
                        type="button"
                        data-testid={`account-rotation-toggle-${a.id}`}
                        disabled={!rotation.canToggle}
                        style={rotation.canToggle ? menuItem : { ...menuItem, opacity: 0.45, cursor: "default" }}
                        title={
                          rotation.canToggle
                            ? undefined
                            : rotation.reason === "duplicate"
                              ? "This is a second registration of a login another account already holds. Both share one quota, so rotating to it gains nothing."
                              : "Sign this account in first — it cannot receive agents yet."
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!rotation.canToggle) return;
                          setOpenMenuId(null);
                          handleToggleAccountRotation(a.id, !rotation.inRotation);
                        }}
                      >
                        {rotation.inRotation ? "Take out of rotation" : "Put in rotation"}
                      </button>
                      {signedIn && (
                        <button
                          role="menuitem"
                          type="button"
                          style={duplicateIds.has(a.id) ? { ...menuItem, color: C.amber } : menuItem}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuId(null);
                            // The DEFAULT account's dir is the user's real ~/.claude, so re-logging it
                            // changes the login `claude` uses EVERYWHERE — that takes a confirm step.
                            if (a.isDefault) setConfirmLogin(a.id);
                            else void handleLogin(a);
                          }}
                        >
                          Switch login
                        </button>
                      )}
                      {signedIn && (
                        <button
                          role="menuitem"
                          type="button"
                          style={menuItem}
                          disabled={checkingUsage[a.id]}
                          onClick={(e) => {
                            e.stopPropagation();
                            void checkUsageLevels(a);
                          }}
                        >
                          {checkingUsage[a.id] ? "Checking usage…" : "Check usage levels"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ══ THE DEFAULT ACCOUNT'S DIRECTORY WAS RE-LOGGED-IN UNDERNEATH US ═══════════════════
                The default account is imported BY REFERENCE — `config_dir: ""`, the documented
                sentinel for "export no CLAUDE_CONFIG_DIR" — so it IS the user's real ~/.claude, and
                its identity is whatever that directory currently holds. Run `claude` in a terminal
                and log into a different account and this card silently becomes that other account:
                the founder found his "FC Superadmin" card reporting drodio@storytell.ai, with both
                cards showing identical usage because they had genuinely become one login.

                TWO DIFFERENT SIGNALS, AND THEY ARE NEARLY DISJOINT — do not conflate them
                (roborev 65222 caught me doing exactly that):

                  * `forkNotice` / `shellForked` compares this account's OWN config dir against the
                    shell's. For the normalized default — `config_dir: ""` — those are two reads of
                    the SAME file ($HOME/.claude.json), so they are identical by construction and
                    this can never fire. It covers the older TWO-FILE case: a legacy $HOME/.claude
                    default holding a login (which `default_config_dir_needs_normalizing` refuses to
                    normalize), or a CLAUDE_CONFIG_DIR exported in .zprofile after the record was
                    made. Real, but NOT the founder's symptom.

                  * `identityChanged` is the temporal one and IS the founder's symptom: the Rust
                    side records every observed identity per config dir and flips this when that dir
                    has hosted a DIFFERENT account uuid recently (`identity_log::takeover_at`). A
                    terminal `claude` login into another account is precisely that — one file, one
                    identity at a time, no divergence to compare, only a CHANGE over time.

                Sparkle cannot PREVENT a terminal login to the user's own config; making it visible
                where it is looked for is the achievable fix. */}
            {/* The "This account's folder was signed into a different Claude account recently" notice
                was REMOVED at the founder's instruction (2026-08-21 live session). */}
            {forkNotice(display) && (
              <div
                data-testid={`account-fork-notice-${a.id}`}
                style={{ marginTop: 8, fontSize: 12, color: C.amber }}
              >
                {forkNotice(display)}
              </div>
            )}

            {/* In-app confirms (never a native dialog): Remove, and re-logging the DEFAULT account,
                each take a confirm step surfaced here after the kebab item is chosen. */}
            {!a.isDefault && confirmRemove === a.id && (
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 12 }}>
                <span style={{ color: C.amber }}>Remove this account?</span>
                <button
                  type="button"
                  style={{ ...smallBtn, borderColor: C.amber, color: C.amber }}
                  onClick={() => void handleRemove(a.id)}
                >
                  Confirm remove
                </button>
                <button type="button" style={smallBtn} onClick={() => setConfirmRemove(null)}>
                  Cancel
                </button>
              </div>
            )}
            {a.isDefault && confirmLogin === a.id && (
              <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", fontSize: 12 }}>
                <span style={{ color: C.amber }}>
                  This changes the Claude login used everywhere on this machine.
                </span>
                <button
                  type="button"
                  style={{ ...smallBtn, borderColor: C.amber, color: C.amber }}
                  onClick={() => {
                    setConfirmLogin(null);
                    void handleLogin(a);
                  }}
                >
                  Change default account login
                </button>
                <button type="button" style={smallBtn} onClick={() => setConfirmLogin(null)}>
                  Cancel
                </button>
              </div>
            )}

            {/* IDENTITY TEXT — full width, BELOW the controls. `minWidth: 0` still matters: it is
                what lets the ellipsis rule inside actually clip a long email rather than forcing
                the card wider than its container. */}
            <div style={{ minWidth: 0, marginTop: 8 }}>
              {isEditing ? (
                <input
                  autoFocus
                  aria-label={`Rename ${a.nickname}`}
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleRename(a.id);
                    if (e.key === "Escape") exitRename();
                  }}
                  onBlur={() => void handleRename(a.id)}
                  style={{ ...inputStyle, width: "100%" }}
                />
              ) : (
                <>
                  {/* TITLE = the nickname (bold), on its own — no "alias:" prefix. Falls back to the
                      identity string when the account has no nickname.

                      ONE TITLE IS NOT A NICKNAME AT ALL. `EXPIRED_LOGIN_NICKNAME` is the placeholder
                      the Rust side writes when a login is cleared, and it reads "Login expired —
                      reconnect" — an instruction wearing a name's clothes, rendered in the same white
                      bold as "DROdio Gmail". The founder: "put login expired in red instead of white,
                      and make reconnect a clickable link. So I should be able to click that [and it]
                      would pop up the login."

                      So this one title is rendered as what it is: a red status and a real button. The
                      button is the SAME `handleLogin` path the card's own "Renew Login" uses, via the
                      identical default-account confirm — re-logging the default changes the Claude
                      login the whole machine uses, and that must take a confirm step no matter which
                      of the two affordances the user reached for. */}
                  <span
                    data-testid={`account-identity-${a.id}`}
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: titleText === EXPIRED_LOGIN_NICKNAME ? C.dangerInk : undefined,
                    }}
                  >
                    {titleText === EXPIRED_LOGIN_NICKNAME ? (
                      <>
                        Login expired —{" "}
                        <button
                          type="button"
                          data-testid={`account-reconnect-${a.id}`}
                          style={{ ...linkBtn, color: C.dangerInk, fontWeight: 600 }}
                          onClick={() => {
                            if (a.isDefault) setConfirmLogin(a.id);
                            else void handleLogin(a);
                          }}
                        >
                          reconnect
                        </button>
                      </>
                    ) : (
                      titleText
                    )}
                  </span>
                  {/* SECONDARY = the verified email, or the honest sign-in status for a uuid-only /
                      not-signed-in account (amber, so a not-signed-in card still reads as a problem —
                      the loud blocked banner below also stays). The organization line was removed. */}
                  {secondaryText && (
                    <span
                      data-testid={`account-identity-sub-${a.id}`}
                      style={{
                        fontSize: 12,
                        display: "block",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: signedIn ? C.muted : C.amber,
                      }}
                      title={
                        signedIn
                          ? undefined
                          : "This config folder holds no Claude login. Log in to give it a real identity."
                      }
                    >
                      {secondaryText}
                    </span>
                  )}
                </>
              )}
            </div>

            {exhausted && (
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: C.amber }}>
                <FiAlertTriangle size={12} aria-hidden />
                {exhausted}
              </div>
            )}

            {/* An account with no login at all is BROKEN, not merely unconfigured, and it must read
                that way: it is a row that looks exactly like a working account while being unable to
                receive a single agent. That resemblance is what let a never-signed-in registration
                pass for a second Max account on the founder's machine. */}
            {!signedIn && (
              <div
                data-testid={`account-blocked-${a.id}`}
                style={{
                  marginTop: 8,
                  padding: 8,
                  borderRadius: 6,
                  border: `1px solid ${C.dangerInk}`,
                  color: C.dangerInk,
                  fontSize: 12,
                  lineHeight: 1.5,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <FiSlash size={13} aria-hidden />
                {/* The FIRST sentence is unchanged (kept honest for a never-signed-in dir and the
                    established copy). Only the second sentence was softened: this card now ALSO
                    covers a recovered account whose login EXPIRED — Claude Code cleared its
                    `oauthAccount`, so it reads not-signed-in but a login really did live here — for
                    which "no login was ever completed" would be a lie. "No active Claude login" is
                    true of both, and the button opens the login modal, which offers both the browser
                    sign-in AND a pasted long-lived `claude setup-token` (the durable renew path). */}
                <span style={{ flex: 1, minWidth: 160 }}>
                  <strong>Not signed in — this account cannot receive agents.</strong> Its config
                  folder is here, but it has no active Claude login. Sign in to give it one.
                </span>
                <button
                  type="button"
                  style={{ ...primaryBtn, borderColor: C.dangerInk, background: C.dangerInk }}
                  onClick={() => void handleLogin(a)}
                >
                  Finish sign-in
                </button>
              </div>
            )}

            {/* THE CASE THE RECORDED FLAG MISSES: the row READS signed in (its `.claude.json` still
                names an email), but `claude auth status` says the OAuth session is dead. Without the
                live probe this account looks perfectly healthy while every agent it runs fails at
                auth — the exact silent expiry the founder hits. Additive to the card above (they are
                mutually exclusive: that one needs `!signedIn`, this one needs a signed-in identity). */}
            {signedIn && loginExpired && (
              <div
                data-testid={`account-expired-${a.id}`}
                role="alert"
                style={{
                  marginTop: 8,
                  padding: 8,
                  borderRadius: 6,
                  border: `1px solid ${C.dangerInk}`,
                  color: C.dangerInk,
                  fontSize: 12,
                  lineHeight: 1.5,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <FiAlertTriangle size={13} aria-hidden />
                <span style={{ flex: 1, minWidth: 160 }}>
                  <strong>Login expired.</strong> This account still shows its email, but Claude says
                  its session is no longer valid — agents on it will fail to authenticate until you
                  reconnect it.
                </span>
                <button
                  type="button"
                  data-testid={`account-renew-${a.id}`}
                  style={{ ...primaryBtn, borderColor: C.dangerInk, background: C.dangerInk }}
                  onClick={() => {
                    if (a.isDefault) setConfirmLogin(a.id);
                    else void handleLogin(a);
                  }}
                >
                  Renew Login
                </button>
              </div>
            )}

            {/* ── ACTIVATE, and WHAT IS ON THIS ACCOUNT ────────────────────────────────────────
                The control the founder asked for, and immediately under it the answer to the
                question he asked next. A button that silently re-routes an invisible fleet is the
                thing that was unclear; the list is most of the feature. */}
            {(() => {
              // `isPrimary` was read here to colour the routing line that is now deleted. Whether
              // this card holds the manual override is still visible — the header's Manual Override
              // button reads "Back to automatic" when it does — so nothing is lost by not
              // re-deriving it.
              const here = consumersOn(a.id);
              return (
                <div data-testid={`account-routing-${a.id}`} style={{ marginTop: 10 }}>
                  {/* THE ROUTING LINE WAS HERE — "Active — new agents run here" / "Not taking new
                      agents" / "Automatic — new agents may run here" — and it is deleted. The
                      founder, reading it: "when it says not taking new agents, I don't think I
                      [know] what that means. Does it mean that it's not available to take new
                      agents? Or that it's just, like, it's not currently selected?… Let's just
                      delete those two lines."

                      The ambiguity he is pointing at was real and structural: the line was trying to
                      say two different things at once — whether this account CAN receive an agent,
                      and whether it is the one currently being routed to — in a single three-way
                      string. Those are now two separate, unambiguous things in two places: the
                      rotation dot at the top of the card answers the first, and the Manual Override
                      button beside it answers the second by its own state. The empty-list sentence
                      ("Nothing is running on this account right now") went with it — an empty list
                      renders as nothing at all now, which is the same information without a line. */}
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                    {here.length === 0 ? null : expandedRunning[a.id] ? (
                      // EXPANDED: the full comma list + a Collapse link back to one line.
                      <>
                        Running agents: <span style={{ color: C.cream }}>{here.join(", ")}</span>{" "}
                        <button
                          type="button"
                          style={linkBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            setExpandedRunning((m) => ({ ...m, [a.id]: false }));
                          }}
                        >
                          Collapse
                        </button>
                      </>
                    ) : (
                      // COLLAPSED (one line): first 2 names + "+ N more" (or all, when <= 3).
                      (() => {
                        const { shown, moreCount } = collapsedRunningAgents(here);
                        return (
                          <>
                            Running agents:{" "}
                            <span style={{ color: C.cream }}>{shown.join(", ")}</span>
                            {moreCount > 0 && (
                              <>
                                {" "}
                                <button
                                  type="button"
                                  style={linkBtn}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedRunning((m) => ({ ...m, [a.id]: true }));
                                  }}
                                >
                                  + {moreCount} more
                                </button>
                              </>
                            )}
                          </>
                        );
                      })()
                    )}
                  </div>
                </div>
              );
            })()}

            {/* The estimated "usual limit" headroom bar was removed here — see the block comment
                where `HeadroomLine` used to be defined. The REAL USAGE (ANTHROPIC) section below is
                the only standing on this card now. */}

            {/* REAL server-side usage from Anthropic — the account's actual 5h/7d percent + reset.
                THE ONLY usage figures on this card now.

                The two "(local estimate)" bars that used to sit below were REMOVED at the founder's
                instruction ("we can remove the local estimates, they're not useful — let's just go
                with the actual cloud data"), and they were worse than merely unhelpful. They were
                computed by scanning each account's OWN transcripts, so they measured what THIS
                machine ran under an account rather than what the account had spent. On the card that
                prompted this, the real figures read session 0% / weekly 100% while BOTH local bars
                read 0 — the estimate described a fully exhausted account as completely idle. Showing
                a number that confidently contradicts the real one beside it is a liability, not a
                fallback. (The same inversion was steering the ROUTER; that is fixed separately, in
                `accountStore.pickAccount`.) */}
            <LiveUsageSection live={liveUsage[a.id]} accountId={a.id} now={now} />
            {/* Per-card "Check usage levels" status (item 14): a brief in-flight line, then the
                outcome note if the forced fetch didn't produce figures — never a browser dialog.
                FOUR SHAPES, and the distinction is the point: `unknown` (no readable credential) and
                `exhausted` (signed in, just rate-limited) are calm MUTED statuses — neither is a
                fault the user must chase — while `signedout` (a dead login) and `error` (a transient
                network problem) are amber ALERTS. Rendering the alarm copy for all of them, or the
                "sign in again" remedy for a merely rate-limited account, is what sent users chasing a
                non-existent outage. */}
            {checkingUsage[a.id] ? (
              <div
                data-testid={`account-usage-checking-${a.id}`}
                role="status"
                style={{ marginTop: 6, fontSize: 12, color: C.muted }}
              >
                Checking usage…
              </div>
            ) : usageError[a.id]?.kind === "unknown" || usageError[a.id]?.kind === "exhausted" ? (
              <div
                data-testid={
                  usageError[a.id]?.kind === "exhausted"
                    ? `account-usage-exhausted-note-${a.id}`
                    : `account-usage-unknown-note-${a.id}`
                }
                role="status"
                style={{ marginTop: 6, fontSize: 12, color: C.muted }}
              >
                {usageError[a.id]?.text}
              </div>
            ) : (
              usageError[a.id] && (
                <div
                  data-testid={`account-usage-error-${a.id}`}
                  role="alert"
                  style={{ marginTop: 6, fontSize: 12, color: C.amber }}
                >
                  {usageError[a.id]?.text}
                </div>
              )
            )}
          </div>
        );
      })}

      {/* ── The two consumers "Activate this account" deliberately leaves alone ─────────────────
          accountSelection.ts conceded this control was owed: "giving the concierge a visible
          account control belongs with the rest of the Phase 2 account UI. Stickiness is what makes
          that absence tolerable rather than a hole." Without it, activating an account would look
          like it moved everything while these two silently stayed put — the exact "two systems"
          confusion the founder described. Each writes a PIN on its own key, which is a deliberate
          per-consumer decision rather than a side effect of a fleet-wide setting. */}
      {accounts.length > 0 && (
        <div data-testid="sticky-consumers" style={{ ...card, marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Sparkle&rsquo;s own helpers</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 2, lineHeight: 1.5 }}>
            These two stay on one account on purpose, so activating an account does not move them.
            Park them here instead.
          </div>
          {STICKY_CONSUMERS.map((c) => {
            const pin = c.key === CONCIERGE_ACCOUNT_KEY ? routing.conciergePin : routing.sparklePin;
            const on = c.key === CONCIERGE_ACCOUNT_KEY ? routing.conciergeOn : routing.sparkleOn;
            const onName = nameOfAccount(on);
            return (
              <div
                key={c.key}
                style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, flexWrap: "wrap" }}
              >
                <span style={{ flex: 1, minWidth: 180 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, display: "block" }}>{c.label}</span>
                  <span style={{ fontSize: 12, color: C.muted, display: "block" }}>
                    {/* "Not chosen yet" is a real third state and must not read as an account
                        name: these keys resolve lazily, so before the concierge's first turn there
                        is genuinely no answer. */}
                    {onName
                      ? `On ${onName}${pin ? " (you set this)" : " (chosen automatically)"}`
                      : "No account chosen yet"}
                  </span>
                  <span style={{ fontSize: 12, color: C.muted, display: "block" }}>{c.note}</span>
                </span>
                <select
                  aria-label={`Account for ${c.label}`}
                  data-testid={`sticky-account-${c.key}`}
                  value={pin ?? ""}
                  onChange={(e) => handleStickyChoice(c.key, e.target.value)}
                  style={inputStyle}
                >
                  <option value="">Automatic</option>
                  {accounts.map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {accountOptionLabel(acc)}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      )}

      {/* The RETROSPECTIVE half of rotation. Everything above says what Sparkle will do next; this
          says what it actually did — which account each recent agent ran under, read from the
          on-disk ledger. Both halves are needed: the state above cannot be checked after the fact,
          and being told rotation "landed" twice with nothing to look at is what made it necessary. */}
      {accounts.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <AccountSpawnLog read={io.readSpawnLog} />
        </div>
      )}
    </div>
  );
}
