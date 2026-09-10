import { describe, it, expect } from "vitest";
import {
  shouldNarrate,
  NARRATION_MIN_INTERVAL_MS,
  NARRATION_MIN_TURN_CHARS,
  SELF_REPORT_PROTECTED_MS,
} from "./activityNarrationPolicy";
import { ACTIVITY_STALE_MS } from "./activityFreshness";

// A turn long enough to clear the length floor, so each test varies exactly one thing.
const TURN = "x".repeat(NARRATION_MIN_TURN_CHARS + 10);
// The line already on the agent is a GENERATED one, so the fresh-self-report protection never
// fires and each case below varies exactly the thing it is about. The protection has its own block.
const base = {
  turnText: TURN,
  lastSpendAt: undefined,
  now: 1_000_000,
  enabled: true,
  existingSource: "narrated" as const,
  existingAt: undefined,
};

describe("shouldNarrate", () => {
  it("narrates an agent it has never narrated before", () => {
    // The first turn must produce a line rather than waiting out an interval the agent was never
    // in — otherwise a newly-spawned agent shows nothing for the first minute of its life.
    expect(shouldNarrate({ ...base, lastSpendAt: undefined })).toEqual({ narrate: true });
  });

  it("refuses when the feature is switched off", () => {
    expect(shouldNarrate({ ...base, enabled: false })).toEqual({
      narrate: false,
      reason: "disabled",
    });
  });

  it("refuses an empty or whitespace-only turn", () => {
    expect(shouldNarrate({ ...base, turnText: "   \n  " })).toEqual({
      narrate: false,
      reason: "empty-turn",
    });
  });

  it("refuses a turn too short to carry anything worth summarizing", () => {
    // "Done." would make the summarizer either echo it or invent — and inventing is worse than
    // leaving the previous line up with its honest age showing.
    expect(shouldNarrate({ ...base, turnText: "Done." })).toEqual({
      narrate: false,
      reason: "turn-too-short",
    });
    // The boundary itself: one char under the floor refuses, exactly the floor narrates.
    const justUnder = "y".repeat(NARRATION_MIN_TURN_CHARS - 1);
    expect(shouldNarrate({ ...base, turnText: justUnder }).narrate).toBe(false);
    const exactly = "y".repeat(NARRATION_MIN_TURN_CHARS);
    expect(shouldNarrate({ ...base, turnText: exactly }).narrate).toBe(true);
  });

  it("throttles a chatty agent to at most one narration per interval", () => {
    // THE SPEND GUARD. A question-and-answer loop can Stop every few seconds; without this, one
    // agent alone bills dozens of Haiku calls a minute, and this app runs 60+ agents at once.
    const now = base.now;
    expect(shouldNarrate({ ...base, now, lastSpendAt: now - 1_000 })).toEqual({
      narrate: false,
      reason: "throttled",
    });
    // One ms under the interval still refuses; the interval exactly elapsed narrates.
    expect(
      shouldNarrate({ ...base, now, lastSpendAt: now - (NARRATION_MIN_INTERVAL_MS - 1) }).narrate,
    ).toBe(false);
    expect(
      shouldNarrate({ ...base, now, lastSpendAt: now - NARRATION_MIN_INTERVAL_MS }).narrate,
    ).toBe(true);
  });

  it("refuses on a future stamp rather than treating skew as a long gap", () => {
    // now - lastNarratedAt is NEGATIVE here. A naive `since >= interval` comparison reads that as
    // "not yet elapsed" by luck; a naive `Math.abs` would read it as a huge gap and SPEND. The
    // conservative direction on a bad clock is to under-spend the user's quota.
    expect(shouldNarrate({ ...base, now: base.now, lastSpendAt: base.now + 5_000 })).toEqual({
      narrate: false,
      reason: "clock-skew",
    });
  });

  it("refreshes the line before it is rendered as a stale past quote", () => {
    // THE PRODUCT CONSTRAINT, pinned as arithmetic: the throttle must be strictly under the
    // staleness threshold, or a narrated line is routinely shown as `said "…" · Nm ago` — which is
    // the exact reading this feature exists to make unnecessary. If someone raises the throttle
    // past ACTIVITY_STALE_MS, this fails and says why.
    expect(NARRATION_MIN_INTERVAL_MS).toBeLessThan(ACTIVITY_STALE_MS);
  });
});

describe("shouldNarrate — a fresh self-report is never overwritten (roborev 82272)", () => {
  const now = 2_000_000;
  const withLine = (source: "self" | "narrated" | undefined, ageMs: number | undefined) => ({
    ...base,
    now,
    existingSource: source,
    existingAt: ageMs === undefined ? undefined : now - ageMs,
    // Never throttled, so only the protection can be what refuses.
    lastSpendAt: now - 10 * NARRATION_MIN_INTERVAL_MS,
  });

  it("refuses while a deliberate self-report is still fresh", () => {
    // THE MEASURED WINDOW: the throttle frees narration at 60s but the notification path still
    // treats a self-report as usable until 120s. Every self-report in that gap used to be both
    // overwritable AND still eligible to supply a free notification body — so overwriting it
    // destroyed the agent's own words and made Sparkle PAY for an ask-summary instead.
    expect(shouldNarrate(withLine("self", 61_000))).toEqual({
      narrate: false,
      reason: "self-report-fresh",
    });
  });

  it("protects a LEGACY line with no recorded source", () => {
    // Every line written before provenance existed was a self-report. Treating an absent source as
    // "generated" would make the whole persisted backlog overwritable.
    expect(shouldNarrate(withLine(undefined, 61_000)).narrate).toBe(false);
  });

  it("narrates once the self-report is past the protected window", () => {
    // The protection must not be a permanent veto — an abandoned self-report is the entire bug this
    // feature exists to fix, so it has to become overwritable eventually.
    expect(shouldNarrate(withLine("self", SELF_REPORT_PROTECTED_MS + 1)).narrate).toBe(true);
    // The boundary itself: exactly at the window is still protected.
    expect(shouldNarrate(withLine("self", SELF_REPORT_PROTECTED_MS)).narrate).toBe(false);
  });

  it("freely replaces its OWN previous narration", () => {
    // A generated line carries no deliberate intent, so refreshing it costs nothing.
    expect(shouldNarrate(withLine("narrated", 61_000)).narrate).toBe(true);
  });

  it("narrates when there is no line at all", () => {
    // A brand-new agent has no stamp. That must read as "nothing to protect", not as protected.
    expect(shouldNarrate(withLine(undefined, undefined)).narrate).toBe(true);
  });

  it("keeps the agent's words on a skewed clock", () => {
    // A future stamp is skew. Destroying a deliberate self-report on the strength of a bad clock is
    // the irreversible direction; refusing merely delays a recap.
    expect(shouldNarrate({ ...withLine("self", 0), existingAt: now + 5_000 }).narrate).toBe(false);
  });
});
