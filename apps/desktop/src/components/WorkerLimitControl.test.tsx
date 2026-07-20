// @vitest-environment jsdom
//
// The ⋯-menu slider for the orchestrator's max concurrent workers: reflects the stored value,
// writes changes back, and renders even when the stored value exceeds the slider's track.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The slider persists to config.toml via this action (debounced); mock it so we can assert the
// write behavior without IPC.
vi.mock("../services/configActions", () => ({
  setMaxConcurrentWorkers: vi.fn().mockResolvedValue(undefined),
}));

import { WorkerLimitControl, WORKER_LIMIT_SLIDER_MAX } from "./WorkerLimitControl";
import { setMaxConcurrentWorkers } from "../services/configActions";
import { useSettingsStore } from "../stores/settingsStore";

beforeEach(() => {
  vi.clearAllMocks();
  // Plenty of RAM by default, so the memory hint stays out of the way in unrelated tests.
  useSettingsStore.setState({ maxConcurrentWorkers: 20, effectiveMaxConcurrentWorkers: 20 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const slider = () => screen.getByLabelText("Max concurrent workers") as HTMLInputElement;

describe("WorkerLimitControl", () => {
  it("warns when this machine's RAM holds fewer agents than the slider is set to", () => {
    // The honest case (sparkle-01xv): the user asked for 20, RAM only supports 3. The slider must
    // keep showing THEIR 20 — but must not let them believe 20 will actually run.
    useSettingsStore.setState({ maxConcurrentWorkers: 20, effectiveMaxConcurrentWorkers: 3 });
    render(<WorkerLimitControl />);
    expect(slider().value).toBe("20");
    expect(screen.getByText(/memory only fits 3/i)).toBeTruthy();
  });

  it("shows no memory warning when RAM supports the configured value", () => {
    useSettingsStore.setState({ maxConcurrentWorkers: 4, effectiveMaxConcurrentWorkers: 8 });
    render(<WorkerLimitControl />);
    // Only the memory hint must be absent — the base "may run at once" hint always renders.
    expect(screen.queryByText(/memory only fits/i)).toBeNull();
  });

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

  it("persists exactly once per drag, after the debounce settles", () => {
    vi.useFakeTimers();
    render(<WorkerLimitControl />);
    fireEvent.change(slider(), { target: { value: "30" } }); // live store update + mark dirty
    fireEvent.pointerUp(slider()); // schedule the debounced persist
    expect(setMaxConcurrentWorkers).not.toHaveBeenCalled(); // not yet — still debouncing
    vi.advanceTimersByTime(200);
    expect(setMaxConcurrentWorkers).toHaveBeenCalledTimes(1);
    expect(setMaxConcurrentWorkers).toHaveBeenCalledWith(30);
  });

  it("flushes a pending write on unmount (close-panel-mid-debounce)", () => {
    vi.useFakeTimers();
    const { unmount } = render(<WorkerLimitControl />);
    fireEvent.change(slider(), { target: { value: "33" } });
    fireEvent.pointerUp(slider());
    unmount(); // within the 200ms window → must still persist, not drop
    expect(setMaxConcurrentWorkers).toHaveBeenCalledTimes(1);
    expect(setMaxConcurrentWorkers).toHaveBeenCalledWith(33);
  });

  it("a settle event with no user change is a no-op (dirty=false)", () => {
    vi.useFakeTimers();
    render(<WorkerLimitControl />);
    fireEvent.blur(slider()); // no preceding change → nothing dirty
    vi.advanceTimersByTime(200);
    expect(setMaxConcurrentWorkers).not.toHaveBeenCalled();
  });
});
