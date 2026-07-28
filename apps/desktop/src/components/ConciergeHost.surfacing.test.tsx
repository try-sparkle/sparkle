// @vitest-environment jsdom
// NOTHING RED FALLS THROUGH THE FLOOR, and column one states ONE number.
//
// `ConciergeHost.surfacedAgents` gained a `topLevel` gate so the digest's count equals the rows its
// click leaves standing (see ConciergeHost.digestFilter.test.tsx — that invariant is the founder's
// headline ask and is NOT relaxed here). But `isTopLevelAgent` excludes every worker
// unconditionally, and a worker's red only reaches the user by BUBBLING to its orchestrator — which
// `withRedWorkerAttention` does not always do. An agent in that gap had no row, no card, no digest
// line and no count: invisible everywhere in the app.
//
// THE GAP, established from the code rather than guessed at (engine/workerAttention.ts):
//   1. `parentId === null`      — the loop skips it outright, so nothing ever inherits its red.
//   2. parent NOT in the fleet  — the bubble is written to a status-map key with no agent behind
//                                 it, so the feed drops it on the floor.
//   3. IN-MOTION SUPPRESSION    — a `blocked` worker under an orchestrator that is still moving is
//                                 deliberately not bubbled. That was harmless while the worker
//                                 surfaced on its own; with the `topLevel` gate it is silence.
// Workers are the ONLY population that can land here: no production path gives a non-worker a
// `parentId` (cloud agents are `kind: "build"`, shell agents are parentless), which is why the
// fixtures below are all workers.
//
// THE SECOND HALF, same root cause: `feed.scopedCounts` counted every un-muted in-scope agent, so a
// red worker AND the orchestrator that inherited its red were counted twice for one piece of work —
// the vitals line said "2 Need you" over a thread holding one card.
//
// The rule that closes both: an agent is REPRESENTED ELSEWHERE when a present ancestor already
// carries its band. Represented → counted once, at the row. Not represented → it surfaces itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(),
  setInterruptPreference: vi.fn(),
}));
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));
vi.mock("../services/concierge", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/concierge")>();
  return {
    SUPERSEDED_DETAILS: real.SUPERSEDED_DETAILS,
    isSupersededDetail: real.isSupersededDetail,
    startConciergeTurn: vi.fn(async () => null),
    onConciergeDelta: () => () => {},
    onConciergeDone: () => () => {},
    onConciergeError: () => () => {},
  };
});
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true })),
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: vi.fn(() => true),
  liveOptionsFor: vi.fn(() => []),
  isTerseAnswer: vi.fn(() => false),
  matchAnswerToOption: vi.fn(() => null),
  onDeferredSendOutcome: () => () => {},
}));
vi.mock("../services/conciergeRouter", () => ({
  routeMessage: vi.fn(async () => ({
    target: "sparkle" as const,
    reason: "test",
    source: "heuristic" as const,
  })),
}));
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({
    micLive: false,
    interim: "",
    toggleMic: vi.fn(),
    registerInsert: vi.fn(),
  }),
}));
vi.mock("../services/dictationControls", () => ({ maybePauseOnSubmit: vi.fn() }));
vi.mock("../stores/sparklePrefsStore", () => ({
  useSparklePrefsStore: { getState: () => ({ setInterruptPreference: h.setInterruptPreference }) },
}));

import { ConciergeHost } from "./ConciergeHost";
import { useUiStore } from "../stores/uiStore";
import { buildConciergeFeed } from "../services/conciergeFeed";
import { bandCountLabel } from "../engine/statusBandLabels";
import type { AgentTab, AgentTabStatus, Project } from "../types";

const tab = (id: string, over: Partial<AgentTab> = {}): AgentTab =>
  ({
    id,
    name: id,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    ...over,
  }) as AgentTab;

const worker = (id: string, parentId: string | null): AgentTab =>
  tab(id, { kind: "worker", parentId });

const projectOf = (id: string, name: string, agents: AgentTab[]): Project =>
  ({
    id,
    name,
    rootPath: `/${id}`,
    defaultBranch: "main",
    createdAt: "",
    agents,
    selectedAgentId: null,
  }) as Project;

/** Everything live, so the unstarted-worker overlay (which invents an `approval` for a worker with
 *  NO status) can't fire and manufacture the very reds these cases are about. */
const openIds = (projects: Project[]) => projects.flatMap((p) => p.agents.map((a) => a.id));

const feedFrom = (projects: Project[], status: Record<string, AgentTabStatus>) =>
  buildConciergeFeed({ projects, status, openAgentIds: openIds(projects) });

/** The nudge cards on screen, by the agent name each one names. NudgeCard renders
 *  "<statusLabel> — <name> in <project>." — see ConciergeHost.agentToNudge. */
const cardNames = (): string[] =>
  screen
    .queryAllByText(/ — .+ in .+\.$/)
    .map((el) => /— (.+) in /.exec(el.textContent!)![1]!);

/** Every item column one accounts for: the cards, plus each digest line's stated count — BOTH
 *  variants of line, since a rowless line stands for its agents just as a row-promising one does.
 *  This is the thread's own arithmetic, read off the DOM; missing a surface here would let the
 *  thread silently under-account for exactly the population these tests are about. */
const threadTotal = (): number =>
  cardNames().length +
  [
    ...screen.queryAllByTestId("concierge-digest"),
    ...screen.queryAllByTestId("concierge-rowless-digest"),
  ].reduce((n, el) => n + Number(/^(\d+) /.exec(el.textContent!)![1]), 0);

beforeEach(() => {
  useUiStore.getState().showAllStatusBands();
  // uiStore is a module singleton, so expansion LEAKS between cases: a test that clicks a rowless
  // line leaves that head expanded, and the next one asserting "starts collapsed" then reads a
  // state its own fixture never set. Cleared rather than worked around with distinct ids, because
  // "absent → collapsed" is the production default these cases are about.
  useUiStore.setState({ collapsedOrchestrators: {} });
  h.openProjectTab.mockClear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("no red agent falls through the floor", () => {
  // GAP 3 — the one that actually happens in a live fleet. `blocked` is red but is not an ASK, so
  // withRedWorkerAttention suppresses its bubble while the orchestrator is still moving. The
  // orchestrator therefore bands `running`, not `needs_you`: the click's filter would hide it, and
  // before this fix the worker had nothing of its own either.
  it("surfaces a blocked worker whose orchestrator is in motion and so never inherited its red", () => {
    const p = projectOf("p1", "web", [tab("orch"), worker("w1", "orch")]);
    const status: Record<string, AgentTabStatus> = { orch: "working", w1: "blocked" };
    const feed = feedFrom([p], status);
    // The premise, asserted rather than assumed: the bubble really did not happen.
    const byId = Object.fromEntries(feed.projects[0]!.agents.map((a) => [a.id, a]));
    expect(byId["orch"]!.band).toBe("running");
    expect(byId["w1"]!.band).toBe("needs_you");
    expect(byId["w1"]!.topLevel).toBe(false);

    render(<ConciergeHost feed={feed} />);
    expect(cardNames()).toEqual(["w1"]);
  });

  // GAP 1 — a worker with no parent at all. withRedWorkerAttention skips it on the first line, so
  // there is no orchestrator anywhere that could speak for it.
  it("surfaces a parentless worker", () => {
    const p = projectOf("p1", "web", [tab("calm"), worker("w1", null)]);
    const feed = feedFrom([p], { calm: "idle", w1: "waiting" });
    render(<ConciergeHost feed={feed} />);
    expect(cardNames()).toEqual(["w1"]);
  });

  // GAP 2 — the founder's original failure case, from the other side. The bubble IS written, but to
  // a status-map key with no agent behind it, so the feed drops it. Previously: two workers red,
  // "2 Need you in web" and an empty column; then, after the topLevel gate, total silence.
  //
  // TWO of them, and they surface as TWO CARDS — not as one rowless line. These have no row
  // ANYWHERE (no head of their own, and no present parent to nest under), so a card apiece is the
  // only thing that keeps both reachable: a line can reveal exactly one agent, and its "2" would
  // have promised an affordance for a second one that did not exist (roborev 53679). The line is
  // still right for workers that DO get a nested row — see the gap-3 case below.
  it("surfaces workers whose orchestrator is not in the fleet at all", () => {
    const p = projectOf("p1", "web", [
      tab("calm"),
      worker("w1", "elsewhere"),
      worker("w2", "elsewhere"),
    ]);
    const feed = feedFrom([p], { calm: "idle", w1: "blocked", w2: "blocked" });
    render(<ConciergeHost feed={feed} />);
    expect(cardNames()).toEqual(["w1", "w2"]);
    expect(screen.queryByTestId("concierge-rowless-digest")).toBeNull();
    // Nothing fell through, and every one of them can be acted on.
    expect(threadTotal()).toBe(2);
  });

  // GAP 3 — the high-volume case, and the one the rowless LINE is actually for. The orchestrator IS
  // present; it is merely in motion, so `withRedWorkerAttention` suppresses the bubble. Each of its
  // blocked workers used to be a card, which is the card wall the digest exists to prevent.
  //
  // Collapsing these is honest in a way collapsing the ancestor-less ones is not — but NOT because
  // the reveal happens to land well. That was the original claim here and it was wrong: a missing
  // `collapsedOrchestrators` entry reads as collapsed, so the default is a shut subtree. What makes
  // them collapsible is having a HEAD the click can name and open; the click then does the opening
  // itself (`showAllStatusBands` + `expandOrchestrators`), which the case below this one pins.
  // See ConciergeHost.strandedAgents / revealAgent, and conciergeFeed.parentRowId.
  it("still collapses workers that DO get a nested row under a present orchestrator", () => {
    const p = projectOf("p1", "web", [
      tab("orch"),
      worker("w1", "orch"),
      worker("w2", "orch"),
      worker("w3", "orch"),
    ]);
    // `orch` is WORKING, so it bands `running` and does not represent its blocked workers — the
    // in-motion suppression this gap is made of. Its row is on screen all the same.
    const feed = feedFrom([p], { orch: "working", w1: "blocked", w2: "blocked", w3: "blocked" });
    render(<ConciergeHost feed={feed} />);
    expect(cardNames()).toEqual([]);
    expect(screen.getByTestId("concierge-rowless-digest").textContent).toBe(
      "3 workers inside web need you",
    );
    expect(threadTotal()).toBe(3);
  });

  // THE PREMISE, not the sentence (roborev 53734). "Reveal the lead and the siblings render beside
  // it" is only true if the head is actually DRAWN and EXPANDED, and neither is the default:
  // `isOrchestratorCollapsed` reads a missing entry as collapsed, and a prior rows-variant digest
  // click leaves `running` filtered off — which is exactly the band an in-motion orchestrator sits
  // in. Asserting the line's text would have passed through both bugs, so assert the state the
  // reveal depends on instead.
  it("clicking a rowless line expands the head and un-hides its band, so the group can be seen", () => {
    const p = projectOf("p1", "web", [tab("orch"), worker("w1", "orch"), worker("w2", "orch")]);
    const feed = feedFrom([p], { orch: "working", w1: "blocked", w2: "blocked" });
    // The hostile-but-ordinary starting state: the head's band is filtered out and its subtree has
    // never been expanded (no entry at all — which uiStore reads as collapsed).
    useUiStore.getState().isolateStatusBand("needs_you");
    expect(useUiStore.getState().isOrchestratorCollapsed("orch")).toBe(true);
    expect(useUiStore.getState().statusFilter.running).toBe(false);

    render(<ConciergeHost feed={feed} />);
    fireEvent.click(screen.getByTestId("concierge-rowless-digest"));

    // The head is now drawn AND open, which is what makes the line's "2" deliverable.
    expect(useUiStore.getState().isOrchestratorCollapsed("orch")).toBe(false);
    expect(useUiStore.getState().statusFilter.running).toBe(true);
    // And it still reveals — expanding replaces nothing.
    expect(h.openProjectTab).toHaveBeenCalledWith("p1", "w1");
  });

  // The OTHER way one line could out-promise one click: same project, same band, DIFFERENT heads.
  // One line still, because splitting it per head rebuilds the card wall (see the next case) — so
  // the click's reach is what widens instead: it expands every head the line names.
  it("keeps workers under different orchestrators on ONE line, and opens every subtree it names", () => {
    const p = projectOf("p1", "web", [
      tab("orchA"),
      tab("orchB"),
      worker("a1", "orchA"),
      worker("a2", "orchA"),
      worker("b1", "orchB"),
      worker("b2", "orchB"),
    ]);
    const feed = feedFrom([p], {
      orchA: "working",
      orchB: "working",
      a1: "blocked",
      a2: "blocked",
      b1: "blocked",
      b2: "blocked",
    });
    render(<ConciergeHost feed={feed} />);
    const lines = screen.queryAllByTestId("concierge-rowless-digest");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe("4 workers inside web need you");

    fireEvent.click(lines[0]!);

    // BOTH heads, not just the lead's — the count is only deliverable if every subtree opens.
    expect(useUiStore.getState().isOrchestratorCollapsed("orchA")).toBe(false);
    expect(useUiStore.getState().isOrchestratorCollapsed("orchB")).toBe(false);
    expect(cardNames()).toEqual([]);
    expect(threadTotal()).toBe(4);
  });

  // THE CARD WALL, in the shape that actually occurs (roborev 53737). Keying rowless buckets by head
  // made every line honest, and fragmented this fleet — several in-motion orchestrators with ONE
  // blocked worker each — into a bucket apiece. A bucket of one is a card, so the module built to
  // prevent the wall rebuilt it. The count is what a line may promise; the fix belongs on the
  // click's reach, not on the grouping.
  it("collapses one-blocked-worker-per-orchestrator into a line, not a card each", () => {
    const p = projectOf("p1", "web", [
      tab("orchA"),
      tab("orchB"),
      tab("orchC"),
      worker("a1", "orchA"),
      worker("b1", "orchB"),
      worker("c1", "orchC"),
    ]);
    const feed = feedFrom([p], {
      orchA: "working",
      orchB: "working",
      orchC: "working",
      a1: "blocked",
      b1: "blocked",
      c1: "blocked",
    });
    render(<ConciergeHost feed={feed} />);
    expect(screen.getByTestId("concierge-rowless-digest").textContent).toBe(
      "3 workers inside web need you",
    );
    expect(cardNames()).toEqual([]);
    expect(threadTotal()).toBe(3);
  });

  // The SINGLETON path, which the digest line's fix did not cover. One blocked worker keeps a card,
  // and its card click used a bare `openProjectTab` — hitting the very collapse/filter gates the
  // line's click had just learned to enforce. The contract belongs with the population, so it lives
  // in `revealAgent` and every affordance uses it.
  it("a nested agent's CARD click expands its head and un-hides its band too", () => {
    const p = projectOf("p1", "web", [tab("orch"), worker("w1", "orch")]);
    const feed = feedFrom([p], { orch: "working", w1: "blocked" });
    useUiStore.getState().isolateStatusBand("needs_you");
    expect(useUiStore.getState().isOrchestratorCollapsed("orch")).toBe(true);

    render(<ConciergeHost feed={feed} />);
    // A singleton, so it is a card rather than a line — that is the point of this case.
    expect(cardNames()).toEqual(["w1"]);
    fireEvent.click(screen.getByText(/ — w1 in web\.$/));

    expect(useUiStore.getState().isOrchestratorCollapsed("orch")).toBe(false);
    expect(useUiStore.getState().statusFilter.running).toBe(true);
    expect(h.openProjectTab).toHaveBeenCalledWith("p1", "w1");
  });

  // ...and the other direction, which is what keeps the fix from double-speaking: when the bubble
  // DID land, the orchestrator's row already says it. Surfacing the worker too would put the same
  // piece of work in the column twice.
  it("does NOT surface a worker whose red already reached its orchestrator", () => {
    const p = projectOf("p1", "web", [tab("orch"), worker("w1", "orch"), worker("w2", "orch")]);
    const feed = feedFrom([p], { orch: "idle", w1: "blocked", w2: "blocked" });
    const byId = Object.fromEntries(feed.projects[0]!.agents.map((a) => [a.id, a]));
    expect(byId["orch"]!.band).toBe("needs_you"); // the bubble landed
    render(<ConciergeHost feed={feed} />);
    // One card, for the ROW that carries the red — not three.
    expect(cardNames()).toEqual(["orch"]);
  });

  // A worker in a band the concierge does not interrupt on must not be dragged in by the fix.
  it("leaves a working worker alone — the gap is about RED, not about workers", () => {
    const p = projectOf("p1", "web", [tab("orch"), worker("w1", "orch")]);
    const feed = feedFrom([p], { orch: "idle", w1: "working" });
    render(<ConciergeHost feed={feed} />);
    expect(cardNames()).toEqual([]);
  });

  // Mute still means mute: an un-representable worker the user silenced stays silent.
  it("honors a mute on a worker that would otherwise surface", () => {
    const p = projectOf("p1", "web", [tab("orch"), worker("w1", "orch")]);
    const feed = buildConciergeFeed({
      projects: [p],
      status: { orch: "working", w1: "blocked" },
      openAgentIds: openIds([p]),
      shouldInterrupt: (topic) => topic !== "w1",
    });
    render(<ConciergeHost feed={feed} />);
    expect(cardNames()).toEqual([]);
  });
});

describe("column one states ONE number", () => {
  /** The vitals line's "N Need you", read off the rendered header. */
  const vitalsNeedsYou = (): number => {
    for (let n = 0; n <= 40; n++) {
      if (screen.queryByText(bandCountLabel("needs_you", n))) return n;
    }
    throw new Error("no needs_you vitals part rendered");
  };

  // The double-count that made the two numbers disagree: `scopedCounts` counted the worker AND the
  // orchestrator that inherited from it, while the thread digested one.
  it("counts one piece of work once, at the row that carries it", () => {
    const p = projectOf("p1", "web", [tab("orch"), worker("w1", "orch"), worker("w2", "orch")]);
    const feed = feedFrom([p], { orch: "idle", w1: "waiting", w2: "waiting" });
    expect(feed.scopedCounts.needs_you).toBe(1);
    render(<ConciergeHost feed={feed} />);
    expect(vitalsNeedsYou()).toBe(1);
    expect(threadTotal()).toBe(1);
  });

  // The general statement, over the fleet that mixes every shape at once: bubbled workers,
  // suppressed workers, a parentless one, a dangling parent, two projects and two bands. Whatever
  // the vitals line says, the thread accounts for exactly that many items.
  it("the vitals number equals what the thread accounts for, across a mixed fleet", () => {
    const web = projectOf("p1", "web", [
      tab("w-a"), //    idle, but inherits w-x's red
      tab("w-b"), //    blocked on its own
      tab("w-c"), //    waiting on its own
      tab("w-run"), //  working — banded `running`, and in motion
      worker("w-x", "w-a"), //   bubbles into w-a → represented
      worker("w-y", null), //    parentless → surfaces itself
      worker("w-z", "w-run"), // suppressed by w-run's motion → surfaces itself
    ]);
    const api = projectOf("p2", "api", [
      tab("a-a"),
      tab("a-b"),
      worker("a-x", "a-a"), //     asks, so it always bubbles → represented
      worker("a-y", "vanished"), // dangling parent → surfaces itself
    ]);
    const status: Record<string, AgentTabStatus> = {
      "w-a": "idle",
      "w-b": "blocked",
      "w-c": "waiting",
      "w-run": "working",
      "w-x": "blocked",
      "w-y": "waiting",
      "w-z": "blocked",
      "a-a": "idle",
      "a-b": "approval",
      "a-x": "approval",
      "a-y": "errored",
    };
    const feed = feedFrom([web, api], status);
    render(<ConciergeHost feed={feed} />);
    expect(threadTotal()).toBe(vitalsNeedsYou());
    expect(vitalsNeedsYou()).toBe(feed.scopedCounts.needs_you);
    // Not vacuous — there is plenty to account for.
    expect(vitalsNeedsYou()).toBeGreaterThan(3);
  });

  // The digest's promise is UNTOUCHED by the fix. A worker has no row, so it may never be folded
  // into a ROW-PROMISING line's count — it is accounted for on the rowless line beside it, whose
  // sentence states no row count at all.
  it("never folds a rowless agent into a digest line's count", () => {
    const p = projectOf("p1", "web", [
      tab("a"),
      tab("b"),
      tab("orch"),
      worker("w1", "orch"), // suppressed by orch's motion → a card, never part of the line
      worker("w2", null), //  parentless        → a card, never part of the line
    ]);
    const feed = feedFrom([p], {
      a: "blocked",
      b: "blocked",
      orch: "working",
      w1: "blocked",
      w2: "blocked",
    });
    render(<ConciergeHost feed={feed} />);
    const lines = screen.queryAllByTestId("concierge-digest");
    expect(lines).toHaveLength(1);
    // Two ROWS stand behind the line (a and b) — the two workers are cards beside it, not inside
    // this count.
    expect(lines[0]!.textContent).toBe(`${bandCountLabel("needs_you", 2)} in web`);
    // Neither worker joins a rowless line here, for two DIFFERENT reasons, which is the point of
    // pairing them in one fixture: `w1` does get a nested row under the present `orch`, so it is
    // eligible to collapse — but it is alone in that population, and one is always a card. `w2` is
    // parentless, so it has no row anywhere and is never eligible at all.
    expect(screen.queryByTestId("concierge-rowless-digest")).toBeNull();
    expect(cardNames()).toEqual(["w1", "w2"]);
    // Four asks, one line plus two cards, and the arithmetic still adds up.
    expect(threadTotal()).toBe(4);
  });
});
