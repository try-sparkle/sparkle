// @vitest-environment jsdom
//
// THE SEAM: that the pill's non-navigating state is actually WIRED, and that its one affordance
// lands somewhere a reader can see.
//
// AgentPill.deadEnd.test.tsx pins the pill's behavior against a hand-built context. Those tests
// would keep passing if `ConciergeHost` never supplied `onSeeAgentHistory`, or if its opener threw
// the reveal's outcome away — the pill would fall back to "no history route" and "the open always
// worked", which is exactly today's silent-failure behavior. That is the vacuous-test shape this
// repo keeps finding, so the wiring gets its own assertions through a real render.
//
// EVERY FIXTURE HERE IS PRODUCTION-REACHABLE, which the first version of this suite was not: it
// seeded a feed containing an agent that projectStore did not, to model an "open in another
// window" pill. `buildConciergeFeed` maps exactly `projects[].agents`, so that state cannot occur
// (roborev 55522). The reachable failure is a race — the agent is closed between the render that
// drew the pill and the click that lands on it — and it is produced below by removing the agent
// from projectStore after mounting, which is what actually happens when an agent is closed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
// The recommended-action row mounts a real metered engine; nothing here is about it.
vi.mock("./Concierge/ConciergeSuggestions", () => ({ ConciergeSuggestions: () => null }));
vi.mock("../services/aiGate", () => ({
  useAiFeature: () => true,
  aiFeatureNow: () => false,
  useHasAiCredits: () => true,
  aiEnhancementsEnabled: () => true,
}));

import { ConciergeHost } from "./ConciergeHost";
import { setConciergeChat } from "../stores/conciergeThreadStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useHistoryStore } from "../stores/historyStore";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import type { ConciergeFeed } from "../useConciergeFeed";

function feedAgent(id: string, name: string) {
  return {
    id,
    name,
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "idle",
    statusColor: "#e0533f",
    statusLabel: "Idle",
    // `done`, not `needs_you`: a surfaced agent adds nudge cards unrelated to this suite.
    band: "done" as const,
    // EXPLICIT, because the fixture is cast through `unknown` and a missing field is therefore
    // `undefined` rather than a type error. `revealAgent` branches on it, and omitting it sent a
    // top-level agent down the nested path — which is how this suite's caller-owned row passed for
    // the wrong reason (roborev 58705). The real feed always sets it (services/conciergeFeed).
    parentRowId: null as string | null,
    inScope: true,
    muted: false,
    topLevel: true,
    representedElsewhere: false,
  };
}

const COUNTS = { needs_you: 0, questions: 0, running: 0, done: 1 };
const FEED = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: [feedAgent("ag1", "Build 8")],
    },
  ],
  counts: COUNTS,
  scopedCounts: COUNTS,
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

/** A feed whose named agent lives in a SECOND project — so a doomed reveal would have to navigate
 *  across projects to reach it, which is the movement the guard has to prevent. */
const FEED_P2 = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: [feedAgent("ag1", "Build 7")],
    },
    {
      id: "p2",
      name: "other",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: [{ ...feedAgent("ag2", "Build 8"), projectId: "p2", projectName: "other" }],
    },
  ],
  counts: COUNTS,
  scopedCounts: COUNTS,
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

/** projectStore is the LOCAL truth the reveal path reads — and the feed is built from it, so the
 *  two agree except across the window where an agent is being closed. */
function seedProjects(agentIds: string[]) {
  useProjectStore.setState({
    projects: [{ id: "p1", name: "sparkle", agents: agentIds.map((id) => ({ id, name: id })) }],
  } as never);
}

/** Put a concierge REPLY in the thread that references `agentId` as a pill. */
function threadReferencing(agentId: string, label: string) {
  setConciergeChat(() => [
    { id: "a1", kind: "sparkle", text: `Ask [@${label}](sparkle-agent:${agentId}) about it.` },
  ]);
}

beforeEach(() => {
  enableAiEnhancementsForTests();
  setConciergeChat(() => []);
  useHistoryStore.setState({ query: "", results: [] });
  // Cleared per row: `openAgentIds` is what the (b) case asserts was NOT written, and a successful
  // reveal in an earlier row would otherwise leave `ag1` in it and make that assertion unfalsifiable.
  useRuntimeStore.setState({ openAgentIds: [] } as never);
  seedProjects(["ag1"]);
});
afterEach(() => cleanup());

describe("the host's opener reports whether the reveal landed", () => {
  it("(a) an agent that is really there navigates, and explains nothing", () => {
    threadReferencing("ag1", "Build 8");
    render(<ConciergeHost feed={FEED} />);

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    // The real reveal ran: the agent is mounted and selected.
    expect(useRuntimeStore.getState().openAgentIds).toContain("ag1");
    expect(screen.queryByTestId("concierge-agent-pill-notice")).toBeNull();
  });

  it("(b) an agent CLOSED after the reply rendered reports the failure instead of doing nothing", () => {
    // The production race, reproduced honestly: the pill resolved against the feed, and then the
    // agent went away. `selectAndOpen` bails silently — that bail is the bug, and the pill can only
    // know about it because the opener now returns the outcome.
    threadReferencing("ag1", "Build 8");
    render(<ConciergeHost feed={FEED} />);
    act(() => seedProjects([])); // the agent is closed while the reply is still on screen

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    const notice = screen.getByTestId("concierge-agent-pill-notice");
    expect(notice.textContent).toMatch(/Build 8 is closed/i);
    // And it did NOT mount a phantom id on the way through.
    expect(useRuntimeStore.getState().openAgentIds).not.toContain("ag1");
  });

  it("(b) a failed open moves NOTHING — the notice must not follow a visible navigation", () => {
    // `openProjectTab` reports the miss only AFTER `markProjectOpen` and `selectProjectOnItsSide`
    // have run, so calling it blind would yank the reader to ANOTHER project's tab and THEN say the
    // click accomplished nothing. The host checks `agentExists` first (roborev 55548).
    //
    // THE PILL'S AGENT MUST LIVE IN A DIFFERENT PROJECT THAN THE SELECTED ONE, or this test proves
    // nothing: `selectProjectOnItsSide` is idempotent for an already-selected project, and
    // `openProjectIds` stays `null` until something is CLOSED — so a same-project fixture leaves
    // every observable identical whether or not the guard exists. The first version of this test
    // did exactly that and passed against the unguarded code.
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "sparkle", agents: [{ id: "ag1", name: "ag1" }] },
        // p2 holds the pill's agent, and it is ALREADY GONE — the stale-pill case.
        { id: "p2", name: "other", agents: [] },
      ],
      selectedProjectId: "p1",
    } as never);
    threadReferencing("ag2", "Build 8");
    render(<ConciergeHost feed={FEED_P2} />);

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    expect(screen.getByTestId("concierge-agent-pill-notice").textContent).toMatch(/closed/i);
    // The reader was NOT dragged to p2 on the way to being told the agent is gone.
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
    expect(useUiStore.getState().openProjectIds).toBeNull();
  });
});

describe("(e) the host tells the reader when the reveal had nothing to do", () => {
  /** THE FOUNDER'S STATE, reproduced from the stores rather than described.
   *
   *  The concierge spawned an agent in ANOTHER project and named it as a pill in its reply.
   *  `spawnBuildAgentInProject` finishes with `landInAgent`, so by the time that reply is on screen
   *  the agent is already its project's selected agent, already open, already on Build, with the
   *  overlay already down. The reader then goes back to the project they were working in — a
   *  DIFFERENT pair — and clicks the pill.
   *
   *  Every write `openProjectTab` + `selectAndOpen` would perform is therefore already satisfied,
   *  and every one of them skips. The click used to report success and produce nothing at all. */
  function seedAlreadyShowing() {
    useRuntimeStore.setState({ openAgentIds: ["ag2"] } as never);
    useUiStore.setState({
      openProjectIds: null,
      // p2 lives on the LEFT pair; the reader is watching the right one. This is what makes the
      // no-op total: `selectProjectOnItsSide` writes `leftProjectId`, which is already p2, so not
      // even the tab selection moves.
      pairAssignment: { p2: "left" },
      leftProjectId: "p2",
      activeSpecial: null,
      workModeBySide: { left: "build", right: "build" },
    } as never);
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "sparkle", agents: [{ id: "ag1", name: "Build 7" }] },
        {
          id: "p2",
          name: "other",
          agents: [{ id: "ag2", name: "Build 8" }],
          selectedAgentId: "ag2",
        },
      ],
      selectedProjectId: "p1",
    } as never);
  }

  it("says where the agent is instead of producing no visible change", () => {
    seedAlreadyShowing();
    threadReferencing("ag2", "Build 8");
    render(<ConciergeHost feed={FEED_P2} />);

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    // THE CONTRACT: the reader sees something.
    expect(screen.getByTestId("concierge-agent-pill-notice").textContent).toMatch(
      /Build 8 is already open in other\./i,
    );
  });

  it("moves nothing and calls nothing closed — the agent is alive and was already up", () => {
    seedAlreadyShowing();
    threadReferencing("ag2", "Build 8");
    render(<ConciergeHost feed={FEED_P2} />);

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    // The reader was not yanked anywhere: this is the state where there was nowhere to go.
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
    expect(useUiStore.getState().leftProjectId).toBe("p2");
    // And a live agent is not labelled dead.
    expect(document.body.textContent ?? "").not.toMatch(/closed/i);
    expect(screen.queryByTestId("concierge-agent-pill-closed")).toBeNull();
  });

  /** THE CALLER-OWNED PATH. `NudgeCard` supplies `onOpen`, so `AgentPill` renders NO notice of its
   *  own there — deliberately, because the caller reports the outcome through the column's one
   *  announcer. That reporting enumerated only "does not resolve" and "does not land", so an
   *  already-showing agent produced silence: the founder's exact bug, surviving the first cut of
   *  this fix on precisely the surfaces that name freshly-spawned agents (roborev 58643). */
  function nudgeFeed() {
    const feed = JSON.parse(JSON.stringify(FEED_P2));
    const counts = { needs_you: 1, questions: 0, running: 0, done: 0 };
    feed.projects[1].agents[0].band = "needs_you";
    feed.projects[1].agents[0].status = "waiting";
    feed.counts = counts;
    feed.scopedCounts = counts;
    feed.projects[1].counts = counts;
    feed.projects[1].scopedCounts = counts;
    return feed as unknown as ConciergeFeed;
  }

  it("says it through the TRANSCRIPT for a card pill, which owns its own outcome", () => {
    seedAlreadyShowing();
    setConciergeChat(() => []);
    render(<ConciergeHost feed={nudgeFeed()} />);

    // The pill on the nudge card — the `onOpen` path, not the context one.
    fireEvent.click(within(screen.getByTestId("concierge-nudge")).getByTestId("concierge-agent-pill"));

    // A line in the column, because the card pill has no live region of its own to speak with.
    expect(document.body.textContent ?? "").toMatch(/Build 8 is already open in other\./i);
    // And NOT the "isn't open any more" line, which would be a false claim about a live agent.
    expect(document.body.textContent ?? "").not.toMatch(/isn't open any more/i);
  });

  /** A NESTED agent — a worker under an orchestrator row. `revealAgent` un-hides its band and
   *  expands its head before revealing it, and whether THOSE writes changed anything is the one
   *  piece of logic that can flip an already-showing prediction back to "revealed". It had no test
   *  at all: deleting the whole `surfaced` computation left the suite green (roborev 58705). */
  /** Defaults reproduce the ORIGINAL shape: a `done` head with a `needs_you` worker. The two bands
   *  must DIFFER — a worker whose band its head already carries is `representedElsewhere`, and the
   *  nudge for it is suppressed, so a same-band pair renders no card to click at all. */
  function nestedNudgeFeed(headBand = "done", workerBand = "needs_you") {
    const feed = JSON.parse(JSON.stringify(FEED_P2));
    const counts = { needs_you: 1, questions: 0, running: 0, done: 0 };
    const head = {
      ...feed.projects[1].agents[0],
      id: "head2",
      name: "Head 2",
      parentRowId: null,
      band: headBand,
    };
    const worker = {
      ...feed.projects[1].agents[0],
      band: workerBand,
      status: "waiting",
      parentRowId: "head2",
    };
    feed.projects[1].agents = [head, worker];
    feed.counts = counts;
    feed.scopedCounts = counts;
    feed.projects[1].counts = counts;
    feed.projects[1].scopedCounts = counts;
    return feed as unknown as ConciergeFeed;
  }

  it("(nested) a worker whose row was COLLAPSED counts as revealed — a row appeared", () => {
    seedAlreadyShowing();
    setConciergeChat(() => []);
    // Its head is collapsed, so the worker's row was not drawable a moment ago. Un-collapsing it
    // puts a row on screen the reader could not see: that IS a visible result, and adding a
    // "nothing moved" sentence beside it would contradict the screen.
    useUiStore.setState({
      collapsedOrchestrators: { head2: true },
      statusFilter: { needs_you: true, questions: true, running: true, done: true },
    } as never);
    render(<ConciergeHost feed={nestedNudgeFeed()} />);

    fireEvent.click(
      within(screen.getByTestId("concierge-nudge")).getByTestId("concierge-agent-pill"),
    );

    expect(document.body.textContent ?? "").not.toMatch(/is already open in/i);
  });

  it("(nested) a worker already drawable still gets the sentence", () => {
    seedAlreadyShowing();
    setConciergeChat(() => []);
    // Head expanded AND this agent's own band shown — nothing was hidden, so nothing moved.
    useUiStore.setState({
      collapsedOrchestrators: { head2: false },
      statusFilter: { needs_you: true, questions: true, running: true, done: true },
    } as never);
    render(<ConciergeHost feed={nestedNudgeFeed()} />);

    fireEvent.click(
      within(screen.getByTestId("concierge-nudge")).getByTestId("concierge-agent-pill"),
    );

    expect(document.body.textContent ?? "").toMatch(/Build 8 is already open in other\./i);
  });

  it("(nested) another band being filtered off does NOT count as this row appearing", () => {
    seedAlreadyShowing();
    setConciergeChat(() => []);
    // Isolating a band is a one-click designed affordance, so this is an ordinary resting state.
    // `running`/`done` being off says nothing about a `needs_you` row's drawability — reading it as
    // "a row appeared" swallowed the sentence for a genuinely already-showing agent.
    useUiStore.setState({
      collapsedOrchestrators: { head2: false },
      // `done` — the HEAD's band, which is what gates the row — stays on. `running` is the band
      // belonging to nobody here, and switching it off must change nothing.
      statusFilter: { needs_you: true, questions: true, running: false, done: true },
    } as never);
    render(<ConciergeHost feed={nestedNudgeFeed()} />);

    fireEvent.click(
      within(screen.getByTestId("concierge-nudge")).getByTestId("concierge-agent-pill"),
    );

    expect(document.body.textContent ?? "").toMatch(/Build 8 is already open in other\./i);
  });

  it("(nested) reads the HEAD's band, not the worker's — a drawn head means the row was up", () => {
    // Isolate `needs_you`. The head rolls up red so it is DRAWN and expanded, and every worker under
    // it is on screen — workers are never band-filtered themselves (engine/buildSections filters the
    // top-level list only). A `done` worker there did not move, so the sentence is owed. Reading the
    // WORKER's band called this "a row appeared" and swallowed it (roborev 58713).
    seedAlreadyShowing();
    setConciergeChat(() => []);
    useUiStore.setState({
      collapsedOrchestrators: { head2: false },
      // THE DISCRIMINATOR: the HEAD's band (`done`) is ON, so its row is drawn and its workers are
      // on screen with it. The WORKER's own band (`needs_you`) is OFF — which is irrelevant, because
      // workers are never band-filtered. Reading the worker's band here calls this "a row appeared"
      // and swallows the sentence; reading the head's band gets it right.
      statusFilter: { needs_you: false, questions: true, running: true, done: true },
    } as never);
    render(<ConciergeHost feed={nestedNudgeFeed()} />);

    fireEvent.click(
      within(screen.getByTestId("concierge-nudge")).getByTestId("concierge-agent-pill"),
    );

    expect(document.body.textContent ?? "").toMatch(/is already open in other\./i);
  });

  it("(nested) a worker under a FILTERED-OUT head was not drawable, whatever its own band", () => {
    // The mirror: isolate `running`. The head rolls up red and is filtered OUT, so its worker is not
    // on screen at all — clearing the filter puts the whole subtree up, which IS a visible result.
    // Reading the worker's own `running` band said "nothing was hidden" and produced a sentence
    // contradicting the screen.
    seedAlreadyShowing();
    setConciergeChat(() => []);
    useUiStore.setState({
      collapsedOrchestrators: { head2: false },
      statusFilter: { needs_you: false, questions: true, running: true, done: false },
    } as never);
    render(<ConciergeHost feed={nestedNudgeFeed("needs_you", "running")} />);

    fireEvent.click(
      within(screen.getByTestId("concierge-nudge")).getByTestId("concierge-agent-pill"),
    );

    expect(document.body.textContent ?? "").not.toMatch(/is already open in/i);
  });

  it("(top-level) a row whose OWN band is filtered off is not showing either", () => {
    // Top-level rows ARE the population `groupAgentsByStage` band-filters. Skipping the filter term
    // (and the clear) for them left a `done` agent undrawn while the caller announced it was
    // already open — newly reachable once `parentRowId` was corrected to `null`, because these
    // agents used to fall down the nested branch, which cleared the filter (roborev 58713).
    seedAlreadyShowing();
    setConciergeChat(() => []);
    useUiStore.setState({
      collapsedOrchestrators: {},
      // `nudgeFeed()`'s agent is `needs_you`, and it is TOP-LEVEL — so this is its own row's band.
      statusFilter: { needs_you: false, questions: true, running: true, done: true },
    } as never);
    render(<ConciergeHost feed={nudgeFeed()} />);

    fireEvent.click(
      within(screen.getByTestId("concierge-nudge")).getByTestId("concierge-agent-pill"),
    );

    expect(document.body.textContent ?? "").not.toMatch(/is already open in/i);
  });

  it("still NAVIGATES — and stays silent — when there really is somewhere to go", () => {
    // The mirror of the case above, and the reason `revealOutcomeFor` is a prediction rather than a
    // blanket "say something every time": a reveal that MOVES the screen must add no sentence, or
    // every working click grows an explanation nobody needs.
    useRuntimeStore.setState({ openAgentIds: [] } as never);
    useUiStore.setState({
      openProjectIds: null,
      pairAssignment: {},
      leftProjectId: null,
      activeSpecial: null,
      workModeBySide: { left: "build", right: "build" },
    } as never);
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "sparkle", agents: [{ id: "ag1", name: "Build 7" }] },
        { id: "p2", name: "other", agents: [{ id: "ag2", name: "Build 8" }] },
      ],
      selectedProjectId: "p1",
    } as never);
    threadReferencing("ag2", "Build 8");
    render(<ConciergeHost feed={FEED_P2} />);

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    expect(useRuntimeStore.getState().openAgentIds).toContain("ag2");
    expect(screen.queryByTestId("concierge-agent-pill-notice")).toBeNull();
  });
});

describe("the host gives a closed agent somewhere to go", () => {
  it("(c) an id the roster cannot resolve is INTERACTIVE here, because the host offers history", () => {
    // Outside the concierge column the same pill stays plain prose — that contrast is the wiring.
    threadReferencing("b78f9f8c", "Build 8");
    render(<ConciergeHost feed={FEED} />);

    const closed = screen.getByTestId("concierge-agent-pill-closed");
    expect(closed.tagName).toBe("BUTTON");
    fireEvent.click(closed);
    expect(screen.getByTestId("concierge-agent-pill-notice").textContent).toMatch(
      /Build 8 is closed/i,
    );
  });

  it("(c) 'See what it did' searches by NAME *and* opens the surface that renders the search", () => {
    // Seeding historyStore alone renders NOTHING: the sidebar's <HistorySearch> mount was removed,
    // and CommandPalette — the only live consumer — draws nothing while closed. So the host must
    // open it, or this affordance is the same dead click one level down (roborev 55522).
    const onOpenHistory = vi.fn();
    threadReferencing("b78f9f8c", "Build 8");
    render(<ConciergeHost feed={FEED} onOpenHistory={onOpenHistory} />);

    fireEvent.click(screen.getByTestId("concierge-agent-pill-closed"));
    fireEvent.click(screen.getByTestId("concierge-agent-pill-notice-action"));

    // By NAME, not by the internal uuid: no recorded prompt text contains the id, so an id-keyed
    // search would be a live-looking route that always returns empty.
    expect(useHistoryStore.getState().query).toBe("Build 8");
    expect(onOpenHistory).toHaveBeenCalled();
  });

  it("(d) a RENAMED agent's pill reads its current name, not the one the reply was written with", () => {
    // FEED names ag1 "Build 8"; the reply's link text says "Build 9". The roster wins.
    threadReferencing("ag1", "Build 9");
    render(<ConciergeHost feed={FEED} />);

    expect(screen.getByTestId("concierge-agent-pill").textContent).toBe("@Build 8");
    expect(document.body.textContent).not.toContain("Build 9");
  });
});
