// THE LADDER'S TERMINUS (sparkle-4cd0x). `apiRecoveryRunner.test.ts` injects its own `ReviveDeps`,
// so it exercises the sweep's LOGIC and never `liveDeps` — the production wiring. That is exactly
// where the hole was: `onEscalate` was a no-op for the whole life of the feature, with 54 tests
// green over it, because no test ever called the real one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUDGET_SPENT_REASON } from "../engine/apiRecovery";
import { liveDeps } from "./apiRecoveryRunner";
import {
  _resetConciergeNotifierForTests,
  setConciergeNotifier,
} from "./conciergeNotifier";
import { useProjectStore } from "../stores/projectStore";
import type { AgentTab, Project } from "../types";

vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

function seedAgent(id: string, name: string) {
  const agent = {
    id,
    name,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: true,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  } as unknown as AgentTab;
  const project = {
    id: "p1",
    name: "P1",
    rootPath: "/p1",
    defaultBranch: "main",
    createdAt: "",
    agents: [agent],
    selectedAgentId: null,
  } as Project;
  useProjectStore.setState({ projects: [project], selectedProjectId: "p1" });
}

const episode = (attempts: number) => ({
  erroredSince: 1_000,
  attempts,
  lastPingAt: 2_000,
  failure: "retryable" as const,
  escalated: false,
});

let told: string[];

beforeEach(() => {
  told = [];
  _resetConciergeNotifierForTests();
  setConciergeNotifier((t) => told.push(t));
  seedAgent("a1", "Mount Tells The Truth");
});
afterEach(() => _resetConciergeNotifierForTests());

describe("giving up on an agent tells the concierge", () => {
  it("reports the exhaustion — the ONE event nothing else announces", () => {
    // Every existing channel fires when the row TURNS red: a change in the needs-you digest. Giving
    // up arrives up to 1h27m later and moves no digest at all, because the row has been red the
    // whole time. That is the founder's case verbatim — an agent that died on a 529 and "has sat
    // errored ever since", with the ladder having run and quit hours before anyone looked.
    liveDeps(9_000).onEscalate("a1", BUDGET_SPENT_REASON, episode(11));

    expect(told).toHaveLength(1);
    expect(told[0]).toContain("Mount Tells The Truth");
    // Alive, and said so: exhaustion escalates AFTER the liveness gates (roborev 57783).
    expect(told[0]).toContain("is still running but keeps failing");
    expect(told[0]).toContain("11 times");
    expect(told[0]).toContain("restart it or take its branch over");
  });

  it("quotes the reason the ladder gave, rather than inventing one", () => {
    liveDeps(9_000).onEscalate("a1", BUDGET_SPENT_REASON, episode(11));
    expect(told[0]).toContain(BUDGET_SPENT_REASON);
  });

  it("names an unknown agent by id rather than escalating about nobody", () => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    liveDeps(9_000).onEscalate("ghost", "gone", episode(4));
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("ghost");
  });

  // DELETED: "does not reach the FOUNDER" (roborev 57761). It asserted `told[0]` — the CONCIERGE
  // sink — did not match /needs you:/, which observes nothing about the founder-facing channels
  // (system notification, dock badge, needs-you digest) and so could not fail for the regression its
  // title named. It was also one wording change from a false red, since BUDGET_SPENT_REASON already
  // contains "it needs you now". `pusherBlocker.test.ts` pins the routing property properly, at the
  // pure function that decides it: routeSilence never returns `founder` for any input.

  it("does NOT claim a retry count for an account limit, and gives the right remedy", () => {
    // decideRevive answers a terminal account limit with escalate BEFORE any ping arm, so this
    // callback sees attempts === 0. Claiming "retried 0 times and stayed dead" would be false, and
    // "restart it" would be actively wrong — restarting an agent whose limit has not reset just
    // re-fails.
    liveDeps(9_000).onEscalate("a1", "blocked on an ACCOUNT limit", {
      ...episode(0),
      failure: "terminal",
    });

    expect(told).toHaveLength(1);
    expect(told[0]).not.toMatch(/retried \d+ times/);
    // ...and it must not claim the agent is DEAD or tell anyone to restart it (roborev 57773).
    // Terminal escalates BEFORE the liveness gates, so the agent is typically alive and accepting
    // input; restarting it just re-fails until the window resets.
    expect(told[0]).not.toContain("is not running");
    expect(told[0]).toContain("is running but blocked on an account limit");
    expect(told[0]).toContain("DO NOT restart it");
  });

  it("reports the REAL spend on the budget path, where the episode's own count is zero", () => {
    // The budget is charged across PRIOR ladders and is checked before episode.attempts is
    // assigned, so a brand-new episode escalates with attempts === 0 while the ping log holds the
    // real number. Reporting zero would understate the evidence behind the one give-up report the
    // concierge gets.
    liveDeps(9_000).onEscalate("a1", BUDGET_SPENT_REASON, episode(0), 22);
    expect(told[0]).toContain("22 times");
    expect(told[0]).not.toContain("0 times");
  });

  it("survives a window with no concierge listening, without throwing", () => {
    // `notifyConcierge` is false here. There is deliberately nothing to retry — `escalated` has
    // latched, and the Pusher re-observes the standing condition every minute — but it must not
    // take the sweep down with it.
    _resetConciergeNotifierForTests();
    expect(() => liveDeps(9_000).onEscalate("a1", BUDGET_SPENT_REASON, episode(11))).not.toThrow();
  });
});
