// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowLine } from "./WorkflowLine";
import { stageFraction, stageLineColor, stageMeta } from "../engine/workflowStage";

afterEach(cleanup);

describe("WorkflowLine", () => {
  it("announces the current stage and fills proportionally", () => {
    const { container } = render(<WorkflowLine stage="pull_request" />);
    expect(screen.getByLabelText("Workflow stage: Pull Request")).toBeTruthy();
    // The fill div (the only element painted with the logo gradient) is the stage fraction wide
    // (3/5 = 60%).
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

  it("prefixes the detail when asked (orchestrator roll-up)", () => {
    render(<WorkflowLine stage="committed" expanded labelPrefix="Overall: " />);
    expect(screen.getByText(`Overall: ${stageMeta("committed").detail}`)).toBeTruthy();
  });
});

// jsdom normalizes inline hex colors to rgb(); convert for the assertion.
function hexToRgbStyle(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
