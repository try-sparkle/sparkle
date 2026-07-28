// The Sparkle.ai brand wordmark itself — the pixels, with no link, no layout and no opinion about
// which window it is in.
//
// ── WHY IT IS PAINTED, NOT DRAWN ────────────────────────────────────────────────────────────────
// `/sparkle-logo.svg` carries its own `linearGradient` — cyan #34E0F0 → blue #3E7BFF — so rendering
// it as an `<img>` made the app's one brand mark the single largest patch of a hue the token layer
// declares DECORATIVE. So the asset is used as an alpha MASK over a themed fill instead, which buys
// two things an asset edit could not:
//   • it is THEMED. A literal accent baked into the asset would be a pale blue on light mode's
//     near-white column, i.e. invisible — the trap `goldFill` documents. `goldInk` is a bright blue
//     in dark and a deep saturated blue in light, and chromeContrast.test.ts already holds it to the
//     AA floor on every plane.
//   • the asset stays untouched, so nothing else that ships it (the marketing site, the installer)
//     inherits a desktop-only decision.
//
// ── WHY IT IS ITS OWN FILE ──────────────────────────────────────────────────────────────────────
// It was inline in `SparkleLogoLink`, which is a LINK — and the capture takeover, which shows the
// mark but must not navigate anywhere, therefore kept its own raw `<img>`. The two marks disagreed:
// one gold, one cyan, in the same app (roborev 53986). Splitting the mark from the link is what lets
// both windows paint the same pixels; the fill is a prop because the capture window pins
// `data-theme=dark` regardless of the app theme and passes the dark literal.
//
// The accessible name lives HERE, on the masked box: `role="img"` + `aria-label` is what `alt` was
// doing on the `<img>` it replaced. Query it with `getByRole("img", { name: "Sparkle" })` —
// `getByAltText` cannot see it, which is exactly the migration roborev caught mid-flight.
//
// There is no `data-logo-src` mirror any more (roborev 54019). It was a test-only copy of the asset
// path, so both windows' assertions verified the copy while a typo, a renamed asset or a mask that
// fails to load would paint a solid gold rectangle — with no fallback — and stay green. Tests import
// `LOGO_SRC` and read the mask that is actually applied.
import { C } from "../theme/colors";

/** The asset's own aspect ratio (viewBox 850.23 × 188.31), so a caller sizes the mark by HEIGHT
 *  alone the way it did when this was an `<img>` — the width follows. */
const LOGO_ASPECT = 850.23 / 188.31;

/** The wordmark asset, used as an alpha MASK rather than painted. See the note above. */
export const LOGO_SRC = "/sparkle-logo.svg";

/**
 * A GOLD SHEEN — a single specular glint sweeping the letters, for callers that want the mark to
 * carry more of the app's gradient wordmark treatment than a flat fill does (founder, 2026-07-27:
 * "make the logo sparklier", kept elegant). The concierge header uses it; the capture takeover and
 * the default stay flat.
 *
 * A GRADIENT works here for free: the mask is what cuts the letterforms, and `background` behind it
 * can be any paint — which is exactly why `fill` is a string rather than a color type.
 *
 * WHY GOLD AND NOT THE ASSET'S CYAN. The shipped SVG's own cyan→blue gradient is the thing this
 * component exists to NOT paint (see the note above); reintroducing it as a "sparklier" fill would
 * undo that decision by the back door. So the sheen is built from the two THEMED gold tokens, and
 * the highlight stop is `goldHotInk`, which moves AWAY from the surface in both themes — lighter
 * than `goldInk` on dark, darker on light (see theme/colors) — so no stop can land closer to the
 * plane than the flat fill chromeContrast.test.ts already holds to AA.
 *
 * STATIC, not animated: an animating wordmark is a permanent motion source at the top of the one
 * column that is always on screen, and would need a `prefers-reduced-motion` escape. One glint
 * reads as material, not as an effect.
 */
export const GOLD_SHEEN = `linear-gradient(100deg, ${C.goldInk} 0%, ${C.goldInk} 34%, ${C.goldHotInk} 50%, ${C.goldInk} 66%, ${C.goldInk} 100%)`;

export function SparkleWordmark({
  height = 25,
  /** The paint behind the mask — any CSS `background` value, so a gradient works as well as a
   *  color (see GOLD_SHEEN). Defaults to the themed gold ink; the capture takeover passes the dark
   *  literal because that window is dark regardless of the app theme. */
  fill = C.goldInk,
}: {
  height?: number;
  fill?: string;
}) {
  return (
    <span
      role="img"
      aria-label="Sparkle"
      style={{
        display: "block",
        height,
        width: height * LOGO_ASPECT,
        background: fill,
        // Both spellings: the WebView is WebKit-based and still wants the prefixed properties.
        WebkitMaskImage: `url(${LOGO_SRC})`,
        maskImage: `url(${LOGO_SRC})`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}
