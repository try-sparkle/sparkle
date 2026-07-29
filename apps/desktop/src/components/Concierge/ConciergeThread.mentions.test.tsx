// @vitest-environment jsdom
//
// A sent message draws the agents it addressed as PILLS, not as raw "@text" — the last half of the
// founder's ask ("if I press enter it shows me the agent as a pill in the chat"). The composer is a
// plain textarea and stays one, so the sent bubble is where a pill becomes visible.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConciergeThread } from "./ConciergeThread";
import type { ConciergeMessage } from "./types";

afterEach(() => cleanup());

function thread(messages: ConciergeMessage[]) {
  render(
    <ConciergeThread messages={messages} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />,
  );
}

const pills = () => screen.queryAllByTestId("concierge-mention-pill");
const bubble = () => screen.getByTestId("you-bubble");

describe("ConciergeThread — @-mention pills", () => {
  it("draws the addressed agent as a pill, keeping the words around it", () => {
    thread([
      {
        id: "u1",
        kind: "you",
        text: "Tell @Blueprint UI/UX to move things over by 5 pixels",
        mentions: [{ agentId: "a1", name: "Blueprint UI/UX" }],
      },
    ]);
    expect(pills()).toHaveLength(1);
    expect(pills()[0]!.textContent).toBe("@Blueprint UI/UX");
    expect(pills()[0]!.getAttribute("data-agent-id")).toBe("a1");
    // The sentence still reads as one sentence — the pill is inside it, not instead of it.
    expect(bubble().textContent).toBe("Tell @Blueprint UI/UX to move things over by 5 pixels");
  });

  it("draws a pill per addressed agent", () => {
    thread([
      {
        id: "u1",
        kind: "you",
        text: "@Kraken Auth and @Blueprint UI/UX both ship",
        mentions: [
          { agentId: "a2", name: "Kraken Auth" },
          { agentId: "a1", name: "Blueprint UI/UX" },
        ],
      },
    ]);
    expect(pills().map((p) => p.textContent)).toEqual(["@Kraken Auth", "@Blueprint UI/UX"]);
  });

  it("leaves an ordinary message completely alone", () => {
    thread([{ id: "u1", kind: "you", text: "just ship it" }]);
    expect(pills()).toHaveLength(0);
    expect(bubble().textContent).toBe("just ship it");
  });

  // A stray "@" in a message nobody addressed is text, not a pill — the record on the message is
  // the only thing that makes a pill, so nothing can be promoted into one after the fact.
  it("does not invent a pill from an @ in an unaddressed message", () => {
    thread([{ id: "u1", kind: "you", text: "email me@example.com" }]);
    expect(pills()).toHaveLength(0);
  });

  // History outlives the roster. Resolving pills against the live fleet would silently rewrite what
  // the user is scrolling back through the moment an agent was closed.
  it("still draws the pill for an agent that no longer exists", () => {
    thread([
      {
        id: "u1",
        kind: "you",
        text: "@Ghost Agent are you there",
        mentions: [{ agentId: "gone", name: "Ghost Agent" }],
      },
    ]);
    expect(pills()[0]!.getAttribute("data-agent-id")).toBe("gone");
  });

  it("renders a pill that a message's own text no longer contains as nothing at all", () => {
    // Defensive: a persisted message whose text was somehow rewritten without its record. The
    // bubble must still show its words rather than throwing or dropping them.
    thread([
      {
        id: "u1",
        kind: "you",
        text: "the name is gone now",
        mentions: [{ agentId: "a1", name: "Blueprint UI/UX" }],
      },
    ]);
    expect(pills()).toHaveLength(0);
    expect(bubble().textContent).toBe("the name is gone now");
  });
});
