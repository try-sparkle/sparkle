import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Bead } from "../services/beads";

// Mock the beads service so the store tests never touch Tauri/bd. We keep the real
// bucketBeads + isBeadsUnavailable (pure) but stub listBeads/ensureBeadsDb so we control
// success/failure and the auto-init self-heal path.
const listBeads = vi.fn();
const ensureBeadsDb = vi.fn();
vi.mock("../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beads")>();
  return {
    ...actual,
    listBeads: (...a: unknown[]) => listBeads(...a),
    ensureBeadsDb: (...a: unknown[]) => ensureBeadsDb(...a),
  };
});

import { bucketBeads } from "../services/beads";
import { useBeadsStore } from "./beadsStore";
import { useSettingsStore } from "./settingsStore";

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return { title: "", description: "", status: "open", labels: [], parent: null, ...partial };
}

beforeEach(() => {
  listBeads.mockReset();
  ensureBeadsDb.mockReset();
  ensureBeadsDb.mockResolvedValue("initialized");
  // Reset store snapshot state between cases.
  useBeadsStore.setState({ byProject: {}, loading: {}, error: {} });
});

afterEach(() => {
  // Make sure no interval leaks between cases.
  useBeadsStore.getState().stopPolling("p1");
  vi.useRealTimers();
  // Restore the tools gate so a case that flipped it off can't leak into the next test.
  useSettingsStore.setState({ beadsEnabled: true });
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

describe("auto-init self-heal (beads by default)", () => {
  // Distinct project ids per case so the module-scope one-shot `autoInitAttempted` guard can't
  // leak between cases.
  it("inits a beads DB then retries the list when bd reports no database found", async () => {
    // First list rejects with the recognized "no beads database found" error, retry succeeds.
    listBeads
      .mockRejectedValueOnce(new Error("Error: no beads database found"))
      .mockResolvedValueOnce([bead({ id: "a", status: "open" })]);

    await useBeadsStore.getState().refresh("heal1", "/proj");

    expect(ensureBeadsDb).toHaveBeenCalledWith("/proj");
    expect(listBeads).toHaveBeenCalledTimes(2); // initial (failed) + retry (ok)
    const snap = useBeadsStore.getState().byProject.heal1;
    expect(snap?.board.backlog.map((b) => b.id)).toEqual(["a"]);
    expect(useBeadsStore.getState().error.heal1).toBeUndefined();
    expect(useBeadsStore.getState().loading.heal1).toBe(false);
  });

  it("only attempts init once per project — a later 'no DB' does not re-init", async () => {
    listBeads.mockRejectedValue(new Error("no beads database found"));
    // ensureBeadsDb resolves, but the retried list ALSO fails (still no DB) — surfaces that error.
    await useBeadsStore.getState().refresh("heal2", "/proj");
    expect(ensureBeadsDb).toHaveBeenCalledTimes(1);
    expect(useBeadsStore.getState().error.heal2).toContain("no beads database found");

    // A second refresh must NOT try to init again (guard latched).
    await useBeadsStore.getState().refresh("heal2", "/proj");
    expect(ensureBeadsDb).toHaveBeenCalledTimes(1);
  });

  it("surfaces the init failure (not the original 'no DB' error) when bd init itself fails", async () => {
    listBeads.mockRejectedValue(new Error("no beads database found"));
    ensureBeadsDb.mockRejectedValueOnce(new Error("bd: command not found"));

    await useBeadsStore.getState().refresh("heal3", "/proj");

    expect(useBeadsStore.getState().error.heal3).toBe("bd: command not found");
    expect(useBeadsStore.getState().loading.heal3).toBe(false);
  });

  it("does NOT init for an unrelated bd failure (only the 'no DB' case self-heals)", async () => {
    listBeads.mockRejectedValue(new Error("bd crashed: some other failure"));

    await useBeadsStore.getState().refresh("heal4", "/proj");

    expect(ensureBeadsDb).not.toHaveBeenCalled();
    expect(useBeadsStore.getState().error.heal4).toBe("bd crashed: some other failure");
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

describe("tools gate — [tools].beads off means off", () => {
  it("refresh never shells out to bd and clears any prior snapshot when disabled", async () => {
    // Seed a stale snapshot (a real bucketed board), then disable Beads and refresh: no bd call,
    // snapshot dropped.
    const staleBeads = [bead({ id: "old" })];
    useBeadsStore.setState({
      byProject: { p1: { beads: staleBeads, board: bucketBeads(staleBeads), loadedAt: 1 } },
    });
    useSettingsStore.setState({ beadsEnabled: false });

    await useBeadsStore.getState().refresh("p1", "/proj");

    expect(listBeads).not.toHaveBeenCalled();
    expect(useBeadsStore.getState().byProject.p1).toBeUndefined();
    expect(useBeadsStore.getState().loading.p1).toBe(false);
  });

  it("startPolling arms no timer and runs no bd call when disabled", () => {
    vi.useFakeTimers();
    useSettingsStore.setState({ beadsEnabled: false });

    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    // No immediate call...
    expect(listBeads).not.toHaveBeenCalled();
    // ...and no interval was armed, so advancing time triggers nothing either.
    vi.advanceTimersByTime(20_000);
    expect(listBeads).not.toHaveBeenCalled();
  });
});
