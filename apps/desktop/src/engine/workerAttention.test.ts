// A worker the orchestrator spawned + cut a worktree for, but which never went live (not in
// openAgentIds, no PTY status), is the "Start this agent" strand: it silently blocks its
// orchestrator with a gray dot. These tests pin the detector that drives both the self-healing
// auto-open and the RED ("Approve?") overlay that surfaces the block at the top.
import { describe, expect, it } from "vitest";
import type { AgentTab, AgentTabStatus } from "../types";
import {
  isUnstartedWorker,
  workersNeedingOpen,
  withUnstartedWorkerAttention,
  withRedWorkerAttention,
} from "./workerAttention";

// Minimal factory — workerAttention only reads id/kind/parentId/worktreePath.
function agent(over: Partial<AgentTab> & { id: string }): AgentTab {
  return {
    kind: "worker",
    parentId: "build1",
    worktreePath: "/wt/" + over.id,
    name: over.id,
    ...over,
  } as AgentTab;
}

// The orchestrator (build1) is live — the normal case when it has just spawned a worker.
const parentOpen: ReadonlySet<string> = new Set<string>(["build1"]);

describe("isUnstartedWorker", () => {
  it("is true for a materialized worker that isn't open and has no live status", () => {
    expect(isUnstartedWorker(agent({ id: "w" }), {}, parentOpen)).toBe(true);
  });

  it("is false once the worker is open (its pane mounts → it will launch)", () => {
    expect(isUnstartedWorker(agent({ id: "w" }), {}, new Set(["build1", "w"]))).toBe(false);
  });

  it("is false once the worker has a live PTY status (already running)", () => {
    expect(isUnstartedWorker(agent({ id: "w" }), { w: "working" }, parentOpen)).toBe(false);
  });

  it("is false before the worktree is cut (queued / mid-spawn — don't force it open)", () => {
    expect(isUnstartedWorker(agent({ id: "w", worktreePath: null }), {}, parentOpen)).toBe(false);
  });

  it("is false when the ORCHESTRATOR isn't live (e.g. deliberately closed / relocating)", () => {
    expect(isUnstartedWorker(agent({ id: "w" }), {}, new Set<string>())).toBe(false);
  });

  it("is false for non-workers and for parentless workers", () => {
    expect(isUnstartedWorker(agent({ id: "b", kind: "build", parentId: null }), {}, parentOpen)).toBe(
      false,
    );
    expect(isUnstartedWorker(agent({ id: "w", parentId: null }), {}, parentOpen)).toBe(false);
  });
});

describe("workersNeedingOpen", () => {
  it("returns exactly the unstarted workers, in array order", () => {
    const agents = [
      agent({ id: "build1", kind: "build", parentId: null }),
      agent({ id: "w1" }), // unstarted
      agent({ id: "w2" }), // open → skip
      agent({ id: "w3" }), // running → skip
      agent({ id: "w4" }), // unstarted
    ];
    const out = workersNeedingOpen(agents, { w3: "working" }, new Set(["build1", "w2"]));
    expect(out.map((a) => a.id)).toEqual(["w1", "w4"]);
  });
});

describe("withUnstartedWorkerAttention — parent guard", () => {
  // The ONLY coverage of the blocked-parent branch used to live in redTaxonomySeparation.test.ts and
  // was removed when that file was trimmed, leaving this guard revertible with a green suite
  // (roborev on f7b43dc8). The synthesized `approval` is a needs-you-now status, so it must win over
  // a parent that is merely `blocked` — same asymmetric rule as withRedWorkerAttention.
  const parentAgents = [
    agent({ id: "build1", kind: "build", parentId: null }),
    agent({ id: "w1" }),
  ];
  const liveParent: ReadonlySet<string> = new Set<string>(["build1"]);

  it("overwrites a parent that is merely BLOCKED (an ask is not shadowed by a stall)", () => {
    const out = withUnstartedWorkerAttention(parentAgents, { build1: "blocked" }, liveParent);
    expect(out.w1).toBe("approval");
    expect(out.build1).toBe("approval");
  });

  it("leaves a parent that is asking on its own behalf", () => {
    const out = withUnstartedWorkerAttention(parentAgents, { build1: "waiting" }, liveParent);
    expect(out.build1).toBe("waiting");
  });
});

describe("withUnstartedWorkerAttention", () => {
  it("overlays approval (red) on the unstarted worker AND bubbles it to its orchestrator", () => {
    const agents = [
      agent({ id: "build1", kind: "build", parentId: null }),
      agent({ id: "w1" }),
    ];
    const status: Record<string, AgentTabStatus> = { build1: "working" };
    const eff = withUnstartedWorkerAttention(agents, status, parentOpen);
    expect(eff.w1).toBe("approval");
    expect(eff.build1).toBe("approval"); // working orchestrator → red, because it's blocked
  });

  it("does not mutate the input status map", () => {
    const agents = [agent({ id: "build1", kind: "build", parentId: null }), agent({ id: "w1" })];
    const status: Record<string, AgentTabStatus> = { build1: "working" };
    withUnstartedWorkerAttention(agents, status, parentOpen);
    expect(status).toEqual({ build1: "working" });
  });

  it("returns the same reference when nothing is unstarted (cheap no-op)", () => {
    const agents = [agent({ id: "build1", kind: "build", parentId: null }), agent({ id: "w1" })];
    const status: Record<string, AgentTabStatus> = { build1: "working", w1: "working" };
    expect(withUnstartedWorkerAttention(agents, status, parentOpen)).toBe(status);
  });

  it("does not downgrade an orchestrator that is already RED for its own reason", () => {
    const agents = [agent({ id: "build1", kind: "build", parentId: null }), agent({ id: "w1" })];
    const status: Record<string, AgentTabStatus> = { build1: "errored" };
    const eff = withUnstartedWorkerAttention(agents, status, parentOpen);
    expect(eff.w1).toBe("approval");
    expect(eff.build1).toBe("errored"); // keep the more specific red
  });
});

describe("withRedWorkerAttention", () => {
  const agents = [
    agent({ id: "build1", kind: "build", parentId: null }),
    agent({ id: "w1" }),
    agent({ id: "w2" }),
  ];

  it("bubbles a started worker's RED status to its orchestrator (parent floats up + turns red)", () => {
    const status: Record<string, AgentTabStatus> = { build1: "idle", w1: "errored" };
    const eff = withRedWorkerAttention(agents, status);
    expect(eff.build1).toBe("errored");
    expect(eff.w1).toBe("errored"); // worker's own status is untouched
  });

  it.each(["waiting", "approval", "errored"] as const)(
    "bubbles the %s red status specifically",
    (redStatus) => {
      const status: Record<string, AgentTabStatus> = { build1: "idle", w1: redStatus };
      expect(withRedWorkerAttention(agents, status).build1).toBe(redStatus);
    },
  );

  it("leaves a non-red (working/idle) worker's parent alone", () => {
    const status: Record<string, AgentTabStatus> = { build1: "idle", w1: "working" };
    expect(withRedWorkerAttention(agents, status)).toBe(status); // same ref → no change
  });

  it("does not downgrade a parent already red for its own reason (or another worker)", () => {
    const status: Record<string, AgentTabStatus> = { build1: "approval", w1: "errored" };
    expect(withRedWorkerAttention(agents, status).build1).toBe("approval");
  });

  it("does not mutate the input status map", () => {
    const status: Record<string, AgentTabStatus> = { build1: "idle", w1: "errored" };
    withRedWorkerAttention(agents, status);
    expect(status).toEqual({ build1: "idle", w1: "errored" });
  });

  // A `blocked` worker is RED but is NOT asking you anything, and it bubbles like any other red once
  // the fleet is still. This used to be impossible: the guard called `needsAttention` (the narrow
  // waiting|approval|errored set) behind a comment reading "only RED workers bubble", so a quiet
  // worker never reached its orchestrator's row at all (2026-07-26).
  it("bubbles a BLOCKED worker to a settled orchestrator", () => {
    const status: Record<string, AgentTabStatus> = { build1: "idle", w1: "blocked" };
    expect(withRedWorkerAttention(agents, status).build1).toBe("blocked");
  });

  // IN-MOTION SUPPRESSION. These pin the 2026-07-22 fix — a moving orchestrator is not "needs you" —
  // as NARROWED on 2026-07-26 to cover only the non-ask reds. `blocked` ("this worker went quiet")
  // is the status that can be swallowed by a moving fleet; a real ask never is (see the group after).
  it("does NOT bubble a blocked worker to a parent that is working itself", () => {
    const status: Record<string, AgentTabStatus> = { build1: "working", w1: "blocked" };
    expect(withRedWorkerAttention(agents, status)).toBe(status); // same ref → untouched
  });

  it("does NOT bubble a blocked worker while another worker is still building", () => {
    const status: Record<string, AgentTabStatus> = { build1: "idle", w1: "blocked", w2: "working" };
    expect(withRedWorkerAttention(agents, status)).toBe(status);
  });

  // Motion must not latch: the whole point is that a genuinely stuck fleet still surfaces.
  it("bubbles once the fleet settles and nothing is moving any more", () => {
    const moving: Record<string, AgentTabStatus> = { build1: "idle", w1: "blocked", w2: "working" };
    expect(withRedWorkerAttention(agents, moving).build1).toBe("idle");
    const settled: Record<string, AgentTabStatus> = { build1: "idle", w1: "blocked", w2: "idle" };
    expect(withRedWorkerAttention(agents, settled).build1).toBe("blocked");
  });

  // Suppression is scoped to the parent that is moving — an unrelated orchestrator still bubbles.
  it("suppresses only the moving parent, not another orchestrator's fleet", () => {
    const twoFleets = [
      agent({ id: "build1", kind: "build", parentId: null }),
      agent({ id: "build2", kind: "build", parentId: null }),
      agent({ id: "w1" }),
      agent({ id: "w2", parentId: "build2" }),
    ];
    const status: Record<string, AgentTabStatus> = {
      build1: "working",
      w1: "blocked",
      build2: "idle",
      w2: "blocked",
    };
    const eff = withRedWorkerAttention(twoFleets, status);
    expect(eff.build1).toBe("working"); // moving → suppressed
    expect(eff.build2).toBe("blocked"); // settled → bubbled
  });

  // THE OTHER HALF of the 2026-07-26 report: an ask is never swallowed. The first cut suppressed
  // every red in a moving fleet, so one busy sibling was enough to hide a worker sitting on a
  // question — the fleet looked healthy while a strand was stopped dead.
  it.each(["waiting", "approval", "errored"] as const)(
    "ALWAYS bubbles %s, even while the fleet is in motion",
    (ask) => {
      const status: Record<string, AgentTabStatus> = { build1: "idle", w1: ask, w2: "working" };
      expect(withRedWorkerAttention(agents, status).build1).toBe(ask);
    },
  );

  it("ALWAYS bubbles an ask even when the orchestrator itself is working", () => {
    const status: Record<string, AgentTabStatus> = { build1: "working", w1: "waiting" };
    expect(withRedWorkerAttention(agents, status).build1).toBe("waiting");
  });

  // An `errored` worker is NOT suppressed by a moving fleet, which reverses the 2026-07-22 fix for
  // that one status. Deliberate, and pinned here so it can't be undone by accident: a crashed or
  // API-wedged worker has stopped producing anything and is burning your time until you look (it is
  // in engine/attention's badge set for exactly that reason), and a busy sibling does not make that
  // less true. What the 2026-07-22 report was actually about — a fleet that merely looks quiet —
  // is `blocked`, which is still suppressed above.
  it("bubbles an ERRORED worker even mid-fleet (2026-07-22 suppression deliberately reversed here)", () => {
    const status: Record<string, AgentTabStatus> = { build1: "working", w1: "errored" };
    expect(withRedWorkerAttention(agents, status).build1).toBe("errored");
    const sibling: Record<string, AgentTabStatus> = { build1: "idle", w1: "errored", w2: "working" };
    expect(withRedWorkerAttention(agents, sibling).build1).toBe("errored");
  });

  // ── An ask must not be shadowed by a non-ask red ────────────────────────────────────────────────
  // Found by roborev on 4b3ede48 (both reviewers, independently). Widening the parent guard from
  // `needsAttention` to `isRedStatus` made a non-ask red on the parent BLOCK a genuine ask from ever
  // reaching it — the exact opposite of the invariant this module claims to hold.
  it("lets a worker's ask overwrite a parent that is red for a NON-ask reason", () => {
    const status: Record<string, AgentTabStatus> = { build1: "blocked", w1: "waiting" };
    expect(withRedWorkerAttention(agents, status).build1).toBe("waiting");
  });

  it("lets an ask win over a blocked SIBLING regardless of array order", () => {
    // The blocked worker bubbles first and would otherwise latch the parent at `blocked`, making the
    // row's meaning depend on the order of the agents array.
    const blockedFirst: Record<string, AgentTabStatus> = { build1: "idle", w1: "blocked", w2: "waiting" };
    expect(withRedWorkerAttention(agents, blockedFirst).build1).toBe("waiting");
    const askFirst: Record<string, AgentTabStatus> = { build1: "idle", w1: "waiting", w2: "blocked" };
    expect(withRedWorkerAttention(agents, askFirst).build1).toBe("waiting");
  });

  it("never downgrades an ask already on the parent to another worker's ask", () => {
    // Two asks: first writer wins, so the parent keeps a stable reason rather than flapping.
    const status: Record<string, AgentTabStatus> = { build1: "idle", w1: "waiting", w2: "approval" };
    expect(withRedWorkerAttention(agents, status).build1).toBe("waiting");
  });

  it("never downgrades a parent that is asking on its OWN behalf", () => {
    const status: Record<string, AgentTabStatus> = { build1: "approval", w1: "blocked" };
    expect(withRedWorkerAttention(agents, status).build1).toBe("approval");
  });

  // The trade-off, stated so it can't be read as an accident: when a worker asks, the parent's OWN
  // `blocked` is REPLACED, not merely out-ranked — the row stops saying the orchestrator went quiet
  // and says the worker needs you instead. That is the right call (a question is actionable, a
  // stall is not) but it does lose a fact, so it is pinned rather than left implicit.
  it("REPLACES a parent's own blocked with the worker's ask (deliberate loss of the parent reason)", () => {
    const status: Record<string, AgentTabStatus> = { build1: "blocked", w1: "approval" };
    expect(withRedWorkerAttention(agents, status).build1).toBe("approval");
  });
});
