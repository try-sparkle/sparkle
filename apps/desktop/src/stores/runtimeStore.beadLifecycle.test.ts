import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the bd shell-out wrappers so we exercise syncBeadLifecycle's STATEFUL behavior (watermark
// advance-on-success retry, the create back-off latch, the shipped-seed no-reopen) without bd. Keep
// the real pure helper isBeadsUnavailable — the no-beads-DB latch depends on it.
vi.mock("../services/beads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/beads")>()),
  createBead: vi.fn(),
  claimBead: vi.fn(),
  closeBead: vi.fn(),
  markBeadDelivered: vi.fn(),
}));

import { syncBeadLifecycle, __resetBeadLifecycleForTest, useRuntimeStore } from "./runtimeStore";
import * as beads from "../services/beads";
import type { BranchStatus } from "../services/branchStatus";

const bs = (ahead: number, dirty = false): BranchStatus => ({
  ahead,
  behind: 0,
  dirty,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetBeadLifecycleForTest();
});

describe("syncBeadLifecycle — wrapper state", () => {
  it("does not advance the watermark when a write throws, so the edge retries next tick", async () => {
    vi.mocked(beads.claimBead).mockRejectedValueOnce(new Error("bd offline")).mockResolvedValue();
    const agent = { id: "a1", kind: "build", beadId: "bd-1", name: "X" };
    await syncBeadLifecycle("p", "/root", agent, "building_saved", bs(1), false);
    expect(beads.claimBead).toHaveBeenCalledTimes(1); // attempted in_progress (claim), threw
    await syncBeadLifecycle("p", "/root", agent, "building_saved", bs(1), false);
    expect(beads.claimBead).toHaveBeenCalledTimes(2); // retried (watermark wasn't advanced)
    // Third tick: now it succeeded, so the watermark advanced and there's nothing more to write.
    await syncBeadLifecycle("p", "/root", agent, "building_saved", bs(1), false);
    expect(beads.claimBead).toHaveBeenCalledTimes(2);
  });

  it("backs off after create returns null (no orphan beads spawned every poll)", async () => {
    vi.mocked(beads.createBead).mockResolvedValue(null);
    const agent = { id: "a2", kind: "build", name: "X" }; // no beadId → auto-create path
    await syncBeadLifecycle("p", "/root", agent, "building_saved", bs(1), false);
    expect(beads.createBead).toHaveBeenCalledTimes(1);
    await syncBeadLifecycle("p", "/root", agent, "building_saved", bs(1), false);
    expect(beads.createBead).toHaveBeenCalledTimes(1); // latched — not retried
  });

  it("latches a project with no beads DB so it stops shelling out to bd every poll", async () => {
    // A project that never ran `bd init` rejects every write with "no beads database found".
    vi.mocked(beads.claimBead).mockRejectedValue(new Error("no beads database found"));
    const a = { id: "a-nodb-1", kind: "build", beadId: "bd-x", name: "X" };
    const b = { id: "a-nodb-2", kind: "build", beadId: "bd-y", name: "Y" };
    await syncBeadLifecycle("noDbProj", "/root", a, "building_saved", bs(1), false);
    expect(beads.claimBead).toHaveBeenCalledTimes(1); // first write attempted, threw → project latched
    // Same project, next poll and a different agent: both short-circuit before any bd shell-out.
    await syncBeadLifecycle("noDbProj", "/root", a, "building_saved", bs(1), false);
    await syncBeadLifecycle("noDbProj", "/root", b, "building_saved", bs(1), false);
    expect(beads.claimBead).toHaveBeenCalledTimes(1); // no further bd calls for this project
    // A DIFFERENT project is unaffected by the latch (it still attempts its own writes).
    await syncBeadLifecycle("otherProj", "/root", a, "building_saved", bs(1), false);
    expect(beads.claimBead).toHaveBeenCalledTimes(2);
  });

  it("does NOT latch on a genuine (non-no-DB) failure — those keep retrying", async () => {
    vi.mocked(beads.claimBead).mockRejectedValue(new Error("bd offline"));
    const a = { id: "a-genuine", kind: "build", beadId: "bd-z", name: "Z" };
    await syncBeadLifecycle("liveProj", "/root", a, "building_saved", bs(1), false);
    await syncBeadLifecycle("liveProj", "/root", a, "building_saved", bs(1), false);
    expect(beads.claimBead).toHaveBeenCalledTimes(2); // not latched — retried next poll
  });

  it("does not reopen a shipped bead on relaunch (watermark seeded from the shipped ✓)", async () => {
    const agent = { id: "a3", kind: "build", beadId: "bd-3", name: "X" };
    // Fresh boot: in-memory watermark is 0, the stage re-climbed to building, but shippedLatched=true.
    await syncBeadLifecycle("p", "/root", agent, "building_saved", bs(1), true);
    expect(beads.claimBead).not.toHaveBeenCalled(); // no in_progress (claim) write onto a shipped bead
  });

  it("reconcile sweeps a create-null agent's beadCreateFailed latch (no leak)", async () => {
    vi.mocked(beads.createBead).mockResolvedValue(null);
    const agent = { id: "gone", kind: "build", name: "X" }; // no beadId → auto-create path
    await syncBeadLifecycle("p", "/root", agent, "building_saved", bs(1), false);
    await syncBeadLifecycle("p", "/root", agent, "building_saved", bs(1), false);
    expect(beads.createBead).toHaveBeenCalledTimes(1); // latched after the null result — no retry
    // reconcile() with "gone" excluded must forget the latch (it's a beadCreateFailed-only entry,
    // never in beadLevelFor — the union-sweep is what catches it).
    useRuntimeStore.getState().reconcile([]);
    await syncBeadLifecycle("p", "/root", agent, "building_saved", bs(1), false);
    expect(beads.createBead).toHaveBeenCalledTimes(2); // latch cleared → create retried
  });
});
