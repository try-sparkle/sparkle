import { describe, it, expect } from "vitest";
import {
  parseWorkerResult,
  workerPersona,
  workerMission,
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
