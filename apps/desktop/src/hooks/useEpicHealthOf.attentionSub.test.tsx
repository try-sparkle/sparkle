// @vitest-environment jsdom
//
// THE EPIC SQUARE MUST REPAINT WHEN THE MOUNT-INDEPENDENT ATTENTION VERDICT ARRIVES (bead
// sparkle-obvtfx).
//
// `engine/observedAttention.applyVerdict`'s `delegating` arm is the ONLY mount-independent GREEN
// input in the app: it exists precisely for rows where `runtimeStore.status` has no entry because
// no pane ever mounted. On that population status BY DEFINITION never moves — so if this hook's
// chain does not SUBSCRIBE to `runtimeStore.observedAttention`, nothing in its memo's deps can
// change when the verdict lands, and the square holds its gray until some unrelated render happens
// to recompute it. The value was never wrong; it was simply not reactive to the one signal meant to
// drive it, which is invisible to every existing test because they all assert the VALUE after a
// fresh render rather than the TRANSITION across a store write.
//
// `hooks/useOverlaidStatus.ts` already subscribes to exactly that field. Both files' headers say
// the two chains must not diverge, so this is a parity fix, and the assertion below is written as
// the transition — render gray, write the verdict, expect green — because that is the only shape a
// lost subscription can fail.
//
// ══ WHAT THIS FILE ACTUALLY FOUND, WHICH IS NOT WHAT THE BEAD PREDICTED ════════════════════════
// sparkle-obvtfx reads as a live defect ("the square cannot repaint") and recommends adding
// `observedAttention` to `useRollupView`'s `useShallow` slice. WRITTEN FIRST AND RUN, this test
// PASSED against unmodified `origin/main` — so the defect does not reproduce and that fix would be
// a no-op with a re-render cost the bead itself says to measure first.
//
// The reactivity is real but TRANSITIVE: `useRollupView` calls `useOverlaidStatus`, which
// subscribes to the field itself, and its `calmStatus` reaches `isFinishedOf` — a genuine memo dep.
// Proven by mutating that one line to `useRuntimeStore.getState().observedAttention`, which reds
// the first case here (`expected 'gray' to be 'green'`) and leaves the paired negative green. So
// what was missing was never the subscription; it was anything at all that would notice its loss —
// the bead's own words, "no parity test looks at subscriptions". This file is that guard.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

import { useEpicHealthOf } from "./useEpicHealthOf";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useInteractionStore } from "../stores/interactionStore";
import type { AgentTab } from "../types";
import type { Bead } from "../services/beads";

const EPIC_ID = "e1";

/** The epic and the one child slice its orchestrator is carrying. */
const BEADS = [
  { id: EPIC_ID, title: "an epic", issue_type: "epic", status: "open" },
  { id: "e1.1", title: "a slice", issue_type: "task", status: "open", parent: EPIC_ID },
] as unknown as Bead[];

/**
 * An orchestrator bound to the epic's child slice whose PANE NEVER MOUNTED.
 *
 * Both halves matter and neither is decoration: `beadId` is what puts it in
 * `epicLadder.agentsForEpicSlices`' answer for this epic (without it the readings list is empty and
 * `epicHealth` returns "gray" BY DEFINITION, so the test would pass on a broken hook), and its
 * absence from `openAgentIds` plus its absence from `status` is the exact population the
 * `delegating` arm exists for — an entry in either one would give the memo a dep that moves on its
 * own and the missing subscription would be masked.
 */
const ORCH = {
  id: "orch",
  name: "orch",
  kind: "build",
  parentId: null,
  beadId: "e1.1",
  worktreePath: "/tmp/wt",
  createdAt: Date.now() - 60 * 60_000,
} as unknown as AgentTab;

function seed(rt: Record<string, unknown> = {}) {
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    lastObserved: {},
    observedAttention: {},
    branchStatus: {},
    workflowStage: {},
  } as never);
  useRuntimeStore.setState(rt as never);
  useInteractionStore.setState({ lastAt: {} } as never);
}

afterEach(() => cleanup());

describe("useEpicHealthOf — reactivity to runtimeStore.observedAttention", () => {
  it("repaints the epic from gray to green when a `delegating` verdict lands for an unmounted agent", () => {
    seed();
    const roster = [ORCH];

    const { result } = renderHook(() => useEpicHealthOf(roster, BEADS));
    // The precondition, asserted rather than assumed: with no verdict the unmounted orchestrator
    // contributes a gray dot, so the square is gray. If this were anything else the transition
    // below would prove nothing.
    expect(
      result.current(EPIC_ID),
      "PRECONDITION: an unmounted, verdict-less orchestrator must contribute a gray dot",
    ).toBe("gray");

    act(() => {
      useRuntimeStore.setState({
        observedAttention: {
          orch: { verdict: "delegating", alternate: false, atMs: Date.now() },
        },
      } as never);
    });

    // THE SIDE EFFECT, not the precondition: the hook re-ran because it is subscribed, and the
    // promoted `working` status reached `epicHealth` through the shared rollup.
    expect(
      result.current(EPIC_ID),
      "useEpicHealthOf must repaint when runtimeStore.observedAttention moves — the subscription " +
        "lives in useOverlaidStatus (see this file's header and useEpicHealthOf.ts)",
    ).toBe("green");
  });

  it("still reports gray for the same agent when NO verdict has landed", () => {
    // THE PAIRED NEGATIVE. Without it the case above passes for a hook that reports green
    // unconditionally, which is the failure mode a reactivity fix is most likely to introduce.
    seed();
    const roster = [ORCH];

    const { result } = renderHook(() => useEpicHealthOf(roster, BEADS));
    act(() => {
      useRuntimeStore.setState({ observedAttention: {} } as never);
    });

    expect(
      result.current(EPIC_ID),
      "a verdict-less agent must stay gray — the positive case must not be passing by reporting " +
        "green unconditionally",
    ).toBe("gray");
  });
});
