import { describe, expect, it } from "vitest";
import type { CheckPolicy, LintContext } from "../types";
import { FILE_REF_RE, SEGMENT_CHAR, SEPARATORS, nakedFileRefCheck } from "./nakedFileRef";

const ctx = (policy: Partial<CheckPolicy> = {}): LintContext => ({
  roster: [],
  toolCalls: [],
  refusals: [],
  prevReply: null,
  founderMessages: [],
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

  // THE REGRESSION GUARD for the ReDoS revert — a PROPERTY test, asserted by matching.
  //
  // Three earlier attempts failed in instructive ways, and each failure narrowed what the guard has
  // to do:
  //
  //   1. A TIMING guard cannot work at all. The scan is synchronous and Vitest's `testTimeout` is
  //      timer-based, so it cannot preempt CPU-bound sync code: a re-widened pattern wedges the
  //      worker instead of failing, and CI burns to the workflow timeout with nothing pointing back
  //      here (roborev 55895). The measurement in the revert commit — eight repetitions, not
  //      finished in ten minutes — is why: any input big enough to demonstrate the catastrophe is
  //      far past the point where a duration can be reported.
  //   2. SEARCHING THE SOURCE for the token from the reverted diff pins one SPELLING. `&\w+;` or
  //      `&(?:#\d+|\w+);` reintroduce the same ambiguity with the test green (roborev 55898).
  //   3. Comparing candidates against ONE segment character was still too narrow (roborev 55955).
  //      The ambiguity is between the separator and the repeated run `SEG+`, not a single `SEG`, so
  //      a multi-character widening like `\.\.` — consumable either as two segment chars or as one
  //      separator, inside the outer `+` — slipped through. It also made the multi-character
  //      candidates below dead weight, since a single-char class can never accept them.
  //
  // So: a separator must never accept a string that a RUN of segment characters also accepts. With
  // the two disjoint there is exactly one decomposition of any input, the engine never backtracks
  // across alternatives, and 2^k cannot arise.
  //
  // WHICH SEPARATOR MATTERS, precisely. The exponential form is `(?:E+E)+` — the overlap has to be
  // on the separator that CLOSES THE REPEATED GROUP, because only then does each extra ambiguous
  // position double the ways to split the repetition. That is `SEPARATORS[0]`, the `/`.
  //
  // The extension `.` DOES overlap the segment class (which contains `.`), and that is fine and
  // pre-existing: it sits OUTSIDE the outer `+`, so it is a single choice point per dot —
  // polynomial at worst, not 2^k. Asserting disjointness for all three separators would fail on the
  // pattern as shipped and would have to be weakened until it proved nothing.

  /** Strings a separator and a RUN of segment characters both accept — i.e. positions consumable
   *  two ways. Empty means the two are disjoint and the repetition is unambiguous.
   *
   *  Exported as a helper so the guard below and the meta-test that proves the guard can FAIL both
   *  drive this one implementation. An inlined copy in the meta-test would assert that the regex
   *  engine works, not that this guard does — it would stay green with the real assertion deleted
   *  (roborev 55955). */
  function overlapsSegmentRun(separatorSource: string, segmentSource = SEGMENT_CHAR): string[] {
    // `+`, not a single character: the ambiguity that produces `(?:E+E)+` is against the whole
    // repeated run. This is what catches a multi-character widening such as `\.\.`.
    //
    // `segmentSource` is a parameter with the real class as its default ONLY so the meta-test can
    // reproduce the historical revert faithfully. That change widened BOTH sides — an entity was
    // added to the segment class AND to the separator — and it had to, because `&amp;` is not a run
    // of `[A-Za-z0-9_.@-]`. Passing a widened separator alone would prove nothing about the entity
    // case. The guard itself never passes this argument.
    const segmentRun = new RegExp(`^(?:${segmentSource})+$`);
    const separator = new RegExp(`^(?:${separatorSource})$`);
    // A NULLABLE separator is the other canonical route to `(a+)+` and the candidate filter below
    // structurally cannot see it (roborev 55982): every candidate is non-empty and `segmentRun`
    // requires at least one character, so nothing it tests can reveal an empty match. If the
    // separator accepts "" then `(?:SEG+ SEP)+` collapses to `(?:SEG+)+` — fully catastrophic, and
    // strictly worse than the pattern this file reverted — while the filter returns clean. Checked
    // first, and reported as a distinct marker so the failure message names the real cause.
    if (separator.test("")) return ["<matches the empty string>"];
    const candidates: string[] = [];
    for (let c = 0x20; c < 0x7f; c++) {
      const ch = String.fromCharCode(c);
      candidates.push(ch, `\\${ch}`);
    }
    // Multi-character forms a widening would plausibly introduce. Entities were the real case; `..`
    // and `aa` cover the plain repeated-segment shape that finding #3 above was about. These are
    // only meaningful because `segmentRun` matches runs — under a single-character test they could
    // never overlap, which is exactly how they became dead weight before.
    candidates.push("&#46;", "&period;", "&amp;", "&#x2e;", "&nbsp;", "&#47;", "..", "aa", "a.b");
    return candidates.filter((c) => separator.test(c) && segmentRun.test(c));
  }

  it("is assembled EXACTLY as the disjointness guard below assumes", () => {
    // The companion to the property guard, and it took two rounds to get right (roborev 55982, then
    // 55985). The guard below tests `SEPARATORS[0]` and only `SEPARATORS[0]`, because that is the
    // separator closing the ONE nested repetition — the single position where an overlap goes
    // exponential. Two ways that assumption can rot, and a `startsWith` prefix check caught neither:
    //
    //   • A restructure could close the repetition with `SEPARATORS[1]` — the `.`, which ALREADY
    //     overlaps the segment class and is safe only because it sits OUTSIDE the `+`.
    //   • A restructure could ADD a second repetition further along (say `(?:SEG+\.)+` to allow
    //     `a.b.c.ts`) while leaving the prefix untouched. A prefix assertion stays green, and the
    //     new repetition is closed by the overlapping `.`. That is the reverted exponential form,
    //     reachable with every guard passing.
    //
    // So pin the WHOLE assembled source. Any structural change fails here and forces the author to
    // re-derive which separators sit inside a repetition before touching the guard. The property
    // test below is what explains WHY that matters; this is what makes its single-separator scope
    // provably sufficient.
    //
    // Built through `new RegExp` rather than compared as a raw string: `RegExp.prototype.source`
    // returns the ESCAPED pattern (`EscapeRegExpPattern` normalizes a bare `/` to `\/`), so a
    // cosmetic respelling of a separator would otherwise fail with a message blaming a restructure
    // that never happened (roborev 55985). Both sides go through the same normalization.
    const expected = new RegExp(
      `(?:(?:${SEGMENT_CHAR})+${SEPARATORS[0]})+` +
        `(?:${SEGMENT_CHAR})+${SEPARATORS[1]}` +
        `[A-Za-z][A-Za-z0-9]*${SEPARATORS[2]}` +
        String.raw`\d+(?:\\?[:-]\d+)?`,
    ).source;
    expect(
      FILE_REF_RE.source,
      "FILE_REF_RE was restructured. The guard below assumes there is exactly ONE nested repetition \
and that SEPARATORS[0] closes it — re-derive which separators now sit inside a repetition, and point \
the disjointness guard at every one of them, before updating this pin.",
    ).toBe(expected);
  });

  it("keeps the REPEATED separator disjoint from the segment RUN (the anti-ReDoS property)", () => {
    const overlap = overlapsSegmentRun(SEPARATORS[0]);
    expect(
      overlap,
      `the repeated separator /${SEPARATORS[0]}/ is AMBIGUOUS with the segment run: ${JSON.stringify(
        overlap,
      )}. Either it accepts a string a run of segment characters also accepts, or it accepts the \
EMPTY string (which collapses the repetition to (?:SEG+)+ outright). Either way a position inside \
the repetition is consumable more than one way, which is the exponential form this file reverted. \
See FILE_REF_RE.`,
    ).toEqual([]);
  });

  it("that guard DETECTS an overlap, including a multi-character one", () => {
    // Drives the real helper, so deleting the guard's alphabet, its `SEPARATORS[0]` reference, or
    // its assertion breaks this too. Both spellings below share no token with the reverted diff.
    //
    // `\.\.` is the case the single-character version of this guard missed entirely: two segment
    // characters, also matchable as one separator, inside the outer `+`.
    expect(overlapsSegmentRun(String.raw`\\?\/|\.\.`), "a multi-character widening").toContain("..");
    // The historical case, reproduced as it actually was: the entity went into BOTH the segment
    // class and the separator. That is what made a single entity consumable two ways.
    expect(
      overlapsSegmentRun(String.raw`\\?\/|&\w+;`, String.raw`\\?[A-Za-z0-9_.@-]|&\w+;`),
      "the entity widening that was reverted",
    ).toContain("&amp;");
    // A NULLABLE separator collapses `(?:SEG+ SEP)+` to `(?:SEG+)+` — the textbook `(a+)+`, worse
    // than what was reverted. No candidate string can expose it, hence the dedicated check.
    expect(overlapsSegmentRun(String.raw`\\?\/?`), "a nullable separator").toEqual([
      "<matches the empty string>",
    ]);
  });

  it("does not flag the SAFE pattern as overlapping when the segment class is widened alone", () => {
    // The other half of "the guard can fail": it must not fire on everything. Widening only the
    // segment class leaves the repeated separator `/` still unmatchable by it, so there is no
    // ambiguity inside the repetition and no exponential form.
    expect(overlapsSegmentRun(SEPARATORS[0], String.raw`\\?[A-Za-z0-9_.@-]|&\w+;`)).toEqual([]);
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
