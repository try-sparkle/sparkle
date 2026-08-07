import { memo, type CSSProperties } from "react";
import { FiUser } from "react-icons/fi";

import { C, ON_BRAND_FILL, FONT_WEIGHT } from "../theme/colors";
import { ALLOWED_TYPE, FONT_UI } from "../theme/scale";
import { avatarLetter, type Me } from "../services/entitlement";
import type { Availability } from "../engine/social";
import { AvailabilityDot, availabilityLabel } from "./AvailabilityDot";

/**
 * A person's letter disc with their availability dot on it. Design:
 * docs/superpowers/specs/2026-08-05-social-coding-design.md §10 "Key UI design calls".
 *
 * ══ WHY ONE COMPONENT AND NOT TWO CALL SITES ═══════════════════════════════════════════════════
 * Two surfaces draw this at two sizes — a chat row at **18** and `AuthStatusButton`'s own avatar at
 * **28** — and the thing that must not drift between them is the OVERLAP: how far the dot sits off
 * the disc. Composed here, taking `size`, the two cannot disagree. Hand-placed at each call site
 * they would, immediately and invisibly, because the correct offset is not a constant — it is a
 * function of both diameters (see {@link availabilityDotOffset}).
 *
 * ══ IT FITS THE EXISTING ROW SLOT; NOTHING NEEDS TO GROW ═══════════════════════════════════════
 * The binding constraint is the sidebar's `GLYPH_SLOT_H` (20) inside a 24×20 slot, and it is worth
 * being exact about WHICH box is being constrained, because two earlier attempts at this paragraph
 * got it wrong in opposite directions.
 *
 * **LAYOUT: the composed box is exactly `size`, at every offset.** The dot's slot is
 * `position: absolute`, so it is out of flow and contributes NOTHING to the wrapper's box, and the
 * wrapper carries an explicit `width`/`height` of `size`. 18 ≤ 20, so nothing needs to grow — and
 * that is true independently of the dot, which is what makes the overlap free to tune. (This also
 * means a `border` on the dot could not grow the wrapper either, and `* { box-sizing: border-box }`
 * in index.css means it would not grow the dot's own box — so whatever the reason the ring is a
 * `box-shadow` is, it is not a layout reason. **For what it actually is, read
 * `AvailabilityDot`'s `ringColor` prop.** That is the one place it is stated, and this comment
 * carries neither the reason nor its arithmetic on purpose: this paragraph existing in three
 * files, each drifting from the others, is what produced four review rounds on this branch.)
 *
 * **INK: the overhang is OVERFLOW, and the ancestor must not clip it.** The dot hangs past the disc
 * on the top and the right ONLY — no bottom, no left — so each axis paints one offset beyond, not
 * two. The design doc's `18 + 2 = 20` double-counts; the real figure is 18 + 1 = **19**
 * ({@link paintedExtent}), and **21 with the ring**, which is past the 20px slot on purpose. The
 * sidebar row does not clip at the glyph slot, and a ring that stopped at the slot edge would be cut
 * off on the exact side it exists to separate.
 *
 * ══ COLOUR IS NOT THE INFORMATION ══════════════════════════════════════════════════════════════
 * The accessible name carries the availability IN WORDS ("Ada Lovelace — Available"). The dot itself
 * is `aria-hidden`. WCAG 1.4.1, which this codebase enforces: a green disc that only a sighted user
 * can read is not a status.
 */

/** The dot's diameter as a fraction of the avatar's, from the design's worked pair (d=8 at size 18).
 *  Kept as the ratio rather than a table so a third size is right without an edit. */
export const DOT_DIAMETER_RATIO = 8 / 18;

/** The dot's diameter for a given avatar size. */
export function availabilityDotSize(size: number): number {
  return Math.round(size * DOT_DIAMETER_RATIO);
}

/**
 * How far the dot is inset from the disc's top-right corner, in px. NEGATIVE means it overhangs.
 *
 * **This is a derivation, not a magic number, and it must stay one.** The design's rule is that the
 * dot's CENTRE sits ON the disc's circumference — a clean 50% overlap. Put the dot's centre at 45°
 * on the circle of radius `r = size/2`: its centre is `r/√2` from the disc's centre along each axis,
 * i.e. `r − r/√2` from the disc's edge. The dot's own box starts `d/2` before its centre, so the
 * box's inset from the edge is
 *
 *     r(1 − 1/√2) − d/2
 *
 * At r=9, d=8 that is `9(0.29289) − 4 = −1.36`, so −1 — which is the integer the design states.
 * Rounded, because a sub-pixel `top` on a 20px slot is a blurry dot, not a more accurate one.
 *
 * Hard-coding −1 would be wrong at every other size (at 28 the same rule gives −2), and wrong
 * SILENTLY — the dot would drift off the circumference with nothing failing. That is why the test
 * asserts this against the formula rather than against the number it happens to produce.
 */
export function availabilityDotOffset(size: number, dotSize: number): number {
  const r = size / 2;
  return Math.round(r * (1 - 1 / Math.SQRT2) - dotSize / 2);
}

/**
 * The composed **PAINTED** extent per axis — how far ink reaches, excluding the ring.
 *
 * NOT a layout quantity: the dot is out of flow, so the composed LAYOUT box is exactly `size` at
 * every offset (see the header). This is the number that overflows the wrapper, so what it
 * constrains is that no ancestor may CLIP, not that anything must fit.
 *
 * `size + |offset|`, NOT `size + 2|offset|` — the dot is at the top-right corner only, so there is
 * nothing hanging off the bottom or the left to add. It is a function rather than a comment because
 * the comment has now been wrong twice: once about the arithmetic, once about which box it described.
 */
export function paintedExtent(size: number, ringWidth = 0): number {
  return size + Math.abs(availabilityDotOffset(size, availabilityDotSize(size))) + ringWidth;
}

/**
 * The letter's type size — **a step off `TYPE`, chosen by the disc's diameter.**
 *
 * The first cut was `Math.round(size * 0.5)`, which is proportional and therefore optically right,
 * and wrong for this codebase: at 18 it renders 9 and at 28 it renders 14, and neither is on the
 * type scale. `theme/scale.test.ts` is a ratchet whose ceiling is now **0** — every off-scale
 * `fontSize:` in the repo has been migrated — so a fresh one reds the fleet, and the rendered
 * values were off-scale independently of how the expression was written. Hoisting the `0.5` into a
 * constant would have satisfied the scanner while still painting 9px and 14px; that is the escape
 * hatch the guard's own comments call out, not a fix.
 *
 * So it picks the NEAREST allowed step instead of computing a free number: 18 → `micro` (10),
 * 28 → `body` (13). Still a derivation rather than a table, which is the property
 * {@link availabilityDotOffset} exists to protect — a third size gets a sensible step with no edit
 * here — but the output is now drawn from the scale rather than from arithmetic that happens to
 * land near it.
 *
 * Ties go to the SMALLER step (`<`, not `<=`, on a strict improvement): a letter that overflows its
 * disc is a worse failure than one with a little air around it.
 */
export function avatarLetterType(size: number): number {
  const target = size / 2;
  return ALLOWED_TYPE.reduce((best, step) =>
    Math.abs(step - target) < Math.abs(best - target) ? step : best,
  );
}

/**
 * `avatarLetter` takes the auth `Me` shape and reads exactly one thing out of it —
 * `authIdentity(me)`, i.e. `name || email`. A person is not an auth identity, so we hand it the one
 * field it reads rather than growing a SECOND first-code-point implementation here. That function
 * already carries the reasoning (first code point, not the first UTF-16 unit, so an astral glyph is
 * not sliced into a lone surrogate); duplicating it is how the row and the top bar would eventually
 * disagree about the same person's initial. The other fields are inert.
 */
function asIdentity(name: string): Me {
  return { clerkUserId: "", entitled: false, balanceCents: 0, tokenVersion: 0, name };
}

export const PersonAvatar = memo(function PersonAvatar({
  name,
  availability,
  size = 18,
  ringColor = C.deepForest,
  fill = C.teal,
}: {
  /** What this person is CALLED — `personName(person)` from the store, which is the display name
   *  when they set one and the username otherwise. Drives both the letter and the spoken name. */
  name: string;
  availability: Availability;
  /** Avatar diameter. 18 in a sidebar row, 28 in the top bar. Everything else derives from it. */
  size?: number;
  /** The colour BEHIND the avatar, painted as the dot's ring so the dot reads as separate from the
   *  fill. Defaults to the sidebar's surface; the top bar passes its own. */
  ringColor?: string;
  /** The disc fill. Defaults to the brand teal `AuthStatusButton` uses, so a person's disc and the
   *  user's own read as the same kind of object. */
  fill?: string;
}) {
  const dot = availabilityDotSize(size);
  const offset = availabilityDotOffset(size, dot);
  const letter = avatarLetter(asIdentity(name));

  const disc: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: size,
    height: size,
    borderRadius: "50%",
    background: fill,
    color: ON_BRAND_FILL,
    // A step off TYPE, scaled to the disc — see `avatarLetterType` for why not `size * 0.5`.
    fontSize: avatarLetterType(size),
    fontWeight: FONT_WEIGHT.semibold,
    fontFamily: FONT_UI,
    lineHeight: 1,
  };

  return (
    <span
      role="img"
      // The ONE accessible name, and it names the availability in words. Everything inside is
      // aria-hidden so this is not read twice.
      aria-label={`${name} — ${availabilityLabel(availability)}`}
      data-testid="person-avatar"
      style={{
        // `size`, unconditionally — see the header. The dot's overhang is overflow, not layout, so
        // the composed box never depends on the offset.
        position: "relative",
        display: "inline-flex",
        width: size,
        height: size,
        flex: "0 0 auto",
      }}
    >
      <span style={disc} aria-hidden>
        {/* No letter to show (a blank name) → a neutral person glyph, never an emoji (house rule);
            react-icons/fi, matching AuthStatusButton. */}
        {letter || <FiUser size={Math.round(size * 0.55)} />}
      </span>
      <span
        data-testid="availability-dot-slot"
        style={{ position: "absolute", top: offset, right: offset, lineHeight: 0 }}
      >
        <AvailabilityDot
          availability={availability}
          size={dot}
          ringColor={ringColor}
          title={`${name} — ${availabilityLabel(availability)}`}
        />
      </span>
    </span>
  );
});
