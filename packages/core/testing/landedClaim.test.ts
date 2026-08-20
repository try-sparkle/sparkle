// The guard's OWN tests. Every past failure of this rule was a guard that could not fail, so the
// rule itself is pinned here against the exact strings that defeated each earlier cut — otherwise
// "we verified it by injecting a claim" is a fact about one afternoon rather than about the code.
import { describe, it, expect } from "vitest";
import { auditLandedClaims } from "./landedClaim";

describe("auditLandedClaims — an unconditional claim that the work is on origin/main", () => {
  const audit = (s: string) => auditLandedClaims(s);

  it("passes the sentences that describe the CHECK or report an ABSENCE — they are not claims", () => {
    // These two open the real refusal, and a bare `on origin\/main` predicate would flag both. The
    // first describes what the goal is verified BY; the second reports that nothing was seen. If
    // either counted as a claim the rule would be unusable and would get weakened back out.
    const { candidates } = audit(
      "This goal is verified by the work being on origin/main. Nothing has been observed reaching " +
        "origin/main for this branch, and it is holding no unlanded commits either.",
    );
    expect(candidates).toEqual([]);
  });

  it("catches a claim with NO condition at all", () => {
    const { violations } = audit("Your work merged and this worktree was then parked.");
    expect(violations).toEqual([
      { sentence: "Your work merged and this worktree was then parked.", reason: "no-condition" },
    ]);
  });

  it("catches the two forms an adverb-shaped predicate missed", () => {
    // roborev 65753: `already on origin/main` needed the adverb and `landed on` needed the
    // preposition, so both of these were never examined at all.
    expect(audit("Your work is on origin/main and this worktree was parked.").violations).toHaveLength(1);
    expect(audit("Your work landed and this worktree was then parked.").violations).toHaveLength(1);
  });

  it("catches a condition that arrives AFTER the claim", () => {
    // roborev 65749. Co-occurrence is not government: this sentence contains `if` and still asserts
    // the merge outright.
    const { violations } = audit("Your work already merged, so if you open another PR you will duplicate it.");
    expect(violations).toEqual([
      {
        sentence: "Your work already merged, so if you open another PR you will duplicate it.",
        reason: "condition-follows-claim",
      },
    ]);
  });

  it("accepts a claim the condition LEADS", () => {
    const { candidates, violations } = audit(
      "If you believe it is ALREADY on origin/main, run `git merge-base --is-ancestor <sha> " +
        "origin/main`; if it IS an ancestor, say so rather than opening a second PR for work already merged.",
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it("catches an unconditional claim APPENDED after a conditional opening", () => {
    // roborev 65758, and one edit from the shipped string: swap the `;` for an em-dash and keep
    // writing. Judging a sentence by its first `if` against its first claim accepts this.
    const { violations } = audit(
      "If you have not committed the work yet, commit it and land it, then mark this met again — " +
        "your work already merged and this worktree was parked.",
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toBe("no-condition");
  });

  it("still accepts a governed claim inside a PAIRED em-dash parenthetical — the real copy does this", () => {
    // The other half of the same tightening. A dash PAIR is a parenthetical, and the sentence's
    // leading condition still governs what is inside it; treating every dash as a clause break would
    // red the shipped refusal and put pressure on weakening the rule back out.
    const { candidates, violations } = audit(
      "If you believe it is ALREADY on origin/main — it merged and this worktree was then parked or " +
        "moved onto another branch — run `git merge-base --is-ancestor <sha> origin/main`.",
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it("accepts governors other than `if`, and does not read a DENIAL as a claim", () => {
    // roborev 65758. The sibling arm legitimately says "…or once you have merged your PR…", which
    // claims nothing; `if` as the only governor would report correct copy as an unconditional claim,
    // and a guard that fires on correct text is one that gets weakened back out.
    expect(audit("Once a branch poll lands (or once you have merged your PR), mark it met again.").violations).toEqual(
      [],
    );
    expect(audit("git says it has not merged yet.").candidates).toEqual([]);
  });

  it("a denial upstream does not exempt a claim further along the sentence", () => {
    // roborev 65761. The exemption is for "it has NOT merged" — the words next to the denial — not
    // for any sentence that happens to contain a `not`. Tested against the whole prefix it is an
    // exemption anything can buy, and it hides the claim from `candidates` as well as from
    // `violations`, which removes the evidence that anything was examined at all.
    //
    // KNOWN REMAINING GAP, stated rather than papered over: government is still clause-scoped, so a
    // claim comma-joined onto a genuinely conditional opening ("If you have not committed it yet,
    // then your work already merged") is read as governed. Splitting clauses on commas would red the
    // real copy's parenthetical, so the line is drawn here.
    const { candidates, violations } = audit(
      "Nothing has been observed reaching origin/main, your work already merged and this worktree was parked.",
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(violations).toEqual([
      {
        sentence: "Nothing has been observed reaching origin/main, your work already merged and this worktree was parked.",
        reason: "no-condition",
      },
    ]);
  });

  it("does not read `unlanded` as `landed`", () => {
    // The word-boundary detail the real copy depends on: "it is holding no unlanded commits either"
    // must not become a candidate, or the refusal could never say it.
    expect(audit("It is holding no unlanded commits either.").candidates).toEqual([]);
  });
});
