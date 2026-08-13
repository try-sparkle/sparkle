// useSparkleSessionBinding — give the ONE mounted agent that has no hook events a session binding.
//
// `useAgentTranscript` reads nothing for an agent whose Claude session ids it does not know, and
// that is correct: the fallback it would otherwise take — the newest session file in the worktree's
// directory — renders whatever OTHER `claude` last wrote there, under this agent's name. Failing
// closed is the fix, not a limitation to route around.
//
// But writer (3) had exactly one production writer, `AgentPane`'s gated hook handler, and the
// app-owned Improve Sparkle agent has no `AgentPane`: `SparkleAgentPane` mirrors the pane and wires
// no hook handler, and the hourly improvement pass is headless — which is the entire reason
// `services/sparkleTranscript` exists. `ConciergeHost` explicitly supports mounting that agent, so
// mounting the very agent the wrong-conversation bug was reported against rendered an EMPTY
// transcript forever: no reads, no tail, no error (roborev 63133 / 63135). The defect was fixed by
// switching the feature off for its primary target.
//
// This hook is that agent's binding source. Two properties are load-bearing:
//
//   • IT RUNS AT THE MOUNT, not only at registration. Every hourly pass spawns with no `--resume`
//     and therefore opens a NEW session, so a resolve taken when the worktree was registered names
//     the session that was newest THEN — mid-pass, the PREVIOUS pass's. Same reasoning that made
//     writer (2) store a directory rather than a file (roborev 55363); the binding has to be
//     refreshed where the reading happens. Writer (3) accumulates, so a refresh ADDS the live
//     session and leaves the earlier ones readable, and `bindWorktreeSession` no-ops on an id it
//     already holds — a re-mount onto an unchanged session neither re-renders nor re-fetches.
//
//   • IT IS GATED ON THE SPARKLE NAMESPACE, and that gate is the whole safety argument. Every
//     ordinary build agent ALSO has a registered worktree (`projectStore.setAgentWorktree` writes
//     one the moment a worktree is cut) and every one of them gets a real, session-gated binding
//     from its own pane's hook stream. Seeding those from a directory scan would trade that evidence
//     for a guess, in a directory measured at 41-1,172 files — i.e. re-enter the original bug from
//     the other side. The app-owned agent is the one case where no better source exists and the
//     worktree was cut by the app for that agent alone; see services/sparkleTranscript's safety
//     block for the residual race it inherits.
import { useEffect } from "react";

import { isSparkleAgentId } from "../services/sparkleAgent";
import { bindWorktreeSession } from "../services/sparkleTranscript";

/**
 * While `agentId` is the app-owned Sparkle agent and its worktree is known, keep its Claude session
 * binding current so the mounted transcript can read it.
 *
 * A no-op for every other agent, for an unmounted column, and for a Sparkle agent whose worktree has
 * not been registered yet — all three are ordinary states, not faults. Fire-and-forget: the binding
 * is subscribed by the reader, so an id that lands after the first render re-pages the pane on its
 * own.
 */
export function useSparkleSessionBinding(
  agentId: string | null,
  worktreePath: string | null,
): void {
  useEffect(() => {
    if (!agentId || !worktreePath) return;
    if (!isSparkleAgentId(agentId)) return;
    void bindWorktreeSession(agentId, worktreePath);
  }, [agentId, worktreePath]);
}
