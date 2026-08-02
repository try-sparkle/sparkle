// @vitest-environment jsdom
// A RED CARD MUST NAME THE AGENT THAT IS ACTUALLY RED, AND MUST LEAVE WHEN THAT AGENT RESUMES.
//
// THE REPORT (founder, 2026-07-30, with screenshots). The column showed
// "Needs you — Cockpit Column Resize in sparkle-desktop" while that agent was demonstrably
// WORKING: seven commits ahead, mid-rebase, fixing roborev findings. Clicking through found a busy
// terminal. His conclusion is the one that matters: "a stale alert that says BLOCKED about a
// working agent is worse than no alert, because it trains him to ignore the real ones."
//
// THE MECHANISM, read out of engine/workerAttention.withRedWorkerAttention. A worker's ASK
// (waiting/approval/errored) bubbles onto its orchestrator UNCONDITIONALLY — in motion or not —
// and the write is allowed whenever the parent is not itself asking, which includes a parent that
// is `working`. So a WORKING orchestrator is published `waiting`. Then conciergeFeed's
// `representedElsewhere` sees the worker's band matched by its ancestor and suppresses the
// worker's own card, on the reasoning that the ancestor "speaks for it". The net effect is that
// the ONE thing on screen is a red card naming the one agent in the pair that does NOT need you.
//
// Both halves of the bubble are still right for what they were built for — the ask must not be
// hidden by a busy sibling (the 2026-07-26 report), and one piece of work must be counted once.
// What was wrong is WHO the surviving card names. The rule these cases pin: a nudge card is raised
// for, and named after, the agent whose OWN status is the red. An ancestor that merely INHERITED a
// red while it is itself in motion is a routing hop, not the subject of the alert.
//
// The retraction case is the same rule stated over time, and it is the founder's literal ask:
// bound to the agent whose own status is red, a card cannot outlive that status.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({ dismissAlert: vi.fn() }));

vi.mock("../services/openProjectTab", () => ({
  openProjectTab: vi.fn(),
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
    onConciergeTurnsAbandoned: () => () => {},
  };
});
vi.mock("../services/conciergeDispatch", () => ({
  dispatchConciergeAnswer: vi.fn(async () => ({ ok: true })),
  flushPendingSends: vi.fn(async () => []),
  agentCanAcceptInput: vi.fn(() => true),
  agentCanAcceptPrompt: vi.fn(() => true),
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
  useConciergeDictation: () => ({ interim: "", toggleMic: vi.fn(), registerInsert: vi.fn() }),
}));
vi.mock("../services/dictationControls", () => ({ maybePauseOnSubmit: vi.fn() }));

import { ConciergeHost } from "./ConciergeHost";
import { useUiStore } from "../stores/uiStore";
import { buildConciergeFeed } from "../services/conciergeFeed";
import { accountedNeedsYou } from "../services/conciergeProactive";
import { useProjectStore } from "../stores/projectStore";
import { NUDGE_CARD_TESTID } from "./Concierge/NudgeCard";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

beforeEach(enableAiEnhancementsForTests);

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
 *  NO status entry) cannot manufacture the very reds these cases are about. */
const openIds = (projects: Project[]) => projects.flatMap((p) => p.agents.map((a) => a.id));

const feedFrom = (projects: Project[], status: Record<string, AgentTabStatus>) =>
  buildConciergeFeed({ projects, status, openAgentIds: openIds(projects) });

/** Which agent each nudge card on screen is ABOUT — read off the card's own data attribute rather
 *  than by matching its prose, so these cases keep holding through the card's copy redesign. */
const cardAgentIds = (): string[] =>
  screen.queryAllByTestId(NUDGE_CARD_TESTID).map((el) => el.getAttribute("data-agent-id")!);

/** The same question asked of a feed WITHOUT rendering — for stating a case's premise before the
 *  gesture under test, where a second mounted column would just be noise. */
const cardSubjects = (feed: ReturnType<typeof buildConciergeFeed>): string[] =>
  accountedNeedsYou(feed).map((a) => a.id);

/** Every `dismissAlert` the host wrote, in order. Read off the real store: this is the record the
 *  status chain (`withDismissedAlerts`) later reads, so asserting it is asserting the side effect
 *  rather than the click. */
const dismissed = (): Array<{ projectId: string; agentId: string; status: string }> =>
  h.dismissAlert.mock.calls.map(([projectId, agentId, status]) => ({
    projectId,
    agentId,
    status,
  }));

beforeEach(() => {
  useUiStore.getState().showAllStatusBands();
  useUiStore.setState({ collapsedOrchestrators: {} });
  // The REAL store with one action swapped, rather than a module mock: everything else in the host
  // still reads the genuine projectStore, and `dismissAlert` is the one write these cases are about.
  h.dismissAlert.mockClear();
  useProjectStore.setState({ dismissAlert: h.dismissAlert });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a red card names the agent that is actually red", () => {
  // THE FOUNDER'S CASE. `w1` asked a question; `orch` is working. Today the ask bubbles onto the
  // working orchestrator and the orchestrator's card is the only one drawn — so the column says
  // the busy agent is the one that needs him, and the agent that does is silent.
  it("names the asking WORKER, not the working orchestrator that inherited its red", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("orch"), worker("w1", "orch")]);
    const feed = feedFrom([p], { orch: "working", w1: "waiting" });

    // The premise, asserted rather than assumed: the orchestrator's OWN status is `working`, and
    // the only reason it is not calm is the bubble. If this ever stops being true the case below is
    // testing something else.
    const byId = Object.fromEntries(feed.projects[0]!.agents.map((a) => [a.id, a]));
    expect(byId["w1"]!.status).toBe("waiting");

    render(<ConciergeHost feed={feed} />);
    expect(cardAgentIds()).toEqual(["w1"]);
  });

  // The same shape one level deeper, so the fix cannot be a parent-only special case: an ask under
  // a working orchestrator nested under a working orchestrator still names the asker.
  it("names the asker when the inherited red has travelled more than one hop", () => {
    const p = projectOf("p1", "sparkle-desktop", [
      tab("top"),
      worker("mid", "top"),
      worker("leaf", "mid"),
    ]);
    const feed = feedFrom([p], { top: "working", mid: "working", leaf: "approval" });
    render(<ConciergeHost feed={feed} />);
    expect(cardAgentIds()).toEqual(["leaf"]);
  });

  // THE OTHER DIRECTION, and the reason this is a rule about OWN status rather than about workers.
  // An orchestrator that is itself asking still gets its own card: the bubble is not what put it
  // there, so nothing about it is a routing hop.
  it("still names the orchestrator when the orchestrator is the one asking", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("orch"), worker("w1", "orch")]);
    const feed = feedFrom([p], { orch: "waiting", w1: "working" });
    render(<ConciergeHost feed={feed} />);
    expect(cardAgentIds()).toEqual(["orch"]);
  });

  // THE TRADE-OFF, CHOSEN RATHER THAN DISCOVERED. A hop's red descendants surface under the
  // ORDINARY gates, so a hop whose only red descendant is MUTED relays nothing and the column goes
  // quiet. Pinned because it is the one behaviour this fix gives up, and the alternative is worse:
  // telling the founder that a working agent needs him, on behalf of a worker he explicitly asked
  // not to be interrupted about. See `ConciergeAgent.redIsInherited`.
  it("goes quiet rather than relaying, when the only red under a working head is muted", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("orch"), worker("w1", "orch")]);
    const feed = buildConciergeFeed({
      projects: [p],
      status: { orch: "working", w1: "waiting" },
      openAgentIds: openIds([p]),
      shouldInterrupt: (topic) => !topic.includes("w1"),
    });
    render(<ConciergeHost feed={feed} />);
    expect(cardAgentIds()).toEqual([]);
    // And the count agrees with the silence — the vitals line does not promise an item the thread
    // has no row for, which is the invariant the scoped-count gate exists to keep.
    expect(feed.scopedCounts.needs_you).toBe(0);
  });

  // A calm (not working) orchestrator is NOT a routing hop in the sense above — it is doing
  // nothing, so it is a fair place to knock. This case exists so the fix stays narrow: it must not
  // silence the ordinary "your build finished and a worker is asking" rollup, which is what the
  // orchestrator's row is for.
  it("leaves the rollup intact when the orchestrator is idle rather than working", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("orch"), worker("w1", "orch")]);
    const feed = feedFrom([p], { orch: "idle", w1: "waiting" });
    render(<ConciergeHost feed={feed} />);
    expect(cardAgentIds()).toEqual(["orch"]);
  });
});

describe("[x] acknowledges the alarm, not just the agent named on the card", () => {
  // THE WHACK-A-MOLE (roborev 55986, Medium). On the rollup shape this design deliberately keeps —
  // an IDLE orchestrator carrying a red worker's band — the card names the orchestrator. Dismissing
  // only that de-escalates its red, which makes the worker un-represented, so the NEXT tick raises a
  // new, near-identical card naming the worker. The reader who reflexively acknowledged one alarm
  // gets it straight back under a different name, once per red descendant.
  //
  // Asserted through the STORE, because the defect is about which records get written — the visible
  // symptom (a second card) is a consequence of the feed being rebuilt from them.
  it("dismisses the descendants a rollup card was standing in for, not only the head", () => {
    const p = projectOf("p1", "sparkle-desktop", [
      tab("orch"),
      worker("w1", "orch"),
      worker("w2", "orch"),
    ]);
    const feed = feedFrom([p], { orch: "idle", w1: "waiting", w2: "waiting" });
    // The premise: ONE card, naming the head, standing in for both workers.
    expect(cardSubjects(feed)).toEqual(["orch"]);

    render(<ConciergeHost feed={feed} />);
    fireEvent.click(screen.getByTestId("concierge-nudge-dismiss"));

    // Every agent the card spoke for is acknowledged, so nothing is left to re-raise under a new
    // name. Each with its OWN published status, which is what ties the record to this episode.
    expect(dismissed()).toEqual([
      { projectId: "p1", agentId: "orch", status: "waiting" },
      { projectId: "p1", agentId: "w1", status: "waiting" },
      { projectId: "p1", agentId: "w2", status: "waiting" },
    ]);
  });

  // THE SAME BUG ONE LEVEL DOWN (roborev 56000). `representedBy` names the NEAREST ancestor that
  // speaks for an agent, so on a three-deep chain the leaf points at `mid`, not at the head the card
  // names. Dismissing only the DIRECT representees left the leaf red with both its ancestors' alarms
  // now suppressed — nothing spoke for it, so the next tick raised a fresh card naming it. The first
  // two cases here could not see that: one is depth 1 and the other depth 0.
  it("dismisses a rollup's whole subtree, not just the agents pointing straight at the head", () => {
    const p = projectOf("p1", "sparkle-desktop", [
      tab("orch"),
      worker("mid", "orch"),
      worker("leaf", "mid"),
    ]);
    const feed = feedFrom([p], { orch: "idle", mid: "waiting", leaf: "waiting" });
    // The premise: ONE card, naming the head, and the leaf pointing at `mid` rather than at it.
    expect(cardSubjects(feed)).toEqual(["orch"]);
    const byId = Object.fromEntries(feed.projects[0]!.agents.map((a) => [a.id, a]));
    expect(byId["leaf"]!.representedBy).toBe("mid");
    expect(byId["mid"]!.representedBy).toBe("orch");

    render(<ConciergeHost feed={feed} />);
    fireEvent.click(screen.getByTestId("concierge-nudge-dismiss"));

    expect(dismissed().map((d) => d.agentId).sort()).toEqual(["leaf", "mid", "orch"]);
  });

  it("dismisses only the named agent when the card speaks for nobody else", () => {
    // The narrow case, so the fix cannot quietly become "dismiss the whole subtree": a leaf card
    // must not acknowledge alarms the reader never saw.
    const p = projectOf("p1", "sparkle-desktop", [tab("solo")]);
    render(<ConciergeHost feed={feedFrom([p], { solo: "waiting" })} />);
    fireEvent.click(screen.getByTestId("concierge-nudge-dismiss"));
    expect(dismissed()).toEqual([{ projectId: "p1", agentId: "solo", status: "waiting" }]);
  });
});

describe("a red card retracts when its agent goes back to working", () => {
  // THE FOUNDER'S LITERAL ASK: "make the toast retract itself the moment the agent goes back to
  // working". Asserted as a TRANSITION on one mounted column — a card that is drawn, then gone —
  // rather than as two independent renders, because the failure being guarded against is a card
  // that OUTLIVES its state, and only a rerender can catch that.
  it("drops the card on the next feed tick after the agent resumes", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("solo")]);
    const { rerender } = render(<ConciergeHost feed={feedFrom([p], { solo: "waiting" })} />);
    expect(cardAgentIds()).toEqual(["solo"]);

    rerender(<ConciergeHost feed={feedFrom([p], { solo: "working" })} />);
    expect(cardAgentIds()).toEqual([]);
  });

  // The founder's case again, as a transition. The worker answers and resumes; the orchestrator
  // never stopped working. Nothing red is left, so nothing red may be on screen — the state the
  // screenshot showed and the app did not reach.
  it("drops the inherited-red card when the asking worker resumes", () => {
    const p = projectOf("p1", "sparkle-desktop", [tab("orch"), worker("w1", "orch")]);
    const { rerender } = render(
      <ConciergeHost feed={feedFrom([p], { orch: "working", w1: "waiting" })} />,
    );
    expect(cardAgentIds()).toEqual(["w1"]);

    rerender(<ConciergeHost feed={feedFrom([p], { orch: "working", w1: "working" })} />);
    expect(cardAgentIds()).toEqual([]);
  });
});
