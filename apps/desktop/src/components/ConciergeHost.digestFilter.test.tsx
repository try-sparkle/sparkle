// @vitest-environment jsdom
// The digest line's CLICK — the founder's headline ask, and the half main shipped without.
//
//   "I just want Sparkle to be telling me that I have two agents that need my attention. If I click
//    on the two agents part of that text then it filters the build column out to only show me the
//    agents that need attention."
//
// Opening the project was already there. What was missing is everything below:
//   • the click ISOLATES that band in the Build column, writing the SAME `statusFilter` the
//     sidebar's own chips read — so one state, not two that can disagree
//   • it selects the project FIRST and filters SECOND, because the filter narrows whichever project
//     is selected
//   • the number the sentence states EQUALS the number of rows left standing, which is what makes
//     the sentence a promise rather than a report
//   • a click that lands after its group resolved opens nothing and filters nothing
//
// Lives apart from ConciergeHost.test.tsx (the dispatch/refusal ladder) because this file is about
// NAVIGATION and the count-vs-rows invariant.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const h = vi.hoisted(() => ({
  openProjectTab: vi.fn(),
  setInterruptPreference: vi.fn(),
  /** `statusFilter` as it stood at the instant `openProjectTab` was called — see the ORDER test. */
  filterWhenOpened: null as Record<string, boolean> | null,
  /** The last view-model + controller ConciergeColumn was handed. The STALE-click tests need these:
   *  a stale click is by definition one whose digest MESSAGE is older than the feed, and React keeps
   *  the rendered button's message current — so re-rendering and clicking can never produce one.
   *  Holding the earlier message and invoking the live controller with it is the only way to put the
   *  handler in the situation it guards against. */
  lastModel: null as { messages: { id: string; kind: string; leadAgentId?: string }[] } | null,
  lastController: null as {
    onDigestClick?: (d: { id: string }) => void;
    /** No longer reachable from the DOM — the header segments that called it are gone — so the
     *  contract test below invokes it through here. */
    onProjectClick?: (projectId: string) => void;
  } | null,
}));
// Mirror EVERY export: Vitest throws on access to a missing mock export.
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
    onConciergeTurnsAbandoned: () => () => {},
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
vi.mock("./Concierge/ConciergeSuggestions", () => ({
  ConciergeSuggestions: () => null,
}));
// The REAL column, wrapped only to record what it was handed — the digest line still renders for
// real, so every DOM-level assertion below is against production markup.
vi.mock("./Concierge", async (importOriginal) => {
  const real = await importOriginal<typeof import("./Concierge")>();
  return {
    ...real,
    ConciergeColumn: (p: Parameters<typeof real.ConciergeColumn>[0]) => {
      h.lastModel = p.model as unknown as typeof h.lastModel;
      h.lastController = p.controller as unknown as typeof h.lastController;
      return real.ConciergeColumn(p);
    },
  };
});
// The voice stack is imported unconditionally by the host; without these every render would run the
// real dictation hook and couple these navigation rows to the mic pipeline.
vi.mock("../useConciergeDictation", () => ({
  useConciergeDictation: () => ({
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
// The SELECTED project is what the header calls "here" — the only store the segment tests seed.
import { useProjectStore } from "../stores/projectStore";
import { buildConciergeFeed, conciergeBand } from "../services/conciergeFeed";
import { topLevelAgents } from "../engine/agentOrdering";
import { flattenSections, groupAgentsByStage, type StatusBand } from "../engine/buildSections";
import { publishedStatusFor } from "../useAttentionNotifications";
import { resolveStage } from "../engine/workflowStage";
import type { AgentTab, AgentTabStatus, Project } from "../types";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import { NUDGE_CARD_TESTID } from "./Concierge/NudgeCard";

// PRECONDITION, stated rather than inherited: this suite's subject is the concierge CONVERSATION,
// and the column locks that half — thread and composer both — whenever the AI gate is shut
// (Concierge/conciergeAiLock). A fresh test's default is the anonymous trial (`me: null`), which is
// locked. The locked state has its own suite: Concierge/ConciergeColumn.locked.test.
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

/** A worker — the kind of agent that never claims a row of its own in column two. */
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

/** Everything live, so the unstarted-worker red overlay can't fire and skew one side only. */
const openIds = (projects: Project[]) => projects.flatMap((p) => p.agents.map((a) => a.id));

const feedFrom = (projects: Project[], status: Record<string, AgentTabStatus>) =>
  buildConciergeFeed({ projects, status, openAgentIds: openIds(projects) });

/**
 * The rows AgentSidebar would LEAVE STANDING after `isolateStatusBand(band)`.
 *
 * This is the sidebar's OWN pipeline, called here: its exact stack (`topLevelAgents`) through its
 * exact filter (`groupAgentsByStage` with one band visible), flattened the way the column renders it
 * (`flattenSections`) — see AgentSidebar's `sections`/`ordered` memos. The expected side of the
 * invariant is therefore production code, not a re-derivation of it; a test that re-derived its own
 * expectation would go green on exactly the drift it exists to catch.
 *
 * The stage function is constant because stage decides which SECTION a row lands in, never whether
 * it is visible at all.
 */
function sidebarRows(project: Project, status: Record<string, AgentTabStatus>, band: StatusBand) {
  const eff = publishedStatusFor(project.agents, status, new Set(openIds([project])), {}, () =>
    resolveStage(undefined, undefined),
  );
  return flattenSections(
    groupAgentsByStage(
      topLevelAgents(project.agents, "build"),
      () => resolveStage(undefined, undefined),
      (id) => eff[id] ?? "stopped",
      { needs_you: band === "needs_you", running: band === "running", done: band === "done" },
    ),
  );
}

/** What each rendered digest line PROMISES: its band, its project, and the number it states.
 *  Parsed with an anchored regex rather than splitting on spaces — a band label is two words
 *  ("Need you"), so positional splitting would read the project name off the wrong token. */
const promises = () =>
  screen.queryAllByTestId("concierge-digest").map((el) => {
    const m = /^(\d+) .+ in (.+)$/.exec(el.textContent!)!;
    return {
      band: el.getAttribute("data-band") as StatusBand,
      projectName: m[2]!,
      count: Number(m[1]),
    };
  });

// Every band visible, i.e. the sidebar's default. The click ISOLATES one; the assertions read the
// resulting `statusFilter` back, which is exactly what the chips render.
beforeEach(() => {
  useUiStore.getState().showAllStatusBands();
  h.filterWhenOpened = null;
  h.openProjectTab.mockImplementation(() => {
    h.filterWhenOpened = { ...useUiStore.getState().statusFilter };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("clicking a digest line filters the Build column", () => {
  const twoInWeb = () => {
    const p = projectOf("p2", "web", [tab("a"), tab("b"), tab("calm")]);
    const status: Record<string, AgentTabStatus> = {
      a: "blocked",
      b: "approval",
      calm: "idle",
    };
    return { p, status };
  };

  it("isolates the line's band in the SAME statusFilter the sidebar chips write", () => {
    const { p, status } = twoInWeb();
    render(<ConciergeHost feed={feedFrom([p], status)} />);
    fireEvent.click(screen.getByTestId("concierge-digest"));
    // The whole record, not one key: leaving `running`/`done` on would show every row and keep no
    // promise at all.
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: false,
      done: false,
    });
  });

  it("selects the project FIRST, then filters — the order is load-bearing", () => {
    const { p, status } = twoInWeb();
    render(<ConciergeHost feed={feedFrom([p], status)} />);
    fireEvent.click(screen.getByTestId("concierge-digest"));
    expect(h.openProjectTab).toHaveBeenCalledWith("p2", expect.any(String));
    // `isolateStatusBand` narrows whichever project is SELECTED. Captured at the moment the project
    // was opened, the filter must still be WIDE — if it had already been isolated, the narrowing
    // landed on the previously-selected project's list, which reads as "my agents just vanished".
    expect(h.filterWhenOpened).toEqual({ needs_you: true, running: true, done: true });
  });

  it("leaves the filter in a state the chips can show and Show-all can clear", () => {
    const { p, status } = twoInWeb();
    render(<ConciergeHost feed={feedFrom([p], status)} />);
    fireEvent.click(screen.getByTestId("concierge-digest"));
    expect(useUiStore.getState().statusFilter.done).toBe(false);
    useUiStore.getState().showAllStatusBands();
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: true,
      done: true,
    });
  });

  it("reveals a lead agent the filter it just applied still SHOWS", () => {
    const { p, status } = twoInWeb();
    render(<ConciergeHost feed={feedFrom([p], status)} />);
    fireEvent.click(screen.getByTestId("concierge-digest"));
    const [, revealedId] = h.openProjectTab.mock.calls[0]!;
    // The selected row must survive its own filter, or the click lands the user on a row that is
    // no longer in the column.
    expect(sidebarRows(p, status, "needs_you").map((a) => a.id)).toContain(revealedId);
  });

  // ── Stale clicks ────────────────────────────────────────────────────────────
  // The handler re-derives its group from the LIVE feed rather than trusting the message it was
  // handed. These drive the controller with the message captured from an EARLIER render, because
  // that is what a stale click is: React re-renders the button with a current message on every feed
  // tick, so clicking the DOM can never produce one.

  /** The digest message as of the current render. */
  const renderedDigest = () => h.lastModel!.messages.find((m) => m.kind === "digest")!;

  it("opens nothing and filters nothing when the group has resolved under the click", () => {
    const { p, status } = twoInWeb();
    const { rerender } = render(<ConciergeHost feed={feedFrom([p], status)} />);
    const stale = renderedDigest();
    // Both agents answer before the click is delivered.
    rerender(<ConciergeHost feed={feedFrom([p], { a: "idle", b: "idle", calm: "idle" })} />);
    h.lastController!.onDigestClick!(stale);
    expect(h.openProjectTab).not.toHaveBeenCalled();
    // Untouched — still every band visible, exactly as beforeEach left it. A stale click must not
    // narrow the column either: filtering on a promise that no longer exists is the empty column
    // this whole invariant is about.
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: true,
      done: true,
    });
  });

  it("opens the agent that is still asking, not the one the stale message named", () => {
    const { p, status } = twoInWeb();
    const { rerender } = render(<ConciergeHost feed={feedFrom([p], status)} />);
    const stale = renderedDigest();
    // The lead is whichever agent the feed's own order ranked first (live questions before older
    // asks) — read it rather than assuming, so this stays true if that ordering is retuned.
    const staleLead = stale.leadAgentId!;
    expect(["a", "b"]).toContain(staleLead);
    // The lead the stale message names RESOLVES; the other two are the ones asking now. The group
    // survives — same project, same band, same id — but its membership moved underneath it.
    const after: Record<string, AgentTabStatus> = {
      a: "blocked",
      b: "blocked",
      calm: "blocked",
      [staleLead]: "idle",
    };
    rerender(<ConciergeHost feed={feedFrom([p], after)} />);
    h.lastController!.onDigestClick!(stale);
    const [, revealedId] = h.openProjectTab.mock.calls[0]!;
    // Opening the agent that already answered is the dead click this guard exists to prevent.
    expect(revealedId).not.toBe(staleLead);
    expect(after[revealedId as string]).toBe("blocked");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The count is a PROMISE, not a report.
//
// "2 Need you in web" is a clickable phrase, and the click calls `isolateStatusBand`, which narrows
// the sidebar's TOP-LEVEL rows and nothing else. So the sentence and the handoff must be counting
// the same population, or column one promises rows column two cannot produce: with both asks being
// workers the user clicked "2" and got an empty column plus an empty-state chip.
//
// These run the REAL builder over REAL AgentTab fixtures — worker nesting and the worker→
// orchestrator red bubble only exist down there, and a hand-rolled ConciergeAgent literal
// reproduces neither.
// ─────────────────────────────────────────────────────────────────────────────
describe("the stated count equals the rows the click leaves standing", () => {
  /** THE invariant: every number column one states is a number column two can show. */
  function expectEveryPromiseKept(projects: Project[], status: Record<string, AgentTabStatus>) {
    render(<ConciergeHost feed={feedFrom(projects, status)} />);
    for (const p of promises()) {
      const project = projects.find((x) => x.name === p.projectName)!;
      expect({ ...p, rows: sidebarRows(project, status, p.band).length }).toEqual({
        ...p,
        rows: p.count,
      });
    }
  }

  // The concierge's own banding, asserted to be the same function the sidebar filters on — one
  // shared `bandOfStatus`, so the two columns cannot band the same agent differently.
  it("bands an agent the same way on both sides", () => {
    expect(conciergeBand("blocked")).toBe("needs_you");
    expect(conciergeBand("working")).toBe("running");
  });

  // The founder's exact failure case. Two blocked workers whose orchestrator isn't in this project,
  // so nothing inherits their red: the sentence said "2 in web" and the click produced an empty
  // column. There is no honest ROW-PROMISING line to draw here, so none is drawn.
  //
  // Drawing no such line is not the same as saying nothing, and the difference is a bug this branch
  // briefly shipped: with no line and no row, these two were invisible everywhere in the app. They
  // speak as one card EACH — and a card each, not a rowless line, because an orchestrator outside
  // the fleet leaves them with no row anywhere, so nothing but their own card can reach them. A
  // line here would have named "2" and delivered one (roborev 53679); the rowless line is reserved
  // for workers that do get a nested row, which the surfacing suite covers.
  it("draws no row-promising line when the only asks are workers — but still says they exist", () => {
    const p = projectOf("p2", "web", [tab("calm"), worker("w1", "elsewhere"), worker("w2", "elsewhere")]);
    const status: Record<string, AgentTabStatus> = { calm: "idle", w1: "blocked", w2: "blocked" };
    expect(sidebarRows(p, status, "needs_you")).toHaveLength(0);
    render(<ConciergeHost feed={feedFrom([p], status)} />);
    expect(screen.queryByText(/2 Need you in web/)).toBeNull();
    expect(promises()).toEqual([]);
    // Not silence, and not a promise either: two cards, each naming (and navigating to) its own
    // agent. That affordance used to be a "Show me" button; since the one-line rewrite it is the
    // card's `AgentPill`, so the count is of CARDS.
    expect(screen.queryByTestId("concierge-rowless-digest")).toBeNull();
    expect(screen.queryAllByTestId(NUDGE_CARD_TESTID)).toHaveLength(2);
  });

  // The partial version, which is the one that actually happens: a red worker paints its
  // orchestrator, so counting both the workers AND the row that inherited from them said "3"
  // against one visible row. The orchestrator is counted ONCE, however many workers it inherited
  // from — and at a volume of one it keeps its card rather than becoming a line, which is the
  // correct sentence, not a rounded-down one.
  it("counts the orchestrator once, not once per red worker it inherited from", () => {
    const p = projectOf("p2", "web", [tab("orch"), worker("w1", "orch"), worker("w2", "orch")]);
    const status: Record<string, AgentTabStatus> = {
      orch: "idle",
      w1: "blocked",
      w2: "blocked",
    };
    // The bubble is what makes this a trap: `orch` is red only because its workers are.
    expect(sidebarRows(p, status, "needs_you").map((a) => a.id)).toEqual(["orch"]);
    render(<ConciergeHost feed={feedFrom([p], status)} />);
    expect(screen.queryByText(/3 Need you in web/)).toBeNull();
    expect(promises()).toEqual([]); // one item keeps its card; no line is drawn at all
  });

  // A line the click CAN keep still gets drawn — the fix must not simply silence the digest.
  it("still says what it can deliver, and delivers exactly that many rows", () => {
    const p = projectOf("p2", "web", [
      tab("a"),
      tab("b"),
      tab("c"),
      worker("w1", "a"),
      worker("w2", "b"),
    ]);
    const status: Record<string, AgentTabStatus> = {
      a: "blocked",
      b: "blocked",
      c: "idle",
      w1: "blocked",
      w2: "blocked",
    };
    render(<ConciergeHost feed={feedFrom([p], status)} />);
    expect(promises()).toEqual([{ band: "needs_you", projectName: "web", count: 2 }]);
    expect(sidebarRows(p, status, "needs_you").map((a) => a.id)).toEqual(["a", "b"]);
    fireEvent.click(screen.getByTestId("concierge-digest"));
    expect(h.openProjectTab).toHaveBeenCalledWith("p2", expect.stringMatching(/^(a|b)$/));
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: false,
      done: false,
    });
  });

  // The general statement, over a fleet that mixes bands, both kinds, two projects and a worker
  // orphaned mid-spawn — the shapes that produced the mismatch, all at once.
  it("holds for every line it draws across a mixed fleet", () => {
    const web = projectOf("p2", "web", [
      tab("w-a"),
      tab("w-b"),
      tab("w-c"),
      worker("w-x", "w-a"),
      // Orphaned mid-spawn: still never a ROW, and so never part of a line's count — but it does
      // get a card of its own, because nothing inherited its red (ConciergeHost.surfacing.test.tsx).
      worker("w-y", null),
    ]);
    const api = projectOf("p3", "api", [tab("a-a"), tab("a-b"), worker("a-x", "a-a")]);
    const status: Record<string, AgentTabStatus> = {
      "w-a": "idle",
      "w-b": "blocked",
      "w-c": "waiting",
      "w-x": "blocked",
      "w-y": "waiting",
      "a-a": "idle",
      "a-b": "approval",
      "a-x": "approval",
    };
    expectEveryPromiseKept([web, api], status);
    // Not vacuous — there IS something to keep.
    expect(promises().length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CARD WALL, THROUGH THE ONE DOOR THE DIGEST DID NOT COVER (roborev 53654).
//
// Rowless agents — workers nothing else speaks for — were appended to the thread as ONE CARD PER
// AGENT, bypassing buildDigest entirely. That population is not bounded by one: the in-motion
// suppression fires once per blocked worker, so a fleet with several blocked workers under an
// absent or still-moving orchestrator is several cards, which is the wall the digest exists to
// prevent ("the whole left column just gets overrun by cards"). They digest by the same rule now.
//
// The founder's OTHER invariant is what shapes the fix rather than a plain reuse: the count on a
// clickable line has to equal the rows the click leaves standing, and these agents have no rows. So
// the rowless line is a different SENTENCE (no row count in it) with a different CLICK (a reveal,
// not a filter) — which is why the guards above, which read `concierge-digest`, still measure only
// the population that owes rows.
// ─────────────────────────────────────────────────────────────────────────────
describe("rowless agents digest like everything else", () => {
  /** The nudge cards on screen, by the agent each names — read off the card's `AgentPill`, which is
   *  both the name on screen and the thing the reader clicks. It used to be matched out of the
   *  card's prose sentence; that sentence is gone with the one-line rewrite (Concierge/NudgeCard). */
  const cardNames = () =>
    screen
      .queryAllByTestId(NUDGE_CARD_TESTID)
      .map((el) => el.querySelector('[data-testid^="concierge-agent-pill"]')?.textContent ?? "")
      .map((t) => t.replace(/^@/, ""));

  /** Four blocked workers under an orchestrator that is still moving — gap 3, once per worker. This
   *  is the shape that produced four cards. */
  const fourBlockedWorkers = () => {
    const p = projectOf("p2", "web", [
      tab("orch"),
      worker("w1", "orch"),
      worker("w2", "orch"),
      worker("w3", "orch"),
      worker("w4", "orch"),
    ]);
    const status: Record<string, AgentTabStatus> = {
      orch: "working",
      w1: "blocked",
      w2: "blocked",
      w3: "blocked",
      w4: "blocked",
    };
    return { p, status };
  };

  it("collapses N rowless agents into ONE line instead of N cards", () => {
    const { p, status } = fourBlockedWorkers();
    render(<ConciergeHost feed={feedFrom([p], status)} />);
    const lines = screen.queryAllByTestId("concierge-rowless-digest");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toBe("4 workers inside web need you");
    // The wall itself: four agents, zero cards.
    expect(cardNames()).toEqual([]);
  });

  it("states no row count — the promise it cannot keep", () => {
    const { p, status } = fourBlockedWorkers();
    // The premise: column two has nothing to show for these, whatever the filter.
    expect(sidebarRows(p, status, "needs_you")).toHaveLength(0);
    render(<ConciergeHost feed={feedFrom([p], status)} />);
    // Nothing rendered as a row-promising line, so the count-equals-rows sweep has nothing to check
    // and nothing to be wrong about.
    expect(promises()).toEqual([]);
  });

  it("reveals its lead agent on click, and narrows nothing", () => {
    const { p, status } = fourBlockedWorkers();
    render(<ConciergeHost feed={feedFrom([p], status)} />);
    fireEvent.click(screen.getByTestId("concierge-rowless-digest"));
    expect(h.openProjectTab).toHaveBeenCalledWith("p2", expect.stringMatching(/^w[1-4]$/));
    // Untouched. Isolating `needs_you` here would hide `orch` — which bands `running` — and the
    // revealed worker pops out UNDER `orch`, so the filter would remove the thing it just opened.
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: true,
      done: true,
    });
  });

  it("keeps a single rowless ask as a card — one is not a wall", () => {
    const p = projectOf("p2", "web", [tab("orch"), worker("w1", "orch")]);
    const status: Record<string, AgentTabStatus> = { orch: "working", w1: "blocked" };
    render(<ConciergeHost feed={feedFrom([p], status)} />);
    expect(screen.queryAllByTestId("concierge-rowless-digest")).toEqual([]);
    expect(cardNames()).toEqual(["w1"]);
  });

  // Both variants live in the SAME project and band at once. Their ids differ by construction; if
  // they ever collided, one line would answer the other's click — and this is the fleet shape where
  // that would happen.
  it("draws both lines when a project has rows AND rowless asks, each keeping its own promise", () => {
    const p = projectOf("p2", "web", [
      tab("a"),
      tab("b"),
      tab("orch"),
      worker("w1", "orch"),
      worker("w2", "orch"),
    ]);
    const status: Record<string, AgentTabStatus> = {
      a: "blocked",
      b: "blocked",
      orch: "working",
      w1: "blocked",
      w2: "blocked",
    };
    render(<ConciergeHost feed={feedFrom([p], status)} />);
    expect(promises()).toEqual([{ band: "needs_you", projectName: "web", count: 2 }]);
    expect(sidebarRows(p, status, "needs_you").map((x) => x.id)).toEqual(["a", "b"]);
    expect(screen.getByTestId("concierge-rowless-digest").textContent).toBe(
      "2 workers inside web need you",
    );
    // The row line still filters; the rowless one still reveals.
    fireEvent.click(screen.getByTestId("concierge-digest"));
    expect(h.openProjectTab).toHaveBeenCalledWith("p2", expect.stringMatching(/^(a|b)$/));
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: false,
      done: false,
    });
  });
});
// ── THE HEADER SAYS NOTHING ACROSS PROJECTS ANY MORE ────────────────────────────────────────────
//
// This block used to pin the header's per-project SEGMENTS — `All projects · 2 here · 1 in mobile`,
// worst project first, each other-project segment switching to it. PRD §2a's open question (column
// one is the GLOBAL index, column two stays project-scoped) is still answered that way in the
// MODEL: `ConciergeHost` builds `needsYouByProject` exactly as before and hands it to the column.
//
// What changed is the RENDER. Bead sparkle-ircc3: the founder asked twice for nothing beside the
// Sparkle wordmark but the red needs-you pill, so the line and its segments are gone. Kept as a
// host-level test rather than deleted, because the column's own tests render a hand-built
// view-model — only this file proves the REAL feed→header path prints no cross-project prose.
describe("the header prints no cross-project line, whatever the feed says", () => {
  /** Two projects with Needs-you work, with `here` selected — the exact feed that used to produce
   *  both segment shapes. If anything is going to reintroduce the line, it is this input. */
  const twoProjects = () => {
    const here = projectOf("p1", "here", [tab("h1"), tab("h2")]);
    const there = projectOf("p2", "mobile", [tab("m1")]);
    const status: Record<string, AgentTabStatus> = {
      h1: "waiting",
      h2: "blocked",
      m1: "approval",
    };
    useProjectStore.setState({ selectedProjectId: "p1" } as never);
    return { projects: [here, there], status };
  };

  it("renders no vitals line and no segment buttons from a real two-project feed", () => {
    const { projects, status } = twoProjects();
    render(<ConciergeHost feed={feedFrom(projects, status)} />);
    expect(screen.queryByTestId("concierge-vitals-line")).toBeNull();
    expect(screen.queryByTestId("concierge-needs-dot")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Switch to / })).toBeNull();
    // The words themselves, not just the handles that carried them.
    for (const gone of ["All projects", "2 here", "1 in mobile", "all calm", "Pinned to"]) {
      expect(screen.queryByText(gone)).toBeNull();
    }
  });

  it("states the SAME total on the red pill instead — the count was not lost with the line", () => {
    const { projects, status } = twoProjects();
    render(<ConciergeHost feed={feedFrom(projects, status)} />);
    // 2 here + 1 in mobile = 3, the number the deleted line used to add up to.
    const pill = screen.getByTestId("concierge-needs-filter");
    expect(pill.textContent).toBe("3");
  });

  it("switching project is no longer something the header can do on its own", () => {
    const { projects, status } = twoProjects();
    render(<ConciergeHost feed={feedFrom(projects, status)} />);
    // Nothing in the header opens a project tab any more: the digest lines below it are the one
    // cross-project navigation the column still offers, and they are tested above.
    fireEvent.click(screen.getByTestId("concierge-needs-filter"));
    expect(h.openProjectTab).not.toHaveBeenCalled();
  });

  // ── THE CALLBACK OUTLIVED ITS CALLER, SO ITS CONTRACT MUST OUTLIVE ITS BUTTON ─────────────────
  //
  // `onProjectClick` is still wired by the host and is now called by nothing (roborev 57364). The
  // segments that used to call it were the only test of what it must NOT do — switch and stop, no
  // agent selected on its behalf (`sparkle-vohh`'s mirror image), and no narrowing of column two
  // the way a digest click does. Deleting those tests with the buttons would hand the next person
  // who adds a caller a green suite whether or not they reintroduce the bug. So the contract is
  // asserted against the CALLBACK directly, through the controller the host hands the column.
  it("still upholds switch-and-stop if anything calls it: no agent named, no band isolated", () => {
    const { projects, status } = twoProjects();
    render(<ConciergeHost feed={feedFrom(projects, status)} />);
    h.lastController!.onProjectClick!("p2");
    // ONE call, ONE argument. `toEqual` compares the whole argument list, so a stray agent id —
    // the thing a count cannot honestly name — fails here.
    expect(h.openProjectTab.mock.calls).toEqual([["p2"]]);
    // Every band still visible: it named a project, not a band, and silently isolating one would
    // hide the very rows the user switched over to look at.
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: true,
      done: true,
    });
  });
});
