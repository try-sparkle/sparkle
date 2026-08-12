import { describe, expect, it } from "vitest";

import { buildSnapshot } from "./conciergeSnapshot";
import { STATUS_BANDS } from "./buildSections";
import type { ConciergeCounts, ConciergeFeed } from "../services/conciergeFeed";

// Derived from the band list rather than spelled out, so a new band cannot silently make this
// fixture an incomplete `Record<StatusBand, number>` — the taxonomy is exactly what has drifted
// before (see workerRollup.ts's drift warnings).
const NO_COUNTS: ConciergeCounts = Object.fromEntries(
  STATUS_BANDS.map((b) => [b.id, 0]),
) as ConciergeCounts;

/** A calm feed — the roster half is not what these tests are about. */
const CALM: ConciergeFeed = {
  projects: [],
  counts: NO_COUNTS,
  scopedCounts: NO_COUNTS,
  pinnedProjectId: null,
};

describe("open asks reach the brain's per-turn context", () => {
  // THE REGRESSION THIS PINS (bead sparkle-yd1ud). Before this, buildSnapshot carried the live
  // roster and the current message and nothing else — so an ask the concierge did not act on in the
  // same turn existed nowhere and evaporated with the context. Two of the four items the founder
  // had to chase on 2026-08-09 died exactly this way. Deleting the openAsks argument must turn this
  // red.
  it("names an ask the founder made in an EARLIER turn", () => {
    const prompt = buildSnapshot(CALM, "what should I look at next?", [
      { beadId: "sparkle-aaa1", sentence: "build ten homepage designs", timesAsked: 1 },
    ]);
    expect(prompt).toContain("sparkle-aaa1");
    expect(prompt).toContain("build ten homepage designs");
  });

  it("says a re-asked item was asked more than once", () => {
    const prompt = buildSnapshot(CALM, "hi", [
      { beadId: "sparkle-aaa1", sentence: "research the Gary Tan ideas", timesAsked: 3 },
    ]);
    expect(prompt).toContain("asked 3×");
  });

  it("does not decorate a first-time ask with a count", () => {
    const prompt = buildSnapshot(CALM, "hi", [
      { beadId: "sparkle-aaa1", sentence: "research the Gary Tan ideas", timesAsked: 1 },
    ]);
    expect(prompt).not.toContain("asked 1×");
  });

  it("renders EVERY open ask — this block is never capped", () => {
    // docs/never-hide-actionable-rows.md: rows carrying work he is owed are never truncated. A cap
    // reintroduced here would rebuild the exact defect the queue exists to close.
    const asks = Array.from({ length: 12 }, (_, i) => ({
      beadId: `sparkle-b${i}`,
      sentence: `build widget number ${i}`,
      timesAsked: 1,
    }));
    const prompt = buildSnapshot(CALM, "hi", asks);
    for (const a of asks) expect(prompt).toContain(a.beadId);
  });

  it("keeps the user's own message LAST, so the turn is still about what he just said", () => {
    const prompt = buildSnapshot(CALM, "what should I look at next?", [
      { beadId: "sparkle-aaa1", sentence: "build ten homepage designs", timesAsked: 1 },
    ]);
    // The `>= 0` guard is load-bearing: indexOf returns -1 when the block is absent, and -1 is
    // trivially less than any real index — so the ordering assertion ALONE stays green when the
    // block is dropped entirely, which is precisely the mutant this file exists to catch.
    const askAt = prompt.indexOf("sparkle-aaa1");
    expect(askAt).toBeGreaterThanOrEqual(0);
    expect(askAt).toBeLessThan(prompt.indexOf("The user says:"));
  });

  it("adds nothing at all when nothing is outstanding", () => {
    const withNone = buildSnapshot(CALM, "hi", []);
    const withoutArg = buildSnapshot(CALM, "hi");
    expect(withNone).toBe(withoutArg);
    expect(withNone).not.toContain("STILL OPEN");
  });
});

// ══ THE MERGE THIS FILE HAD TO SURVIVE (sparkle-yd1ud × sparkle-s7rfc) ═══════════════════════════
// Two branches independently added a THIRD parameter to `buildSnapshot` — `openAsks` here, and
// `continuity` (the visible conversation, engine/conciergeContinuity) there. They are different
// signals: what is still OWED versus what was already SAID. The merge kept both, and these rows
// exist because taking either side verbatim, or composing them in the wrong order, is a defect no
// type check can see: the function still returns a plausible string.
describe("continuity composes with open asks rather than replacing them", () => {
  const ASK = { beadId: "sparkle-aaa1", sentence: "build ten homepage designs", timesAsked: 1 };
  const THREAD = "EARLIER IN THIS CONVERSATION:\nyou: what about the pricing page?";

  it("carries BOTH blocks in one prompt", () => {
    const prompt = buildSnapshot(CALM, "what should I look at next?", [ASK], THREAD);
    expect(prompt).toContain("sparkle-aaa1");
    expect(prompt).toContain("what about the pricing page?");
  });

  it("orders them asks → conversation → his message", () => {
    const prompt = buildSnapshot(CALM, "what should I look at next?", [ASK], THREAD);
    const askAt = prompt.indexOf("sparkle-aaa1");
    const threadAt = prompt.indexOf("what about the pricing page?");
    const saysAt = prompt.indexOf("The user says:");
    // Same `>= 0` reasoning as the ordering row above: indexOf returns -1 for an absent block, and
    // -1 is below every real index, so the ordering assertions alone stay green when a block is
    // dropped entirely — which is the mutant that matters here.
    expect(askAt).toBeGreaterThanOrEqual(0);
    expect(threadAt).toBeGreaterThan(askAt);
    expect(saysAt).toBeGreaterThan(threadAt);
  });

  it("is byte-identical to the no-continuity prompt when the thread is empty", () => {
    // The property `buildContinuityBlock` relies on: a first turn, or a thread that bounded down to
    // nothing, must not perturb the prompt the brain was tuned against.
    expect(buildSnapshot(CALM, "hi", [ASK], "")).toBe(buildSnapshot(CALM, "hi", [ASK]));
  });
});
