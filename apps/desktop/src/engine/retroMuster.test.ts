import { describe, it, expect } from "vitest";
import { assessNoRetroReason, MIN_REASON_TEXT_CHARS } from "./retroMuster";
import { NO_RETRO_REASONS } from "./retroReceiptTypes";

/** A reason text that is long enough and says something. Reused so each test varies ONE thing. */
const GOOD = "Superseded by the concierge work; nothing of mine reached a branch.";

describe("a well-formed reason is excused", () => {
  it("excuses every code in the vocabulary when the text is real", () => {
    // The founder's decision, implemented literally: well-formed passes. If a later change makes
    // some codes need evidence, this test is the thing that should fail and force the conversation.
    for (const code of NO_RETRO_REASONS) {
      expect(assessNoRetroReason(code, GOOD).verdict).toBe("excused");
    }
  });

  it("never claims the reason was VERIFIED — only that it was stated", () => {
    // The `why` outlives the agent and is all a later reader has. If it ever reads like
    // confirmation, a reader will believe the app checked something it cannot check.
    for (const code of NO_RETRO_REASONS) {
      const { why } = assessNoRetroReason(code, GOOD);
      expect(why).toMatch(/stated|gave a reason/);
      expect(why).not.toMatch(/verified|confirmed|checked|proven/);
    }
  });

  it("accepts a legitimately SHORT reason at the threshold", () => {
    const atThreshold = "superseded by PR 1204";
    expect(atThreshold.length).toBeGreaterThanOrEqual(MIN_REASON_TEXT_CHARS);
    expect(assessNoRetroReason("superseded", atThreshold).verdict).toBe("excused");
  });
});

describe("an off-vocabulary code is rejected", () => {
  it("rejects a category the agent invented", () => {
    for (const bad of ["frictionless", "busy", "", "NO-CHANGES", null, undefined, 7, {}]) {
      const r = assessNoRetroReason(bad, GOOD);
      expect(r.verdict).toBe("rejected");
      expect(r.why).toMatch(/not one of the recognized kinds/);
    }
  });
});

describe("an empty or filler explanation is rejected", () => {
  it("rejects a missing or non-string explanation", () => {
    for (const bad of [undefined, null, 42, {}, [], ""]) {
      expect(assessNoRetroReason("other", bad).verdict).toBe("rejected");
    }
  });

  it("rejects whitespace-only text", () => {
    expect(assessNoRetroReason("other", "   \n\t  ").verdict).toBe("rejected");
  });

  it("rejects text that is too brief to be a reason", () => {
    const r = assessNoRetroReason("no-changes", "no changes");
    expect(r.verdict).toBe("rejected");
    expect(r.why).toMatch(/too brief/);
  });

  it("rejects padded filler that clears the length bar", () => {
    // The interesting case: long enough to pass the character count, and still a shrug. Punctuation
    // and case must not let it through, which is what the normalizer is for.
    for (const filler of ["N/A . . . . . . . . . .", "Nothing to report!!!!!!!!!", "  Not applicable.........  "]) {
      expect(filler.trim().length).toBeGreaterThanOrEqual(MIN_REASON_TEXT_CHARS);
      const r = assessNoRetroReason("other", filler);
      expect(r.verdict).toBe("rejected");
      expect(r.why).toMatch(/says nothing/);
    }
  });
});

describe("PII and secrets are refused, with the RIGHT remedy", () => {
  // Each of these is a shape, never a real value. The runtime strings are assembled so no
  // contiguous secret-shaped literal sits in this source file (mirrors the leak-check convention
  // already used in services/sparkleScrub.test.ts).
  const cases: [string, string, RegExp][] = [
    ["an email", `Absorbed into the work ${"someone"}@${"example"}.com was already doing.`, /email address/],
    ["a home path", `No changes; my worktree was at /Users/${"somebody"}/projects/thing all along.`, /home directory path/],
    ["a key", `Superseded; the old token ${"sk"}-${"abcdef1234567890XYZ"} is gone now.`, /key-shaped token/],
    // AWS access key IDs have NO separator after the prefix, which is why they need their own
    // alternative (roborev 58742). Against the single fused pattern this case was unmatchable —
    // the shape was listed as refused and let through every real key.
    [
      "an AWS access key id",
      `Absorbed; the runner's ${"AKIA"}${"JQ7RTNVX2PLMD3WB"} was rotated out before this.`,
      /key-shaped token/,
    ],
    // The same shape shouted. Prefixes are matched case-insensitively for exactly this reason.
    [
      "an UPPERCASED vendor prefix",
      `Superseded; the old ${"SK"}_${"ABCDEF1234567890XYZ"} is gone now.`,
      /key-shaped token/,
    ],
  ];

  it.each(cases)("rejects %s and says to anonymize it", (_label, text, expected) => {
    const r = assessNoRetroReason("other", text);
    expect(r.verdict).toBe("rejected");
    expect(r.why).toMatch(expected);
    expect(r.why).toMatch(/anonymized/);
  });

  it("reports a SHORT leak as a leak, not as 'too brief'", () => {
    // Order matters and this is the assertion that pins it. The two rejections have different
    // remedies, and telling an agent carrying a leaked email to "write more" would have it write
    // more around the email — a remedy string is an instruction the reader follows.
    const short = `${"a"}@${"b"}.co`;
    expect(short.length).toBeLessThan(MIN_REASON_TEXT_CHARS);
    const r = assessNoRetroReason("other", short);
    expect(r.verdict).toBe("rejected");
    expect(r.why).toMatch(/email address/);
    expect(r.why).not.toMatch(/too brief/);
  });
});

describe("the text requirement applies to EVERY code", () => {
  it("does not let a self-explanatory code skip its explanation", () => {
    // `no-changes` reads like it explains itself, which is exactly why it would be the one to get a
    // pass. A code alone is a checkbox, and a checkbox is what gets ticked on the way past.
    for (const code of NO_RETRO_REASONS) {
      expect(assessNoRetroReason(code, "").verdict).toBe("rejected");
    }
  });
});
