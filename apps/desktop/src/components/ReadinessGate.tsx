// System-readiness gate. Wraps the whole app (App.tsx wraps <AuthGate/> in this) so a user is walked
// through installing git → Node.js → Claude Code, and then SIGNING IN to Claude, before they get
// blocked deep in the app by a missing dependency or a dead credential.
//
// AUTH IS A GATE, NOT A STEP. That is the change this file exists to make.
//
// It used to be one probe at mount: "prereqs present and an email recorded in .claude.json?" — and
// if not, show a four-row install checklist whose last row was "Sign in to Claude Code". Two things
// were wrong with that, and the founder hit both on a second machine:
//
//   1. It only ever ran at mount, and only really mattered on a fresh machine. There was no path
//      that could ask for auth AGAIN.
//   2. It asked the wrong question. `checkClaudeSignedIn` reads a RECORDED email that survives the
//      session it was written for, so it answers "did you ever sign in", not "can you sign in now".
//
// So when his OAuth session expired, the gate saw a recorded email, reported the machine ready, and
// stayed invisible. He asked the concierge a question and got "Failed to authenticate: OAuth session
// expired and could not be refreshed" with no way to fix it. Reordering onboarding would not have
// saved him — his first run had succeeded.
//
// Now: `checkClaudeAuthStatus` (a live `claude auth status`) drives a stage machine, and the auth
// stage BLOCKS. It is re-probed whenever the window regains focus and whenever something else in the
// app reports an auth failure, so an expiry that happens mid-session is caught on the user's next
// interaction rather than never.
//
// ROTATION AWARENESS — the second machine had ONE account; the founder's main machine has SIX. The
// auth probe only ever looks at the DEFAULT account, and a full-screen block on that one account's
// lapse locked him out of the whole app while five other accounts were healthy and every spawn
// auto-picks a healthy one (`accountSelection.pickAccount` — the default is not privileged there). So
// a default-account lapse now BLOCKS only when the account store confirms no OTHER account is usable.
// When one is, the gate does not block: it steers the fleet preference onto a healthy account (the
// existing "Activate this account" lever) and shows a NON-BLOCKING, dismissible banner that NAMES the
// account needing re-login. `readiness.authGateDecision` is the pure block-vs-banner rule.
//
// Design goals (do not regress):
//   • A healthy or returning machine sees NOTHING. Children render immediately and both probes run
//     in the background; a gate only mounts once a probe CONFIRMS a problem — so there is no flash
//     of onboarding for a ready machine and no delay to first paint.
//   • Never lock out a working user over a broken probe. `claude_auth_status` is fail-open in Rust
//     (see accounts.rs), and this adds a visible "Continue anyway" escape on top of it. A gate that
//     can wedge the whole app is a worse dead end than the one it prevents. A rotation read that
//     fails is treated the SAME way — it fails OPEN to a banner, never to a block.
//   • Reuse, don't duplicate: install lives in SetupChecklist, sign-in lives in ClaudeSignIn, account
//     health lives in accountSelection/accountStore, and the fleet-preference lever is
//     `setPreferredAccountId`. This file invents none of those.
//   • AgentPane's post-spawn `no-claude` branch stays as a backstop for a dependency that disappears
//     mid-session.

import { Suspense, lazy, useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { FiAlertTriangle, FiX } from "react-icons/fi";
import {
  checkPrereqs,
  checkClaudeAuthStatus,
  authIsDefinitelyExpired,
  type PrereqsReport,
  type ClaudeAuthStatus,
} from "../preflight";
import { readinessStage, authGateDecision, type RotationHealth } from "../services/readiness";
import { onClaudeAuthFailed } from "../services/claudeAuthSignal";
import { setCredentialHealth } from "../services/credentialHealth";
import { loadAccountState, liveUsageRows } from "../services/accountSelection";
import {
  eligibleAccounts,
  pickAccount,
  accountDisplay,
  signedInAccountIds,
  loginSiblingIds,
  getPreferredAccountId,
  clearPreferredAccount,
  type Account,
  type Identity,
  type Usage,
  type PickOptions,
} from "../services/accountStore";
import { markRescuedOnto, rescuedOntoIds, rotationOutIds } from "../services/rotationState";
import { recordPreference } from "../hooks/useAccountSwitch";
import { C, FONT_WEIGHT, ON_BRAND_FILL_DARK } from "../theme/colors";
import { ClaudeSignIn } from "./ClaudeSignIn";

// SetupChecklist pulls in the embedded Terminal (xterm) — heavy, and only ever needed on a machine
// that is actually missing something. Code-split so a healthy first-run user never downloads it.
const SetupChecklist = lazy(() =>
  import("./SetupChecklist").then((m) => ({ default: m.SetupChecklist })),
);

/** Full-screen cover so the gate sits above whatever AuthGate/Workspace rendered underneath
 *  (WelcomeScreen uses zIndex 9999; this must win). */
const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  background: C.forest,
  color: C.cream,
  zIndex: 10000,
};

/** The identity of the account the gate is asking the user to re-login, cross-referenced from the
 *  account store rather than the auth probe. `ClaudeAuthStatus.email` is frequently NULL for an
 *  expired session (the founder's screenshot named no account at all), so the store's verified
 *  identity is the trustworthy source — and it also carries the nickname and org the probe never had.
 *  Every field is nullable: we show whatever is known and degrade gracefully, but the whole point is
 *  that the user can tell WHICH of their accounts to re-login. */
export interface ExpiredAccountIdentity {
  nickname: string | null;
  email: string | null;
  organization: string | null;
}

/** `data-testid` for the non-blocking re-login banner (so a real-layout test can find the bar). */
export const READINESS_AUTH_BANNER_TESTID = "readiness-auth-banner";

export function ReadinessGate({ children }: { children: ReactNode }) {
  const [report, setReport] = useState<PrereqsReport | null>(null);
  const [auth, setAuth] = useState<ClaudeAuthStatus | null>(null);
  // Rotation health for a default-account auth failure. `undefined` = not evaluated yet (show nothing
  // rather than flash a banner and then replace it with a block); `null` = evaluated but the store
  // read failed → UNKNOWN → fail open; a value = evaluated. See `readiness.RotationHealth`.
  const [rotation, setRotation] = useState<RotationHealth | null | undefined>(undefined);
  // Which account the gate is naming as needing re-login (the probed default), from the account store.
  const [expiredName, setExpiredName] = useState<ExpiredAccountIdentity | null>(null);
  // The user's explicit escape hatch. Once set, the gate never blocks again this session — see the
  // "Continue anyway" button for why that is a deliberate one-way door.
  const [overridden, setOverridden] = useState(false);
  // The non-blocking banner is dismissible for the session. Kept SEPARATE from `overridden`: dismissing
  // the banner must never suppress a genuine BLOCK if every account later lapses.
  const [bannerDismissed, setBannerDismissed] = useState(false);
  // The banner offers a user-initiated way to open the sign-in surface without being force-blocked.
  const [signInOnDemand, setSignInOnDemand] = useState(false);

  /** Evaluate the account rotation after the DEFAULT account failed to authenticate: is any OTHER
   *  account usable, which account is the one to re-login, and does the fleet pointer need to move so
   *  the app keeps working. Best-effort — any failure fails OPEN (rotation stays UNKNOWN → banner,
   *  never a block). */
  const evaluateRotation = useCallback(async (a: ClaudeAuthStatus) => {
    try {
      const state = await loadAccountState();
      if (state.failed) {
        // The account store could not be read → rotation UNKNOWN. Fail open (a banner, not a block),
        // and name the account from whatever the probe gave us (often null, hence the banner degrades).
        setRotation(null);
        setExpiredName(nameFromProbe(a));
        return;
      }
      const now = Date.now();
      // The SAME option bag `chooseAccountForAgent` builds for a spawn, so "usable" here is exactly
      // what auto-pick considers usable — we do not invent a second notion of health.
      const base = {
        signedInIds: signedInAccountIds(state.identities),
        live: liveUsageRows(),
        siblingIds: loginSiblingIds(state.accounts, state.identities),
        now,
      };
      const eligible = eligibleAccounts(state.accounts, state.usage, base);
      // The gate probes the DEFAULT config dir (no CLAUDE_CONFIG_DIR), so the account it just found
      // expired is the default one. It stays "signed in" by its RECORDED email even when its OAuth has
      // lapsed, so it appears in `eligible` — exclude it before asking whether anything ELSE is usable.
      const alternatives = eligible.filter((x) => !x.isDefault);
      const hasUsableAlternative = alternatives.length > 0;
      setRotation({ hasUsableAlternative });

      // Name the account to re-login — the PROBED (default) one, not just "the first account".
      const probed = state.accounts.find((x) => x.isDefault) ?? null;
      setExpiredName(nameFromStore(probed, state.identities, a));

      // Keep the app WORKING via a healthy account. Auto-pick does not avoid the expired default on
      // its own (a lapsed OAuth still reads "signed in" by its recorded email, so it can win a pick),
      // so steer the fleet-wide preference onto a healthy account — the existing "Activate this
      // account" lever, not a new one. Only when the current pointer is not already usable, so we
      // never clobber a preference the user set on purpose.
      if (hasUsableAlternative) {
        ensureUsablePreferred(alternatives, state.usage, base);
      }
    } catch (e) {
      // Any throw → UNKNOWN → fail open. Never let a rotation read lock the user out.
      console.warn("readiness: rotation health probe failed; not blocking:", e);
      setRotation(null);
      setExpiredName(nameFromProbe(a));
    }
  }, []);

  /** Probe both prereqs and auth. Split from the effect so focus/auth-failure can re-run it. */
  const probe = useCallback(async () => {
    try {
      const r = await checkPrereqs();
      setReport(r);
      if (!r.claude.installed) {
        // Nothing to authenticate against yet. Leave `auth` null rather than synthesising a
        // signed-out status — the install stage owns this case, and a false auth answer here would
        // race the install and briefly show the wrong screen.
        return;
      }
      const a = await checkClaudeAuthStatus();
      setAuth(a);
      if (a.loggedIn) {
        // Healthy default — no rotation question to ask; clear any stale rotation/naming state so a
        // recovered machine shows nothing.
        setRotation(undefined);
        setExpiredName(null);
      } else {
        // The default cannot authenticate. Consult the rotation BEFORE the gate is allowed to block.
        await evaluateRotation(a);
      }
    } catch (e) {
      // A broken probe must never BLOCK the app (that would be a worse dead-end than the one we're
      // preventing). Treat it as ready and fall through to the normal flow — AgentPane's no-claude
      // branch still catches a genuinely missing dependency at spawn time.
      console.warn("readiness probe failed; proceeding without the gate:", e);
      setOverridden(true);
    }
  }, [evaluateRotation]);

  useEffect(() => {
    void probe();
  }, [probe]);

  // RE-PROBE ON FOCUS — this is what makes the gate cover "every run after", not just first run.
  // A session that expires while the app sits in the background is caught when the user comes back,
  // which is the moment before they would otherwise type at a concierge that cannot answer.
  //
  // Skipped once the user has overridden: re-probing would be pointless work whose only possible
  // effect is re-blocking someone who explicitly asked not to be.
  useEffect(() => {
    if (overridden) return;
    const onFocus = () => void probe();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [probe, overridden]);

  // Something else in the app (the concierge, an agent spawn) hit an auth failure. Re-probe so the
  // gate can take over rather than leaving the user to discover it one failed request at a time.
  useEffect(() => {
    if (overridden) return;
    return onClaudeAuthFailed(() => void probe());
  }, [probe, overridden]);

  const stage = overridden ? "ready" : readinessStage(report, auth);
  // Block vs banner vs nothing. While the rotation is still being evaluated for a fresh auth failure
  // (`rotation === undefined`), surface nothing yet — this is what prevents a banner from flashing and
  // then being replaced by a full-screen block a moment later.
  const decision =
    overridden || stage !== "auth" || rotation === undefined
      ? "none"
      : authGateDecision(stage, rotation);

  // ══ PUBLISH THE ONE CREDENTIAL-HEALTH STATE (bead sparkle-s8xi35) ═══════════════════════════════
  // A "block" is precisely "the default account cannot authenticate AND no other account is usable" —
  // auth-expiry detected with no healthy fallback, the frontend twin of `concierge.rs::plan_retry`
  // returning None. That is the ONE fact the concierge send path, the research auto-dispatch and the
  // proactive scheduler must all stop working against, so it is centralised in `credentialHealth`
  // rather than re-derived per consumer. It SELF-HEALS: every re-probe (focus, the auth-failure
  // signal, a confirmed sign-in) recomputes `decision`, so once the human runs /login and a healthy
  // account exists again the decision leaves "block" and this returns to "ok" with no manual reset.
  // An override clears it too — `decision` is "none" then — matching the user's explicit "continue
  // anyway", and a still-probing gate is "none", so nothing is gated before the block is confirmed.
  useEffect(() => {
    setCredentialHealth(decision === "block" ? "expired" : "ok");
  }, [decision]);

  const onSignedIn = useCallback(() => {
    // Re-probe rather than optimistically setting `loggedIn: true`: the gate's whole job is to
    // reflect the credential's real state, and ClaudeSignIn already confirmed it. This keeps one
    // source of truth for the answer. Close the on-demand overlay; if auth is healthy now the re-probe
    // drops every surface anyway.
    setSignInOnDemand(false);
    void probe();
  }, [probe]);

  const expired = auth != null && authIsDefinitelyExpired(auth);
  // The full-screen sign-in overlay shows for a genuine BLOCK, or when the user opened it themselves
  // from the banner. Its escape differs: a block's "Continue anyway" is the permanent session
  // override; the on-demand overlay just closes back to the banner.
  const showOverlay = decision === "block" || signInOnDemand;

  // Children render unconditionally so a healthy machine paints the real first screen with no delay
  // and no flash; a gate only overlays once a probe has CONFIRMED a problem.
  return (
    <>
      {children}
      {stage === "install" && (
        <div style={overlay}>
          <Suspense fallback={null}>
            {/* onReady fires when every prereq is green. Re-probe rather than dismissing outright —
                the auth stage may still be owed, and that is exactly the handoff this gate adds. */}
            <SetupChecklist onReady={() => void probe()} />
          </Suspense>
        </div>
      )}
      {showOverlay && (
        <div style={overlay}>
          <AuthStage
            expired={expired}
            identity={expiredName}
            onSignedIn={onSignedIn}
            onOverride={
              decision === "block" ? () => setOverridden(true) : () => setSignInOnDemand(false)
            }
          />
        </div>
      )}
      {decision === "banner" && !signInOnDemand && !bannerDismissed && (
        <AuthDegradedBanner
          identity={expiredName}
          onSignIn={() => setSignInOnDemand(true)}
          onDismiss={() => setBannerDismissed(true)}
        />
      )}
    </>
  );
}

/** Move the fleet-wide preference onto a healthy account so future spawns stop landing on the expired
 *  default. Reuses `recordPreference` (the durable half of the "Activate this account" lever, minus its
 *  fleet-wide pin sweep) — no new switch logic —
 *  and does nothing when the current preference already names a usable account, so a choice the user
 *  made on purpose is never overwritten. `alternatives` are already the eligible non-default accounts;
 *  `pickAccount` orders them lowest-usage-first exactly as a real spawn would. */
/** EXPORTED FOR ITS TEST, and the export earns itself: this is a silent write on an automatic path,
 *  so the only way to see it go wrong is to call it — which is how it shipped for a while both
 *  ignoring the rotation opt-out on the way in AND able to name an opted-out account on the way out. */
export function ensureUsablePreferred(
  alternatives: Account[],
  usage: Usage[],
  base: PickOptions,
): void {
  // THE ROTATION OPT-OUT IS PART OF "usable" HERE TOO, in both directions, and it was in neither.
  //
  // An opted-out `current` used to read as "already usable → leave it", so the rescue did not even
  // try to re-point; and the pick below ran without `outOfRotationIds`, so it could NAME an
  // opted-out account — producing exactly the inert preference the rest of this feature is built to
  // make impossible (`usablePreferredAccount` declines it on every spawn, so the "keep the app
  // working" steer silently did nothing and the fleet stayed on the expired default).
  const takenOut = rotationOutIds();
  const current = getPreferredAccountId();
  if (current && !takenOut.has(current) && alternatives.some((x) => x.id === current)) return;
  const best = pickAccount(alternatives, usage, { ...base, outOfRotationIds: takenOut });
  // NOTHING TO RESCUE WHEN THE PREFERENCE ALREADY NAMES THE PICK, and this guard is what keeps the
  // kebab's "Take out of rotation" from being a toggle that cannot hold.
  //
  // `probe()` re-runs on EVERY window focus. In the common two-account install — an expired default
  // and one alternative `b` — the gate writes `b`, the user takes `b` out, alt-tabs away and back,
  // and without this: the early return no longer applies (the preference is opted out), `pickAccount`
  // DEMOTES rather than blocks so it returns `b` again (the only alternative), and `recordPreference`
  // puts `b` straight back in rotation. No gesture behind the revision and no bound on the
  // repetition — the control reverts itself on focus, indefinitely, for as long as the default stays
  // expired.
  //
  // ── NOTHING TO RESCUE ONTO ───────────────────────────────────────────────────────────────────
  // The guard has to key on the PICK being opted out, not on it matching `current`, or it does not
  // hold. `pickAccount` DEMOTES rather than blocks, so with one alternative it returns that account
  // however the user has marked it — and an earlier cut keyed on `best?.id === current`, which is
  // false the moment the preference is cleared. That merely delayed the loop by one focus event:
  //
  //   focus 2 — current "b", pick "b" → matched, cleared the preference
  //   focus 3 — current undefined, pick still "b" → no longer matches → wrote it back AND
  //             `recordPreference` put "b" back in rotation
  //
  // `probe()` runs on every window focus for as long as the default stays expired, so the user's
  // kebab click survived exactly one alt-tab. Keying on the opt-out is stable: there is no state in
  // which this writes an account the user has taken out.
  //
  // The preference is still CLEARED when it names an opted-out account, because leaving one is the
  // inert-preference state this codebase declares impossible in two places — one of which
  // (`headroom.bestHealthyTarget`) leans on that claim to justify not consulting the opt-out itself.
  // Selection then auto-picks, where the account is merely demoted, which is what the user asked for.
  if (best && takenOut.has(best.id)) {
    // ONCE, NOT NEVER, AND NOT EVERY TIME. Declining outright was tried and it strands the fleet on
    // the expired default: `leastBad` runs only when `candidates` is EMPTY, and at
    // `chooseAccountForAgent` the lapsed default is still a candidate (recorded email, no wall, no
    // live-spent row), so the opted-out alternative is filtered out and every agent opens on a login
    // prompt. Rescuing every time was also tried and it re-clears the opt-out on every window focus,
    // so the kebab click cannot hold. See `rescuedOnto`.
    if (rescuedOntoIds().has(best.id)) {
      // We already steered here once and the user answered by taking it out again. That is a
      // deliberate second statement and it stands — even though the fleet will now land on the
      // expired default, which is at least VISIBLE (that card renders its own Reconnect button).
      if (current && takenOut.has(current)) clearPreferredAccount();
      return;
    }
    // ORDER MATTERS: `recordPreference` puts the account back in rotation, and that clears this
    // account's rescue memory (so a deliberate human put-back starts a fresh episode). Marking after
    // it is what lets the rescue's own write keep its mark.
    recordPreference(best.id);
    markRescuedOnto(best.id);
    return;
  }
  // Already naming the pick — the rescue's job is done, there is nothing to move it to.
  if (best?.id === current) return;
  // Through the shared helper, so the preference and the account's rotation membership are written
  // together — the invariant `headroom.bestHealthyTarget` now leans on. `pickAccount` DEMOTES rather
  // than blocks, so `best` can still be an opted-out account when it is the only one left; putting it
  // back in rotation is what keeps that honest instead of inert.
  // NO MARK ON THIS PATH. It steers onto an account the user has said nothing about, which is not
  // the rescue-over-an-opt-out the memory is for — and spending the one-shot here meant the user's
  // FIRST kebab click was read as their second, so the very next focus declined and the fleet
  // stranded on the expired default. Permanently, since nothing clears the memory.
  if (best) recordPreference(best.id);
}

/** Name the probed (default) account from the account store's verified identity. Prefers the store
 *  email (which survives an OAuth lapse); falls back to the probe email only as a last resort. */
function nameFromStore(
  probed: Account | null,
  identities: Identity[],
  a: ClaudeAuthStatus,
): ExpiredAccountIdentity {
  if (!probed) return nameFromProbe(a);
  const d = accountDisplay(
    probed,
    identities.find((i) => i.id === probed.id),
  );
  return {
    nickname: d.nickname,
    email: d.signedIn ? d.primary : (a.email ?? null),
    organization: d.organization,
  };
}

/** Fallback naming when the store has nothing to say (unreadable store, or an unregistered default):
 *  the auth-probe email, which is usually null for an expired session — hence "degrade gracefully". */
function nameFromProbe(a: ClaudeAuthStatus): ExpiredAccountIdentity {
  return { nickname: null, email: a.email ?? null, organization: null };
}

/** Renders the specific account a re-login is for: nickname (bold/primary), then email, then org.
 *  Shows only the fields that are known. Returns null when nothing is known, so callers can render it
 *  unconditionally and simply get nothing when the account could not be named. */
function AccountIdentityLines({ identity }: { identity: ExpiredAccountIdentity | null }) {
  if (!identity || (!identity.nickname && !identity.email && !identity.organization)) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "center" }}>
      {identity.nickname ? (
        <span style={{ fontWeight: FONT_WEIGHT.semibold }}>{identity.nickname}</span>
      ) : null}
      {identity.email ? <span>{identity.email}</span> : null}
      {identity.organization ? (
        <span style={{ opacity: 0.8 }}>{identity.organization}</span>
      ) : null}
    </div>
  );
}

/**
 * The blocking sign-in screen.
 *
 * The copy forks on `expired` because the two audiences need genuinely different sentences, and
 * telling a returning user "welcome, let's get you set up" when their session merely lapsed reads as
 * the app having forgotten them. The specific account is named from the store (`identity`), because
 * the auth probe's own email is frequently null for an expired session.
 */
function AuthStage({
  expired,
  identity,
  onSignedIn,
  onOverride,
}: {
  expired: boolean;
  identity: ExpiredAccountIdentity | null;
  onSignedIn: () => void;
  onOverride: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        color: C.cream,
        overflow: "auto",
      }}
    >
      <style>{SPIN_KEYFRAMES}</style>
      <div style={{ fontSize: 17, fontWeight: FONT_WEIGHT.semibold }}>
        {expired ? "Your Claude sign-in expired" : "Sign in to Claude"}
      </div>
      <div style={{ color: C.muted, maxWidth: 560, lineHeight: 1.5, textAlign: "center" }}>
        {expired ? (
          <>
            This account needs to sign in again. Signing in takes a few seconds and everything picks up
            where you left off.
          </>
        ) : (
          <>
            Sparkle runs Claude on your own Mac, under your own Claude account. Sign in below to get
            started — Sparkle never sees your credentials.
          </>
        )}
      </div>
      {expired ? <AccountIdentityLines identity={identity} /> : null}

      <div
        style={{
          width: "100%",
          maxWidth: 760,
          flex: "1 1 auto",
          minHeight: 260,
          maxHeight: 520,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <ClaudeSignIn onSignedIn={onSignedIn} />
      </div>

      {/* THE ESCAPE HATCH. This gate blocks the entire app on the word of a subprocess probe, so it
          must have a visible way out — a probe bug, an unusual auth setup (a gateway, a console
          key), or simply a user who wants to look around must never be permanently locked out. It
          is one-way for the session on purpose: re-blocking someone who just said "not now" on the
          next focus event would be the same trap with extra steps. The concierge still names the
          auth failure and offers re-auth in place, so the path back is never lost. */}
      <button type="button" onClick={onOverride} style={overrideButton}>
        <FiAlertTriangle size={13} aria-hidden style={{ marginRight: 6, verticalAlign: "-2px" }} />
        Continue anyway — agents may not work
      </button>
    </div>
  );
}

/**
 * The NON-BLOCKING re-login notice. Shown when the default account's session lapsed but another
 * account is usable (or the rotation could not be read): the app keeps working via a healthy account,
 * so this only informs — it never covers the screen. It NAMES the account so the user knows which one
 * to re-login, offers an in-place "Sign in" that opens the sign-in surface on demand, and a dismiss ✕.
 *
 * Follows the app-shell banner family's visual contract (see AiServiceBanner): the theme-constant
 * amber caution fill with brand-navy ink, a top-anchored row, a `role="status"` live region for the
 * sentence, and an out-of-flow ✕.
 */
function AuthDegradedBanner({
  identity,
  onSignIn,
  onDismiss,
}: {
  identity: ExpiredAccountIdentity | null;
  onSignIn: () => void;
  onDismiss: () => void;
}) {
  const name = bannerAccountName(identity);
  return (
    <div style={bannerBar} data-testid={READINESS_AUTH_BANNER_TESTID}>
      <FiAlertTriangle size={14} style={{ flex: "none", marginTop: 1 }} aria-hidden />
      <span role="status" aria-live="polite" style={bannerSentence}>
        {/* Name the account in bold so the user can pick it out of several. `name` is never empty —
            bannerAccountName degrades to a generic phrase when the store had nothing. */}
        <strong>{name}</strong> needs to sign in again — agents are running on your other accounts.
        {identity?.email && identity.email !== name ? <> ({identity.email})</> : null}
      </span>
      <button type="button" onClick={onSignIn} style={bannerSignIn}>
        Sign in
      </button>
      <button type="button" aria-label="Dismiss" title="Dismiss" style={bannerDismiss} onClick={onDismiss}>
        <FiX size={14} aria-hidden />
      </button>
    </div>
  );
}

/** The account label for the banner sentence: nickname first (what the user named it), else the email,
 *  else a generic phrase so the sentence is always grammatical even when the store named nothing. */
function bannerAccountName(identity: ExpiredAccountIdentity | null): string {
  return identity?.nickname ?? identity?.email ?? "One of your Claude accounts";
}

/** Spin keyframes for ClaudeSignIn's confirming spinner, which uses the shared `.setup-spin` class.
 *  Rendered here because this stage can mount without SetupChecklist (which owns the other copy). */
const SPIN_KEYFRAMES = `@keyframes setup-spin { to { transform: rotate(360deg) } } .setup-spin { animation: setup-spin 1s linear infinite; }`;

const overrideButton: CSSProperties = {
  background: "transparent",
  color: C.muted,
  border: `1px solid ${C.hairline}`,
  borderRadius: 6,
  padding: "6px 14px",
  fontWeight: FONT_WEIGHT.medium,
  fontSize: 12,
  cursor: "pointer",
};

// ── Banner styles (mirrors the app-shell banner family; see AiServiceBanner) ──────────────────────
// Brand amber is the theme-CONSTANT caution fill, so its ink is the constant brand navy rather than
// the themed cream. The bar is fixed to the top so it overlays without pushing layout, and sits above
// ordinary chrome but BELOW the full-screen overlay (which uses zIndex 10000).
const bannerBar: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  gap: 8,
  background: C.amber,
  color: ON_BRAND_FILL_DARK,
  padding: "6px 40px",
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  zIndex: 9998,
};

const bannerSentence: CSSProperties = {
  minWidth: 0,
  overflowWrap: "break-word",
};

const bannerSignIn: CSSProperties = {
  flex: "none",
  background: "transparent",
  color: ON_BRAND_FILL_DARK,
  border: `1px solid ${ON_BRAND_FILL_DARK}`,
  borderRadius: 6,
  padding: "1px 8px",
  fontWeight: FONT_WEIGHT.semibold,
  fontSize: 12,
  cursor: "pointer",
};

const bannerDismiss: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  background: "transparent",
  border: "none",
  padding: 2,
  margin: 0,
  cursor: "pointer",
  color: ON_BRAND_FILL_DARK,
  lineHeight: 0,
};
