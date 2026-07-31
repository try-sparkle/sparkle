// The activity chip's elapsed label, which is the only computed text on the chip.
//
// Pure and exported precisely so this can be asserted without a DOM: the chip's rendering is covered
// through the column, but the FORMATTING rules — and the deliberate silences — are decisions worth
// pinning on their own.
import { describe, expect, it } from "vitest";

import { elapsedLabel } from "./ActivityChip";

describe("elapsedLabel", () => {
  it("reports whole seconds under a minute", () => {
    expect(elapsedLabel("2026-07-30T14:02:01.000Z", "2026-07-30T14:02:39.000Z")).toBe("38s");
  });

  it("switches to minutes above one, and drops a zero seconds remainder", () => {
    expect(elapsedLabel("2026-07-30T14:00:00.000Z", "2026-07-30T14:03:07.000Z")).toBe("3m 7s");
    expect(elapsedLabel("2026-07-30T14:00:00.000Z", "2026-07-30T14:02:00.000Z")).toBe("2m");
  });

  // SILENCE IS A DECISION, not a gap. "0s" on a chip is chrome that tells the reader nothing, and a
  // run that took under half a second is exactly the case where the number is noise.
  it("says nothing for an instant run", () => {
    expect(elapsedLabel("2026-07-30T14:02:01.000Z", "2026-07-30T14:02:01.200Z")).toBe("");
    expect(elapsedLabel("2026-07-30T14:02:01.000Z", "2026-07-30T14:02:01.000Z")).toBe("");
  });

  // A transcript is read off disk and its stamps are not ours to trust. A malformed or reversed pair
  // must render no label rather than "NaNs" or a negative duration.
  it("says nothing when the stamps are unusable or out of order", () => {
    expect(elapsedLabel("not-a-date", "2026-07-30T14:02:39.000Z")).toBe("");
    expect(elapsedLabel("2026-07-30T14:02:39.000Z", "also-not-a-date")).toBe("");
    expect(elapsedLabel("2026-07-30T14:02:39.000Z", "2026-07-30T14:02:01.000Z")).toBe("");
  });
});
