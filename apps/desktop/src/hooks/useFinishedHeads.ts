// "Has the app POSITIVELY READ this agent as finished?" — one derivation, for every surface that
// has to agree about it.
//
// ══ WHY THIS IS A HOOK AND NOT A LOCAL `useCallback` ═══════════════════════════════════════════
// It lived inside `AgentSidebar` and had exactly one consumer, which was fine while the Build
// column was the only surface that painted a rolled-up disc. It is not any more: the Epics column
// (bead `sparkle-l06ax7`) now paints an epic's square from the SAME `rollupViewFor` composition, and
// `rollupViewFor`'s own parameter doc states what happens to a caller that omits this reading —
//
//   *"`dotOf` reads the finished-calmed published map, so a column that skipped it would keep
//   painting a finished head red while every other surface had calmed it."*
//
// which is precisely the column↔column drift `engine/workerRollup`'s header says the shared entry
// point exists to prevent. A finished orchestrator still carrying a red worker bubble would have
// painted its EPIC red beside a build row the sidebar had already gone quiet on — the founder-
// visible *"why is this red? nothing is blocked by me"* symptom, one column over.
//
// The obvious alternative — copy the eight-line chain into the second caller — is the thing
// `AgentSidebar`'s own comment at the old site warns against: *"Re-deriving it in two places is how
// this subsystem has drifted before."*
//
// ══ WHAT IT DOES NOT OWN ═══════════════════════════════════════════════════════════════════════
// `calmStatus` and `nudgeFlags` are PARAMETERS, not derived here. Both have other consumers in
// `AgentSidebar` (the escalation map, the row's own colour) and re-deriving them inside would mean
// that component holding two objects built from the same inputs — value-identical, but two things
// to keep in step for no gain. The rule that must not drift is the VERDICT, and the verdict is what
// this file owns.
import { useCallback } from "react";
import { stallReport } from "../engine/agentStall";
import { stallInputsFor } from "../components/rowAttention";
import { quotaBlockForAgent } from "../engine/engineRegistry";
import { humanBlockIn, type NudgeFlagSnapshot } from "../services/humanBlockFor";
import { awaitingCloseEvidenceFor } from "../services/agentGoalReading";
import { useRuntimeStore } from "../stores/runtimeStore";
import type { AgentTab, AgentTabStatus } from "../types";

/**
 * `id → was this agent positively read as FINISHED?`
 *
 * THREE ANSWERS, AND THE DOC THIS REPLACES GOT ONE OF THEM WRONG. It said `undefined` meant "the
 * git state was never read"; it does not, and the claim rode along verbatim from the call site this
 * was lifted out of:
 *
 *   `true`      — positively read as finished.
 *   `false`     — asked and told no. This INCLUDES `stallReport`'s `unknown` verdict, i.e. "idle,
 *                 nothing outstanding found, but the git state was never read — do not report it as
 *                 finished". Unexamined collapses into not-finished here, which is the safe
 *                 direction and is why the mistake was invisible.
 *   `undefined` — there is no agent record for this id at all.
 *
 * All three are safe at the one consumer: `engine/finishedHeadCalm` demands `=== true` before it
 * demotes anything, so a head is calmed only on a positive reading and never on the absence of one.
 * A future caller reading `!== false` as "we did not look" would be wrong about the middle arm —
 * which is why the three are spelled out and pinned by `useFinishedHeads.test.tsx`.
 *
 * @param agentsById the caller's own index. Passed in rather than built here so the caller keeps
 *   ONE index — `AgentSidebar`'s exists for a measured hot path (`sparkle-z5gq8`), and a second one
 *   beside it would double that cost to no purpose.
 * @param calmStatus the PRE-escalation map — **`hooks/useOverlaidStatus`'s `calmStatus`, and nothing
 *   else**. This doc used to say "`withUnmergedWork` applied, nothing else", which described one
 *   caller and not the other, and the mismatch WAS the bug: the tail of the chain over the RAW store
 *   map reads a head carrying a red worker as `idle` (quiet ⇒ `finished`), while the full chain reads
 *   it as `blocked` (not quiet ⇒ `active`). One head, two answers, decided by which caller asked.
 *   It stays a parameter because both callers already hold this map for other purposes — but a
 *   `Record<string, AgentTabStatus>` parameter CANNOT enforce where it came from, and that is the
 *   whole weakness: reverting a caller to the raw map is a one-word edit that type-checks and left
 *   the entire suite green. `hooks/finishedHeadsInputParity.test.ts` is what closes that, by reading
 *   the call sites; `useFinishedHeads.test.tsx` is what proves the two maps differ at all. If this
 *   ever takes its map from the hook directly instead, delete that parity file.
 *
 *   PRE-escalation, not escalated: `stallReport` answers `active` for the red tier, so feeding it
 *   the escalated map collapses every report to "nothing outstanding" and the escalation erases its
 *   own justification.
 * @param nudgeFlags the nudger's flag table, SUBSCRIBED by the caller (`useNudgeFlagSnapshot`). It
 *   lives in a module-level Map with no store behind it, and a flagged agent is silent by
 *   definition — so a caller that reads it imperatively never learns a flag arrived (roborev 65339,
 *   65408). It is a parameter precisely so that mistake is the caller's to make visibly.
 */
export function useFinishedHeads(
  agentsById: ReadonlyMap<string, AgentTab>,
  calmStatus: Record<string, AgentTabStatus>,
  nudgeFlags: NudgeFlagSnapshot,
): (id: string) => boolean | undefined {
  const branchStatus = useRuntimeStore((s) => s.branchStatus);
  const workflowStage = useRuntimeStore((s) => s.workflowStage);
  const workflowState = useRuntimeStore((s) => s.workflowState);
  const workflowShipped = useRuntimeStore((s) => s.workflowShipped);

  return useCallback(
    (id: string) => {
      // REACTIVITY ANCHOR, not dead code. `awaitingCloseEvidenceFor` reads the merge watermark from
      // the store rather than taking it as an argument, so nothing in this body mentions
      // `workflowShipped` and the dep would read as unnecessary — while dropping it leaves a row
      // that has just merged painting its old colour until some other input happens to change.
      void workflowShipped;
      const agent = agentsById.get(id);
      if (agent === undefined) return undefined;
      const r = stallReport(
        stallInputsFor(
          calmStatus[id] ?? "stopped",
          Date.now(),
          agent.goal,
          { bs: branchStatus[id], ws: workflowState[id], stageOverride: workflowStage[id] },
          quotaBlockForAgent(id, Date.now()),
          humanBlockIn(nudgeFlags, id),
          // Whether git says this agent's work already shipped FOR THIS GOAL. Without it this
          // surface cannot reach `awaiting_close`, so a row whose PR is merged behind a check only a
          // person may answer keeps raising the RED `blocked-on-human` cause — the exact
          // wrong-status reading this state was added to remove, on the one surface he watches.
          awaitingCloseEvidenceFor(id, agent.goal),
        ),
      );
      return r === undefined ? undefined : r.verdict === "finished";
    },
    [
      agentsById,
      calmStatus,
      branchStatus,
      workflowState,
      workflowStage,
      workflowShipped,
      nudgeFlags,
    ],
  );
}
