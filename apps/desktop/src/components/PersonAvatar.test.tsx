// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import {
  PersonAvatar,
  availabilityDotOffset,
  availabilityDotSize,
  avatarLetterType,
  paintedExtent,
} from "./PersonAvatar";
import { GLYPH_SLOT_H } from "../engine/rowGeometry";
import { ALLOWED_TYPE } from "../theme/scale";
import { AVAILABILITY, DEFAULT_RING_WIDTH } from "./AvailabilityDot";
import type { Availability } from "../engine/social";

afterEach(cleanup);

/**
 * THE FORMULA, restated independently of the implementation: the dot's centre sits ON the disc's
 * circumference at 45°, so the dot's BOX is inset from the disc's edge by r(1 − 1/√2) − d/2.
 *
 * The assertions below drive it through the rendered DOM rather than calling the exported helper
 * and comparing it to itself: what has to hold is that the number reaches the inline `top`/`right`,
 * which is the only thing that positions anything. jsdom never lays out, so `getBoundingClientRect`
 * is 0 and a class-derived `getComputedStyle` is empty (docs/jsdom-test-caveats.md) — the inline
 * style value IS the observable here, and it is the real one.
 */
const expectedOffset = (size: number, dotSize: number) =>
  Math.round((size / 2) * (1 - 1 / Math.sqrt(2)) - dotSize / 2);

const slotOf = (): HTMLElement => screen.getByTestId("availability-dot-slot");

describe("PersonAvatar — the letter's size comes off the type scale", () => {
  /**
   * The RENDERED value, not the helper compared to itself. The first implementation was
   * `Math.round(size * 0.5)`, which paints 9 at 18 and 14 at 28 — both off `TYPE` — and reds
   * `theme/scale.test.ts`, whose off-scale ceiling is 0. That ratchet reads SOURCE, so it would
   * also have gone green against a hoisted `const RATIO = 0.5`, which still paints 9px. This reads
   * the inline style the component actually set, so it fails for either shape.
   */
  it.each([18, 28])("size %i: the disc's fontSize is a step on TYPE", (size) => {
    render(<PersonAvatar name="Ada Lovelace" availability="available" size={size} />);
    const disc = screen.getByTestId("person-avatar").firstElementChild as HTMLElement;
    const painted = Number.parseFloat(disc.style.fontSize);
    expect(ALLOWED_TYPE).toContain(painted);
    expect(painted).toBe(avatarLetterType(size));
  });

  it("the two composed sizes get DIFFERENT steps — the letter still scales with the disc", () => {
    // Guards the other direction: clamping every avatar to one step (the lazy way to satisfy the
    // ratchet) would make an 18px and a 28px disc carry identical letters.
    expect(avatarLetterType(18)).not.toBe(avatarLetterType(28));
  });

  it("picks the step NEAREST half the diameter: 18 -> 10, 28 -> 13", () => {
    expect(avatarLetterType(18)).toBe(10);
    expect(avatarLetterType(28)).toBe(13);
  });
});

describe("PersonAvatar — the dot sits on the circumference, at every size", () => {
  it.each([18, 28])("size %i: the rendered top/right equal the formula", (size) => {
    const dot = availabilityDotSize(size);
    render(<PersonAvatar name="Ada Lovelace" availability="available" size={size} />);
    const slot = slotOf();
    const want = `${expectedOffset(size, dot)}px`;
    expect(slot.style.top).toBe(want);
    expect(slot.style.right).toBe(want);
  });

  it.each([18, 28])("size %i: the exported helper agrees with the formula", (size) => {
    const dot = availabilityDotSize(size);
    expect(availabilityDotOffset(size, dot)).toBe(expectedOffset(size, dot));
  });

  it("the two sizes do NOT share an offset — a hard-coded constant would be wrong at one of them", () => {
    // This is the whole reason the offset is derived. If someone replaces the formula with the
    // design's worked −1, this fails at 28.
    expect(availabilityDotOffset(18, availabilityDotSize(18))).not.toBe(
      availabilityDotOffset(28, availabilityDotSize(28)),
    );
  });

  it("matches the design's worked example: size 18 -> d=8, offset -1", () => {
    // A pin on the DESIGN DOC's stated geometry (§10), not on the implementation.
    const dot = availabilityDotSize(18);
    expect(dot).toBe(8);
    expect(availabilityDotOffset(18, dot)).toBe(-1);
  });

  it.each([18, 28])(
    "size %i: the LAYOUT box is exactly `size` — the overhang is overflow, not layout",
    (size) => {
      // THE actual layout invariant, asserted on the rendered wrapper rather than on a helper that
      // restates it. The dot slot is position:absolute and so contributes nothing to this box, which
      // is why the overlap is free to tune: no offset can make the avatar grow. Making the wrapper's
      // width depend on the offset — the plausible "fix" someone reaches for after reading the ink
      // arithmetic — fails here.
      render(<PersonAvatar name="Ada" availability="available" size={size} />);
      const wrapper = screen.getByTestId("person-avatar");
      expect(wrapper.style.width).toBe(`${size}px`);
      expect(wrapper.style.height).toBe(`${size}px`);
      // And that box fits the slot at the row size with room over, without counting the dot at all.
      if (size === 18) expect(size).toBeLessThanOrEqual(GLYPH_SLOT_H);
    },
  );

  it("the PAINTED extent is size + |offset| — one overhang per axis, not two", () => {
    // The design doc's "18 + 2 = 20, fits exactly" double-counts: the dot hangs off the top and the
    // right ONLY. The truth is 19. This is ink, not layout — what it constrains is that no ancestor
    // may clip, which is why it is allowed to exceed GLYPH_SLOT_H once the ring is added below.
    expect(paintedExtent(18)).toBe(19);
    expect(paintedExtent(28)).toBe(30);
  });

  it("the ring's ink deliberately exceeds the slot, and nothing clips it", () => {
    // 19 + 2 = 21 in a 20px slot. Intended: a ring that stopped at the slot edge would be cut off on
    // the exact side it exists to separate. Asserted so the claim is checkable rather than prose.
    expect(paintedExtent(18, DEFAULT_RING_WIDTH)).toBe(21);
    expect(paintedExtent(18, DEFAULT_RING_WIDTH)).toBeGreaterThan(GLYPH_SLOT_H);
  });

  it("the dot's own diameter reaches the rendered mark", () => {
    render(<PersonAvatar name="Ada" availability="offline" size={28} />);
    const mark = slotOf().firstElementChild as HTMLElement;
    expect(mark.style.width).toBe(`${availabilityDotSize(28)}px`);
    expect(mark.style.height).toBe(`${availabilityDotSize(28)}px`);
  });

  it("the ring is a box-shadow and NOT a border", () => {
    // WHY: see AvailabilityDot's `ringColor` prop. Not restated here — three copies of that
    // paragraph is what produced four review rounds. The next test pins its arithmetic.
    //
    // Both assertions are load-bearing and neither implies the other: the shadow proves the ring is
    // painted, the absent border proves it was not implemented the way that reasoning forbids (a
    // border added ALONGSIDE the shadow passes the first check and is caught only by the second).
    // Asserting the mark's WIDTH here would prove nothing — under border-box it is 8px either way.
    render(<PersonAvatar name="Ada" availability="available" size={18} ringColor="#123456" />);
    const mark = slotOf().firstElementChild as HTMLElement;
    expect(mark.style.boxShadow).toContain("#123456");
    expect(mark.style.borderWidth).toBe("");
  });

  it.each([
    [18, 4],
    [28, 8],
  ])(
    "size %i: a border ring would leave a %ipx colour core — the cost is NOT a fixed ratio",
    (size, expectedCore) => {
      // The mechanical link that keeps AvailabilityDot's `ringColor` docstring honest. Its formula
      // is `d − 2·ringWidth`, and the whole point of pinning BOTH sizes is that the ratio differs:
      // half the mark at 18 (8 → 4) but only a third at 28 (12 → 8). A docstring that generalizes
      // one of those to "the composed size" is wrong at the other, which is exactly the defect this
      // test exists to make fail rather than merely mislead.
      const d = availabilityDotSize(size);
      expect(d - 2 * DEFAULT_RING_WIDTH).toBe(expectedCore);
    },
  );

  it("the border cost really is a different FRACTION at the two composed sizes", () => {
    // Stated as the comparison, so "half" and "a third" cannot both be written of one size.
    const core = (size: number) => availabilityDotSize(size) - 2 * DEFAULT_RING_WIDTH;
    expect(core(18) / availabilityDotSize(18)).not.toBeCloseTo(core(28) / availabilityDotSize(28));
  });

  it.each(["available", "away", "offline"] as const)(
    "composes the %s mark's OWN colour, not a fixed one",
    (availability: Availability) => {
      // Pinned here too, not only in AvailabilityDot's own suite: what could break is PersonAvatar
      // passing a constant availability down (or dropping the prop), which that suite cannot see.
      render(<PersonAvatar name="Ada" availability={availability} />);
      const mark = slotOf().firstElementChild as HTMLElement;
      expect(mark.style.background).toBe(AVAILABILITY[availability].color);
    },
  );
});

describe("PersonAvatar — the accessible name carries availability IN WORDS", () => {
  it.each(["available", "away", "offline"] as const)(
    "%s is spoken, not merely coloured",
    (availability: Availability) => {
      render(<PersonAvatar name="Ada Lovelace" availability={availability} />);
      const img = screen.getByRole("img");
      // WCAG 1.4.1 — colour alone is not information. The word must be in the name.
      // (No jest-dom in this repo, and jsdom computes no accessible name anyway: `aria-label` on a
      // `role="img"` IS the name, so asserting the attribute is asserting the mechanism.)
      expect(img.getAttribute("aria-label")).toBe(`Ada Lovelace — ${AVAILABILITY[availability].label}`);
      expect(img.getAttribute("aria-label")).toContain(AVAILABILITY[availability].label);
    },
  );

  it("names the person too, so a column of dots is not a column of anonymous states", () => {
    render(<PersonAvatar name="Grace" availability="away" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Grace — /);
  });

  it("the dot itself is aria-hidden, so the state is announced ONCE", () => {
    render(<PersonAvatar name="Ada" availability="available" />);
    const mark = slotOf().firstElementChild as HTMLElement;
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    // And it is genuinely a leaf of the named image, not a sibling that escaped the name.
    expect(screen.getByRole("img").contains(mark)).toBe(true);
  });
});

describe("PersonAvatar — the letter", () => {
  it("shows the first code point, uppercased (reusing entitlement.avatarLetter)", () => {
    render(<PersonAvatar name="ada" availability="offline" />);
    expect(screen.getByRole("img").textContent).toBe("A");
  });

  it("falls back to a Feather person glyph — never an emoji — when there is no letter", () => {
    const { container } = render(<PersonAvatar name="   " availability="offline" />);
    expect(screen.getByRole("img").textContent).toBe("");
    expect(container.querySelector("svg")).not.toBeNull();
  });
});