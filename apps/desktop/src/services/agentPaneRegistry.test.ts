// Unit tests for the mounted-pane registry (bead `sparkle-bxidpw`, roborev 67480).
//
// WHY THIS FILE EXISTS SEPARATELY FROM `AgentPane.closeTrace.test.tsx`. That file drives the real
// component and proves the registry is wired up — a pane that mounts registers, a pane that
// unmounts releases. What it cannot reach is the REFCOUNT, because a single `render`/`unmount` pair
// only ever exercises the 1 → 0 transition. The `n > 0` branch of `unregisterMountedPane` exists for
// React StrictMode's double-invoked effects (mount → cleanup → mount) and for a portal-target change
// that remounts a pane, and until this file nothing exercised it at all: delete the branch entirely,
// leaving `mountedPanes.delete(agentId)` unconditional, and the whole suite stayed green while an
// overlapping remount would drop a still-live pane out of the registry on the FIRST cleanup of the
// pair. That is not a cosmetic loss — a dropped id makes `removeAgent` decline to open the `close:`
// waterfall for a pane that is genuinely there, so the measurement this whole mechanism exists to
// take silently stops being taken.
//
// These assert the OBSERVABLE side effect (`isAgentPaneMounted`), never the map, because the map is
// private and asserting on it would pin the implementation rather than the contract.

import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetMountedPanesForTest,
  isAgentPaneMounted,
  registerMountedPane,
  unregisterMountedPane,
} from "./agentPaneRegistry";

const ID = "agent-1";
const OTHER = "agent-2";

describe("agentPaneRegistry", () => {
  beforeEach(() => {
    __resetMountedPanesForTest();
  });

  it("reads false for an id that never registered", () => {
    expect(isAgentPaneMounted(ID)).toBe(false);
  });

  it("registers and releases a single pane", () => {
    registerMountedPane(ID);
    expect(isAgentPaneMounted(ID)).toBe(true);
    unregisterMountedPane(ID);
    expect(isAgentPaneMounted(ID)).toBe(false);
  });

  // THE `n > 0` BRANCH — the one a boolean Set could not express and nothing else exercises.
  //
  // The overlap is the point: StrictMode runs mount → cleanup → mount, and a portal move remounts
  // without an intervening idle state, so the second `register` lands BEFORE the first `unregister`.
  // With a Set (or an unconditional delete) that first cleanup drops the id while a live pane still
  // holds it, and `removeAgent` then skips the waterfall for a pane that is right there on screen.
  it("stays mounted through an overlapping remount and releases only on the last cleanup", () => {
    registerMountedPane(ID);
    registerMountedPane(ID); // the remount, before the first cleanup has run
    expect(isAgentPaneMounted(ID)).toBe(true);

    unregisterMountedPane(ID); // the FIRST pane's cleanup — a live pane remains
    expect(isAgentPaneMounted(ID)).toBe(true);

    unregisterMountedPane(ID); // the last one goes
    expect(isAgentPaneMounted(ID)).toBe(false);
  });

  // The floor, asserted rather than assumed. The doc comment promises an unmatched unregister is a
  // safe no-op; without the floor the count goes negative and the NEXT register leaves it at 0 or
  // below, so a genuinely mounted pane reads as absent — a leak in the opposite direction, and the
  // harder one to notice because nothing is left behind to see.
  it("floors an unmatched unregister at absent rather than going negative", () => {
    unregisterMountedPane(ID);
    expect(isAgentPaneMounted(ID)).toBe(false);

    registerMountedPane(ID);
    expect(isAgentPaneMounted(ID)).toBe(true);
    unregisterMountedPane(ID);
    expect(isAgentPaneMounted(ID)).toBe(false);
  });

  it("keys per agent id — releasing one does not release another", () => {
    registerMountedPane(ID);
    registerMountedPane(OTHER);
    unregisterMountedPane(ID);
    expect(isAgentPaneMounted(ID)).toBe(false);
    expect(isAgentPaneMounted(OTHER)).toBe(true);
  });

  it("__resetMountedPanesForTest clears every id, not just the last one", () => {
    registerMountedPane(ID);
    registerMountedPane(ID);
    registerMountedPane(OTHER);
    __resetMountedPanesForTest();
    expect(isAgentPaneMounted(ID)).toBe(false);
    expect(isAgentPaneMounted(OTHER)).toBe(false);
  });
});
