import { describe, expect, it } from "vitest";
import { ensureLeadingFounderQuote } from "./enforceLeadingQuote";
import { leadingQuoteCorpus, overlapCoefficient, QUOTE_MATCH_MIN } from "./checks/replyWithoutQuote";

// The FLOOR under `reply-without-quote`: when the model ships a reply that does not open by quoting
// the founder, code prepends the quote so the founder can always see what is being answered. These
// tests assert the SIDE EFFECT (a leading blockquote of his words appears) — and the mutation that
// deletes the prepend is caught by "prepends the founder's words…" below.
describe("ensureLeadingFounderQuote", () => {
  const FOUNDER = "why did #2139 and #2159 ship from two branches";

  it("prepends the founder's words as a leading blockquote when the reply does not quote them", () => {
    // The exact shape the founder complains about: the reply launches straight into analysis.
    const reply = "You're right and the app is wrong. Both PRs shipped from separate branches.";
    const out = ensureLeadingFounderQuote(reply, [FOUNDER]);

    expect(out.inserted).toBe(true);
    // The reference block is literally the first thing in the rendered reply…
    expect(out.text.startsWith(`> ${FOUNDER}`)).toBe(true);
    // …it carries the founder's ACTUAL triggering words, not a generic label…
    expect(out.text).toContain(FOUNDER);
    // …and the model's analysis still follows underneath it.
    expect(out.text).toContain(reply);
    // The prepended block is a real markdown blockquote that the coverage rule now accepts — i.e. a
    // second pass would no longer fire the check. This is what makes the guarantee end-to-end.
    expect(overlapCoefficient(leadingQuoteCorpus(out.text), FOUNDER)).toBeGreaterThanOrEqual(
      QUOTE_MATCH_MIN,
    );
  });

  it("leaves a reply that ALREADY opens by quoting the founder untouched (model authorship preserved)", () => {
    // A reply the model wrote compliantly — its own quote stands, code inserts nothing.
    const reply = `> ${FOUNDER}\n\nThey shipped from two branches because the merge queue reordered them.`;
    const out = ensureLeadingFounderQuote(reply, [FOUNDER]);

    expect(out.inserted).toBe(false);
    expect(out.text).toBe(reply);
  });

  it("quotes only the UNCOVERED messages of a burst, not the one the model already quoted", () => {
    const first = "please merge the auth PR";
    const second = "and cut a release after";
    // The model quoted only the first of two messages it answers.
    const reply = `> ${first}\n\nMerging now; the release will follow.`;
    const out = ensureLeadingFounderQuote(reply, [first, second]);

    expect(out.inserted).toBe(true);
    expect(out.text).toContain(`> ${second}`);
    // The already-covered message is not duplicated into a second blockquote line.
    expect(out.text.match(new RegExp(`> ${first}`, "g")) ?? []).toHaveLength(1);
  });

  it("stands down when there is nothing to quote (a proactive push carries no founder messages)", () => {
    const reply = "You have 3 P1 beads ready to work.";
    const out = ensureLeadingFounderQuote(reply, []);
    expect(out.inserted).toBe(false);
    expect(out.text).toBe(reply);
  });

  it("does not demand a quote of an app-authored attachments-only send", () => {
    // `quotableMessages` drops "2 attachments" — there is no compliant blockquote of it to write.
    const reply = "Got the files; reviewing them now.";
    const out = ensureLeadingFounderQuote(reply, ["2 attachments"]);
    expect(out.inserted).toBe(false);
    expect(out.text).toBe(reply);
  });
});
