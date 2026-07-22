import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  shouldRename,
  isSelfNamingAgent,
  shouldHaikuName,
  maybeAutoName,
  namingOutcome,
  isUnpinnedDefaultName,
  isNameFromWorkCandidate,
  workNamingBasis,
  maybeNameFromWork,
  __resetNamingGuards,
  MAX_WORK_BACKSTOP_ATTEMPTS,
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

describe("isSelfNamingAgent (build/worker self-report; shell does not)", () => {
  it("treats the Claude-Code kinds (build, worker) as self-reporting", () => {
    expect(isSelfNamingAgent({ kind: "build" })).toBe(true);
    expect(isSelfNamingAgent({ kind: "worker" })).toBe(true);
  });

  it("does NOT treat shell (raw command) as self-reporting", () => {
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

  it("labels paid_haiku_fallback for exactly the ladder invariant: title yielded, not deferred, shouldRename", () => {
    // NOT a tautology: shouldHaikuName is DEFINED as namingOutcome(...) === "paid_haiku_fallback", so we
    // instead reconstruct the invariant from its independent parts — the two upstream guards (aiTitle /
    // first-turn defer) composed with the public shouldRename heuristic. This catches a divergence in how
    // namingOutcome composes the guards or delegates step 3.
    //
    // The aiTitle guard is no longer "any title blocks forever": a title only holds while it still
    // describes the work, judged by the SAME shouldRename heuristic with the title as the basis (see
    // namingOutcome rung 1 — Claude Code never refreshes the title, so a permanent block froze names).
    // "Login Redirect Fix" overlaps the substantive prompt and still blocks; "Title" does not and yields.
    const kinds: NamingDecisionOpts["kind"][] = ["build", "worker", "shell"];
    const prompts = ["fix the login redirect bug", "yes", "push to production", "ok"];
    for (const kind of kinds) {
      for (const namePinned of [false, true]) {
        for (const aiTitle of [null, "Title", "Login Redirect Fix"]) {
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
                  // Rung 1 only guards while the title is the live name (no autoNameBasis has
                  // superseded it), and it yields exactly when the title stops describing the work.
                  const titleYields =
                    !aiTitle ||
                    Boolean(autoNameBasis) ||
                    shouldRename({ namePinned, autoNameBasis: aiTitle, prompt });
                  const expectedPaid =
                    titleYields && !deferred && shouldRename({ namePinned, autoNameBasis, prompt });
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

  // Claude Code writes its ai-title ONCE, on the first turn, and repeats that same value verbatim
  // for the rest of the session (verified across 58/58 real transcripts). So a stale title must not
  // latch the name forever — when the work moves on, the paid fallback has to be reachable again.
  it("aiTitle that no longer describes the work → DOES call generate_agent_name", async () => {
    seed(
      agentTab({
        kind: "worker",
        aiTitle: "Make YouTube videos full width of page",
        promptHistory: history(3),
      }),
    );
    await maybeAutoName("p1", "a1", "add a live archive count to the dock pill");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useSelfReportMetrics.getState().namingOutcomes.paid_haiku_fallback).toBe(1);
  });

  // The other half of the seenAiTitle contract: the rename is allowed past the title it was DECIDED
  // against, but a title that changes mid-flight means the decision was made on stale state and the
  // fresh title must win. Without this the seenAiTitle check would be a pure widening of the guard.
  it("a title that lands mid-flight beats the in-flight rename", async () => {
    seed(
      agentTab({
        kind: "worker",
        aiTitle: "Make YouTube videos full width of page",
        promptHistory: history(3),
      }),
    );
    // The naming call resolves only AFTER the title poll applied a different title.
    invoke.mockImplementation(async () => {
      useProjectStore.getState().applyAiTitle("p1", "a1", "A Newer Session Title");
      return { title: "Dock Archive Count", description: "" };
    });
    await maybeAutoName("p1", "a1", "add a live archive count to the dock pill");
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "a1")!;
    expect(agent.name).toBe("A Newer Session Title"); // the fresh title, not the stale guess
  });

  it("a diverged-work rename actually lands over the stale aiTitle", async () => {
    invoke.mockResolvedValue({ title: "Dock Archive Count", description: "" });
    seed(
      agentTab({
        kind: "worker",
        aiTitle: "Make YouTube videos full width of page",
        promptHistory: history(3),
      }),
    );
    await maybeAutoName("p1", "a1", "add a live archive count to the dock pill");
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "a1")!;
    expect(agent.name).toBe("Dock Archive Count");
    // The title itself is retained so the 30s poll's dedupe keeps re-applying it as a no-op
    // rather than clobbering the fresh name back to the stale title.
    expect(agent.aiTitle).toBe("Make YouTube videos full width of page");
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

// ── Name-from-work fallback (Tier 1 + Tier 2, sparkle name-from-work) ──────────────────────────
// A build/worker that does real work but is only ever handed tactical prompts (or no further composer
// prompts) never leaves its "Build N"/"Worker N" default via the composer path. These tiers run off
// the poll tick to close that gap.

describe("isUnpinnedDefaultName — the kind default pattern", () => {
  it("matches Build N / Worker N", () => {
    expect(isUnpinnedDefaultName("build", "Build 1")).toBe(true);
    expect(isUnpinnedDefaultName("build", "Build 12")).toBe(true);
    expect(isUnpinnedDefaultName("worker", "Worker 3")).toBe(true);
  });
  it("rejects a real (non-default) name", () => {
    expect(isUnpinnedDefaultName("build", "Login redirect fix")).toBe(false);
    expect(isUnpinnedDefaultName("worker", "Worker")).toBe(false); // no number
    expect(isUnpinnedDefaultName("build", "Worker 1")).toBe(false); // wrong-kind label
  });
  it("is never true for non-self-naming kinds (shell has no name-from-work default)", () => {
    expect(isUnpinnedDefaultName("shell", "Shell 1")).toBe(false);
  });
});

describe("isNameFromWorkCandidate — shared eligibility gate for both tiers", () => {
  const base = { kind: "build" as const, name: "Build 1", namePinned: false, worktreePath: "/wt/a1" };
  it("build/worker on unpinned default WITH a worktree is a candidate", () => {
    expect(isNameFromWorkCandidate(base)).toBe(true);
    expect(isNameFromWorkCandidate({ ...base, kind: "worker", name: "Worker 2" })).toBe(true);
  });
  it("SHELL is never a candidate", () => {
    expect(isNameFromWorkCandidate({ ...base, kind: "shell", name: "Shell 1" })).toBe(false);
  });
  it("no worktree → not a candidate (hasn't done real work yet)", () => {
    expect(isNameFromWorkCandidate({ ...base, worktreePath: null })).toBe(false);
  });
  it("pinned / self-named / already-titled → not a candidate", () => {
    expect(isNameFromWorkCandidate({ ...base, namePinned: true })).toBe(false);
    expect(isNameFromWorkCandidate({ ...base, selfNamed: true })).toBe(false);
    expect(isNameFromWorkCandidate({ ...base, aiTitle: "Real Title" })).toBe(false);
  });
  it("a non-default (already renamed) name → not a candidate", () => {
    expect(isNameFromWorkCandidate({ ...base, name: "Wire the control listener" })).toBe(false);
  });
});

describe("workNamingBasis — pick the agent's WORK as naming basis", () => {
  it("picks the FIRST substantive prompt, skipping tactical/thin ones", () => {
    const h = [
      { id: "0", text: "commit and push", at: 0 }, // tactical
      { id: "1", text: "ok continue", at: 0 }, // thin
      { id: "2", text: "refactor the billing webhook handler", at: 0 }, // substantive ✓
      { id: "3", text: "add dark mode toggle", at: 0 },
    ];
    expect(workNamingBasis(h, undefined)).toBe("refactor the billing webhook handler");
  });
  it("falls back to the activity line when every prompt is tactical/thin", () => {
    const h = [{ id: "0", text: "push to prod", at: 0 }, { id: "1", text: "run tests", at: 0 }];
    expect(workNamingBasis(h, "Wiring the payment reconciliation job")).toBe(
      "Wiring the payment reconciliation job",
    );
  });
  it("returns null when there is nothing substantive to name from", () => {
    expect(workNamingBasis([{ id: "0", text: "continue", at: 0 }], undefined)).toBeNull();
    expect(workNamingBasis([], "  ")).toBeNull();
    expect(workNamingBasis(undefined, undefined)).toBeNull();
  });
});

describe("maybeNameFromWork — Tier 2 paid backstop", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ title: "Billing Webhook Refactor", description: "" });
    useSelfReportMetrics.getState().reset();
    __resetNamingGuards();
  });

  // Read the seeded agent's current name from the store (avoids unchecked index access on projects[0]).
  const currentName = (): string | undefined =>
    useProjectStore.getState().projects.find((p) => p.id === "p1")?.agents.find((a) => a.id === "a1")?.name;

  const workAgent = (over: Partial<AgentTab> = {}): AgentTab =>
    agentTab({
      kind: "build",
      name: "Build 1",
      worktreePath: "/wt/a1",
      promptHistory: [{ id: "0", text: "refactor the billing webhook handler", at: 0 }],
      ...over,
    });

  it("eligible build agent (work done, unpinned default, no aiTitle, not self-named) → fires ONCE and applies the name", async () => {
    seed(workAgent());
    await maybeNameFromWork("p1", "a1");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("generate_agent_name", {
      prompt: "refactor the billing webhook handler",
    });
    expect(currentName()).toBe("Billing Webhook Refactor");
    expect(useSelfReportMetrics.getState().namingOutcomes.work_haiku_backstop).toBe(1);
  });

  it("fires AT MOST ONCE per agent across multiple ticks", async () => {
    seed(workAgent());
    await maybeNameFromWork("p1", "a1");
    // Simulate the agent still (somehow) reading as a default across later ticks.
    useProjectStore.setState((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        agents: p.agents.map((a) => ({ ...a, name: "Build 1", aiTitle: null, autoNameBasis: null })),
      })),
    }));
    await maybeNameFromWork("p1", "a1");
    await maybeNameFromWork("p1", "a1");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // Re-aimed (was: "…and is not retried (fire once)"). The no-retry half pinned the bug below; the
  // tally half is real coverage and is kept.
  it("a FAILED call is not tallied as work_haiku_backstop", async () => {
    seed(workAgent());
    invoke.mockRejectedValueOnce(new Error("offline"));
    await maybeNameFromWork("p1", "a1");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(currentName()).toBe("Build 1"); // kept default
    expect(useSelfReportMetrics.getState().namingOutcomes.work_haiku_backstop).toBe(0); // failure ≠ paid win
  });

  it("a TRANSIENT invoke failure leaves the backstop retryable", async () => {
    // The attempt was marked BEFORE the invoke, so ONE transient failure (offline, signed out,
    // keychain locked, proxy 500) permanently burned the agent's single backstop attempt. The Set is
    // module-level and never pruned, so only an app restart recovered — an agent that was briefly
    // offline during its window stayed "Build 4" for the whole session.
    seed(workAgent());
    invoke.mockRejectedValueOnce(new Error("offline"));
    await maybeNameFromWork("p1", "a1");
    expect(currentName()).toBe("Build 1"); // failed, as expected

    invoke.mockResolvedValueOnce({ title: "Stripe Checkout", description: "" });
    await maybeNameFromWork("p1", "a1"); // must be allowed to try again
    expect(currentName()).toBe("Stripe Checkout");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("an EMPTY/malformed result is transient too — the model hiccuped", async () => {
    // Consistent with the throw path: nothing usable was produced, so nothing terminal happened.
    seed(workAgent());
    invoke.mockResolvedValueOnce({ title: "   ", description: "" });
    await maybeNameFromWork("p1", "a1");
    expect(currentName()).toBe("Build 1");

    invoke.mockResolvedValueOnce({ title: "Stripe Checkout", description: "" });
    await maybeNameFromWork("p1", "a1");
    expect(currentName()).toBe("Stripe Checkout");
  });

  it("a SUCCESSFUL backstop is never retried — the paid call fires at most once", async () => {
    seed(workAgent());
    invoke.mockResolvedValueOnce({ title: "First Name", description: "" });
    await maybeNameFromWork("p1", "a1");
    // Simulate the agent still (somehow) reading as an eligible default on a later tick.
    useProjectStore.setState((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        agents: p.agents.map((a) => ({ ...a, name: "Build 1", aiTitle: null, autoNameBasis: null })),
      })),
    }));
    await maybeNameFromWork("p1", "a1");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("bounds retries: a PERSISTENTLY failing backstop stops after MAX_WORK_BACKSTOP_ATTEMPTS", async () => {
    // Retrying transient failures must not become an unbounded PAID loop. naming.rs returns Err for
    // the model's own judgments — a bare SKIP sentinel (naming.rs:229), a conversational reply, or
    // no usable title — so a "throw" is not always free infrastructure failure: it can be a paid
    // call whose verdict is deterministic for a fixed basis. Without a cap, maybeNameFromWork would
    // re-invoke every ~15s tick forever (WORK_BACKSTOP_WINDOW_TICKS is 1) and bill each one.
    seed(workAgent());
    invoke.mockRejectedValue(new Error("naming skipped (operational or low-content prompt)"));
    for (let i = 0; i < MAX_WORK_BACKSTOP_ATTEMPTS + 3; i++) await maybeNameFromWork("p1", "a1");
    expect(invoke).toHaveBeenCalledTimes(MAX_WORK_BACKSTOP_ATTEMPTS);
    expect(currentName()).toBe("Build 1");
  });

  it("bounds retries on the EMPTY-result path too — an empty title is a paid call", async () => {
    seed(workAgent());
    invoke.mockResolvedValue({ title: "  ", description: "" });
    for (let i = 0; i < MAX_WORK_BACKSTOP_ATTEMPTS + 3; i++) await maybeNameFromWork("p1", "a1");
    expect(invoke).toHaveBeenCalledTimes(MAX_WORK_BACKSTOP_ATTEMPTS);
  });

  it("a SUCCESS resets nothing but ends it — failures before a success don't burn the win", async () => {
    // The realistic transient case the retry exists for: fail once, then succeed on the next tick.
    seed(workAgent());
    invoke.mockRejectedValueOnce(new Error("offline"));
    await maybeNameFromWork("p1", "a1");
    invoke.mockResolvedValueOnce({ title: "Stripe Checkout", description: "" });
    await maybeNameFromWork("p1", "a1");
    await maybeNameFromWork("p1", "a1"); // terminal now — no third call
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(currentName()).toBe("Stripe Checkout");
  });

  // NOTE: markTerminal()'s pruning of the failure counter is deliberately NOT tested. The property
  // is structural, not behavioral — the fire-once Set short-circuits before the counter is ever read
  // again, so a stale entry has no observable effect through the public API. Pinning it would need a
  // test-only inspector of module internals, which the neighbouring workBackstopAttempted Set (whose
  // same session-bounded footprint was accepted in review 36146) doesn't have either. One helper,
  // three call sites, no drift to observe.

  it("a no-basis skip is never retried — that outcome is terminal, not transient", async () => {
    // All-tactical prompts + no activity → re-scanning a later tick would find the same nothing.
    seed(workAgent({ promptHistory: [{ id: "0", text: "commit and push", at: 0 }], activity: undefined }));
    await maybeNameFromWork("p1", "a1");
    await maybeNameFromWork("p1", "a1");
    expect(invoke).not.toHaveBeenCalled();
    expect(useSelfReportMetrics.getState().namingOutcomes.work_backstop_skipped).toBe(1);
  });

  it("PINNED agent → no backstop", async () => {
    seed(workAgent({ namePinned: true }));
    await maybeNameFromWork("p1", "a1");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("SELF-NAMED agent → no backstop", async () => {
    seed(workAgent({ selfNamed: true }));
    await maybeNameFromWork("p1", "a1");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("agent WITH aiTitle → no Haiku call (aiTitle already won)", async () => {
    seed(workAgent({ aiTitle: "Session Title Wins" }));
    await maybeNameFromWork("p1", "a1");
    expect(invoke).not.toHaveBeenCalled();
    expect(currentName()).toBe("Build 1");
  });

  it("SHELL on a default name → NOT eligible", async () => {
    seed(workAgent({ kind: "shell", name: "Shell 1" }));
    await maybeNameFromWork("p1", "a1");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("no worktree (no real work yet) → NOT eligible", async () => {
    seed(workAgent({ worktreePath: null }));
    await maybeNameFromWork("p1", "a1");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("no substantive basis (all prompts tactical, no activity) → skips, keeps default, tallies work_backstop_skipped", async () => {
    seed(workAgent({ promptHistory: [{ id: "0", text: "commit and push", at: 0 }], activity: undefined }));
    await maybeNameFromWork("p1", "a1");
    expect(invoke).not.toHaveBeenCalled();
    expect(currentName()).toBe("Build 1");
    expect(useSelfReportMetrics.getState().namingOutcomes.work_backstop_skipped).toBe(1);
  });

  it("precedence: a name that becomes namePinned mid-flight is NOT overridden by the backstop", async () => {
    seed(workAgent());
    let resolveInvoke: (v: unknown) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((r) => (resolveInvoke = r)));
    const pending = maybeNameFromWork("p1", "a1");
    // User pins a name while the Haiku call is in flight.
    useProjectStore.setState((s) => ({
      projects: s.projects.map((p) => ({
        ...p,
        agents: p.agents.map((a) => ({ ...a, name: "My Pinned Name", namePinned: true })),
      })),
    }));
    resolveInvoke({ title: "Billing Webhook Refactor", description: "" });
    await pending;
    // autoRenameAgent respects the pin → the backstop name is dropped.
    expect(currentName()).toBe("My Pinned Name");
  });
});
