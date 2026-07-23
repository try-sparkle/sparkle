// A worker must never claim a cross-WINDOW row.
//
// `orderedTopLevelAgents` already keeps workers out of their OWN window's sidebar list and TopBar
// dots. The cross-window attention block at the top of every sidebar is a SECOND, independent list:
// each window publishes its red agents (windowStatus) and every other window renders them as
// project-tagged rows. That publisher looped over every agent, so a red WORKER in window A surfaced
// as its own top-level row in windows B/C/D — the exact "worker agent windows" leak the sidebar fix
// was meant to end, just arriving from a different direction.
//
// The contract these tests pin: workers are filtered out of the published list, and their red is not
// LOST — it bubbles to the orchestrator (withRedWorkerAttention) before the filter runs, so the
// parent is what other windows see.
import { describe, it, expect } from "vitest";
import { crossWindowRedAgents, publishedStatusFor } from "./useAttentionNotifications";
import { withRedWorkerAttention } from "./engine/workerAttention";
import type { resolveStage } from "./engine/workflowStage";
import type { AgentTab, AgentKind } from "./types";
import type { StatusMap } from "./engine/attention";

type Row = { id: string; kind: AgentKind; parentId: string | null };

const ag = (id: string, kind: AgentKind, parentId: string | null = null): Row => ({
  id,
  kind,
  parentId,
});

describe("crossWindowRedAgents — workers never claim a cross-window row", () => {
  it("publishes a red build orchestrator", () => {
    const agents = [ag("b1", "build")];
    const status: StatusMap = { b1: "waiting" };
    expect(crossWindowRedAgents(agents, status).map((a) => a.id)).toEqual(["b1"]);
  });

  it("drops a red worker nested under a live orchestrator", () => {
    const agents = [ag("b1", "build"), ag("w1", "worker", "b1")];
    // Only the worker is red on its own; the parent has not been bubbled yet.
    const status: StatusMap = { b1: "idle", w1: "waiting" };
    expect(crossWindowRedAgents(agents, status)).toEqual([]);
  });

  it("drops a red worker ORPHANED by a missing parent, too", () => {
    // The orphan is the case that leaked hardest: no parent row exists to nest it under, so the old
    // publisher happily broadcast it as a standalone project-tagged row in every other window.
    const agents = [ag("w2", "worker", "gone")];
    const status: StatusMap = { w2: "errored" };
    expect(crossWindowRedAgents(agents, status)).toEqual([]);
  });

  it("keeps a red SHELL agent — only workers are excluded", () => {
    const agents = [ag("s1", "shell")];
    const status: StatusMap = { s1: "errored" };
    expect(crossWindowRedAgents(agents, status).map((a) => a.id)).toEqual(["s1"]);
  });

  it("bubbles a red worker to its orchestrator instead of dropping the signal", () => {
    const agents = [ag("b1", "build"), ag("w1", "worker", "b1")] as unknown as AgentTab[];
    const live: StatusMap = { b1: "idle", w1: "approval" };
    // The publisher runs withRedWorkerAttention FIRST (matching AgentSidebar's effectiveStatus), so
    // the orchestrator carries the worker's red and is the row other windows see.
    const bubbled = withRedWorkerAttention(agents, live);
    const published = crossWindowRedAgents(agents, bubbled);
    expect(published.map((a) => a.id)).toEqual(["b1"]);
    expect(bubbled["b1"]).toBe("approval");
  });

  it("an ORPHANED red worker has no parent to bubble to — it goes silent, not loud", () => {
    // Documented consequence: a worker whose orchestrator is gone can't paint anyone red. That is
    // the accepted trade (same call the sidebar fix made) — a stranded orphan is a teardown edge
    // case, and a stray row in every other window is worse than no row.
    const agents = [ag("w2", "worker", "gone")] as unknown as AgentTab[];
    const bubbled = withRedWorkerAttention(agents, { w2: "waiting" });
    expect(crossWindowRedAgents(agents, bubbled)).toEqual([]);
  });

  it("ignores non-red statuses entirely", () => {
    const agents = [ag("b1", "build"), ag("b2", "build")];
    expect(crossWindowRedAgents(agents, { b1: "working", b2: "idle" })).toEqual([]);
  });
});

// The overlays that keep a filtered-out worker's red from vanishing. These run against the REAL
// publisher chain (publishedStatusFor), not the individual engine helpers, so a future edit that
// drops or reorders an overlay in the publish path fails here rather than silently going quiet.
describe("publishedStatusFor — a filtered worker's red still reaches another window", () => {
  const NO_STAGE = () => "start" as ReturnType<typeof resolveStage>;
  const tab = (id: string, kind: AgentKind, parentId: string | null, worktreePath: string | null) =>
    ({ id, kind, parentId, worktreePath }) as unknown as AgentTab;

  it("publishes the ORCHESTRATOR when its started worker went red", () => {
    const agents = [tab("b1", "build", null, "/tmp/b1"), tab("w1", "worker", "b1", "/tmp/w1")];
    const published = publishedStatusFor(agents, { b1: "idle", w1: "waiting" }, new Set(["b1", "w1"]), NO_STAGE);
    expect(published["b1"]).toBe("waiting");
    expect(crossWindowRedAgents(agents, published).map((a) => a.id)).toEqual(["b1"]);
  });

  it("publishes the ORCHESTRATOR when its worker is STRANDED (spawned, never started)", () => {
    // The strand has no status entry at all — nothing downstream would call it red — so this case
    // is only covered if withUnstartedWorkerAttention is still first in the chain. Without it the
    // orchestrator broadcasts calm while its own window paints it red.
    const agents = [tab("b1", "build", null, "/tmp/b1"), tab("w1", "worker", "b1", "/tmp/w1")];
    // Parent is live (it just called spawn_worker); the worker is not open and has no status.
    const published = publishedStatusFor(agents, {}, new Set(["b1"]), NO_STAGE);
    expect(published["b1"]).toBe("approval");
    expect(crossWindowRedAgents(agents, published).map((a) => a.id)).toEqual(["b1"]);
  });

  it("never publishes the worker itself, however its red arose", () => {
    const agents = [tab("b1", "build", null, "/tmp/b1"), tab("w1", "worker", "b1", "/tmp/w1")];
    for (const status of [{ b1: "idle", w1: "errored" } as StatusMap, {} as StatusMap]) {
      const published = publishedStatusFor(agents, status, new Set(["b1"]), NO_STAGE);
      expect(crossWindowRedAgents(agents, published).map((a) => a.id)).not.toContain("w1");
    }
  });

  it("leaves a calm build calm — no overlay invents red out of nothing", () => {
    const agents = [tab("b1", "build", null, "/tmp/b1")];
    const published = publishedStatusFor(agents, { b1: "working" }, new Set(["b1"]), NO_STAGE);
    expect(crossWindowRedAgents(agents, published)).toEqual([]);
  });
});
