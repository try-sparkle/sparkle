// THE RULE THAT DECIDES WHETHER THE REPLY ALREADY QUOTED HIM (bead sparkle-y3ptuf).
//
// The rendered outcome is pinned in ./ConciergeThread.quoteOnce.test.tsx; what is checked here is
// the decision itself, which is where every interesting case lives — a reply that opens by quoting
// something OTHER than the founder, a burst only half covered, an attachments-only send that has no
// words to quote. Same split ./replyAnchors ↔ ./ConciergeThread.anchors.test.tsx already uses.
import { describe, expect, it } from "vitest";
import { attachmentQuote } from "./replyAnchors";
import {
  leadingQuoteCovers,
  leadingQuoteSource,
  quoteJumpLabel,
  quoteJumpTarget,
  quoteSourceCovers,
  stubAnchorsFor,
} from "./replyQuoteCoverage";

/** The founder's own screenshot, 2026-08-17. */
const HIS_QUESTION = "What did you find out about Epic versus tasks?";
const anchors = (...quotes: string[]) => quotes.map((quote, i) => ({ id: `you-${i + 1}`, quote }));

describe("leadingQuoteSource — the cheap prefix the parse is handed", () => {
  it("takes the opening quote and stops at the prose under it", () => {
    expect(leadingQuoteSource(`> ${HIS_QUESTION}\n\nThe sweep came back.`)).toBe(`> ${HIS_QUESTION}`);
  });

  it("keeps a BLANK-SEPARATED run together — that is one quote, and one bar", () => {
    // The spelling `remarkMergeQuotes` exists for, and the spelling the concierge actually uses for a
    // burst. Stopping at the first blank line would hand the parser only the first message's quote
    // and score the burst as partially covered — the stub would come back for a reply that quoted
    // every one of them.
    expect(leadingQuoteSource("> one\n\n> two\n\n> three\n\nThe answer.")).toBe("> one\n\n> two\n\n> three");
  });

  it("keeps a LAZY CONTINUATION line, because CommonMark folds it into the quote", () => {
    // A bare line directly under a `>` line is part of the quote. Cutting it out here would hand the
    // parser a truncated quotation and could drop it below the coverage floor — the expensive
    // direction, since it puts the duplicate back on screen.
    expect(leadingQuoteSource("> the first half\nand the second half\n\nAnswer.")).toBe(
      "> the first half\nand the second half",
    );
  });

  it("allows leading blank lines — they are children of nothing", () => {
    expect(leadingQuoteSource(`\n\n> ${HIS_QUESTION}\n\nAnswer.`)).toBe(`> ${HIS_QUESTION}`);
  });

  it("returns nothing for a reply that opens with prose, whatever it quotes later", () => {
    expect(leadingQuoteSource("Here is what I found.\n\n> buried quote")).toBe("");
    expect(leadingQuoteSource("")).toBe("");
  });

  it("is not fooled by a `>` indented past the marker's four-space limit", () => {
    // Four spaces is an indented CODE BLOCK, not a quote. Treating it as an opening quote would hand
    // the parser something whose first child is `code`, and `leadingQuoteCorpus` would return "" —
    // correct by luck rather than by rule, and a rule that agrees with the parser is the point.
    expect(leadingQuoteSource("    > not a quote\n\nAnswer.")).toBe("");
  });
});

describe("does the reply's opening quote cover what it is answering?", () => {
  it("YES for the founder's screenshot — one message, quoted verbatim", () => {
    expect(leadingQuoteCovers(`> ${HIS_QUESTION}\n\nThe sweep came back.`, anchors(HIS_QUESTION))).toBe(true);
  });

  it("YES for a burst where every message is represented", () => {
    const text = "> can you check the retry logic\n\n> also the timeout\n\n> and is CI green\n\nAll fine.";
    expect(
      leadingQuoteCovers(text, anchors("can you check the retry logic", "also the timeout", "and is CI green")),
    ).toBe(true);
  });

  it("NO when only SOME of a burst is quoted — the others still need their stub", () => {
    // The half-covered reply is the case the suppression must not take: the two unquoted messages
    // would be left looking exactly as unanswered as they did before, which is the complaint reply
    // anchoring exists for. Mirrors replyWithoutQuote's own all-messages coverage rule.
    const text = "> can you check the retry logic\n\nRetry is fine, timeout was 3s, CI is green.";
    expect(
      leadingQuoteCovers(text, anchors("can you check the retry logic", "also the timeout", "and is CI green")),
    ).toBe(false);
  });

  it("NO when the reply opens by quoting AGENT OUTPUT rather than him", () => {
    // The case that makes this a content measure instead of a position check. A leading blockquote
    // of scrollback is a real quote and keeps its blue bar — but it says nothing about what he
    // asked, so his question must keep its stub. Suppressing here would leave the question nowhere
    // on screen.
    const text = "> ok 47 passed | 2 failed\n\nCI is failing on a payment block, not your tests.";
    expect(leadingQuoteCovers(text, anchors("why is CI red?"))).toBe(false);
  });

  it("NO for a quote BURIED under a preamble — an opening is the whole rule", () => {
    const text = `Good question.\n\n> ${HIS_QUESTION}\n\nThe sweep came back.`;
    expect(leadingQuoteCovers(text, anchors(HIS_QUESTION))).toBe(false);
  });

  it("NO for a reply that anchors nothing — a push has no stub to duplicate", () => {
    expect(leadingQuoteCovers("> something\n\nHeads up.", [])).toBe(false);
    expect(leadingQuoteCovers("> something\n\nHeads up.", undefined)).toBe(false);
  });

  it("NO for an ATTACHMENTS-ONLY send, whose anchor is the app's own words", () => {
    // `attachmentQuote` is pinned by import rather than by a literal, so a change over there turns
    // this red instead of quietly making the exemption stop matching. There is no compliant blue bar
    // for a message that had no words, so the gray one has to stay.
    expect(leadingQuoteCovers("> here are the files\n\nGot them.", anchors(attachmentQuote(2)))).toBe(false);
  });

  it("YES for a MIXED burst — an attachments send beside a text send, quoting the words", () => {
    // THE CASE THAT BROUGHT THE DEFECT BACK (roborev, Medium, on the original PR). The linter's
    // `quotableMessages` DROPS an app-authored anchor before demanding coverage, so it accepts this
    // reply. An `every` over the UNFILTERED anchors still sees "2 attachments" scoring 0.0 and says
    // no — and the two disagreeing is precisely the state that draws BOTH bars, which is the bug
    // this module exists to remove. Only the attachments-ONLY case above was covered before, and it
    // passes either way, so nothing caught this.
    const text = `> ${HIS_QUESTION}\n\nThe sweep came back.`;
    expect(leadingQuoteCovers(text, anchors(attachmentQuote(2), HIS_QUESTION))).toBe(true);
  });

  it("NO for a mixed burst whose TEXT send is not the one quoted", () => {
    // The filter drops the app-authored anchor; it must not weaken the all-anchors rule for the rest.
    const text = `> ${HIS_QUESTION}\n\nBoth answered.`;
    expect(
      leadingQuoteCovers(text, anchors(attachmentQuote(2), HIS_QUESTION, "and what about the DMG?")),
    ).toBe(false);
  });

  it("tolerates a CLEANED quote of dictated speech — the linter's own floor, shared", () => {
    // He dictates, so the compliant quote drops the stutters and is never byte-exact. This is the
    // same threshold `replyWithoutQuote` accepts the reply on; if the two disagreed, a quote the
    // linter passed could still score below this and draw BOTH bars — the reported bug returning
    // through its own fix.
    const said = "so I said drodio.com not jury.com, drodio.com, can you check the DNS on that";
    const text = "> check the DNS on drodio.com\n\nDNS is fine.";
    expect(leadingQuoteCovers(text, anchors(said))).toBe(true);
  });
});

describe("where the blue bar jumps, and what it is called", () => {
  it("jumps to the FIRST message of the burst", () => {
    expect(quoteJumpTarget(anchors("one", "two", "three"))?.id).toBe("you-1");
  });

  it("skips an anchor whose target did not survive restore", () => {
    // `remapAnchors` keeps the quote and empties the id. A control that scrolls nowhere is the dead
    // affordance this column's rules are written against, so the jump moves to the next live one.
    expect(quoteJumpTarget([{ id: "", quote: "gone" }, { id: "you-2", quote: "still here" }])?.id).toBe("you-2");
  });

  it("offers no jump at all when nothing resolves", () => {
    expect(quoteJumpTarget([{ id: "", quote: "gone" }])).toBeUndefined();
    expect(quoteJumpLabel([{ id: "", quote: "gone" }])).toBe("");
  });

  it("names the single message it will show", () => {
    expect(quoteJumpLabel(anchors(HIS_QUESTION))).toBe(`Replying to: ${HIS_QUESTION}. Show that message.`);
  });

  it("does NOT claim one message when the merged bar stands for several", () => {
    // One bar, three messages, and the title shows only the first — so the accessible name has to
    // say how many there are and where the jump lands, or it is a confident sentence about a
    // mapping that does not hold.
    const label = quoteJumpLabel(anchors("one", "two", "three"));
    expect(label).toContain("3 of your messages");
    expect(label).toContain("Show the first.");
  });
});

describe("quoteSourceCovers is the same measure with a stable input", () => {
  it("agrees with leadingQuoteCovers on the same reply", () => {
    // The streaming path memoises on the RUN rather than the text, so the two entry points must not
    // be able to disagree — a divergence would show up as the stub flickering in and out mid-reply.
    const text = `> ${HIS_QUESTION}\n\nThe sweep came back.`;
    expect(quoteSourceCovers(leadingQuoteSource(text), anchors(HIS_QUESTION))).toBe(
      leadingQuoteCovers(text, anchors(HIS_QUESTION)),
    );
  });

  it("is STABLE as the answer streams in under a settled quote", () => {
    // The whole reason the prefix exists. Once the opening quote is complete, every further token
    // must leave the memo key untouched; if it did not, this would re-parse the reply per delta.
    const opening = `> ${HIS_QUESTION}\n\n`;
    const keys = ["The", "The sweep", "The sweep came back.", "The sweep came back. They're one system."].map(
      (tail) => leadingQuoteSource(opening + tail),
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(`> ${HIS_QUESTION}`);
  });
});

describe("stubAnchorsFor — WHICH stubs survive, not merely whether any do", () => {
  const src = (text: string) => leadingQuoteSource(text);
  const quoted = `> ${HIS_QUESTION}\n\nThe sweep came back.`;

  it("keeps the ATTACHMENTS stub in a mixed burst, whose send the blue bar never stood for", () => {
    // Raised in review against the first fix. Filtering app-authored anchors out of the MEASURE made
    // coverage true for a mixed burst — and the row then dropped EVERY stub, including the one for a
    // send the reply's rendered quote does not represent at all. Its only remaining trace was the
    // bar's aria-label, which is not visible text. That is this module's own doctrine violated:
    // partial coverage must not erase the record of what was skipped.
    const a = anchors(attachmentQuote(2), HIS_QUESTION);
    expect(quoteSourceCovers(src(quoted), a)).toBe(true);
    expect(stubAnchorsFor(src(quoted), a).map((x) => x.quote)).toEqual([attachmentQuote(2)]);
  });

  it("drops every stub when the quote covers a burst that has no app-authored send", () => {
    expect(stubAnchorsFor(src(quoted), anchors(HIS_QUESTION))).toEqual([]);
  });

  it("keeps ALL stubs when the quote covers nothing — the fallback, unchanged", () => {
    const a = anchors(attachmentQuote(2), HIS_QUESTION, "and what about the DMG?");
    expect(stubAnchorsFor(src(quoted), a).map((x) => x.quote)).toEqual([
      attachmentQuote(2),
      HIS_QUESTION,
      "and what about the DMG?",
    ]);
  });

  it("keeps the stub for an ATTACHMENTS-ONLY send", () => {
    const a = anchors(attachmentQuote(2));
    expect(stubAnchorsFor(src("> here are the files\n\nGot them."), a).map((x) => x.quote)).toEqual([
      attachmentQuote(2),
    ]);
  });

  it("is empty for a reply that anchors nothing", () => {
    expect(stubAnchorsFor(src(quoted), [])).toEqual([]);
    expect(stubAnchorsFor(src(quoted), undefined)).toEqual([]);
  });
});
