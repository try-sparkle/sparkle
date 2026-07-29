// THE CONCIERGE WORDMARK'S PAINT — rev4.html's `.wm`.
//
// The mark ramps DARK → LIGHT, left to right, ending on a lighter blue. It is a `background` value
// rather than a colour because `SparkleWordmark` uses the logo asset as an alpha MASK over whatever
// paint it is handed, so a gradient works exactly as a flat fill does (see that file for why the
// mark is masked rather than painted).
//
// ── WHY THIS TAKES A MODE INSTEAD OF READING CSS VARS ─────────────────────────────────────────────
// Everything else in the column themes itself through `var(--c-*)`, which is why a `data-theme` flip
// re-themes the app with no React render. The two ends of this ramp have no CSS var: they are
// `--wm-dark` / `--wm-lit`, which rev-4 adds and which are NOT in `THEME_HEX`, because
// `theme/cssMirror.test.ts` asserts KEY-SET equality between `THEME_HEX` and `index.css` and that
// stylesheet belongs to a concurrent worker. So the caller resolves the theme (`useResolvedTheme`)
// and passes it, the same way `Terminal.tsx` already does for concrete xterm hex.
//
// ── WHY IT IS A TOKEN PAIR AND NOT `linear-gradient(ink, primary)` ────────────────────────────────
// Because WHICH of those two is the darker one FLIPS between themes — in light `primary` is the
// lighter, in dark `ink` is — so a single hard-coded order runs the ramp backwards in exactly one
// theme, silently. `theme/blueprintSpec.test.ts` pins the flip and both ends.
import { BLUEPRINT } from "../../theme/blueprintSpec";
import type { ResolvedTheme } from "../../theme/theme";

/** The mock's angle. 92deg rather than a flat 90 so the ramp crosses the letterforms with a slight
 *  rise, which is what stops it reading as a horizontal band behind the word. */
export const WORDMARK_RAMP_ANGLE = "92deg";

/** `background` for the masked wordmark in the given theme: the spec's dark end into its lit end. */
export function wordmarkRamp(mode: ResolvedTheme): string {
  const t = BLUEPRINT[mode];
  return `linear-gradient(${WORDMARK_RAMP_ANGLE}, ${t.wmDark}, ${t.wmLit})`;
}
