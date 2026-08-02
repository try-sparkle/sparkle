// resolvePromptTarget decides which agent the concierge compose box may prompt directly.
//
// The cloud case is still the load-bearing one, but it flipped (design 2026-08-01 §Decision 7).
// It used to return null with "Cloud agents take prompts in the terminal for now", because dispatch
// wrote only through submitPrompt/writePty and a cloud agent has no local PTY — so a target here
// would have swallowed the prompt into a pty-gone dead end. `dispatchConciergeAnswer` now routes a
// cloud PROMPT through `getTransport` to the sandbox's stdin, so a cloud tab IS a promptable target
// and the old refusal copy would be advice to work around a feature that works. What a cloud agent
// still cannot take is an ANSWER to a prompt on its own screen, and that refusal lives at the
// dispatcher — which reads the screen — not in this resolver, which cannot see one.
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

  it("returns a TARGET for a cloud agent — the box can prompt one now", () => {
    // The assertion that fails if the early return comes back: dispatch relays a cloud prompt to
    // the sandbox's stdin (services/conciergeDispatch.cloud.test.ts pins the emit), so refusing the
    // target here would disable a working path and tell the user to go and type in the terminal.
    expect(resolvePromptTarget(mkProject([mkAgent("cloud")]), "a1")).toEqual({
      projectId: "p1",
      agentId: "a1",
      name: expect.any(String),
    });
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
  it("has NO refusal for a cloud selection — there is nothing left to explain", () => {
    const d = decidePromptTarget(mkProject([mkAgent("cloud")]), "a1");
    expect(d.target).toMatchObject({ agentId: "a1" });
    // Specifically NOT the old "Cloud agents take prompts in the terminal for now": a refusal
    // string is an instruction (AGENTS.md), and this one would now instruct the user around a path
    // that delivers. A stale copy left behind here would still have passed a `target === null`
    // assertion, so the copy is asserted absent rather than merely the target present.
    expect(d.refusal).toBeUndefined();
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
    // A REFUSING case, so this pins "same decision" rather than "both happen to resolve": a
    // torn-apart pair would agree on a null target for a missing agent by coincidence.
    const p = mkProject([mkAgent("local")]);
    expect(resolvePromptTarget(p, "ghost")).toBe(decidePromptTarget(p, "ghost").target);
    expect(resolvePromptTarget(p, "a1")).toEqual(decidePromptTarget(p, "a1").target);
  });
});
