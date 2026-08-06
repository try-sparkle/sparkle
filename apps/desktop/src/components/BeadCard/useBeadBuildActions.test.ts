// @vitest-environment jsdom
//
// The build handoffs, tested directly.
//
// These three orderings were each a shipped bug once, and until now every one of them was pinned
// only INDIRECTLY, through BoardView.test.tsx rendering a whole board. That is a thin thread: the
// logic moved out of BoardView into this hook precisely so the concierge could share it, and a
// board-level test would not notice the concierge inheriting a broken ordering.
//
//   * the preflight runs BEFORE `claimBead`, so a refusal at capacity leaves the bead unclaimed
//     (a claimed bead with no orchestrator is in_progress forever) — roborev 55139;
//   * the preflight runs INSIDE the batch loop, so a ceiling reached partway leaves the remaining
//     epics untouched rather than throwing out of the middle;
//   * `buildTask` passes mode "task", so the refusal does not call a single-bead build a plan —
//     roborev 55145.
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendToBuild = vi.fn();
const blockedReason = vi.fn<(p: string, e: string, m?: string) => string | null>(() => null);
vi.mock("../../services/sendToBuild", () => ({
  sendToBuild: (...a: unknown[]) => sendToBuild(...a),
  // Forwards ALL args so a test can assert the MODE. A factory that dropped them is how a call
  // site that never passed "task" went unnoticed (roborev 55145).
  sendToBuildBlockedReason: (...a: [string, string, string?]) => blockedReason(...a),
}));

const claimBead = vi.fn().mockResolvedValue(undefined);
vi.mock("../../services/beads", async (orig) => ({
  ...(await orig<typeof import("../../services/beads")>()),
  claimBead: (...a: unknown[]) => claimBead(...a),
}));

import { useBeadBuildActions } from "./useBeadBuildActions";
import { useProjectStore } from "../../stores/projectStore";
import type { Bead } from "../../services/beads";

const PRD = "PRD file: PRD/2026-06-27-build-the-app.md";

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: "t",
    description: "",
    status: "open",
    labels: [],
    parent: null,
    ...over,
  };
}

const epic1 = bead({ id: "e1", type: "epic", description: PRD });
const epic2 = bead({ id: "e2", type: "epic", description: PRD });
const task1 = bead({ id: "t1", type: "task", description: PRD });

beforeEach(() => {
  sendToBuild.mockClear();
  claimBead.mockClear();
  blockedReason.mockReset();
  blockedReason.mockReturnValue(null);
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "Demo",
        rootPath: "/tmp/demo",
        defaultBranch: "main",
        createdAt: "2026-01-01",
        agents: [],
        selectedAgentId: null,
      },
    ],
    selectedProjectId: "p1",
  });
});

afterEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
});

function hook(b: Bead, all: Bead[] = [epic1, epic2, task1]) {
  return renderHook(() => useBeadBuildActions({ bead: b, projectId: "p1", allBeads: all }));
}

describe("useBeadBuildActions — which action a bead deserves", () => {
  it("gives an epic buildEpic and a task buildTask", async () => {
    const e = hook(epic1);
    await act(async () => {
      await e.result.current.buildIt?.();
    });
    expect(sendToBuild).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: "e1", mode: "epic" }),
    );

    sendToBuild.mockClear();
    const t = hook(task1);
    await act(async () => {
      await t.result.current.buildIt?.();
    });
    // MODE "task" — without it the preflight's "epic" default makes a one-bead build announce
    // itself as a plan (roborev 55145).
    expect(sendToBuild).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: "t1", mode: "task" }),
    );
  });

  it("gives a bead that is neither NO build action at all", () => {
    const { result } = hook(bead({ id: "b1", type: "bug", description: PRD }));
    expect(result.current.buildIt).toBeNull();
  });

  // The gate that belongs here rather than at each call site: a non-epic carrying a PRD back-link
  // resolves a non-empty prdEpics, and both surfaces independently shipped a length-only check that
  // offered "Build all N epics in this PRD" from a card for a bead that is not one of them.
  it("offers the batch ONLY for an epic with siblings in its PRD", () => {
    expect(hook(epic1).result.current.buildAllPrd).not.toBeNull();
    // Same PRD, same non-empty prdEpics — but a task.
    expect(hook(task1).result.current.prdEpics.length).toBeGreaterThan(1);
    expect(hook(task1).result.current.buildAllPrd).toBeNull();
    // An epic alone in its PRD is not a batch either.
    const lone = bead({ id: "e9", type: "epic", description: "PRD file: PRD/other.md" });
    expect(hook(lone, [lone]).result.current.buildAllPrd).toBeNull();
  });
});

describe("useBeadBuildActions — the preflight runs BEFORE the claim", () => {
  // A claimed bead with no orchestrator sits in_progress forever with nothing building it, so the
  // refusal has to happen while nothing has been written yet (roborev 55139).
  it("does not claim the bead when the preflight refuses", async () => {
    blockedReason.mockReturnValue("At capacity.");
    const { result } = hook(epic1);
    await act(async () => {
      // It REJECTS with the refusal rather than swallowing it — that is the change of shape from
      // the old DetailOverlay, which set a local error string. The card's `runBuild` catches this
      // and renders the sentence beside the button, so the reason still reaches the reader.
      await expect(result.current.buildIt?.()).rejects.toThrow("At capacity.");
    });
    // THE ASSERTION THAT MATTERS, and the reason the ordering is what it is: nothing was written.
    expect(claimBead).not.toHaveBeenCalled();
    expect(sendToBuild).not.toHaveBeenCalled();
  });

  it("claims and hands off when it does not", async () => {
    const { result } = hook(epic1);
    await act(async () => {
      await result.current.buildIt?.();
    });
    expect(claimBead).toHaveBeenCalledWith("/tmp/demo", "e1");
    expect(sendToBuild).toHaveBeenCalledTimes(1);
  });
});

describe("useBeadBuildActions — the batch checks the ceiling on every iteration", () => {
  // The ceiling can be reached PARTWAY through a batch. Checking once up front would claim epics it
  // then could not hand off; throwing out of the middle would leave the caller unable to say how far
  // it got. It stops cleanly and reports.
  it("stops at the ceiling and leaves the remaining epics unclaimed", async () => {
    // First epic passes, second is refused.
    blockedReason.mockReturnValueOnce(null).mockReturnValueOnce("At capacity.");
    const { result } = hook(epic1);

    await act(async () => {
      await expect(result.current.buildAllPrd?.()).rejects.toThrow(/Started 1 of 2/);
    });

    // Exactly one handoff, and the refused epic was never claimed.
    expect(sendToBuild).toHaveBeenCalledTimes(1);
    expect(claimBead).toHaveBeenCalledTimes(1);
    expect(claimBead).toHaveBeenCalledWith("/tmp/demo", "e1");
    expect(claimBead).not.toHaveBeenCalledWith("/tmp/demo", "e2");
  });

  it("hands off every epic when none is refused", async () => {
    const { result } = hook(epic1);
    await act(async () => {
      await result.current.buildAllPrd?.();
    });
    expect(sendToBuild).toHaveBeenCalledTimes(2);
    expect(claimBead).toHaveBeenCalledTimes(2);
  });
});
