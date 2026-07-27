// resolvePromptTarget decides which agent the concierge compose box may prompt directly. The
// cloud case is the load-bearing one: a cloud agent has no local PTY (AgentPane.prepare returns
// early for runtime "cloud"), so a target for it would accept a prompt and strand it as pty-gone.
import { describe, expect, it } from "vitest";

import { decidePromptTarget, resolvePinnedProjectId, resolvePromptTarget } from "./shellResolve";
import type { AgentTab, Project, Runtime } from "../types";

function mkAgent(runtime: Runtime, id = "a1"): AgentTab {
  return {
    id,
    name: `Agent ${id}`,
    kind: "build",
    parentId: null,
    runtime,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  };
}

function mkProject(agents: AgentTab[]): Project {
  return {
    id: "p1",
    name: "Demo",
    rootPath: "/tmp/demo",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents,
  };
}

describe("resolvePromptTarget", () => {
  it("targets a local agent by id", () => {
    const t = resolvePromptTarget(mkProject([mkAgent("local")]), "a1");
    expect(t).toEqual({ projectId: "p1", agentId: "a1", name: expect.any(String) });
  });

  it("returns null for a cloud agent — the box must stay Sparkle-only", () => {
    // Dispatch writes through submitPrompt/writePty; a cloud agent's PTY was never spawned, so a
    // target here would swallow the user's prompt into a pty-gone dead end.
    expect(resolvePromptTarget(mkProject([mkAgent("cloud")]), "a1")).toBeNull();
  });

  it("returns null when the selection names a missing agent, project, or nothing", () => {
    expect(resolvePromptTarget(mkProject([mkAgent("local")]), "ghost")).toBeNull();
    expect(resolvePromptTarget(null, "a1")).toBeNull();
    expect(resolvePromptTarget(mkProject([mkAgent("local")]), null)).toBeNull();
  });
});

describe("resolvePinnedProjectId", () => {
  it("keeps a pin that names a live project and drops a dangling one", () => {
    const p = mkProject([]);
    expect(resolvePinnedProjectId([p], "p1")).toBe("p1");
    expect(resolvePinnedProjectId([p], "gone")).toBeNull();
    expect(resolvePinnedProjectId([p], null)).toBeNull();
  });
});

describe("decidePromptTarget", () => {
  // One decision carries both halves, so a refusal cannot ship without the copy that explains it
  // (roborev 49295/52649) — a second `return null` in a separate resolver would have left the
  // toggle saying "select an agent" about an agent the user can see is selected.
  it("explains a CLOUD selection rather than pretending nothing is selected", () => {
    const d = decidePromptTarget(mkProject([mkAgent("cloud")]), "a1");
    expect(d.target).toBeNull();
    expect(d.refusal).toMatch(/Cloud agents/i);
  });

  it("has no refusal when the target resolved", () => {
    const d = decidePromptTarget(mkProject([mkAgent("local")]), "a1");
    expect(d.target).toMatchObject({ agentId: "a1" });
    expect(d.refusal).toBeUndefined();
  });

  it("has no refusal when nothing is selected at all — the default copy is right there", () => {
    expect(decidePromptTarget(mkProject([mkAgent("local")]), null).refusal).toBeUndefined();
    expect(decidePromptTarget(mkProject([mkAgent("local")]), "ghost").refusal).toBeUndefined();
    expect(decidePromptTarget(null, "a1").refusal).toBeUndefined();
  });

  it("resolvePromptTarget is the same decision, target half only", () => {
    const p = mkProject([mkAgent("cloud")]);
    expect(resolvePromptTarget(p, "a1")).toBe(decidePromptTarget(p, "a1").target);
  });
});
