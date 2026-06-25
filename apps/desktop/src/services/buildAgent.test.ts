import { describe, it, expect } from "vitest";
import {
  parseWorkerResult,
  workerPersona,
  workerMission,
  orchestrationPersona,
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
});
