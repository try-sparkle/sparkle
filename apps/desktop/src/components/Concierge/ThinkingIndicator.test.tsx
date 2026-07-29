// @vitest-environment jsdom
//
// The thinking indicator. The founder asked for more than three dots; the constraint on "more" is
// that every word of it be something the app OBSERVED. These tests are mostly about the cases where
// it must say less: no turn, no activity, or activity that belongs to a different turn.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  THINKING_ACTIVITY_TESTID,
  THINKING_INDICATOR_TESTID,
  ThinkingIndicator,
} from "./ThinkingIndicator";
import {
  _resetConciergeActivityForTests,
  noteConciergeToolCall,
} from "../../services/conciergeActivity";
import { useProjectStore } from "../../stores/projectStore";

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  _resetConciergeActivityForTests();
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
