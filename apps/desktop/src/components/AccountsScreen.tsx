import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { FiAlertTriangle, FiRotateCw, FiSlash, FiUserPlus } from "react-icons/fi";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { FONT_UI } from "../theme/scale";
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
  CEILING_AVOID_FRACTION,
  type Account,
  type Usage,
  type Identity,
} from "../services/accountStore";
import {
  assessHeadroom,
  rotationReadiness,
  exhaustionOutlook,
  switchRecommendation,
  describeRecommendation,
  type Ceiling,
  type Headroom,
} from "../services/headroom";

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
  // OTHER (the relative UsageBars) but never how close any of them is to its OWN limit — which is
  // the number that decides whether rotation is about to matter.
  listCeilings,
  addAccount,
  setNickname,
  removeAccount,
  // The spawn ledger read. Injectable like every other IO on this screen — without it the panel
  // fell back to the real `invoke("accounts_spawn_log")` inside a component suite that mocks no
  // Tauri bridge, so the call rejected, resolved to [] outside `act()` after the assertions had
  // run, and the mount could not be asserted at all.
  readSpawnLog,
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

/** A labelled usage bar showing this account's token usage for a window, filled RELATIVE to the
 *  busiest account (`peakTokens`) — there's no real Anthropic cap to read, so the comparison is
 *  cross-account: the heaviest-used account fills the bar and the emptiest reads shortest, making
 *  "which account has the most headroom" (where new jobs go) obvious at a glance. The raw count is
 *  shown alongside. A lone account (peak == its own usage) reads full — there's nothing to compare
 *  it against. */
function UsageBar({
  label,
  tokens,
  peakTokens,
}: {
  label: string;
  tokens: number;
  peakTokens: number;
}) {
  const pct = peakTokens > 0 ? Math.min(100, (tokens / peakTokens) * 100) : 0;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.muted }}>
        <span>{label}</span>
        <span>{fmtTokens(tokens)}</span>
      </div>
      <div
        role="progressbar"
        aria-label={`${label} usage`}
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
    </div>
  );
}

/** Wall-clock time in the user's own locale ("8:20 PM"). One formatter, so the per-account line and
 *  the all-exhausted banner can never quote the same instant two different ways. */
function clockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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
 *  visibility. Distinct from {@link UsageBar}, which compares accounts to each other; this one
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
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [a, u, ids, cs] = await Promise.all([
        listAccountsFn(),
        getUsageFn(),
        getIdentitiesFn(),
        // Ceilings are an ENRICHMENT, not a prerequisite: they add the "% of its own limit" numbers.
        // Sharing the rejection path with `listAccounts` would let a backend that cannot answer
        // `accounts_ceilings` blank the entire account list — trading a missing percentage for a
        // screen that shows no accounts at all. Degrade to "unknown" per account instead.
        listCeilingsFn().catch(() => [] as Ceiling[]),
      ]);
      setAccounts(a);
      setUsage(u);
      setIdentities(ids);
      setCeilings(cs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load accounts");
    }
  }, [listAccountsFn, getUsageFn, getIdentitiesFn, listCeilingsFn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const usageFor = (id: string) => usage.find((u) => u.id === id);
  const identityFor = (id: string) => identities.find((i) => i.id === id);
  // Registrations that resolve to the SAME Anthropic account (same identity key: uuid when
  // recorded, else the verified email) — see the
  // banner below and `duplicateAccountGroups`.
  const duplicates = duplicateAccountGroups(accounts, identities);
  const duplicateIds = new Set(duplicates.flatMap((g) => g.accounts.map((a) => a.id)));
  const now = Date.now();
  // Each window's bar fills RELATIVE to the busiest account, so the emptiest account reads shortest
  // (= most headroom). Floor at 1 so an all-zero set divides cleanly to empty bars, not NaN.
  const peak5h = Math.max(1, ...usage.map((u) => u.tokens5h));
  const peak7d = Math.max(1, ...usage.map((u) => u.tokens7d));

  // ── Rotation visibility ─────────────────────────────────────────────────────────────────────
  // Every number below is DERIVED from the same pure policy the spawn path uses. Nothing here
  // decides anything; it reports what selection is already doing, which is the entire point — the
  // bug was never that selection was wrong, it was that its input pool was invisible.
  const displayFor = (a: Account) => accountDisplay(a, identityFor(a.id));
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add account");
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to log in");
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
      setError(e instanceof Error ? e.message : "Failed to rename");
    }
  }

  async function handleRemove(id: string) {
    setConfirmRemove(null);
    try {
      await io.removeAccount(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove");
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
          {g.accounts.map((a) => a.nickname).join(" and ")} share one usage quota, so switching
          between them gains you nothing — they hit the limit together. Log one of them into a
          different Claude account, or remove it.
        </div>
      ))}

      {accounts.length === 0 && !adding && (
        <div style={{ ...card, color: C.muted, fontSize: 13 }}>No accounts yet. Add one to get started.</div>
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
        const primary = display.signedIn
          ? display.primary
          : signedIn
            ? SIGNED_IN_NO_EMAIL
            : display.primary;
        const alias = primary !== display.nickname ? display.nickname : null;
        return (
          <div key={a.id} style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
                  style={{ ...inputStyle, flex: 1 }}
                />
              ) : (
                <span style={{ flex: 1, minWidth: 0 }}>
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
                      drives the Log in / Switch login affordance below — it is deliberately WIDER
                      than the identity slot's rule (email only), so an account holding an
                      `oauthAccount` with no readable `emailAddress` offers "Switch login" while its
                      identity slot honestly reports it has no email to show. */}
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

            <UsageBar label="5-hour window" tokens={u?.tokens5h ?? 0} peakTokens={peak5h} />
            <UsageBar label="7-day window" tokens={u?.tokens7d ?? 0} peakTokens={peak7d} />
          </div>
        );
      })}

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
