// @vitest-environment jsdom
//
// BOTH THREADS MUST CARRY `data-concierge-scroller` — the handle ComposeBox measures its drag
// ceiling against.
//
// WHY THIS TEST EXISTS AT ALL. The column swaps `ConciergeThread` for `MountedAgentThread` when the
// concierge is mounted to a build agent, so the composer cannot look for one component's testid: for
// the whole mounted session it would find nothing and fall back to `window.innerHeight`, which clips
// the Send row off the bottom (roborev 53572/53586). The shared marker is what makes its query
// component-agnostic.
//
// It is asserted here because the marker was ALREADY LOST ONCE, by a merge that took the other
// side's JSX for the scroller verbatim. Nothing caught it: the composer's selector is a union that
// still falls through to the testid, so the invariant was false while the behaviour was fine — the
// worst shape a regression can have, because the next person to simplify that selector reinstates a
// bug nobody can see coming (roborev 56359).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

import { ConciergeThread } from "./ConciergeThread";
import { MountedAgentThread, MOUNTED_THREAD_TESTID } from "./MountedAgentThread";
import { EMPTY_MOUNTED_THREAD } from "../../stores/mountedThreadStore";
import { CONCIERGE_THREAD_TESTID } from "../../engine/composeBoxHeight";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";

beforeEach(enableAiEnhancementsForTests);
afterEach(cleanup);

/** The exact selector `ComposeBox.findThread` uses for the marker half of its union. */
const MARKER = '[data-concierge-scroller="yes"]';

describe("the composer's thread handle", () => {
  it("is on the concierge thread's scroller", () => {
    const { container } = render(
      <ConciergeThread
        messages={[{ id: "m1", kind: "you", text: "hello" }]}
        onNudgeClick={vi.fn()}
        onNudgeAction={vi.fn()}
      />,
    );
    const marked = container.querySelector(MARKER);
    expect(marked).toBeTruthy();
    // …and it is the SCROLLER itself, not some wrapper — measuring a non-scrolling box would report
    // the wrong height just as silently as finding nothing.
    expect(marked).toBe(screen.getByTestId(CONCIERGE_THREAD_TESTID));
  });

  it("is on the mounted agent thread's scroller", () => {
    const { container } = render(
      <MountedAgentThread
        thread={{ ...EMPTY_MOUNTED_THREAD, entries: [] }}
        agentId="agent-1"
        agentName="Kraken Auth"
        onReachTop={vi.fn()}
      />,
    );
    const marked = container.querySelector(MARKER);
    expect(marked).toBeTruthy();
    expect(marked).toBe(screen.getByTestId(MOUNTED_THREAD_TESTID));
  });
});
