// @vitest-environment jsdom
//
// THE NAMED REGRESSION GUARD FOR bead sparkle-7m719, which the founder has asked for four times over
// sixteen days. His goal, verbatim in shape: *dragging to an old prompt actually loads and scrolls to
// it* — not *the rail draws*.
//
// So every assertion here is on the SIDE EFFECT, per AGENTS.md:
//   • a message id that was NOT in the DOM before the pick IS in the DOM after it, and
//   • `jumpTo` ran on THAT element (asserted through `scrollIntoView`'s receiver, not through a spy
//     on the loader).
// Asserting "loadBack was called" would pass against a version that loads the page and never
// scrolls, which is one of the two ways this feature has looked broken before.
//
// It drives the REAL wiring — `useConciergeScrubberWiring`, the same hook `ConciergeHost` calls —
// with only the two SQLite queries swapped, so the seq counter and the load-then-jump ordering under
// test are the production ones.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConciergeThread, BACKLOG_DIVIDER_TESTID, THREAD_RAIL_TESTID } from "./ConciergeThread";
import { useConciergeScrubberWiring, type RailMark } from "./useThreadScrubber";
import { setThreadScrubberIo } from "./useThreadScrubber";
import {
  setConciergeBacklogIo,
  useConciergeBacklogStore,
} from "../../stores/conciergeBacklogStore";
import { setConciergeChat } from "../../stores/conciergeThreadStore";
import type { HistoryRangeRow } from "../../services/history";
import type { ConciergeMessage } from "./types";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

/** The mark the stand-in rail commits. `fraction` is a CONTENT-axis position now (see
 *  railGeometry.ts) — 0 because a three-day-old prompt is at the top of everything loaded. */
const ANCIENT: RailMark = {
  id: "you-ancient",
  createdAt: NOW - 3 * DAY,
  textPrefix: "what did we decide about the rail",
  index: 1,
  fraction: 0,
};

/** The rows SQLite would return for that window — the ancient prompt and the reply to it. */
const ANCIENT_ROWS: HistoryRangeRow[] = [
  {
    id: "you-ancient",
    kind: "prompt",
    createdAt: NOW - 3 * DAY,
    text: "what did we decide about the rail",
  },
  {
    id: "brain-ancient",
    kind: "response",
    createdAt: NOW - 3 * DAY + 1000,
    text: "we decided it pages history in",
  },
];

const LIVE: ConciergeMessage[] = [{ id: "you-now", kind: "you", text: "today's question" }];

const noop = () => {};

/** Which elements `jumpTo` scrolled to, in order — recorded off the RECEIVER, so the test proves
 *  the scroll landed on the picked message rather than merely that some scroll happened. */
let scrolledTo: string[] = [];

/** The production wiring, plus a button that stands in for the rail's dot. */
function Harness({ messages = LIVE }: { messages?: ConciergeMessage[] } = {}) {
  const { backlog, jumpRequest, scrubber } = useConciergeScrubberWiring("7d");
  return (
    <ConciergeThread
      messages={messages}
      backlog={backlog}
      jumpRequest={jumpRequest}
      rail={
        <button data-testid="pick-ancient" onClick={() => scrubber.onPick(ANCIENT)}>
          dot
        </button>
      }
      onNudgeClick={noop}
      onNudgeAction={noop}
    />
  );
}

function bubble(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
}

function thread(): HTMLElement {
  const el = document.querySelector('[data-testid="concierge-thread"]');
  if (!el) throw new Error("thread not rendered");
  return el as HTMLElement;
}

/** Give the scroller a real scrollable geometry — jsdom lays nothing out. */
function makeScrollable(el: HTMLElement, scrollHeight = 1000, clientHeight = 200): void {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
}

function readerScrollsTo(el: HTMLElement, top: number): void {
  el.scrollTop = top;
  fireEvent.scroll(el);
}

/** Let the pick's `await loadBack(...)` and the render it causes settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  scrolledTo = [];
  // jsdom implements no scrollIntoView at all. Installed here rather than stubbed per element so the
  // RECEIVER is observable: `this` is the element the component chose to scroll to.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: function (this: HTMLElement) {
      scrolledTo.push(this.dataset.messageId ?? "(no id)");
    },
  });
  useConciergeBacklogStore.getState().clear();
  setConciergeChat([]);
  // EVERY LEG OF THE SEAM IS STUBBED, not just the one this file exercises. An unstubbed leg reaches
  // the real Tauri `invoke`, which rejects in jsdom — and the controller records that as `failed`,
  // so the rail under test would quietly be in its error state for reasons that have nothing to do
  // with what these rows are about.
  setThreadScrubberIo({
    now: () => NOW,
    promptsInRange: async () => [],
    promptDensity: async () => [],
    historyExtent: async () => ({ oldestMs: NOW - 30 * DAY, newestMs: NOW, count: 0 }),
  });
  setConciergeBacklogIo({ now: () => NOW, entriesInRange: async () => ANCIENT_ROWS });
});

afterEach(() => cleanup());

describe("picking a dot older than the live window", () => {
  it("loads the turn into the DOM and scrolls to it", async () => {
    render(<Harness />);
    await settle();

    // THE PRECONDITION, STATED. Without this the assertion below could be true of a thread that had
    // the message all along, which is the vacuous shape AGENTS.md warns about.
    expect(bubble("you-ancient")).toBeNull();

    fireEvent.click(screen.getByTestId("pick-ancient"));
    await settle();

    // ── THE SIDE EFFECT ──
    expect(bubble("you-ancient")).not.toBeNull();
    expect(bubble("you-ancient")!.textContent).toContain("what did we decide about the rail");
    expect(scrolledTo).toEqual(["you-ancient"]);
  });

  it("brings the REPLY in with it, not just the question", async () => {
    render(<Harness />);
    await settle();
    fireEvent.click(screen.getByTestId("pick-ancient"));
    await settle();

    // A paged-in window showing only the prompts is half a conversation.
    expect(bubble("brain-ancient")).not.toBeNull();
  });

  it("keeps the live thread on screen below the paged-in turns", async () => {
    render(<Harness />);
    await settle();
    fireEvent.click(screen.getByTestId("pick-ancient"));
    await settle();

    const ids = Array.from(
      thread().querySelectorAll<HTMLElement>("[data-message-id]"),
    ).map((el) => el.dataset.messageId);
    expect(ids).toEqual(["you-ancient", "brain-ancient", "you-now"]);
  });

  it("draws the seam between history and the live window", async () => {
    render(<Harness />);
    await settle();
    expect(screen.queryByTestId(BACKLOG_DIVIDER_TESTID)).toBeNull();

    fireEvent.click(screen.getByTestId("pick-ancient"));
    await settle();

    expect(screen.getByTestId(BACKLOG_DIVIDER_TESTID).textContent).toContain(
      "Earlier — loaded from history",
    );
  });

  // ── PICKING THE SAME DOT TWICE MUST SCROLL TWICE ─────────────────────────────────────────────
  // A bare `{ id }` is an Object.is-equal setState React bails out of, so the second click would do
  // nothing at all — the reader scrolls away, clicks the dot again, and the app ignores them.
  it("scrolls again when the same dot is picked a second time", async () => {
    render(<Harness />);
    await settle();

    fireEvent.click(screen.getByTestId("pick-ancient"));
    await settle();
    fireEvent.click(screen.getByTestId("pick-ancient"));
    await settle();

    expect(scrolledTo).toEqual(["you-ancient", "you-ancient"]);
  });

  it("does not re-query SQLite for a turn it has already paged in", async () => {
    let queries = 0;
    setConciergeBacklogIo({
      entriesInRange: async () => {
        queries++;
        return ANCIENT_ROWS;
      },
    });
    render(<Harness />);
    await settle();

    fireEvent.click(screen.getByTestId("pick-ancient"));
    await settle();
    const afterFirst = queries;
    fireEvent.click(screen.getByTestId("pick-ancient"));
    await settle();

    expect(afterFirst).toBe(1);
    expect(queries).toBe(1);
  });
});

// ── AUTO-FOLLOW MUST NOT STEAL THE JUMP ─────────────────────────────────────────────────────────
// The most likely way this ships looking broken: the reader picks a dot from three days ago, the
// thread scrolls there, and the next feed tick slams the column back to the bottom. Both halves are
// asserted — the prepend itself must not follow, and content arriving AFTER the jump must not either.
describe("auto-follow", () => {
  it("does not follow the bottom when older turns are prepended", async () => {
    render(<Harness />);
    await settle();
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 800); // pinned to the bottom: the follow is armed

    fireEvent.click(screen.getByTestId("pick-ancient"));
    await settle();

    // Armed + a contentKey change would write scrollTop = scrollHeight (1000). Folding `backlog`
    // into that key is exactly the mutation this catches.
    expect(el.scrollTop).toBe(800);
  });

  it("leaves the reader at the old message when new live content arrives after the jump", async () => {
    const { rerender } = render(<Harness />);
    await settle();
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 800);

    fireEvent.click(screen.getByTestId("pick-ancient"));
    await settle();
    // Where the smooth jump left them. jsdom performs no scrolling of its own, so the position is
    // set here to stand for "somewhere up in the history".
    el.scrollTop = 40;

    await act(async () => {
      rerender(
        <Harness
          messages={[...LIVE, { id: "brain-new", kind: "sparkle", text: "a fresh reply" }]}
        />,
      );
    });

    expect(el.scrollTop).toBe(40);
  });

  // The mirror: with NO jump in play, an armed reader must still be followed. Without this, the test
  // above passes for a thread whose auto-follow is simply broken.
  it("still follows the bottom for a reader who never jumped", async () => {
    const { rerender } = render(<Harness />);
    await settle();
    const el = thread();
    makeScrollable(el);
    readerScrollsTo(el, 800);

    await act(async () => {
      rerender(
        <Harness
          messages={[...LIVE, { id: "brain-new", kind: "sparkle", text: "a fresh reply" }]}
        />,
      );
    });

    expect(el.scrollTop).toBe(1000);
  });
});

describe("the rail column", () => {
  it("renders beside the scroller, and the scroller keeps its markers", async () => {
    render(<Harness />);
    await settle();

    expect(screen.getByTestId(THREAD_RAIL_TESTID)).toBeTruthy();
    const el = thread();
    expect(el.getAttribute("data-concierge-scroller")).toBe("yes");
    // BESIDE, not inside: a rail inside the scroller would scroll away with the transcript.
    expect(el.contains(screen.getByTestId(THREAD_RAIL_TESTID))).toBe(false);
  });

  it("adds no rail element at all when the caller passes none", () => {
    render(<ConciergeThread messages={LIVE} onNudgeClick={noop} onNudgeAction={noop} />);
    expect(screen.queryByTestId(THREAD_RAIL_TESTID)).toBeNull();
  });
});

describe("a bridge that cannot answer", () => {
  it("does not take out the pick handler", async () => {
    setConciergeBacklogIo({
      entriesInRange: async () => {
        throw new Error("bridge down");
      },
    });
    const onError = vi.fn();
    window.addEventListener("error", onError);
    render(<Harness />);
    await settle();

    fireEvent.click(screen.getByTestId("pick-ancient"));
    await settle();

    expect(useConciergeBacklogStore.getState().error).toBe("bridge down");
    // The jump still fires; it simply finds nothing, which is the honest outcome.
    expect(onError).not.toHaveBeenCalled();
    window.removeEventListener("error", onError);
  });
});
