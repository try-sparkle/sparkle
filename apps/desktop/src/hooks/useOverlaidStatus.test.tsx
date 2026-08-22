// @vitest-environment jsdom
//
// THE ORDER OF THE OVERLAY CHAIN, PINNED.
//
// `useOverlaidStatus` declares its step order load-bearing, and it is right to: both orderings below
// have already shipped the wrong way round and been paid for. But a declaration in a header is not a
// guard, and the file this chain was extracted FROM says why nothing else can catch a reordering —
// *"`publishedRollupAgreement.test.ts` is structurally blind to this: both maps it compares come out
// of the one `composeRollup`, so it can never see this parallel copy."*
//
// So each case drives the real hook and asserts an outcome that INVERTS when the step it names is
// moved — each one below was mutation-checked that way, and one case that was WRITTEN as an ordering
// test survived its mutation and has been renamed to what it actually guards. An ordering claim a
// swap cannot falsify is not an ordering test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { useOverlaidStatus } from "./useOverlaidStatus";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useInteractionStore } from "../stores/interactionStore";
import { bandOfStatus } from "../engine/buildSections";
import type { AgentTab } from "../types";

/** A briefless agent — no goal, no bead — spawned `ageMs` ago. `isBriefless`'s subject. */
function briefless(id: string, ageMs: number, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id,
    name: id,
    kind: "build",
    parentId: null,
    worktreePath: null,
    createdAt: Date.now() - ageMs,
    ...over,
  } as unknown as AgentTab;
}

/** A worker that HAS a brief.
 *
 *  `task` is not decoration — it is route 3 of `isBriefless` ("for workers: the one-shot task its
 *  orchestrator assigned; that IS the worker's brief"). Without it `calmNewAgent` de-escalates the
 *  worker's `blocked` to `new` (gray) REGARDLESS OF AGE, so a briefless worker never reaches the
 *  red-bubble step and the ordering these cases are about goes untested — green for the wrong
 *  reason. `worktreePath` is separately what `isUnstartedWorker` requires before it will invent a
 *  strand's red. */
function worker(id: string, over: Partial<AgentTab> = {}): AgentTab {
  return briefless(id, 60 * 60_000, {
    kind: "worker",
    parentId: "head",
    task: "do the thing",
    worktreePath: "/tmp/wt",
    ...over,
  });
}

function seed(rt: Record<string, unknown>) {
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    lastObserved: {},
    observedAttention: {},
    branchStatus: {},
    workflowStage: {},
    ...rt,
  } as never);
  useInteractionStore.setState({ lastAt: {} } as never);
}

afterEach(() => cleanup());

describe("useOverlaidStatus — observed attention runs BEFORE the new-agent calm", () => {
  it("leaves a briefless, freshly-spawned `errored` agent GRAY rather than reddening it", () => {
    // THE MEASURED REGRESSION (roborev 67199), reproduced exactly. A briefless agent inside the
    // 5-minute grace window, status `errored`, with the Rust nudger's grid reading `awaiting`:
    //
    //   correct order — `applyVerdict` LEAVES `errored` alone (it is a more specific claim than
    //     "a prompt is on screen"), then `calmNewAgent`'s red backstop grays it   ⇒ `new`
    //   swapped     — `calmNewAgent` grays it to `new` FIRST, and `new` is a status `applyVerdict`
    //     DOES rewrite                                                            ⇒ `waiting` (RED)
    //
    // Which is why the swap was not theoretical: the Build column banded the row red while the dock
    // badge, the TopBar cluster and the concierge feed all called it calm.
    const agents = [briefless("a", 30_000)];
    seed({
      status: { a: "errored" },
      observedAttention: { a: { verdict: "awaiting", alternate: false, atMs: Date.now() } },
    });

    const { result } = renderHook(() => useOverlaidStatus(agents));

    expect(result.current.status["a"]).toBe("new");
    // Stated as the BAND too, because that is the thing that actually diverged across surfaces.
    expect(bandOfStatus(result.current.status["a"]!)).not.toBe("needs_you");
  });
});

describe("useOverlaidStatus — a never-started worker still reaches its orchestrator", () => {
  // ⚠️ THIS IS NOT AN ORDERING TEST, AND SAYING SO MATTERS. It was written as one — "the unstarted
  // bubble must run before the red bubble" — and a mutation check disproved that: swapping the two
  // steps leaves every assertion here GREEN, because `withUnstartedWorkerAttention` paints the
  // PARENT itself rather than relying on the red bubbler to carry the strand's synthetic red. The
  // ordering between those two may still matter somewhere, but it is not observable through this
  // composition, and a test whose name claims a guarantee it does not hold is worse than no test:
  // the next person reorders the steps, sees green, and believes it was checked.
  //
  // What it DOES guard, which is worth guarding: the strand reaches the row a human can act on.
  it("bubbles a never-started worker's SYNTHETIC red up to its orchestrator", () => {
    // A worktree was cut and the worker never went live, so it has NO status entry at all and
    // nothing downstream would ever call it red — this red is invented, and without it a build whose
    // worker never started shows nothing anywhere.
    const agents = [briefless("head", 60 * 60_000), worker("strand", { task: undefined })];
    // No status entry for `strand`, never observed. `head` is OPEN because `isUnstartedWorker`
    // requires it — the strand rule only fires where the parent's pane is live enough to have
    // started it.
    seed({ status: { head: "idle" }, openAgentIds: ["head"] });

    const { result } = renderHook(() => useOverlaidStatus(agents));

    expect(bandOfStatus(result.current.status["head"]!)).toBe("needs_you");
  });

  it("leaves the head calm when the worker DID start and is calm — so the case above is not a constant", () => {
    // The same fixture with the worker present and quiet. Without this, "head is red" would pass
    // against an overlay that reddens every orchestrator it sees.
    const agents = [briefless("head", 60 * 60_000), worker("w")];
    seed({ status: { head: "idle", w: "idle" }, openAgentIds: ["head"] });

    const { result } = renderHook(() => useOverlaidStatus(agents));

    expect(bandOfStatus(result.current.status["head"]!)).not.toBe("needs_you");
  });
});

describe("useOverlaidStatus — calmStatus is the overlaid map, not the raw one", () => {
  it("carries the worker's bubbled red into `calmStatus`, which is what the stall question reads", () => {
    // THE WHOLE REASON THIS HOOK EXISTS. `stallReport` gates its arms behind `isQuiet(status)`, so a
    // head reading raw `idle` is judged FINISHED while the same head reading the bubbled `blocked`
    // is judged ACTIVE. Two columns deriving this map differently answered differently about the
    // same head — and `calmStatus` is the parameter both of them hand to `useFinishedHeads`.
    const agents = [briefless("head", 60 * 60_000), worker("w")];
    seed({ status: { head: "idle", w: "blocked" } });

    const { result } = renderHook(() => useOverlaidStatus(agents));

    // NOT `idle` — the raw store value, and the answer the Epics column used to get.
    expect(result.current.calmStatus["head"]).not.toBe("idle");
    expect(bandOfStatus(result.current.calmStatus["head"]!)).toBe("needs_you");
  });
});
