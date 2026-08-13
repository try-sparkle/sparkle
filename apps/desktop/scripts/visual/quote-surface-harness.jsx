// The page `quote-surface-probe.mjs` measures: the concierge's QUOTE SURFACE, in a real browser.
//
// Two founder reports about the same piece of chrome, both of them claims about PIXELS:
//
//   1. *"Make this quote response button less rounded I can't stand the rounded buttons like that."*
//      — the floating `QuoteChiclet` ("Quote in response"), which was a full capsule.
//   2. a screenshot, no words: a concierge blockquote whose COPY GLYPH sits ON TOP of the blue quote
//      rule, with the quoted text starting straight after it. It reads as a rendering collision.
//
// The second is a CSS float rule that no unit test in this repo could see. The copy glyph is
// `float: left` (ConciergeMessageRow), and a float shortens the LINE BOXES beside it — it does not
// shorten a following BLOCK's box. A `<blockquote>` is a block, so its `border-left` is laid at the
// container's left edge, underneath the float, while its inline text is pushed clear. jsdom has no
// float implementation at all, so the overlap is invisible there by construction.
//
// `.jsx` rather than `.tsx` on purpose: `tsconfig.json` includes only `src`, so a `.tsx` here would
// be silently outside `pnpm typecheck` and look covered when it is not.
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import { Markdown } from "../../src/components/Markdown";
import { CopyAnswerButton } from "../../src/components/Concierge/CopyAnswerButton";
import { QuoteChiclet } from "../../src/components/Concierge/QuoteChiclet";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";

/**
 * An answer whose FIRST BLOCK is a blockquote — the shape in the founder's screenshot.
 *
 * Leading with the quote is what puts the block beside the float. An answer that opened with a
 * paragraph would push the quote below the glyph and the collision would not occur, so a fixture
 * that did that would be measuring a case the report is not about.
 */
const ANSWER = [
  "> get as much of the queue drained as you can before the release cut",
  "",
  "#1765 is merged. The queue is down to four, and priority is now on the release notes.",
].join("\n");

function Harness() {
  return (
    <div id="page" style={{ padding: 24, width: 460 }}>
      {/* EXACTLY `ConciergeMessageRow`'s answer markup — the floated span and the markdown as
          siblings. Copied rather than imported because the row needs the whole concierge store
          graph; what is under test is this two-element relationship, and it is reproduced verbatim
          so a change to the row's float that re-opens the collision still has to be made here too.
          `quote-surface-probe.mjs` re-reads the row's own source and fails if the two drift. */}
      <div data-testid="answer">
        <span style={{ float: "left", marginRight: 6, marginLeft: -2, marginTop: -1 }}>
          <CopyAnswerButton text={ANSWER} />
        </span>
        <Markdown text={ANSWER} mergeQuotes />
      </div>
      {/* The chiclet, mounted at a fixed point so its corner radius can simply be read. It portals
          itself to `document.body`, which is why it is not inside the answer box above. */}
      <QuoteChiclet x={40} y={260} onQuote={() => {}} onDismiss={() => {}} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);

requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.__quoteHarnessReady = true;
  });
});
