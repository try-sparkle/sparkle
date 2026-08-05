// @vitest-environment jsdom
//
// ONE STATUS, ONE PLACE — the rail says the general thing, the bubble says its own.
//
// THE COMPLAINT: *"You're doing a new thing where you're giving me an update in the left side of the
// chat window but then ALSO below the message itself… I don't need to see it twice."*
//
// The rule he stated, and the whole content of this file:
//
//   • THE LEFT RAIL (`ThinkingIndicator`, at the foot of the column beside the compose box) is for
//     GENERAL updates — anything about the concierge as a whole that is not about any one message.
//   • UNDER A MESSAGE is where anything SPECIFIC to that message goes, and nowhere else.
//   • No status string appears in BOTH. That duplication is the bug.
//   • The little glyph the rail draws is the one thing he DID want in both places: *"I like how on
//     the left side it gives me a little icon, I'd like to see that icon on the right side as well."*
//
// WHY IT DUPLICATED: exactly two surfaces render `engine/conciergeActivityLine` — this rail, which
// recomputes it from `services/conciergeActivity`, and `services/conciergeMessageStatuses`, which
// pins the same global `latest` entry onto the awaited bubble. One line, one store, two renderers,
// no coordination between them. So the thread — the ONE component that renders both — is where the
// non-duplication invariant can actually be guaranteed, and where it is asserted.
//
// THE ASSERTIONS ARE ABOUT THE PAIR, deliberately. A test that only checked "the status is under the
// bubble" passed before this change and proves nothing (AGENTS.md's #1 fleet-wide finding); every
// case below counts the phrase across the WHOLE thread, so a second copy anywhere fails it.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentPillProvider } from "./AgentPill";
import { ConciergeThread } from "./ConciergeThread";
import { MESSAGE_STATUS_TESTID, type ConciergeMessageStatusText } from "./MessageStatus";
import { THINKING_ACTIVITY_TESTID, THINKING_INDICATOR_TESTID } from "./ThinkingIndicator";
import {
  _resetConciergeActivityForTests,
  noteConciergeToolCall,
} from "../../services/conciergeActivity";
import { _resetConciergeLivenessForTests } from "../../services/conciergeLiveness";
import { useProjectStore } from "../../stores/projectStore";
import type { ConciergeMessage } from "./types";

/** What `noteConciergeToolCall("terminal", "read_agent_terminal", …)` phrases to. Taken from
 *  ThinkingIndicator.test.tsx rather than invented, so both suites are pinned to the same phrase and
 *  a wording change breaks them together instead of leaving this one asserting a dead string. */
const LINE = "Reading an agent's terminal";

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  _resetConciergeActivityForTests();
  _resetConciergeLivenessForTests();
});
afterEach(() => cleanup());

function messages(): ConciergeMessage[] {
  return [
    { id: "u1", kind: "you", text: "what needs me?" },
    { id: "u2", kind: "you", text: "and the other project?" },
  ];
}

function draw(statuses?: Record<string, ConciergeMessageStatusText>) {
  return render(
    <ConciergeThread
      messages={messages()}
      typing
      turnFloor={-1}
      statuses={statuses}
      onNudgeClick={() => {}}
      onNudgeAction={() => {}}
    />,
  );
}

function rail(): HTMLElement | null {
  return document.querySelector(`[data-testid="${THINKING_INDICATOR_TESTID}"]`);
}
function railWords(): string | null {
  return document.querySelector(`[data-testid="${THINKING_ACTIVITY_TESTID}"]`)?.textContent ?? null;
}
/** The drawn glyph, as a shape rather than a component name: two different Feather icons have
 *  different `innerHTML` (polylines, paths, circles), and comparing that is the only way to say
 *  "the SAME icon" across two components without asserting an import. */
function glyph(el: Element | null): string {
  return el?.querySelector("svg")?.innerHTML ?? "";
}

/** A live tool call, recorded before render so the first paint already has it. */
function callTerminal() {
  noteConciergeToolCall("terminal", "read_agent_terminal", { agentId: "gone" });
}

describe("the running message's line is SPECIFIC, so only the bubble says it", () => {
  it("renders the phrase exactly ONCE in the whole thread", () => {
    callTerminal();
    draw({ u1: { text: LINE, live: true, icon: "terminal" } });
    // THE assertion. Before this change the rail recomputed the same line from the same store and
    // this returned two nodes — a status the founder read twice for every tool call.
    expect(screen.getAllByText(LINE)).toHaveLength(1);
  });

  it("and the one copy is under the bubble, not in the rail", () => {
    callTerminal();
    draw({ u1: { text: LINE, live: true, icon: "terminal" } });
    const status = screen.getByTestId(MESSAGE_STATUS_TESTID);
    expect(status.textContent).toBe(LINE);
    expect(document.querySelector(`[data-message-id="u1"]`)!.contains(status)).toBe(true);
    // The rail's word-carrying node is GONE, not merely empty — an emptied span would still reserve
    // its gap in the row and read as a status that lost its text.
    expect(railWords()).toBeNull();
    expect(document.querySelector(`[data-testid="${THINKING_ACTIVITY_TESTID}"]`)).toBeNull();
  });

  it("yields the WORDS, not the row: the rail keeps its pulse and its glyph", () => {
    callTerminal();
    draw({ u1: { text: LINE, live: true, icon: "terminal" } });
    // The rail is still there saying the general thing — "something is happening" — which is exactly
    // what the founder reserved it for. Suppressing the whole row would have removed the only
    // signal that a turn is in flight at all.
    expect(rail()).not.toBeNull();
    expect(rail()?.querySelector(".sparkle-pulse")?.textContent).toBe("…");
    expect(glyph(rail())).not.toBe("");
  });

  it("says nothing aloud from the rail once the words have moved", () => {
    callTerminal();
    draw({ u1: { text: LINE, live: true, icon: "terminal" } });
    // With no text of its own the row is decoration again, exactly as the bare pulse always was.
    // Leaving `aria-live` on a row whose content just vanished announces the DISAPPEARANCE.
    expect(rail()?.getAttribute("aria-hidden")).toBe("true");
    expect(rail()?.getAttribute("aria-live")).toBeNull();
    expect(rail()?.getAttribute("aria-label")).toBe("Sparkle is typing");
  });
});

describe("the GENERAL case is untouched — the rail still owns an unclaimed line", () => {
  it("carries the words itself when no message is showing them", () => {
    // A turn with no bubble to attach to (relayFollowUp and friends): the line is about the
    // concierge as a whole, which is precisely what the rail is for.
    callTerminal();
    draw();
    expect(railWords()).toBe(LINE);
    expect(screen.queryByTestId(MESSAGE_STATUS_TESTID)).toBeNull();
    expect(screen.getAllByText(LINE)).toHaveLength(1);
  });

  it("is not silenced by a QUEUED message's position line", () => {
    // "3rd in line" is a fact about the queue, not the activity line — it is not the rail's phrase,
    // so it makes no claim on it. Only the LIVE status carries the observed line.
    callTerminal();
    draw({ u2: { text: "3rd in line" } });
    expect(railWords()).toBe(LINE);
    expect(screen.getByTestId(MESSAGE_STATUS_TESTID).textContent).toBe("3rd in line");
  });
});

describe("the glyph is the one thing that IS in both places", () => {
  it("draws the rail's own icon under the message", () => {
    callTerminal();
    draw({ u1: { text: LINE, live: true, icon: "terminal" } });
    const under = glyph(screen.getByTestId(MESSAGE_STATUS_TESTID));
    expect(under).not.toBe("");
    expect(under).toBe(glyph(rail()));
  });

  it("and a different icon really is a different glyph", () => {
    // Without this the equality above would hold for any two icons — including a world where every
    // key resolved to one glyph — and would prove nothing about the mapping.
    callTerminal();
    draw({ u1: { text: LINE, live: true, icon: "terminal" } });
    const terminal = glyph(screen.getByTestId(MESSAGE_STATUS_TESTID));
    cleanup();
    callTerminal();
    draw({ u1: { text: LINE, live: true, icon: "agents" } });
    expect(glyph(screen.getByTestId(MESSAGE_STATUS_TESTID))).not.toBe(terminal);
  });

  it("draws no glyph for a status that has no icon", () => {
    // A queue position is not an observed tool call and has no domain — inventing a glyph for it
    // would be this component deriving a signal the producer never gave it.
    callTerminal();
    draw({ u2: { text: "Next up" } });
    expect(glyph(screen.getByTestId(MESSAGE_STATUS_TESTID))).toBe("");
  });
});

/**
 * AND SO IS THE AGENT PILL — the subject travels with the sentence.
 *
 * The rail did not render the agent's name as WORDS; it rendered `AgentPill`, which re-reads the
 * roster and shows the agent's CURRENT name, with a click that opens it. The founder's ask when that
 * pill was built: *"once you have the agent ID … that would render as a pill so I would see it as
 * Build 17 or whatever. And then as it renames, I would see it rename."*
 *
 * So handing the bubble `text` alone would not have MOVED the pill, it would have deleted it — and
 * silently, because `text` is a complete sentence that reads fine with the stale name baked in
 * (`ConciergeActivityLine.agentRef`: "the name as it stood when the call was recorded"). Both cases
 * below therefore turn on the name having CHANGED since: a fixture where the roster agrees with the
 * recorded name would pass against plain text and prove nothing.
 */
describe("the agent the line names stays a live pill under the bubble", () => {
  /** Recorded when the call was made — "Kraken Auth" — and the sentence built around it. */
  const REF = {
    agentId: "agent-7",
    name: "Kraken Auth",
    before: "Reading ",
    after: "'s terminal",
  };
  const RENAMED = "Kraken Auth v2";

  function drawWired(
    statuses: Record<string, ConciergeMessageStatusText>,
    onOpenAgent = vi.fn(() => true),
  ) {
    render(
      <AgentPillProvider
        value={{
          // The agent has been RENAMED since the call was recorded. The roster is the live truth.
          agents: [
            {
              id: "agent-7",
              name: RENAMED,
              projectId: "p1",
              projectName: "web",
              band: "running",
              canAcceptInput: true,
            },
          ],
          onOpenAgent,
        }}
      >
        <ConciergeThread
          messages={messages()}
          typing
          turnFloor={-1}
          statuses={statuses}
          onNudgeClick={() => {}}
          onNudgeAction={() => {}}
        />
      </AgentPillProvider>,
    );
    return onOpenAgent;
  }

  it("shows the agent's CURRENT name, not the one baked into the phrase", () => {
    callTerminal();
    drawWired({
      u1: { text: "Reading Kraken Auth's terminal", icon: "terminal", agentRef: REF, live: true },
    });
    const status = screen.getByTestId(MESSAGE_STATUS_TESTID);
    expect(status.textContent).toContain(RENAMED);
    // The stale name is GONE, not merely accompanied. Rendering `text` verbatim is what this fails.
    expect(status.textContent).not.toContain("Kraken Auth's terminal");
    // The words either side of the subject are still the producer's, unsliced.
    expect(status.textContent).toContain("Reading ");
    expect(status.textContent).toContain("'s terminal");
  });

  it("keeps the click that opens the agent", () => {
    callTerminal();
    const onOpenAgent = drawWired({
      u1: { text: "Reading Kraken Auth's terminal", icon: "terminal", agentRef: REF, live: true },
    });
    const status = screen.getByTestId(MESSAGE_STATUS_TESTID);
    const pill = status.querySelector<HTMLElement>(`[data-testid="concierge-agent-pill"]`);
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute("data-agent-id")).toBe("agent-7");
    fireEvent.click(pill!);
    // THE SIDE EFFECT, not the presence of the button: a pill wired to nothing is the dead link
    // AgentPill.deadEnd.test.tsx exists to forbid, and it would satisfy a query-only assertion.
    expect(onOpenAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-7" }));
  });

  it("and the rail is not ALSO drawing it — one subject, one place", () => {
    callTerminal();
    drawWired({
      u1: { text: "Reading Kraken Auth's terminal", icon: "terminal", agentRef: REF, live: true },
    });
    // The whole point of the file, restated for the pill: moving the sentence must not leave a
    // second copy of its subject in the rail.
    expect(document.querySelectorAll(`[data-testid="concierge-agent-pill"]`)).toHaveLength(1);
    expect(railWords()).toBeNull();
  });

  it("renders plain words when the line names no agent", () => {
    // A phase line ("Composing") and a queue position have no `agentRef`, and inventing a pill for
    // them would be this component deriving a subject the producer never named.
    callTerminal();
    drawWired({ u1: { text: LINE, icon: "terminal", live: true } });
    const status = screen.getByTestId(MESSAGE_STATUS_TESTID);
    expect(status.textContent).toBe(LINE);
    expect(status.querySelector(`[data-testid="concierge-agent-pill"]`)).toBeNull();
  });
});
