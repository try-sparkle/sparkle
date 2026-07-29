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

import { WorkerLimitControl, WORKER_LIMIT_SLIDER_FLOOR } from "./WorkerLimitControl";
import { setMaxConcurrentWorkers } from "../services/configActions";
import { useSettingsStore } from "../stores/settingsStore";

beforeEach(() => {
  vi.clearAllMocks();
  // Plenty of headroom by default, so the machine hint stays out of the way in unrelated tests.
  useSettingsStore.setState({
    maxConcurrentWorkers: 20,
    effectiveMaxConcurrentWorkers: 20,
    // MUST be reset (roborev 55091): `setState` MERGES, and `sliderMax` is derived from this field,
    // so a test that seeds 81 leaks it into every test declared after it. The
    // exceeds-the-track case below then passed only by DECLARATION ORDER — under
    // `--sequence.shuffle`, a `.only`, or a test inserted above it, the track would be 81 and its
    // assertion would read "81" instead of the floor.
    machineMaxConcurrentWorkers: 20,
    concurrencyBound: "unknown",
    concurrencyBasis: "",
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const slider = () => screen.getByLabelText("Max concurrent workers") as HTMLInputElement;

describe("WorkerLimitControl", () => {
  it("warns when this machine holds fewer agents than the slider is set to", () => {
    // The honest case (sparkle-01xv): the user asked for 20, the machine only supports 3. The
    // slider must keep showing THEIR 20 — but must not let them believe 20 will actually run.
    useSettingsStore.setState({
      maxConcurrentWorkers: 20,
      effectiveMaxConcurrentWorkers: 3,
      concurrencyBound: "ram",
      concurrencyBasis: "RAM-bound: 16 GiB installed − 6 GiB reserved, ÷ 1536 MiB per agent",
    });
    render(<WorkerLimitControl />);
    expect(slider().value).toBe("20");
    expect(screen.getByText(/runs 3 at once/i)).toBeTruthy();
    expect(screen.getByText(/RAM-bound: 16 GiB installed/i)).toBeTruthy();
    // RAM really is the constraint here, so the heap remedy is the right one to offer.
    expect(screen.getByText(/Lowering agent_heap_mb/i)).toBeTruthy();
  });

  // roborev 53087, closed. The hint asserted memory unconditionally, so on a core-bound machine —
  // the common case on a big Mac, where 18 cores × 2 = 36 sits well below what 128 GiB holds — it
  // named the wrong dimension AND offered a remedy (lower agent_heap_mb) that cannot move the
  // number. The binding dimension now comes from the Rust derivation that computed the limit.
  it("names the CPU bound, and withholds the heap remedy, on a core-bound machine", () => {
    useSettingsStore.setState({
      maxConcurrentWorkers: 50,
      effectiveMaxConcurrentWorkers: 36,
      concurrencyBound: "cpu",
      concurrencyBasis: "CPU-bound: 18 cores × 2 agents per core",
    });
    render(<WorkerLimitControl />);
    expect(screen.getByText(/CPU-bound: 18 cores × 2 agents per core/i)).toBeTruthy();
    expect(screen.queryByText(/agent_heap_mb/i)).toBeNull();
    expect(screen.getByText(/More memory won't change this/i)).toBeTruthy();
  });

  it("says neither remedy alone helps when RAM and cores bind equally", () => {
    useSettingsStore.setState({
      maxConcurrentWorkers: 40,
      effectiveMaxConcurrentWorkers: 16,
      concurrencyBound: "both",
      concurrencyBasis: "CPU-bound: 8 cores × 2 agents per core, and equally RAM-bound: 30 GiB",
    });
    render(<WorkerLimitControl />);
    expect(screen.getByText(/changing either alone won't help/i)).toBeTruthy();
    expect(screen.queryByText(/Lowering agent_heap_mb/i)).toBeNull();
  });

  it("shows no machine warning when the hardware supports the configured value", () => {
    useSettingsStore.setState({ maxConcurrentWorkers: 4, effectiveMaxConcurrentWorkers: 8 });
    render(<WorkerLimitControl />);
    // Only the machine hint must be absent — the base "may run at once" hint always renders.
    expect(screen.queryByText(/so that's the limit in effect/i)).toBeNull();
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
    // Thumb clamps to the track end (default machineMax=20 < the floor, so the floor governs)…
    expect(slider().value).toBe(String(WORKER_LIMIT_SLIDER_FLOOR));
    // …but the readout shows the real (unbounded) value.
    expect(screen.getByText("999")).toBeTruthy();
  });

  it("reaches whatever this machine can actually run, past the floor (roborev 54816)", () => {
    // The reported bug: a hardcoded slider max (50) sat BELOW a measured machine's own derived
    // ceiling (81), so a single drag could silently pin an 81-capable machine below its own
    // capacity with no way back except hand-editing config.toml. The track must reach at least
    // what the machine can do.
    useSettingsStore.setState({
      maxConcurrentWorkers: 40,
      effectiveMaxConcurrentWorkers: 40,
      machineMaxConcurrentWorkers: 81,
    });
    render(<WorkerLimitControl />);
    expect(slider().max).toBe("81");
    fireEvent.change(slider(), { target: { value: "81" } });
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(81);
  });

  // roborev 55027 (High) / 55052 (Medium): drives the actual WRITE -> RE-HYDRATE cycle the ratchet
  // lived in, rather than restating the previous test's steady state. The first cut of the fix
  // derived the track from `effectiveMaxConcurrentWorkers`, which hydration clamps to the user's
  // pin — and since the slider WRITES that pin, each drag lowered the track for the next one: 81 →
  // 60 → 55 → …, with 81 unreachable forever. Only replaying the loop catches that; a single
  // snapshot cannot, which is why the first version of this test was byte-for-byte redundant with
  // its neighbour and could not fail independently.
  it("does NOT ratchet down across a drag → re-hydrate cycle", () => {
    // Start at AUTO on an 81-capable machine: no pin, so all three agree.
    useSettingsStore.setState({
      maxConcurrentWorkers: 81,
      effectiveMaxConcurrentWorkers: 81,
      machineMaxConcurrentWorkers: 81,
    });
    const { unmount } = render(<WorkerLimitControl />);
    expect(slider().max).toBe("81");
    fireEvent.change(slider(), { target: { value: "60" } });
    unmount();

    // What `hydrateFromConfig` produces once that pin lands: `effective = min(60, 81) = 60`, while
    // `machineMaxConcurrentWorkers` is untouched hardware. Under the broken derivation the track
    // would now read "60" and 81 would be gone for good.
    useSettingsStore.setState({
      maxConcurrentWorkers: 60,
      effectiveMaxConcurrentWorkers: 60,
      machineMaxConcurrentWorkers: 81,
    });
    render(<WorkerLimitControl />);
    expect(slider().max).toBe("81");
    // …and the machine's full range is still reachable, which is the whole point.
    fireEvent.change(slider(), { target: { value: "81" } });
    expect(useSettingsStore.getState().maxConcurrentWorkers).toBe(81);
  });

  it("still clamps the thumb rather than stretching the track for an extreme persisted value", () => {
    // sliderMax must NOT include `value` itself — otherwise an outlier (999, set by hand-editing
    // config.toml) would stretch the whole track to it, making a normal ~1..80 drag imperceptible.
    useSettingsStore.setState({
      maxConcurrentWorkers: 999,
      effectiveMaxConcurrentWorkers: 81,
      machineMaxConcurrentWorkers: 81,
    });
    render(<WorkerLimitControl />);
    expect(slider().max).toBe("81");
    expect(slider().value).toBe("81");
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
