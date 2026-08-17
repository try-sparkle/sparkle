// Pure predicates for the readiness gate (ReadinessGate.tsx). Kept free of React and Tauri IPC so
// the "what does the user need to do before the app is usable" decision is unit-testable in
// isolation. The gate probes with checkPrereqs()/checkClaudeAuthStatus() and feeds the result here;
// the detect-and-install engine (SetupChecklist) and the sign-in surface (ClaudeSignIn) are reused.
//
// WHY INSTALL AND AUTH ARE SEPARATE STAGES NOW.
//
// They used to be one boolean: "everything installed AND signed in" → show the checklist, which had
// the login step as its fourth row. That conflated two things with completely different shapes:
//
//   • INSTALL is machine work. It runs unattended, it only ever happens on a fresh machine, and the
//     user's only job is to wait. It is genuinely first-run-only.
//   • AUTH is user work, and it is NOT first-run-only. A session expires; the user must come back
//     and re-authenticate on a machine that is otherwise perfectly set up.
//
// Folding auth into a first-run install checklist meant there was no way to ask for auth AGAIN — so
// when the founder's OAuth session expired on a second machine, nothing asked. The concierge just
// failed. Splitting the stages is what lets the same gate serve first run and every run after.
//
// The ordering constraint is real and cannot be designed away: `claude auth login` needs the claude
// binary, so install genuinely must precede auth. What CAN be arranged — and is, by `readinessStage`
// returning "install" before "auth" — is that install is the stage that needs no user decisions,
// and auth is the first thing the user is actually ASKED for.

import type { PrereqsReport, ClaudeAuthStatus } from "../preflight";

/** All three runtime prerequisites (git, node, claude) are present on the machine. */
export function prereqsAllInstalled(r: PrereqsReport): boolean {
  return r.git.installed && r.node.installed && r.claude.installed;
}

/**
 * What the gate should be showing.
 *
 *  • `probing`  — no answer yet. Renders NOTHING extra, so a healthy machine paints the real first
 *                 screen with no delay and no flash of onboarding.
 *  • `install`  — a prerequisite is missing. SetupChecklist.
 *  • `auth`     — everything is installed but Claude Code cannot authenticate. ClaudeSignIn.
 *  • `ready`    — get out of the way.
 */
export type ReadinessStage = "probing" | "install" | "auth" | "ready";

/**
 * Decide the stage from the two probes. `null` for either means "not answered yet".
 *
 * INSTALL IS CHECKED FIRST, and that ordering is load-bearing rather than cosmetic: with claude
 * absent there is nothing to authenticate against, and an auth screen offering a Sign in button
 * that cannot run would be a dead end. It also means a machine missing a prerequisite never has to
 * answer the auth question at all.
 *
 * A `null` auth status with prereqs present is `probing`, NOT `ready`. Returning `ready` there would
 * flash the app for the length of the auth probe and then yank it away — and, worse, would let a
 * user start typing at a concierge that is about to be gated.
 */
export function readinessStage(
  r: PrereqsReport | null,
  auth: ClaudeAuthStatus | null,
): ReadinessStage {
  if (r === null) return "probing";
  if (!prereqsAllInstalled(r)) return "install";
  if (auth === null) return "probing";
  return auth.loggedIn ? "ready" : "auth";
}

/**
 * The machine is fully ready to run agents. Retained as the single-expression form of "the gate
 * shows nothing", and used by callers that only want the boolean.
 *
 * NOTE THE SECOND ARGUMENT IS AN AUTH STATUS, NOT A `signedIn` BOOLEAN — the change is the whole
 * point of this module's rewrite. It used to take `claudeSignedIn`, sourced from
 * `checkClaudeSignedIn`, which reports a RECORDED email that outlives the session it was written
 * for. That predicate could not go false for an expired session, so the gate stayed invisible while
 * every `claude` child on the machine was failing to authenticate.
 */
export function readinessComplete(r: PrereqsReport, auth: ClaudeAuthStatus): boolean {
  return readinessStage(r, auth) === "ready";
}

// ── ROTATION-AWARE auth gate ──────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS. `readinessStage` above answers "can the DEFAULT account authenticate?" — the only
// account the gate ever probes (`checkClaudeAuthStatus()` with no config dir). When it cannot, the
// stage is "auth". But a full-screen BLOCK on that one fact is wrong the moment the machine runs more
// than one Claude account: the founder had six accounts, five healthy, and a lapsed session on the
// DEFAULT one locked him out of the whole app even though every spawn auto-picks a healthy account
// (`accountSelection.pickAccount`). The default is not privileged in selection — it is just the one
// this gate happened to probe.
//
// So a default-account auth failure is no longer automatically a dead end. It is a dead end ONLY when
// the ROTATION cannot carry the app either. This decision is kept here, pure and IPC-free, so it is
// unit-testable; the gate computes the rotation summary from the account store and feeds it in.

/**
 * A minimal, IPC-free summary of whether the account ROTATION can carry the app while the account the
 * gate probed (the default) cannot authenticate. Computed by `ReadinessGate` from the account store
 * (`eligibleAccounts`) and passed to {@link authGateDecision}.
 *
 * `null` is a DISTINCT third state from `{ hasUsableAlternative: false }`, and the distinction is the
 * whole point: `null` means "we could not read the rotation at all" (the store read failed or threw),
 * which must FAIL OPEN — a broken store read must never lock the user out. `false` is a read that
 * SUCCEEDED and genuinely found nothing usable — the real single-account dead end this gate was built
 * for. Conflating the two would turn a transient IPC hiccup into a full-screen lockout.
 */
export interface RotationHealth {
  /** At least one account OTHER than the probed (expired) default is usable RIGHT NOW — signed in and
   *  not exhausted, per `accountStore.eligibleAccounts`. This is NOT a new notion of "usable": it is
   *  exactly the predicate auto-pick uses to choose the account a spawn runs under. */
  hasUsableAlternative: boolean;
}

/** How a default-account auth failure should be surfaced. */
export type AuthGateDecision = "none" | "banner" | "block";

/**
 * Decide how to surface a default-account auth failure, given the readiness stage and what we know
 * about the rotation. The asymmetry is deliberate: we BLOCK only on a positive "nothing usable", and
 * every other path — a usable alternative, or an unreadable store — declines to block.
 *
 *   • "block"  — a FULL-SCREEN dead end, and the ONLY case that still blocks the whole app. Chosen
 *                solely when we POSITIVELY know rotation cannot help: the store read succeeded AND no
 *                other account is usable (`rotation.hasUsableAlternative === false`). This is the
 *                single-account expiry the gate was originally built for; its "Continue anyway" escape
 *                hatch still applies.
 *   • "banner" — a NON-BLOCKING, dismissible notice. Chosen when another account is usable (the app
 *                keeps working via that account) OR when rotation health is UNKNOWN (`rotation ===
 *                null`). Unknown FAILS OPEN and lands here, never on "block".
 *   • "none"   — not the auth stage; the gate shows nothing (or the install stage owns it).
 */
export function authGateDecision(
  stage: ReadinessStage,
  rotation: RotationHealth | null,
): AuthGateDecision {
  if (stage !== "auth") return "none";
  // Block ONLY on a positive, successfully-read "nothing else is usable". A null rotation (unreadable
  // store) is not that — it fails open to a banner below.
  if (rotation !== null && !rotation.hasUsableAlternative) return "block";
  return "banner";
}
