import type { ReactNode } from "react";
import { C } from "../../theme/colors";

/** THE ONE WAY THIS APP DRAWS A KEYBOARD KEY.
 *
 *  Before this there were three spellings of the same idea: the command palette's `esc` chip, the
 *  palette launcher's `⌘K` chip (two copies of one inline style, already drifting on padding), and
 *  ConciergeColumn's unmount hint — a BARE `<kbd>` with no border at all, which is why that hint
 *  had to compensate by wrapping the key in literal square brackets in its copy. Brackets are what
 *  you write when you have no way to draw a key. Now there is one, so they are gone.
 *
 *  Every consumer renders a real `<kbd>`, so a screen reader still announces it as a key.
 */
export type KeyPillTone = "muted" | "violet";

/** Border + ink per tone. Both come from palette TOKENS, never a literal, so a retune of the brand
 *  hue moves the pill with it.
 *
 *  WHY `violet` FOR THE EDGE BUT `violetInk` FOR THE GLYPH — this is the palette's own documented
 *  split (theme/colors.ts), not a hedge. BRAND.violet (#8b6df0) is the "blocked / stalled on
 *  something external" hue and is the colour of the open-PR badge (OpenPrMenu), which is the pill
 *  this tone is meant to match. It is legible as a SHAPE and only as a shape: measured as text on
 *  the flooded terminal plane the unmount hint actually renders on (BLUEPRINT.light.term #d9e3f3),
 *  it comes out at 2.93:1 — far under the repo's 4.5 floor, on the one glyph a reader must read to
 *  know which key to press. `violetInk` is that same brand violet's text twin, themed per mode
 *  (#5636b8 light / #a185f5 dark) and measuring 6.20:1 / 6.78:1 on the same plane. So the pill is
 *  purple in both places a reader sees purple, and readable in both themes.
 */
const TONES: Record<KeyPillTone, { edge: string; ink: string }> = {
  muted: { edge: `color-mix(in srgb, ${C.muted} 25%, transparent)`, ink: C.muted },
  violet: { edge: C.violet, ink: C.violetInk },
};

/** A keycap chip: `<KeyPill>ESC</KeyPill>`.
 *
 *  `tone` colours the PILL ONLY — the surrounding sentence ("to unmount") keeps whatever ink its
 *  own row set, which is the point of the founder's ask. Background stays transparent, matching the
 *  open-PR badge it is tuned against. */
export function KeyPill({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: KeyPillTone;
}) {
  const { edge, ink } = TONES[tone];
  return (
    <kbd
      style={{
        // `inline-flex` rather than `inline`: an inline <kbd> with padding overlaps the line above
        // it when the hint wraps, and the row this sits in is one line tall.
        display: "inline-flex",
        alignItems: "center",
        flex: "0 0 auto",
        fontSize: 10,
        // Inherit the surface's face — this repo has one type scale and a keycap is not a place to
        // introduce a second family.
        fontFamily: "inherit",
        lineHeight: 1.6,
        color: ink,
        border: `1px solid ${edge}`,
        borderRadius: 4,
        padding: "0 5px",
        // NO `opacity` — see ConciergeColumn.unmountHint.test.tsx. The contrast suite measures token
        // pairs and cannot see an inline opacity, so thinning the glyph here would spend the margin
        // the tones above were chosen to keep, invisibly to CI (roborev 55535).
      }}
    >
      {children}
    </kbd>
  );
}
