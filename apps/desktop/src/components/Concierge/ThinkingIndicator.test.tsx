// @vitest-environment jsdom
//
// The thinking indicator. The founder asked for more than three dots; the constraint on "more" is
// that every word of it be something the app OBSERVED. These tests are mostly about the cases where
// it must say less: no turn, no activity, or activity that belongs to a different turn.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NO_ANSWER_YET_LABEL,
  THINKING_ACTIVITY_TESTID,
  THINKING_ELAPSED_TESTID,
  THINKING_INDICATOR_TESTID,
  ThinkingIndicator,
} from "./ThinkingIndicator";
import {
  _resetConciergeActivityForTests,
  noteConciergeToolCall,
} from "../../services/conciergeActivity";
import {
  ELAPSED_COUNTER_AFTER_MS,
  OFFLINE_AFTER_MS,
} from "../../engine/conciergeLiveness";
import {
  _resetConciergeLivenessForTests,
  noteConciergeSent,
  noteConciergeSettled,
} from "../../services/conciergeLiveness";
import { useProjectStore } from "../../stores/projectStore";

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  _resetConciergeActivityForTests();
  // The row now reads the liveness detector too, and that store is a module singleton that outlives
  // render() — without this, one case's outstanding turn is the next case's elapsed counter.
  _resetConciergeLivenessForTests();
});
afterEach(() => cleanup());

function indicator(): HTMLElement | null {
  return document.querySelector(`[data-testid="${THINKING_INDICATOR_TESTID}"]`);
}
function activityText(): string | null {
  return document.querySelector(`[data-testid="${THINKING_ACTIVITY_TESTID}"]`)?.textContent ?? null;
}

describe("ThinkingIndicator", () => {
  it("renders nothing at all when no turn is in flight", () => {
    render(<ThinkingIndicator typing={false} />);
    expect(indicator()).toBeNull();
  });

  // THE HONEST FALLBACK. A turn that thinks and calls no tools has nothing to report, and the right
  // answer is the pulse it always showed — not an invented status line.
  it("shows the bare pulse when the concierge has done nothing observable", () => {
    render(<ThinkingIndicator typing />);
    expect(indicator()).not.toBeNull();
    expect(activityText()).toBeNull();
    expect(indicator()?.querySelector(".sparkle-pulse")?.textContent).toBe("…");
    // Nothing to announce, so nothing is announced: the bare pulse stays decorative.
    expect(indicator()?.getAttribute("aria-hidden")).toBe("true");
    // The name this row has always carried. Several suites outside this file identify the indicator
    // by it, so the fallback must keep it.
    expect(indicator()?.getAttribute("aria-label")).toBe("Sparkle is typing");
  });

  it("says what the concierge is doing once it calls a tool", () => {
    const { rerender } = render(<ThinkingIndicator typing />);
    noteConciergeToolCall("terminal", "read_agent_terminal", { agentId: "gone" });
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Reading an agent's terminal");
    // A real sentence IS worth announcing — it changes once per tool call, not per token, so it
    // carries none of the flooding risk that kept the thread itself off a live region.
    expect(indicator()?.getAttribute("aria-live")).toBe("polite");
    expect(indicator()?.getAttribute("aria-hidden")).toBeNull();
    // …and what is announced is the line itself, not the generic "typing" underneath it.
    expect(indicator()?.getAttribute("aria-label")).toBe("Reading an agent's terminal");
  });

  it("keeps the pulse beside the line, so a settled call still reads as ongoing", () => {
    const { rerender } = render(<ThinkingIndicator typing />);
    const settle = noteConciergeToolCall("workflow", "merge_pr", { number: 753 });
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Merging PR #753");

    settle(true);
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Merged PR #753");
    expect(indicator()?.querySelector(".sparkle-pulse")).not.toBeNull();
  });

  // A refused call — a policy denial, or an ask-tier tool whose approval card is on screen right
  // now — must read as an attempt. The past tense there would have the column announcing the merge
  // directly above the request asking whether to allow it.
  it("reads a refused call as an attempt, not as something that happened", () => {
    const { rerender } = render(<ThinkingIndicator typing />);
    const settle = noteConciergeToolCall("workflow", "merge_pr", { number: 753 });
    settle(false);
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Tried merging PR #753");
  });

  // THE STALENESS GUARD, and the reason the store hands out a `seq` at all. A proactive push calls
  // tools with no typing indicator of its own, and the previous turn's last call outlives it — so
  // without this the column would present an old action as what it is doing about the message the
  // user just sent.
  it("ignores activity recorded before this turn began", () => {
    const { rerender } = render(<ThinkingIndicator typing={false} />);
    noteConciergeToolCall("terminal", "read_agent_terminal", {});

    rerender(<ThinkingIndicator typing />); // the user sends: a NEW turn starts
    expect(indicator()).not.toBeNull();
    expect(activityText()).toBeNull();

    // A call made during THIS turn does show.
    noteConciergeToolCall("workspace", "list_projects", {});
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Looking over your projects");
  });

  // The floor is snapshotted on the false→true edge, not on every render — otherwise it would keep
  // moving past calls that had already arrived and the line would never appear.
  it("does not re-snapshot the floor on a re-render mid-turn", () => {
    const { rerender } = render(<ThinkingIndicator typing />);
    noteConciergeToolCall("workspace", "list_projects", {});
    rerender(<ThinkingIndicator typing />);
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Looking over your projects");
  });

  // A second turn must not inherit the first turn's last line.
  it("drops the line again when the next turn starts with nothing to report", () => {
    const { rerender } = render(<ThinkingIndicator typing />);
    noteConciergeToolCall("workspace", "list_projects", {});
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Looking over your projects");

    rerender(<ThinkingIndicator typing={false} />); // the turn finishes
    rerender(<ThinkingIndicator typing />); // and the user sends again
    expect(activityText()).toBeNull();
  });

  // A tool the phrase table has no sentence for still shows its own name, but a domain the app does
  // not recognise has nothing truthful to say and falls back to the pulse.
  it("falls back to the pulse for an unrecognised domain", () => {
    const { rerender } = render(<ThinkingIndicator typing />);
    noteConciergeToolCall("filesystem", "rm_rf", {});
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBeNull();
    expect(indicator()?.querySelector(".sparkle-pulse")).not.toBeNull();
  });
});

// ── HOW LONG YOU HAVE BEEN WAITING ──────────────────────────────────────────────────────────────
//
// The pulse alone could not tell "thinking hard" from "this turn died and nothing will ever arrive",
// and on 2026-07-29 the second case happened 149 times without the column changing at all. These
// rows are the timing half; the thresholds themselves are argued and tested in
// engine/conciergeLiveness.
describe("ThinkingIndicator — the wait", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function elapsedText(): string | null {
    return document.querySelector(`[data-testid="${THINKING_ELAPSED_TESTID}"]`)?.textContent ?? null;
  }

  /** Let the liveness ticker run, which is what advances both the clock and the escalation. */
  function wait(ms: number, rerender: (ui: React.ReactElement) => void) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
    rerender(<ThinkingIndicator typing />);
  }

  it("says nothing about time for the first few seconds", () => {
    noteConciergeSent();
    const { rerender } = render(<ThinkingIndicator typing />);
    wait(ELAPSED_COUNTER_AFTER_MS - 1_000, rerender);
    expect(elapsedText()).toBeNull();
  });

  // FACTUAL, NOT A CLAIM. A counter cannot be wrong, so it may appear early — which is what the
  // "show me something within a few seconds" instinct actually wants. Asserting a status that early
  // would be a guess, and the measured median turn is ~54s.
  it("states the elapsed time once there is some", () => {
    noteConciergeSent();
    const { rerender } = render(<ThinkingIndicator typing />);
    wait(ELAPSED_COUNTER_AFTER_MS + 2_000, rerender);
    expect(elapsedText()).toContain("7s");
    // Still just waiting — no alarm, no claim about the brain.
    expect(indicator()?.textContent).not.toContain(NO_ANSWER_YET_LABEL);
    expect(indicator()?.getAttribute("data-liveness")).toBe("waiting");
  });

  it("says plainly that nothing has come back once the silence is long enough", () => {
    noteConciergeSent();
    const { rerender } = render(<ThinkingIndicator typing />);
    wait(OFFLINE_AFTER_MS, rerender);
    expect(indicator()?.textContent).toContain(NO_ANSWER_YET_LABEL);
    expect(indicator()?.getAttribute("data-liveness")).toBe("offline");
    // Announced: it changes at most twice a turn, and it is the only notice a non-sighted user gets
    // that their question has gone nowhere. (The bare counter is NOT — it changes every second.)
    expect(indicator()?.getAttribute("aria-live")).toBe("polite");
    expect(indicator()?.getAttribute("aria-label")).toContain(NO_ANSWER_YET_LABEL);
  });

  // A tool call RESETS the silence clock, so a stale activity line beside "No answer yet" would read
  // as work still in progress — the one thing we have just established we cannot vouch for.
  it("drops the stale activity line once it goes silent", () => {
    noteConciergeSent();
    const { rerender } = render(<ThinkingIndicator typing />);
    // AFTER the first render: the row snapshots an activity floor when a turn starts, so a call
    // recorded before it mounted belongs to the previous turn and is correctly ignored.
    act(() => noteConciergeToolCall("terminal", "read_agent_terminal", { agentId: "gone" }));
    rerender(<ThinkingIndicator typing />);
    expect(activityText()).toBe("Reading an agent's terminal");

    // Measured from the TOOL CALL, which reset the silence clock — that reset is the whole reason a
    // 20s threshold is safe for turns whose median duration is ~54s.
    wait(OFFLINE_AFTER_MS, rerender);
    expect(activityText()).toBeNull();
    expect(indicator()?.textContent).toContain(NO_ANSWER_YET_LABEL);
  });

  // "Recovering must clear the state promptly" — in the same commit, not on the next tick.
  it("goes back to normal the instant the turn answers", () => {
    noteConciergeSent();
    const { rerender } = render(<ThinkingIndicator typing />);
    wait(OFFLINE_AFTER_MS, rerender);
    expect(indicator()?.textContent).toContain(NO_ANSWER_YET_LABEL);

    act(() => noteConciergeSettled());
    rerender(<ThinkingIndicator typing />);
    expect(indicator()?.textContent).not.toContain(NO_ANSWER_YET_LABEL);
    expect(elapsedText()).toBeNull();
  });

  // The name several suites outside this file identify the row by, kept EXACTLY while there is
  // nothing else to say.
  it("keeps its original accessible name when nothing has happened yet", () => {
    render(<ThinkingIndicator typing />);
    expect(indicator()?.getAttribute("aria-label")).toBe("Sparkle is typing");
  });
});
