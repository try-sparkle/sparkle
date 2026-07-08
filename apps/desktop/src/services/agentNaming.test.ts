import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  shouldRename,
  isSelfNamingAgent,
  shouldHaikuName,
  maybeAutoName,
  namingOutcome,
  type NamingDecisionOpts,
} from "./agentNaming";
import { useProjectStore } from "../stores/projectStore";
import { useSelfReportMetrics } from "../stores/selfReportMetrics";
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

describe("namingOutcome — labels the branch (Phase 2c observation, sparkle-rl84)", () => {
  const base: NamingDecisionOpts = {
    kind: "worker",
    namePinned: false,
    aiTitle: null,
    autoNameBasis: null,
    promptCount: 2, // past the first-turn defer by default, so non-defer branches are reachable
    prompt: "fix the login redirect bug",
  };

  it("ai_title — a Claude Code session title wins outright", () => {
    expect(namingOutcome({ ...base, aiTitle: "Login Redirect Fix" })).toBe("ai_title");
  });

  it("deferred_first_turn — a self-reporting agent's first prompt", () => {
    expect(namingOutcome({ ...base, kind: "worker", promptCount: 1 })).toBe("deferred_first_turn");
    expect(namingOutcome({ ...base, kind: "build", promptCount: 1 })).toBe("deferred_first_turn");
  });

  it("self_named — the agent (or user) pinned its own name", () => {
    expect(namingOutcome({ ...base, namePinned: true })).toBe("self_named");
  });

  it("skipped_thin — too-thin, tactical-only, or unchanged work", () => {
    expect(namingOutcome({ ...base, prompt: "yes" })).toBe("skipped_thin"); // < 2 content words
    expect(namingOutcome({ ...base, prompt: "push to production" })).toBe("skipped_thin"); // tactical
    expect(
      namingOutcome({
        ...base,
        autoNameBasis: "fix the login redirect bug",
        prompt: "please also fix the login redirect on mobile",
      }),
    ).toBe("skipped_thin"); // work hasn't shifted
  });

  it("paid_haiku_fallback — a substantive prompt that actually earns a call", () => {
    expect(namingOutcome({ ...base, promptCount: 2 })).toBe("paid_haiku_fallback"); // later prompt, no signals
    expect(namingOutcome({ ...base, kind: "shell", promptCount: 1 })).toBe("paid_haiku_fallback");
    expect(
      namingOutcome({ ...base, kind: "worker", promptCount: 0, bypassFirstTurnDefer: true }),
    ).toBe("paid_haiku_fallback"); // worker spawn-time one-shot
  });

  it("labels paid_haiku_fallback for exactly the ladder invariant: no aiTitle, not deferred, shouldRename", () => {
    // NOT a tautology: shouldHaikuName is DEFINED as namingOutcome(...) === "paid_haiku_fallback", so we
    // instead reconstruct the invariant from its independent parts — the two upstream guards (aiTitle /
    // first-turn defer) composed with the public shouldRename heuristic. This catches a divergence in how
    // namingOutcome composes the guards or delegates step 3.
    const kinds: NamingDecisionOpts["kind"][] = ["build", "worker", "think", "shell"];
    const prompts = ["fix the login redirect bug", "yes", "push to production", "ok"];
    for (const kind of kinds) {
      for (const namePinned of [false, true]) {
        for (const aiTitle of [null, "Title"]) {
          for (const autoNameBasis of [null, "add dark mode toggle"]) {
            for (const promptCount of [0, 1, 2, 3]) {
              for (const bypassFirstTurnDefer of [false, true]) {
                for (const prompt of prompts) {
                  const opts: NamingDecisionOpts = {
                    kind,
                    namePinned,
                    aiTitle,
                    autoNameBasis,
                    promptCount,
                    prompt,
                    bypassFirstTurnDefer,
                  };
                  const deferred =
                    !bypassFirstTurnDefer && isSelfNamingAgent({ kind }) && promptCount < 2;
                  const expectedPaid =
                    !aiTitle && !deferred && shouldRename({ namePinned, autoNameBasis, prompt });
                  expect(namingOutcome(opts) === "paid_haiku_fallback").toBe(expectedPaid);
                  // And shouldHaikuName stays wired to the same verdict.
                  expect(shouldHaikuName(opts)).toBe(expectedPaid);
                }
              }
            }
          }
        }
      }
    }
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
    useSelfReportMetrics.getState().reset();
  });

  it("tallies the deferred outcome when a first-prompt self-reporting agent is deferred", async () => {
    seed(agentTab({ kind: "worker", promptHistory: history(1) }));
    await maybeAutoName("p1", "a1", "fix the login redirect bug");
    expect(useSelfReportMetrics.getState().namingOutcomes.deferred_first_turn).toBe(1);
    expect(useSelfReportMetrics.getState().namingOutcomes.paid_haiku_fallback).toBe(0);
  });

  it("tallies the paid_haiku_fallback outcome exactly once when it actually invokes", async () => {
    seed(agentTab({ kind: "worker", promptHistory: history(2) }));
    await maybeAutoName("p1", "a1", "fix the login redirect bug");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useSelfReportMetrics.getState().namingOutcomes.paid_haiku_fallback).toBe(1);
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

// ── The ordering invariant itself (sparkle-y2tv) ──────────────────────────────────────────────
// This suite differs from the ones above: it does NOT hand-seed a promptHistory length. Instead it
// drives the REAL projectStore `appendPrompt` and the REAL `maybeAutoName`, in the SAME order the
// live call site uses (AgentPane.tsx: appendPrompt at :778 → maybeAutoName at :787). The whole point
// is that promptHistory.length must GROW (append) before the naming read runs — that ordering is the
// contract. So we intentionally do not mock projectStore here.
describe("appendPrompt→maybeAutoName ordering invariant (sparkle-y2tv)", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ title: "Some Name", description: "" });
    useSelfReportMetrics.getState().reset();
  });

  const prompt1 = "fix the login redirect bug";
  const prompt2 = "add a CSV export button to the reports page";

  it("append-first ordering: 1st submit defers (promptCount 1), 2nd submit pays (promptCount 2)", async () => {
    // A worker with a genuinely empty history — no self-name, no aiTitle yet.
    seed(agentTab({ kind: "worker", promptHistory: [], namePinned: false, aiTitle: null }));

    // ── First submit ── append BEFORE naming, exactly as AgentPane does.
    useProjectStore.getState().appendPrompt("p1", "a1", prompt1);
    await maybeAutoName("p1", "a1", prompt1);
    // append-first ⇒ promptCount === 1 ⇒ the self-reporting worker gets its turn to self-name: no paid call.
    expect(invoke).not.toHaveBeenCalled();
    expect(useSelfReportMetrics.getState().namingOutcomes.deferred_first_turn).toBe(1);
    expect(useSelfReportMetrics.getState().namingOutcomes.paid_haiku_fallback).toBe(0);

    // ── Second submit ── same agent, still unnamed/untitled. Append BEFORE naming again.
    useProjectStore.getState().appendPrompt("p1", "a1", prompt2);
    await maybeAutoName("p1", "a1", prompt2);
    // append-first ⇒ promptCount === 2 ⇒ past the first-turn defer ⇒ the paid last-resort fallback fires ONCE.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("generate_agent_name", { prompt: prompt2 });
    expect(useSelfReportMetrics.getState().namingOutcomes.paid_haiku_fallback).toBe(1);
  });

  it("negative guard: reversed order (name BEFORE append) mis-defers the 2nd turn — the off-by-one the invariant prevents", async () => {
    // Reproduce the reversed-order bug for what SHOULD be the second turn. In the correct flow the
    // second submit appends prompt2 first (promptHistory.length → 2) and then names → paid fallback.
    // Here we simulate a caller that named BEFORE appending the second prompt: only prompt1 is in
    // history (length 1) when maybeAutoName reads it, so the read is one turn behind. namingOutcome
    // therefore still sees promptCount 1 (< 2) and DEFERS instead of paying — the exact off-by-one
    // that pushes the paid fallback out by a full turn and leaves the worker unnamed longer than
    // designed. This test locks in WHY the append-must-precede-name ordering matters.
    seed(agentTab({ kind: "worker", promptHistory: [], namePinned: false, aiTitle: null }));

    useProjectStore.getState().appendPrompt("p1", "a1", prompt1); // turn 1's prompt is in history…
    // …but for turn 2 we (wrongly) name BEFORE appending prompt2 — the read sees length 1, not 2.
    await maybeAutoName("p1", "a1", prompt2);

    expect(invoke).not.toHaveBeenCalled(); // mis-deferred — no paid call, when the correct order pays.
    expect(useSelfReportMetrics.getState().namingOutcomes.deferred_first_turn).toBe(1);
    expect(useSelfReportMetrics.getState().namingOutcomes.paid_haiku_fallback).toBe(0);
  });
});
