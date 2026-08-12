// @vitest-environment jsdom
//
// WHERE THE TWO THINGS UNDER A USER BUBBLE LIVE — and they swapped places.
//
// The founder, on his own messages: *"I think the copy icon should actually be put INSIDE the box,
// because the copy icon should be referencing what I wrote. That's what we're copying here. But then
// below the box, where the copy icon currently is, it could show the status for that specific
// question."*
//
// So this file is about CONTAINMENT, not presence, and the distinction is the whole point. Both
// controls existed before this change and both exist after it; a test that asserted either one was
// merely *rendered* would have passed against the old code and proved nothing — the vacuous shape
// AGENTS.md names as the #1 fleet-wide finding. Every assertion below therefore states which box a
// node is inside, and the two are mirrors: the copy glyph IS inside `you-bubble`, the status is NOT.
//
// The ORDER below the bubble is asserted too, because three annotations now stack there and they say
// different things at different times: what is happening now (status), where the message went
// (receipt), and what happened next (answered-below).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConciergeThread } from "./ConciergeThread";
import { MESSAGE_STATUS_TESTID, type ConciergeMessageStatusText } from "./MessageStatus";
import { SENT_TO_AGENT_TESTID } from "./SentToAgentRow";
import type { ConciergeMessage } from "./types";

afterEach(() => cleanup());

const COPY_MESSAGE_TESTID = "concierge-copy-message";

/** Two user bubbles: the first carries a receipt (so the ordering assertions have all three
 *  annotations to place), the second carries nothing — it is the "no status" case that most of a
 *  real thread is made of. */
function messages(): ConciergeMessage[] {
  return [
    {
      id: "u1",
      kind: "you",
      text: "what needs me?",
      receipt: { target: "agent", agentName: "Kraken Auth", agentId: "ag1", redirectable: true },
    },
    { id: "u2", kind: "you", text: "and the other project?" },
  ];
}

function draw(statuses?: Record<string, ConciergeMessageStatusText>) {
  return render(
    <ConciergeThread
      messages={messages()}
      statuses={statuses}
      onNudgeClick={() => {}}
      onNudgeAction={() => {}}
    />,
  );
}

/** The whole transcript entry for a message — bubble PLUS everything stacked under it. */
function entry(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  if (!el) throw new Error(`no entry for ${id}`);
  return el;
}

/** True when `a` comes before `b` in document order. */
function precedes(a: Node, b: Node): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("the copy glyph moved INSIDE the bubble", () => {
  it("is contained by `you-bubble`, not merely present in the entry", () => {
    draw();
    const bubble = screen.getAllByTestId("you-bubble")[0]!;
    const copy = screen.getAllByTestId(COPY_MESSAGE_TESTID)[0]!;
    // THE assertion. `getByTestId(...)` alone was true of the old layout too.
    expect(bubble.contains(copy)).toBe(true);
    // And it is the LAST thing in the bubble — the founder asked for the bottom-right corner of the
    // box, so a glyph that had landed above the words would satisfy containment and miss the ask.
    expect(precedes(screen.getAllByText("what needs me?")[0]!, copy)).toBe(true);
  });

  it("still renders one per user bubble, always — not on hover", () => {
    // The old placement's constraint that survives the move (see CopyAnswerButton's header): a
    // control that mounts on hover changes the entry's height under a reader who is only moving the
    // mouse, and the thread auto-follows on a content key.
    draw();
    expect(screen.getAllByTestId(COPY_MESSAGE_TESTID)).toHaveLength(2);
    for (const [i, bubble] of screen.getAllByTestId("you-bubble").entries()) {
      expect(bubble.contains(screen.getAllByTestId(COPY_MESSAGE_TESTID)[i]!)).toBe(true);
    }
  });
});

describe("the status took the corner the glyph vacated", () => {
  it("renders BELOW the bubble and is NOT inside it", () => {
    draw({ u1: { text: "Checking git" } });
    const bubble = screen.getAllByTestId("you-bubble")[0]!;
    const status = screen.getByTestId(MESSAGE_STATUS_TESTID);
    // The mirror of the containment assertion above — together they pin a swap rather than two
    // independent facts either of which the old code also satisfied.
    expect(bubble.contains(status)).toBe(false);
    expect(entry("u1").contains(status)).toBe(true);
    expect(precedes(bubble, status)).toBe(true);
    // A DIRECT child of the entry, i.e. a sibling of the bubble — not buried inside the receipt,
    // which is a separate annotation with its own row and its own right-justified button.
    expect(status.parentElement).toBe(entry("u1"));
    expect(status.textContent).toBe("Checking git");
  });

  it("does not re-apply the entry's width cap on top of the entry's own", () => {
    // roborev 57853-M1, and it is a fact about the PAIR, which is why it lives here rather than in
    // MessageStatus.test.tsx. The entry is `alignSelf: "flex-end"` in a flex column, i.e.
    // SHRINK-TO-FIT: its width is its contents' max-content width, already capped at 92% of the
    // column. A percentage max-width on a child contributes nothing while that intrinsic width is
    // computed and is then resolved against the result — so a second 92% here measures the status
    // against a width the status itself produced and ellipsises the widest phrase in every entry,
    // with the column half empty. Exactly one 92% in the chain, and it belongs to the entry.
    draw({ u1: { text: "Checking git" } });
    const status = screen.getByTestId(MESSAGE_STATUS_TESTID);
    expect(entry("u1").style.maxWidth).toBe("92%");
    expect(status.style.maxWidth).toBe("100%");
  });

  it("sits between the bubble and the routing receipt", () => {
    // A REFUSED RECEIPT, and the substitution is the point rather than a convenience. The fixture's
    // ordinary agent receipt no longer renders a line BELOW the bubble at all: a message that
    // reached an agent now says so inside the black sent card (Concierge/SentToAgentRow), which is
    // above the status, not below it. A refused send is the case that still stacks a receipt
    // underneath — it went nowhere, so it has no destination to draw and keeps the old line — and
    // it is therefore where this ordering invariant still lives.
    render(
      <ConciergeThread
        messages={[
          {
            id: "u1",
            kind: "you",
            text: "what needs me?",
            receipt: { target: "agent", agentName: "Kraken Auth", agentId: "ag1", refused: true },
          },
        ]}
        statuses={{ u1: { text: "Checking git" } }}
        onNudgeClick={() => {}}
        onNudgeAction={() => {}}
      />,
    );
    const bubble = screen.getAllByTestId("you-bubble")[0]!;
    const status = screen.getByTestId(MESSAGE_STATUS_TESTID);
    const receipt = screen.getByTestId("routing-receipt");
    // "What is happening now" before "where it went": the receipt is the settled record and reads
    // last, so a status appended after it would put the live line under the archive.
    expect(precedes(bubble, status)).toBe(true);
    expect(precedes(status, receipt)).toBe(true);
  });

  it("still sits below the bubble when the destination is drawn INSIDE it", () => {
    // The other half of the split above, so neither case can regress unnoticed. For a message that
    // really did reach an agent the destination is inside the card and the status stays where the
    // founder put it — under the box, in the corner the copy glyph vacated.
    draw({ u1: { text: "Checking git" } });
    const bubble = screen.getAllByTestId("you-bubble")[0]!;
    const status = screen.getByTestId(MESSAGE_STATUS_TESTID);
    const sentTo = screen.getByTestId(SENT_TO_AGENT_TESTID);
    expect(bubble.contains(sentTo)).toBe(true);
    expect(bubble.contains(status)).toBe(false);
    expect(precedes(bubble, status)).toBe(true);
    // Nothing hangs below it any more for this message.
    expect(screen.queryByTestId("routing-receipt")).toBeNull();
  });

  it("appears on the ONE message it is keyed to, and on no other", () => {
    draw({ u1: { text: "Checking git" } });
    expect(screen.getAllByTestId(MESSAGE_STATUS_TESTID)).toHaveLength(1);
    expect(entry("u1").querySelector(`[data-testid="${MESSAGE_STATUS_TESTID}"]`)).not.toBeNull();
    // The bubble with no entry in the map renders NOTHING — the state most of a long thread is in.
    expect(entry("u2").querySelector(`[data-testid="${MESSAGE_STATUS_TESTID}"]`)).toBeNull();
  });

  it("renders nothing at all when the thread is given no statuses", () => {
    // The prop is OPTIONAL: every caller and suite that predates this feature renders exactly what
    // it did before, which is why `draw()` takes no argument here.
    draw();
    expect(screen.queryByTestId(MESSAGE_STATUS_TESTID)).toBeNull();
  });

  it("is not offered to a bubble the user did not write", () => {
    // A `statuses` map is keyed by message id, and ids come from several producers. A key that
    // happened to name a sparkle reply must not grow a status under an answer — the surface is
    // "what is being done about MY question", and it has no meaning on the answer itself.
    render(
      <ConciergeThread
        messages={[{ id: "b1", kind: "sparkle", text: "Two agents are waiting on you." }]}
        statuses={{ b1: { text: "Composing" } }}
        onNudgeClick={() => {}}
        onNudgeAction={() => {}}
      />,
    );
    expect(screen.queryByTestId(MESSAGE_STATUS_TESTID)).toBeNull();
  });
});
