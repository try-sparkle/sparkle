// The visual contract for a finished row, pinned. See `retiredRowTreatment.ts`'s header for why the
// axis is fill rather than hue.
//
// EVERY ASSERTION HERE NAMES BOTH LIVENESSES AT ONCE. That is the shape AGENTS.md asks for when a
// rule picks one of N treatments: "the assertion that has power is the one that needs every
// candidate mounted at once". A test that only checked `dotVariantFor("retired") === "ring"` passes
// just as happily when the function ignores its argument and returns `"ring"` unconditionally —
// which would paint every LIVE row hollow and is precisely the regression worth catching. Asserting
// the two are DIFFERENT is what the single-sided version cannot do.
import { describe, expect, it } from "vitest";
import {
  countsTowardRollup,
  dotVariantFor,
  LIVE_DOT_VARIANT,
  RETIRED_DOT_VARIANT,
  titleInkFor,
} from "./retiredRowTreatment";

describe("the retired-row treatment", () => {
  it("draws a finished row HOLLOW and a live row FILLED — and they differ", () => {
    expect(dotVariantFor("retired")).toBe("ring");
    expect(dotVariantFor("live")).toBe("fill");
    // The load-bearing one: a treatment that collapsed the two would make the whole change inert
    // while both single-sided assertions above still passed for one of them.
    expect(dotVariantFor("retired")).not.toBe(dotVariantFor("live"));
  });

  it("keeps the exported constants and the function in step", () => {
    // Two ways to reach the same fact — the constants exist so callers can name them, and a caller
    // naming `RETIRED_DOT_VARIANT` while `dotVariantFor` returned something else would be a silent
    // split in the contract this module exists to keep single.
    expect(dotVariantFor("retired")).toBe(RETIRED_DOT_VARIANT);
    expect(dotVariantFor("live")).toBe(LIVE_DOT_VARIANT);
    expect(RETIRED_DOT_VARIANT).not.toBe(LIVE_DOT_VARIANT);
  });

  it("greys a finished row's title and leaves a live one alone", () => {
    const live = "var(--c-cream)";
    const muted = "var(--c-muted)";
    expect(titleInkFor("retired", live, muted)).toBe(muted);
    expect(titleInkFor("live", live, muted)).toBe(live);
    expect(titleInkFor("retired", live, muted)).not.toBe(titleInkFor("live", live, muted));
  });

  it("passes the caller's inks through rather than hardcoding a hex", () => {
    // The module must stay free of the theme layer: whatever the caller supplies is what comes back,
    // so the light/dark twin remains the theme's job. A hardcoded `#8aa0c4` would pass the test
    // above (which uses the real token strings) and fail this one.
    expect(titleInkFor("retired", "A", "B")).toBe("B");
    expect(titleInkFor("live", "A", "B")).toBe("A");
  });

  it("keeps a finished row OUT of any parent rollup", () => {
    // The rule that stops a retired `failed` row painting its parent red forever — the "red that can
    // never be cleared" failure `ConciergeAgentsRow` already guards against on its own header.
    expect(countsTowardRollup("retired")).toBe(false);
    expect(countsTowardRollup("live")).toBe(true);
    expect(countsTowardRollup("retired")).not.toBe(countsTowardRollup("live"));
  });
});
