import { describe, it, expect } from "vitest";
import {
  parseWorkerResult,
  workerPersona,
  workerMission,
  orchestrationPersona,
  beadsProtocol,
  WORKER_RESULT_RELPATH,
} from "./buildAgent";

describe("WORKER_RESULT_RELPATH", () => {
  it("is the .sparkle/result.json contract path", () => {
    expect(WORKER_RESULT_RELPATH).toBe(".sparkle/result.json");
  });
});

describe("parseWorkerResult", () => {
  const valid = JSON.stringify({
    schemaVersion: 1,
    taskId: "t1",
    branch: "sparkle/agent-w1",
    status: "success",
    filesChanged: ["a.ts", "b.ts"],
    summary: "did the thing",
  });

  it("parses a valid result", () => {
    const r = parseWorkerResult(valid);
    expect(r.status).toBe("success");
    expect(r.filesChanged).toEqual(["a.ts", "b.ts"]);
    expect(r.notes).toBeUndefined();
  });

  it("throws on a bad status value", () => {
    const bad = JSON.stringify({ ...JSON.parse(valid), status: "done" });
    expect(() => parseWorkerResult(bad)).toThrow(/status/);
  });

  it("throws on a missing required field", () => {
    const bad = JSON.stringify({ ...JSON.parse(valid), branch: undefined });
    expect(() => parseWorkerResult(bad)).toThrow(/branch/);
  });

  it("throws on non-JSON", () => {
    expect(() => parseWorkerResult("not json")).toThrow();
  });

  it("throws on null JSON", () => {
    expect(() => parseWorkerResult("null")).toThrow(/object/);
  });

  it("throws on scalar JSON", () => {
    expect(() => parseWorkerResult("123")).toThrow(/object/);
  });

  it("throws on array JSON", () => {
    expect(() => parseWorkerResult("[]")).toThrow(/object/);
  });

  it("throws on empty summary", () => {
    const bad = JSON.stringify({ ...JSON.parse(valid), summary: "" });
    expect(() => parseWorkerResult(bad)).toThrow(/summary/);
  });
});

describe("workerPersona", () => {
  const p = workerPersona({ parentBranch: "sparkle/agent-build1", resultPath: "/wt/.sparkle/result.json" });
  it("names the result path and parent branch and forbids spawning workers", () => {
    expect(p).toContain("/wt/.sparkle/result.json");
    expect(p).toContain("sparkle/agent-build1");
    expect(p).toMatch(/exactly ONE task/i);
    expect(p).toMatch(/do not.*spawn/i);
  });
  it("tells the worker it is unattended: don't ask questions, assume-and-report instead", () => {
    // No human is watching a worker, so a clarifying question or approval wait is a silent stall.
    expect(p).toMatch(/unattended|no one is watching|no human/i);
    expect(p).toMatch(/do not ask/i);
    expect(p).toMatch(/assumption/i);
    expect(p).toMatch(/notes/i);
  });
});

describe("workerMission", () => {
  it("embeds the task", () => {
    expect(workerMission("Implement the login form", "agent-abc")).toContain("Implement the login form");
  });

  it("puts the taskId on a leading Task <id>: line", () => {
    const out = workerMission("Implement the login form", "agent-abc");
    expect(out).toContain("Task agent-abc:");
    expect(out).toContain("Implement the login form");
    // The id line must come before the task text
    expect(out.indexOf("Task agent-abc:")).toBeLessThan(out.indexOf("Implement the login form"));
  });
});

describe("orchestrationPersona", () => {
  const p = orchestrationPersona({ ownBranch: "sparkle/agent-build1", maxConcurrentWorkers: 4 });

  it("establishes the orchestrator role and decomposition", () => {
    expect(p).toMatch(/ORCHESTRATOR|orchestrator/);
    expect(p).toMatch(/decompose/i);
  });

  it("states the division of labor: subagents for research, spawn_worker for code units", () => {
    expect(p).toMatch(/subagent/i);
    expect(p).toMatch(/read-only|research/i);
    expect(p).toContain("spawn_worker");
  });

  it("names the wait + list tools and the concurrency cap", () => {
    expect(p).toContain("wait_for_workers");
    expect(p).toContain("list_workers");
    expect(p).toContain("4"); // the cap value is interpolated
  });

  it("uses explicit batching up to the cap — no 'queues automatically' promise", () => {
    // The persona must instruct batching explicitly and warn against exceeding the cap.
    // It must NOT claim that spawn_worker queues transparently (that caused deadlock).
    expect(p).not.toMatch(/queue.*automatically|automatically.*queue/i);
    // Instructs to spawn up to the cap per batch.
    expect(p).toMatch(/up to.*4|batch/i);
    // Instructs to spin_down_worker to free slots before the next batch.
    expect(p).toMatch(/spin.?down|free.*slot|slot.*free/i);
    // Warns against exceeding the cap without spinning down first.
    expect(p).toMatch(/exceed.*cap|reach the cap|cap.*time|not.*more than.*cap/i);
    // Positively asserts the ACCURATE mechanism (over-cap queues but BLOCKS the REPL → deadlock/timeout),
    // not just the absence of the old "queues automatically" phrasing.
    expect(p).toMatch(/block|deadlock/i);
  });

  it("instructs a SEQUENTIAL merge into its own branch, never main", () => {
    expect(p).toContain("sparkle/agent-build1"); // its own branch, the merge target
    expect(p).toMatch(/one at a time|sequentially/i);
    expect(p).toMatch(/never/i);
    expect(p).toMatch(/\bmain\b/);
    expect(p).toMatch(/conflict/i);
  });

  it("tells it to spin_down_worker after merging and to report the consolidated outcome", () => {
    expect(p).toContain("spin_down_worker");
    expect(p).toMatch(/report|consolidated/i);
  });

  it("reflects a different cap value", () => {
    expect(orchestrationPersona({ ownBranch: "b", maxConcurrentWorkers: 2 })).toContain("2");
  });

  it("tells it to handle an `errored` worker (decide: respawn / redirect / escalate) and not merge it", () => {
    expect(p).toMatch(/errored/);
    expect(p).toMatch(/respawn|re-?spawn/i);
    expect(p).toMatch(/escalate|report/i);
    // An errored worker must not be merged as if it succeeded.
    expect(p).toMatch(/do not merge|not.*merge/i);
  });
});

describe("beadsProtocol", () => {
  const p = beadsProtocol({ epicId: "epic-42" });

  it("binds the orchestrator to the epic and its child tasks", () => {
    expect(p).toContain("epic-42");
    expect(p).toContain("bd show epic-42 --json");
    expect(p).toContain("spawn_worker");
  });

  it("instructs exactly one worker per task, linked to its bead via the beadId argument", () => {
    expect(p).toMatch(/one worker/i);
    expect(p).toContain("beadId"); // the worker↔bead linkage argument
    expect(p).toContain("spawn_worker");
  });

  it("leaves status transitions to the app, not manual bd commands", () => {
    // in_progress/closed/delivered are now written programmatically (syncBeadLifecycle); the
    // orchestrator is explicitly told NOT to run them by hand so the board can't drift.
    expect(p).toMatch(/do not run/i);
    expect(p).toMatch(/automatically/i);
  });
});
