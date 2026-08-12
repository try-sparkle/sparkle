// The blocked-prompt grace window, END TO END THROUGH THE FEED.
//
// `engine/blockedPromptGrace.test.ts` owns the rule. This file owns the only thing the founder can
// actually see: `feed.counts.needs_you`, `feed.scopedCounts.needs_you`, and the agent's `band`. A
// test that asserted on a status map would be asserting a PRECONDITION — the map is an input to
// `publishedStatusFor`, and the whole reason the overlay is composed where it is is that the map and
// the count can disagree (a held worker whose red was already copied onto its orchestrator).
//
// EVERY CASE IS PAIRED, and the pairing is the anti-vacuity proof: the identical fleet, the identical
// prompt, built ONCE WITHOUT the ledger and ONCE WITH it. The no-ledger half must count in
// `needs_you` — if it did not, the "with" half would be asserting something that was already true
// before this feature existed, which is this repo's #1 recurring defect.
import { describe, it, expect, beforeEach } from "vitest";
import { buildConciergeFeed, type ConciergeFeedInput } from "./conciergeFeed";
import {
  BLOCKED_PROMPT_GRACE_MS,
  notePromptAnswerOutcome,
  resetPromptGraceLedgerForTests,
  windowPromptGraceLedger,
  type PromptAnswerOutcome,
} from "../engine/blockedPromptGrace";
import type { AgentTab, AgentTabStatus, Project } from "../types";

function agent(id: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id,
    name: id,
    kind: "build",
    parentId: null,
    promptHistory: [],
    runtime: "local",
    worktreePath: null,
    ...over,
  } as AgentTab;
}

function project(id: string, agents: AgentTab[]): Project {
  return {
    id,
    name: `Proj ${id}`,
    rootPath: `/${id}`,
    defaultBranch: "main",
    createdAt: "",
    agents,
    selectedAgentId: null,
  } as Project;
}

/** A permission dialog the automated answerer is about to dispose of. */
const ASK = "Allow `git status`?\n  1. Yes\n  2. No";
/** A different question, so the two cannot share a burned identity. */
const OTHER_ASK = "Allow `rm -rf build/`?\n  1. Yes\n  2. No";

const T0 = 1_700_000_000_000;

/** Build the feed for one `waiting` agent whose ask screen was captured at `capturedAt`.
 *
 *  `withLedger` is THE ONLY DIFFERENCE between the two halves of every pair below. Everything else —
 *  the fleet, the status, the captured text, the clock — is held identical on purpose. */
function feedFor(opts: {
  withLedger: boolean;
  now: number;
  capturedAt?: number;
  screen?: string;
  status?: Record<string, AgentTabStatus>;
  agents?: AgentTab[];
}) {
  const agents = opts.agents ?? [agent("a")];
  const screen = opts.screen ?? ASK;
  const capturedAt = opts.capturedAt ?? T0;
  const input: ConciergeFeedInput = {
    projects: [project("p", agents)],
    status: opts.status ?? { a: "waiting" },
    nowMs: opts.now,
    attentionScreen: { a: screen },
    attentionScreenAt: { a: capturedAt },
    ...(opts.withLedger ? { promptGrace: windowPromptGraceLedger() } : {}),
  };
  return buildConciergeFeed(input);
}

const bandOf = (feed: ReturnType<typeof buildConciergeFeed>, id: string) =>
  feed.projects.flatMap((p) => p.agents).find((a) => a.id === id)?.band;

beforeEach(() => {
  // A burn that survives a case silently decides the next one — the ledger is a window singleton.
  resetPromptGraceLedgerForTests();
});

describe("a drawn prompt inside its grace window", () => {
  it("is NOT counted in needs_you — and the same fleet without the ledger IS", () => {
    // The control half. If this ever goes to 0 the assertion below proves nothing.
    const without = feedFor({ withLedger: false, now: T0 + 1_000 });
    expect(without.counts.needs_you).toBe(1);
    expect(without.scopedCounts.needs_you).toBe(1);
    expect(bandOf(without, "a")).toBe("needs_you");

    resetPromptGraceLedgerForTests();
    const with_ = feedFor({ withLedger: true, now: T0 + 1_000 });
    expect(with_.counts.needs_you).toBe(0);
    expect(with_.scopedCounts.needs_you).toBe(0);
    expect(bandOf(with_, "a")).not.toBe("needs_you");
  });

  it("surfaces the MOMENT the 30s ceiling lapses, with nothing else having changed", () => {
    // One millisecond inside the window: held.
    const inside = feedFor({ withLedger: true, now: T0 + BLOCKED_PROMPT_GRACE_MS - 1 });
    expect(inside.counts.needs_you).toBe(0);

    // …and one millisecond outside it: counted. Same ledger, same episode, same everything but the
    // clock — which is what makes this a test OF THE CEILING rather than of a rebuild.
    const outside = feedFor({ withLedger: true, now: T0 + BLOCKED_PROMPT_GRACE_MS });
    expect(outside.counts.needs_you).toBe(1);
    expect(bandOf(outside, "a")).toBe("needs_you");
  });

  it("is never held at all when no ask screen was captured — no identity, no hold", () => {
    const held = feedFor({ withLedger: true, now: T0 + 1_000, screen: "   \n\n  " });
    expect(held.counts.needs_you).toBe(1);
    expect(bandOf(held, "a")).toBe("needs_you");
  });

  it("measures the ceiling from the CAPTURE, so a prompt older than this window surfaces at once", () => {
    // The pane was drawing this question a full minute before we first looked at it. It has already
    // spent its window; it must not earn a fresh one.
    const feed = feedFor({
      withLedger: true,
      now: T0,
      capturedAt: T0 - (BLOCKED_PROMPT_GRACE_MS + 30_000),
    });
    expect(feed.counts.needs_you).toBe(1);
  });
});

describe("the answerer's outcome ends the hold", () => {
  /** Record an outcome for `a` against the episode that is about to open, then build. */
  const withOutcome = (outcome: PromptAnswerOutcome) => {
    resetPromptGraceLedgerForTests();
    notePromptAnswerOutcome("a", outcome, T0 + 100, windowPromptGraceLedger());
    return feedFor({ withLedger: true, now: T0 + 1_000 });
  };

  it("`declined` surfaces the prompt immediately — declining IS 'the human decides this one'", () => {
    expect(withOutcome("declined").counts.needs_you).toBe(1);
  });

  it("`unreachable` surfaces it immediately — nobody is going to answer this but the founder", () => {
    expect(withOutcome("unreachable").counts.needs_you).toBe(1);
  });

  it("`handled` does NOT — the red clears on its own a beat later (the anti-vacuity pair)", () => {
    // Same ledger, same clock, same prompt: only the outcome differs. Without this half, the two
    // assertions above would pass against a build that ignored the outcome map entirely and simply
    // never held anything.
    expect(withOutcome("handled").counts.needs_you).toBe(0);
  });

  it("ignores an outcome recorded BEFORE this episode opened — it describes a different prompt", () => {
    resetPromptGraceLedgerForTests();
    // An answerer failed on something this agent asked a minute ago. That must not disqualify every
    // later prompt it ever draws.
    notePromptAnswerOutcome("a", "unreachable", T0 - 60_000, windowPromptGraceLedger());
    expect(feedFor({ withLedger: true, now: T0 + 1_000 }).counts.needs_you).toBe(0);
  });
});

describe("THE HEADLINE RULE: the same prompt is never suppressed twice", () => {
  it("counts a re-raised prompt in needs_you ON SIGHT, with no second grace window", () => {
    // 1. The prompt is drawn and held.
    expect(feedFor({ withLedger: true, now: T0 + 1_000 }).counts.needs_you).toBe(0);

    // 2. It leaves the screen (the answerer pressed something, or the pane redrew), which closes the
    //    episode. The agent stays in the fleet so nothing is pruned.
    const gone = feedFor({ withLedger: true, now: T0 + 2_000, status: { a: "working" } });
    expect(gone.counts.needs_you).toBe(0);

    // 3. THE SAME QUESTION comes back, freshly captured. A second hold here is the invisible loop the
    //    burn set exists to prevent: hidden 30s, re-raised, hidden 30s, forever.
    const again = feedFor({ withLedger: true, now: T0 + 3_000, capturedAt: T0 + 2_500 });
    expect(again.counts.needs_you).toBe(1);
    expect(bandOf(again, "a")).toBe("needs_you");
  });

  it("still holds a DIFFERENT question from the same agent — the burn is per prompt, not per agent", () => {
    // The anti-over-reach pair for the case above: if the burn were keyed on the agent alone, this
    // would read 1 and the feature would be dead after one prompt apiece.
    expect(feedFor({ withLedger: true, now: T0 + 1_000 }).counts.needs_you).toBe(0);
    feedFor({ withLedger: true, now: T0 + 2_000, status: { a: "working" } });
    const other = feedFor({
      withLedger: true,
      now: T0 + 3_000,
      capturedAt: T0 + 2_500,
      screen: OTHER_ASK,
    });
    expect(other.counts.needs_you).toBe(0);
  });
});

describe("ORDERING: the hold lands before the worker→orchestrator bubble", () => {
  const worker = agent("a", { kind: "worker", parentId: "o", task: "fix the parser" });
  const orchestrator = agent("o");
  const fleet = [orchestrator, worker];
  const statuses: Record<string, AgentTabStatus> = { a: "waiting", o: "working" };

  it("leaves the ORCHESTRATOR calm too — not wearing a red whose owner is held", () => {
    // Control: the worker's ask is bubbled onto its working orchestrator, so BOTH rows band red.
    const without = feedFor({
      withLedger: false,
      now: T0 + 1_000,
      agents: fleet,
      status: statuses,
    });
    expect(without.counts.needs_you).toBe(2);
    expect(bandOf(without, "a")).toBe("needs_you");
    expect(bandOf(without, "o")).toBe("needs_you");

    resetPromptGraceLedgerForTests();
    // With the hold composed BEFORE `publishedStatusFor`, the red never enters the bubble at all.
    // If the overlay were applied afterwards this would read 1: a calm worker under an orchestrator
    // still carrying a copy of its question — a needs-you row naming an agent that is not asking.
    const with_ = feedFor({ withLedger: true, now: T0 + 1_000, agents: fleet, status: statuses });
    expect(with_.counts.needs_you).toBe(0);
    expect(bandOf(with_, "a")).not.toBe("needs_you");
    expect(bandOf(with_, "o")).toBe("running");
  });

  it("re-reddens BOTH rows when the ceiling lapses", () => {
    feedFor({ withLedger: true, now: T0 + 1_000, agents: fleet, status: statuses });
    const late = feedFor({
      withLedger: true,
      now: T0 + BLOCKED_PROMPT_GRACE_MS,
      agents: fleet,
      status: statuses,
    });
    expect(late.counts.needs_you).toBe(2);
    expect(bandOf(late, "o")).toBe("needs_you");
  });
});
