// @vitest-environment jsdom
//
// THE MOUNTED PANE SHOWS *THAT AGENT'S* CONVERSATION — the bug this feature exists to fix.
//
// The founder's report: *"the mounted concierge is supposed to not show the regular chat history but
// instead show the terminal output when mounted. It's not doing that."*
//
// HOW THESE TESTS AVOID BEING VACUOUS — the #1 fleet-wide finding, and very easy to hit here.
// Asserting "the mounted column has messages" is ALREADY TRUE of the broken build: the concierge
// thread has messages too, which is exactly the bug. So every test below asserts a DISCRIMINATOR —
// a string that exists in ONE source and never in the other:
//
//   • CONCIERGE_ONLY lives in the concierge view-model and never in the transcript.
//   • TRANSCRIPT_ONLY lives in the transcript and never in the view-model.
//
// A build that renders the wrong thread fails on the absence assertion, not just the presence one.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("../BalanceBadge", () => ({ BalanceBadge: () => null }));

import { ConciergeColumn } from "./ConciergeColumn";
import { ACTIVITY_CHIP_ITEMS_TESTID, ACTIVITY_CHIP_TESTID } from "./ActivityChip";
import { MOUNTED_AGENT_TESTID, MOUNTED_HUMAN_TESTID, MOUNTED_THREAD_TESTID } from "./MountedAgentThread";
import { RESUME_PROMPT_MARKER } from "../../engine/agentOriginated";
import { filterSystemAuthored, type TranscriptEntry } from "../../services/agentTranscript";
import { EMPTY_MOUNTED_THREAD } from "../../stores/mountedThreadStore";
import { CONCIERGE_THREAD_TESTID } from "../../engine/composeBoxHeight";
import type { ConciergeController, ConciergeMountedAgent, ConciergeViewModel } from "./types";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";

beforeEach(enableAiEnhancementsForTests);
afterEach(cleanup);

/** In the Sparkle conversation ONLY. If this is on screen while mounted, the bug is back. */
const CONCIERGE_ONLY = "Retry the failing one across every project";
/** In the agent's transcript ONLY. If this is missing while mounted, the transcript is not shown. */
const TRANSCRIPT_ONLY = "Added retry.test.ts covering the 429 backoff";
/** The founder's own words to that agent, in the transcript only. */
const TRANSCRIPT_HUMAN = "add a test for the retry path";

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 0, running: 0, done: 0 },
  messages: [{ id: "m1", kind: "you", text: CONCIERGE_ONLY }],
};

const controller = (): ConciergeController => ({
  onSend: vi.fn(),
  onAttach: vi.fn(),
  onNudgeClick: vi.fn(),
  onNudgeAction: vi.fn(),
});

const entries: TranscriptEntry[] = [
  {
    kind: "human",
    id: "h1",
    text: TRANSCRIPT_HUMAN,
    timestamp: "2026-07-30T14:02:00.000Z",
    sessionId: "s1",
    promptSource: "typed",
    raw: "{}",
    cursor: { file: "/s1.jsonl", line: 0 },
  },
  {
    kind: "activity",
    id: "a1",
    summary: "read 3 files · edited retry.ts · ran 1 test",
    items: [
      { verb: "read", target: "src/retry.ts", detail: "84 lines" },
      { verb: "edited", target: "src/retry.test.ts", detail: "+31" },
      { verb: "ran", target: "npx vitest run retry", detail: "4 passed" },
    ],
    timestamp: "2026-07-30T14:02:01.000Z",
    endTimestamp: "2026-07-30T14:02:39.000Z",
    sessionId: "s1",
    raw: "{}",
    cursor: { file: "/s1.jsonl", line: 1 },
  },
  {
    kind: "agent",
    id: "g1",
    text: TRANSCRIPT_ONLY,
    timestamp: "2026-07-30T14:02:40.000Z",
    sessionId: "s1",
    raw: "{}",
    cursor: { file: "/s1.jsonl", line: 2 },
  },
];

function mountedAgent(over: Partial<ConciergeMountedAgent> = {}): ConciergeMountedAgent {
  return {
    agentId: "agent-1",
    name: "Kraken Auth",
    thread: { ...EMPTY_MOUNTED_THREAD, entries, hasMore: false },
    onReachTop: vi.fn(),
    ...over,
  };
}

function renderColumn(mounted: ConciergeMountedAgent | null) {
  return render(
    <ConciergeColumn
      model={model}
      controller={controller()}
      wired={mounted ? "right" : "off"}
      mountedAgent={mounted}
    />,
  );
}

describe("mounted — the pane shows the AGENT's conversation", () => {
  it("renders the agent's turns and NOT the Sparkle conversation", () => {
    renderColumn(mountedAgent());

    // Present: what only the transcript has.
    expect(screen.getByTestId(MOUNTED_THREAD_TESTID)).toBeTruthy();
    expect(screen.getByTestId(MOUNTED_HUMAN_TESTID).textContent).toContain(TRANSCRIPT_HUMAN);
    expect(screen.getByTestId(MOUNTED_AGENT_TESTID).textContent).toContain(TRANSCRIPT_ONLY);

    // ABSENT: what only the concierge has. THIS is the assertion the broken build fails — it
    // rendered the concierge thread, so this string was on screen.
    expect(screen.queryByText(CONCIERGE_ONLY)).toBeNull();
    expect(screen.queryByTestId(CONCIERGE_THREAD_TESTID)).toBeNull();
  });

  it("names the thread after the agent, not after Sparkle", () => {
    renderColumn(mountedAgent());
    // A screen reader told "Conversation with Sparkle" here would be told the exact untruth this
    // feature corrects, so the label is asserted rather than left to the visual test.
    expect(screen.getByLabelText("Conversation with Kraken Auth")).toBeTruthy();
    expect(screen.queryByLabelText("Conversation with Sparkle")).toBeNull();
  });

  it("collapses a stretch of tool work into ONE chip that expands to the calls", () => {
    renderColumn(mountedAgent());
    const chip = screen.getByTestId(ACTIVITY_CHIP_TESTID);
    expect(chip.textContent).toContain("read 3 files");
    // 38 seconds between the fold's first and last record.
    expect(chip.textContent).toContain("38s");

    // Collapsed by default — the individual calls are the noise the fold exists to remove.
    expect(screen.queryByTestId(ACTIVITY_CHIP_ITEMS_TESTID)).toBeNull();
    expect(screen.queryByText(/npx vitest run retry/)).toBeNull();

    fireEvent.click(chip);
    const items = screen.getByTestId(ACTIVITY_CHIP_ITEMS_TESTID);
    expect(items.textContent).toContain("src/retry.ts");
    expect(items.textContent).toContain("npx vitest run retry");
  });

  it("never renders Sparkle's auto-resume banner as if the founder had typed it", () => {
    const banner: TranscriptEntry = {
      kind: "human",
      id: "banner",
      text: `${RESUME_PROMPT_MARKER} automatically.`,
      timestamp: "2026-07-30T14:01:00.000Z",
      sessionId: "s1",
      promptSource: "typed",
      raw: "{}",
      cursor: { file: "/s1.jsonl", line: 0 },
    };
    // Through the real filter, exactly as the loader does — so this covers the wiring, not a
    // hand-filtered array that would prove nothing.
    const thread = {
      ...EMPTY_MOUNTED_THREAD,
      entries: filterSystemAuthored([banner, ...entries]),
    };
    renderColumn(mountedAgent({ thread }));

    expect(screen.queryByText(new RegExp(RESUME_PROMPT_MARKER))).toBeNull();
    // …while the real turn from the same session survives. Without this the test would also pass on
    // a filter that dropped everything.
    expect(screen.getByTestId(MOUNTED_HUMAN_TESTID).textContent).toContain(TRANSCRIPT_HUMAN);
  });

  it("marks a terminal-typed message's provenance, and stays silent when it cannot tell", () => {
    const unknown: TranscriptEntry = { ...entries[0]!, id: "h2", promptSource: null } as TranscriptEntry;
    renderColumn(mountedAgent({ thread: { ...EMPTY_MOUNTED_THREAD, entries: [entries[0]!, unknown] } }));
    const marks = screen.getAllByText("· terminal");
    // Exactly ONE mark for two bubbles: a guessed provenance is worse than none (AGENTS.md's
    // `agentId: null` means UNKNOWN convention), so the second renders no mark at all.
    expect(marks).toHaveLength(1);
  });
});

describe("unmount — the Sparkle conversation comes back intact", () => {
  it("restores the concierge thread and drops the agent thread", () => {
    const { rerender } = renderColumn(mountedAgent());
    expect(screen.queryByText(CONCIERGE_ONLY)).toBeNull();

    rerender(
      <ConciergeColumn model={model} controller={controller()} wired="off" mountedAgent={null} />,
    );

    expect(screen.getByTestId(CONCIERGE_THREAD_TESTID)).toBeTruthy();
    expect(screen.getByText(CONCIERGE_ONLY)).toBeTruthy();
    expect(screen.queryByTestId(MOUNTED_THREAD_TESTID)).toBeNull();
    expect(screen.queryByText(TRANSCRIPT_ONLY)).toBeNull();
  });

  it("keeps each conversation's DRAFT with its own conversation", () => {
    const { rerender } = renderColumn(null);
    const box = () => screen.getByLabelText("Message") as HTMLTextAreaElement;

    fireEvent.change(box(), { target: { value: "half-typed note to Sparkle" } });
    expect(box().value).toBe("half-typed note to Sparkle");

    // Mount: the box is now addressed to the AGENT, so Sparkle's draft must not be sitting in it —
    // one Enter away from being sent to the wrong reader.
    rerender(
      <ConciergeColumn
        model={model}
        controller={controller()}
        wired="right"
        mountedAgent={mountedAgent()}
      />,
    );
    expect(box().value).toBe("");
    fireEvent.change(box(), { target: { value: "note to the agent" } });

    // Unmount: Sparkle's draft comes back, exactly as it was.
    rerender(
      <ConciergeColumn model={model} controller={controller()} wired="off" mountedAgent={null} />,
    );
    expect(box().value).toBe("half-typed note to Sparkle");

    // …and re-mounting brings the agent's own draft back rather than losing it.
    rerender(
      <ConciergeColumn
        model={model}
        controller={controller()}
        wired="right"
        mountedAgent={mountedAgent()}
      />,
    );
    expect(box().value).toBe("note to the agent");
  });
});
