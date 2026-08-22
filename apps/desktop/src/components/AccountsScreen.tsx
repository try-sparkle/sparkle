import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { FiAlertTriangle, FiRotateCw, FiSlash, FiUserPlus } from "react-icons/fi";
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
  identityChanged,
  duplicateAccountGroups,
  loginSiblingIds,
  identityKey,
  getPreferredAccountId,
  clearPreferredAccount,
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
  type AccountUsageLive,
} from "../services/accountUsage";
import { checkSpendGateForAccounts } from "../services/advisor/spendGate";
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
  EXPIRED_LOGIN_NICKNAME,
  STALLED_SIGN_IN_TITLE,
  SIGN_IN_STALL_SECONDS,
} from "./accountsView";
import { joinList } from "../engine/joinList";

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
  getUsageLive: getAccountUsageLive,
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
 *  which pins that contract. */
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

/** The REAL live-usage block for one account row. Three states, none of which may break the screen:
 *   - `undefined` (not fetched yet) → a muted "Loading real usage…";
 *   - `"error"` (no token / offline / 401 / keychain declined) → "Real usage unavailable", and the
 *     relative token-tally bars below remain the fallback;
 *   - data → the two real percent bars. */
function LiveUsageSection({
  live,
  now,
}: {
  live: AccountUsageLive | "error" | undefined;
  now: number;
}) {
  if (live === undefined) {
    return (
      <div style={{ marginTop: 6, fontSize: 12, color: C.muted }}>Loading real usage…</div>
    );
  }
  if (live === "error") {
    return (
      <div style={{ marginTop: 6, fontSize: 12, color: C.muted }}>Real usage unavailable.</div>
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
      <MeterLine live={live} />
    </div>
  );
}

/** THE FLEET ANSWER: will an advisor pass run at all, right now?
 *
 *  `MeterLine` below states one ACCOUNT's meter. This states the thing a human actually wants to
 *  know, and the two are not the same question — which is the trap this component exists to close.
 *
 *  Production asks `checkSpendGateForAccounts`, which folds EVERY registered account and requires
 *  UNANIMITY: the first account that cannot prove its credits are disarmed refuses for the whole
 *  fleet. So a card reading "usage credits disarmed" proves nothing on its own, and two reachable
 *  states were being reported as though it did — a sibling with credits ARMED, and a sibling whose
 *  usage read FAILED (which renders "Real usage unavailable" and mounts no meter line at all, so
 *  nothing anywhere on the screen said the advisor was off).
 *
 *  It calls the SAME function production calls rather than re-deriving the rule. A second copy of a
 *  unanimity fold is exactly the drift that would put a reassuring sentence on screen while every
 *  pass silently refuses — the failure this whole surface exists to prevent.
 *
 *  An account still loading contributes nothing; one that ERRORED contributes `null`, which the
 *  gate reads as unreadable and refuses on, matching production, where a rejected read is a refusal
 *  rather than an abstention. */
function AdvisorGateLine({
  liveByAccount,
}: {
  liveByAccount: readonly (AccountUsageLive | "error" | undefined)[];
}) {
  const payloads = liveByAccount
    .filter((l) => l !== undefined)
    .map((l) => (l === "error" ? null : l));
  if (payloads.length === 0) return null;
  const verdict = checkSpendGateForAccounts(payloads);
  const why =
    verdict.allowed === true
      ? null
      : verdict.reason === "credits-armed"
        ? "an account has usage credits armed, so a pass could bill outside the subscription"
        : verdict.reason === "spend-limit-reached"
          ? "an account reports its credit spend limit reached"
          : verdict.reason === "usage-unreadable"
            ? "an account's usage could not be read, and an unreadable meter is not permission"
            : "an account did not report its usage-credits meter";
  return (
    <div
      data-testid="advisor-gate-line"
      style={{
        ...card,
        fontSize: 12,
        color: why ? C.dangerInk : C.muted,
        marginBottom: 8,
      }}
    >
      {why ? `Advisor passes are SKIPPING — ${why}.` : "Advisor passes can run — all accounts have usage credits disarmed."}
    </div>
  );
}

/** WHICH BILLING METER this account is spending against, in one plain line under the bars.
 *
 *  The two bars above are the SUBSCRIPTION windows, and for a long time they were the whole story
 *  the screen could tell — the usage-credits meter was fetched and thrown away by the parser. So an
 *  account spending pay-as-you-go credits looked identical to one on subscription alone, and the
 *  first anyone learned of a spend limit was a fleet of agents stalling against it. The point of
 *  this line is that a human sees it BEFORE that, not after.
 *
 *  Driven off the RAW TRI-STATE, not `summarizeMeter`, and IN THE GATE'S OWN ORDER. The summary
 *  folds absent / `null` / `isEnabled: false` together as "subscription", which is right for a
 *  status pill and wrong here: `services/advisor/spendGate.ts` treats those as opposite outcomes.
 *
 *  The order is the subtle half, and getting it wrong is what a first cut of this line did. The
 *  gate checks `spendLimitReached` BEFORE the `isEnabled` gate, so a DISARMED meter at its spend
 *  limit still refuses — yet reading the warning off the summary while the label read the
 *  tri-state rendered that case as a plain, unqualified "subscription", which under this line's own
 *  contract is the one reading that means a pass is permitted. Most reassuring in a refusing state
 *  is precisely the failure this exists to prevent, so the whole line derives from one verdict that
 *  mirrors the gate rather than from two independent reads.
 *
 *  It also distinguishes NO METER BLOCK from a block that did not say whether it is armed. Both
 *  refuse, but only the first can honestly be called "not reported" — a payload carrying
 *  `spendLimitReached: true` with a null `isEnabled` plainly did report a meter, and saying
 *  otherwise one line above a definite statement about that meter's ceiling contradicts itself. */
function MeterLine({ live }: { live: AccountUsageLive }) {
  const extra = live.extraUsage ?? null;
  const armed = extra?.isEnabled;
  const limitReached = extra?.spendLimitReached === true;
  const credits = extra?.usedCredits ?? null;
  const monthly = extra?.monthlyLimit ?? null;

  // ONE derivation, in `spendGate.ts`'s order: spend limit, then armed, then disarmed (the only
  // permitting state), then unreadable.
  //
  // Worded as a fact about THIS ACCOUNT, never as a verdict about whether advisor passes run. That
  // distinction is not pedantry: production asks `checkSpendGateForAccounts`, which requires
  // UNANIMITY across every registered account, so one disarmed account proves nothing on its own —
  // a sibling with credits armed, or one whose usage read failed, refuses for the whole fleet. An
  // earlier cut said "Advisor passes skip here — …" and rendered NOTHING on a permitting card,
  // which made silence a fleet-wide permission claim this line cannot support. The fleet answer is
  // `AdvisorGateLine`, rendered once above the cards from the same fold production uses.
  const accountNote =
    limitReached
      ? "credit spend limit reported reached"
      : armed === true
        ? "usage credits armed"
        : armed === false
          ? "usage credits disarmed"
          : extra == null
            ? "no credits meter reported"
            : "credits meter did not say whether it is armed";

  // Credit figures belong ONLY beside the credits label. The Rust type makes every field its own
  // `Option`, so a meter disabled part-way through a month arrives as `isEnabled: false` with
  // `usedCredits` still populated — and rendering that as "subscription · 47.50 of 200 used"
  // asserts one meter while displaying the other's spend, the exact confusion this removes.
  const usedText =
    armed !== true || credits == null
      ? null
      : monthly == null
        ? `${formatCredits(credits)} in credits used this month`
        : `${formatCredits(credits)} of ${formatCredits(monthly)} credits used this month`;

  return (
    <div style={{ marginTop: 6, fontSize: TYPE.small, color: C.muted }}>
      <span>
        Billing: {armed === true ? "usage credits" : "subscription"}
        {usedText ? ` · ${usedText}` : ""}
      </span>
      {limitReached && (
        <div style={{ color: C.dangerInk, marginTop: 2 }}>
          Credit spend limit reached — usage credits will not cover new agents.
        </div>
      )}
      <div style={{ color: limitReached ? C.dangerInk : C.muted, marginTop: 2 }}>
        This account: {accountNote}.
      </div>
    </div>
  );
}

/** Credits as a plain figure: whole numbers stay whole, fractions keep two places. Never a
 *  fabricated value — the caller has already established the figure is non-null. */
function formatCredits(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function exhaustedLabel(usage: Usage | undefined, now: number): string | null {
  if (!usage?.exhaustedUntil || usage.exhaustedUntil <= now) return null;
  return `Exhausted until ${clockTime(usage.exhaustedUntil)}`;
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

/** Build the "counted out" bullets for ONE reason bucket, collapsing accounts that share a nickname.
 *
 *  A single account keeps the `singular` sentence naming it. Two-or-more accounts with the SAME
 *  nickname — the generic placeholders "Signing in…" / "Login expired — reconnect" are shared by
 *  every not-signed-in / expired account — collapse to ONE `plural` sentence with a count, instead of
 *  repeating a byte-identical line per account (which also collided on the React `key`). Distinct
 *  nicknames within the bucket stay separate: they are already tellable apart. Each returned `key` is
 *  the group's account ids joined, so it is stable and unique even when two buckets share a nickname. */
function groupExcluded(
  accounts: Account[],
  singular: (nickname: string) => string,
  plural: (count: number, nickname: string) => string,
): { key: string; text: string }[] {
  const byNickname = new Map<string, Account[]>();
  for (const a of accounts) {
    const group = byNickname.get(a.nickname);
    if (group) group.push(a);
    else byNickname.set(a.nickname, [a]);
  }
  return [...byNickname.values()].map((group) => ({
    key: group.map((a) => a.id).join(","),
    text: group.length === 1 ? singular(group[0]!.nickname) : plural(group.length, group[0]!.nickname),
  }));
}

function RotationBanner({
  readiness,
  nameOf,
  onAdd,
}: {
  readiness: ReturnType<typeof rotationReadiness>;
  /** The VERIFIED identity for an account — never the nickname, which is user-typed and proves
   *  nothing about which login a config dir holds. */
  nameOf: (a: Account) => string;
  onAdd: () => void;
}) {
  const n = readiness.usableLogins;
  const rotates = n >= 2;
  const ink = rotates ? C.successInk : C.dangerInk;
  const Icon = n === 0 ? FiSlash : rotates ? FiRotateCw : FiAlertTriangle;

  const headline =
    n === 0
      ? "No account is signed in."
      : n === 1
        ? "Only 1 account is signed in, so Sparkle has nothing to rotate to."
        : `Rotation active — ${n} accounts available.`;

  const body =
    n === 0
      ? "Agents will run on whatever your terminal is logged into. Sparkle has no account of its own to hand them."
      : n === 1
        ? `Every agent will run on ${nameOf(readiness.usable[0]!)} until it hits its limit. Sign in another account to enable rotation.`
        : `New agents go to whichever of ${readiness.usable.map(nameOf).join(", ")} has the most room left.`;

  // Registrations that are counted OUT, named one by one. This is the state that is invisible today:
  // a config dir that was created but never signed into renders as an ordinary row, so two rows read
  // as two accounts. Each sentence says which registration and WHY it doesn't count.
  //
  // COLLAPSE IDENTICAL PLACEHOLDERS. The only bucket with a shared placeholder is `notSignedIn`, which
  // holds BOTH "Signing in…" ({@link PENDING_NICKNAME}) and "Login expired — reconnect"
  // ({@link EXPIRED_LOGIN_NICKNAME}) — the Rust producer nulls email AND accountUuid together for an
  // expired login (its `oauthAccount` was cleared), so `rotationReadiness` files it here, NOT under
  // `noEmail` (roborev 67153/67154 corrected the earlier claim). Two accounts sharing one of these
  // placeholders used to render byte-identical bullets — the same sentence twice, and a React `key`
  // collision — so we group by nickname and say a shared placeholder ONCE with a count.
  //
  // …but the SENTENCE must match WHY the row is out: an expired login is not "never signed in" (that
  // contradicts the nickname it quotes and points at the wrong remedy). So the copy branches on the
  // expired placeholder. Distinct nicknames stay on their own line.
  //
  // `redundant` is NOT collapsed (roborev 66907): its rows are signed in with real emails, carry no
  // shared placeholder, and two same-nickname rows can duplicate two DIFFERENT logins — so a plural
  // "they share one quota" would assert a relationship that need not hold. Per-account bullets, keyed on
  // the id. `noEmail` is likewise per-account: `list_account_identities` nulls email and accountUuid
  // together, so no production row reaches it with a readable-uuid-but-no-email shape — collapsing a
  // bucket nothing reaches would be a claim about an unreachable state.
  const notSignedInSingular = (nick: string) =>
    nick === EXPIRED_LOGIN_NICKNAME
      ? `“${nick}” — its Claude login expired; reconnect it to route agents there.`
      : `“${nick}” is registered but has never been signed in, so it cannot receive agents.`;
  const notSignedInPlural = (count: number, nick: string) =>
    nick === EXPIRED_LOGIN_NICKNAME
      ? `${count} accounts show “${nick}” — their Claude login expired; reconnect them to route agents there.`
      : `${count} accounts are still “${nick}” — registered but never signed in, so they cannot receive agents.`;
  const excluded = [
    ...groupExcluded(readiness.notSignedIn, notSignedInSingular, notSignedInPlural),
    ...readiness.redundant.map((a) => ({
      key: a.id,
      text: `“${a.nickname}” is the same Claude login as another account, so they share one quota and count as one.`,
    })),
    ...readiness.noEmail.map((a) => ({
      key: a.id,
      text: `“${a.nickname}” has a Claude login with no readable email, so Sparkle cannot route agents to it.`,
    })),
  ];

  return (
    <div data-testid="rotation-banner" role="status" style={noticeCard(ink)}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
        <Icon size={13} aria-hidden />
        {headline}
      </div>
      <div style={{ marginTop: 4 }}>{body}</div>
      {excluded.length > 0 && (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {excluded.map((line) => (
            <li key={line.key}>{line.text}</li>
          ))}
        </ul>
      )}
      {!rotates && (
        <button type="button" style={{ ...primaryBtn, marginTop: 8 }} onClick={onAdd}>
          <FiUserPlus size={12} aria-hidden style={{ verticalAlign: "-1px", marginRight: 4 }} />
          {n === 0 ? "Add an account" : "Add another account"}
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
  // REAL live usage per account id. A value is Anthropic's own utilization; the literal "error"
  // means the fetch failed (no token / offline / 401) and the row shows "usage unavailable"; a
  // MISSING entry is "not fetched yet". Kept separate from the token-tally `usage` above because it
  // fetches per account and each account can fail independently without blanking the others.
  const [liveUsage, setLiveUsage] = useState<Record<string, AccountUsageLive | "error">>({});
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
  const [checkingUsage, setCheckingUsage] = useState<Record<string, boolean>>({});
  const [usageError, setUsageError] = useState<Record<string, string | null>>({});
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
      // OAuth secret (a keychain read that can raise a macOS prompt) and hits the network per
      // account — up to 15s each — so folding it into refresh's critical path would gate every
      // add/rename/remove/login flow (each awaits refresh) behind N blocking round-trips. It runs in
      // its own effect below, keyed on the account SET so a rename doesn't re-hit the endpoint.
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
  //   • a plain RENAME calls neither, so it still doesn't re-hit the keychain / endpoint.
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
        .catch(() => {
          if (liveGenRef.current === gen) setLiveUsage((prev) => ({ ...prev, [acct.id]: "error" }));
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

  // ── "Check usage levels" — per-card, on-demand true-up of ONE account's REAL usage (item 14) ─────
  // The founder's ask, now surfaced from each card's ⋮ menu instead of a global button. Force-fetches
  // that account's live usage with `force=true`, so the read bypasses the cached OAuth token and
  // re-reads the account's keychain — the macOS prompt that may raise is the acknowledged, wanted
  // signal of a real re-check, not an error.
  //
  // HONEST SCOPE: the cache holds only the TOKEN, never the usage numbers (`account_usage_live` hits
  // Anthropic on every call), so `force` guarantees a fresh keychain-backed token read rather than
  // adding data freshness. Shares the live effect's `liveGenRef` guard so a login that re-fires the
  // effect mid-check discards this late write; the in-flight flag is always cleared so it can't wedge.
  async function checkUsageLevels(a: Account) {
    setOpenMenuId(null);
    if (checkingUsage[a.id]) return;
    setCheckingUsage((m) => ({ ...m, [a.id]: true }));
    setUsageError((m) => ({ ...m, [a.id]: null }));
    const gen = ++liveGenRef.current;
    try {
      const r = await getUsageLiveFn(a.configDir, true);
      if (liveGenRef.current === gen) setLiveUsage((prev) => ({ ...prev, [a.id]: r }));
    } catch {
      if (liveGenRef.current === gen) {
        setLiveUsage((prev) => ({ ...prev, [a.id]: "error" }));
        setUsageError((m) => ({
          ...m,
          [a.id]: "Couldn't refresh usage. Check your connection or sign in again.",
        }));
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
  // The REAL Anthropic rows we have fetched, in the shape selection uses. Feeding these into the
  // AC8 verdict keeps "all accounts are at their limit" tracking the SAME signal the spawn gate now
  // excludes on (`partitionAccounts` → `isLiveSpent`), rather than only the observed wall — so the
  // banner and the gate cannot disagree. Rows still loading ("undefined") or failed ("error") are
  // simply absent, which reads as "no live evidence" for that account, never as spent.
  const liveRows: LiveUsage[] = Object.entries(liveUsage)
    .filter((e): e is [string, AccountUsageLive] => e[1] !== "error")
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

      // A row still carrying the sign-in PLACEHOLDER has just been recovered by this login, so give
      // it its real name. `AccountLimitModal.onSignedIn` is the only other place that renames, and
      // it is bound to that modal's own `pending` state — so an account rescued from THIS card's
      // "Finish sign-in" button would otherwise keep "Signing in…" as its stored nickname forever.
      // Best-effort on purpose: a failed rename must not fail a login that actually succeeded, and
      // the card's own display rule already refuses to show a stale placeholder on a signed-in row.
      if (a.nickname === PENDING_NICKNAME && newIdentity?.email) {
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
    const live = liveUsage[a.id];
    const hasData = live !== undefined && live !== "error";
    return {
      id: a.id,
      alias: displayFor(a).nickname || displayFor(a).primary || a.id,
      usable: isSignedIn(identityFor(a.id)),
      sessionUsedPct: hasData ? live.fiveHourPercent : null,
      weeklyUsedPct: hasData ? live.sevenDayPercent : null,
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
      <div data-testid="accounts-header" style={stickyHeader}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Claude accounts</div>
        {/* The global "Refresh usage" button was replaced by a per-card "Check usage levels" item in
            each card's ⋮ kebab menu (overhaul item 14). */}
        {!adding && (
          <button type="button" style={primaryBtn} onClick={() => setAdding(true)}>
            + Add account
          </button>
        )}
      </div>

      {/* THE GLANCE. How many accounts can actually receive a spawn, and what that means — stated
          before anything else on the screen, because the row count is not that number. Gated on
          `loaded`: before the first read resolves this would read "No account is signed in", the
          same false-empty flash the CTA below guards against. */}
      {loaded && (
        <RotationBanner
          readiness={readiness}
          nameOf={(a) => displayFor(a).primary}
          onAdd={() => setAdding(true)}
        />
      )}

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

      {/* Two registrations of the SAME Claude login look like two accounts here but share one
          quota, so failover between them is a no-op that re-hits the same limit immediately. The
          nickname can't reveal this (it's user-typed), so we surface the identity clash instead.
          NOTE: a group is a PROVEN clash when it has an accountUuid, and an INFERENCE from a shared
          verified email when it does not — `duplicateAccountGroups` only infers when that email
          identifies exactly one uuid group, or none at all. */}
      {duplicates.map((g) => (
        <div
          key={g.key}
          role="alert"
          style={{ ...card, borderColor: C.amber, color: C.amber, fontSize: 12, lineHeight: 1.5 }}
        >
          <strong>
            {g.accounts.length} accounts are the same Claude login
            {g.email ? ` (${g.email})` : ""}.
          </strong>{" "}
          {joinList(g.accounts.map((a) => a.nickname))} share one usage quota, so switching
          between them gains you nothing — they hit the limit together. Log one of them into a
          different Claude account, or remove it.
        </div>
      ))}

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

      {/* One fleet-level statement, above the cards, because the gate is a fleet-level fact — see
          `AdvisorGateLine`. Rendered before the per-account meters so a human reads "are passes
          running" before "what is this one account's meter", which is the order they care about. */}
      <AdvisorGateLine liveByAccount={orderedAccounts.map((a) => liveUsage[a.id])} />

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
        const titleText = stalledSignIn
          ? STALLED_SIGN_IN_TITLE
          : pendingPlaceholder && signedIn
            ? primary
            : display.nickname || primary;
        const secondaryText = titleText === primary ? null : primary;
        return (
          <div key={a.id} data-testid={`account-row-${a.id}`} style={card}>
            {/* ══ HEADER ROW: `default` badge (LEFT) │ Manual Override + ⋮ kebab (RIGHT) ═══════════
                Rename / Switch login / Remove moved INTO the ⋮ kebab (item 11); the activate toggle
                and the kebab form the top-right cluster (item 11 layout refinement). */}
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
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
            {identityChanged(identity) && (
              <div
                data-testid={`account-identity-changed-${a.id}`}
                style={{ marginTop: 8, fontSize: 12, color: C.amber }}
              >
                <strong>This account&rsquo;s folder was signed into a different Claude account
                recently.</strong>{" "}
                {a.isDefault
                  ? "The default account is your real ~/.claude, shared with your terminal — a `claude` login there changes who this account is."
                  : "Its usage figures may have been measured against the previous login."}
              </div>
            )}
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
                      identity string when the account has no nickname. */}
                  <span
                    data-testid={`account-identity-${a.id}`}
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {titleText}
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
              const isPrimary = routing.preferredId === a.id;
              const here = consumersOn(a.id);
              return (
                <div data-testid={`account-routing-${a.id}`} style={{ marginTop: 10 }}>
                  {/* The activate/deactivate TOGGLE moved to the card's top-right header (item 11
                      layout). This block keeps only the subtle active-state indicator and the list of
                      what is running here. */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span
                      data-testid={`account-active-state-${a.id}`}
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: isPrimary ? C.successInk : C.muted,
                      }}
                    >
                      {/* NOT "Inactive". This line states a ROUTING fact — where the NEXT agent
                          will be started — and says nothing about what is running now. The founder
                          screenshotted a card reading "Inactive" directly above "Running agents:
                          Concierge" and reasonably read it as a bug in the state. The state was
                          right; the word was wrong, and it sits one line above the very list that
                          contradicts it.

                          THREE states, not two, and the third is the DEFAULT one. With no manual
                          override anywhere, `preferredId` is unset, so NO card is primary and a
                          two-way label would tell every card it takes no new agents — while
                          `chooseAccountForAgent` is in fact auto-picking one of them by lowest
                          usage. On a single-account fleet that is the card receiving 100% of spawns
                          declaring it receives none: a definitely false claim, which is worse than
                          the vague word it replaced (roborev 65216). Only when some OTHER card
                          holds the override is "not taking new agents" actually true — and even
                          then a per-agent pin can outrank it, which "may" leaves room for.

                          `!signedIn` comes FIRST because a signed-out card cannot receive agents at
                          all: `chooseAccountForAgent` filters both `eligibleAccounts` and `autoPick`
                          on `signedInIds`, and this same card renders "Not signed in — this account
                          cannot receive agents" a few lines below. Claiming "automatic — may run
                          here" above that banner would rebuild the founder's original complaint
                          inside a single card (roborev 65221).

                          The PRIMARY arm needs the same gate, and for the same reason (roborev
                          65223): nothing clears a stored preference when an account's login later
                          goes away — `handleActivate` checks `canBePrimary` at CLICK time only —
                          so a preference can outlive its identity. `usablePreferredAccount` drops a
                          preference that is not in `signedInIds`, so routing sides with the banner
                          there too, and an unqualified "Active" is the loudest possible way to be
                          wrong about it. */}
                      {isPrimary && signedIn
                        ? "Active — new agents run here"
                        : !signedIn || routing.preferredId
                          ? "Not taking new agents"
                          : "Automatic — new agents may run here"}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                    {here.length === 0 ? (
                      "Nothing is running on this account right now."
                    ) : expandedRunning[a.id] ? (
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
            <LiveUsageSection live={liveUsage[a.id]} now={now} />
            {/* Per-card "Check usage levels" status (item 14): a brief in-flight line, then an inline
                error if the forced fetch failed — never a browser dialog. */}
            {checkingUsage[a.id] ? (
              <div
                data-testid={`account-usage-checking-${a.id}`}
                role="status"
                style={{ marginTop: 6, fontSize: 12, color: C.muted }}
              >
                Checking usage…
              </div>
            ) : (
              usageError[a.id] && (
                <div
                  data-testid={`account-usage-error-${a.id}`}
                  role="alert"
                  style={{ marginTop: 6, fontSize: 12, color: C.amber }}
                >
                  {usageError[a.id]}
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
