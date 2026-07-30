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
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

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
    inScope: true,
    muted: false,
    topLevel: true,
    representedElsewhere: false,
  };
}

const COUNTS = { needs_you: 0, running: 0, done: 1 };
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
