import { describe, it, expect } from "vitest";
import {
  planDemotion,
  demotionBriefing,
  CLOUD_WIP_COMMIT_MESSAGE,
  type DemotionAgent,
  type DemotionPlanInput,
} from "./plan";

function agent(over: Partial<DemotionAgent> = {}): DemotionAgent {
  return {
    id: "tab-1",
    runtime: "cloud",
    kind: "build",
    worktreePath: null,
    branch: "sparkle/agent-42",
    name: "Widget Builder",
    ...over,
  };
}

function input(over: Partial<DemotionPlanInput> = {}): DemotionPlanInput {
  return {
    agent: agent(),
    project: { id: "proj-1", rootPath: "/Users/x/repo" },
    ...over,
  };
}

describe("planDemotion — refusals", () => {
  it("refuses an agent that is already local", () => {
    const p = planDemotion(input({ agent: agent({ runtime: "local" }) }));
    expect(p).toMatchObject({ ok: false, refusal: "not_cloud" });
    expect(p.ok === false && p.message).toMatch(/already running on this Mac/i);
  });

  it("refuses an UNKNOWN runtime — remoteness must be a positive claim", () => {
    // The inverse of promotion's rule, and load-bearing: this is the step that starts committing
    // and pushing inside a sandbox. `undefined` means "no record names the runtime", and the rest
    // of the app reads that as local (`a.runtime ?? "local"`).
    expect(planDemotion(input({ agent: agent({ runtime: undefined }) }))).toMatchObject({
      ok: false,
      refusal: "not_cloud",
    });
    expect(planDemotion(input({ agent: agent({ runtime: "unknown" }) }))).toMatchObject({
      ok: false,
      refusal: "not_cloud",
    });
  });

  it("refuses a shell agent", () => {
    const p = planDemotion(input({ agent: agent({ kind: "shell" }) }));
    expect(p).toMatchObject({ ok: false, refusal: "shell_agent" });
  });

  it("refuses when there is no project, then when the project has no folder", () => {
    expect(planDemotion(input({ project: null }))).toMatchObject({
      ok: false,
      refusal: "no_project",
    });
    expect(
      planDemotion(input({ project: { id: "proj-1", rootPath: null } })),
    ).toMatchObject({ ok: false, refusal: "no_root" });
  });

  it("refuses when the agent has no branch recorded", () => {
    expect(planDemotion(input({ agent: agent({ branch: null }) }))).toMatchObject({
      ok: false,
      refusal: "no_branch",
    });
    // Whitespace is not a branch.
    expect(planDemotion(input({ agent: agent({ branch: "   " }) }))).toMatchObject({
      ok: false,
      refusal: "no_branch",
    });
  });

  it("orders refusals outside-in: agent kind before workspace, workspace before branch", () => {
    // A shell agent with no project at all still refuses as a SHELL agent — naming the project
    // would send the user to fix something that isn't the reason.
    expect(
      planDemotion({ agent: agent({ kind: "shell", branch: null }), project: null }),
    ).toMatchObject({ refusal: "shell_agent" });
    // …and a cloud build agent with neither project nor branch names the project first.
    expect(planDemotion({ agent: agent({ branch: null }), project: null })).toMatchObject({
      refusal: "no_project",
    });
  });

  it("does NOT consult a cloud gate — the exit must stay open when credits run out", () => {
    // Pinned as an ABSENCE (plan W4): planDemotion takes no gate at all, so a user who is out of
    // credits can still bring their work down. This asserts the shape the dialog depends on.
    const p = planDemotion(input());
    expect(p.ok).toBe(true);
    expect(Object.keys(input())).not.toContain("gate");
  });
});

describe("planDemotion — the warnings the dialog must render", () => {
  it("always states that sandbox WIP is committed and pushed, naming the commit and the branch", () => {
    const p = planDemotion(input());
    expect(p.ok).toBe(true);
    const warnings = p.ok ? p.warnings : [];
    const wip = warnings.find((w) => w.includes(CLOUD_WIP_COMMIT_MESSAGE));
    expect(wip).toBeDefined();
    expect(wip).toContain("origin/sparkle/agent-42");
  });

  it("states the sandbox is DESTROYED and nothing outside git survives it", () => {
    const p = planDemotion(input());
    const warnings = p.ok ? p.warnings : [];
    expect(warnings.some((w) => /destroy/i.test(w) && /outside git/i.test(w))).toBe(true);
  });

  it("states the conversation is downloaded onto this Mac when a transcript is expected", () => {
    const p = planDemotion(input());
    const warnings = p.ok ? p.warnings : [];
    expect(warnings.some((w) => /downloaded through Sparkle onto this Mac/i.test(w))).toBe(true);
  });

  it("keeps the custody warning when the caller says nothing — unknown must not drop a disclosure", () => {
    const p = planDemotion(input({ expectTranscript: undefined }));
    const warnings = p.ok ? p.warnings : [];
    expect(warnings).toHaveLength(3);
  });

  it("drops ONLY the custody warning when the caller positively knows there is no transcript", () => {
    const p = planDemotion(input({ expectTranscript: false }));
    const warnings = p.ok ? p.warnings : [];
    expect(warnings).toHaveLength(2);
    expect(warnings.some((w) => /downloaded/i.test(w))).toBe(false);
    // The two unconditional ones survive.
    expect(warnings.some((w) => w.includes(CLOUD_WIP_COMMIT_MESSAGE))).toBe(true);
    expect(warnings.some((w) => /destroy/i.test(w))).toBe(true);
  });

  it("states the destruction warning even for a project whose worktree already exists", () => {
    // A previously-promoted agent still loses its sandbox. The desktop cannot see the sandbox's
    // working tree, so "there's nothing uncommitted in there" is never a claim it may make.
    const p = planDemotion(input({ agent: agent({ worktreePath: "/Users/x/wt/agent-42" }) }));
    const warnings = p.ok ? p.warnings : [];
    expect(warnings.some((w) => /destroy/i.test(w))).toBe(true);
  });

  it("returns the agent's branch, trimmed", () => {
    const p = planDemotion(input({ agent: agent({ branch: "  sparkle/x  " }) }));
    expect(p).toMatchObject({ ok: true, branch: "sparkle/x" });
  });
});

describe("demotionBriefing", () => {
  it("says the conversation did NOT come across, and tells the agent not to confabulate", () => {
    const t = demotionBriefing({ name: "Widget Builder", branch: "sparkle/agent-42" });
    expect(t).toMatch(/did NOT come with you/);
    expect(t).toMatch(/don't reconstruct a history you don't have/i);
  });

  it("names the agent and the branch, and points at git for re-orientation", () => {
    const t = demotionBriefing({ name: "Widget Builder", branch: "sparkle/agent-42" });
    expect(t).toContain("Widget Builder");
    expect(t).toContain("sparkle/agent-42");
    expect(t).toContain("git log --oneline -20");
  });

  it("states that everything committed in the sandbox IS here, and non-git state is not", () => {
    const t = demotionBriefing({ name: "A", branch: "b" });
    expect(t).toMatch(/Everything you committed there is here/i);
    expect(t).toMatch(/Nothing outside git came across/i);
  });

  it("carries the goal when there is one, and omits the line when there isn't", () => {
    expect(demotionBriefing({ name: "A", branch: "b", goal: "ship it" })).toContain(
      "Your goal, unchanged: ship it",
    );
    expect(demotionBriefing({ name: "A", branch: "b" })).not.toContain("Your goal");
    // Whitespace is not a goal.
    expect(demotionBriefing({ name: "A", branch: "b", goal: "   " })).not.toContain("Your goal");
  });
});
