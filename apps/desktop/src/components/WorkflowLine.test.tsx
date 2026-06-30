// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowLine } from "./WorkflowLine";
import { stageFraction, stageLineColor, stageMeta } from "../engine/workflowStage";

afterEach(cleanup);

describe("WorkflowLine", () => {
  it("announces the current stage and fills proportionally", () => {
    const { container } = render(<WorkflowLine stage="pull_request" />);
    expect(
      screen.getByLabelText(`Workflow stage: ${stageMeta("pull_request").label}`),
    ).toBeTruthy();
    // The fill div (the only element painted with the logo gradient) is the stage fraction wide
    // (pull_request = 7/9 of the 9-stage path).
    const fill = container.querySelector('div[style*="gradient"]') as HTMLElement;
    expect(fill.style.width).toBe(`${stageFraction("pull_request") * 100}%`);
  });

  it("hides the status detail until expanded, then inks it the line's reached color", () => {
    const { rerender } = render(<WorkflowLine stage="merged" />);
    // Collapsed: no readout text (just the line).
    expect(screen.queryByText(stageMeta("merged").detail)).toBeNull();
    // Expanded: the detail sentence appears, colored the blue the line has warmed to at Merged.
    rerender(<WorkflowLine stage="merged" expanded />);
    const label = screen.getByText(stageMeta("merged").detail);
    expect((label as HTMLElement).style.color).toBe(hexToRgbStyle(stageLineColor("merged")));
  });

  it("keeps a minWidth floor on the bar so a long expanded label can't squash it to zero", () => {
    // Regression: in a narrow flex container the expanded nowrap status label ate all the width and
    // collapsed the flex:1 bar to ~0 (workers showed no progress bar). The track carries a minWidth
    // floor so the bar stays visible regardless of the label's length. jsdom does no layout, so we
    // assert the floor style is present on the track element itself.
    const { container } = render(<WorkflowLine stage="building_saved" expanded />);
    const track = container.querySelector('div[role="img"]') as HTMLElement;
    expect(parseInt(track.style.minWidth, 10)).toBeGreaterThan(0);
  });

  it("shows a sticky ✓ once shipped — even when the bar has reset to an earlier stage", () => {
    // A new cycle resets the live stage back to Committed, but a prior ship keeps the ✓.
    const { rerender } = render(<WorkflowLine stage="building_saved" shipped />);
    expect(screen.getByLabelText("Landed at least once").textContent).toBe("✓");
    // Not shipped → no ✓.
    rerender(<WorkflowLine stage="building_saved" />);
    expect(screen.queryByLabelText("Landed at least once")).toBeNull();
  });
});

// jsdom normalizes inline hex colors to rgb(); convert for the assertion.
function hexToRgbStyle(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
