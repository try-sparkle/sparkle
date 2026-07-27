// The Sparkle.ai brand wordmark, as a LINK to sparkle.ai.
//
// Extracted from AgentSidebar when the mark moved from column two (builder agents) to column one
// (the persistent concierge). It lives in its own file rather than inline in ConciergeColumn for
// two reasons: the column is a pure renderer driven by its view-model, and the accessibility
// contract below is the kind of thing that quietly regresses when it is one anonymous <a> nested
// three levels inside a layout block.
//
// Deliberately NOT used by HelperIsland or the capture window, which inline their own
// <img src="/sparkle-logo.svg">: the island's is a bare non-interactive 16px mark and the capture
// window's is 28px chrome in another window. Neither wants link behavior.
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * An ANCHOR wrapping the mark — never a bare clickable `<img>` — so the logo is reachable by
 * keyboard and announced as a link, with the destination in its accessible name.
 *
 * We're in a WebView, so a real navigation would replace the app; the system browser is opened via
 * the Tauri opener instead. Hence preventDefault, and a surfaced opener failure rather than a
 * swallowed promise. `href` stays on the element regardless — it is what makes this a link to
 * assistive tech, and what puts the target in the status bar on hover.
 */
export function SparkleLogoLink({ height = 25 }: { height?: number }) {
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
      <img src="/sparkle-logo.svg" alt="Sparkle" style={{ height, display: "block" }} />
    </a>
  );
}
