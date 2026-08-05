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
// Design goals (do not regress):
//   • A healthy or returning machine sees NOTHING. Children render immediately and both probes run
//     in the background; a gate only mounts once a probe CONFIRMS a problem — so there is no flash
//     of onboarding for a ready machine and no delay to first paint.
//   • Never lock out a working user over a broken probe. `claude_auth_status` is fail-open in Rust
//     (see accounts.rs), and this adds a visible "Continue anyway" escape on top of it. A gate that
//     can wedge the whole app is a worse dead end than the one it prevents.
//   • Reuse, don't duplicate: install lives in SetupChecklist, sign-in lives in ClaudeSignIn.
//   • AgentPane's post-spawn `no-claude` branch stays as a backstop for a dependency that disappears
//     mid-session.

import { Suspense, lazy, useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { FiAlertTriangle } from "react-icons/fi";
import {
  checkPrereqs,
  checkClaudeAuthStatus,
  authIsDefinitelyExpired,
  type PrereqsReport,
  type ClaudeAuthStatus,
} from "../preflight";
import { readinessStage } from "../services/readiness";
import { onClaudeAuthFailed } from "../services/claudeAuthSignal";
import { C, FONT_WEIGHT } from "../theme/colors";
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

export function ReadinessGate({ children }: { children: ReactNode }) {
  const [report, setReport] = useState<PrereqsReport | null>(null);
  const [auth, setAuth] = useState<ClaudeAuthStatus | null>(null);
  // The user's explicit escape hatch. Once set, the gate never blocks again this session — see the
  // "Continue anyway" button for why that is a deliberate one-way door.
  const [overridden, setOverridden] = useState(false);

  /** Probe both. Split from the effect so focus/auth-failure can re-run it. */
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
      setAuth(await checkClaudeAuthStatus());
    } catch (e) {
      // A broken probe must never BLOCK the app (that would be a worse dead-end than the one we're
      // preventing). Treat it as ready and fall through to the normal flow — AgentPane's no-claude
      // branch still catches a genuinely missing dependency at spawn time.
      console.warn("readiness probe failed; proceeding without the gate:", e);
      setOverridden(true);
    }
  }, []);

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

  const onSignedIn = useCallback(() => {
    // Re-probe rather than optimistically setting `loggedIn: true`: the gate's whole job is to
    // reflect the credential's real state, and ClaudeSignIn already confirmed it. This keeps one
    // source of truth for the answer.
    void probe();
  }, [probe]);

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
      {stage === "auth" && (
        <div style={overlay}>
          <AuthStage
            expired={auth != null && authIsDefinitelyExpired(auth)}
            email={auth?.email ?? null}
            onSignedIn={onSignedIn}
            onOverride={() => setOverridden(true)}
          />
        </div>
      )}
    </>
  );
}

/**
 * The blocking sign-in screen.
 *
 * The copy forks on `expired` because the two audiences need genuinely different sentences, and
 * telling a returning user "welcome, let's get you set up" when their session merely lapsed reads as
 * the app having forgotten them.
 */
function AuthStage({
  expired,
  email,
  onSignedIn,
  onOverride,
}: {
  expired: boolean;
  email: string | null;
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
            {email ? <>Your session for {email} has lapsed. </> : null}
            Signing in again takes a few seconds and everything picks up where you left off.
          </>
        ) : (
          <>
            Sparkle runs Claude on your own Mac, under your own Claude account. Sign in below to get
            started — Sparkle never sees your credentials.
          </>
        )}
      </div>

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
