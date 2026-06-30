import { describe, it, expect } from "vitest";
import { paneVisibilityStyle } from "./paneVisibility";

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

  it("makes only the active pane interactive so stacked hidden panes never steal clicks", () => {
    expect(paneVisibilityStyle(false).pointerEvents).toBe("none");
    expect(paneVisibilityStyle(true).pointerEvents).toBe("auto");
  });

  it("stacks the active pane above the inert hidden ones", () => {
    expect(paneVisibilityStyle(true).zIndex).toBeGreaterThan(paneVisibilityStyle(false).zIndex);
  });
});
