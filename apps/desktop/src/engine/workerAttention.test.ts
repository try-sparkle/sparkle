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
    const status: Record<string, AgentTabStatus> = { build1: "working", w1: "errored" };
    const eff = withRedWorkerAttention(agents, status);
    expect(eff.build1).toBe("errored");
    expect(eff.w1).toBe("errored"); // worker's own status is untouched
  });

  it.each(["waiting", "approval", "errored"] as const)(
    "bubbles the %s red status specifically",
    (redStatus) => {
      const status: Record<string, AgentTabStatus> = { build1: "working", w1: redStatus };
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
    const status: Record<string, AgentTabStatus> = { build1: "working", w1: "errored" };
    withRedWorkerAttention(agents, status);
    expect(status).toEqual({ build1: "working", w1: "errored" });
  });
});
