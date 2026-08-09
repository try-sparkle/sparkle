// Polling is REFERENCE-COUNTED: N viewers of one project each hold the poller up, and the timer
// stops only when the last of them lets go.
//
// ══ WHY THIS MATTERS, AND WHY IT IS A SEPARATE FILE ═════════════════════════════════════════════
// `startPolling` was always idempotent, so a second viewer's call was a no-op — but `stopPolling`
// unconditionally cleared the timer, so the FIRST viewer to unmount silently stopped polling for
// everyone still watching. Nothing errors; the board simply freezes on its last snapshot with no
// visible cause, which is the hardest kind of bug to attribute.
//
// That was already reachable before bead pills existed: a project can be shown in BOTH pairs, and
// two `BoardView`s on one project is exactly the two-viewer case. It became certain with
// `BeadPillHost`, which polls the selected project for as long as the concierge is mounted — i.e.
// always — so every board close would have killed the pills' liveness.
//
// The assertions below are about the SIDE EFFECT — whether `bd` is actually still being polled
// after a release — not about the counter, which is module-private and would be a precondition
// dressed up as a result.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const listBeads = vi.fn();
const blockedBeadIdsOrNull = vi.fn();
vi.mock("../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beads")>();
  return {
    ...actual,
    listBeads: (...a: unknown[]) => listBeads(...a),
    blockedBeadIdsOrNull: (...a: unknown[]) => blockedBeadIdsOrNull(...a),
  };
});

// The post-poll decompose watcher. It WRITES beads and reaches the AI gate, which is why whether it
// runs is a correctness question and not a performance one.
const runDecomposeWatcherForPoll = vi.fn();
vi.mock("../services/epicDecompose", () => ({
  runDecomposeWatcherForPoll: (...a: unknown[]) => runDecomposeWatcherForPoll(...a),
}));

import {
  useBeadsStore,
  BEADS_POLL_INTERVAL_MS,
  __resetBeadsRefreshInFlightForTest,
} from "./beadsStore";
import { useSettingsStore } from "./settingsStore";

/** How many times `bd list` has been asked for, i.e. how many polls actually happened. */
const polls = () => listBeads.mock.calls.length;

/** Advance one full poll interval.
 *
 * Awaits, and settles any in-flight refresh FIRST, because `refresh` now holds a per-project
 * concurrency-1 guard (see `refreshInFlight` in beadsStore.ts): a tick that fires while the prior
 * refresh is still awaiting `bd` is dropped. Real ticks are 5s apart and a scan settles in ms, so
 * the guard is long released before the next one; a synchronous `advanceTimersByTime` never flushes
 * that microtask, so it would leave the guard held and every tick after the first would be dropped.
 * `advanceTimersByTimeAsync(0)` flushes the pending refresh (releasing the guard) before the real
 * interval fires — modelling the real gap, not defeating the guard. */
async function tick() {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(BEADS_POLL_INTERVAL_MS);
}

beforeEach(() => {
  listBeads.mockReset();
  blockedBeadIdsOrNull.mockReset();
  runDecomposeWatcherForPoll.mockReset();
  listBeads.mockResolvedValue([]);
  blockedBeadIdsOrNull.mockResolvedValue(new Set());
  useBeadsStore.setState({ byProject: {}, loading: {}, error: {} });
  useSettingsStore.setState({ beadsEnabled: true });
  __resetBeadsRefreshInFlightForTest(); // teardown no longer clears the guard; reset it explicitly
  vi.useFakeTimers();
});

afterEach(() => {
  // Release any claim a case left open, so no interval leaks into the next one. Over-releasing is
  // deliberately safe (see the store's stopPolling), so calling this more often than needed is fine.
  const store = useBeadsStore.getState();
  for (let i = 0; i < 3; i++) {
    store.stopPolling("p1");
    store.stopPolling("p1", "passive");
    store.stopPolling("p2");
  }
  vi.useRealTimers();
});

describe("beadsStore — polling is reference counted", () => {
  it("polls on a cadence for a single viewer", async () => {
    useBeadsStore.getState().startPolling("p1", "/proj");
    expect(polls()).toBe(1); // the immediate refresh
    await tick();
    expect(polls()).toBe(2);
  });

  it("arms only ONE timer no matter how many viewers claim it", async () => {
    useBeadsStore.getState().startPolling("p1", "/proj");
    useBeadsStore.getState().startPolling("p1", "/proj");
    // Two immediate refreshes (one per claim), but a single interval — so one tick adds one poll,
    // not two. A second timer would double the `bd` spawn rate for the life of the app.
    const before = polls();
    await tick();
    expect(polls()).toBe(before + 1);
  });

  // THE REGRESSION. Before counting, this first release cleared the timer and the second viewer —
  // still mounted, still on screen — silently stopped receiving updates.
  it("keeps polling when one of two viewers goes away", async () => {
    useBeadsStore.getState().startPolling("p1", "/proj");
    useBeadsStore.getState().startPolling("p1", "/proj");
    useBeadsStore.getState().stopPolling("p1");
    const before = polls();
    await tick();
    expect(polls()).toBe(before + 1);
  });

  it("stops once the LAST viewer goes away", async () => {
    useBeadsStore.getState().startPolling("p1", "/proj");
    useBeadsStore.getState().startPolling("p1", "/proj");
    useBeadsStore.getState().stopPolling("p1");
    useBeadsStore.getState().stopPolling("p1");
    const before = polls();
    await tick();
    expect(polls()).toBe(before);
  });

  it("a single viewer's release still stops it", async () => {
    useBeadsStore.getState().startPolling("p1", "/proj");
    useBeadsStore.getState().stopPolling("p1");
    const before = polls();
    await tick();
    expect(polls()).toBe(before);
  });

  // An unmatched release — a viewer that never started because `[tools].beads` was off, or a
  // double-unmount — drives the count negative. Treating that as "still claimed" would leave a timer
  // nothing could ever stop, so the store tears down at zero OR BELOW and a later claim re-arms
  // cleanly rather than being swallowed by a negative balance.
  it("recovers from an unmatched release rather than wedging", async () => {
    useBeadsStore.getState().stopPolling("p1");
    useBeadsStore.getState().stopPolling("p1");
    useBeadsStore.getState().startPolling("p1", "/proj");
    const before = polls();
    await tick();
    expect(polls()).toBe(before + 1);
  });

  it("does not arm anything when beads are switched off", async () => {
    useSettingsStore.setState({ beadsEnabled: false });
    useBeadsStore.getState().startPolling("p1", "/proj");
    await tick();
    expect(polls()).toBe(0);
  });

  // ── THE CLAIM MUST BE SYMMETRIC WITH THE MOUNT ────────────────────────────────────────────────
  //
  // `beadsEnabled` is a RUNTIME setting. A viewer that mounted while beads were off used to take no
  // claim, so when the user switched them on and a board armed the timer, that first viewer's
  // unmount released a claim it never took and stopped the poller for the board still on screen —
  // the frozen-board bug, reintroduced through the disabled path (roborev 57655).
  it("a viewer that mounted while beads were OFF cannot release another viewer's claim", async () => {
    useSettingsStore.setState({ beadsEnabled: false });
    useBeadsStore.getState().startPolling("p1", "/proj"); // claims, arms nothing
    useSettingsStore.setState({ beadsEnabled: true });
    useBeadsStore.getState().startPolling("p1", "/proj"); // second viewer: claims AND arms

    // The first viewer goes away. The second is still mounted and must still be polling.
    useBeadsStore.getState().stopPolling("p1");
    const before = polls();
    await tick();
    expect(polls()).toBe(before + 1);
  });

  // ── THE DECOMPOSE WATCHER IS FOR BOARDS ONLY ──────────────────────────────────────────────────
  //
  // It writes beads and reaches the AI gate. `BeadPillHost` is mounted for the whole session, so a
  // board-kind claim from it would turn that into a permanent background process.
  describe("the post-poll decompose watcher", () => {
    it("runs for a board viewer", async () => {
      useBeadsStore.getState().startPolling("p1", "/proj", undefined, "board");
      await vi.advanceTimersByTimeAsync(0);
      expect(runDecomposeWatcherForPoll).toHaveBeenCalled();
    });

    it("does NOT run when only a passive viewer is watching", async () => {
      useBeadsStore.getState().startPolling("p1", "/proj", undefined, "passive");
      await vi.advanceTimersByTimeAsync(0);
      expect(polls()).toBe(1); // it IS polling — ids still resolve
      expect(runDecomposeWatcherForPoll).not.toHaveBeenCalled();
    });

    it("runs when a board joins a passive viewer", async () => {
      useBeadsStore.getState().startPolling("p1", "/proj", undefined, "passive");
      await vi.advanceTimersByTimeAsync(0);
      expect(runDecomposeWatcherForPoll).not.toHaveBeenCalled();
      useBeadsStore.getState().startPolling("p1", "/proj", undefined, "board");
      await vi.advanceTimersByTimeAsync(BEADS_POLL_INTERVAL_MS);
      expect(runDecomposeWatcherForPoll).toHaveBeenCalled();
    });

    // ASKED EVERY TICK, not captured when the timer was armed — the last board can close while a
    // passive viewer keeps the timer alive, and the watcher must stop from that moment.
    it("stops when the last board leaves but a passive viewer keeps polling", async () => {
      useBeadsStore.getState().startPolling("p1", "/proj", undefined, "passive");
      useBeadsStore.getState().startPolling("p1", "/proj", undefined, "board");
      await vi.advanceTimersByTimeAsync(BEADS_POLL_INTERVAL_MS);
      expect(runDecomposeWatcherForPoll).toHaveBeenCalled();

      useBeadsStore.getState().stopPolling("p1", "board");
      runDecomposeWatcherForPoll.mockReset();
      const before = polls();
      await vi.advanceTimersByTimeAsync(BEADS_POLL_INTERVAL_MS);
      expect(polls()).toBe(before + 1); // still polling for the passive viewer
      expect(runDecomposeWatcherForPoll).not.toHaveBeenCalled(); // but no longer decomposing
    });
  });

  it("counts each project separately", async () => {
    useBeadsStore.getState().startPolling("p1", "/proj");
    useBeadsStore.getState().startPolling("p2", "/other");
    useBeadsStore.getState().stopPolling("p2");
    const before = polls();
    await tick();
    // p1 still polls; p2 does not. One tick, one poll.
    expect(polls()).toBe(before + 1);
    useBeadsStore.getState().stopPolling("p1");
  });
});
