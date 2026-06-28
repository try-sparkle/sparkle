// @vitest-environment jsdom
//
// The ⋯-menu slider for the orchestrator's max concurrent workers: reflects the stored value,
// writes changes back, and renders even when the stored value exceeds the slider's track.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkerLimitControl, WORKER_LIMIT_SLIDER_MAX } from "./WorkerLimitControl";
import { useSettingsStore } from "../stores/settingsStore";

beforeEach(() => useSettingsStore.setState({ maxConcurrentWorkers: 20 }));
afterEach(() => cleanup());

const slider = () => screen.getByLabelText("Max concurrent workers") as HTMLInputElement;

describe("WorkerLimitControl", () => {
  it("reflects the stored value", () => {
    render(<WorkerLimitControl />);
    expect(slider().value).toBe("20");
    expect(screen.getByText("20")).toBeTruthy();
  });

  it("writes a dragged value back to the store", () => {
    render(<WorkerLimitControl />);
    fireEvent.change(slider(), { target: { value: "35" } });
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(35);
    expect(screen.getByText("35")).toBeTruthy();
  });

  it("keeps the thumb on-track but shows the true value when it exceeds the slider max", () => {
    useSettingsStore.setState({ maxConcurrentWorkers: 999 });
    render(<WorkerLimitControl />);
    // Thumb clamps to the track end…
    expect(slider().value).toBe(String(WORKER_LIMIT_SLIDER_MAX));
    // …but the readout shows the real (unbounded) value.
    expect(screen.getByText("999")).toBeTruthy();
  });
});
