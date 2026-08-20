// @vitest-environment jsdom
//
// HIS QUESTION APPEARS ONCE (founder screenshot, 2026-08-17, bead sparkle-y3ptuf).
//
// ══ WHAT HE SAW ════════════════════════════════════════════════════════════════════════════════
//     | What did you find out about Epic versus tasks?       ← ReplyAnchorStubs, thin muted gray
//  [copy] | What did you find out about Epic versus tasks?   ← the concierge's own markdown quote
//     The sweep came back. They're one system, not two…
//
// *"There's a bad UX here you're quoting. My question twice So I want it to be the blue bar quote
// and not the gray bar quote. What do we need to do to fix that so it's right every time? I want it
// to be the blue bar that has the copy next to it."*
//
// ══ WHAT IS ASSERTED, AND WHY IT IS THE OUTPUT AND NOT A PRECONDITION ══════════════════════════
// The headline case COUNTS HIS SENTENCE in the rendered row. "The stub component did not render" is
// a fact about one component; "his words are on screen exactly once" is the thing he reported, and
// it stays true through any later refactor that moves which component draws what. The negative half
// (a foreign quote, a half-covered burst, a held reply) matters just as much: this fix is a
// SUPPRESSION, and a suppression that fires too often deletes the only record of what he asked.
//
// scrollIntoView is STUBBED, not asserted around — same reason and same shape as
// ./ConciergeThread.anchors.test.tsx, whose cases pin the un-suppressed behaviour this one narrows.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUOTE_JUMP_TESTID } from "../Markdown";
import { ConciergeThread } from "./ConciergeThread";
import { HELD_REPLY_TESTID } from "./ConciergeMessageRow";
import { REPLY_ANCHOR_TESTID } from "./ReplyAnchorViews";
import { attachmentQuote } from "./replyAnchors";
import { Markdown } from "../Markdown";
import { BeadPillProvider, type BeadPillContextValue } from "./BeadPill";
import type { ConciergeMessage } from "./types";

const noop = () => {};
const HIS_QUESTION = "What did you find out about Epic versus tasks?";
const ANSWER = "The sweep came back. They're one system, not two.";

function mount(messages: ConciergeMessage[]) {
  return render(<ConciergeThread messages={messages} onNudgeClick={noop} onNudgeAction={noop} />);
}

/** The reply row, as the reader sees it. */
function reply(id = "brain-1"): HTMLElement {
  return document.querySelector(`[data-message-id="${id}"]`) as HTMLElement;
}

/** How many times `needle` occurs in `haystack`. The whole defect was "twice". */
function occurrences(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** The founder's exact case: one question, one settled reply that opens by quoting it. */
const quotedBack: ConciergeMessage[] = [
  { id: "you-1", kind: "you", text: HIS_QUESTION, receipt: { target: "sparkle" } },
  {
    id: "brain-1",
    kind: "sparkle",
    settled: true,
    text: `> ${HIS_QUESTION}\n\n${ANSWER}`,
    answers: [{ id: "you-1", quote: HIS_QUESTION }],
  },
];

let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
});
afterEach(cleanup);

describe("the reply quotes him ONCE", () => {
  it("shows his sentence exactly once in the reply, not twice", () => {
    mount(quotedBack);
    expect(occurrences(reply().textContent ?? "", HIS_QUESTION)).toBe(1);
  });

  it("keeps the BLUE bar and drops the gray one", () => {
    mount(quotedBack);
    // The gray stub is gone…
    expect(screen.queryByTestId(REPLY_ANCHOR_TESTID)).toBeNull();
    // …and what remains is a real `<blockquote>`, which is what carries the blue rule.
    const quotes = reply().querySelectorAll("blockquote");
    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.textContent).toContain(HIS_QUESTION);
  });

  it("does not change how the bar LOOKS — same quote chrome, plus a cursor", () => {
    // He asked for the blue bar he already has, not a new treatment of it. Compared against a quote
    // rendered with no jump offered, so this fails if the affordance ever starts restyling the rule.
    mount(quotedBack);
    const jumpable = screen.getByTestId(QUOTE_JUMP_TESTID);
    const { container } = render(<ConciergeThread messages={[{ id: "b", kind: "sparkle", text: "> plain" }]} onNudgeClick={noop} onNudgeAction={noop} />);
    const inert = container.querySelector("blockquote")!;
    expect(jumpable.style.borderLeft).toBe(inert.style.borderLeft);
    expect(jumpable.style.display).toBe(inert.style.display);
    expect(jumpable.style.cursor).toBe("pointer");
    expect(inert.style.cursor).toBe("");
  });

  it("still keeps the copy affordance beside it — the half he named", () => {
    // *"I want it to be the blue bar that has the copy next to it."* The glyph is the reply's own
    // copy control, floated at the row's leading edge; a fix that removed the row's opening element
    // could plausibly have taken it with it.
    mount(quotedBack);
    expect(reply().querySelector('[data-testid="quote-jump"]')).not.toBeNull();
    expect(reply().querySelector("button")).not.toBeNull();
  });
});

describe("the jump the gray bar used to carry now lives on the blue one", () => {
  it("scrolls back to his message when the bar is clicked", () => {
    mount(quotedBack);
    fireEvent.click(screen.getByTestId(QUOTE_JUMP_TESTID));
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("is reachable by keyboard, and Space does not double as a page scroll", () => {
    mount(quotedBack);
    const bar = screen.getByTestId(QUOTE_JUMP_TESTID);
    expect(bar.getAttribute("role")).toBe("button");
    expect(bar.tabIndex).toBe(0);
    const e = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    bar.dispatchEvent(e);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it("says what it will show, for a reader who cannot see the bar", () => {
    mount(quotedBack);
    expect(screen.getByTestId(QUOTE_JUMP_TESTID).getAttribute("aria-label")).toBe(
      `Replying to: ${HIS_QUESTION}. Show that message.`,
    );
  });

  it("stands down mid-selection, so quoting the bar's words does not scroll him away", () => {
    // This column's `QuoteChiclet` invites highlighting concierge prose, and the mouseup that ends
    // such a drag is also a click. Without the guard, selecting inside the quote navigates away and
    // destroys the selection on the way out.
    mount(quotedBack);
    const bar = screen.getByTestId(QUOTE_JUMP_TESTID);
    const sel = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(bar);
    sel.removeAllRanges();
    sel.addRange(range);
    fireEvent.click(bar);
    expect(scrollIntoView).not.toHaveBeenCalled();
    sel.removeAllRanges();
  });

  it("lets a CONTROL INSIDE the quote be used without scrolling him away", () => {
    // Found by review on the original PR (Medium). The quoted line is rendered by the same markdown
    // pipeline as anything else, so it can contain a `remarkBeadRefs` BeadPill — a real <button> —
    // or a link, and neither stops propagation. His messages routinely carry `sparkle-xxxx` ids, so
    // this is the ordinary case. Before the guard, opening a bead pill ALSO fired the jump and moved
    // the reader off the reply they were acting on. The selection guard above cannot catch it: an
    // ordinary click on a child leaves the selection collapsed.
    const withLink = "check the DNS on https://drodio.com before the cutover";
    mount([
      { id: "you-1", kind: "you", text: withLink, receipt: { target: "sparkle" } },
      {
        id: "brain-1",
        kind: "sparkle",
        settled: true,
        text: `> ${withLink}\n\n${ANSWER}`,
        answers: [{ id: "you-1", quote: withLink }],
      },
    ]);
    const bar = screen.getByTestId(QUOTE_JUMP_TESTID);
    const inner = bar.querySelector("a,button");
    // If the pill ever stops rendering inside the quote this test would silently stop covering the
    // thing it exists for, so say so rather than passing vacuously.
    expect(inner, "expected a control (bead pill or link) inside the leading quote").not.toBeNull();
    fireEvent.click(inner!, { bubbles: true });
    expect(scrollIntoView).not.toHaveBeenCalled();
    // …and the bar itself still jumps, so the guard narrowed nothing it should not have.
    fireEvent.click(bar);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("ignores a click on the CARD a pill opens, not just on the pill itself", () => {
    // The second review round's finding, and the one the control-only guard missed. A pill's expanded
    // card (`BeadPill` → `ConciergeBeadCard`, `AgentPill` → its notice) is an IN-TREE SIBLING of the
    // pill's <button> — no portal, no stopPropagation — so its body, padding and status labels are
    // plain <div>s that a `closest("a,button,…")` walk goes straight past to the blockquote. That
    // made an OPENED card a large target that scrolls the reader away mid-read: the same defect, on
    // more surface.
    //
    // The nested UI is INSERTED here rather than driven through a real pill, because the pills need
    // their provider to render and this is a statement about the blockquote's handler, not about any
    // one pill. It exercises the real production element and the real production handler; only the
    // subtree's origin is synthetic. `data-nested-ui` is what `Markdown` puts on every pill wrapper.
    mount(quotedBack);
    const bar = screen.getByTestId(QUOTE_JUMP_TESTID);
    const card = document.createElement("span");
    card.setAttribute("data-nested-ui", "yes");
    const body = document.createElement("div");
    body.textContent = "the bead's description, which is not a button";
    card.appendChild(body);
    bar.appendChild(card);
    fireEvent.click(body, { bubbles: true });
    expect(scrollIntoView).not.toHaveBeenCalled();
    // The bar itself is unaffected.
    fireEvent.click(bar);
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("ignores a KEYPRESS that started in a control inside the quote", () => {
    // The keyboard half of the same rule, which had no test of its own: the existing keyboard case
    // dispatches on the bar, so it stayed green whether or not the guard existed. Both paths now ask
    // one predicate, and this is what pins the second caller.
    const withLink = "check the DNS on https://drodio.com before the cutover";
    mount([
      { id: "you-1", kind: "you", text: withLink, receipt: { target: "sparkle" } },
      {
        id: "brain-1",
        kind: "sparkle",
        settled: true,
        text: `> ${withLink}\n\n${ANSWER}`,
        answers: [{ id: "you-1", quote: withLink }],
      },
    ]);
    const bar = screen.getByTestId(QUOTE_JUMP_TESTID);
    const inner = bar.querySelector("a,button");
    expect(inner, "expected a control inside the leading quote").not.toBeNull();
    fireEvent.keyDown(inner!, { key: "Enter", bubbles: true });
    expect(scrollIntoView).not.toHaveBeenCalled();
    fireEvent.keyDown(bar, { key: "Enter" });
    expect(scrollIntoView).toHaveBeenCalled();
  });
});

describe("what must NOT be suppressed", () => {
  it("keeps his stub when the reply opens by quoting AGENT OUTPUT instead", () => {
    // Both quotes are legitimate and they are about different things, so both are drawn. Position
    // alone would have deleted the only record of what he asked.
    mount([
      { id: "you-1", kind: "you", text: "why is CI red?", receipt: { target: "sparkle" } },
      {
        id: "brain-1",
        kind: "sparkle",
        settled: true,
        text: "> ok 47 passed | 2 failed\n\nCI is failing on a payment block, not your tests.",
        answers: [{ id: "you-1", quote: "why is CI red?" }],
      },
    ]);
    expect(screen.getByTestId(REPLY_ANCHOR_TESTID).textContent).toBe("why is CI red?");
    expect(screen.queryByTestId(QUOTE_JUMP_TESTID)).toBeNull();
    // …and the agent's own quote is still a quote.
    expect(reply().querySelector("blockquote")!.textContent).toContain("47 passed");
  });

  it("keeps every stub when only PART of a burst was quoted", () => {
    mount([
      { id: "you-1", kind: "you", text: "check the retry logic", receipt: { target: "sparkle" } },
      { id: "you-2", kind: "you", text: "also the timeout", receipt: { target: "sparkle" } },
      { id: "you-3", kind: "you", text: "and is CI green", receipt: { target: "sparkle" } },
      {
        id: "brain-1",
        kind: "sparkle",
        settled: true,
        text: "> check the retry logic\n\nRetry is fine, timeout was 3s, CI is green.",
        answers: [
          { id: "you-1", quote: "check the retry logic" },
          { id: "you-2", quote: "also the timeout" },
          { id: "you-3", quote: "and is CI green" },
        ],
      },
    ]);
    expect(screen.getAllByTestId(REPLY_ANCHOR_TESTID)).toHaveLength(3);
  });

  it("keeps the stub on a HELD reply, whose words are not on screen to duplicate", () => {
    // The blue bar is withheld with the rest of the text, so suppressing off that text would leave
    // the row saying nothing at all about what it answers.
    mount([
      { id: "you-1", kind: "you", text: HIS_QUESTION, receipt: { target: "sparkle" } },
      {
        id: "brain-1",
        kind: "sparkle",
        settled: true,
        held: true,
        text: `> ${HIS_QUESTION}\n\n${ANSWER}`,
        answers: [{ id: "you-1", quote: HIS_QUESTION }],
      },
    ]);
    expect(screen.getByTestId(HELD_REPLY_TESTID)).toBeTruthy();
    expect(screen.getByTestId(REPLY_ANCHOR_TESTID).textContent).toBe(HIS_QUESTION);
  });

  it("never makes a quote FURTHER DOWN the reply a jump", () => {
    // `remarkLeadingQuote` marks the document's first block and nothing else. The second quote here
    // is the concierge quoting scrollback inside its own answer; offering to scroll to his message
    // from there would point at something it is not quoting.
    mount([
      { id: "you-1", kind: "you", text: HIS_QUESTION, receipt: { target: "sparkle" } },
      {
        id: "brain-1",
        kind: "sparkle",
        settled: true,
        text: `> ${HIS_QUESTION}\n\n${ANSWER}\n\nThe sweep said:\n\n> plans are epics`,
        answers: [{ id: "you-1", quote: HIS_QUESTION }],
      },
    ]);
    expect(reply().querySelectorAll("blockquote")).toHaveLength(2);
    expect(screen.getAllByTestId(QUOTE_JUMP_TESTID)).toHaveLength(1);
    expect(screen.getByTestId(QUOTE_JUMP_TESTID).textContent).toContain(HIS_QUESTION);
  });
});

describe("a burst quoted in full", () => {
  const burst: ConciergeMessage[] = [
    { id: "you-1", kind: "you", text: "check the retry logic", receipt: { target: "sparkle" } },
    { id: "you-2", kind: "you", text: "also the timeout", receipt: { target: "sparkle" } },
    { id: "you-3", kind: "you", text: "and is CI green", receipt: { target: "sparkle" } },
    {
      id: "brain-1",
      kind: "sparkle",
      settled: true,
      text: "> check the retry logic\n\n> also the timeout\n\n> and is CI green\n\nRetry is fine, timeout 3s, CI green.",
      answers: [
        { id: "you-1", quote: "check the retry logic" },
        { id: "you-2", quote: "also the timeout" },
        { id: "you-3", quote: "and is CI green" },
      ],
    },
  ];

  it("draws ONE merged blue bar and no stubs — his call, twice over", () => {
    mount(burst);
    expect(screen.queryByTestId(REPLY_ANCHOR_TESTID)).toBeNull();
    expect(reply().querySelectorAll("blockquote")).toHaveLength(1);
  });

  it("jumps to the FIRST message of the burst, and says so", () => {
    mount(burst);
    const bar = screen.getByTestId(QUOTE_JUMP_TESTID);
    expect(bar.getAttribute("data-anchor-id")).toBe("you-1");
    expect(bar.getAttribute("aria-label")).toContain("3 of your messages");
  });
});

describe("a MIXED burst — words quoted, attachments not representable", () => {
  it("keeps the attachments stub while dropping the one the blue bar stands for", () => {
    // Raised in review: filtering app-authored anchors out of the MEASURE made coverage true here,
    // and the row's all-or-nothing suppression then dropped EVERY stub — including the send the
    // reply's rendered quote does not represent at all. The bar's aria-label named it, but a label
    // is not visible text, so that send had no on-screen record. Asserting the BOOLEAN could never
    // have caught this; only what the row renders can.
    render(
      <ConciergeThread
        messages={[
          {
            id: "you-1",
            kind: "you",
            text: "",
            attachments: [
              { id: "a1", kind: "image", path: "/tmp/a.png", name: "a.png" },
              { id: "a2", kind: "image", path: "/tmp/b.png", name: "b.png" },
            ],
            receipt: { target: "sparkle" },
          },
          { id: "you-2", kind: "you", text: HIS_QUESTION, receipt: { target: "sparkle" } },
          {
            id: "brain-1",
            kind: "sparkle",
            settled: true,
            text: `> ${HIS_QUESTION}\n\n${ANSWER}`,
            answers: [
              { id: "you-1", quote: attachmentQuote(2) },
              { id: "you-2", quote: HIS_QUESTION },
            ],
          },
        ]}
        onNudgeClick={noop}
        onNudgeAction={noop}
      />,
    );
    const row = reply();
    const stubs = [...row.querySelectorAll(`[data-testid="${REPLY_ANCHOR_TESTID}"]`)];
    expect(stubs).toHaveLength(1);
    expect(stubs[0]!.textContent).toContain(attachmentQuote(2));
    // His words are still shown exactly once — by the blue bar, which is the whole ask.
    expect(screen.getAllByTestId(QUOTE_JUMP_TESTID)).toHaveLength(1);
    expect(occurrences(row.textContent ?? "", HIS_QUESTION)).toBe(1);
  });

  it("points the bar at the message it QUOTES, not at the first anchor in the list", () => {
    // THE REGRESSION THE VERSION ABOVE SHIPPED WITH, and the reason asserting the stub text was not
    // enough. The bar's target and label were derived from the FULL anchor list, so
    // `quoteJumpTarget` returned the first anchor with an id — the attachments send — while the bar
    // rendered his question. Clicking the quote of his question scrolled to the image; the surviving
    // gray stub pointed at that same message; his question was reachable from NOTHING on the row;
    // and a screen reader was told the bar meant "2 attachments".
    render(
      <ConciergeThread
        messages={[
          {
            id: "you-1",
            kind: "you",
            text: "",
            attachments: [
              { id: "a1", kind: "image", path: "/tmp/a.png", name: "a.png" },
              { id: "a2", kind: "image", path: "/tmp/b.png", name: "b.png" },
            ],
            receipt: { target: "sparkle" },
          },
          { id: "you-2", kind: "you", text: HIS_QUESTION, receipt: { target: "sparkle" } },
          {
            id: "brain-1",
            kind: "sparkle",
            settled: true,
            text: `> ${HIS_QUESTION}\n\n${ANSWER}`,
            answers: [
              { id: "you-1", quote: attachmentQuote(2) },
              { id: "you-2", quote: HIS_QUESTION },
            ],
          },
        ]}
        onNudgeClick={noop}
        onNudgeAction={noop}
      />,
    );
    const bar = screen.getByTestId(QUOTE_JUMP_TESTID);
    expect(bar.getAttribute("data-anchor-id")).toBe("you-2");
    // …and it says so, rather than naming a message it does not show.
    expect(bar.getAttribute("aria-label")).toBe(
      `Replying to: ${HIS_QUESTION}. Show that message.`,
    );
    expect(bar.getAttribute("aria-label")).not.toContain(attachmentQuote(2));
  });
});

describe("the marker that makes a pill's whole subtree foreign", () => {
  /** A bead the pill can resolve — existence is what linkifies the ref (see BeadPill.test.tsx). */
  const beadCtx = (): BeadPillContextValue => ({
    beads: new Map([
      [
        "sparkle-t6wje",
        {
          bead: {
            id: "sparkle-t6wje",
            title: "Clickable bead ids",
            description: "why",
            status: "open",
            type: "feature",
            priority: 0,
            labels: [],
            parent: null,
            commentCount: 0,
          },
          projectId: "p1",
        },
      ],
    ]),
    onViewOnBoard: vi.fn(() => true),
  });

  it("wraps a REAL pill rendered through the markdown pipeline, so the guard sees its card too", () => {
    // THE PRODUCTION HALF, which nothing covered before (raised in review). The other guard tests
    // use a plain https:// link, which `FOREIGN` matches via its `a` clause whether or not the
    // marker exists — and the card-body test inserts a `data-nested-ui` span BY HAND. So all three
    // could pass with every <NestedUi> wrapper deleted, while the reported defect returns in full:
    // a pill's expanded card is an in-tree sibling of its button, and plain <div>s inside it are
    // exactly what `closest("a,button,…")` walks straight past.
    //
    // Driving the real chain (remark -> urlTransform -> link override -> pill) is the point; a
    // hand-mounted pill would keep passing with any link of it cut.
    const onQuoteJump = vi.fn();
    const { container } = render(
      <BeadPillProvider value={beadCtx()}>
        <Markdown
          text={"> look at sparkle-t6wje\n\nThat one is open."}
          mergeQuotes
          quoteJumpId="you-1"
          quoteJumpLabel="Replying to: look at sparkle-t6wje. Show that message."
          onQuoteJump={onQuoteJump}
        />
      </BeadPillProvider>,
    );
    const pill = screen.queryByTestId("concierge-bead-pill");
    expect(pill, "expected a real BeadPill inside the leading quote").not.toBeNull();
    // The assertion that reds if <NestedUi> is dropped: the pill sits inside a marked subtree.
    expect(pill!.closest("[data-nested-ui]")).not.toBeNull();
    // …and the marked subtree is inside the quote that carries the jump, which is what makes the
    // marker load-bearing rather than decorative.
    expect(container.querySelector('[data-testid="quote-jump"] [data-nested-ui]')).not.toBeNull();
    // Opening the pill must not also jump.
    fireEvent.click(pill!, { bubbles: true });
    expect(onQuoteJump).not.toHaveBeenCalled();
  });
});
