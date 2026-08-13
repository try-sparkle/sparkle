import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { FiAlertTriangle, FiRotateCw, FiSlash, FiUserPlus } from "react-icons/fi";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { FONT_UI, TYPE } from "../theme/scale";
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
  duplicateAccountGroups,
  getPreferredAccountId,
  clearPreferredAccount,
  clearSwitchWrittenPins,
  getPin,
  setPin,
  clearPin,
  CEILING_AVOID_FRACTION,
  type Account,
  type Usage,
  type Identity,
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
  type Ceiling,
  type Headroom,
} from "../services/headroom";
import { getAccountUsageLive, type AccountUsageLive } from "../services/accountUsage";
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

const tagStyle: CSSProperties = { ...tag(C.accentInk), borderColor: C.teal };

/** The PRIMARY badge — the account the user activated for the fleet.
 *
 *  DELIBERATELY A FILLED PILL while `default` stays an outline tag, and that contrast is the point
 *  rather than decoration. In the founder's screenshot an EXHAUSTED account was still badged
 *  `default`, because "default" means "the config dir Sparkle registers as `~/.claude`" and has
 *  nothing to do with where agents run. Two outline tags of the same weight would read as two
 *  spellings of one idea; a solid one reads as the answer to "which account are my agents on". */
const primaryTagStyle: CSSProperties = {
  ...tag(ON_BRAND_FILL),
  background: C.teal,
  borderColor: C.teal,
  color: ON_BRAND_FILL,
};

/** The screen's title bar, PINNED. "+ Add account" is the remedy every banner on this screen
 *  recommends, and it used to scroll with the page: the spawn ledger at the bottom grew unbounded,
 *  the dialog outgrew the window, and the one control the founder needed went off the top edge —
 *  in a panel whose own copy was telling him to sign in another account.
 *
 *  Two details are load-bearing, and each is a way this has already failed:
 *
 *  • FULL BLEED. The scrollport is `ModalShell`'s body, which carries the dialog's inset. A sticky
 *    header that respects that inset leaves a `MODAL_PADDING`-wide gutter down each side with live
 *    content sliding up through it. Cancelling the inset with negative margins and re-adding it as
 *    padding makes the header span the card edge-to-edge while looking identical at rest.
 *  • OPAQUE. `sticky` does not imply a background. Without one the ledger rows scroll straight
 *    THROUGH the title and the button, which is worse than the overflow it replaced.
 *
 *  The negative top margin means it is already at its sticky offset before any scrolling happens,
 *  so it is pinned from the first paint rather than snapping into place partway down. */
const stickyHeader: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  background: C.dialogSurface,
  margin: `-${MODAL_PADDING}px -${MODAL_PADDING}px 10px`,
  padding: `${MODAL_PADDING}px ${MODAL_PADDING}px 8px`,
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

/** Human-readable token count (e.g. 9.3B, 1.2M, 34k). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

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

/** "resets Aug 17, 10:59 AM" for an ISO-8601 reset instant, or null when the string is absent or
 *  unparseable. A 7-day reset can be days out, so — unlike {@link clockTime} — this carries the date
 *  too. Defensive: Anthropic sends `resets_at: null` for a scoped/inactive window, and a bad string
 *  yields `NaN`, both of which must read as "no reset to show" rather than "Invalid Date". */
function resetLabel(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const when = new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `resets ${when}`;
}

/** A REAL usage bar filled by Anthropic's actual utilization percent (0–100), with an optional reset
 *  caption. `percent: null` (a window the server didn't report) renders "—" and an empty bar, never
 *  a fabricated 0%. Unlike the removed relative cross-account bar, this one
 *  is the account's honest standing against its own real limit. */
function LiveUsageBar({
  label,
  percent,
  resetsAt,
}: {
  label: string;
  percent: number | null;
  resetsAt: string | null;
}) {
  const pct = percent != null ? Math.max(0, Math.min(100, percent)) : 0;
  const reset = resetLabel(resetsAt);
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.muted }}>
        <span>{label}</span>
        <span>{percent != null ? `${Math.round(percent)}%` : "—"}</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} real usage`}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{
          height: 6,
          borderRadius: 3,
          background: C.deepForest,
          border: `1px solid ${C.muted}`,
          marginTop: 2,
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: C.teal }} />
      </div>
      {reset && <div style={{ fontSize: TYPE.micro, color: C.muted, marginTop: 2 }}>{reset}</div>}
    </div>
  );
}

/** The REAL live-usage block for one account row. Three states, none of which may break the screen:
 *   - `undefined` (not fetched yet) → a muted "Loading real usage…";
 *   - `"error"` (no token / offline / 401 / keychain declined) → "Real usage unavailable", and the
 *     relative token-tally bars below remain the fallback;
 *   - data → the two real percent bars. */
function LiveUsageSection({ live }: { live: AccountUsageLive | "error" | undefined }) {
  if (live === undefined) {
    return (
      <div style={{ marginTop: 6, fontSize: 12, color: C.muted }}>Loading real usage…</div>
    );
  }
  if (live === "error") {
    return (
      <div style={{ marginTop: 6, fontSize: 12, color: C.muted }}>
        Real usage unavailable — showing local estimate below.
      </div>
    );
  }
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: TYPE.micro, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>
        Real usage (Anthropic)
      </div>
      <LiveUsageBar
        label="Session (5h)"
        percent={live.fiveHourPercent}
        resetsAt={live.fiveHourResetsAt}
      />
      <LiveUsageBar
        label="Weekly (7d)"
        percent={live.sevenDayPercent}
        resetsAt={live.sevenDayResetsAt}
      />
    </div>
  );
}

function exhaustedLabel(usage: Usage | undefined, now: number): string | null {
  if (!usage?.exhaustedUntil || usage.exhaustedUntil <= now) return null;
  return `Exhausted until ${clockTime(usage.exhaustedUntil)}`;
}

/** A bordered notice in one ink — the shape every banner on this screen takes. */
function noticeCard(ink: string): CSSProperties {
  return { ...card, borderColor: ink, color: ink, fontSize: 12, lineHeight: 1.5 };
}

/** How each headroom verdict reads and colours.
 *
 *  `unknown` is muted and says so IN WORDS. It must never borrow `ok`'s green or render as a
 *  percentage: an account with too few observed limit episodes has no ceiling, and presenting that
 *  as "0% used" would make the least-measured account look like the emptiest one. */
const HEADROOM_TONE: Record<Headroom["state"], { ink: string; label: string }> = {
  ok: { ink: C.successInk, label: "Room to spare" },
  warn: { ink: C.amberInk, label: "Close to its limit" },
  exhausted: { ink: C.dangerInk, label: "At its limit" },
  unknown: { ink: C.muted, label: "Limit unknown" },
};

/** Where ONE account stands against its OWN learned ceiling — the per-account half of rotation
 *  visibility. Unlike the removed relative cross-account bar, this one
 *  answers "how much room does this account have left", which is what decides when rotation bites.
 *
 *  With no ceiling learned yet it renders words and NO bar. A bar implies a denominator we do not
 *  have, and either extreme of it would be a lie in one direction or the other. */
function HeadroomLine({ headroom, accountId }: { headroom: Headroom; accountId: string }) {
  const tone = HEADROOM_TONE[headroom.state];
  const pct = headroom.fraction != null ? Math.round(headroom.fraction * 100) : null;
  const actPct = Math.round(CEILING_AVOID_FRACTION * 100);
  return (
    <div data-testid={`account-headroom-${accountId}`} style={{ marginTop: 8, fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: tone.ink }}>
        <span style={{ fontWeight: 600 }}>{tone.label}</span>
        {headroom.ceiling != null && pct != null && (
          <span style={{ color: C.muted }}>
            {fmtTokens(headroom.used)} of about {fmtTokens(headroom.ceiling)} · {pct}% of its usual
            limit
          </span>
        )}
      </div>
      {headroom.ceiling == null ? (
        <div style={{ color: C.muted, marginTop: 2 }}>
          Not enough history to estimate a limit yet
        </div>
      ) : (
        <>
          <div
            role="progressbar"
            aria-label="Headroom against learned limit"
            aria-valuenow={Math.min(100, pct ?? 0)}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{
              height: 6,
              borderRadius: 3,
              background: C.deepForest,
              border: `1px solid ${C.muted}`,
              marginTop: 4,
              overflow: "hidden",
            }}
          >
            <div style={{ width: `${Math.min(100, pct ?? 0)}%`, height: "100%", background: tone.ink }} />
          </div>
          {/* The ACT line, not the WARN line. `CEILING_AVOID_FRACTION` is the fraction at which
              auto-pick stops sending this account new work; `headroom.WARN_FRACTION` (0.8) is the
              lower point at which the human is merely told. Two stages, one number each — imported
              rather than typed out so the sentence cannot drift from the behaviour. */}
          <div style={{ color: C.muted, marginTop: 2 }}>
            Stops taking new agents at {actPct}% of that.
          </div>
        </>
      )}
    </div>
  );
}

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
  const excluded = [
    ...readiness.notSignedIn.map(
      (a) =>
        `“${a.nickname}” is registered but has never been signed in, so it cannot receive agents.`,
    ),
    ...readiness.redundant.map(
      (a) =>
        `“${a.nickname}” is the same Claude login as another account, so they share one quota and count as one.`,
    ),
    ...readiness.noEmail.map(
      (a) =>
        `“${a.nickname}” has a Claude login with no readable email, so Sparkle cannot route agents to it.`,
    ),
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
            <li key={line}>{line}</li>
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
  // Bumped after every completed `onLogin` (handleAdd / handleLogin) to re-drive the live-usage
  // effect — the trigger a login provides that the account SET does not (see the effect below).
  const [liveNonce, setLiveNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  // Synchronous mirror of the active rename id. The state closures captured by the
  // input's onBlur/onKeyDown are stale by the time blur fires on unmount, so we
  // gate commit/cancel on this ref instead: Enter and Escape both clear it BEFORE
  // the resulting blur runs, which lets handleRename short-circuit a double-commit
  // (Enter) or a cancelled-edit save (Escape).
  const editingIdRef = useRef<string | null>(null);
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
      setAccounts(a);
      setIdentities(ids);
      setCeilings(cs);
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
  const headroomById = new Map(assessHeadroom(usage, ceilings, now).map((h) => [h.accountId, h]));
  const outlook = exhaustionOutlook(
    readiness.usable.map((a) => a.id),
    usage,
    ceilings,
    now,
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
  const runwayIds = currentAccountId ? [currentAccountId] : readiness.usable.map((a) => a.id);
  const runways = runwayIds
    .map((id) => ({
      account: accounts.find((a) => a.id === id),
      headroom: headroomById.get(id),
      // `switchRecommendation` + `describeRecommendation` ARE the policy and the sentence. This
      // screen does not get a second opinion about either.
      recommendation: switchRecommendation(id, accounts, usage, ceilings, identities, now),
    }))
    .filter(
      (r) =>
        r.account != null &&
        (r.recommendation != null ||
          // The no-target case: running out with nowhere to move. NOT a switch recommendation —
          // there is nothing to recommend — so it cannot come from the formatter, but staying silent
          // about it is exactly the founder's blind spot. Suppressed when AC8's banner is already
          // saying the same thing about the whole pool.
          (!outlook.allAtLimit &&
            (r.headroom?.state === "warn" || r.headroom?.state === "exhausted"))),
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
  async function handleLogin(a: Account) {
    try {
      await onLogin(a);
      await refresh();
      // Re-fetch live usage for the account just (re-)authenticated — including re-logging into the
      // SAME account to recover a row that had failed with a 401 / offline error, where neither the
      // account set nor the identity changes.
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
    try {
      await io.removeAccount(id);
      await refresh();
    } catch (e) {
      setError(errText(e, "Failed to remove"));
    }
  }

  return (
    <div style={{ fontFamily: fontStack, color: C.cream }}>
      <div data-testid="accounts-header" style={stickyHeader}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Claude accounts</div>
        {!adding && (
          <button type="button" style={primaryBtn} onClick={() => setAdding(true)}>
            + Add account
          </button>
        )}
      </div>

      {/* THE GLANCE. How many accounts can actually receive a spawn, and what that means — stated
          before anything else on the screen, because the row count is not that number. */}
      <RotationBanner
        readiness={readiness}
        nameOf={(a) => displayFor(a).primary}
        onAdd={() => setAdding(true)}
      />

      {/* AC8 — every usable account is out of room. Deliberately does NOT claim spawns are blocked:
          `pickAccount` still returns an account rather than refusing, so promising a block would be
          false, and so would implying everything is fine.

          ON THE WORDING: the sentence below is the founder's, chosen to settle a contradiction
          between two older strings (sparkle-cjpte). `pickAccount` IS lowest-usage in the general
          case — see accountSelection.ts — but in THIS branch, where every account is already at its
          limit, the pick is the least-bad fallback rather than a genuinely least-used one. The copy
          is deliberate and is not to be re-voiced here; this note exists so the next reader knows
          the nuance is known rather than overlooked. */}
      {outlook.allAtLimit && (
        <div data-testid="all-at-limit-banner" role="alert" style={noticeCard(C.dangerInk)}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
            <FiAlertTriangle size={13} aria-hidden />
            {readiness.usableLogins === 1
              ? "Your only signed-in account is at its limit."
              : "All accounts are at their limit."}
            {outlook.earliestReset != null
              ? readiness.usableLogins === 1
                ? ` It frees up at ${clockTime(outlook.earliestReset)}.`
                : ` The first frees up at ${clockTime(outlook.earliestReset)}.`
              : " No reset time has been reported yet."}
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
              <span>
                {displayFor(r.account!).primary}
                {r.headroom?.fraction != null
                  ? ` is at ${Math.round(r.headroom.fraction * 100)}% of its usual limit`
                  : " has hit its limit"}
                , and there is no other signed-in account to move to.
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

      {accounts.length === 0 && !adding && (
        <div style={{ ...card, color: C.muted, fontSize: 13 }}>No accounts yet. Add one to get started.</div>
      )}

      {/* BE HONEST ABOUT COVERAGE. `paneAccountMap` holds only MOUNTED panes, so an agent in a
          satellite window or a closed tab is running somewhere and appears in no list below. Saying
          so in one line is cheaper than a reader concluding the lists are exhaustive and that an
          account is idle when it is not. */}
      {accounts.length > 0 && (
        <div data-testid="routing-coverage-note" style={{ fontSize: 12, color: C.muted, margin: "0 0 8px" }}>
          The lists below cover agents with an open tab in this window; agents in other windows or
          closed tabs aren&rsquo;t shown.
        </div>
      )}

      {accounts.map((a) => {
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
        // Can this account be made PRIMARY? Narrower than `signedIn` on purpose — see the Activate
        // button below: `usablePreferredAccount` gates on `signedInAccountIds`, which keys on email.
        const canBePrimary = display.signedIn;
        const primary = display.signedIn
          ? display.primary
          : signedIn
            ? SIGNED_IN_NO_EMAIL
            : display.primary;
        const alias = primary !== display.nickname ? display.nickname : null;
        return (
          <div key={a.id} style={card}>
            {/* ══ CONTROLS ROW — ON TOP, AND THE TEXT BELOW IT ═══════════════════════════════════
                The buttons and the identity text used to share ONE flex row, with the text at
                `flex: 1` beside them. At any width where the buttons did not fit on their own line,
                the name and email wrapped AROUND them and the two collided — which is what the
                founder screenshotted.

                Splitting them into two stacked blocks removes the failure mode rather than tuning
                it: the controls take a full-width wrapping row of their own, so they reflow among
                THEMSELVES at a narrow width, and the text block below is full-width with no
                floated sibling to wrap around. No breakpoint to pick, and nothing to re-tune the
                next time a button is added to this card. */}
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              {/* PRIMARY before `default`, and filled rather than outlined. They answer different
                  questions and the founder's screenshot is why that has to be legible at a glance:
                  an EXHAUSTED account was badged `default` there, which reads as "this is the one
                  in use" when it means nothing of the kind. */}
              {routing.preferredId === a.id && (
                <span data-testid={`account-primary-badge-${a.id}`} style={primaryTagStyle}>
                  primary
                </span>
              )}
              {a.isDefault && <span style={tagStyle}>default</span>}
              {/* Log in / re-point this config dir at a different Claude account. Without this an
                  account could only ever be logged in at the moment it was CREATED, so an account
                  that was never signed into — or two that turned out to hold the SAME login — had no
                  route to a fix but delete-and-recreate. Highlighted for a duplicate, since
                  re-logging one of the pair into a different account is exactly the remedy. */}
              {/* SIGNED-IN accounts only. An account with no login gets its one affordance from the
                  loud block below instead — rendering "Finish sign-in" twice in one card would be
                  noise, and an ambiguous target for a test. */}
              {!isEditing &&
                signedIn &&
                // The DEFAULT account's config dir is the user's real `~/.claude` (registered by
                // reference, never copied — which is also why the Rust side refuses to delete it).
                // Re-logging it in therefore replaces the login used by `claude` EVERYWHERE on this
                // machine, not just inside Sparkle. That is not a one-click action, so it takes the
                // same confirm step as Remove.
                (a.isDefault && confirmLogin !== a.id ? (
                  <button
                    type="button"
                    style={
                      duplicateIds.has(a.id)
                        ? { ...smallBtn, borderColor: C.amber, color: C.amber }
                        : smallBtn
                    }
                    onClick={() => setConfirmLogin(a.id)}
                    // Scope named, not overstated — see AccountLoginModal (knightwatch probe 3).
                    title={`Changes the Claude login Sparkle uses for the default account (${a.configDir || "~/.claude.json"}).`}
                  >
                    Switch login
                  </button>
                ) : a.isDefault ? (
                  <>
                    <button
                      type="button"
                      style={{ ...smallBtn, borderColor: C.amber, color: C.amber }}
                      onClick={() => {
                        setConfirmLogin(null);
                        void handleLogin(a);
                      }}
                      title={`Replaces the login Sparkle uses for the default account (${a.configDir || "~/.claude.json"})`}
                    >
                      Change default account login
                    </button>
                    <button type="button" style={smallBtn} onClick={() => setConfirmLogin(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    style={
                      duplicateIds.has(a.id)
                        ? { ...smallBtn, borderColor: C.amber, color: C.amber }
                        : smallBtn
                    }
                    onClick={() => void handleLogin(a)}
                    title={`Currently ${identity?.email ?? "signed in"}. Logging in again lets you point this account at a different Claude login.`}
                  >
                    Switch login
                  </button>
                ))}
              {!isEditing && (
                <button
                  type="button"
                  style={smallBtn}
                  onClick={() => startRename(a)}
                >
                  Rename
                </button>
              )}
              {/* The default account has no Remove control. NOTE: this is a UI-only rule —
                  `accounts_remove` does NOT reject a default, so do not rely on the backend for it.
                  What the backend does guarantee is that the DIRECTORY survives
                  (`dir_to_remove_on_remove` returns None for a default). */}
              {!a.isDefault &&
                (confirmRemove === a.id ? (
                  <>
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
                  </>
                ) : (
                  <button type="button" style={smallBtn} onClick={() => setConfirmRemove(a.id)}>
                    Remove
                  </button>
                ))}

              {/* The duplicate "Switch all agents here" control that used to render here was REMOVED
                  when this branch merged, along with the `manualAccountSwitch` request channel it
                  published on. It and "Activate this account" below were built in parallel for the
                  same ask, and shipping both put two buttons with overlapping meaning on one card —
                  one of which promised, in its own tooltip, to "move every agent and the concierge",
                  which is the exact opposite of what the sticky section two blocks down tells the
                  user. The channel went with it rather than being left wired: nothing published on
                  it once the button was gone, and a module whose comment says it is live while no
                  caller exists is worse than no module. `activateAccount` is now the ONE entry point
                  — it records the preference with or without a mounted host, and hands the migration
                  to the same `switchTo` this screen's button reaches. */}
            </div>

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
                  <span
                    data-testid={`account-identity-${a.id}`}
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      ...(signedIn ? {} : { color: C.amber }),
                    }}
                    title={
                      signedIn
                        ? undefined
                        : "This config folder holds no Claude login. Log in to give it a real identity."
                    }
                  >
                    {primary}
                  </span>
                  {alias && (
                    <span style={{ fontSize: 12, color: C.muted, display: "block" }}>alias: {alias}</span>
                  )}
                  {identity?.organization && (
                    <span style={{ fontSize: 12, color: C.muted, display: "block" }}>{identity.organization}</span>
                  )}
                  {/* The separate amber "Not signed in" badge is gone: the identity slot above now
                      says it literally, and rendering the same words twice in one card was both
                      noise and an ambiguous target for tests. `isSignedIn` (uuid OR email) still
                      drives the Log in / Switch login affordance above — it is deliberately WIDER
                      than the identity slot's rule (email only), so an account holding an
                      `oauthAccount` with no readable `emailAddress` offers "Switch login" while its
                      identity slot honestly reports it has no email to show. */}
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
                <span style={{ flex: 1, minWidth: 160 }}>
                  <strong>Not signed in — this account cannot receive agents.</strong> Its config
                  folder exists, but no Claude login was ever completed in it.
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

            {/* ── ACTIVATE, and WHAT IS ON THIS ACCOUNT ────────────────────────────────────────
                The control the founder asked for, and immediately under it the answer to the
                question he asked next. A button that silently re-routes an invisible fleet is the
                thing that was unclear; the list is most of the feature. */}
            {(() => {
              const isPrimary = routing.preferredId === a.id;
              const here = consumersOn(a.id);
              return (
                <div data-testid={`account-routing-${a.id}`} style={{ marginTop: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span
                      data-testid={`account-active-state-${a.id}`}
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: isPrimary ? C.successInk : C.muted,
                      }}
                    >
                      {isPrimary ? "Active — new agents run here" : "Inactive"}
                    </span>
                    {isPrimary ? (
                      <button
                        type="button"
                        style={smallBtn}
                        onClick={handleClearPreferred}
                        // Says what it does NOT do, because the opposite is the natural assumption:
                        // nothing already running is dragged back off this account.
                        title="Stop sending new agents here. Agents already running stay where they are."
                      >
                        Back to automatic
                      </button>
                    ) : (
                      <button
                        type="button"
                        style={canBePrimary ? primaryBtn : { ...smallBtn, opacity: 0.5 }}
                        // An account the selection gate would reject cannot receive agents, so
                        // offering the button would be a control that reports success and changes
                        // nothing — the card would flip to "Active — new agents run here" and the
                        // very next spawn would discard the preference, recording a bland "auto".
                        //
                        // Gated on `display.signedIn` (EMAIL-ONLY) rather than the wider `signedIn`
                        // (uuid OR email) precisely so this button and `usablePreferredAccount`
                        // cannot disagree: that gate tests `signedInAccountIds`, which keys on
                        // email. The wider predicate is right for Log in / Switch login beside it —
                        // a uuid-only login IS real — but promising primacy this screen cannot
                        // deliver is the failure mode here.
                        disabled={!canBePrimary}
                        onClick={() => handleActivate(a.id)}
                        title={
                          canBePrimary
                            ? "Run agents on this account. New agents start here; ones already running move as each finishes its turn."
                            : "Sign in to this account first — it cannot receive agents yet."
                        }
                      >
                        Activate this account
                      </button>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
                    {here.length === 0 ? (
                      "Nothing is running on this account right now."
                    ) : (
                      <>
                        Running here: <span style={{ color: C.cream }}>{here.join(", ")}</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Where this account stands against its OWN learned ceiling. An account with no usage
                row yet has nothing measured — rendered as "unknown", never as 0%. */}
            <HeadroomLine
              accountId={a.id}
              headroom={
                headroomById.get(a.id) ?? {
                  accountId: a.id,
                  used: 0,
                  ceiling: null,
                  fraction: null,
                  state: "unknown",
                }
              }
            />

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
            <LiveUsageSection live={liveUsage[a.id]} />
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
