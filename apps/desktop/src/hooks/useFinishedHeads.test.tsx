// @vitest-environment jsdom
//
// WHICH MAP YOU FEED `useFinishedHeads` CHANGES ITS ANSWER — and that is the whole bug.
//
// Lifting the finished-head verdict into a shared hook was only half a fix. Its most consequential
// input stayed a plain parameter, and the two callers derived it differently: `AgentSidebar` from
// its OVERLAID map (observed attention, new-agent calm, the two worker-attention bubbles), the Epics
// column from the RAW store map. `stallReport` gates every arm behind `isQuiet(status)` — `idle` or
// `unmerged`, nothing else — so a head carrying a red worker reads `blocked` in one map (NOT quiet
// ⇒ verdict `active` ⇒ not finished) and `idle` in the other (quiet ⇒ `finished`). One head, two
// answers, decided entirely by which caller asked.
//
// ══ WHY THIS FILE, AND WHERE THE REST OF THE GUARD LIVES ═══════════════════════════════════════
// This file witnesses the DIVERGENCE. `hooks/finishedHeadsInputParity.test.ts` witnesses that every
// production caller passes the right side of it. Two files because no single one can do both, and
// the reason is mechanical rather than a matter of effort:
//
//   `rollupDot` paints a row from its WORKERS' published statuses plus the head's own bubble-free
//   tier. A head's verdict only demotes the HEAD's published status, which is in neither. And the
//   two maps never disagree about a WORKER: a red worker is `blocked` in both (the overlays repaint
//   parents, not the worker itself), and `blocked` is not quiet, so both answer `active`. A
//   never-started strand is `approval` in one and absent from the other — where this hook falls back
//   to `stopped` — and neither of those is quiet either.
//
// Four fixtures were written to catch it through the rendered column, including one a review
// specified verbatim (head `idle` + `blocked` worker, `CLEAN_BS` on the head's branch status,
// `MERGED_WS` on its workflow state). Each was run against BOTH call sites. Every one printed `red`
// either way — so every one would have been GREEN while proving nothing, which is the #1 fleet-wide
// finding AGENTS.md names.
//
// ⚠️ `EpicsColumn.finishedCalm.test.tsx` DOES move the square on that fixture, and that looks like a
// counter-example until you look at the mock: it answers for EVERY id, so its WORKER is called
// finished too, and that is what demotes the red. The real hook never calls a `blocked` worker
// finished. A mock that can answer more ids than the real thing is the whole difference — which is
// exactly why that test cannot stand in for the parity guard.
//
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { useFinishedHeads } from "./useFinishedHeads";
import { useOverlaidStatus } from "./useOverlaidStatus";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useInteractionStore } from "../stores/interactionStore";
import type { AgentTab } from "../types";

/** Fully polled and genuinely done: clean tree, nothing ahead, PR merged. Without ALL THREE facts
 *  resolved `stallReport` answers `unknown` rather than `finished` — "not checked" is not "nothing
 *  to do" — and both maps would reach `unknown`, making every assertion below vacuous. */
const CLEAN_BS = { ahead: 0, behind: 0, dirty: false, filesChanged: 0, insertions: 0, deletions: 0 };
const MERGED_WS = {
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 0,
  prState: "merged",
  prNumber: null,
  prUrl: null,
};

const HEAD = {
  id: "h",
  name: "h",
  kind: "build",
  parentId: null,
  worktreePath: null,
  createdAt: Date.now() - 60 * 60_000,
} as unknown as AgentTab;

/** A worker that HAS a brief — `task` is route 3 of `isBriefless`. Without it `calmNewAgent`
 *  de-escalates its `blocked` to `new` (gray) at any age, so nothing would bubble and the head's two
 *  readings would coincide. */
const WORKER = {
  id: "w",
  name: "w",
  kind: "worker",
  parentId: "h",
  task: "do the thing",
  worktreePath: "/tmp/wt",
  createdAt: Date.now() - 60 * 60_000,
} as unknown as AgentTab;

const AGENTS = [HEAD, WORKER];

afterEach(() => cleanup());

function seed() {
  useRuntimeStore.setState({
    // The head is quiet and done; the worker under it went red.
    status: { h: "idle", w: "blocked" },
    openAgentIds: [],
    lastObserved: {},
    observedAttention: {},
    branchStatus: { h: CLEAN_BS },
    workflowStage: {},
    workflowState: { h: MERGED_WS },
  } as never);
  useInteractionStore.setState({ lastAt: {} } as never);
}

const index = new Map(AGENTS.map((a) => [a.id, a]));

describe("useFinishedHeads — the verdict follows the map it is given", () => {
  it("answers FINISHED off the raw store map and NOT FINISHED off the overlaid one", () => {
    seed();

    // What the Epics column used to build: `withUnmergedWork` over the RAW map. The head reads
    // `idle`, which IS quiet, and every git fact is resolved and negative ⇒ finished.
    const raw = renderHook(() =>
      useFinishedHeads(index, useRuntimeStore.getState().status, new Map()),
    );
    expect(raw.result.current("h")).toBe(true);

    // What both columns build now. `withRedWorkerAttention` has bubbled the worker's red onto the
    // head, so it reads `blocked` — NOT quiet ⇒ `active` ⇒ not finished.
    const overlaid = renderHook(() => {
      const { calmStatus } = useOverlaidStatus(AGENTS);
      return useFinishedHeads(index, calmStatus, new Map());
    });
    expect(overlaid.result.current("h")).toBe(false);

    // Stated as the difference itself, because THAT is the defect: one head, one store, two answers
    // decided by which caller asked.
    expect(raw.result.current("h")).not.toBe(overlaid.result.current("h"));
  });

  it("answers `false`, not `finished`, when the git state was never read", () => {
    // "No evidence of work" and "evidence of no work" are different claims, and only the second
    // licenses calling an agent done. With nothing polled `stallReport` returns the `unknown`
    // verdict — *"this is 'not checked', not 'nothing to do'. Do not report it as finished."*
    //
    // ⚠️ THE RETURN IS `false` HERE, NOT `undefined`, and the difference is worth pinning because
    // this hook's own doc-comment used to claim otherwise (an inaccuracy inherited verbatim from
    // the call site it was lifted out of). `undefined` is reserved for "no agent record", the case
    // below. Both are SAFE at the only consumer — `isFinishedHeadCalmed` demands `=== true` before
    // it demotes anything — but a future caller that reads `!== false` as "we did not look" would
    // be wrong about this arm, so it is stated rather than assumed.
    useRuntimeStore.setState({
      status: { h: "idle" },
      openAgentIds: [],
      lastObserved: {},
      observedAttention: {},
      branchStatus: {}, // nothing polled
      workflowStage: {},
      workflowState: {},
    } as never);
    useInteractionStore.setState({ lastAt: {} } as never);

    const { result } = renderHook(() => useFinishedHeads(index, { h: "idle" }, new Map()));
    expect(result.current("h")).toBe(false);
  });

  it("returns `undefined` for an id it has no agent record for", () => {
    seed();
    const { result } = renderHook(() => useFinishedHeads(index, { ghost: "idle" }, new Map()));
    expect(result.current("ghost")).toBeUndefined();
  });
});
