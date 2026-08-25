// @vitest-environment jsdom
//
// THE PREVIEW CARD IS AN ITEM IN THE TRANSCRIPT, NOT A FIXTURE ABOVE THE COMPOSER — bead
// sparkle-0xbron, and the founder's ask twice over: *"the preview must NOT be attached to the
// compose box — it should render in the actual chat thread, as a message-like item in the
// transcript… a thread artifact with its own place in scroll history"*, and *"it's supposed to be
// in line with chat so that it flows in the chat. Right now it's still pegged above the compose
// window."*
//
// ══ WHY "IS THE CARD ON SCREEN" IS THE VACUOUS VERSION OF THIS TEST ═════════════════════════════
// `ConciergeColumn.previewCard.test.tsx` already asserts the card mounts and its pill resolves, and
// BOTH were true of the pinned build this change replaces. So neither fact can distinguish the
// layout the founder rejected from the one he asked for. The two assertions here are the ones that
// were FALSE before and are TRUE after:
//
//   1. CONTAINMENT — the card is a descendant of the scrolling element. Only a child of the
//      scroller moves with the conversation; anything the column renders is a sibling of it and
//      cannot scroll however it is styled.
//   2. ANCHORING — a message that arrives AFTER the preview renders BELOW the card. This is the
//      half that "append it to the bottom of the thread" also fails: that would put the card inside
//      the scroller (passing 1) while still pinning it under every future message, which is very
//      nearly the picture he complained about.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.reject(new Error("no preview is open"))),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("../BalanceBadge", () => ({ BalanceBadge: () => null }));

import { ConciergeColumn } from "./ConciergeColumn";
import { PREVIEW_CARD_TESTID, PREVIEW_NOTICE_TESTID } from "./PreviewCards";
import { CONCIERGE_THREAD_TESTID } from "../../engine/composeBoxHeight";
import { applyPreviewStatus } from "../../services/preview";
import { usePreviewStore } from "../../stores/previewStore";
import { useProjectStore } from "../../stores/projectStore";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";
import { EMPTY_MOUNTED_THREAD } from "../../stores/mountedThreadStore";
import type {
  ConciergeController,
  ConciergeMessage,
  ConciergeMountedAgent,
  ConciergeViewModel,
} from "./types";
import type { MentionAgent } from "./mentions";

const KRAKEN = "ag-kraken";

const FIRST: ConciergeMessage = { id: "m1", kind: "you", text: "Retry the failing one" };
const LATER: ConciergeMessage = { id: "m2", kind: "you", text: "And rerun the shell suite" };

const model = (messages: ConciergeMessage[]): ConciergeViewModel => ({
  scope: {},
  vitals: { needs_you: 0, questions: 0, running: 0, done: 0 },
  messages,
});

const controller = (): ConciergeController => ({
  onSend: vi.fn(),
  onAttach: vi.fn(),
  onNudgeClick: vi.fn(),
  onNudgeAction: vi.fn(),
});

const ROSTER: MentionAgent[] = [
  {
    id: KRAKEN,
    name: "Kraken Auth",
    projectId: "p1",
    projectName: "sparkle",
    band: "running",
    canAcceptInput: true,
  },
];

/** The `preview:state` event that produces an openable card. */
function previewGoesLive() {
  act(() => {
    applyPreviewStatus({
      id: "srv-1",
      agentId: KRAKEN,
      projectId: "p1",
      url: "http://127.0.0.1:5173",
      port: 5173,
      state: "ready",
      error: null,
    });
  });
}

/** DOM order, read off the document itself rather than off any assumption about the tree shape:
 *  true when `a` comes strictly before `b` in a depth-first walk. */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;

beforeEach(() => {
  enableAiEnhancementsForTests();
  usePreviewStore.setState({ byAgent: {}, capability: {}, openedProjects: {} });
  useProjectStore.setState({
    projects: [{ id: "p1", name: "sparkle", agents: [{ id: KRAKEN, name: "Kraken Auth" }] }],
    selectedProjectId: "p1",
  } as never);
});
afterEach(cleanup);

describe("a live preview is an item in the concierge transcript", () => {
  it("renders the card INSIDE the scrolling thread, not beside it", () => {
    render(
      <ConciergeColumn
        model={model([FIRST])}
        controller={controller()}
        mentionAgents={ROSTER}
        onOpenAgent={vi.fn(() => "revealed" as const)}
      />,
    );
    previewGoesLive();

    const card = screen.getByTestId(PREVIEW_CARD_TESTID);
    const scroller = screen.getByTestId(CONCIERGE_THREAD_TESTID);
    // THE WHOLE POINT. Before this change the card was a sibling of this element, between it and
    // the compose box — structurally incapable of scrolling with the conversation.
    expect(scroller.contains(card)).toBe(true);
  });

  it("keeps its place in scroll history — a later message renders BELOW it", () => {
    const { rerender } = render(
      <ConciergeColumn
        model={model([FIRST])}
        controller={controller()}
        mentionAgents={ROSTER}
        onOpenAgent={vi.fn(() => "revealed" as const)}
      />,
    );
    previewGoesLive();

    // It landed after the conversation as it stood when the preview arrived.
    expect(precedes(row("m1"), screen.getByTestId(PREVIEW_CARD_TESTID))).toBe(true);

    rerender(
      <ConciergeColumn
        model={model([FIRST, LATER])}
        controller={controller()}
        mentionAgents={ROSTER}
        onOpenAgent={vi.fn(() => "revealed" as const)}
      />,
    );

    const card = screen.getByTestId(PREVIEW_CARD_TESTID);
    // …and it STAYED there. An "append to the bottom of the thread" implementation puts the card
    // after `m2` here and fails exactly this line, which is why the assertion is on ORDER against a
    // newer message rather than on containment again.
    expect(precedes(row("m1"), card)).toBe(true);
    expect(precedes(card, row("m2"))).toBe(true);
  });

  it("threads a preview NOTICE the same way — the failing case the reader most needs", () => {
    render(
      <ConciergeColumn
        model={model([FIRST])}
        controller={controller()}
        mentionAgents={ROSTER}
        onOpenAgent={vi.fn(() => "revealed" as const)}
      />,
    );
    act(() => {
      applyPreviewStatus({
        id: "srv-1",
        agentId: KRAKEN,
        projectId: "p1",
        url: null,
        port: null,
        state: "failed",
        error: "Error: Cannot find module 'vite'",
      });
    });

    const notice = screen.getByTestId(PREVIEW_NOTICE_TESTID);
    expect(screen.getByTestId(CONCIERGE_THREAD_TESTID).contains(notice)).toBe(true);
    expect(precedes(row("m1"), notice)).toBe(true);
  });
});

// ══ THE ONE STATE THAT KEEPS THE PINNED STRIP ═══════════════════════════════════════════════════
// Mounted, `ConciergeThread` is not rendered at all — the column shows the AGENT's transcript — so
// there is no chat for a card to flow into and the choice is between the pinned strip and nothing.
// Nothing would be a silent regression exactly where the card is most useful, so the strip is kept
// for this state and this state only. Asserting it here is what stops the move from quietly
// deleting the surface on the mounted path.
describe("mounted, the card falls back to the pinned strip", () => {
  const mounted: ConciergeMountedAgent = {
    agentId: "agent-1",
    name: "Kraken Auth",
    thread: { ...EMPTY_MOUNTED_THREAD, entries: [], hasMore: false },
    onReachTop: vi.fn(),
  };

  it("still paints the card when the concierge thread is swapped out", () => {
    render(
      <ConciergeColumn
        model={model([FIRST])}
        controller={controller()}
        mentionAgents={ROSTER}
        mountedAgent={mounted}
        onOpenAgent={vi.fn(() => "revealed" as const)}
      />,
    );
    previewGoesLive();

    expect(screen.getByTestId(PREVIEW_CARD_TESTID)).toBeTruthy();
    // And the concierge scroller genuinely is not on screen — otherwise this test would be passing
    // on the in-thread surface and proving nothing about the fallback.
    expect(screen.queryByTestId(CONCIERGE_THREAD_TESTID)).toBeNull();
  });
});
