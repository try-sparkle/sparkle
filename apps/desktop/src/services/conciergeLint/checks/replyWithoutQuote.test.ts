// The `reply-without-quote` check — does a reply OPEN by quoting the message it is answering?
//
// Every assertion here is written against the SIDE EFFECT (a violation, or the absence of one for a
// reply that would otherwise be blocked), never against the ctx object it was built from. The two
// halves that make a case non-vacuous are always present: the compliant reply passes AND the
// non-compliant one is blocked, over the same founder message.
import { describe, expect, it } from "vitest";
import {
  APP_AUTHORED_QUOTE_RE,
  leadingQuoteCorpus,
  overlapCoefficient,
  QUOTE_MATCH_MIN,
  REPLY_WITHOUT_QUOTE_CHECK_ID,
  replyWithoutQuoteCheck,
} from "./replyWithoutQuote";
import type { CheckPolicy, LintContext, LintPolicy } from "../types";
import { LINT_CHECK_IDS } from "../../../stores/conciergeLintMetrics";
import { attachmentQuote } from "../../../components/Concierge/replyAnchors";

const ROW: CheckPolicy = { enabled: true, severity: "block", autofix: false };

const policy = (over: Partial<CheckPolicy> = {}): LintPolicy => ({
  enabled: true,
  log: false,
  logMatches: false,
  checks: { [REPLY_WITHOUT_QUOTE_CHECK_ID]: { ...ROW, ...over } },
});

const ctx = (founderMessages: readonly string[], over: Partial<LintContext> = {}): LintContext => ({
  roster: [],
  toolCalls: [],
  refusals: [],
  prevReply: null,
  founderMessages,
  policy: policy(),
  ...over,
});

const run = (text: string, founderMessages: readonly string[], over: Partial<LintContext> = {}) =>
  replyWithoutQuoteCheck.run(text, ctx(founderMessages, over));

/** One real founder message and a reply that opens by quoting a piece of it. */
const ASKED = "Can you get the DNS for drodio.com pointed at the new load balancer today";
const QUOTED_REPLY = "> get the DNS for drodio.com pointed at the new load balancer\n\nDone — it is cut over.";

describe("reply-without-quote — the reply is not answering anything", () => {
  it("(a) stands down entirely when there is no founder message this turn", () => {
    // A proactive push. Nobody asked for it, so there is nothing to quote and no violation is
    // possible however the reply is written.
    expect(run("Kraken Auth just went red on CI.", []).violations).toEqual([]);
    // The SAME unquoted reply against a real message IS blocked — otherwise this proves nothing.
    expect(run("Kraken Auth just went red on CI.", [ASKED]).violations).toHaveLength(1);
  });

  it("stands down when the only message it answers is an attachments-only send", () => {
    // `anchorQuote`'s fallback chain ends at `attachmentQuote`, which is the APP's words, not the
    // founder's. Demanding a blockquote of "2 attachments" would block a reply whose compliant form
    // does not exist.
    expect(run("Read them — the second one is the signed cert.", ["2 attachments"]).violations) //
      .toEqual([]);
    expect(run("Got it.", ["1 attachment"]).violations).toEqual([]);
  });

  it("pins the app-authored pattern against attachmentQuote itself", () => {
    // The filter above is a regex over a string another module produces. Asserting the two agree is
    // what stops a change to `attachmentQuote` from silently turning that exemption off.
    expect(APP_AUTHORED_QUOTE_RE.test(attachmentQuote(1))).toBe(true);
    expect(APP_AUTHORED_QUOTE_RE.test(attachmentQuote(4))).toBe(true);
    // And it must not swallow a founder message that merely mentions attachments.
    expect(APP_AUTHORED_QUOTE_RE.test("send me the 2 attachments from that thread")).toBe(false);
  });
});

describe("reply-without-quote — one founder message", () => {
  it("(b) passes a reply that opens with a blockquote of what was asked", () => {
    expect(run(QUOTED_REPLY, [ASKED]).violations).toEqual([]);
  });

  it("passes when the opening quote is preceded only by blank lines", () => {
    expect(run(`\n\n${QUOTED_REPLY}`, [ASKED]).violations).toEqual([]);
  });

  it("(c) blocks a reply with no blockquote at all", () => {
    const v = run("Done — DNS is cut over to the new load balancer.", [ASKED]).violations;
    expect(v).toHaveLength(1);
    expect(v[0]!.check).toBe(REPLY_WITHOUT_QUOTE_CHECK_ID);
    expect(v[0]!.severity).toBe("block");
    // `warned` at detection time, like every other check: only the component that performs a
    // revision may claim one (roborev 55981).
    expect(v[0]!.action).toBe("warned");
    // Metadata only — a character COUNT, and zero when there was no opening quote to count.
    expect(v[0]!.span).toBe(0);
    // The detail names the shortfall in counts, never a word of the reply or of the message.
    expect(v[0]!.detail).not.toContain("DNS");
    expect(v[0]!.detail).not.toContain("drodio");
  });

  it("(d) blocks a reply that buries the blockquote under a preamble", () => {
    const preamble = `Sure thing — here's what you asked:\n\n> ${ASKED}\n\nDone.`;
    const v = run(preamble, [ASKED]).violations;
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toMatch(/did not open/i);
    // The same quote WITH the preamble removed passes, which is what pins the failure on the
    // POSITION of the quote rather than on its content.
    expect(run(`> ${ASKED}\n\nDone.`, [ASKED]).violations).toEqual([]);
  });

  it("blocks a reply whose only blockquote is at the end", () => {
    expect(run(`Done — it is cut over.\n\n> ${ASKED}`, [ASKED]).violations).toHaveLength(1);
  });

  it("(g) blocks an opening blockquote that quotes something unrelated", () => {
    // A quote is present, at the top, and is not the founder's words. The similarity floor is the
    // only thing standing between this and a check that any `>` line satisfies.
    const wrong = "> ship the v0.62 release notes and notarize the DMG\n\nDNS is cut over.";
    const v = run(wrong, [ASKED]).violations;
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toMatch(/matched|quote/i);
    // And its span IS counted here, because there was an opening quote — it just did not match.
    expect(v[0]!.span).toBeGreaterThan(0);
  });

  it("blocks an opening blockquote made only of filler words shared with the message", () => {
    // The stopword floor. Without it, "> can you get the" clears any founder message containing
    // those words, which is most of them.
    expect(run("> can you, and I can do that\n\nDone.", [ASKED]).violations).toHaveLength(1);
  });
});

describe("reply-without-quote — dictated speech", () => {
  // (f) Voice-to-text: stutters, a self-correction, a repeated clause. The reply's quote is the
  // CLEANED sentence, so it is not a byte-exact substring of anything the founder said.
  const DICTATED =
    "I said drodeo.com not jury.com, drodio.com — can you point, uh, can you point the DNS at the new load balancer";

  it("(f) passes a cleaned quote of a stuttered, self-corrected message", () => {
    const cleaned = "> can you point the DNS at drodio.com at the new load balancer\n\nDone.";
    expect(run(cleaned, [DICTATED]).violations).toEqual([]);
  });

  it("still blocks an unrelated quote of a dictated message", () => {
    // The pair that proves the tolerance is a threshold and not a pass-everything.
    expect(run("> merge the two open PRs on Kraken Auth\n\nDone.", [DICTATED]).violations) //
      .toHaveLength(1);
  });
});

describe("reply-without-quote — a queued burst", () => {
  // (e) Several messages sent while a turn was in flight; one reply covers the burst. `pendingAnchors`
  // hands them over oldest-first, and EVERY one of them has to be represented in the opening quotes.
  const BURST = [
    "point the DNS for drodio.com at the new load balancer",
    "also bump the staging cert before it expires on Friday",
  ];

  it("passes when the opening quotes cover both messages", () => {
    const reply = [
      "> point the DNS for drodio.com at the new load balancer",
      "> bump the staging cert before it expires Friday",
      "",
      "Both done.",
    ].join("\n");
    expect(run(reply, BURST).violations).toEqual([]);
  });

  it("passes when the two are quoted as two separate opening blockquotes", () => {
    const reply = [
      "> point the DNS for drodio.com at the new load balancer",
      "",
      "> bump the staging cert before it expires Friday",
      "",
      "Both done.",
    ].join("\n");
    expect(run(reply, BURST).violations).toEqual([]);
  });

  it("(e) blocks when the opening quotes cover only one of them", () => {
    const reply = "> point the DNS for drodio.com at the new load balancer\n\nDone. Cert is fine too.";
    const v = run(reply, BURST).violations;
    expect(v).toHaveLength(1);
    // ONE violation for the reply, not one per uncovered message — the failure is "this reply did
    // not open by quoting me", and counting it twice would overstate the drift number.
    expect(v[0]!.detail).toContain("1 of 2");
  });

  it("does not count a blockquote that appears only AFTER the prose as coverage", () => {
    const reply = [
      "> point the DNS for drodio.com at the new load balancer",
      "",
      "Both done.",
      "",
      "> bump the staging cert before it expires Friday",
    ].join("\n");
    expect(run(reply, BURST).violations).toHaveLength(1);
  });
});

describe("reply-without-quote — policy", () => {
  it("carries the configured severity", () => {
    const warned = replyWithoutQuoteCheck.run(
      "Done.",
      ctx([ASKED], { policy: policy({ severity: "warn" }) }),
    );
    expect(warned.violations[0]!.severity).toBe("warn");
  });

  it("returns the text byte-identical — this check never rewrites", () => {
    const text = "Done — DNS is cut over.";
    expect(run(text, [ASKED]).text).toBe(text);
    expect(run(QUOTED_REPLY, [ASKED]).text).toBe(QUOTED_REPLY);
  });

  it("survives a context with no founderMessages at all", () => {
    // The field is required by the type, but this runs on model-authored input inside a linter whose
    // one unacceptable failure is losing a reply. A malformed ctx must not throw.
    const broken = { ...ctx([ASKED]), founderMessages: undefined } as unknown as LintContext;
    expect(() => replyWithoutQuoteCheck.run("Done.", broken)).not.toThrow();
    expect(replyWithoutQuoteCheck.run("Done.", broken).violations).toEqual([]);
  });

  it("is counted — an id the metrics store lacks is a permanent zero", () => {
    expect(LINT_CHECK_IDS).toContain(REPLY_WITHOUT_QUOTE_CHECK_ID);
  });
});

describe("reply-without-quote — the parts", () => {
  it("leadingQuoteCorpus takes the opening run of blockquotes and stops at the first prose", () => {
    expect(leadingQuoteCorpus("> one\n> two\n\nprose\n\n> three")).toContain("one");
    expect(leadingQuoteCorpus("> one\n> two\n\nprose\n\n> three")).not.toContain("three");
    expect(leadingQuoteCorpus("prose\n\n> one")).toBe("");
    expect(leadingQuoteCorpus("")).toBe("");
  });

  it("overlapCoefficient is symmetric about which side is the excerpt", () => {
    const long = "point the DNS for drodio.com at the new load balancer today please";
    const short = "point the DNS at the load balancer";
    expect(overlapCoefficient(short, long)).toBeGreaterThanOrEqual(QUOTE_MATCH_MIN);
    expect(overlapCoefficient(long, short)).toBeGreaterThanOrEqual(QUOTE_MATCH_MIN);
    expect(overlapCoefficient("merge the release PR", long)).toBeLessThan(QUOTE_MATCH_MIN);
  });

  it("overlapCoefficient ignores case, punctuation and whitespace runs", () => {
    expect(overlapCoefficient("DNS, load-balancer!", "dns   load balancer")).toBe(1);
  });
});
