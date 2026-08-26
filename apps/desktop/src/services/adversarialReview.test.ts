// The JS half of the fail-closed rule, and the wire shape that makes it reachable.
//
// TWO PROPERTIES ARE PINNED HERE AND NOTHING ELSE MATTERS AS MUCH:
//
//   1. NOTHING UNREADABLE BECOMES `ship`. Every degenerate payload — absent, null, wrong type,
//      unrecognised word — resolves to `unknown`, which the shipped `block_on` treats as blocking.
//      A permissive read here would undo the guarantee the Rust parser spends a whole module
//      establishing, because a record can also reach this layer from a file written by a different
//      app version or edited by hand.
//
//   2. `null` IS THE SHAPE THE WIRE ACTUALLY PRODUCES. A Rust `Option<T>` is serialised as the KEY
//      with a `null` value, never as an absent key. So every fixture below carries a literal
//      `null`, and the normalisers are asserted against it — a suite whose fixtures only ever omit
//      the key would be testing a case that never occurs while the real payload silently fails.
import { describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import {
  gateSentence,
  groupBySeverity,
  normalizeFinding,
  normalizeGate,
  normalizeStatus,
  normalizeVerdict,
  normalizeVerdictKind,
  readAdversarialStatus,
  runAdversarialReview,
  type AdversarialReviewStatus,
} from "./adversarialReview";

/** A wire-shaped record, exactly as serde renders it: `note` present and `null`, `line` present
 *  and `null`. */
function wireRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: "ship-with-notes",
    summary: "two notes",
    findings: [
      {
        file: "apps/desktop/src/a.ts",
        line: null,
        severity: "low",
        category: "missing-tests",
        summary: "no test for the empty case",
        rationale: "the branch is only exercised with a populated list",
      },
    ],
    model: "claude-opus-5",
    diffBytes: 4211,
    truncated: false,
    reviewedSha: "abcdef1234",
    branch: "feat/x",
    reviewedAtMs: 1700000000000,
    note: null,
    ...over,
  };
}

describe("nothing unreadable becomes ship", () => {
  it.each([
    ["absent", undefined],
    ["null", null],
    ["a number", 3],
    ["an empty string", ""],
    ["an unrecognised word", "approved"],
    ["a near-miss", "shipped"],
    ["a sentence containing the word ship", "shipping is blocked"],
  ])("a verdict that is %s reads as unknown", (_label, raw) => {
    expect(normalizeVerdictKind(raw)).toBe("unknown");
    expect(normalizeVerdictKind(raw)).not.toBe("ship");
  });

  it("keeps the four real verdicts, spelled loosely", () => {
    expect(normalizeVerdictKind("ship")).toBe("ship");
    expect(normalizeVerdictKind(" SHIP ")).toBe("ship");
    expect(normalizeVerdictKind("ship_with_notes")).toBe("ship-with-notes");
    expect(normalizeVerdictKind("Ship With Notes")).toBe("ship-with-notes");
    expect(normalizeVerdictKind("block")).toBe("block");
    expect(normalizeVerdictKind("unknown")).toBe("unknown");
  });

  it("a record whose verdict is garbage still parses, as unknown", () => {
    // THE ALL-OR-NOTHING FAILURE MODE, from the other side: rejecting the whole record would show
    // the panel an empty state, which reads as "nothing has been reviewed" — the opposite of the
    // truth, which is "a review ran and its answer could not be read".
    const rec = normalizeVerdict(wireRecord({ verdict: "looks fine to me" }));
    expect(rec).not.toBeNull();
    expect(rec?.verdict).toBe("unknown");
    expect(rec?.findings).toHaveLength(1);
    expect(rec?.reviewedSha).toBe("abcdef1234");
  });

  it("an unrecognised gate withholds approval without claiming a block", () => {
    expect(normalizeGate("clear")).toBe("clear");
    expect(normalizeGate("blocking")).toBe("blocking");
    expect(normalizeGate("something-new")).toBe("not-reviewed");
    expect(normalizeGate(undefined)).toBe("not-reviewed");
  });
});

describe("null is the shape the wire produces", () => {
  it("a null line survives as null, not as a dropped field or a zero", () => {
    const f = normalizeFinding({
      file: "a.ts",
      line: null,
      severity: "high",
      category: "correctness",
      summary: "s",
      rationale: "r",
    });
    expect(f.line).toBeNull();
    expect(f.line).not.toBe(0);
    expect(f.severity).toBe("high");
  });

  it("a null note survives as null", () => {
    expect(normalizeVerdict(wireRecord())?.note).toBeNull();
    expect(normalizeVerdict(wireRecord({ note: "escalated to block" }))?.note).toBe(
      "escalated to block",
    );
  });

  it("a null record on a status is null, not an empty object", () => {
    const st = normalizeStatus(
      { enabled: true, branch: "feat/x", headSha: "aa", record: null, stale: false, gate: "not-reviewed", blockOn: ["block", "unknown"] },
      "feat/x",
    );
    expect(st.record).toBeNull();
    expect(st.gate).toBe("not-reviewed");
    expect(st.blockOn).toEqual(["block", "unknown"]);
  });
});

describe("findings are degraded, never dropped", () => {
  it("keeps a row whose every scalar is missing or the wrong type", () => {
    const rec = normalizeVerdict(
      wireRecord({
        findings: [
          { rationale: "something is wrong" },
          { file: "b.ts", line: "412", severity: "nit", summary: "s", rationale: "r" },
          { file: "c.ts", line: 0, severity: "medium", category: "", summary: "s", rationale: "r" },
          "not even an object",
        ],
      }),
    );
    expect(rec?.findings).toHaveLength(4);
    expect(rec?.findings[0]?.file).toBe("");
    expect(rec?.findings[0]?.line).toBeNull();
    expect(rec?.findings[0]?.severity).toBe("unknown");
    expect(rec?.findings[0]?.category).toBe("unspecified");
    // A numeric string is a line number written the other common way.
    expect(rec?.findings[1]?.line).toBe(412);
    // `nit` is an ALIAS, and it must resolve the same way `Severity::parse` resolves it in Rust —
    // the two tables had already drifted, which drew a `critical` finding as muted "unspecified".
    expect(rec?.findings[1]?.severity).toBe("low");
    // There is no line 0, so a bogus one is "no line" rather than a wrong location.
    expect(rec?.findings[2]?.line).toBeNull();
    expect(rec?.findings[3]?.summary).toBe("");
  });

  it("severity aliases resolve the way the Rust side resolves them", () => {
    // Mirrors `Severity::parse` in adversarial_review.rs. A `critical` read as "unknown" renders in
    // MUTED ink under "Unspecified severity" — a high finding drawn as the mildest thing on screen.
    expect(normalizeFinding({ severity: "critical" }).severity).toBe("high");
    expect(normalizeFinding({ severity: "blocker" }).severity).toBe("high");
    expect(normalizeFinding({ severity: "moderate" }).severity).toBe("medium");
    expect(normalizeFinding({ severity: "warning" }).severity).toBe("medium");
    expect(normalizeFinding({ severity: "minor" }).severity).toBe("low");
    expect(normalizeFinding({ severity: "info" }).severity).toBe("low");
    // And a word neither side knows is still `unknown` — the leniency stops at guessing.
    expect(normalizeFinding({ severity: "spicy" }).severity).toBe("unknown");
  });

  it("a non-array findings field yields [] rather than throwing", () => {
    const rec = normalizeVerdict(wireRecord({ findings: "none" }));
    expect(rec?.findings).toEqual([]);
    expect(rec?.verdict).toBe("ship-with-notes");
  });
});

describe("grouping", () => {
  it("orders groups worst-first and omits empty ones", () => {
    const groups = groupBySeverity([
      normalizeFinding({ file: "a", severity: "low", summary: "l" }),
      normalizeFinding({ file: "b", severity: "high", summary: "h" }),
      normalizeFinding({ file: "c", severity: "low", summary: "l2" }),
    ]);
    expect(groups.map((g) => g.severity)).toEqual(["high", "low"]);
    expect(groups[0]?.findings).toHaveLength(1);
    expect(groups[1]?.findings).toHaveLength(2);
  });
});

describe("gate sentences", () => {
  function status(over: Partial<AdversarialReviewStatus>): AdversarialReviewStatus {
    return {
      enabled: true,
      branch: "feat/x",
      headSha: "aa",
      record: null,
      stale: false,
      gate: "clear",
      blockOn: [],
      ...over,
    };
  }

  it("says something different for every gate, and names staleness as re-runnable", () => {
    const seen = new Set<string>();
    for (const gate of ["off", "not-reviewed", "stale", "blocking", "clear"] as const) {
      const s = gateSentence(status({ gate }));
      expect(s.length).toBeGreaterThan(0);
      seen.add(s);
    }
    expect(seen.size).toBe(5);
    expect(gateSentence(status({ gate: "stale" }))).toContain("re-run");
  });
});

describe("the command wrappers", () => {
  it("passes root and branch and normalises the reply", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce({
      enabled: true,
      branch: "feat/x",
      headSha: "head1",
      record: wireRecord({ reviewedSha: "old1" }),
      stale: true,
      gate: "stale",
      blockOn: ["block", "unknown"],
    });
    const st = await readAdversarialStatus("/repo", "feat/x");
    expect(invokeMock).toHaveBeenCalledWith("adversarial_review_status", {
      root: "/repo",
      branch: "feat/x",
    });
    expect(st.stale).toBe(true);
    expect(st.record?.reviewedSha).toBe("old1");
  });

  it("labels the status with the branch asked about when the reply lost the field", async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce({ enabled: true, gate: "clear" });
    const st = await readAdversarialStatus("/repo", "feat/x");
    expect(st.branch).toBe("feat/x");
  });

  it("a run that answers with nothing REJECTS rather than returning an approval", async () => {
    // The one place a null must not be tolerated: a run is supposed to produce a record, and a
    // caller that treated "no record" as a completed review would mark a branch reviewed when
    // nothing was.
    invokeMock.mockReset();
    invokeMock.mockResolvedValueOnce(null);
    await expect(runAdversarialReview("/repo", "feat/x")).rejects.toThrow(/no record/);
  });
});
