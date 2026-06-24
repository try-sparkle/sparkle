import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { refreshAgentBranch } from "./branchStatus";

describe("refreshAgentBranch", () => {
  beforeEach(() => invoke.mockReset());

  it("short-circuits to busy without invoking Rust when the agent is busy", async () => {
    const r = await refreshAgentBranch("/root", "p1", "a1", "main", true);
    expect(r).toEqual({ ok: false, reason: "busy" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("passes through the Rust outcome when not busy", async () => {
    invoke.mockResolvedValue({ ok: true, ahead: 2, behind: 0 });
    const r = await refreshAgentBranch("/root", "p1", "a1", "main", false);
    expect(r).toEqual({ ok: true, ahead: 2, behind: 0 });
    expect(invoke).toHaveBeenCalledWith("refresh_agent_branch", {
      root: "/root",
      projectId: "p1",
      agentId: "a1",
      baseBranch: "main",
    });
  });
});
