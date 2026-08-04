// The pure half of bead references: what counts as an id in prose, what counts as one in an href,
// and what the clipboard gets.
//
// These are the tests that pin the RECALL/PRECISION split the feature rests on. `findBeadIds` is
// deliberately loose — it hands `BeadPill` every id-shaped token and lets the live store reject the
// ones that are not beads — so the cases below assert both directions of that on purpose: the real
// ids it must never miss, AND the ordinary English it is expected to offer up and have rejected
// downstream. A future tightening that "fixes" the second group breaks the first.
import { describe, expect, it } from "vitest";
import {
  beadRefHref,
  findBeadIds,
  isWellFormedBeadId,
  parseBeadRefHref,
  stripBeadRefs,
} from "./beadRefs";

const ids = (text: string) => findBeadIds(text).map((s) => s.id);

describe("findBeadIds — the founder's own sentence", () => {
  // The example on the bead, verbatim. If this ever stops passing the feature is off.
  it("finds the id in 'settled and recorded on sparkle-17hm1 so no agent re-litigates it'", () => {
    expect(ids("settled and recorded on sparkle-17hm1 so no agent re-litigates it")).toContain(
      "sparkle-17hm1",
    );
  });

  it("reports the span so the text around it survives", () => {
    const [span] = findBeadIds("see sparkle-17hm1 now");
    expect(span).toBeDefined();
    expect("see sparkle-17hm1 now".slice(span!.start, span!.end)).toBe("sparkle-17hm1");
  });
});

describe("findBeadIds — real ids, whose suffix length VARIES", () => {
  // Four real ids of four different suffix lengths. A fixed-width pattern passes on one of these
  // and fails on the rest, which is exactly the bug the bead calls out.
  it.each(["sparkle-76h9", "sparkle-1sp7r", "sparkle-vyghy", "sparkle-17hm1", ""])(
    "finds %s",
    (id) => {
      expect(ids(`filed as ${id} today`)).toEqual([id]);
    },
  );

  // A CHILD bead. The agent id class rejects `.`, so reusing it would have made every one of these
  // permanently unlinkable — see the class's docstring.
  it.each(["sparkle-hiju.4", "bd-a3f8.2"])("finds the child id %s whole", (id) => {
    expect(ids(`blocked on ${id}.`)).toEqual([id]);
  });

  it("finds several in one sentence", () => {
    expect(ids("sparkle-76h9 blocks sparkle-vyghy, and sparkle-hiju.4 is done")).toEqual([
      "sparkle-76h9",
      "sparkle-vyghy",
      "sparkle-hiju.4",
    ]);
  });
});

describe("findBeadIds — boundaries", () => {
  // THE CASE THAT MOTIVATES THE CLOSING BOUNDARY TEST. The pattern happily matches `concierge-bead`
  // inside this, and only "the next character is `-`" rejects it. Without that, every multi-hyphen
  // word in the thread becomes a candidate whose id is a truncation of itself.
  it("does not read a truncation out of a multi-hyphen word", () => {
    expect(ids("PRD/sparkle/concierge-bead-pills is the doc")).toEqual([]);
  });

  it("does not read an id out of a filename", () => {
    expect(ids("see sparkle-t6wje.md for the writeup")).toEqual([]);
  });

  // NOT "returns nothing" — `xsparkle-17hm1` is itself id-shaped (prefix `xsparkle`), and so is
  // `sparkle-17hm1x` (suffix `17hm1x`). Both are candidates the store will reject, which is the
  // design. What must NEVER happen is the real id being CARVED OUT of a longer token, because that
  // would linkify part of a word and open a bead the text was not referring to.
  it("never carves a real id out of a longer token", () => {
    expect(ids("xsparkle-17hm1 and sparkle-17hm1x")).not.toContain("sparkle-17hm1");
  });

  // Trailing punctuation is not part of the id, but it also must not prevent the match.
  it.each([".", ",", ")", ":", ";", "!"])("stops before a trailing %s", (p) => {
    expect(ids(`recorded on sparkle-17hm1${p}`)).toEqual(["sparkle-17hm1"]);
  });

  // Uppercase is not a bead id — this is what keeps ordinary Title Case hyphenation out entirely.
  it("ignores capitalised hyphenation", () => {
    expect(ids("Claude-Code and React-DOM")).toEqual([]);
  });
});

describe("findBeadIds — recall is bought deliberately, precision is bought live", () => {
  // NOT A BUG, AND THE ASSERTION IS DELIBERATE. Ordinary lowercase hyphenated English is id-shaped
  // and comes through as a candidate; `BeadPill` renders it as the prose it always was because the
  // store has no such bead. Filtering it HERE would need a dictionary, and any pattern tight enough
  // to exclude `auto-heal` also excludes `sparkle-vyghy`, which is a real id of the same shape.
  //
  // This test exists so that someone tightening the pattern sees the trade rather than discovering
  // it when real ids stop linkifying.
  it("offers ordinary hyphenated words as candidates for the store to reject", () => {
    expect(ids("the auto-heal path is one-shot")).toEqual(["auto-heal", "one-shot"]);
  });
});

describe("isWellFormedBeadId / parseBeadRefHref — the trust boundary", () => {
  it("accepts a real id", () => {
    expect(parseBeadRefHref(beadRefHref("sparkle-17hm1"))).toBe("sparkle-17hm1");
  });

  it("accepts a child id, which the AGENT class would reject", () => {
    expect(parseBeadRefHref(beadRefHref("sparkle-hiju.4"))).toBe("sparkle-hiju.4");
  });

  it("tolerates leading whitespace, as markdown can carry it into an href", () => {
    expect(parseBeadRefHref(" sparkle-bead:sparkle-17hm1")).toBe("sparkle-17hm1");
  });

  // Path traversal, refused outright. `services/beads.beadShow` reaches a `bd show <id>` shell-out,
  // and an id from model-authored text that can climb a path is a liability whether or not today's
  // call sites take it there.
  it.each(["../../etc/passwd", "a..b", ".."])("refuses %s", (id) => {
    expect(isWellFormedBeadId(id)).toBe(false);
    expect(parseBeadRefHref(`sparkle-bead:${id}`)).toBeNull();
  });

  it.each([".hidden", "-flag"])("refuses a leading sigil in %s", (id) => {
    expect(isWellFormedBeadId(id)).toBe(false);
  });

  it.each(["", "a b", "a/b", "a<b", 'a"b'])("refuses %s", (id) => {
    expect(isWellFormedBeadId(id)).toBe(false);
  });

  it("refuses an unbounded id", () => {
    expect(isWellFormedBeadId(`sparkle-${"x".repeat(200)}`)).toBe(false);
  });

  it.each(["https://example.com", "javascript:alert(1)", "sparkle-agent:ag9", undefined])(
    "reads %s as not-ours",
    (href) => {
      expect(parseBeadRefHref(href)).toBeNull();
    },
  );
});

describe("stripBeadRefs — what the clipboard gets", () => {
  it("flattens an explicit reference to its visible words", () => {
    expect(stripBeadRefs("recorded on [sparkle-17hm1](sparkle-bead:sparkle-17hm1) today")).toBe(
      "recorded on sparkle-17hm1 today",
    );
  });

  it("keeps the author's own label when it is not the id", () => {
    expect(stripBeadRefs("see [the retry bead](sparkle-bead:sparkle-17hm1)")).toBe(
      "see the retry bead",
    );
  });

  // AUTO-LINKIFIED IDS ARE NOT IN THE SOURCE AT ALL — the linkifier transforms the parsed tree, so
  // `m.text` still holds the bare id and copies through byte for byte. This is the property that
  // makes the copy button safe for the common case.
  it("leaves a bare id exactly as written", () => {
    const text = "recorded on sparkle-17hm1 today";
    expect(stripBeadRefs(text)).toBe(text);
  });

  it("leaves an ordinary link alone", () => {
    const text = "see [docs](https://example.com/sparkle-17hm1)";
    expect(stripBeadRefs(text)).toBe(text);
  });

  // remark never parses a link inside a code span; a regex does. A reference quoted as source must
  // copy verbatim or the button is silently editing the code the user asked for (roborev 55092).
  it("does not rewrite a reference inside a code span", () => {
    const text = "the source is `[x](sparkle-bead:sparkle-17hm1)`";
    expect(stripBeadRefs(text)).toBe(text);
  });

  it("does not rewrite a reference inside a fence", () => {
    const text = "```\n[x](sparkle-bead:sparkle-17hm1)\n```";
    expect(stripBeadRefs(text)).toBe(text);
  });

  // The two forms a hand-rolled regex under-stripped: CommonMark allows a title, and an
  // angle-bracketed destination. remark unwraps both into real links, so both must flatten.
  it("strips the titled form remark unwraps into a link", () => {
    expect(stripBeadRefs('see [x](sparkle-bead:sparkle-17hm1 "the bead")')).toBe("see x");
  });

  it("strips the angle-bracketed form", () => {
    expect(stripBeadRefs("see [x](<sparkle-bead:sparkle-17hm1>)")).toBe("see x");
  });
});
