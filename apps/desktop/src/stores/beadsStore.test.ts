import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Bead } from "../services/beads";

// Mock the beads service so the store tests never touch Tauri/bd. We keep the real
// bucketBeads (pure) but stub listBeads so we control success/failure.
const listBeads = vi.fn();
vi.mock("../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beads")>();
  return { ...actual, listBeads: (...a: unknown[]) => listBeads(...a) };
});

import { useBeadsStore } from "./beadsStore";

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return { title: "", description: "", status: "open", labels: [], parent: null, ...partial };
}

beforeEach(() => {
  listBeads.mockReset();
  // Reset store snapshot state between cases.
  useBeadsStore.setState({ byProject: {}, loading: {}, error: {} });
});

afterEach(() => {
  // Make sure no interval leaks between cases.
  useBeadsStore.getState().stopPolling("p1");
  vi.useRealTimers();
});

describe("refresh", () => {
  it("populates byProject + board and toggles loading", async () => {
    const beads = [bead({ id: "a", status: "open" }), bead({ id: "b", status: "in_progress" })];
    let resolveList: (v: Bead[]) => void = () => {};
    listBeads.mockReturnValue(new Promise<Bead[]>((r) => (resolveList = r)));

    const p = useBeadsStore.getState().refresh("p1", "/proj");
    // loading flips true synchronously before the promise settles
    expect(useBeadsStore.getState().loading.p1).toBe(true);

    resolveList(beads);
    await p;

    const snap = useBeadsStore.getState().byProject.p1;
    expect(snap?.beads).toEqual(beads);
    expect(snap?.board.backlog.map((b) => b.id)).toEqual(["a"]);
    expect(snap?.board.inProgress.map((b) => b.id)).toEqual(["b"]);
    expect(typeof snap?.loadedAt).toBe("number");
    expect(useBeadsStore.getState().loading.p1).toBe(false);
    expect(useBeadsStore.getState().error.p1).toBeUndefined();
  });

  it("swallows errors into error state without throwing, keeping loading false", async () => {
    listBeads.mockRejectedValue(new Error("bd blew up"));
    await expect(useBeadsStore.getState().refresh("p1", "/proj")).resolves.toBeUndefined();
    expect(useBeadsStore.getState().error.p1).toBe("bd blew up");
    expect(useBeadsStore.getState().loading.p1).toBe(false);
    expect(useBeadsStore.getState().byProject.p1).toBeUndefined();
  });

  it("clears a prior error on a subsequent successful refresh", async () => {
    listBeads.mockRejectedValueOnce(new Error("transient"));
    await useBeadsStore.getState().refresh("p1", "/proj");
    expect(useBeadsStore.getState().error.p1).toBe("transient");

    listBeads.mockResolvedValueOnce([bead({ id: "a" })]);
    await useBeadsStore.getState().refresh("p1", "/proj");
    expect(useBeadsStore.getState().error.p1).toBeUndefined();
    expect(useBeadsStore.getState().byProject.p1?.beads.map((b) => b.id)).toEqual(["a"]);
  });
});

describe("polling", () => {
  it("startPolling refreshes immediately then on each interval, and is idempotent", async () => {
    vi.useFakeTimers();
    listBeads.mockResolvedValue([bead({ id: "a" })]);

    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    // immediate refresh
    expect(listBeads).toHaveBeenCalledTimes(1);

    // a second start is a no-op (one timer per project)
    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    expect(listBeads).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(listBeads).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(listBeads).toHaveBeenCalledTimes(3);
  });

  it("stopPolling clears the timer so no further refreshes fire", async () => {
    vi.useFakeTimers();
    listBeads.mockResolvedValue([bead({ id: "a" })]);

    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    expect(listBeads).toHaveBeenCalledTimes(1);

    useBeadsStore.getState().stopPolling("p1");
    await vi.advanceTimersByTimeAsync(20000);
    expect(listBeads).toHaveBeenCalledTimes(1);

    // stopPolling again is harmless, and a fresh start works after stop
    useBeadsStore.getState().stopPolling("p1");
    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    expect(listBeads).toHaveBeenCalledTimes(2);
  });
});
