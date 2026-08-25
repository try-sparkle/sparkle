// orphanedSubagentRegistry — the note-gating logic that keeps a stale `0` from ever reading as a
// truthy "had orphans" entry, and the spawn-edge forget. Bead sparkle-y5dk8x.
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  _resetOrphanedSubagentRegistryForTests,
  forgetOrphanedSubagents,
  noteOrphanedSubagents,
  orphanedSubagentsForAgent,
} from "./orphanedSubagentRegistry";

beforeEach(() => _resetOrphanedSubagentRegistryForTests());
afterEach(() => _resetOrphanedSubagentRegistryForTests());

describe("orphanedSubagentRegistry", () => {
  it("records a positive count and reads it back", () => {
    noteOrphanedSubagents("a1", 3);
    expect(orphanedSubagentsForAgent("a1")).toBe(3);
  });

  it("treats 0 and undefined as an ABSENCE — never a zero-valued entry", () => {
    // Seed a real value, then overwrite with a non-positive count: it must DELETE, not store 0.
    noteOrphanedSubagents("a1", 4);
    noteOrphanedSubagents("a1", 0);
    expect(orphanedSubagentsForAgent("a1")).toBeUndefined();

    noteOrphanedSubagents("a2", 4);
    noteOrphanedSubagents("a2", undefined);
    expect(orphanedSubagentsForAgent("a2")).toBeUndefined();
  });

  it("forgets on the spawn edge", () => {
    noteOrphanedSubagents("a1", 2);
    forgetOrphanedSubagents("a1");
    expect(orphanedSubagentsForAgent("a1")).toBeUndefined();
  });

  it("returns undefined for an agent it never saw", () => {
    expect(orphanedSubagentsForAgent("ghost")).toBeUndefined();
  });
});
