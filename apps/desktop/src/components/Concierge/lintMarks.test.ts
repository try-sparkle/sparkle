// THE WORDING IS THE FEATURE, so it is tested as a function rather than through a rendered tree —
// the same reason `RoutingReceipt.receiptText` is. A mark that says "ask-without-action" is a log
// line; a mark that says "Said it would do it — then didn't" is the founder's own complaint read
// back to him, and that difference is what bead sparkle-kr2jz is about.
import { describe, expect, it } from "vitest";

// The AUTHORITATIVE check list, imported from the metrics store on purpose. `lintMarks` deliberately
// does NOT import it (nothing under components/Concierge touches a store), so this file is where the
// two are held together: a check shipped without a sentence fails HERE rather than printing its own
// id at the founder in production.
import { LINT_CHECK_IDS } from "../../stores/conciergeLintMetrics";
import {
  LINT_DETAIL_MAX_LEN,
  MAX_LINT_MARKS,
  lintCheckSentence,
  lintMarkText,
  normalizeLintMarks,
  toLintMarks,
  type MessageLintMark,
} from "./lintMarks";

const mark = (check: string, detail = "why"): MessageLintMark => ({
  check,
  severity: "warn",
  detail,
});

describe("lintCheckSentence — a check id becomes something the founder can read", () => {
  it("gives EVERY shipped check a human sentence, not its id", () => {
    for (const id of LINT_CHECK_IDS) {
      const said = lintCheckSentence(id);
      // The two failure modes, both of which would ship a check id to the reader: no row at all
      // (the fallback fires) and a row that merely restates the id.
      expect(said, `${id} fell through to the fallback`).not.toContain(id);
      expect(said.length, `${id} has no sentence`).toBeGreaterThan(10);
    }
  });

  it("words the headline check as the complaint it detects", () => {
    // The one the bead names explicitly: reporting accurately and then asking permission instead of
    // acting. Pinned by content, not merely by "is non-empty", because the copy IS the deliverable.
    expect(lintCheckSentence("ask-without-action")).toBe("Said it would do it — then didn't, this turn");
  });

  it("gives each check a DISTINCT sentence", () => {
    // A positive control on the row above: eleven ids mapped to one string would pass every
    // per-id assertion here and tell the reader nothing about which check fired.
    const said = LINT_CHECK_IDS.map(lintCheckSentence);
    expect(new Set(said).size).toBe(LINT_CHECK_IDS.length);
  });

  it("names an UNKNOWN check rather than inventing reassuring copy", () => {
    // The linter's registry is open (`registerCheck`), so an id can reach this build that has no row.
    // Saying "something looked off" would hide the gap behind copy that reads deliberate.
    expect(lintCheckSentence("some-future-check")).toBe("Flagged by some-future-check");
  });
});

describe("lintMarkText — many findings, ONE line", () => {
  it("says nothing at all for a clean reply", () => {
    expect(lintMarkText(undefined)).toBeNull();
    expect(lintMarkText([])).toBeNull();
  });

  it("words a single finding with no count", () => {
    expect(lintMarkText([mark("hedge-words")])).toBe("Hedged instead of saying what happened");
  });

  it("collapses several findings to the FIRST sentence plus a count", () => {
    const text = lintMarkText([mark("ask-without-action"), mark("hedge-words"), mark("naked-file-ref")]);
    expect(text).toBe("Said it would do it — then didn't, this turn · +2 more");
    // The negative control that makes the row above mean something: the collapse must not silently
    // become a concatenation of all three, which is the shape that would push the conversation off
    // screen in a column this narrow.
    expect(text).not.toContain("Hedged");
  });
});

describe("toLintMarks — the linter's violations, narrowed to metadata", () => {
  it("returns undefined for a clean turn rather than an empty array", () => {
    expect(toLintMarks(undefined)).toBeUndefined();
    expect(toLintMarks([])).toBeUndefined();
  });

  it("keeps ONLY check, severity and detail — never a span, never text", () => {
    // The rule this feature has to honour: `Violation.span` is a character COUNT and the log is
    // metadata-only. A projection that spread the violation through would carry whatever a future
    // check adds to it, including matched text, straight into localStorage.
    const marks = toLintMarks([
      { check: "hedge-words", severity: "warn", detail: 'hedging word "should"', span: 6, action: "warned" } as never,
    ])!;
    expect(marks[0]).toEqual({ check: "hedge-words", severity: "warn", detail: 'hedging word "should"' });
    expect(Object.keys(marks[0]!).sort()).toEqual(["check", "detail", "severity"]);
  });

  it("caps how many marks one message may carry", () => {
    // `hedge-words` reports one violation PER WORD, so this is the realistic case, not a corner one.
    const many = Array.from({ length: MAX_LINT_MARKS + 9 }, () => mark("hedge-words"));
    expect(toLintMarks(many)).toHaveLength(MAX_LINT_MARKS);
  });

  it("clips an over-long detail", () => {
    const marks = toLintMarks([mark("hedge-words", "x".repeat(LINT_DETAIL_MAX_LEN + 500))])!;
    expect(marks[0]!.detail).toHaveLength(LINT_DETAIL_MAX_LEN);
  });

  it("drops a record with no check id instead of rendering a blank mark", () => {
    const marks = toLintMarks([{ severity: "warn", detail: "x" } as never, mark("hedge-words")]);
    expect(marks).toEqual([{ check: "hedge-words", severity: "warn", detail: "why" }]);
  });
});

describe("normalizeLintMarks — what comes back off disk is not trusted", () => {
  it("rejects anything that is not an array", () => {
    expect(normalizeLintMarks(undefined)).toBeUndefined();
    expect(normalizeLintMarks("[]")).toBeUndefined();
    expect(normalizeLintMarks({ check: "hedge-words" })).toBeUndefined();
  });

  it("drops junk entries and keeps the real ones", () => {
    expect(normalizeLintMarks([null, "nope", 7, mark("restated-state")])).toEqual([
      { check: "restated-state", severity: "warn", detail: "why" },
    ]);
  });

  it("re-applies the caps a hand-edited localStorage could have blown past", () => {
    const forged = Array.from({ length: 50 }, () => ({
      check: "hedge-words",
      severity: "warn",
      detail: "y".repeat(5000),
    }));
    const marks = normalizeLintMarks(forged)!;
    expect(marks).toHaveLength(MAX_LINT_MARKS);
    expect(marks[0]!.detail).toHaveLength(LINT_DETAIL_MAX_LEN);
  });
});
