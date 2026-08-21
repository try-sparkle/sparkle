// @vitest-environment jsdom
//
// THE PROP HAND-OFF, driven through the PRODUCTION mount (roborev 66443).
//
// `ConciergeColumn` builds `<ThreadScrubber … failed={scrubber.failed} />` at its `rail` slot. That
// one attribute is the entire path from "the history query rejected" to "the reader is told" — and
// before this file it was covered by nothing: the hook's flag had tests, the label's branch had a
// mutation check, and the LINE JOINING THEM could be deleted with the whole suite green.
//
// That is not a hypothetical gap; it is the shape of this branch's worst bug. Both Tauri commands
// the rail depends on were missing from `generate_handler!` for four commits — every query
// rejected, the view layer was fully tested, and the WIRE was not. So this asserts through the real
// component, not a copy of its JSX.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConciergeColumn } from "./ConciergeColumn";
import { THREAD_SCRUBBER_TESTID } from "./ThreadScrubber";
import type { ThreadScrubberController } from "./useThreadScrubber";
import type { ConciergeController, ConciergeViewModel } from "./types";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";

afterEach(() => cleanup());

const noop = () => {};

/** The same shape ConciergeColumn.test.tsx builds — a column with a real vitals block and a turn
 *  of conversation, so the rail is rendered in the tree the founder actually sees. */
function model(): ConciergeViewModel {
  return {
    scope: {},
    vitals: { needs_you: 0, questions: 0, running: 1, done: 0 },
    messages: [
      { id: "m1", kind: "sparkle", text: "Morning — I'm watching every open project." },
      { id: "m2", kind: "you", text: "Thanks, keep me posted." },
    ],
  } as unknown as ConciergeViewModel;
}

function controller(): ConciergeController {
  return {
    onSend: vi.fn(),
    onAttach: vi.fn(),
    onNudgeClick: vi.fn(),
    onNudgeAction: vi.fn(),
  } as unknown as ConciergeController;
}

function scrubber(failed: boolean): ThreadScrubberController {
  return {
    markers: [], scope: "1h", setScope: noop, now: 1_700_000_000_000,
    position: 1, onSeek: noop, onPick: noop, loading: false, failed,
  };
}

function handle(): HTMLElement {
  return screen.getByTestId(`${THREAD_SCRUBBER_TESTID}-handle`);
}

describe("ConciergeColumn hands the rail its failed state", () => {
  it("mounts the rail at all", () => {
    enableAiEnhancementsForTests();
    render(<ConciergeColumn model={model()} controller={controller()} scrubber={scrubber(false)} />);
    expect(screen.getByTestId(THREAD_SCRUBBER_TESTID)).toBeTruthy();
  });

  it("a rejected query reaches the rail's own label through the column", () => {
    enableAiEnhancementsForTests();
    render(<ConciergeColumn model={model()} controller={controller()} scrubber={scrubber(true)} />);
    expect(handle().getAttribute("aria-label")).toContain("could not read your history");
  });

  // THE PAIR. Without it a column that hard-coded `failed` would pass the row above.
  it("…and an ordinary empty window still says 'no prompts'", () => {
    enableAiEnhancementsForTests();
    render(<ConciergeColumn model={model()} controller={controller()} scrubber={scrubber(false)} />);
    expect(handle().getAttribute("aria-label")).toContain("no prompts");
  });
});
