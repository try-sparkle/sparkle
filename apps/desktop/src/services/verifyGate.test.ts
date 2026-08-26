// verifyGate service — the run coalescer, and the two failure directions that must not be
// collapsed: a command that could not run, versus a run whose checks failed.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  attachVerifyGateEvidence,
  fetchVerifyGateStatus,
  runVerifyGate,
  verifyGateTestingMarkdown,
} from "./verifyGate";
import { entryFor, useVerifyGateStore, type VerifyGateReport } from "../stores/verifyGateStore";

const PASSING: VerifyGateReport = {
  version: 1,
  agentId: "a1",
  worktree: "/w/tree",
  branch: "feat/x",
  checks: [
    {
      name: "test",
      cmd: "pnpm run test",
      status: "pass",
      exitCode: 0,
      durationMs: 1200,
      tail: "",
      logPath: null,
    },
  ],
  verdict: "pass",
  startedAt: 1,
  finishedAt: 2,
};

beforeEach(() => {
  invoke.mockReset();
  useVerifyGateStore.setState({ byAgent: {} });
});

describe("runVerifyGate coalesces per (project, agent)", () => {
  it("issues ONE run command when two callers fire for the same agent", async () => {
    let settle!: (v: unknown) => void;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "verify_gate_run") return new Promise((r) => (settle = r));
      return Promise.resolve({ report: PASSING, evidence: [] });
    });

    const first = runVerifyGate("/repo", "a1", "/w/tree");
    const second = runVerifyGate("/repo", "a1", "/w/tree");
    expect(invoke.mock.calls.filter((c) => c[0] === "verify_gate_run")).toHaveLength(1);

    settle(PASSING);
    // The late caller gets the WINNER'S real outcome, not a silent skip — a skip leaves its caller
    // with nothing to render.
    await expect(first).resolves.toEqual(PASSING);
    await expect(second).resolves.toEqual(PASSING);
  });

  it("runs separately for a DIFFERENT agent in the same project", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "verify_gate_run"
        ? Promise.resolve(PASSING)
        : Promise.resolve({ report: PASSING, evidence: [] }),
    );
    await Promise.all([runVerifyGate("/repo", "a1", "/w/1"), runVerifyGate("/repo", "a2", "/w/2")]);
    expect(invoke.mock.calls.filter((c) => c[0] === "verify_gate_run")).toHaveLength(2);
  });

  it("clears the in-flight slot after a FAILED run, so the gate is runnable again", async () => {
    invoke.mockRejectedValueOnce(new Error("could not save the report"));
    await expect(runVerifyGate("/repo", "a1", "/w/tree")).rejects.toThrow();
    // The side effect: a stuck slot would make the gate permanently un-runnable for this agent.
    invoke.mockImplementation((cmd: string) =>
      cmd === "verify_gate_run"
        ? Promise.resolve(PASSING)
        : Promise.resolve({ report: PASSING, evidence: [] }),
    );
    await expect(runVerifyGate("/repo", "a1", "/w/tree")).resolves.toEqual(PASSING);
  });

  it("clears `running` on both the success and the failure path", async () => {
    invoke.mockRejectedValueOnce(new Error("boom"));
    await expect(runVerifyGate("/repo", "a1", "/w/tree")).rejects.toThrow();
    // A stuck `running` is a permanently disabled button.
    expect(entryFor(useVerifyGateStore.getState(), "a1").running).toBe(false);
    expect(entryFor(useVerifyGateStore.getState(), "a1").error).toContain("boom");
  });

  it("marks running BEFORE the command resolves, so the button disables on click", async () => {
    let settle!: (v: unknown) => void;
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "verify_gate_run") return new Promise((r) => (settle = r));
      return Promise.resolve({ report: PASSING, evidence: [] });
    });
    const p = runVerifyGate("/repo", "a1", "/w/tree");
    expect(entryFor(useVerifyGateStore.getState(), "a1").running).toBe(true);
    settle(PASSING);
    await p;
    expect(entryFor(useVerifyGateStore.getState(), "a1").running).toBe(false);
  });

  it("keeps a report whose checks FAILED — a red gate is a result, not an error", async () => {
    const red: VerifyGateReport = { ...PASSING, verdict: "fail" };
    invoke.mockImplementation((cmd: string) =>
      cmd === "verify_gate_run" ? Promise.resolve(red) : Promise.resolve({ report: red, evidence: [] }),
    );
    await expect(runVerifyGate("/repo", "a1", "/w/tree")).resolves.toEqual(red);
    const e = entryFor(useVerifyGateStore.getState(), "a1");
    expect(e.report?.verdict).toBe("fail");
    // NOT an error: "we could not run the gate" and "the gate says no" render differently.
    expect(e.error).toBeNull();
  });

  it("still stores the report when the evidence read fails", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "verify_gate_run"
        ? Promise.resolve(PASSING)
        : Promise.reject(new Error("evidence dir unreadable")),
    );
    await expect(runVerifyGate("/repo", "a1", "/w/tree")).resolves.toEqual(PASSING);
    // Minutes of checks must not be thrown away because a manifest could not be read.
    expect(entryFor(useVerifyGateStore.getState(), "a1").report).toEqual(PASSING);
  });
});

describe("fetchVerifyGateStatus", () => {
  it("leaves the fail-closed gate standing when the status cannot be read", async () => {
    invoke.mockRejectedValue(new Error("bridge down"));
    await expect(fetchVerifyGateStatus("/repo", "a1")).resolves.toBeNull();
    const e = entryFor(useVerifyGateStore.getState(), "a1");
    // An unreadable status must never render as permission to open a PR.
    expect(e.prGate.allowed).toBe(false);
    expect(e.error).toContain("bridge down");
  });

  it("passes the backend's decision straight through on success", async () => {
    invoke.mockResolvedValue({
      agentId: "a1",
      running: false,
      verdict: "pass",
      checksTotal: 1,
      checksPassed: 1,
      finishedAt: 9,
      enabled: true,
      prGate: { allowed: true, reason: "all 1 checks passed", enforced: true },
    });
    await fetchVerifyGateStatus("/repo", "a1");
    expect(entryFor(useVerifyGateStore.getState(), "a1").prGate.allowed).toBe(true);
  });
});

describe("attachVerifyGateEvidence", () => {
  const item = {
    id: "abc123",
    caption: "first",
    fileName: "abc123.png",
    path: "/w/e/abc123.png",
    kind: "image" as const,
    bytes: 1,
    at: 1,
    sourcePath: "/tmp/shot.png",
  };

  it("adds the artifact to the agent's strip", async () => {
    invoke.mockResolvedValue(item);
    await attachVerifyGateEvidence("/repo", "a1", "/tmp/shot.png", "first");
    expect(entryFor(useVerifyGateStore.getState(), "a1").evidence).toEqual([item]);
  });

  it("REPLACES a same-id artifact instead of showing it twice", async () => {
    invoke.mockResolvedValueOnce(item);
    await attachVerifyGateEvidence("/repo", "a1", "/tmp/shot.png", "first");
    invoke.mockResolvedValueOnce({ ...item, caption: "corrected" });
    await attachVerifyGateEvidence("/repo", "a1", "/tmp/shot.png", "corrected");
    const strip = entryFor(useVerifyGateStore.getState(), "a1").evidence;
    // Rust's manifest is content-addressed and de-duplicates; the strip must agree immediately
    // rather than showing a duplicate until the next full report read.
    expect(strip).toHaveLength(1);
    expect(strip[0]?.caption).toBe("corrected");
  });

  it("sends the caption the caller gave, not a derived one", async () => {
    invoke.mockResolvedValue(item);
    await attachVerifyGateEvidence("/repo", "a1", "/tmp/shot.png", "login flow, signed in");
    expect(invoke).toHaveBeenCalledWith("verify_gate_attach_evidence", {
      projectRoot: "/repo",
      agentId: "a1",
      sourcePath: "/tmp/shot.png",
      caption: "login flow, signed in",
    });
  });
});

describe("verifyGateTestingMarkdown", () => {
  it("returns null when there is no report, never an empty section", async () => {
    invoke.mockResolvedValue(null);
    await expect(verifyGateTestingMarkdown("/repo", "a1")).resolves.toBeNull();
  });

  it("returns the rendered section when there is one", async () => {
    invoke.mockResolvedValue("## Testing\n\n**Verdict: PASS**\n");
    await expect(verifyGateTestingMarkdown("/repo", "a1")).resolves.toContain("**Verdict: PASS**");
  });
});
