// @vitest-environment jsdom
//
// The wordmark's TOKEN contract — the one thing about this component that a reviewer cannot see.
// The motion math is covered by starfieldMath.test.ts; this file exists because the black-and-gold
// repaint fixed a real bug here that nothing pinned, and the bug's whole shape is "a plausible but
// wrong token name", which reads as correct in a diff and is silently re-introducible.
//
// THE GLOW'S SURFACE. Prototype `.brand { text-shadow: … var(--bg-sparkle) }`: the glow's only job
// is to punch the mark out of the star field, so it must be the colour of the surface the mark
// actually sits on. That is the CONCIERGE column. It was keyed to `deepForest` — the BUILDER
// column — which is a different surface in BOTH themes, so the glow was tinting the mark rather
// than clearing a hole for it. `deepForest` is a perfectly sensible-looking token to see in a
// dark-shell shadow, which is exactly why nobody caught it.
//
// WHY drop-shadow AND NOT text-shadow. This component no longer paints the literal word "Sparkle".
// It is a CONTAINER: the mark is passed in as children — today the Sparkle.ai logo — so that the
// column carries exactly one brand mark instead of a logo and a wordmark 8px apart. `text-shadow`
// cannot lift an `<img>` off the stars; `drop-shadow` follows the glyph's own alpha and can. The
// assertion therefore reads `filter`, and the earlier `color: goldHotInk` guard is gone with the
// text it protected — the themed-ink contract now lives wherever gold TEXT is actually painted
// (ScopeVitals, NudgeCard, CommandPalette), with its floors in theme/chromeContrast.test.ts.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StarfieldWordmark } from "./StarfieldWordmark";

afterEach(() => cleanup());

describe("StarfieldWordmark — the tokens the star field is painted against", () => {
  it("glows in the CONCIERGE surface it sits on, never the builder column", () => {
    render(
      <StarfieldWordmark mode="idle">
        <img src="/sparkle-logo.svg" alt="Sparkle" />
      </StarfieldWordmark>,
    );
    const glow = screen.getByAltText("Sparkle").parentElement!;
    expect(glow.style.filter).toContain("var(--c-concierge-surface)");
    expect(glow.style.filter).not.toContain("var(--c-deep-forest)");
  });

  it("punches the mark out with drop-shadow, which text-shadow cannot do for an image", () => {
    render(
      <StarfieldWordmark mode="idle">
        <img src="/sparkle-logo.svg" alt="Sparkle" />
      </StarfieldWordmark>,
    );
    const glow = screen.getByAltText("Sparkle").parentElement!;
    expect(glow.style.filter).toContain("drop-shadow");
    // text-shadow would silently do nothing to the logo — pin that we did not regress to it.
    expect(glow.style.textShadow).toBe("");
  });

  it("keeps the glow's TOTAL reach at the prototype's ~10px, because filters compound", () => {
    render(
      <StarfieldWordmark mode="idle">
        <img src="/sparkle-logo.svg" alt="Sparkle" />
      </StarfieldWordmark>,
    );
    const glow = screen.getByAltText("Sparkle").parentElement!;
    // A `text-shadow` LIST draws every layer from the same glyph alpha, so the prototype's
    // 10/6/3px trio reaches 10px. Chained `drop-shadow()` functions apply SEQUENTIALLY — each
    // shadows the PREVIOUS pass's output — so those same three radii would reach ~19px and pile
    // the alpha toward opaque, covering the star field this component exists to show
    // (roborev 53605). Transliterating the trio is the plausible-but-wrong move, so pin the sum
    // rather than merely that some drop-shadow is present.
    const radii = [...glow.style.filter.matchAll(/drop-shadow\(0 0 (\d+)px/g)].map((m) =>
      Number(m[1]),
    );
    expect(radii.length).toBeGreaterThan(0);
    expect(radii.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(10);
  });

  it("renders whatever mark it is given, rather than painting the word itself", () => {
    render(
      <StarfieldWordmark mode="idle">
        <img src="/sparkle-logo.svg" alt="Sparkle" />
      </StarfieldWordmark>,
    );
    // The literal word is what this component used to paint; the duplicate-brand-mark fix removed
    // it, so its reappearance means the logo and a wordmark are stacked in the header again.
    expect(screen.queryByText("Sparkle")).toBeNull();
    expect(screen.getByAltText("Sparkle")).toBeTruthy();
  });
});
