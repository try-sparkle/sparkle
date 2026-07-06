import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { shouldRename, isSelfNamingAgent, shouldHaikuName, maybeAutoName } from "./agentNaming";
import { useProjectStore } from "../stores/projectStore";
import type { AgentTab, Project } from "../types";

describe("shouldRename heuristic", () => {
  it("names the first substantive prompt", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "fix the login redirect bug" })).toBe(true);
  });

  it("never renames a pinned name", () => {
    expect(shouldRename({ namePinned: true, autoNameBasis: null, prompt: "build a whole new dashboard feature" })).toBe(false);
  });

  it("ignores thin prompts (continue/ok/yes)", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "ok continue" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "yes" })).toBe(false);
  });

  it("does NOT re-name when follow-up work is similar", () => {
    expect(
      shouldRename({
        namePinned: false,
        autoNameBasis: "fix the login redirect bug",
        prompt: "please also fix the login redirect on mobile",
      }),
    ).toBe(false);
  });

  it("re-names when the work clearly shifts", () => {
    expect(
      shouldRename({
        namePinned: false,
        autoNameBasis: "fix the login redirect bug",
        prompt: "now write integration tests for the billing webhook handler",
      }),
    ).toBe(true);
  });

  it("treats minor wording changes of the same request as the same work", () => {
    expect(
      shouldRename({
        namePinned: false,
        autoNameBasis: "add dark mode toggle to settings",
        prompt: "add a dark mode toggle in the settings page",
      }),
    ).toBe(false);
  });
});

describe("shouldRename — tactical command filter", () => {
  it("skips a prompt that is entirely an operational command", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "push to production" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "commit and push" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "merge to main" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "rerun the build" })).toBe(false);
  });

  it("skips ack / filler prompts", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "looks good" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "perfect thanks" })).toBe(false);
  });

  it("still names a substantive prompt that merely contains a tactical word", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "run the onboarding analysis flow" })).toBe(true);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "build the project settings modal" })).toBe(true);
  });

  it("skips build/test/lint chores client-side (matching the model's SKIP examples)", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "run the tests" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "run lint" })).toBe(false);
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "run the typecheck" })).toBe(false);
  });

  it("still names substantive test/build work (tactical word + a real subject)", () => {
    expect(shouldRename({ namePinned: false, autoNameBasis: null, prompt: "write tests for the billing webhook" })).toBe(true);
  });

  it("does not re-name on a tactical follow-up after a real name exists", () => {
    expect(
      shouldRename({
        namePinned: false,
        autoNameBasis: "add dark mode toggle to settings",
        prompt: "push to production",
      }),
    ).toBe(false);
  });
});

describe("isSelfNamingAgent (build/worker self-report; think/shell do not)", () => {
  it("treats the Claude-Code kinds (build, worker) as self-reporting", () => {
    expect(isSelfNamingAgent({ kind: "build" })).toBe(true);
    expect(isSelfNamingAgent({ kind: "worker" })).toBe(true);
  });

  it("does NOT treat think (Chief chat) or shell (raw command) as self-reporting", () => {
    expect(isSelfNamingAgent({ kind: "think" })).toBe(false);
    expect(isSelfNamingAgent({ kind: "shell" })).toBe(false);
  });
});

describe("shouldHaikuName precedence (Phase 2a demotion, sparkle-q1rq)", () => {
  const base = {
    namePinned: false,
    aiTitle: null as string | null,
    autoNameBasis: null as string | null,
    promptCount: 1,
    prompt: "fix the login redirect bug",
  };

  it("self-reporting agent WITH an aiTitle → no Haiku call", () => {
    expect(shouldHaikuName({ ...base, kind: "worker", aiTitle: "Login Redirect Fix", promptCount: 3 })).toBe(false);
    expect(shouldHaikuName({ ...base, kind: "build", aiTitle: "Login Redirect Fix", promptCount: 3 })).toBe(false);
  });

  it("self-reporting agent that self-named (namePinned) → no Haiku call", () => {
    expect(shouldHaikuName({ ...base, kind: "worker", namePinned: true, promptCount: 3 })).toBe(false);
  });

  it("self-reporting agent's FIRST prompt (no aiTitle, not named) → deferred, no Haiku call", () => {
    expect(shouldHaikuName({ ...base, kind: "worker", promptCount: 1 })).toBe(false);
    expect(shouldHaikuName({ ...base, kind: "build", promptCount: 1 })).toBe(false);
  });

  it("self-reporting agent falls back to Haiku on a LATER prompt (>=2) when still unnamed & untitled", () => {
    expect(shouldHaikuName({ ...base, kind: "worker", promptCount: 2 })).toBe(true);
    expect(shouldHaikuName({ ...base, kind: "build", promptCount: 2 })).toBe(true);
  });

  it("bypassFirstTurnDefer lets a worker's spawn-time naming fire at promptCount 0 (its one naming moment)", () => {
    // Regression guard (roborev Medium): a worker is named once at spawn with an empty promptHistory;
    // without the bypass the first-turn deferral would swallow it and it would stay "Worker N".
    expect(shouldHaikuName({ ...base, kind: "worker", promptCount: 0 })).toBe(false);
    expect(shouldHaikuName({ ...base, kind: "worker", promptCount: 0, bypassFirstTurnDefer: true })).toBe(true);
    // Bypass still yields to a real name/title: aiTitle and pinned continue to win.
    expect(
      shouldHaikuName({ ...base, kind: "worker", promptCount: 0, bypassFirstTurnDefer: true, aiTitle: "Login Fix" }),
    ).toBe(false);
    expect(
      shouldHaikuName({ ...base, kind: "worker", promptCount: 0, bypassFirstTurnDefer: true, namePinned: true }),
    ).toBe(false);
  });

  it("non-self-reporting agent (shell) → Haiku on the first prompt, exactly as before", () => {
    expect(shouldHaikuName({ ...base, kind: "shell", promptCount: 1 })).toBe(true);
  });

  it("still honors the thin/tactical prompt skips even for a fallback-eligible self-reporting agent", () => {
    expect(shouldHaikuName({ ...base, kind: "worker", promptCount: 2, prompt: "push to production" })).toBe(false);
    expect(shouldHaikuName({ ...base, kind: "shell", prompt: "ok continue" })).toBe(false);
  });
});

// ── maybeAutoName end-to-end: does the paid `generate_agent_name` invoke fire or not? ──
function agentTab(over: Partial<AgentTab>): AgentTab {
  return {
    id: "a1",
    name: "Worker 1",
    kind: "worker",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
    pinnedIndex: null,
    ...over,
  };
}

function seed(agent: AgentTab): void {
  const project: Project = {
    id: "p1",
    name: "Proj",
    rootPath: "/tmp/p",
    defaultBranch: "main",
    createdAt: "2026-01-01",
    agents: [agent],
    selectedAgentId: agent.id,
  };
  useProjectStore.setState({ projects: [project] });
}

// promptHistory entries: naming reads only `.length`, so ids/text are placeholders.
function history(n: number): AgentTab["promptHistory"] {
  return Array.from({ length: n }, (_, i) => ({ id: `h${i}`, text: `p${i}`, at: 0 }));
}

describe("maybeAutoName — paid call gating for self-reporting agents", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ title: "Some Name", description: "" });
  });

  it("self-reporting worker WITH aiTitle → does NOT call generate_agent_name", async () => {
    seed(agentTab({ kind: "worker", aiTitle: "Login Redirect Fix", promptHistory: history(3) }));
    await maybeAutoName("p1", "a1", "fix the login redirect bug");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("self-reporting worker that self-named (namePinned) → does NOT call generate_agent_name", async () => {
    seed(agentTab({ kind: "worker", namePinned: true, promptHistory: history(3) }));
    await maybeAutoName("p1", "a1", "fix the login redirect bug");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("self-reporting worker on its FIRST prompt (neither self-named nor titled) → deferred, no call", async () => {
    seed(agentTab({ kind: "worker", promptHistory: history(1) }));
    await maybeAutoName("p1", "a1", "fix the login redirect bug");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("self-reporting worker on a LATER prompt with neither signal → falls back to Haiku", async () => {
    seed(agentTab({ kind: "worker", promptHistory: history(2) }));
    await maybeAutoName("p1", "a1", "fix the login redirect bug");
    expect(invoke).toHaveBeenCalledWith("generate_agent_name", { prompt: "fix the login redirect bug" });
  });

  it("non-self-reporting shell agent → Haiku on the first prompt, as before", async () => {
    seed(agentTab({ kind: "shell", promptHistory: history(1) }));
    await maybeAutoName("p1", "a1", "fix the login redirect bug");
    expect(invoke).toHaveBeenCalledWith("generate_agent_name", { prompt: "fix the login redirect bug" });
  });
});
