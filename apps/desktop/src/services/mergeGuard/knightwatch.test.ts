import { describe, it, expect } from "vitest";
import {
  isKnightwatchRefusal,
  knightwatchReasonIssue,
  refusalLines,
  knightwatchReasonFor,
  KNIGHTWATCH_MIN_REASON_CHARS,
} from "./knightwatch";

/**
 * A refusal shaped like the one Rust's `merge_pr` produces: several LINES, each naming a probe, its
 * specialist, and a link straight to the comment carrying the question. The exact wording is the
 * Rust side's and is not asserted here — what is asserted is that this module recognises it, and
 * that nothing about carrying it to a reader flattens it.
 */
const REFUSAL = [
  "Refused: PR #1176 still carries 1 unanswered knightwatch [blocking] probe.",
  "",
  "1. [blocking] [from: shape] Q: Does the retry loop bound its attempts?",
  "   https://github.com/drodio/sparkle/pull/1176#issuecomment-5182769304",
  "",
  "Answer it on the pull request — reply citing the probe — or merge with a written reason.",
].join("\n");

describe("isKnightwatchRefusal", () => {
  it("recognises the probe refusal", () => {
    expect(isKnightwatchRefusal(REFUSAL)).toBe(true);
  });

  it("does NOT claim every failed merge is one", () => {
    // Each of these is a real `gh` failure the menu already handled, and each must keep taking the
    // ordinary error path. Offering an override input for a conflict would promise the user that a
    // sentence can merge it — it cannot.
    for (const other of [
      "Pull request is not mergeable: conflicts with the base branch",
      "required status check is pending",
      "gh: command not found",
      "HTTP 401: Bad credentials",
      "",
    ])
      expect(isKnightwatchRefusal(other), other).toBe(false);
  });

  it("needs BOTH the reviewer and the thing being refused over", () => {
    // The reviewer's name alone appears in ordinary chatter (a branch name, a PR title echoed back
    // in an error), and "probe" alone belongs to half the app.
    expect(isKnightwatchRefusal("merge failed on branch sparkle/knightwatch-tuning")).toBe(false);
    expect(isKnightwatchRefusal("the open-PR probe could not answer")).toBe(false);
  });

  it("is case-insensitive, because the message is prose", () => {
    expect(isKnightwatchRefusal("KnightWatch: 2 unanswered PROBES")).toBe(true);
  });
});

describe("isKnightwatchRefusal — a rejected reason is not a probe refusal", () => {
  // VERBATIM from knightwatch.rs. A paraphrase is exactly what let a HIGH defect ship: an
  // unanchored `override reason` exclusion also matched both REAL refusals — each ends by telling
  // the reader how to override — so probe-refusal detection was dead in production while these
  // tests stayed green against a shortened string that omitted that tail. If Rust's wording moves,
  // these must move with it; that coupling is deliberate.
  const REAL_BLOCKING =
    "Merge blocked: PR #1176 carries 1 unanswered [blocking] knightwatch probe.\n\n" +
    "  • probe 1 [from: contract-drift] — \"The landing gate still checks only orchestration.\"\n" +
    "    https://github.com/o/r/pull/1176#issuecomment-5182769304\n\n" +
    "To answer one, post a NEW comment on the PR that cites it by number — \"Probe 1 — applied, " +
    "…\" or \"probe #1 declined because …\". The citation has to be in a comment of YOUR own: a " +
    "later knightwatch comment never clears a probe. Then merge again.\n" +
    "To merge anyway, supply a knightwatch override reason (at least 15 characters, more than one " +
    "word) saying why. It is posted to the PR as a permanent record BEFORE the merge runs.";
  const REAL_UNKNOWN =
    "Merge blocked: could not determine whether PR #1176 carries unanswered [blocking] knightwatch " +
    "probes.\n\n  gh exited 1\n\nThis is \"could not find out\", not \"clean\" — an unreadable " +
    "review gate blocks, the same way the roborev gate does. Fix the read (check `gh auth status` " +
    "and the network) and merge again, or supply a knightwatch override reason (at least 15 " +
    "characters, more than one word) to merge anyway. The reason is posted to the PR before the " +
    "merge runs.";
  const REAL_TOO_SHORT =
    "The knightwatch override reason is too short (4 characters; at least 15 are required). This " +
    "reason is posted to the PR as the permanent record of why a blocking probe was bypassed, so " +
    "it has to say something a reader can evaluate — name the probe and why it does not apply.";
  const REAL_ONE_WORD =
    "The knightwatch override reason must be more than one word. It is posted to the PR as the " +
    "permanent record of why a blocking probe was bypassed — a single token explains nothing to " +
    "whoever reads it next.";

  it("classifies BOTH real refusals, which both mention how to override", () => {
    expect(isKnightwatchRefusal(REAL_BLOCKING)).toBe(true);
    expect(isKnightwatchRefusal(REAL_UNKNOWN)).toBe(true);
  });

  it("does not classify Rust's rejected-reason errors as a probe refusal", () => {
    expect(isKnightwatchRefusal(REAL_TOO_SHORT)).toBe(false);
    expect(isKnightwatchRefusal(REAL_ONE_WORD)).toBe(false);
  });

  it("is not fooled by an ordinary merge error", () => {
    expect(isKnightwatchRefusal("Pull request is not mergeable: the base branch has moved.")).toBe(
      false,
    );
  });
});

describe("knightwatchReasonIssue — an override costs a sentence", () => {
  it("accepts a written reason", () => {
    expect(
      knightwatchReasonIssue("the probe asks about a file this PR does not touch"),
    ).toBeNull();
  });

  it("rejects empty and whitespace-only", () => {
    expect(knightwatchReasonIssue("")).toBe("empty");
    expect(knightwatchReasonIssue("   \n\t ")).toBe("empty");
  });

  // COUNTS THE UNIT RUST COUNTS. `String.length` is UTF-16 code units; Rust's validate_override
  // counts Unicode scalars. Eight astral characters plus a space is 17 code units and 9 scalars, so
  // a length check written as `t.length` PASSES here and then bounces off Rust — and that rejection
  // reads as "unanswered probes, answer them on the pull request", a remedy for a problem the
  // caller does not have. This is the exact string that split the two.
  it("rejects a reason that only clears the floor in UTF-16 code units", () => {
    const astral = "\u{1F600}".repeat(8) + " x"; // 8 emoji + space + x = 10 scalars, 18 code units
    expect([...astral].length).toBeLessThan(15);
    expect(astral.length).toBeGreaterThanOrEqual(15);
    expect(knightwatchReasonIssue(astral)).toBe("too-short");
  });

  it("rejects the one-word waiver a model reaches for first", () => {
    for (const t of ["ok", "fine", "yes", "approved", "lgtm"])
      expect(knightwatchReasonIssue(t), t).toBe("too-short");
  });

  it("rejects a long single token — length alone is not a clause", () => {
    const long = "a".repeat(KNIGHTWATCH_MIN_REASON_CHARS + 10);
    expect(knightwatchReasonIssue(long)).toBe("not-a-sentence");
  });

  it("measures the TRIMMED reason, so padding cannot buy the floor", () => {
    expect(knightwatchReasonIssue(`   ok${" ".repeat(40)}`)).toBe("too-short");
  });
});

describe("refusalLines — the message reaches the reader intact", () => {
  it("keeps one entry per line, blank lines included", () => {
    const lines = refusalLines(REFUSAL);
    expect(lines).toHaveLength(6);
    // The blank separators are what stop the probe list running into the remedy sentence.
    expect(lines[1]).toEqual([]);
    expect(lines[4]).toEqual([]);
  });

  it("turns the comment URL into a LINK segment, not selectable text", () => {
    const link = refusalLines(REFUSAL)
      .flat()
      .find((s) => s.kind === "link");
    expect(link).toBeDefined();
    expect(link).toEqual({
      kind: "link",
      text: "https://github.com/drodio/sparkle/pull/1176#issuecomment-5182769304",
      url: "https://github.com/drodio/sparkle/pull/1176#issuecomment-5182769304",
    });
  });

  it("keeps the text either side of a link", () => {
    const segs = refusalLines("see https://example.com/x now")[0]!;
    expect(segs.map((s) => s.kind)).toEqual(["text", "link", "text"]);
    expect(segs[0]).toEqual({ kind: "text", text: "see " });
    expect(segs[2]).toEqual({ kind: "text", text: " now" });
  });

  it("leaves the sentence's punctuation OUT of the href", () => {
    const segs = refusalLines("read https://example.com/a.");
    const link = segs.flat().find((s) => s.kind === "link");
    expect(link?.url).toBe("https://example.com/a");
    // …and does not eat it either — the reader still sees a full stop.
    expect(segs[0]!.map((s) => ("text" in s ? s.text : "")).join("")).toBe(
      "read https://example.com/a.",
    );
  });

  it("finds EVERY link on a line — `lastIndex` on a shared /g regex is the classic way to lose one", () => {
    const segs = refusalLines("a https://one.example/x b https://two.example/y c");
    expect(segs[0]!.filter((s) => s.kind === "link")).toHaveLength(2);
  });

  it("loses nothing: the segments rejoin to the original message", () => {
    const rebuilt = refusalLines(REFUSAL)
      .map((line) => line.map((s) => ("text" in s ? s.text : "")).join(""))
      .join("\n");
    expect(rebuilt).toBe(REFUSAL);
  });
});

// ── ONE REASON, ONE PULL REQUEST ──────────────────────────────────────────────────────────────
//
// "Merge all ready" merges N PRs in one loop. The damaging version of the override feature is one
// line: hand the loop whatever reason the user typed. These are the tests that line cannot pass.
describe("knightwatchReasonFor", () => {
  const OVERRIDE = { number: 1176, reason: "the probe is about a file this PR does not touch" };

  it("gives the reason to the PR it was written for", () => {
    expect(knightwatchReasonFor(1176, OVERRIDE)).toBe(OVERRIDE.reason);
  });

  it("gives NOTHING to any other PR in the same batch", () => {
    // The failure this prevents: a batch of four merges, one typed sentence, four probes waived.
    for (const other of [1104, 1, 1177, 0, -1176])
      expect(knightwatchReasonFor(other, OVERRIDE), `#${other}`).toBeUndefined();
  });

  it("has no 'there is only one PR so it must be that one' shortcut", () => {
    // A caller merging exactly one PR still gets nothing unless the override NAMES it. The override
    // says who it is for; inference is how the wrong PR ends up carrying someone's words.
    expect(knightwatchReasonFor(999, { number: 1176, reason: OVERRIDE.reason })).toBeUndefined();
  });

  it("is undefined when no override was given at all", () => {
    expect(knightwatchReasonFor(1176)).toBeUndefined();
    expect(knightwatchReasonFor(1176, undefined)).toBeUndefined();
  });
});
