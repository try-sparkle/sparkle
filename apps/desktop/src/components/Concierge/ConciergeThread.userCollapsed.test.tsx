// @vitest-environment jsdom
//
// THE FOUNDER'S OWN PASTE, AS A PILL — the transcript half of the parity he asked for:
//
//   "Maybe it's just when YOU give me big blocks of text you show them as expandable pills — but I
//    want that same functionality when I'M the one sending big blocks of text. I want it to be an
//    expandable pill, I can click on it, it pops up in a modal, I can click show as regular text."
//
// The sibling suite (./ConciergeThread.collapsed.test.tsx) pins the SPARKLE side of the same
// primitive. These rows exist because the two sides could drift while both stayed green: the pill,
// the modal and the expand-in-place are one component and one piece of thread state on purpose, and
// "the user's bubble does everything the concierge's line does" is a claim that has to be asserted
// on the user's bubble, not inferred from the other suite passing.
//
// WHAT IS DELIBERATELY NOT HERE: any claim about what was SENT. Collapsing is a display decision and
// this file renders messages it built itself, so it cannot see the wire at all. The guarantee that a
// pill never shortens what reaches a live PTY is asserted where the wire actually is —
// ../ConciergeHost.userCollapsed.test.tsx — and that separation is intentional: a row here that
// "checked the payload" would be checking a fixture.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLAPSED_TEXT_TESTID, ConciergeThread } from "./ConciergeThread";
import { collapseText } from "../composer/attachments";
import type { ConciergeMessage } from "./types";

/** A line buried DEEP in the paste. Nothing but the full text may ever contain it — that is what
 *  makes "the bubble does not carry the wall" checkable rather than a matter of taste. */
const CANARY = "line-19-nobody-should-read-this-in-the-bubble";

/** A paste with edges worth checking: leading indentation and a trailing newline, so an assertion
 *  of byte identity cannot be satisfied by something that trimmed on the way through. */
const PASTE = `${[
  "    diff --git a/src/app.ts b/src/app.ts",
  "  -  const a = 1;",
  "  +  const a = 2;",
  "",
  ...Array.from({ length: 13 }, (_, i) => `  context line ${i + 1}`),
  CANARY,
  "\tif (a) return;",
].join("\n")}\n`;

/** What he typed AROUND the paste — the half that must stay legible, and the reason the bubble does
 *  not simply collapse `text` itself. */
const TYPED = "what is wrong here?";

const block = collapseText("blk-1", PASTE);

function withPaste(): ConciergeMessage[] {
  return [{ id: "u1", kind: "you", text: TYPED, collapsed: [block] }];
}

function thread(messages: ConciergeMessage[]) {
  render(<ConciergeThread messages={messages} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />);
}

const pill = () => screen.getByTestId("composer-text-pill");
const noPill = () => screen.queryByTestId("composer-text-pill");
const bubble = () => screen.getByTestId("you-bubble");
const transcript = () => screen.getByTestId("concierge-thread");

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // The clipboard boundary is stubbed at `navigator.clipboard`, not by mocking ../../clipboard, so
  // the real copyToClipboard runs — the same call the sibling suite makes, for the same reason.
  writeText = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => cleanup());

describe("ConciergeThread — the user's own paste is a pill, not a wall of text", () => {
  it("keeps the paste OUT of the bubble and draws one pill for it instead", () => {
    thread(withPaste());
    // THE COMPLAINT, inverted into an assertion: the paste's own deep line is absent from every word
    // the transcript renders. That is what "it shows as an expandable pill" means.
    expect(transcript().textContent).not.toContain(CANARY);
    expect(pill()).toBeTruthy();
    // The compact one-row form — the same variant the concierge's side uses. The default `tile` is
    // the composer's 46px dashed box, which reads as an empty drop target inside a chat bubble.
    expect(pill().getAttribute("data-pill-variant")).toBe("inline");
    // …and it stands for THIS block, not merely for "a block".
    expect(pill().getAttribute("data-line-count")).toBe(String(block.lineCount));
  });

  it("KEEPS THE QUESTION VISIBLE — the words typed around the paste are still words", () => {
    // The whole reason `text` and `collapsed` are separate fields. Collapsing the message wholesale
    // would have hidden "what is wrong here?" inside the log it is asking about, and the reader
    // scrolling back would find a pill and no question.
    thread(withPaste());
    expect(bubble().textContent).toContain(TYPED);
  });

  it("draws the pill INSIDE the user's bubble, above the words", () => {
    // Not appended to the thread, not floating beside the bubble: it is part of the message, in the
    // order the message was assembled (`composeBody` puts every block ahead of what was typed).
    thread(withPaste());
    expect(bubble().contains(pill())).toBe(true);
  });

  it("offers no × — a sent message is a record, not a staged attachment", () => {
    thread(withPaste());
    expect(screen.queryByLabelText("Remove pasted text")).toBeNull();
  });

  it("leaves an ordinary message completely alone", () => {
    // The no-regression half: every bubble in a normal conversation carries no blocks and must
    // render exactly as it did — the words, no pill, nothing extra.
    thread([{ id: "u1", kind: "you", text: "ship it" }]);
    expect(noPill()).toBeNull();
    expect(screen.queryByTestId(COLLAPSED_TEXT_TESTID)).toBeNull();
    expect(bubble().textContent).toContain("ship it");
  });
});

describe("ConciergeThread — everything the concierge-side pill can do, the user-side pill can do", () => {
  it("opens the modal with the paste verbatim", () => {
    thread(withPaste());
    fireEvent.click(pill());
    // Every byte, including the line the bubble refuses to carry and both whitespace edges.
    expect(screen.getByTestId("text-pill-full-text").textContent).toBe(PASTE);
    expect(screen.getByTestId("text-pill-full-text").textContent).toContain(CANARY);
  });

  it("copies the VERBATIM paste from the modal, not the pill's label", async () => {
    thread(withPaste());
    fireEvent.click(pill());
    fireEvent.click(screen.getByTestId("text-pill-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(PASTE));
  });

  it("expands the paste IN PLACE in the bubble — 'show as regular text'", () => {
    thread(withPaste());
    fireEvent.click(pill());
    fireEvent.click(screen.getByTestId("text-pill-show-as-text"));

    const expanded = screen.getByTestId(COLLAPSED_TEXT_TESTID);
    expect(expanded.textContent).toBe(PASTE);
    // IN PLACE: still inside the bubble it belongs to, with the question still next to it.
    expect(bubble().contains(expanded)).toBe(true);
    expect(bubble().textContent).toContain(TYPED);
    // The pill is gone (it IS regular text now) and so is the modal.
    expect(noPill()).toBeNull();
    expect(screen.queryByTestId("modal-overlay")).toBeNull();
  });

  it("expands only the paste that was opened, when ONE message carries two", () => {
    // THE ROW THAT FORCED BLOCK-ID KEYING. A user message can hold several pastes — the compose box
    // stages one pill per paste — so state keyed by MESSAGE id would expand a paste's siblings along
    // with it. Everything above passes under either keying; only this fails.
    const second = collapseText("blk-2", `second paste\n${CANARY}-two\nthree\nfour\nfive\nsix\n`);
    thread([{ id: "u1", kind: "you", text: TYPED, collapsed: [block, second] }]);
    expect(screen.getAllByTestId("composer-text-pill")).toHaveLength(2);

    fireEvent.click(screen.getAllByTestId("composer-text-pill")[0]!);
    fireEvent.click(screen.getByTestId("text-pill-show-as-text"));

    expect(screen.getByTestId(COLLAPSED_TEXT_TESTID).textContent).toBe(PASTE);
    // The second is still collapsed — and still collapsed means its text is still absent.
    expect(screen.getAllByTestId("composer-text-pill")).toHaveLength(1);
    expect(transcript().textContent).not.toContain(`${CANARY}-two`);
  });

  it("keeps the two sides independent: a user paste and a relayed brief in one thread", () => {
    // One modal and one expanded-set serve both kinds. Sharing them is the point; sharing them
    // WRONGLY would spill the concierge's brief when the founder expands his own paste.
    const brief = collapseText("pill-1", `relayed brief\n${CANARY}-brief\nc\nd\ne\nf\n`);
    thread([
      { id: "u1", kind: "you", text: TYPED, collapsed: [block] },
      { id: "s1", kind: "sparkle", text: "CI Hardening is up — I sent your message.", collapsed: brief },
    ]);
    expect(screen.getAllByTestId("composer-text-pill")).toHaveLength(2);

    fireEvent.click(screen.getAllByTestId("composer-text-pill")[0]!);
    fireEvent.click(screen.getByTestId("text-pill-show-as-text"));

    expect(screen.getByTestId(COLLAPSED_TEXT_TESTID).textContent).toBe(PASTE);
    expect(transcript().textContent).not.toContain(`${CANARY}-brief`);
  });
});

describe("ConciergeThread — the bubble's copy glyph copies the WHOLE message", () => {
  it("copies the paste AND the typed words, not the visible half", async () => {
    // THE SUBSTITUTION THIS ROW EXISTS FOR. `m.text` is only what was typed once the bubble carries
    // pills, so a copy button left pointing at it would hand over a message with its paste silently
    // missing — and it would look completely correct on screen. Recomposed through the shared
    // `composeBody`, so the clipboard and the wire cannot disagree about what a pill expands to.
    thread(withPaste());
    fireEvent.click(screen.getByTestId("concierge-copy-message"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${PASTE}\n\n${TYPED}`));
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain(CANARY);
    // The paste's leading indentation survived — this is the user's own text, verbatim.
    expect(copied.startsWith("    diff --git")).toBe(true);
  });

  it("still copies a plain message exactly as it always did", async () => {
    thread([{ id: "u1", kind: "you", text: "ship it" }]);
    fireEvent.click(screen.getByTestId("concierge-copy-message"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ship it"));
  });
});

// ── TWO PASTES THAT SHARE A BLOCK ID ───────────────────────────────────────────────────────────
// NOT A CONTRIVED FIXTURE (roborev 58639). Block ids come from `nextId`, whose counter is
// module-level and restarts at 0 on every page load, and `rehydrateThread` reindexes a restored
// message's id but never its blocks'. So the first paste of a new session and yesterday's restored
// paste are BOTH `blk-1`, sitting in the same transcript. State keyed on the block alone opens the
// wrong one and expands both; keyed on the (message, block) pair it cannot.
describe("ConciergeThread — a restored paste and a fresh one that share a block id", () => {
  const YESTERDAY = `restored-from-last-session\n${CANARY}-old\nc\nd\ne\nf\n`;
  const TODAY = `pasted-just-now\n${CANARY}-new\nc\nd\ne\nf\n`;
  /** The collision, exactly as it arrives: same block id, different messages, different bytes. */
  const collided = (): ConciergeMessage[] => [
    { id: "restored:0", kind: "you", text: "yesterday", collapsed: [collapseText("blk-1", YESTERDAY)] },
    { id: "you-1", kind: "you", text: "today", collapsed: [collapseText("blk-1", TODAY)] },
  ];

  it("opens the one that was clicked, not the first one down the transcript", () => {
    thread(collided());
    const both = screen.getAllByTestId("composer-text-pill");
    expect(both).toHaveLength(2);
    // The SECOND pill — the fresh paste. A block-id lookup returns the restored one instead,
    // because `find` stops at the first match and that message is earlier in the thread.
    fireEvent.click(both[1]!);
    expect(screen.getByTestId("text-pill-full-text").textContent).toBe(TODAY);
  });

  it("expands only the message that was expanded", () => {
    thread(collided());
    fireEvent.click(screen.getAllByTestId("composer-text-pill")[1]!);
    fireEvent.click(screen.getByTestId("text-pill-show-as-text"));

    const expanded = screen.getAllByTestId(COLLAPSED_TEXT_TESTID);
    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.textContent).toBe(TODAY);
    // The other is still a pill, and still collapsed means its text is still absent.
    expect(screen.getAllByTestId("composer-text-pill")).toHaveLength(1);
    expect(transcript().textContent).not.toContain(`${CANARY}-old`);
  });

  it("copies the clicked paste's own bytes, not its namesake's", () => {
    // The quietest form of the bug: the modal is open on the wrong block, so the copy button hands
    // over yesterday's diff and nothing on screen says it did.
    thread(collided());
    fireEvent.click(screen.getAllByTestId("composer-text-pill")[1]!);
    fireEvent.click(screen.getByTestId("text-pill-copy"));
    return waitFor(() => expect(writeText).toHaveBeenCalledWith(TODAY));
  });
});
