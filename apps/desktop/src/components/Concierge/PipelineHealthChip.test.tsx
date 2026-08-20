// @vitest-environment jsdom
//
// The pipeline-health indicator (bead sparkle-m6jov5). These assert the SURFACED state, not an
// intermediate: given a health payload, the icon takes the right tone and the click-through panel
// lists each component with its state and reason. The crux case is a WEDGED roborev → amber icon +
// a visible "wedged" warning row, which is exactly the silent outage this whole surface exists to
// make visible; the healthy negative case pins that it is not vacuously always-amber.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PipelineHealthIndicator } from "./PipelineHealthChip";
import type { PipelineHealth } from "../../stores/pipelineHealthStore";

afterEach(cleanup);

const wedged: PipelineHealth = {
  overall: "warning",
  components: [
    {
      id: "roborev",
      name: "Code review (roborev)",
      state: "warning",
      detail:
        "roborev daemon is registered but not responding — it appears wedged. Recover with stop+start.",
    },
    { id: "ci_runners", name: "CI test runners", state: "healthy", detail: "2 of 3 idle" },
    {
      id: "release_runner",
      name: "Release runner (DMG build)",
      state: "healthy",
      detail: "online and ready",
    },
    {
      id: "knightwatch",
      name: "PR reviewer (knightwatch)",
      state: "not_applicable",
      detail: "no PR-review bot is configured",
    },
  ],
};

const allHealthy: PipelineHealth = {
  overall: "healthy",
  components: [
    { id: "roborev", name: "Code review (roborev)", state: "healthy", detail: "running" },
    { id: "ci_runners", name: "CI test runners", state: "healthy", detail: "idle" },
  ],
};

const blocked: PipelineHealth = {
  overall: "blocking",
  components: [
    {
      id: "release_runner",
      name: "Release runner (DMG build)",
      state: "blocking",
      detail: "the macOS release runner is offline — no notarized DMG can be built",
    },
  ],
};

describe("PipelineHealthIndicator", () => {
  it("a WEDGED roborev drives the AMBER icon (the silent outage becomes visible)", () => {
    render(<PipelineHealthIndicator health={wedged} />);
    const chip = screen.getByTestId("pipeline-health-chip");
    // The icon tone IS the visible signal. Amber, not green — a wedge is surfaced, not hidden.
    expect(chip.getAttribute("data-tone")).toBe("amber");
    expect(chip.getAttribute("data-overall")).toBe("warning");
  });

  it("clicking opens the panel and the roborev row shows its WARNING state and the wedge reason", () => {
    render(<PipelineHealthIndicator health={wedged} />);
    // Panel is not shown until clicked.
    expect(screen.queryByTestId("pipeline-health-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("pipeline-health-chip"));
    expect(screen.getByTestId("pipeline-health-panel")).toBeTruthy();
    // The roborev row surfaces the warning state AND the human reason — the whole point of the panel.
    const row = screen.getByTestId("pipeline-health-row-roborev");
    expect(row.getAttribute("data-state")).toBe("warning");
    expect(row.textContent).toContain("wedged");
    // Every component is listed, including the deliberately-off reviewer.
    expect(screen.getByTestId("pipeline-health-row-ci_runners").getAttribute("data-state")).toBe(
      "healthy",
    );
    expect(
      screen.getByTestId("pipeline-health-row-knightwatch").getAttribute("data-state"),
    ).toBe("not_applicable");
  });

  it("the HEALTHY negative case drives GREEN — not vacuously always-amber", () => {
    render(<PipelineHealthIndicator health={allHealthy} />);
    const chip = screen.getByTestId("pipeline-health-chip");
    expect(chip.getAttribute("data-tone")).toBe("green");
    expect(chip.getAttribute("data-overall")).toBe("healthy");
  });

  it("a BLOCKING component drives RED and names it in the panel", () => {
    render(<PipelineHealthIndicator health={blocked} />);
    const chip = screen.getByTestId("pipeline-health-chip");
    expect(chip.getAttribute("data-tone")).toBe("red");
    fireEvent.click(chip);
    const row = screen.getByTestId("pipeline-health-row-release_runner");
    expect(row.getAttribute("data-state")).toBe("blocking");
    expect(row.textContent).toContain("no notarized DMG");
  });

  it("before the first poll (null) the icon is muted 'checking', never a false green", () => {
    render(<PipelineHealthIndicator health={null} />);
    const chip = screen.getByTestId("pipeline-health-chip");
    expect(chip.getAttribute("data-tone")).toBe("muted");
    expect(chip.getAttribute("data-overall")).toBe("checking");
  });
});
