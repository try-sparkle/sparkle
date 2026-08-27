// useNudgeFlags — make the nudger flag table a signal React can actually see.
//
// THE PROBLEM IT SOLVES (roborev 65339). `services/authRecovery` keeps raised nudger flags in a
// module-level `Map`, filled by a `nudger://escalation` Tauri listener and a 30s poll. Neither is a
// store, so nothing a component selects on changes when a flag arrives. `engine/humanBlock` reads
// that table to decide whether a row is `blocked-on-human` — i.e. whether the dot is RED — and a
// value read during render with no subscription is a value the UI updates on by coincidence.
//
// The coincidence does not arrive for the population this signal is about. A flagged agent has gone
// SILENT, so its status, branch status and workflow state are static by definition — exactly the
// deps the sidebar's memos are keyed on. The row could stay amber indefinitely while the app knew
// perfectly well the agent had said a person was blocking it.
//
// ── WHY A SNAPSHOT AND NOT A COUNTER (roborev 65409) ──────────────────────────────────────────
// This started as a version NUMBER threaded into dep arrays. That worked at runtime and was
// unenforceable: nothing in the hook bodies read it, so `react-hooks/exhaustive-deps` reported it as
// an "unnecessary dependency" and its own suggested fix — delete it — silently restores the stale
// derivation. Adding a `void version;` reference satisfied the linter but changed nothing: it is
// dead code, so deleting all of it is behaviour-preserving and no test fails.
//
// A SNAPSHOT is load-bearing instead of decorative. The derivations read it to answer their
// question, so the lint rule now DEMANDS the dependency rather than objecting to it, and dropping it
// does not compile. That is the same move the `humanBlockedOf` parameter took when it stopped being
// defaulted (roborev 65373): make the seam a type error, not a comment.
import { useSyncExternalStore } from "react";
import { nudgeFlagsSnapshot, subscribeNudgeFlags } from "./services/authRecovery";
import type { NudgeFlagSnapshot } from "./services/humanBlockFor";

/**
 * The current flag table, re-rendering this component whenever it changes.
 *
 * Pass it to `humanBlockIn`/`isHumanBlockedIn` and list it in the surrounding memo's deps — where it
 * now belongs by the linter's own rule, because the closure reads it.
 *
 * `Object.is` on a REPLACED map is what makes this correct: `publishFlagSnapshot` builds a new `Map` per
 * change, so the identity moves exactly when the contents do — no churn on an idle app, and no
 * missed change.
 */
export function useNudgeFlagSnapshot(): NudgeFlagSnapshot {
  return useSyncExternalStore(subscribeNudgeFlags, nudgeFlagsSnapshot, nudgeFlagsSnapshot);
}
