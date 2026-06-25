// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowTracker } from "./WorkflowTracker";
import { WORKFLOW_STAGES } from "../engine/workflowStage";

afterEach(cleanup);

describe("WorkflowTracker", () => {
  it("renders all five chevrons with the current stage labeled", () => {
    render(<WorkflowTracker stage="pull_request" />);
    // Five chevron segments, each carrying a per-stage title.
    for (const s of WORKFLOW_STAGES) {
      expect(screen.getByTitle(new RegExp(`^${s.label}`))).toBeTruthy();
    }
    // The bar announces its current stage for assistive tech.
    expect(screen.getByLabelText("Workflow stage: Pull Request")).toBeTruthy();
    // The current stage's title is marked "current".
    expect(screen.getByTitle("Pull Request — current")).toBeTruthy();
  });

  it("colors reached stages and grays out the ones still ahead", () => {
    const { container } = render(<WorkflowTracker stage="committed" showLabel={false} />);
    const chevrons = container.querySelectorAll("span[title]");
    expect(chevrons.length).toBe(WORKFLOW_STAGES.length);
    // Uncommitted + Committed are reached → full opacity; the stages still ahead are dimmed.
    expect((chevrons[0] as HTMLElement).style.opacity).toBe("1");
    expect((chevrons[1] as HTMLElement).style.opacity).toBe("1");
    expect((chevrons[2] as HTMLElement).style.opacity).toBe("0.45"); // pull_request, not yet reached
    expect((chevrons[4] as HTMLElement).style.opacity).toBe("0.45"); // merged, not yet reached
    // Reached chevrons carry a real background color (their own stage hue), not an empty string.
    expect((chevrons[1] as HTMLElement).style.background).not.toBe("");
  });
});
