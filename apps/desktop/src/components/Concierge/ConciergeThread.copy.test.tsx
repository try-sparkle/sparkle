// @vitest-environment jsdom
//
// The thread's two copy affordances together (PRD 1 §1 + §2), which is where the interesting part
// lives: they copy DIFFERENT THINGS on purpose, and the setting governs only one of them.
//
//   §1 selection → `sel.toString()`, the RENDERED words. A partial selection has no markdown source.
//   §2 button    → `m.text`, the MARKDOWN SOURCE, so a table stays a table on paste.
//
// §2 NOW COVERS BOTH SIDES of the conversation: the founder asked for the same button on the things
// he wrote, so the `you` bubbles carry it too (§2b below). It is the SAME component with a `kind`,
// and the kinds are distinguishable in three places on purpose — the test id, the aria-label, and
// the `ConciergeCopyKind` that reaches the column's one live region.
//
// The clipboard boundary is stubbed at `navigator.clipboard`, not by mocking ../../clipboard: going
// through the shared helper is part of the contract.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConciergeThread } from "./ConciergeThread";
import { MESSAGE_ATTACHMENTS_TESTID } from "../composer/AttachmentStrip";
import type { ConciergeMessage } from "./types";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
});

const noop = () => {};

/** An answer whose VALUE is its structure — the exact case flattening would destroy. */
const MARKDOWN_ANSWER = [
  "Here is the split:",
  "",
  "| Project | Needs you |",
  "| --- | --- |",
  "| drodio-website | 2 |",
  "",
  "```ts",
  "const ready = agents.filter((a) => a.band === 'needs_you');",
  "```",
].join("\n");

const answer: ConciergeMessage = { id: "a1", kind: "sparkle", text: MARKDOWN_ANSWER };

/** One of every kind the thread renders — the fixture the "which kinds get a button" assertions
 *  read. A fresh array per call so a test that mutates one cannot reach another. */
function mixedThread(): ConciergeMessage[] {
  return [
    { id: "u1", kind: "you", text: "what needs me?" },
    { id: "b1", kind: "batch", text: "All projects calm" },
    { id: "d1", kind: "digest", band: "needs_you", variant: "rows", text: "3 Need you", leadAgentId: "x" },
    {
      id: "n1",
      kind: "nudge",
      band: "needs_you",
      projectName: "drodio-website",
      agentName: "OG Image Pipeline",
      text: "A build warning needs your call.",
      actions: [],
    },
    answer,
    { id: "p1", kind: "sparkle", text: "Two agents went quiet.", proactive: true },
  ];
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function thread(): HTMLElement {
  return screen.getByTestId("concierge-thread");
}

describe("ConciergeThread — copy affordances", () => {
  describe("§2 the whole-answer button", () => {
    it("copies the RAW MARKDOWN verbatim — table pipes and code fences intact", async () => {
      const onCopied = vi.fn();
      render(
        <ConciergeThread
          messages={[answer]}
          onNudgeClick={noop}
          onNudgeAction={noop}
          onCopied={onCopied}
        />,
      );
      fireEvent.click(screen.getByTestId("concierge-copy-answer"));
      await settle();

      const copied = writeText.mock.calls[0]?.[0] as string;
      expect(copied).toBe(MARKDOWN_ANSWER);
      // Stated separately from the equality above so a future rewrite of the fixture can't quietly
      // drop the two shapes this exists to protect.
      expect(copied).toContain("| Project | Needs you |");
      expect(copied).toContain("```ts");
      // And it is NOT the rendering. The rendered thread has the words without the syntax; that is
      // exactly what "copy the source, not the innerText" means.
      expect(copied).not.toBe(thread().textContent);
      expect(onCopied).toHaveBeenCalledWith("answer");
    });

    it("still copies when 'Copy on selection' is OFF", async () => {
      // An explicit click is an explicit instruction. The setting governs the SELECTION path only —
      // turning it off must not take the button away.
      render(
        <ConciergeThread
          messages={[answer]}
          onNudgeClick={noop}
          onNudgeAction={noop}
          copyOnSelection={false}
        />,
      );
      fireEvent.click(screen.getByTestId("concierge-copy-answer"));
      await settle();

      expect(writeText).toHaveBeenCalledWith(MARKDOWN_ANSWER);
    });

    it("is on proactive pushes too, and on no CARD in the thread", () => {
      render(<ConciergeThread messages={mixedThread()} onNudgeClick={noop} onNudgeAction={noop} />);

      // One per ANSWER — the reply and the push — and none for the cards.
      expect(screen.getAllByTestId("concierge-copy-answer")).toHaveLength(2);
      expect(screen.getByTestId("concierge-push").querySelector('[data-testid="concierge-copy-answer"]')).toBeTruthy();
      // THE CARDS STAY BARE, and this is the assertion that keeps them that way. A nudge, a digest
      // line and a batch divider are chrome the app wrote about state — nobody pastes one into a
      // doc — so the glyph must not have spread to them along with the user's bubbles. Stated as an
      // EXACT COUNT over every copy button in the thread rather than as four "this card has none"
      // probes: the count is what a fifth card added later has to keep true, and a per-card probe
      // for a card that does not exist yet cannot fail.
      const all = thread().querySelectorAll("[data-testid^='concierge-copy-']");
      expect(all).toHaveLength(3); // two answers + the one user bubble, nothing else
      expect(screen.getAllByTestId("concierge-copy-message")).toHaveLength(1);
    });
  });

  // ── §2b THE USER'S OWN MESSAGES ────────────────────────────────────────────────────────────────
  //
  // "We should also have a copy button like we do for the concierge's responses. We don't currently
  // have a copy button for the things that I've written." These assertions were the exact opposite
  // before that ask — `you-bubble` was asserted to have NO button — so nothing here can pass against
  // the code as it stood.
  describe("§2b the user's own message button", () => {
    const mine: ConciergeMessage = { id: "u1", kind: "you", text: "ship the receipt fix, please" };

    it("copies the user's own words — under its OWN test id, not the answer's", async () => {
      render(<ConciergeThread messages={[mine, answer]} onNudgeClick={noop} onNudgeAction={noop} />);

      const bubble = screen.getByTestId("you-bubble").parentElement!;
      const button = bubble.querySelector('[data-testid="concierge-copy-message"]');
      expect(button).toBeTruthy();
      // And the ANSWER's button is not the one that ended up under the bubble — a shared component
      // with a shared id would make the two indistinguishable to every other test in this file.
      expect(bubble.querySelector('[data-testid="concierge-copy-answer"]')).toBeNull();

      fireEvent.click(button as HTMLElement);
      await settle();
      expect(writeText).toHaveBeenCalledWith("ship the receipt fix, please");
    });

    it("announces kind 'message', never 'answer'", async () => {
      // The announcement is the only channel a screen-reader user has to tell the two buttons
      // apart, so the kind travelling up through the thread is the real side effect here.
      const onCopied = vi.fn();
      render(
        <ConciergeThread
          messages={[mine]}
          onNudgeClick={noop}
          onNudgeAction={noop}
          onCopied={onCopied}
        />,
      );
      fireEvent.click(screen.getByTestId("concierge-copy-message"));
      await settle();

      expect(onCopied).toHaveBeenCalledWith("message");
      expect(onCopied).not.toHaveBeenCalledWith("answer");
    });

    it("sits ABOVE the routing receipt", async () => {
      // Both live on the bubble's right edge and must not share a ROW. Asserted by document order
      // rather than geometry — jsdom has no layout engine, so "which element comes first" is the
      // honest question to ask here.
      //
      // AN AGENT RECEIPT, not a sparkle one: a message the concierge answered itself now renders NO
      // receipt element at all ("Answered here" and the "Also ask" button are both gone), so a
      // sparkle fixture would assert ordering against something that does not exist. An agent
      // delivery still earns a line — it names somewhere the reader cannot see.
      render(
        <ConciergeThread
          messages={[
            {
              ...mine,
              receipt: { target: "agent", redirectable: true, agentName: "Kraken Auth" },
            },
          ]}
          onNudgeClick={noop}
          onNudgeAction={noop}
          onRedirect={noop}
        />,
      );
      const copy = screen.getByTestId("concierge-copy-message");
      const receipt = screen.getByTestId("routing-receipt");
      expect(receipt.contains(copy)).toBe(false);
      expect(copy.compareDocumentPosition(receipt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // And the receipt hosts no control any more — the "Also ask" affordance was removed.
      expect(receipt.querySelector('[data-testid="routing-redirect"]')).toBeNull();
    });

    it("copies the SENT text of a message that addressed an agent, with no internal id in it", async () => {
      // A user's mention is derived from the literal `@Name` and recorded out-of-band in `mentions`
      // (see ./agentRefs' header) — so the clipboard gets the sentence exactly as it was typed, and
      // the agent uuid the bubble draws its pill from stays out of it.
      render(
        <ConciergeThread
          messages={[
            {
              id: "u2",
              kind: "you",
              text: "@Kraken Auth can you retry the token refresh?",
              mentions: [{ agentId: "9f3c1d2e", name: "Kraken Auth" }],
            },
          ]}
          onNudgeClick={noop}
          onNudgeAction={noop}
        />,
      );
      fireEvent.click(screen.getByTestId("concierge-copy-message"));
      await settle();

      const copied = writeText.mock.calls[0]?.[0] as string;
      expect(copied).toBe("@Kraken Auth can you retry the token refresh?");
      expect(copied).not.toContain("9f3c1d2e");
    });
  });

  describe("§1 copy on selection", () => {
    /** Highlight the rendered answer, then release inside the thread. */
    function selectAndRelease(): void {
      const range = document.createRange();
      range.selectNodeContents(thread());
      const sel = window.getSelection();
      if (!sel) throw new Error("jsdom has no Selection");
      sel.removeAllRanges();
      sel.addRange(range);
      fireEvent.mouseDown(thread());
      fireEvent.mouseUp(thread());
    }

    it("copies the RENDERED text — not the markdown source — when the setting is ON", async () => {
      const onCopied = vi.fn();
      render(
        <ConciergeThread
          messages={[answer]}
          onNudgeClick={noop}
          onNudgeAction={noop}
          onCopied={onCopied}
        />,
      );
      selectAndRelease();
      await settle();

      const copied = writeText.mock.calls[0]?.[0] as string;
      expect(copied).toContain("Here is the split:");
      // The deliberate difference from §2: a highlight has no markdown behind it.
      expect(copied).not.toBe(MARKDOWN_ANSWER);
      expect(onCopied).toHaveBeenCalledWith("selection");
    });

    it("does nothing when the setting is OFF", async () => {
      const onCopied = vi.fn();
      render(
        <ConciergeThread
          messages={[answer]}
          onNudgeClick={noop}
          onNudgeAction={noop}
          copyOnSelection={false}
          onCopied={onCopied}
        />,
      );
      selectAndRelease();
      await settle();

      expect(writeText).not.toHaveBeenCalled();
      expect(onCopied).not.toHaveBeenCalled();
    });

    it("shows a confirmation that cannot shift the layout or take focus", async () => {
      render(<ConciergeThread messages={[answer]} onNudgeClick={noop} onNudgeAction={noop} />);
      selectAndRelease();
      await settle();

      const toast = screen.getByTestId("concierge-copy-toast");
      // Absolutely positioned (so it is out of flow) and inert to both the pointer and the reader —
      // the announcement goes through the column's ONE live region instead.
      expect(toast.style.position).toBe("absolute");
      expect(toast.style.pointerEvents).toBe("none");
      expect(toast.getAttribute("aria-hidden")).toBe("true");
      expect(document.activeElement).toBe(document.body);
    });
  });

  it("adds NO second live region — the confirmation leaves via onCopied", async () => {
    // The column's single `role="status" aria-live="polite"` node lives in ConciergeColumn and is
    // fed by the host's `announce()`. A region in here would double-announce every reply, which is
    // what roborev 52648/53010/53088 were about.
    const onCopied = vi.fn();
    const { container } = render(
      <ConciergeThread
        messages={[answer]}
        onNudgeClick={noop}
        onNudgeAction={noop}
        onCopied={onCopied}
      />,
    );
    fireEvent.click(screen.getByTestId("concierge-copy-answer"));
    await settle();

    expect(onCopied).toHaveBeenCalledWith("answer");
    expect(container.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  /**
   * WHERE the glyph sits, not merely THAT it is in the bubble (roborev 58010-M3, corrected by
   * 58031). Every pre-existing assertion in this file passed identically before the glyph moved, so
   * the placement was uncovered; the first attempt at covering it was ALSO vacuous, in two ways
   * worth stating because both are easy to repeat:
   *
   *   • `firstElementChild` SKIPS TEXT NODES. `MentionedText` returns a bare fragment — a text node,
   *     no element — whenever the message has no mentions, so the floated span was the only ELEMENT
   *     child either way and the ordering assertion held with the glyph before OR after the words.
   *     The content being ordered against is a text node, so the assertion has to be over
   *     `childNodes`.
   *   • The strip guard queried `[data-attachment-strip]`, which exists nowhere in the repo (the
   *     real marker is MESSAGE_ATTACHMENTS_TESTID), on a fixture carrying no attachments — and
   *     `AttachmentStrip` renders null for an empty list. It was dead code wrapped in `if (strip)`,
   *     so the headline fix of that commit had no coverage at all while reading as covered.
   *
   * The fixture therefore carries an attachment, the constant is imported rather than re-typed, and
   * the conditional is gone so an absent strip FAILS rather than skips.
   */
  it("floats the copy glyph ahead of the words, in a wrapper that never meets the attachment strip", () => {
    render(
      <ConciergeThread
        messages={[
          {
            id: "u1",
            kind: "you",
            text: "ship the receipt fix, please",
            attachments: [{ id: "a1", name: "shot.png", kind: "image", dataUrl: "data:," }],
          } as ConciergeMessage,
        ]}
        onNudgeClick={noop}
        onNudgeAction={noop}
      />,
    );
    const bubble = screen.getByTestId("you-bubble");
    const button = bubble.querySelector('[data-testid="concierge-copy-message"]')!;
    expect(button).toBeTruthy();
    // Walk UP to the floated ancestor rather than assuming a depth: CopyAnswerButton owns its own
    // wrapper element, so the float is not necessarily the button's direct parent.
    let wrapper = button.parentElement as HTMLElement | null;
    while (wrapper && wrapper.style.float !== "right" && wrapper !== bubble) {
      wrapper = wrapper.parentElement;
    }
    expect(wrapper).toBeTruthy();
    expect(wrapper!.style.float).toBe("right");

    // ORDERING, over childNodes so the text node counts. This is what puts the glyph on the first
    // line rather than below the words.
    expect(wrapper!.parentElement!.childNodes[0]).toBe(wrapper);

    // AND THE SCOPING, which is the layout fix itself: the float's block must not contain — or
    // precede — the attachment strip. A float that met that block-level flex container would narrow
    // it for its full height, squeezing the thumbnails (roborev 58010-M1). No conditional: an
    // absent strip is a broken fixture, not a skipped check.
    const strip = screen.getByTestId(MESSAGE_ATTACHMENTS_TESTID);
    expect(wrapper!.parentElement!.contains(strip)).toBe(false);
    expect(
      strip.compareDocumentPosition(wrapper!.parentElement!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
