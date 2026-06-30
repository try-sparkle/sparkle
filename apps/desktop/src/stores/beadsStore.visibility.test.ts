// @vitest-environment jsdom
//
// Visibility-gating for the beads poller: a backgrounded Tasks tab must NOT spawn `bd` every
// interval, but the board must re-sync the moment the window is shown again. These need a real
// `document` (visibilityState + visibilitychange), so this file opts into jsdom; the rest of the
// beadsStore suite stays under node.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Bead } from "../services/beads";

const listBeads = vi.fn();
vi.mock("../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beads")>();
  return { ...actual, listBeads: (...a: unknown[]) => listBeads(...a) };
});

import { useBeadsStore } from "./beadsStore";

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return { title: "", description: "", status: "open", labels: [], parent: null, ...partial };
}

// jsdom's visibilityState is read-only; override the getter so we can drive it from a test.
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  listBeads.mockReset();
  listBeads.mockResolvedValue([bead({ id: "a" })]);
  useBeadsStore.setState({ byProject: {}, loading: {}, error: {} });
  setVisibility("visible");
});

afterEach(() => {
  useBeadsStore.getState().stopPolling("p1");
  setVisibility("visible");
  vi.useRealTimers();
});

describe("beadsStore visibility gating", () => {
  it("skips the bd spawn on interval ticks while the window is hidden", async () => {
    vi.useFakeTimers();
    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    // immediate refresh on start (window visible)
    expect(listBeads).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    // Two hidden ticks fired but neither spawned bd — still just the initial call.
    expect(listBeads).toHaveBeenCalledTimes(1);
  });

  it("re-syncs immediately when the window becomes visible again", async () => {
    vi.useFakeTimers();
    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    expect(listBeads).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5000); // skipped tick arms the one-shot listener
    expect(listBeads).toHaveBeenCalledTimes(1);

    setVisibility("visible"); // becoming visible triggers an immediate refresh
    await vi.advanceTimersByTimeAsync(0);
    expect(listBeads).toHaveBeenCalledTimes(2);

    // The listener is one-shot: a later hidden→visible flap does NOT double-refresh on its own
    // (only the next visible interval tick would).
    setVisibility("hidden");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(listBeads).toHaveBeenCalledTimes(2);
  });

  it("keeps polling normally while the window stays visible", async () => {
    vi.useFakeTimers();
    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    expect(listBeads).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(listBeads).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(listBeads).toHaveBeenCalledTimes(3);
  });

  it("stopPolling removes the armed visibility listener so it can't fire after teardown", async () => {
    vi.useFakeTimers();
    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(5000); // arms the listener
    expect(listBeads).toHaveBeenCalledTimes(1);

    useBeadsStore.getState().stopPolling("p1");
    setVisibility("visible"); // listener was torn down → no refresh
    await vi.advanceTimersByTimeAsync(0);
    expect(listBeads).toHaveBeenCalledTimes(1);
  });
});
