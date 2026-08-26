import { describe, it, expect } from "vitest";
import { paneVisibilityStyle } from "./paneVisibility";
import { BUILD_COLUMN_Z, TERMINAL_PANE_Z } from "./layers";

// The terminal "thin-column on reveal" bug class came from hiding inactive agent panes with
// `display: none`, which collapses their box to 0×0. xterm's FitAddon then measured a 0-width
// container and either spawned/fit into a ~11-column strip or raced (for multiple frames) to
// re-converge on reveal — the "tiny box in the top-left until I scroll" symptom. The durable fix
// is to keep every pane LAID OUT at full size always (so fit() is correct the instant it mounts and
// on every reveal) and hide inactive ones with `visibility`/`pointer-events` instead. These tests
// lock that invariant in so a future edit can't silently reintroduce `display: none`.
describe("paneVisibilityStyle", () => {
  it("never collapses the box with display:none — the hidden pane stays laid out", () => {
    // The whole point: a hidden pane must keep a real, measurable box so xterm fits correctly.
    expect(paneVisibilityStyle(false).display).toBe("flex");
    expect(paneVisibilityStyle(true).display).toBe("flex");
  });

  it("hides an inactive pane with visibility (not by removing its layout box)", () => {
    expect(paneVisibilityStyle(false).visibility).toBe("hidden");
    expect(paneVisibilityStyle(true).visibility).toBe("visible");
  });

  // ── AND SHEDS THE HIDDEN PANE'S SUBTREE LAYOUT COST (sparkle-gw36j) ───────────────────────────
  // `visibility: hidden` keeps the box (good — measurable) but still LAYS OUT the subtree, so all
  // ~50 backgrounded terminals (mostly on xterm's DOM renderer past MAX_WEBGL_CONTEXTS) take part
  // in every forced layout — ~0.37 s per layout at 40 panes on the shipped renderer. A hidden pane
  // must therefore also carry `content-visibility: hidden` so the engine skips its contents' layout
  // while backgrounded; the active pane must NOT (it renders normally and its fillets/overhang must
  // paint). The terminal refits on reveal via Terminal.tsx's become-active settle. Real layout perf
  // is unmeasurable in jsdom (no layout, no content-visibility support) — this asserts the SKIP
  // SIGNAL the fix applies, which is the property that goes to the DOM.
  it("skips the hidden pane's subtree layout with content-visibility, and never the active one", () => {
    expect(paneVisibilityStyle(false).contentVisibility).toBe("hidden");
    expect(paneVisibilityStyle(true).contentVisibility).toBe("visible");
  });

  it("makes only the active pane interactive so stacked hidden panes never steal clicks", () => {
    expect(paneVisibilityStyle(false).pointerEvents).toBe("none");
    expect(paneVisibilityStyle(true).pointerEvents).toBe("auto");
  });

  it("stacks the active pane above the inert hidden ones", () => {
    expect(paneVisibilityStyle(true).zIndex).toBeGreaterThan(paneVisibilityStyle(false).zIndex);
  });

  // ── AND BELOW THE BUILD COLUMN ───────────────────────────────────────────────────────────────
  // The selected agent row bleeds 9px out of the Build column and into the terminal pane. The pane
  // is LATER IN THE DOM than the column, so at an equal stacking level it paints last and hides the
  // overhang entirely — which is how the row's opening-into-the-pane treatment came to look broken
  // and got "fixed" by deleting the overhang. The direction's answer is an ordering between the two
  // columns (`.build` 2 / `.term` 1); this is the pane's half of it.
  it("keeps the active pane BELOW the Build column, so the selected row's overhang stays visible", () => {
    expect(paneVisibilityStyle(true).zIndex).toBe(TERMINAL_PANE_Z);
    expect(BUILD_COLUMN_Z).toBeGreaterThan(paneVisibilityStyle(true).zIndex);
  });

  it("leaves the floated-column and Plan-board layers unambiguously above both", () => {
    // Guard against someone raising the pane to win some other ordering fight: the docked columns
    // are the BOTTOM of this module's ladder, and a pane that climbed past BUILD_COLUMN_Z would
    // re-hide the overhang without failing the assertion above on its own.
    expect(TERMINAL_PANE_Z).toBeLessThan(BUILD_COLUMN_Z);
    expect(paneVisibilityStyle(false).zIndex).toBeLessThan(TERMINAL_PANE_Z);
  });
});
