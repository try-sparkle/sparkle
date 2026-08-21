// @vitest-environment jsdom
//
// ══ A PILL IN THE THREAD MUST REVEAL, NOT MERELY SELECT (bead sparkle-s6gonk) ═══════════════════
//
// THE FOUNDER'S REPORT, verbatim: *"when I click on a build agent like this … it doesn't take me to
// that build agent."* He was clicking `@Sparkle AGENTS.md Compression` inside a refusal line. The
// pill was a real `<button>`, its handler fired, and `openProjectTab` returned true — and nothing
// he could see changed.
//
// WHY: selecting an agent is not the same as making its ROW DRAWABLE, and two ordinary pieces of
// sidebar state decide the second question independently of the first:
//
//   • the band filter — the sidebar draws top-level rows by rolled-up band, so a filtered-out head
//     is not in the list at all; and
//   • `collapsedOrchestrators[headId] ?? true` — DEFAULTING TO COLLAPSED, so a worker under a head
//     the reader has never expanded has no row anywhere.
//
// `openProjectTab` touches neither. It returned true, the host reported `"revealed"`, and
// `AgentPill` renders NO notice for `"revealed"` on the stated grounds that "the screen already
// answered". It had not. A click that is both invisible AND silent is the exact dead end
// `AgentPill.deadEnd.test.tsx` forbids — reintroduced one layer beneath the component that forbids
// it, and reachable from every pill in every concierge reply.
//
// `ConciergeHost.revealAgent` has always closed both gates. It was reachable only through
// `AgentPill`'s `onOpen` escape hatch, which two CARD surfaces (NudgeCard, PreviewCards) supply —
// so the hole was patched for the cards and left open on the main road. The context opener now
// delegates to it.
//
// ══ WHY THESE TESTS ASSERT ON THE SIDEBAR STATE AND NOT ON THE OPENER ══════════════════════════
// `openAgentIds` is written by `openProjectTab`, which the OLD path also called — so an assertion
// on it passes against the bug and proves nothing. What separates the two paths is exactly the two
// gates, so those are what is asserted. Both are seeded CLOSED and asserted OPEN afterwards, and
// the paired `expect` that the click also mounted the agent is what stops a fix that merely flips
// UI state without navigating anywhere.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
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
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { ConciergeMessage } from "./Concierge/types";

/** The orchestrator head. `done` so it is the band the fixture filters OUT below. */
function head() {
  return {
    id: "head1",
    name: "Sparkle Orchestrator",
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "idle",
    statusColor: "#e0533f",
    statusLabel: "Idle",
    band: "done" as const,
    parentRowId: null as string | null,
    inScope: true,
    muted: false,
    topLevel: true,
    representedElsewhere: false,
  };
}

/** The WORKER the founder clicked: nested under `head1`, and `working` — its dot is GREEN, which is
 *  the whole point of his second question. A green dot and an unreachable row at the same time. */
function worker() {
  // `running` is the band whose dot paints GREEN (STATUS_BANDS: running → colorFrom "working").
  // Note `band` is a StatusBand, NOT an AgentTabStatus — `bandColor` silently falls back to
  // `needs_you`'s RED for an unrecognised value, so "working" here would have been a red dot
  // describing itself as a working agent.
  return { ...head(), id: "w1", name: "Sparkle AGENTS.md Compression", band: "running" as const, parentRowId: "head1", topLevel: false };
}

const COUNTS = { needs_you: 0, questions: 0, running: 1, done: 1 };
const FEED = {
  projects: [
    {
      id: "p1",
      name: "sparkle",
      inScope: true,
      counts: COUNTS,
      scopedCounts: COUNTS,
      agents: [head(), worker()],
    },
  ],
  counts: COUNTS,
  scopedCounts: COUNTS,
  pinnedProjectId: null,
} as unknown as ConciergeFeed;

/** THE EXACT LINE FROM THE SCREENSHOT — an app-authored REFUSAL receipt, which is a different chat
 *  line type from a concierge reply: it carries an `actionReceipt`, so `ConciergeMessageRow` draws
 *  it through the notice arm with its attribution header and its grey ink. */
const REFUSAL: ConciergeMessage = {
  id: "receipt-1",
  kind: "sparkle",
  text: "Refused the concierge's message to [@Sparkle AGENTS.md Compression](sparkle-agent:w1) — send_to_agent_terminal requires a goal.",
  actionReceipt: { kind: "sent", ok: false, reason: "send_to_agent_terminal requires a goal." },
} as ConciergeMessage;

/** An ordinary concierge REPLY naming the same worker — the other line type, so neither case can
 *  pass for the wrong reason. */
const REPLY: ConciergeMessage = {
  id: "reply-1",
  kind: "sparkle",
  text: "Ask [@Sparkle AGENTS.md Compression](sparkle-agent:w1) about it.",
} as ConciergeMessage;

/** THE READER'S SIDEBAR, in the state that hides the worker completely:
 *   • `done` filtered out, so the HEAD is not drawn — and a worker only renders under a drawn head;
 *   • `head1` collapsed, so even a drawn head shows no children.
 *  Both are ordinary states a reader reaches by clicking a band chip and never expanding a head. */
function seedHiddenSidebar() {
  useUiStore.setState({
    statusFilter: { needs_you: true, questions: true, running: true, done: false },
    collapsedOrchestrators: { head1: true },
  } as never);
}

function seedProjects() {
  useProjectStore.setState({
    projects: [
      { id: "p1", name: "sparkle", agents: [{ id: "head1", name: "head1" }, { id: "w1", name: "w1" }] },
    ],
    selectedProjectId: "p1",
  } as never);
}

beforeEach(() => {
  enableAiEnhancementsForTests();
  setConciergeChat(() => []);
  useRuntimeStore.setState({ openAgentIds: [] } as never);
  seedProjects();
  seedHiddenSidebar();
});
afterEach(() => cleanup());

describe("clicking a thread pill makes the agent's row DRAWABLE, not just selected", () => {
  it("from a REFUSAL line — the founder's own case", () => {
    setConciergeChat(() => [REFUSAL]);
    render(<ConciergeHost feed={FEED} />);

    // Sanity: this really is the notice arm, so the assertions below are about the line type the
    // founder clicked and not about an ordinary reply that happens to be in the tree.
    expect(screen.getByTestId("concierge-notice")).toBeTruthy();

    const pill = screen.getByTestId("concierge-agent-pill");
    fireEvent.click(pill);

    const ui = useUiStore.getState();
    // ── THE TWO GATES, WHICH THE OLD PATH LEFT SHUT ──────────────────────────────────────────
    expect(ui.collapsedOrchestrators["head1"]).toBe(false);
    expect(ui.statusFilter.done).toBe(true);
    // ── …AND IT STILL NAVIGATED. Without this a "fix" that only flips sidebar state passes.
    expect(useRuntimeStore.getState().openAgentIds).toContain("w1");
    // Nothing to explain: the screen really did answer, so the pill stays silent.
    expect(screen.queryByTestId("concierge-agent-pill-notice")).toBeNull();
  });

  it("from an ordinary concierge REPLY — same opener, so the fix cannot be row-type-specific", () => {
    setConciergeChat(() => [REPLY]);
    render(<ConciergeHost feed={FEED} />);

    expect(screen.queryByTestId("concierge-notice")).toBeNull();
    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    const ui = useUiStore.getState();
    expect(ui.collapsedOrchestrators["head1"]).toBe(false);
    expect(ui.statusFilter.done).toBe(true);
    expect(useRuntimeStore.getState().openAgentIds).toContain("w1");
  });

  it("a reveal that SURFACED a hidden row is reported as movement, never as 'already open'", () => {
    // ── THE PREDICTION HAS TO BE BUILT IN FULL, OR THIS TEST IS VACUOUS (roborev 66521) ────────
    // The branch under test is `revealAgent`'s `!surfaced && planned === "already-showing"`, so the
    // fixture must make `revealOutcomeFor` genuinely predict `"already-showing"`. The first version
    // set `openAgentIds` alone — which is ONE of six conjuncts — so `planned` came back `"revealed"`
    // regardless, the branch was never reached, and the test asserted exactly what case 1 asserts.
    // It would have stayed green with the `surfaced` term deleted, i.e. with the very logic it
    // exists to fence removed.
    //
    // All six, from services/agentReveal.revealOutcomeFor: the tab is open, the project is selected
    // ON ITS OWN SIDE, it is that project's `selectedAgentId`, its pane is mounted, no overlay
    // covers it, and that column is on Build.
    useUiStore.setState({
      openProjectIds: null,
      pairAssignment: { p1: "left" },
      leftProjectId: "p1",
      activeSpecial: null,
      workModeBySide: { left: "build", right: "build" },
      // …and the same hidden sidebar as every other case here: the row the reader is being sent to
      // is NOT drawable, which is the whole contradiction — the stores say "already showing" while
      // the screen shows nothing.
      statusFilter: { needs_you: true, questions: true, running: true, done: false },
      collapsedOrchestrators: { head1: true },
    } as never);
    useProjectStore.setState({
      projects: [
        {
          id: "p1",
          name: "sparkle",
          selectedAgentId: "w1",
          agents: [{ id: "head1", name: "head1" }, { id: "w1", name: "w1" }],
        },
      ],
      selectedProjectId: "p1",
    } as never);
    useRuntimeStore.setState({ openAgentIds: ["w1"] } as never);
    setConciergeChat(() => [REFUSAL]);
    render(<ConciergeHost feed={FEED} />);

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    // The row genuinely came into existence, so this is a REVEAL. No "…is already open in sparkle."
    expect(screen.queryByTestId("concierge-agent-pill-notice")).toBeNull();
    expect(useUiStore.getState().collapsedOrchestrators["head1"]).toBe(false);
    expect(useUiStore.getState().statusFilter.done).toBe(true);
  });

  it("…but an agent whose row was ALREADY drawable keeps the reader's band filter", () => {
    // THE OTHER DIRECTION, and it is what makes the clearing a rule rather than a habit
    // (roborev 66521). `showAllStatusBands()` hard-writes all four bands over a PERSISTED filter,
    // and since this opener moved onto the thread's main path it runs on every pill click. Clearing
    // unconditionally would discard a band the reader had isolated even when nothing was hidden.
    //
    // Same head, same worker, but the head's band is VISIBLE and the head is EXPANDED — so the row
    // is already drawable and there is nothing for the clear to fix. The reader has `running`
    // isolated; it must survive.
    useUiStore.setState({
      statusFilter: { needs_you: false, questions: false, running: true, done: true },
      collapsedOrchestrators: { head1: false },
    } as never);
    setConciergeChat(() => [REFUSAL]);
    render(<ConciergeHost feed={FEED} />);

    fireEvent.click(screen.getByTestId("concierge-agent-pill"));

    const ui = useUiStore.getState();
    // UNTOUCHED — the two bands the reader had switched off are still off.
    expect(ui.statusFilter.needs_you).toBe(false);
    expect(ui.statusFilter.questions).toBe(false);
    // …and the click still did its job, so this is not passing because nothing ran.
    expect(useRuntimeStore.getState().openAgentIds).toContain("w1");
  });
});
