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

// The post-poll decompose watcher WRITES beads and spends AI, so whether a given scan runs it is a
// correctness question — a stolen-from (stale) scan must not. Spy on it to assert that.
const runDecomposeWatcherForPoll = vi.fn();
vi.mock("../services/epicDecompose", () => ({
  runDecomposeWatcherForPoll: (...a: unknown[]) => runDecomposeWatcherForPoll(...a),
}));

import { bucketBeads } from "../services/beads";
import { useBeadsStore, BEADS_STALE_REFRESH_MS, __resetBeadsRefreshInFlightForTest } from "./beadsStore";
import { useSettingsStore } from "./settingsStore";

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return {
    title: "",
    description: "",
    status: "open",
    labels: [],
    parent: null,
    commentCount: 0,
    ...partial,
  };
}

beforeEach(() => {
  listBeads.mockReset();
  ensureBeadsDb.mockReset();
  runDecomposeWatcherForPoll.mockReset();
  ensureBeadsDb.mockResolvedValue("initialized");
  // Reset store snapshot state between cases.
  useBeadsStore.setState({ byProject: {}, loading: {}, error: {} });
  // Clear the module-scope in-flight guard so a case that left a scan latched (e.g. the hand-held
  // resolver below, or the never-settling steal case) can't drop a later case's refresh for the
  // same project id.
  __resetBeadsRefreshInFlightForTest();
});

afterEach(() => {
  // Make sure no interval leaks between cases.
  //
  // RELEASED REPEATEDLY, because polling is REFERENCE-COUNTED (see beadsStore.refcount.test.ts): a
  // case that claims twice needs two releases, and a single one would leave the timer armed and the
  // NEXT case's `startPolling` taking the "already polling" early return — so its immediate refresh
  // never fires and it fails on an assertion that has nothing to do with what it is testing.
  // Over-releasing is deliberately safe (the store tears down at zero or below), so draining past
  // the actual count costs nothing.
  for (let i = 0; i < 3; i++) useBeadsStore.getState().stopPolling("p1");
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

    // A second start arms no SECOND timer (one timer per project) — but it is a second CLAIM on the
    // one that exists, and the immediate refresh is skipped along with it. The claim half is what
    // beadsStore.refcount.test.ts covers; here the point is only that the `bd` spawn rate does not
    // double when two viewers watch one project.
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

describe("in-flight guard — overlapping poll ticks coalesce to concurrency 1", () => {
  it("drops overlapping refreshes while one is in flight, then releases once it settles", async () => {
    vi.useFakeTimers();
    // First scan stays PENDING (simulates a slow bd list under lock contention that outruns the
    // 5s interval). We hold the resolver so we can decide exactly when it settles.
    let resolveFirst: (v: Bead[]) => void = () => {};
    const firstScan = new Promise<Bead[]>((r) => (resolveFirst = r));
    listBeads.mockReturnValueOnce(firstScan);
    // Every later call resolves immediately.
    listBeads.mockResolvedValue([bead({ id: "a" })]);

    // Immediate fire spawns exactly one scan; that scan is now pending.
    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    expect(listBeads).toHaveBeenCalledTimes(1);

    // Three more ticks fire while the first scan is still in flight. Each MUST be dropped — no new
    // `bd` subprocess. This is the side effect that proves the convoy can't form: the invocation
    // count stays at 1, it does not climb to 4.
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(listBeads).toHaveBeenCalledTimes(1);

    // The slow scan finishes and the guard releases.
    resolveFirst([bead({ id: "a" })]);
    await vi.advanceTimersByTimeAsync(0);

    // The NEXT tick is no longer blocked — a second scan now runs. Proves the guard released rather
    // than latching the project shut forever.
    await vi.advanceTimersByTimeAsync(5000);
    expect(listBeads).toHaveBeenCalledTimes(2);
  });

  it("a later tick steals a claim older than the staleness window so a wedged project recovers", async () => {
    vi.useFakeTimers();
    // First scan HANGS forever — models `bd` blocked on the wedged store's lock (run_bd has no
    // timeout), so the guard's `finally` never runs and the id stays latched.
    listBeads.mockReturnValueOnce(new Promise<Bead[]>(() => {}));
    listBeads.mockResolvedValue([bead({ id: "a" })]);

    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    expect(listBeads).toHaveBeenCalledTimes(1); // immediate scan, now hung + latched

    // Ticks WITHIN the staleness window are dropped — no convoy forms while the scan may still be
    // legitimately (if slowly) progressing.
    await vi.advanceTimersByTimeAsync(5000 * 3); // 15s < BEADS_STALE_REFRESH_MS (30s)
    expect(listBeads).toHaveBeenCalledTimes(1);

    // Advance to exactly the staleness threshold: the tick there sees an over-age claim, STEALS it,
    // and retries — recovery that does not depend on teardown, so it covers the permanently-claimed
    // selected project. Stop here: the stolen replacement resolves and normal polling resumes, so
    // advancing further would keep incrementing — the point is that the SECOND scan happened at all.
    await vi.advanceTimersByTimeAsync(BEADS_STALE_REFRESH_MS - 5000 * 3);
    expect(listBeads).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially between successive steals of a persistently hung project", async () => {
    vi.useFakeTimers();
    // Every scan hangs forever, so each steal just produces another hung, uncancellable scan. The
    // backoff is what stops that from spawning a fresh `bd` pair every 30s without bound.
    listBeads.mockReturnValue(new Promise<Bead[]>(() => {}));

    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    expect(listBeads).toHaveBeenCalledTimes(1); // scan 1, hung

    // First steal fires at 1× the window (30s): scan 2.
    await vi.advanceTimersByTimeAsync(BEADS_STALE_REFRESH_MS);
    expect(listBeads).toHaveBeenCalledTimes(2);

    // The window is now 2× (60s). Another 1× window is NOT enough to steal again — without backoff
    // this tick would steal at 30s and the count would already be 3.
    await vi.advanceTimersByTimeAsync(BEADS_STALE_REFRESH_MS);
    expect(listBeads).toHaveBeenCalledTimes(2);

    // Past the 2× window the next steal fires: scan 3.
    await vi.advanceTimersByTimeAsync(BEADS_STALE_REFRESH_MS);
    expect(listBeads).toHaveBeenCalledTimes(3);
  });

  it("an abandoned (stolen-from) scan that settles late does not free the successor's claim", async () => {
    vi.useFakeTimers();
    // Scan A hangs long enough to be stolen; we hold its resolver to settle it LATE, after a
    // successor scan B has taken the claim. B stays pending so the guard is held by B.
    let resolveA: (v: Bead[]) => void = () => {};
    const scanA = new Promise<Bead[]>((r) => (resolveA = r));
    const scanB = new Promise<Bead[]>(() => {}); // B: pending, never settles during the test
    listBeads.mockReturnValueOnce(scanA).mockReturnValueOnce(scanB).mockResolvedValue([bead({ id: "a" })]);

    useBeadsStore.getState().startPolling("p1", "/proj", 5000);
    expect(listBeads).toHaveBeenCalledTimes(1); // A in flight

    // Age A past the window, then a tick steals the claim and starts B (call 2).
    await vi.advanceTimersByTimeAsync(BEADS_STALE_REFRESH_MS + 5000);
    expect(listBeads).toHaveBeenCalledTimes(2); // B now holds the claim

    // A finally settles with its STALE board — its tokenized `finally` must NOT delete B's claim
    // (that would re-open the convoy), and its gated `commit` must NOT write. B still holds the
    // claim and never settled, so the store must show B's state, not A's late one.
    resolveA([bead({ id: "old" })]);
    await vi.advanceTimersByTimeAsync(5000); // a tick fires within B's window
    expect(listBeads).toHaveBeenCalledTimes(2); // still just A + B — the tick was coalesced under B
    // The write-gate half of the token: A's stale snapshot never landed and loading was not flipped
    // false out from under B. Both go RED if the success-path `commit` is reverted to a bare `set`.
    expect(useBeadsStore.getState().byProject.p1).toBeUndefined();
    expect(useBeadsStore.getState().loading.p1).toBe(true);
    // ...and A's late settle did not run the AI/bead-writing decompose watcher on its stale board.
    expect(runDecomposeWatcherForPoll).not.toHaveBeenCalled();
  });

  it("a stolen-from scan does not run the decompose watcher, but the successor does", async () => {
    vi.useFakeTimers();
    let resolveA: (v: Bead[]) => void = () => {};
    const scanA = new Promise<Bead[]>((r) => (resolveA = r));
    let resolveB: (v: Bead[]) => void = () => {};
    const scanB = new Promise<Bead[]>((r) => (resolveB = r));
    // A (immediate) hangs and is stolen; B (the steal) completes; any later scan stays pending so no
    // scan C fires a third watcher.
    listBeads
      .mockReturnValueOnce(scanA)
      .mockReturnValueOnce(scanB)
      .mockReturnValue(new Promise<Bead[]>(() => {}));

    useBeadsStore.getState().startPolling("p1", "/proj", 5000);

    // Steal A once it ages past the window; B starts and holds the claim.
    await vi.advanceTimersByTimeAsync(BEADS_STALE_REFRESH_MS);
    expect(listBeads).toHaveBeenCalledTimes(2);

    // B completes — it owns the claim, so ITS watcher runs (exactly once).
    resolveB([bead({ id: "b" })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(runDecomposeWatcherForPoll).toHaveBeenCalledTimes(1);

    // A settles LATE with its stale board — its claim was stolen, so it must NOT run the watcher.
    // Without the `ownsClaim()` gate this fires a second decompose against a ≥30s-old board.
    resolveA([bead({ id: "old" })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(runDecomposeWatcherForPoll).toHaveBeenCalledTimes(1);
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
