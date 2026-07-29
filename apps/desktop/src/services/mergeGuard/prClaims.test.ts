import { describe, it, expect, vi, beforeEach } from "vitest";

// A PLAIN-FUNCTION `invoke` double rather than the usual `vi.fn()`.
//
// Not a style choice. Under this suite's config a `vi.fn()` whose result is a REJECTED promise has
// that rejection reported as a test error even when the code under test catches it and the
// assertion passes — vitest records the mock's result and surfaces it independently of the await.
// Three of the tests below exist precisely to prove the catch works ("could not look" is not "no
// claims"), so the double has to be able to fail without the harness calling that a failure.
// Recording the calls by hand costs a few lines and keeps those assertions honest.
const calls: Array<[string, unknown]> = [];
let handler: (cmd: string, args: unknown) => unknown = () => undefined;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => {
    calls.push([cmd, args]);
    return handler(cmd, args);
  },
}));

/** Reset the double between tests: no recorded calls, and an implementation that answers nothing. */
function resetInvoke(): void {
  calls.length = 0;
  handler = () => undefined;
}
/** The double resolves with `value` for every command. */
function resolvesWith(value: unknown): void {
  handler = () => Promise.resolve(value);
}
/** The double rejects with `err` for every command — the "the backend said no" path. */
function rejectsWith(err: unknown): void {
  handler = () => Promise.reject(err);
}
/** The (command, args) pair of the nth recorded call. */
function callAt(i: number): [string, unknown] | undefined {
  return calls[i];
}

import {
  fetchPrClaims,
  setPrClaim,
  releasePrClaim,
  findClaim,
  claimStanding,
  viewClaim,
} from "./prClaims";
import { PR_CLAIM_GRACE_SECONDS } from "./types";
import type { PrClaim } from "./types";

const NOW = 1_700_000_000_000;

function mkClaim(over: Partial<PrClaim> = {}): PrClaim {
  return {
    root: "/repo",
    number: 806,
    agentId: "agent-1",
    note: "waiting on roborev round 12",
    claimedAtMs: NOW - 60_000,
    expiresAtMs: NOW + 60_000,
    ...over,
  };
}

describe("fetchPrClaims", () => {
  beforeEach(resetInvoke);

  it("returns the registry rows for the repo", async () => {
    const rows = [mkClaim()];
    resolvesWith(rows);
    await expect(fetchPrClaims("/repo")).resolves.toEqual(rows);
    expect(callAt(0)).toEqual(["pr_claims_list", { root: "/repo" }]);
  });

  it("returns null (not []) when the probe throws — 'could not look' is not 'no claims'", async () => {
    // `new Error(...)` and not a bare string, here and in the two propagation tests below. Tauri
    // itself rejects with a plain string, but a string rejection from a mock that has been
    // `mockReset()` is reported by Vitest 2.1 as an unhandled error and fails the test even though
    // the code under test catches it. The house tests (services/accountSelection.test.ts) use an
    // Error for the same reason; what is under test is that the rejection is CAUGHT, and that is
    // unaffected by which shape it carries.
    rejectsWith(new Error("registry unavailable"));
    await expect(fetchPrClaims("/repo")).resolves.toBeNull();
  });

  it("returns null when the reply is not an array, rather than passing a shape we cannot read", async () => {
    resolvesWith({ oops: true });
    await expect(fetchPrClaims("/repo")).resolves.toBeNull();
  });

  it("distinguishes an ANSWERED empty registry from an unreadable one", async () => {
    resolvesWith([]);
    await expect(fetchPrClaims("/repo")).resolves.toEqual([]);
  });
});

describe("setPrClaim", () => {
  beforeEach(resetInvoke);

  it("stamps the claim through Rust and returns the stored record", async () => {
    const claim = mkClaim();
    resolvesWith(claim);
    await expect(setPrClaim("/repo", 806, "agent-1", "holding for roborev", 900)).resolves.toEqual(
      claim,
    );
    expect(callAt(0)).toEqual([
      "pr_claim_set",
      { root: "/repo", number: 806, agentId: "agent-1", note: "holding for roborev", ttlSeconds: 900 },
    ]);
  });

  it("omits ttlSeconds entirely when unspecified, so the registry applies its own default", async () => {
    resolvesWith(mkClaim());
    await setPrClaim("/repo", 806, "agent-1");
    expect(callAt(0)![1]).toEqual({
      root: "/repo",
      number: 806,
      agentId: "agent-1",
      note: null,
    });
    expect(callAt(0)![1]).not.toHaveProperty("ttlSeconds");
  });

  it("PROPAGATES a refusal — a claim held by someone else must reach the caller", async () => {
    rejectsWith(new Error("PR #806 is claimed by agent-2 until 12:04"));
    await expect(setPrClaim("/repo", 806, "agent-1")).rejects.toThrow(
      "PR #806 is claimed by agent-2 until 12:04",
    );
  });
});

describe("releasePrClaim", () => {
  beforeEach(resetInvoke);

  it("reports whether a claim was actually removed", async () => {
    resolvesWith(true);
    await expect(releasePrClaim("/repo", 806, "agent-1")).resolves.toBe(true);
    expect(callAt(0)).toEqual([
      "pr_claim_release",
      { root: "/repo", number: 806, agentId: "agent-1" },
    ]);
    resolvesWith(false);
    await expect(releasePrClaim("/repo", 806, "agent-1")).resolves.toBe(false);
  });

  it("propagates a refusal to release someone else's claim", async () => {
    rejectsWith(new Error("PR #806 is claimed by agent-2"));
    await expect(releasePrClaim("/repo", 806, "agent-1")).rejects.toThrow(
      "PR #806 is claimed by agent-2",
    );
  });
});

describe("findClaim", () => {
  it("matches on BOTH root and number — a bare number collides across projects", () => {
    const mine = mkClaim({ root: "/repo-a" });
    const theirs = mkClaim({ root: "/repo-b", agentId: "agent-2" });
    expect(findClaim([mine, theirs], "/repo-b", 806)).toBe(theirs);
    expect(findClaim([mine, theirs], "/repo-c", 806)).toBeNull();
    expect(findClaim([mine, theirs], "/repo-a", 807)).toBeNull();
  });

  it("returns null on an empty registry", () => {
    expect(findClaim([], "/repo", 806)).toBeNull();
  });

  it("matches across root SPELLINGS — a trailing slash is the same repo", () => {
    const c = mkClaim({ root: "/repo/" });
    expect(findClaim([c], "/repo", 806)).toBe(c);
    expect(findClaim([c], "/repo/", 806)).toBe(c);
    expect(findClaim([mkClaim({ root: "/repo" })], " /repo/ ", 806)).not.toBeNull();
    // …but a genuinely different repo still does not match.
    expect(findClaim([c], "/repo-other", 806)).toBeNull();
  });
});

describe("a claim shaped exactly as the Rust registry emits it", () => {
  beforeEach(resetInvoke);

  // NOT hand-built. This literal is asserted byte-for-byte by
  // `pr_claims.rs::a_lapsed_claim_serializes_to_the_shape_the_ts_layer_classifies`, so if serde's
  // field naming or the prune window changes, that Rust test fails and this fixture is regenerated.
  //
  // Why it matters: the inert-`lapsed` bug survived a green suite precisely because every test here
  // fed a claim the real registry could not produce (it pruned at the TTL, so a past-expiry row was
  // never emitted at all). A fixture invented on this side proves the classifier, not the contract.
  const RUST_LAPSED_CLAIM_JSON =
    '{"root":"/Users/x/Projects/sparkle","number":806,"agentId":"agent-a","note":"holding for roborev","claimedAtMs":1700000000000,"expiresAtMs":1700000060000}';
  const RUST_ROOT = "/Users/x/Projects/sparkle";
  const PAST_TTL = 1700000060000 + 1; // inside the grace window
  const PAST_CEILING = 1700000060000 + PR_CLAIM_GRACE_SECONDS * 1000 + 1;

  it("survives the wire and classifies as LAPSED — still blocking", async () => {
    resolvesWith(JSON.parse(`[${RUST_LAPSED_CLAIM_JSON}]`));
    const rows = await fetchPrClaims(RUST_ROOT);
    expect(rows).not.toBeNull();
    // The registry really does hand us a row whose expiry is already past — the fact the old
    // prune-at-TTL made impossible, and without which `lapsed` is dead code.
    const found = findClaim(rows!, RUST_ROOT, 806);
    expect(found).not.toBeNull();
    expect(found!.expiresAtMs).toBeLessThan(PAST_TTL);

    const view = viewClaim(found, PAST_TTL, true, "Left Pair");
    expect(view.standing).toBe("lapsed");
    expect(view.blocks).toBe(true);
    expect(view.summary).toContain("STILL blocks");
  });

  it("agrees with Rust on the grace boundary — the two constants cannot drift silently", () => {
    // `PR_CLAIM_GRACE_SECONDS` here and `GRACE_SECONDS` in pr_claims.rs are two copies of one
    // value, joined only by a comment. Rust prunes at TTL + its copy; this layer stops blocking at
    // TTL + its copy. If they diverge there is a window in which the row is already gone while this
    // layer still believes a claim blocks — merge sees an unclaimed PR while the claimant is live.
    // `pr_claims.rs` asserts the same literal, so lowering either one turns a suite red.
    expect(PR_CLAIM_GRACE_SECONDS).toBe(7200);
    const ttlEnd = 1700000060000;
    const claim = mkClaim({ expiresAtMs: ttlEnd });
    expect(claimStanding(claim, ttlEnd + 7200 * 1000 - 1, true)).toBe("lapsed");
    expect(claimStanding(claim, ttlEnd + 7200 * 1000 + 1, true)).toBe("expired");
  });

  it("stops blocking past the grace ceiling, on the same wire shape", async () => {
    resolvesWith(JSON.parse(`[${RUST_LAPSED_CLAIM_JSON}]`));
    const rows = await fetchPrClaims(RUST_ROOT);
    const view = viewClaim(findClaim(rows!, RUST_ROOT, 806), PAST_CEILING, true);
    expect(view.standing).toBe("expired");
    expect(view.blocks).toBe(false);
  });

  it("does not block when the claimant is gone, on the same wire shape", async () => {
    resolvesWith(JSON.parse(`[${RUST_LAPSED_CLAIM_JSON}]`));
    const rows = await fetchPrClaims(RUST_ROOT);
    const view = viewClaim(findClaim(rows!, RUST_ROOT, 806), PAST_TTL, false);
    expect(view.standing).toBe("abandoned");
    expect(view.blocks).toBe(false);
  });
});

describe("claimStanding", () => {
  it("is 'none' with no claim, whatever the clock or liveness says", () => {
    expect(claimStanding(null, NOW, true)).toBe("none");
    expect(claimStanding(null, NOW, false)).toBe("none");
  });

  it("is 'live' for an unexpired claim by a running agent", () => {
    expect(claimStanding(mkClaim(), NOW, true)).toBe("live");
  });

  it("is 'lapsed' — and STILL BLOCKS — past the deadline while the claimant is running", () => {
    // THE hazard this ordering exists for. An agent deep in a long turn (the #806 owner drained
    // eleven roborev rounds inside one) issues no tool calls, so it cannot renew. Dropping its
    // claim at T+TTL hands the PR to the concierge while the claimant is alive and working — the
    // incident, replayed on a timer.
    const lapsed = mkClaim({ expiresAtMs: NOW - 1 });
    expect(claimStanding(lapsed, NOW, true)).toBe("lapsed");
    expect(viewClaim(lapsed, NOW, true).blocks).toBe(true);
  });

  it("lapses exactly AT the deadline, not one tick later", () => {
    expect(claimStanding(mkClaim({ expiresAtMs: NOW }), NOW, true)).toBe("lapsed");
    expect(claimStanding(mkClaim({ expiresAtMs: NOW + 1 }), NOW, true)).toBe("live");
  });

  it("finally EXPIRES past the grace ceiling, so a live agent cannot wedge a PR forever", () => {
    const grace = PR_CLAIM_GRACE_SECONDS * 1000;
    const claim = mkClaim({ expiresAtMs: NOW - grace });
    expect(claimStanding(claim, NOW, true)).toBe("expired");
    expect(viewClaim(claim, NOW, true).blocks).toBe(false);
    // One millisecond inside the ceiling still blocks — the boundary is the anti-wedge exit.
    expect(claimStanding(mkClaim({ expiresAtMs: NOW - grace + 1 }), NOW, true)).toBe("lapsed");
  });

  it("is 'abandoned' for an UNEXPIRED claim whose agent is no longer running", () => {
    expect(claimStanding(mkClaim(), NOW, false)).toBe("abandoned");
  });

  it("prefers 'abandoned' over any clock state — a dead agent's claim never blocks", () => {
    expect(claimStanding(mkClaim({ expiresAtMs: NOW - 1 }), NOW, false)).toBe("abandoned");
    expect(viewClaim(mkClaim({ expiresAtMs: NOW - 1 }), NOW, false).blocks).toBe(false);
  });
});

describe("viewClaim", () => {
  it("BLOCKS while the claimant is around (live or lapsed), and not otherwise", () => {
    expect(viewClaim(mkClaim(), NOW, true).blocks).toBe(true);
    expect(viewClaim(mkClaim({ expiresAtMs: NOW - 1 }), NOW, true).blocks).toBe(true); // lapsed
    expect(viewClaim(mkClaim(), NOW, false).blocks).toBe(false); // abandoned
    expect(
      viewClaim(mkClaim({ expiresAtMs: NOW - PR_CLAIM_GRACE_SECONDS * 1000 }), NOW, true).blocks,
    ).toBe(false); // past the ceiling
    expect(viewClaim(null, NOW, true).blocks).toBe(false);
  });

  it("names the agent and quotes what it said it was waiting on", () => {
    const v = viewClaim(mkClaim(), NOW, true, "Left Pair");
    expect(v.summary).toContain("Left Pair");
    expect(v.summary).toContain('"waiting on roborev round 12"');
    expect(v.summary).toContain("#806");
    expect(v.standing).toBe("live");
  });

  it("falls back to the agent id when no display name is known", () => {
    expect(viewClaim(mkClaim(), NOW, true).summary).toContain("agent-1");
    expect(viewClaim(mkClaim(), NOW, true, "   ").summary).toContain("agent-1");
  });

  it("says the agent gave no reason rather than quoting an empty note", () => {
    const v = viewClaim(mkClaim({ note: null }), NOW, true, "Left Pair");
    expect(v.summary).toContain("did not say what it is waiting on");
    expect(v.summary).not.toContain('""');
  });

  it("tells lapsed, expired and abandoned APART in the summary — the remedies differ", () => {
    const grace = PR_CLAIM_GRACE_SECONDS * 1000;
    const lapsed = viewClaim(mkClaim({ expiresAtMs: NOW - 1 }), NOW, true, "Left Pair").summary;
    const expired = viewClaim(mkClaim({ expiresAtMs: NOW - grace }), NOW, true, "Left Pair").summary;
    const abandoned = viewClaim(mkClaim(), NOW, false, "Left Pair").summary;
    // Lapsed still blocks, so its copy has to say so — otherwise a reader treats it as a green light.
    expect(lapsed).toContain("STILL blocks");
    expect(lapsed).toContain("Ask it directly");
    // "registered", not "running": claimantIsLive is roster presence, so a tab whose process an
    // app restart killed still reads live. Two surfaces describing one predicate must not disagree.
    expect(lapsed).toContain("still registered");
    expect(lapsed).not.toContain("still running");
    expect(lapsed).toContain("grace window"); // and it names what actually clears the block
    expect(expired).toContain("expired");
    expect(expired).toContain("re-claim");
    expect(expired).not.toContain("STILL blocks");
    expect(abandoned).toContain("no longer registered");
    expect(abandoned).not.toContain("expired");
  });

  it("carries the claim record through, and reports none with no claim", () => {
    const claim = mkClaim();
    expect(viewClaim(claim, NOW, true).claim).toBe(claim);
    const empty = viewClaim(null, NOW, true);
    expect(empty).toEqual({
      claim: null,
      standing: "none",
      blocks: false,
      summary: "No agent has claimed this PR.",
    });
  });
});
