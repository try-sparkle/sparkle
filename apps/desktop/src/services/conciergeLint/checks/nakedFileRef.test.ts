import { describe, expect, it } from "vitest";
import type { CheckPolicy, LintContext } from "../types";
import { FILE_REF_RE, nakedFileRefCheck } from "./nakedFileRef";

const ctx = (policy: Partial<CheckPolicy> = {}): LintContext => ({
  roster: [],
  toolCalls: [],
  refusals: [],
  prevReply: null,
  policy: {
    enabled: true,
    log: false,
    logMatches: false,
    checks: {
      "naked-file-ref": {
        enabled: true,
        severity: "warn",
        autofix: false,
        ...policy,
      },
    },
  },
});

const run = (text: string, policy: Partial<CheckPolicy> = {}) =>
  nakedFileRefCheck.run(text, ctx(policy));

describe("nakedFileRefCheck", () => {
  it("reports a reference dropped in with almost no words around it", () => {
    const { violations } = run("See src/retry.ts:88");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      check: "naked-file-ref",
      severity: "warn",
      action: "warned",
      span: "src/retry.ts:88".length,
    });
  });

  it("reports a bare reference standing alone as a bullet", () => {
    expect(run("- src/retry.ts:88\n- src/queue.ts:12").violations).toHaveLength(2);
  });

  it("leaves the reply text untouched — this check never rewrites", () => {
    const reply = "See src/retry.ts:88";
    expect(run(reply).text).toBe(reply);
  });

  it("stays quiet when the line explains what the code does", () => {
    expect(run("The retry backoff resets at src/retry.ts:88").violations).toEqual([]);
    expect(run("src/retry.ts:88 is where the backoff resets").violations).toEqual([]);
  });

  it("does not count the path's own segments as its explanation", () => {
    // "src", "retry", "ts" would be four-plus words if the reference were not masked first.
    expect(run("apps/desktop/src/services/retry.ts:88").violations).toHaveLength(1);
  });

  it("judges each line on its own", () => {
    const reply = "The backoff resets when the queue drains.\nSee src/retry.ts:88";
    expect(run(reply).violations).toHaveLength(1);
  });

  it("matches a line RANGE and a line:column", () => {
    expect(run("See src/retry.ts:88-104").violations).toHaveLength(1);
    expect(run("See src/retry.ts:88:12").violations).toHaveLength(1);
  });

  // ══ THE LINE, NOT THE TEXT NODE ══════════════════════════════════════════════════════════════
  // Any inline markup splits a paragraph into several mdast text nodes, and an `inlineCode` node is
  // not prose at all. Counting per node read each of these as too few words and fired on a line
  // that plainly explains itself — the most common shape a concierge reply takes.
  it("counts explanation that inline code split off into another text node", () => {
    // Per text node this is " call resets src/retry.ts:88" — two words, so it fired. Per source
    // line it is "Every retryBackoff call resets …" — four.
    expect(run("Every `retryBackoff` call resets src/retry.ts:88").violations).toEqual([]);
  });

  it("counts explanation that bold split off into another text node", () => {
    expect(run("The **retry backoff** resets at src/retry.ts:88").violations).toEqual([]);
  });

  it("counts explanation that a markdown link split off into another text node", () => {
    expect(
      run("The [retry backoff](https://example.test/doc) resets at src/retry.ts:88").violations,
    ).toEqual([]);
  });

  // ══ STILL FIRES ON THE NEW PATH ══════════════════════════════════════════════════════════════
  // Counting the whole source line is more generous than counting a text node, so it could have
  // silenced the check on ANY line containing markup. These pin that it did not.
  it("still fires on a marked-up line that explains nothing", () => {
    // Whole line: "The retry at src/retry.ts:88" — three words, under the bar.
    expect(run("The **retry** at src/retry.ts:88").violations).toHaveLength(1);
  });

  it("still fires when inline code is the only thing on the line besides the ref", () => {
    expect(run("`retryBackoff` src/retry.ts:88").violations).toHaveLength(1);
  });

  it("pins the default boundary at three words firing and four words quiet", () => {
    expect(run("Fixed it in src/retry.ts:88").violations).toHaveLength(1);
    expect(run("Fixed the retry loop in src/retry.ts:88").violations).toEqual([]);
  });

  // ══ ESCAPES AND ENTITIES ═════════════════════════════════════════════════════════════════════
  // Both make the parsed value SHORTER than its source, which used to send the count back to the
  // text node — reinstating the very false positive the line-based count removed, on exactly the
  // marked-up lines where it hurts. Each input below reads under the bar per node and over it per
  // source line, so asserting silence is an assertion about which one is used.
  it("counts the source line when a markdown escape shortens the span", () => {
    // Per node: " resets* at src/retry.ts:88" — two words. Per source line: five.
    expect(run("The **retry backoff** resets\\* at src/retry.ts:88").violations).toEqual([]);
  });

  it("counts the source line when an entity reference shortens the span", () => {
    // Per node: " resets & retries at src/retry.ts:88" — three words. Per source line: seven.
    expect(run("The **retry backoff** resets &amp; retries at src/retry.ts:88").violations).toEqual(
      [],
    );
  });

  it("still recognises a table row whose cell carries an entity", () => {
    const table = ["| file | what |", "| --- | --- |", "| src/retry.ts:88 | a &amp; b |"].join(
      "\n",
    );
    expect(run(table).violations).toEqual([]);
  });

  it("still fires on an escaped line that genuinely explains nothing", () => {
    // The counting path changed; the check must not have gone silent on the degenerate case.
    expect(run("a\\*b src/retry.ts:88").violations).toHaveLength(1);
  });

  it("judges a reference on the SECOND line of a soft-wrapped node against that line", () => {
    // One paragraph, one text node, two source lines. Counting from the node's start would judge
    // this against "The retry backoff resets when the queue drains." and stay quiet.
    const reply = "The retry backoff resets when the queue drains.\nSee src/retry.ts:88";
    expect(run(reply).violations).toHaveLength(1);
  });

  // ══ UNALIGNED *AND* MULTI-LINE ═══════════════════════════════════════════════════════════════
  // The combination is where every previous attempt at "which line is this on" broke. Each case
  // below is a node whose parsed value is a different length from its source AND spans more than
  // one source line, so the answer differs between locating the reference and any of the
  // approximations: the node's start line, or a newline count taken from the decoded value.
  it("finds a reference on a later line of an entity-shortened node", () => {
    // Line 2 is one word, so this must fire. Reading the node's START line reads line 1 and stays
    // quiet.
    const reply = "The **retry backoff** resets &amp; retries.\nSee src/retry.ts:88";
    expect(run(reply).violations).toHaveLength(1);
  });

  it("and the mirror: stays quiet when that later line does explain itself", () => {
    const reply =
      "The **retry backoff** resets &amp; retries.\nThe retry backoff resets there at src/retry.ts:88";
    expect(run(reply).violations).toEqual([]);
  });

  it("is not fooled by an entity that DECODES TO a newline", () => {
    // `&#10;` is the standard idiom for a line break inside a GFM table cell, and micromark decodes
    // it to a real newline in the node's value — a newline the SOURCE does not have. Counting
    // newlines in the value therefore overshoots onto "and again" (2 words) and fires, while the
    // reference's real source line masks to six words and must stay quiet.
    const reply = "Fixed the retry backoff loop &#10; in src/retry.ts:88\nand again";
    expect(run(reply).violations).toEqual([]);
  });

  // ══ MARKDOWN ESCAPES INSIDE THE PATH ═════════════════════════════════════════════════════════
  // `\_` in an identifier is a routine model habit for suppressing emphasis, and it decodes away —
  // so the parsed value holds a path the SOURCE does not contain. Matching the source directly
  // (plus FILE_REF_RE's `\\?` tolerance) is what makes these work.
  it("detects a reference whose path carries a markdown escape", () => {
    expect(run("See src/retry\\_helper.ts:88").violations).toHaveLength(1);
  });

  it("does not let an escaped path's own segments count as its explanation", () => {
    // Unmasked, "apps desktop src services retry helper ts" is seven words and would sail over the
    // bar. The mask has to recognise the escaped form too, or the check goes quiet on a bare path.
    expect(run("apps/desktop/src/services/retry\\_helper.ts:88").violations).toHaveLength(1);
  });

  // roborev 55870: the tolerance covered characters INSIDE segments but not the separators, so a
  // generically-escaping model produced a reference the pattern could not match at all.
  it("detects a reference whose SEPARATORS carry markdown escapes", () => {
    for (const ref of [
      "See src/retry_helper\\.ts:88",
      "See src\\/retry.ts:88",
      "See src/retry.ts\\:88",
    ]) {
      expect(run(ref).violations, `must detect: ${ref}`).toHaveLength(1);
    }
  });

  it("masks a separator-escaped reference so it cannot explain a DIFFERENT one on the same line", () => {
    // The compounding failure: an unmatched reference is also UNMASKED, so its own segments
    // ("src", "a", "ts") were counted as explanation for the second reference and pushed it over the
    // bar — silencing a reference that is genuinely naked. With both masked, "Fixed" and "and" are
    // all that remain, and both references are correctly reported.
    // EXACT, not toBeGreaterThan(0) (roborev 55875): the weaker form passes on the very regression
    // it guards — if src/b.ts:9 stopped being reported while the escaped one still was, the count is
    // 1 and the test stays green. The property is that BOTH fire once masking works.
    expect(run("Fixed src/a\\.ts:12 and src/b.ts:9").violations).toHaveLength(2);
  });

  it("does not resolve an escaped reference onto a different identical occurrence", () => {
    // Line 1 is naked and line 2 explains itself. Searching the source for the DECODED text misses
    // line 1 entirely and lands on line 2, reading six words and reporting nothing at all.
    const reply =
      "See src/retry\\_helper.ts:88\nThe retry backoff resets there at src/retry_helper.ts:88";
    expect(run(reply).violations).toHaveLength(1);
  });

  // A PINNED FALSE NEGATIVE, restored after the fix for it was reverted (roborev 55885). Widening
  // the pattern to accept entities made it exponentially backtrackable AND matched ordinary prose;
  // see the header. The miss stays until something decodes entities before the scan.
  it("does not detect a path whose characters are entity-encoded — the documented miss", () => {
    expect(run("See src/retry&#46;ts:88").violations).toEqual([]);
  });

  // THE EXPENSIVE HALF OF THAT MISS, pinned rather than left in prose (roborev 55895). The single
  // -reference case above only costs its own reference. This one costs a DIFFERENT one: the
  // unmatched entity path is also unmasked, so "Fixed", "src", "retry", "ts", "and" clear the
  // four-word bar and silence `src/b.ts:9`, which is bare and genuinely naked. Asserted so a change
  // to masking or word counting MOVES this test instead of drifting away from the doc.
  it("lets an entity-encoded reference silence a different naked one — the cost of the miss", () => {
    expect(run("Fixed src/retry&#46;ts:12 and src/b.ts:9").violations).toEqual([]);
  });

  // THE REGRESSION GUARD for that revert — STRUCTURAL, because a timing guard cannot work here
  // (roborev 55895). Running the hostile input would be the obvious test and it is unusable: the
  // scan is SYNCHRONOUS, and Vitest's testTimeout is timer-based, so it cannot preempt CPU-bound
  // sync code. A re-widened pattern would never reach the assertion — the worker wedges and CI burns
  // to the workflow timeout with nothing pointing back at this test. The measurement in the revert
  // commit (eight repetitions, not finished in ten minutes) is exactly why: any input big enough to
  // demonstrate the catastrophe is far past the point where a duration can be reported.
  //
  // So assert the PROPERTY that made the pattern safe instead of its symptom. The old pattern was
  // linear only because the separator alternatives were DISJOINT from the segment character class:
  // no input position could be consumed as either, so there was one decomposition, not 2^k. Adding
  // an alternative that both accept — an HTML entity, in the reverted change — is what created the
  // ambiguity. This runs in microseconds and can never hang.
  it("keeps the separator alternatives disjoint from the segment class (the anti-ReDoS property)", () => {
    const src = FILE_REF_RE.source;
    expect(src, "an entity alternative makes a position consumable as segment OR separator — the \
exponential form this file reverted; see the header").not.toMatch(/&#\?/);
    // The separators must stay single literal characters (optionally backslash-escaped), which is
    // what keeps them un-ambiguous with the segment class.
    for (const sep of ["\\\\?\\/", "\\\\?\\.", "\\\\?:"]) {
      expect(src).toContain(sep);
    }
  });

  it("resolves repeated identical references to their own occurrences", () => {
    // Both lines carry the same reference text. Line 1 explains itself, line 2 does not — so a
    // search that always found the FIRST occurrence would report zero instead of one.
    const reply = "The retry backoff resets there at src/retry.ts:88\nSee src/retry.ts:88";
    expect(run(reply).violations).toHaveLength(1);
  });

  // ══ TABLE ROWS ═══════════════════════════════════════════════════════════════════════════════
  // A cell is terse by construction and the header row is the explanation, so the prose word bar
  // does not apply and the row is skipped. See the check's header for the accepted cost.
  it("skips a GFM table row", () => {
    const table = [
      "| file | what it does |",
      "| --- | --- |",
      "| src/retry.ts:88 | resets the backoff |",
    ].join("\n");
    expect(run(table).violations).toEqual([]);
  });

  it("skips a table row even when its explanation cell is empty — the accepted miss", () => {
    const table = ["| file | what |", "| --- | --- |", "| src/retry.ts:88 |  |"].join("\n");
    expect(run(table).violations).toEqual([]);
  });

  it("does NOT treat a sentence that merely contains a pipe as a table row", () => {
    // Three words, so a loose "contains a pipe" test would have wrongly skipped it.
    expect(run("See a | b src/retry.ts:88").violations).toHaveLength(1);
  });

  it("does NOT read a reference out of a bare URL the renderer would autolink", () => {
    // The url's own path matches FILE_REF_RE, and masking it leaves only "See https" — two words —
    // so without the bare-url exclusion this fired on a link.
    expect(run("See https://github.test/o/r/blob/main/src/retry.ts:88").violations).toEqual([]);
  });

  it("STILL reads a reference out of a scheme GFM does not autolink", () => {
    // `file://` is not a GFM autolink, so the reader sees it as plain prose and so must the check.
    expect(run("See file:///Users/x/src/retry.ts:88").violations).toHaveLength(1);
  });

  it("does NOT fire on colon-digit text that is not a file reference", () => {
    expect(run("Ratio 3:1").violations).toEqual([]);
    expect(run("Merged at 12:45").violations).toEqual([]);
    expect(run("See retry:88").violations).toEqual([]);
    expect(run("See src/retry:88").violations).toEqual([]);
  });

  it("does NOT fire inside a fenced code block", () => {
    expect(run("Landed.\n\n```\nsrc/retry.ts:88\n```\n\nGreen.").violations).toEqual([]);
  });

  it("does NOT fire inside an inline code span", () => {
    expect(run("Look at `src/retry.ts:88`.").violations).toEqual([]);
  });

  it("does NOT fire inside a blockquote quoting the user", () => {
    expect(run("You asked:\n\n> src/retry.ts:88\n\nIt resets the backoff.").violations).toEqual([]);
  });

  it("uses the policy threshold as the words-of-explanation bar", () => {
    const reply = "The retry backoff resets at src/retry.ts:88"; // five words of explanation
    expect(run(reply, { threshold: 4 }).violations).toEqual([]);
    expect(run(reply, { threshold: 9 }).violations).toHaveLength(1);
  });

  it("carries the policy's severity onto the violation", () => {
    expect(run("See src/retry.ts:88", { severity: "block" }).violations[0]!.severity).toBe("block");
  });
});
