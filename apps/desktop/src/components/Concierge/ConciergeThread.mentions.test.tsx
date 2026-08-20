// @vitest-environment jsdom
//
// A sent message draws the agents it addressed as PILLS, not as raw "@text" — the last half of the
// founder's ask ("if I press enter it shows me the agent as a pill in the chat"). The composer is a
// plain textarea and stays one, so the sent bubble is where a pill becomes visible.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConciergeThread } from "./ConciergeThread";
import { BeadPillProvider, type BeadPillContextValue } from "./BeadPill";
import { beadMentionId } from "./mentions";
import type { Bead } from "../../services/beads";
import type { ConciergeMessage } from "./types";

// NO BEADS-STORE MOCK, and that is deliberate rather than an omission: these rows mount
// `BeadPillProvider` with a FIXTURE, never `BeadPillHost`, so nothing here arms the poller and
// nothing shells out to `bd`. The fixture is also the honest shape for this surface — a sent bubble
// renders from the mentions RECORDED on the message, not from a live board.

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

// ══ A BEAD MENTION IS A REFERENCE THE READER CAN OPEN ═══════════════════════════════════════════
//
// The founder asked for the reference to be "a clickable pill carrying the bead id", and a sent
// `you` bubble is the one surface where markdown is never involved — `MentionedText` splits the text
// against the RECORDED mentions, so a `[title](sparkle-bead:id)` literal would show as literal
// markdown. The pill therefore has to come out of the mention record, and the CONTROL has to be the
// app's one bead control (`BeadPill`) rather than a lookalike that opens a different card.
const BEAD_ID = "sparkle-1cpomd";
const BEAD: Bead = {
  id: BEAD_ID,
  title: "Chat about a bead from its card",
  description: "",
  status: "open",
  type: "feature",
  priority: 1,
  labels: [],
  parent: null,
  commentCount: 0,
};

function ctx(beads: Bead[]): BeadPillContextValue {
  return {
    beads: new Map(beads.map((b) => [b.id, { bead: b, projectId: "p1" }])),
    onViewOnBoard: vi.fn(() => true),
  };
}

function beadThread(messages: ConciergeMessage[], value: BeadPillContextValue = ctx([BEAD])) {
  render(
    <BeadPillProvider value={value}>
      <ConciergeThread messages={messages} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />
    </BeadPillProvider>,
  );
}

/** A message naming BOTH an agent and a bead — the shape every row below uses, because "the bead is
 *  a button" is only evidence when an agent mention in the same bubble is still NOT one. Rendering
 *  the bead alone would pass identically if every mention had become a button. */
const BOTH: ConciergeMessage = {
  id: "u1",
  kind: "you",
  text: "@Kraken Auth please pick up @Chat about a bead from its card next",
  mentions: [
    { agentId: "a2", name: "Kraken Auth" },
    { agentId: beadMentionId(BEAD_ID), name: "Chat about a bead from its card" },
  ],
};

const beadPills = () => screen.queryAllByTestId("concierge-bead-pill");
const beadCard = () => screen.queryByTestId("concierge-bead-card");

describe("ConciergeThread — a bead mention is clickable", () => {
  it("draws the bead's id as a BeadPill button while the agent beside it stays a plain pill", () => {
    beadThread([BOTH]);
    // The bead half is the app's real bead control, carrying the id…
    expect(beadPills()).toHaveLength(1);
    expect(beadPills()[0]!.getAttribute("data-bead-id")).toBe(BEAD_ID);
    expect(beadPills()[0]!.tagName).toBe("BUTTON");
    // …and the agent half is untouched: still a span, still no button. A change that made every
    // mention clickable would satisfy the line above and fail this one.
    const agentPill = pills().find((p) => p.getAttribute("data-agent-id") === "a2");
    expect(agentPill?.tagName).toBe("SPAN");
    expect(agentPill?.querySelector("button")).toBeNull();
  });

  // THE POINT OF THE WHOLE ROW. "Clickable" is not a style — a pill that cannot open anything is
  // prose with a background colour (AgentPill.deadEnd.test.tsx exists to forbid exactly that).
  it("OPENS THE BEAD'S CARD when the pill is clicked", () => {
    beadThread([BOTH]);
    expect(beadCard()).toBeNull();
    fireEvent.click(beadPills()[0]!);
    expect(beadCard()).toBeTruthy();
    expect(beadCard()!.textContent).toContain("Chat about a bead from its card");
  });

  it("keeps the title as the mention pill, so the record reads as what was sent", () => {
    beadThread([BOTH]);
    const titlePill = pills().find(
      (p) => p.getAttribute("data-agent-id") === beadMentionId(BEAD_ID),
    );
    expect(titlePill?.textContent).toBe("@Chat about a bead from its card");
    // …and the id rides beside it in parentheses, which is exactly the form `beadWireText` puts on
    // the wire. The founder's bubble and the concierge's copy of it say the same thing.
    expect(bubble().textContent).toContain("@Chat about a bead from its card (sparkle-1cpomd)");
  });

  // `withMentionLabels` suffixes a bead's address with its own id when two titles collide. The id
  // must not then appear twice — the suffix becomes the control rather than being printed beside a
  // second copy of itself.
  it("does not print the id twice when the address already carries it", () => {
    beadThread([
      {
        id: "u2",
        kind: "you",
        text: "@Chat about a bead from its card (sparkle-1cpomd) is the one",
        mentions: [
          {
            agentId: beadMentionId(BEAD_ID),
            name: "Chat about a bead from its card (sparkle-1cpomd)",
          },
        ],
      },
    ]);
    expect(bubble().textContent).toBe(
      "@Chat about a bead from its card (sparkle-1cpomd) is the one",
    );
    expect(beadPills()).toHaveLength(1);
  });

  // ══ …NOR WHEN THE HANDLE SITS OUTSIDE THE SPAN, WHICH IS THE COMMON CASE (roborev 65676) ══════
  // The row above records the mention under the SUFFIXED label, which only happens on a title
  // COLLISION. In the ordinary case the recorded name is the bare `@Title` and the handle lives in
  // the text that FOLLOWS the span — and that is not a rare shape, it is the wire form the app
  // itself writes (`beadWireText`), so any message quoting or pasting one back takes this path.
  //
  // Identical text to the row above; ONLY the recorded name differs. That pairing is the whole
  // point: the peel used to inspect the matched span alone, so it fired for one and not the other
  // and printed `(sparkle-1cpomd) (sparkle-1cpomd)` here while the row above stayed green.
  it("does not print the id twice when the handle follows the mention instead", () => {
    beadThread([
      {
        id: "u3",
        kind: "you",
        text: "@Chat about a bead from its card (sparkle-1cpomd) is the one",
        mentions: [
          { agentId: beadMentionId(BEAD_ID), name: "Chat about a bead from its card" },
        ],
      },
    ]);
    expect(bubble().textContent).toBe(
      "@Chat about a bead from its card (sparkle-1cpomd) is the one",
    );
    expect(beadPills()).toHaveLength(1);
    // Belt and braces on the thing that actually regressed: the handle appears ONCE in the record.
    expect(bubble().textContent!.split(BEAD_ID).length - 1).toBe(1);
  });

  // A bead deleted after the message was sent. `BeadPill`'s own rule — an id that resolves to
  // nothing is the prose it always was — and the title pill survives regardless, because history
  // renders from the record and not from the live board.
  it("degrades to plain text when the bead no longer exists, keeping the title pill", () => {
    beadThread([BOTH], ctx([]));
    expect(beadPills()).toHaveLength(0);
    expect(bubble().textContent).toContain("@Chat about a bead from its card (sparkle-1cpomd)");
    expect(
      pills().some((p) => p.getAttribute("data-agent-id") === beadMentionId(BEAD_ID)),
    ).toBe(true);
  });
});
