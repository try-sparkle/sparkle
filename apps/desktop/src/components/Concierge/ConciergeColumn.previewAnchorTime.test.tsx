// @vitest-environment jsdom
//
// A THREAD ARTIFACT PLACES ITSELF BY TIME — bead sparkle-75fbot.
//
// The preview card is an item in the transcript with "its own place in scroll history"
// (sparkle-0xbron, the founder twice). Which place was decided by a REF written the first time the
// component rendered: whichever message happened to be newest then. That is not a fact about when
// the preview arrived, it is a fact about when React ran — so it is lost on every unmount and
// unreproducible afterwards. `ConciergeMessage.arrivedAt` (written by
// `conciergeThreadStore.stampArrivals`) makes the position DERIVABLE instead:
// `threadArtifactAnchor.anchorableIdAt` asks which message had already arrived when the preview
// surfaced, and `PreviewCards.PreviewThreadArtifacts` is where that answer is captured.
//
// ══ WHY EACH TEST HERE IS THE NON-VACUOUS VERSION ══════════════════════════════════════════════
// `ConciergeColumn.previewInThread.test.tsx` already pins that the card is inside the scroller and
// that a LATER message draws below it — both were true of the ref, so neither can tell the two
// implementations apart. These four can:
//
//   1. REMOUNT. The card returns to the SAME message. The ref is gone by construction across an
//      unmount, and this is not a hypothetical: mounting a build agent swaps the concierge
//      transcript out entirely (see `PreviewCards`' header), so coming back re-captured the anchor
//      at the bottom of the conversation and the card visibly moved.
//   2. PERSIST/RESTORE. The same position after the thread has been through
//      `persistableThread`/`rehydrateThread` — every id rewritten, only the stamps surviving. This
//      is the property the bead names, and the one a ref cannot have.
//   3. VOLATILE KINDS. The derived anchor still refuses `nudge`/`digest`, which retire.
//   4. NO STAMPS AT ALL. A thread restored from a build that predates the field still places the
//      card by the pre-existing rule.
//
// jsdom never lays out (AGENTS.md), so every assertion here is on DOM ORDER, never on geometry.
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
import { PREVIEW_CARD_TESTID } from "./PreviewCards";
import { NUDGE_CARD_TESTID } from "./NudgeCard";
import { applyPreviewStatus } from "../../services/preview";
import { usePreviewStore } from "../../stores/previewStore";
import { useProjectStore } from "../../stores/projectStore";
import { persistableThread, rehydrateThread } from "../../stores/conciergeThreadStore";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";
import type { ConciergeController, ConciergeMessage, ConciergeViewModel } from "./types";
import type { MentionAgent } from "./mentions";

const KRAKEN = "ag-kraken";

/** Three instants, far enough apart that no clock skew in the test can reorder them. */
const T_EARLY = 1_000_000;
const T_SURFACED = 2_000_000;
const T_LATE = 3_000_000;

const EARLY: ConciergeMessage = {
  id: "m1",
  kind: "you",
  text: "Retry the failing one",
  arrivedAt: T_EARLY,
};
const LATE: ConciergeMessage = {
  id: "m2",
  kind: "you",
  text: "And rerun the shell suite",
  arrivedAt: T_LATE,
};

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

/**
 * Drive the REAL surfacing path (`applyPreviewStatus` → `previewStore.setPreview`) with the clock
 * pinned, so `surfacedAt` is the instant this test names rather than whatever `Date.now()` says.
 *
 * Through the production writer on purpose: `surfacedAt` is stamped only on the TRANSITION into a
 * surfacing state (see `previewStore.PreviewEntry`), and seeding the store by hand would prove the
 * anchor reads a field without proving anything writes it.
 */
function previewGoesLiveAt(at: number) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(at);
  try {
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
  } finally {
    clock.mockRestore();
  }
}

const column = (messages: ConciergeMessage[]) => (
  <ConciergeColumn
    model={model(messages)}
    controller={controller()}
    mentionAgents={ROSTER}
    onOpenAgent={vi.fn(() => "revealed" as const)}
  />
);

/** DOM order, read off the document itself: true when `a` comes strictly before `b`. */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!;
const card = () => screen.getByTestId(PREVIEW_CARD_TESTID);

beforeEach(() => {
  enableAiEnhancementsForTests();
  usePreviewStore.setState({ byAgent: {}, capability: {}, openedProjects: {} });
  useProjectStore.setState({
    projects: [{ id: "p1", name: "sparkle", agents: [{ id: KRAKEN, name: "Kraken Auth" }] }],
    selectedProjectId: "p1",
  } as never);
});
afterEach(cleanup);

describe("the card lands where the preview happened, not where the render did", () => {
  it("anchors under the newest message that had ALREADY ARRIVED when it surfaced", () => {
    // `m2` is in the transcript before the card ever renders, and it arrived AFTER the preview
    // surfaced. The old rule ("the newest message right now") anchored under it; the card then drew
    // below a message that post-dates it.
    render(column([EARLY, LATE]));
    previewGoesLiveAt(T_SURFACED);

    expect(precedes(row("m1"), card())).toBe(true);
    expect(precedes(card(), row("m2"))).toBe(true);
  });

  it("returns to the SAME message after an unmount — the ref cannot", () => {
    render(column([EARLY, LATE]));
    previewGoesLiveAt(T_SURFACED);
    expect(precedes(card(), row("m2"))).toBe(true);

    // What mounting a build agent does to this component: the whole concierge transcript is swapped
    // out, so the anchor ref goes with it. The preview itself keeps running — `previewStore` is
    // untouched here, exactly as it is untouched by that swap.
    cleanup();
    render(column([EARLY, LATE]));

    expect(precedes(row("m1"), card())).toBe(true);
    expect(precedes(card(), row("m2"))).toBe(true);
  });

  it("does not move as the conversation grows after it appeared", () => {
    // The founder's original complaint, restated as an invariant: a card that re-anchors on every
    // render is a card pinned to the bottom of the transcript.
    const { rerender } = render(column([EARLY]));
    previewGoesLiveAt(T_SURFACED);
    expect(precedes(row("m1"), card())).toBe(true);

    rerender(column([EARLY, LATE]));
    expect(precedes(row("m1"), card())).toBe(true);
    expect(precedes(card(), row("m2"))).toBe(true);
  });
});

describe("the position survives the thread's persist/restore round trip", () => {
  it("lands after the same conversation turn once every id has been rewritten", () => {
    // THE PROPERTY THE BEAD IS ABOUT. `rehydrateThread` renames every message by position, so the
    // id the ref would have held names nothing after a relaunch. The stamps are the only thing that
    // crosses, and they are enough.
    const restored = rehydrateThread(persistableThread([EARLY, LATE]));
    const [first, second] = [restored[0]!, restored[1]!];
    // Guard the fixture itself: if the round trip stopped carrying stamps, the assertions below
    // would still pass by the no-stamp fallback and prove nothing.
    expect(first.arrivedAt).toBe(T_EARLY);
    expect(second.arrivedAt).toBe(T_LATE);
    expect(first.id).not.toBe(EARLY.id);

    render(column(restored));
    previewGoesLiveAt(T_SURFACED);

    expect(precedes(row(first.id), card())).toBe(true);
    expect(precedes(card(), row(second.id))).toBe(true);
  });
});

describe("the rules the derivation must not break", () => {
  it("never anchors to a nudge, which is a projection that retires", () => {
    // A nudge is the NEWEST entry in the transcript and carries no stamp of its own — the shape most
    // likely to be picked up by a naive "walk back to the first message at or before `at`".
    const nudge: ConciergeMessage = {
      id: "nudge-1",
      kind: "nudge",
      band: "needs_you",
      projectName: "sparkle",
      agentName: "Kraken Auth",
      text: "Approve? — Kraken Auth in sparkle.",
      actions: [],
    };
    render(column([EARLY, nudge]));
    previewGoesLiveAt(T_SURFACED);

    // Anchored to the conversation turn, so it draws ABOVE the nudge. Anchored to the nudge it would
    // draw below it — and would jump to the top of the transcript the moment the nudge retired.
    expect(precedes(row("m1"), card())).toBe(true);
    expect(precedes(card(), screen.getByTestId(NUDGE_CARD_TESTID))).toBe(true);
  });

  it("falls back to the newest message when the thread carries no stamps at all", () => {
    // A thread persisted by a build that predates `arrivedAt`. With nothing to compare, the walk
    // collapses to the pre-existing rule — the card sits under the newest turn, where it always did.
    const legacy: ConciergeMessage[] = [
      { id: "m1", kind: "you", text: "Retry the failing one" },
      { id: "m2", kind: "you", text: "And rerun the shell suite" },
    ];
    render(column(legacy));
    previewGoesLiveAt(T_SURFACED);

    expect(precedes(row("m2"), card())).toBe(true);
  });

  it("still places a card that surfaced before anything was said at the very top", () => {
    // Nothing had arrived when it surfaced, so there is nothing for it to be under — the same answer
    // an empty conversation already got, now reached by comparing times.
    render(column([LATE]));
    previewGoesLiveAt(T_SURFACED);

    expect(precedes(card(), row("m2"))).toBe(true);
  });
});
