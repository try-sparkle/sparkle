// The Sparkle.ai brand wordmark itself — the pixels, with no link, no layout and no opinion about
// which window it is in.
//
// ── WHY IT IS PAINTED, NOT DRAWN ────────────────────────────────────────────────────────────────
// `/sparkle-logo.svg` carries its own `linearGradient` — cyan #34E0F0 → blue #3E7BFF — so rendering
// it as an `<img>` made the app's one brand mark the single largest patch of a hue the token layer
// declares DECORATIVE. `packages/ui/tokens.ts` names gold "the primary accent of the black-and-gold
// shell". So the asset is used as an alpha MASK over a themed fill instead, which buys two things an
// asset edit could not:
//   • it is THEMED. A literal gold baked into the asset would be #f5c26b on light mode's near-white
//     column, i.e. invisible — the trap `goldFill` documents. `goldInk` is gold in dark and a deep
//     gold-brown in light, and chromeContrast.test.ts already holds it to the AA floor on every
//     plane.
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

export function SparkleWordmark({
  height = 25,
  /** The paint behind the mask. Defaults to the themed gold ink; the capture takeover passes the
   *  dark literal because that window is dark regardless of the app theme. */
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
