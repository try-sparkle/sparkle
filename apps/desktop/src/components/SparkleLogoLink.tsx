// The Sparkle.ai brand wordmark, as a LINK to sparkle.ai.
//
// Extracted from AgentSidebar when the logo moved from column two (builder agents) to column one
// (the persistent concierge). It lives in its own file rather than inline in ConciergeColumn for
// two reasons: the column is a pure renderer driven by its view-model, and the accessibility
// contract below is the kind of thing that quietly regresses when it is one anonymous <a> nested
// three levels inside a layout block.
//
// The MARK itself is `SparkleWordmark` — see that file for why it is an alpha mask over `goldInk`
// rather than the shipped cyan→blue asset. This file is only the link around it, which is the split
// that let the capture takeover stop painting a second, disagreeing wordmark.
import { openUrl } from "@tauri-apps/plugin-opener";
import { SparkleWordmark } from "./SparkleWordmark";

/**
 * An ANCHOR wrapping the mark — never a bare clickable element — so the logo is reachable by
 * keyboard and announced as a link, with the destination in its accessible name.
 *
 * We're in a WebView, so a real navigation would replace the app; the system browser is opened via
 * the Tauri opener instead. Hence preventDefault, and a surfaced opener failure rather than a
 * swallowed promise. `href` stays on the element regardless — it is what makes this a link to
 * assistive tech, and what puts the target in the status bar on hover.
 */
export function SparkleLogoLink({
  height = 25,
  /** Passed straight through to the mark — the concierge header hands it `GOLD_SHEEN`. The link
   *  itself has no opinion about paint; forwarding is what keeps the header from having to reach
   *  past this component to `SparkleWordmark` and rebuild the anchor around it. */
  fill,
}: {
  height?: number;
  fill?: string;
}) {
  return (
    <a
      href="https://sparkle.ai"
      title="Open sparkle.ai"
      onClick={(e) => {
        e.preventDefault();
        openUrl("https://sparkle.ai").catch((err) =>
          console.error("Failed to open sparkle.ai:", err),
        );
      }}
      style={{ display: "inline-flex", cursor: "pointer" }}
    >
      <SparkleWordmark height={height} {...(fill === undefined ? {} : { fill })} />
    </a>
  );
}
