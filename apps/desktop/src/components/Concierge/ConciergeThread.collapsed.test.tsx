// @vitest-environment jsdom
//
// A SPARKLE LINE'S COLLAPSED PAYLOAD — the transcript half of "a long relayed brief collapses into a
// pill instead of flooding the view", and the surface the founder screenshotted.
//
// What these rows are about, stated as the bug: the transcript used to echo the ENTIRE relayed brief
// inline under "… I sent your message", so forty rows of payload pushed the conversation off screen.
// The payload now travels on the message as a `TextBlock` (ConciergeSparkleMessage.collapsed) and is
// drawn here as ONE row — the same `TextPill` the build-agent composer draws (components/composer/
// AttachmentRow, the only other caller today), in its `inline` variant, with the full text one click
// away.
//
// The wiring is asserted through the RENDERED OUTPUT rather than through props handed to a mocked
// pill: a pill that renders is the whole claim, and a spy on `TextPill` would keep passing if the
// variant, the face or the modal were wrong.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COLLAPSED_TEXT_TESTID, ConciergeThread } from "./ConciergeThread";
import { collapseText } from "../composer/attachments";
import type { ConciergeMessage } from "./types";

/** A line buried DEEP in the payload. Nothing but the full text may ever contain it — that is what
 *  makes "the transcript does not carry the brief" checkable rather than a matter of taste. */
const CANARY = "line-19-nobody-should-read-this-in-the-transcript";

const BRIEF = [
  "Ship the reply linter behind a flag",
  "",
  "Context: the concierge pastes relayed text back at the founder, which is the",
  "one thing the standing rule forbids.",
  "",
  ...Array.from({ length: 13 }, (_, i) => `step ${i + 1}: do the thing`),
  CANARY,
  "…and then report back.",
].join("\n");

const SENTENCE = "CI Hardening is up — I sent your message.";

const block = collapseText("blk-1", BRIEF);

function withPayload(): ConciergeMessage[] {
  return [{ id: "s1", kind: "sparkle", text: SENTENCE, collapsed: block }];
}

function thread(messages: ConciergeMessage[]) {
  render(<ConciergeThread messages={messages} onNudgeClick={vi.fn()} onNudgeAction={vi.fn()} />);
}

const pill = () => screen.getByTestId("composer-text-pill");
const noPill = () => screen.queryByTestId("composer-text-pill");

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // The clipboard boundary is stubbed at `navigator.clipboard`, not by mocking ../../clipboard, so
  // the real copyToClipboard runs — the same call TextPill.test makes, for the same reason.
  writeText = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => cleanup());

describe("ConciergeThread — a relayed payload is a pill, not a wall of text", () => {
  it("keeps the brief OUT of the transcript and draws one pill for it instead", () => {
    thread(withPayload());
    // THE POINT. Not "a pill exists somewhere" — the payload's own deep line is absent from every
    // word the transcript renders, which is what "it stopped flooding the view" means.
    expect(screen.getByTestId("concierge-thread").textContent).not.toContain(CANARY);
    expect(screen.getByTestId("concierge-thread").textContent).toContain(SENTENCE);
    expect(pill()).toBeTruthy();
    // The compact one-row form. The default `tile` is the composer's 46px dashed box, which reads as
    // an empty drop target when it lands in running prose.
    expect(pill().getAttribute("data-pill-variant")).toBe("inline");
  });

  it("puts the payload's first line on the pill's face, so it is identifiable unopened", () => {
    thread(withPayload());
    expect(pill().textContent).toContain("Ship the reply linter behind a flag");
    // …and it stands for THIS block, not merely for "a block".
    expect(pill().getAttribute("data-line-count")).toBe(String(block.lineCount));
  });

  it("offers no × — a posted line is a record, not a staged attachment", () => {
    thread(withPayload());
    expect(screen.queryByLabelText("Remove pasted text")).toBeNull();
  });

  it("leaves an ordinary sparkle line completely alone", () => {
    // The no-regression half: every existing bookkeeping line carries no payload and must render
    // exactly as it did — one sentence, no pill, nothing extra.
    thread([{ id: "s1", kind: "sparkle", text: "Sent to CI Hardening." }]);
    expect(noPill()).toBeNull();
    expect(screen.queryByTestId(COLLAPSED_TEXT_TESTID)).toBeNull();
    expect(screen.getByTestId("concierge-thread").textContent).toContain("Sent to CI Hardening.");
  });
});

describe("ConciergeThread — the full text is one click away", () => {
  it("opens the modal with the payload verbatim", () => {
    thread(withPayload());
    fireEvent.click(pill());
    // Every byte, including the line the transcript refuses to carry.
    expect(screen.getByTestId("text-pill-full-text").textContent).toBe(BRIEF);
    expect(screen.getByTestId("text-pill-full-text").textContent).toContain(CANARY);
  });

  it("copies the VERBATIM payload, not the pill's label or the sentence", async () => {
    thread(withPayload());
    fireEvent.click(pill());
    fireEvent.click(screen.getByTestId("text-pill-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(BRIEF));
  });

  it("expands the payload IN PLACE in the bubble — the founder's literal ask", () => {
    thread(withPayload());
    fireEvent.click(pill());
    fireEvent.click(screen.getByTestId("text-pill-show-as-text"));

    // IN PLACE: the expanded text sits in the same ENTRY as the sentence it belongs to, not in a
    // panel and not appended to the bottom of the thread.
    //
    // Asserted against the entry (`[data-message-id]`, which is the transcript's own unit) rather
    // than against `parentElement`. The immediate parent is an implementation detail — the payloads
    // are a list now that a user bubble can carry several, so a block sits one wrapper deeper than it
    // did — and "the expanded text is in this message" is the claim either way.
    const expanded = screen.getByTestId(COLLAPSED_TEXT_TESTID);
    expect(expanded.textContent).toBe(BRIEF);
    expect(expanded.closest("[data-message-id]")!.textContent).toContain(SENTENCE);
    // The pill is gone (it IS regular text now) and so is the modal.
    expect(noPill()).toBeNull();
    expect(screen.queryByTestId("modal-overlay")).toBeNull();
  });

  it("expands only the payload that was opened", () => {
    // State keyed by message id, pinned: two lines each carrying a brief, and expanding one must not
    // spill the other. A single boolean would pass every row above and fail this one.
    thread([
      { id: "s1", kind: "sparkle", text: SENTENCE, collapsed: block },
      {
        id: "s2",
        kind: "sparkle",
        text: "Kraken Auth is up — I sent your message.",
        collapsed: collapseText("blk-2", `other brief\n${CANARY}-two\nthree\nfour\nfive\nsix\n`),
      },
    ]);
    expect(screen.getAllByTestId("composer-text-pill")).toHaveLength(2);
    fireEvent.click(screen.getAllByTestId("composer-text-pill")[0]!);
    fireEvent.click(screen.getByTestId("text-pill-show-as-text"));

    expect(screen.getByTestId(COLLAPSED_TEXT_TESTID).textContent).toBe(BRIEF);
    // The second is still collapsed — and still collapsed means its text is still absent.
    expect(screen.getAllByTestId("composer-text-pill")).toHaveLength(1);
    expect(screen.getByTestId("concierge-thread").textContent).not.toContain(`${CANARY}-two`);
  });
});
