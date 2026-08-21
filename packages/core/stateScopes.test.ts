// The scope list's own suite. It had none: the helper's behaviour was asserted only indirectly from
// two consumer suites, so the anchoring and capture-class rules below — each of which shipped WRONG
// once (roborev 66300, 66302, 66304) — were pinned by nothing that names them.
import { describe, it, expect } from "vitest";
import {
  STATE_SCOPES,
  OMITTED_CONTRACT,
  isStateScope,
  stateScopesNamedIn,
  uncallableStateScopesIn,
  unqualifiedOmittedClaimsIn,
} from "./stateScopes";

describe("STATE_SCOPES", () => {
  it("contains the scope every surface currently advertises", () => {
    // "fleet" is the one that drifted: the desktop implemented it while mcp-control's z.enum still
    // listed four values, so a remedy naming it was an instruction that failed zod validation.
    expect([...STATE_SCOPES]).toContain("fleet");
    expect([...STATE_SCOPES]).toContain("project");
  });

  it("isStateScope accepts every member and rejects a near-miss", () => {
    for (const s of STATE_SCOPES) expect(isStateScope(s)).toBe(true);
    // Both directions: a list-membership test that accepted everything would satisfy the loop alone.
    expect(isStateScope("sideways")).toBe(false);
    expect(isStateScope("Project")).toBe(false);
  });
});

describe("uncallableStateScopesIn", () => {
  it("catches a scope the schema would reject", () => {
    expect(uncallableStateScopesIn("Read get_state({ scope: 'sideways' }) first")).toEqual([
      "sideways",
    ]);
  });

  it("passes a callable one", () => {
    expect(uncallableStateScopesIn("Read get_state({ scope: 'fleet' })")).toEqual([]);
  });

  it("does NOT judge another tool's scope parameter against get_state's list", () => {
    // THE ANCHOR (roborev 66300). `search_history` has its own `scope`, whose legal values are
    // HISTORY_SCOPES. `sparkle_workspace`'s description carries `scope: "all"` for it, and an
    // unanchored scan passed only because WIDE_HISTORY_SCOPE happens to equal "all" today — so
    // renaming that constant would have reddened this guard for an unrelated change.
    expect(uncallableStateScopesIn('Pass scope: "conversations" to search past chats')).toEqual([]);
    expect(uncallableStateScopesIn('Pass scope: "default" to search past chats')).toEqual([]);
  });

  it.each([["all_projects"], ["project-fleet"], ["activeOnly"]])(
    "catches %s — a new scope name is exactly where an underscore or capital enters",
    (name) => {
      // THE CAPTURE CLASS (roborev 66302/66304). With `([a-z]+)` these did not match the regex AT
      // ALL, so the filter returned `[]` and every guard reported an uncallable scope as callable.
      expect(uncallableStateScopesIn(`get_state({ scope: '${name}' })`)).toEqual([name]);
    },
  );

  it("reads double-quoted literals too", () => {
    expect(uncallableStateScopesIn('get_state({ scope: "sideways" })')).toEqual(["sideways"]);
  });
});

describe("stateScopesNamedIn", () => {
  it("reports callable scopes too, so a guard can prove it read something", () => {
    // `uncallableStateScopesIn` returning [] is AMBIGUOUS: "all callable" or "matched nothing".
    // The second is what happens when copy is reworded past the anchor, and a fail-closed assertion
    // written against a looser pattern than the scanner uses cannot tell them apart (roborev 66304).
    expect(stateScopesNamedIn("get_state({ scope: 'fleet' })")).toEqual(["fleet"]);
    expect(stateScopesNamedIn("get_state({ scope: 'a' }) and get_state({ scope: 'b' })")).toEqual([
      "a",
      "b",
    ]);
  });

  it("returns nothing when the anchor does not match — the case the companion exists to expose", () => {
    // Reworded past the anchor. The scanner is now blind to it, and this is the shape that must be
    // detectable rather than silently reported as "no uncallable scopes".
    const reworded = "call get_state, passing scope: 'sideways'";
    expect(stateScopesNamedIn(reworded)).toEqual([]);
    expect(uncallableStateScopesIn(reworded)).toEqual([]);
  });
});

describe("unqualifiedOmittedClaimsIn", () => {
  // THE COLLECTOR HAD NO DIRECT TEST (roborev 66417), which is why two defects inside it were
  // invisible: a dead exemption branch and a whitespace-sensitive strip. Every assertion on it lived
  // in `server.test.ts` as `toEqual([])` against four surfaces that already pass — and a
  // negative-only assertion over already-correct inputs CANNOT distinguish a working collector from
  // one that returns `[]` unconditionally. The positive cases below are what give the negatives
  // meaning.

  it("flags an unqualified claim", () => {
    expect(
      unqualifiedOmittedClaimsIn("`omitted` is always the exact count."),
    ).toHaveLength(1);
  });

  it("flags a paraphrase that reuses none of the obvious words", () => {
    // The measured escape from roborev 66392: no "exact" anywhere in it.
    expect(
      unqualifiedOmittedClaimsIn("omitted is never truncated by that cap."),
    ).toHaveLength(1);
  });

  it("flags a claim WRAPPED across comment lines, judged as written not as wrapped", () => {
    // roborev 66407's example. Line-split, the subject and the claim word land in different clauses
    // and neither half trips the filter alone.
    const wrapped = ["  // The cap never changes `omitted`: it stays the", "  // exact count either way."].join("\n");
    expect(unqualifiedOmittedClaimsIn(wrapped)).toHaveLength(1);
  });

  it("flags a claim EVEN WHEN it cites the constant — a pointer buys no immunity", () => {
    // The shape that mattered: the pre-existing comment both named `OMITTED_CONTRACT` and asserted
    // the absolute. An exemption keyed on "mentions the constant" would have exempted exactly the
    // clause carrying the defect.
    expect(
      unqualifiedOmittedClaimsIn("Per OMITTED_CONTRACT the cap never changes `omitted`: it stays the exact count."),
    ).toHaveLength(1);
  });

  it("passes a claim that names all five scopes IN ONE CLAUSE", () => {
    expect(
      unqualifiedOmittedClaimsIn(
        "omitted is exact for 'self'/'active'/'all' while 'project' and 'fleet' send 0.",
      ),
    ).toEqual([]);
  });

  it("FLAGS a qualified claim split across clauses by a semicolon — a real limitation, pinned", () => {
    // Not a bug being hidden: the qualifier has to travel WITH the claim, because the whole failure
    // mode this guard exists for is a qualification living somewhere other than the sentence making
    // the assertion. A `;` starts a new clause, so the second half's scope names cannot vouch for
    // the first half's claim — which is precisely the "positives satisfied by another part of the
    // blob" defect that produced three separate findings on this branch.
    //
    // The remedy is the one the design wants anyway: cite OMITTED_CONTRACT (stripped, so it may span
    // clauses) or keep the claim and its qualifier in one clause.
    expect(
      unqualifiedOmittedClaimsIn(
        "omitted is exact for 'self'/'active'/'all'; 'project' and 'fleet' send 0.",
      ),
    ).toHaveLength(1);
  });

  it("passes a clause that only POINTS at the constant", () => {
    expect(
      unqualifiedOmittedClaimsIn("What `omitted` means per scope is stated once in OMITTED_CONTRACT."),
    ).toEqual([]);
  });

  it("passes the canonical statement itself, verbatim", () => {
    expect(unqualifiedOmittedClaimsIn(`Note: ${OMITTED_CONTRACT}.`)).toEqual([]);
  });

  it("passes the canonical statement WRAPPED across JSDoc lines", () => {
    // roborev 66417. JSDoc continuations in this repo are `*` + TWO spaces, so rejoining a wrapped
    // block used to leave a double space at each wrap point — the exact-string strip then missed the
    // contract, its internal `;` fragmented it, and the guard reported the ONE statement it exists to
    // permit as an unqualified claim. Whitespace is collapsed on both sides now.
    const words = OMITTED_CONTRACT.split(" ");
    const half = Math.floor(words.length / 2);
    const jsdoc = [
      "/** Note:  " + words.slice(0, half).join(" "),
      " *  " + words.slice(half).join(" ") + ". */",
    ].join("\n");
    expect(unqualifiedOmittedClaimsIn(jsdoc)).toEqual([]);
  });

  it("does not match `omittedIds` — that is the word boundary, NOT the claim filter", () => {
    // RETITLED TO WHAT IT ACTUALLY PINS (roborev 66433). This case previously claimed to guard the
    // `exact\w*` stem's false-positive tradeoff, and it could not: the input names only
    // `omittedIds`, and `\bomitted\b` fails between `d` and `I`, so the clause is discarded BEFORE
    // the enumeration is ever consulted. Replace the whole claim pattern with `/./` and it stays
    // green — a precondition short-circuiting the mechanism, which is this repo's #1 finding, in the
    // commit written to give this collector real coverage.
    expect(
      unqualifiedOmittedClaimsIn("omittedIds is capped at 20 and reports the exact set."),
    ).toEqual([]);
  });

  it("DOES flag sizing prose that happens to carry a stem word — the enumeration's real cost", () => {
    // THE ACTUAL TRADEOFF, pinned honestly. Widening to `exact\w*` means ordinary prose about SIZING
    // that mentions `omitted` and the word "exactly" is reported, though it asserts nothing about the
    // count's completeness. This is not hypothetical: it flagged a real `controlListener` comment,
    // which was reworded ("exactly one agent" -> "a single agent") — and until now nothing pinned
    // that rewording, so the suite silently depended on prose nobody was guarding.
    //
    // Asserting the FLAG rather than a pass is the honest choice: this is what the heuristic does,
    // and a future maintainer who widens the enumeration should see the cost move, not discover it.
    expect(
      unqualifiedOmittedClaimsIn(
        "Under 'self' the caller asked for exactly one agent, so `omitted` covers every other row.",
      ),
    ).toHaveLength(1);
  });
});
