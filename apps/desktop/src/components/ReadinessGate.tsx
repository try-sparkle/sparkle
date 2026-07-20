// Proactive first-run system-readiness gate. Wraps the whole app (App.tsx wraps <AuthGate/> in this)
// so a brand-new external user is walked through installing git → Node.js → Claude Code + signing in
// BEFORE they get blocked deep in the app by a missing dependency (the old behavior only surfaced the
// checklist AFTER auth + paywall + the first agent spawn, via AgentPane's `no-claude` branch).
//
// Design goals (do not regress):
//   • A healthy or returning machine sees NOTHING new. We render children immediately and probe in
//     the background; the checklist is only ever mounted once the probe CONFIRMS something is
//     missing — so there is no flash of an onboarding screen for a machine that's already ready, and
//     no delay to first paint.
//   • Reuse, don't duplicate: the detection + no-sudo install engine lives in SetupChecklist /
//     preflight; this gate only decides WHEN to show it (one cheap prereqs probe) via the pure
//     readinessComplete() predicate.
//   • The post-spawn `no-claude` branch in AgentPane stays as a backstop for a dependency that
//     disappears mid-session.

import { Suspense, lazy, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { checkPrereqs, checkClaudeSignedIn } from "../preflight";
import { readinessComplete } from "../services/readiness";
import { C } from "../theme/colors";

// SetupChecklist pulls in the embedded Terminal (xterm) for the `claude login` step — heavy, and
// only ever needed on a machine that's actually missing something. Code-split it so a healthy
// first-run user (the common case) never downloads or parses it.
const SetupChecklist = lazy(() =>
  import("./SetupChecklist").then((m) => ({ default: m.SetupChecklist })),
);

/** Full-screen cover for the checklist so it sits above whatever AuthGate/Workspace rendered
 *  underneath (WelcomeScreen uses zIndex 9999; this must win). */
const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  background: C.forest,
  color: C.cream,
  zIndex: 10000,
};

/** null = probing (render nothing extra — children only), false = ready, true = show the checklist. */
type Readiness = null | boolean;

export function ReadinessGate({ children }: { children: ReactNode }) {
  const [needsSetup, setNeedsSetup] = useState<Readiness>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const report = await checkPrereqs();
        // `claude login` state only matters once claude itself is present.
        const signedIn = report.claude.installed ? await checkClaudeSignedIn() : false;
        if (!alive) return;
        setNeedsSetup(!readinessComplete(report, signedIn));
      } catch (e) {
        // A broken probe must never BLOCK the app (that would be a worse dead-end than the one we're
        // preventing). Treat it as ready and fall through to the normal flow — AgentPane's no-claude
        // branch still catches a genuinely missing dependency at spawn time.
        console.warn("readiness probe failed; proceeding without the setup gate:", e);
        if (alive) setNeedsSetup(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Render children unconditionally so a healthy machine paints the real first screen with no delay
  // and no flash; only overlay the checklist once the probe has CONFIRMED a missing prerequisite.
  return (
    <>
      {children}
      {needsSetup === true && (
        <div style={overlay}>
          <Suspense fallback={null}>
            {/* onReady fires when every prereq is green AND the user has signed in — dismiss the
                overlay and reveal the app underneath (welcome / trial / workspace). */}
            <SetupChecklist onReady={() => setNeedsSetup(false)} />
          </Suspense>
        </div>
      )}
    </>
  );
}
