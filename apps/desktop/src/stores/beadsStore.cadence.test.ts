// The poll's COST, not its correctness: how often it launches a `bd` process and how many it
// launches per tick.
//
// ══ WHAT WAS WRONG ══════════════════════════════════════════════════════════════════════════════
// The board polled on a fixed 5s `setInterval` and fired `bd list` + `bd blocked` on every tick.
// Measured against the real ~4,000-bead store, that pair takes 4.5–6.5 s — LONGER than the interval
// that scheduled it — so the shared embedded-Dolt store was busy essentially 100% of the time and a
// user-initiated `bd update` queued behind the backlog until it hit the app's 30s ceiling. 44
// distinct `bd` processes were observed in one 30s window (18 `list`, 12 `blocked`).
//
// Two changes, one file of tests:
//   1. the cadence is DERIVED from how long each refresh actually took, to hold a duty-cycle budget;
//   2. `bd blocked` moved to its own much slower cadence, so most ticks spawn one process, not two.
//
// ══ EVERY ASSERTION HERE WOULD FAIL AGAINST THE OLD STORE ═══════════════════════════════════════
// The delay cases assert a value that is NOT 5000 and a RELATIONSHIP (slower refresh ⇒ longer wait)
// that a constant cannot satisfy. The blocked cases assert a call-count INEQUALITY that a per-tick
// query cannot satisfy, paired with the lane still being right on the ticks that skipped the query —
// because "ask less often" is only correct if the answer survives.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Bead } from "../services/beads";

const listBeads = vi.fn();
const blockedBeadIdsOrNull = vi.fn();
vi.mock("../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beads")>();
  return {
    ...actual, // real bucketBeads — the lane assertions must bucket for real
    listBeads: (...a: unknown[]) => listBeads(...a),
    blockedBeadIdsOrNull: (...a: unknown[]) => blockedBeadIdsOrNull(...a),
  };
});
vi.mock("../services/epicDecompose", () => ({ runDecomposeWatcherForPoll: vi.fn() }));

import {
  useBeadsStore,
  nextPollDelayMs,
  BEADS_POLL_INTERVAL_MS,
  BEADS_POLL_MIN_INTERVAL_MS,
  BEADS_POLL_MAX_INTERVAL_MS,
  BEADS_POLL_DUTY_FACTOR,
  BEADS_BLOCKED_REFRESH_MS,
  BEADS_STALE_REFRESH_MS,
  __resetBeadsRefreshInFlightForTest,
} from "./beadsStore";
import { useSettingsStore } from "./settingsStore";

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return { title: "", description: "", status: "open", labels: [], parent: null, ...partial };
}

/** How many `bd list` processes the poll has launched. */
const polls = () => listBeads.mock.calls.length;
/** How many `bd blocked` processes it has launched. */
const blockedQueries = () => blockedBeadIdsOrNull.mock.calls.length;

/** A `bd list` that takes exactly `ms` of (fake) wall clock, like a real scan under lock contention.
 *  Fake timers move `Date.now()`, which is what the scheduler measures. */
function listTaking(ms: number) {
  return () => new Promise<Bead[]>((resolve) => setTimeout(() => resolve([bead({ id: "a" })]), ms));
}

/**
 * Start polling and return the delay the scheduler actually waited before the NEXT `bd list`.
 *
 * Measured by walking the clock forward in small steps until a second `bd list` is launched —
 * i.e. read off the side effect (a subprocess spawn), not off any internal the store exposes.
 */
async function measureNextTickDelay(projectId: string, refreshMs: number): Promise<number> {
  listBeads.mockImplementation(listTaking(refreshMs));
  useBeadsStore.getState().startPolling(projectId, "/proj");
  await vi.advanceTimersByTimeAsync(refreshMs); // the immediate refresh settles; the chain arms
  const before = polls();
  const STEP = 100;
  for (let waited = STEP; waited <= BEADS_POLL_MAX_INTERVAL_MS * 2; waited += STEP) {
    await vi.advanceTimersByTimeAsync(STEP);
    if (polls() > before) return waited;
  }
  throw new Error(`no follow-up poll within ${BEADS_POLL_MAX_INTERVAL_MS * 2}ms`);
}

beforeEach(() => {
  listBeads.mockReset();
  blockedBeadIdsOrNull.mockReset();
  listBeads.mockResolvedValue([bead({ id: "a" })]);
  blockedBeadIdsOrNull.mockResolvedValue(new Set<string>());
  useBeadsStore.setState({ byProject: {}, loading: {}, error: {} });
  useSettingsStore.setState({ beadsEnabled: true });
  __resetBeadsRefreshInFlightForTest();
  vi.useFakeTimers();
});

afterEach(() => {
  const store = useBeadsStore.getState();
  for (const id of ["p1", "p2"]) for (let i = 0; i < 3; i++) store.stopPolling(id);
  vi.useRealTimers();
});

describe("the poll cadence is derived from measured refresh cost", () => {
  // THE HEADLINE. A 2s refresh must not be followed 5s later — that is the saturating schedule.
  it("waits DUTY_FACTOR × the measured refresh, not the old fixed interval", async () => {
    const delay = await measureNextTickDelay("p1", 2000);
    expect(delay).toBe(BEADS_POLL_DUTY_FACTOR * 2000); // 8000
    expect(delay).not.toBe(BEADS_POLL_INTERVAL_MS); // the constant that used to schedule this
  });

  // THE RELATIONSHIP, which is the part a constant can never satisfy: whatever the numbers, a
  // costlier store must be polled less often. Asserted independently of the exact factor.
  it("a SLOWER refresh produces a LONGER wait", async () => {
    const fast = await measureNextTickDelay("p1", 2000);
    useBeadsStore.getState().stopPolling("p1");
    __resetBeadsRefreshInFlightForTest();
    const slow = await measureNextTickDelay("p2", 4000);

    expect(slow).toBeGreaterThan(fast);
    // …and by the ratio of the costs, so the duty cycle itself is what is held constant.
    expect(slow / fast).toBe(2);
  });

  // ── THE CLAMPS ────────────────────────────────────────────────────────────────────────────────
  it("MIN binds: a very fast store is still not polled faster than the floor", async () => {
    const delay = await measureNextTickDelay("p1", 200);
    // Unclamped this would be 800ms — twelve `bd` processes a minute for a board no human reads
    // that fast. The floor is what stops the duty budget from being spent on nothing.
    expect(BEADS_POLL_DUTY_FACTOR * 200).toBeLessThan(BEADS_POLL_MIN_INTERVAL_MS); // the clamp is live
    expect(delay).toBe(BEADS_POLL_MIN_INTERVAL_MS);
  });

  it("MAX binds: a wedged store still gets polled rather than going silent", async () => {
    // 20s refresh ⇒ 80s derived, which the cap cuts to 60s. Without the cap a store that is merely
    // slow would drift toward never being read again, and a poll that never comes back can never
    // observe it recovering either.
    const delay = await measureNextTickDelay("p1", 20_000);
    expect(BEADS_POLL_DUTY_FACTOR * 20_000).toBeGreaterThan(BEADS_POLL_MAX_INTERVAL_MS); // clamp live
    expect(delay).toBe(BEADS_POLL_MAX_INTERVAL_MS);
  });

  it("nextPollDelayMs falls back to the floor for an unusable measurement", () => {
    // A clock that jumped backwards must not propagate a negative into the clamp.
    expect(nextPollDelayMs(-1)).toBe(BEADS_POLL_MIN_INTERVAL_MS);
    expect(nextPollDelayMs(Number.NaN)).toBe(BEADS_POLL_MIN_INTERVAL_MS);
  });

  // An explicit interval is a caller's decision and still wins — several suites pin their cadence
  // with it, and the fixed-grid `setInterval` is what the steal-recovery cases depend on.
  it("an explicit intervalMs overrides the derived schedule", async () => {
    listBeads.mockImplementation(listTaking(2000)); // would derive 8000
    useBeadsStore.getState().startPolling("p1", "/proj", 3000);
    await vi.advanceTimersByTimeAsync(2000);
    const before = polls();
    await vi.advanceTimersByTimeAsync(1000); // 3000 total since the tick fired
    expect(polls()).toBe(before + 1);
  });
});

describe("`bd blocked` is decoupled from the list poll", () => {
  it("is asked STRICTLY fewer times than `bd list` over a run of polls", async () => {
    blockedBeadIdsOrNull.mockResolvedValue(new Set(["a"]));
    useBeadsStore.getState().startPolling("p1", "/proj");
    // Six derived cadences at the floor = 30s of polling, well inside one blocked window.
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(BEADS_POLL_MIN_INTERVAL_MS);

    expect(polls()).toBeGreaterThan(1);
    expect(blockedQueries()).toBeLessThan(polls());
    // Concretely: one cold read, then cache. Every other tick is HALF the subprocesses it was.
    expect(blockedQueries()).toBe(1);
  });

  // "Ask less often" is only correct if the answer survives — a cheaper poll that empties the
  // Blocked lane has not saved anything, it has broken the board.
  it("keeps the blocked lane populated on the ticks that skipped the query", async () => {
    listBeads.mockResolvedValue([bead({ id: "a" })]);
    blockedBeadIdsOrNull.mockResolvedValue(new Set(["a"]));
    useBeadsStore.getState().startPolling("p1", "/proj");
    await vi.advanceTimersByTimeAsync(0);
    expect(useBeadsStore.getState().byProject.p1?.board.blocked.map((b) => b.id)).toEqual(["a"]);

    for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(BEADS_POLL_MIN_INTERVAL_MS);

    expect(blockedQueries()).toBe(1); // the later ticks really did skip it
    expect(useBeadsStore.getState().byProject.p1?.board.blocked.map((b) => b.id)).toEqual(["a"]);
    expect(useBeadsStore.getState().byProject.p1?.board.backlog).toEqual([]);
  });

  it("re-asks once the blocked window elapses", async () => {
    // The paired negative for the two cases above: caching is a delay, not a freeze.
    useBeadsStore.getState().startPolling("p1", "/proj");
    await vi.advanceTimersByTimeAsync(0);
    expect(blockedQueries()).toBe(1);

    await vi.advanceTimersByTimeAsync(BEADS_BLOCKED_REFRESH_MS);
    expect(blockedQueries()).toBeGreaterThan(1);
  });
});

describe("a failed blocked query never empties a populated lane", () => {
  it("keeps the last known blocked set when the query cannot answer", async () => {
    listBeads.mockResolvedValue([bead({ id: "a" })]);
    blockedBeadIdsOrNull.mockResolvedValueOnce(new Set(["a"]));
    await useBeadsStore.getState().refresh("p1", "/proj");
    expect(useBeadsStore.getState().byProject.p1?.board.blocked.map((b) => b.id)).toEqual(["a"]);

    // The window elapses, and this time `bd blocked` fails. `blockedBeadIdsOrNull` reports that as
    // null rather than collapsing it to an empty set — which is the whole reason it exists, because
    // an empty lane is indistinguishable from a healthy one and the board would silently lie.
    vi.advanceTimersByTime(BEADS_BLOCKED_REFRESH_MS);
    blockedBeadIdsOrNull.mockResolvedValueOnce(null);
    await useBeadsStore.getState().refresh("p1", "/proj");

    expect(blockedQueries()).toBe(2); // it really did re-ask and really did fail
    expect(useBeadsStore.getState().byProject.p1?.board.blocked.map((b) => b.id)).toEqual(["a"]);
  });

  it("PAIRED: a SUCCESSFUL empty answer does clear the lane", async () => {
    // Without this, "keep the old set" could be hard-wired and a bead that genuinely unblocked
    // would sit in the Blocked column forever.
    listBeads.mockResolvedValue([bead({ id: "a" })]);
    blockedBeadIdsOrNull.mockResolvedValueOnce(new Set(["a"]));
    await useBeadsStore.getState().refresh("p1", "/proj");
    expect(useBeadsStore.getState().byProject.p1?.board.blocked.map((b) => b.id)).toEqual(["a"]);

    vi.advanceTimersByTime(BEADS_BLOCKED_REFRESH_MS);
    blockedBeadIdsOrNull.mockResolvedValueOnce(new Set<string>());
    await useBeadsStore.getState().refresh("p1", "/proj");

    expect(useBeadsStore.getState().byProject.p1?.board.blocked).toEqual([]);
    expect(useBeadsStore.getState().byProject.p1?.board.backlog.map((b) => b.id)).toEqual(["a"]);
  });

  it("does not re-ask on every tick while the query keeps failing", async () => {
    // A failing `bd blocked` is still a `bd` process. Retrying it per tick would put back exactly
    // the load the decoupling removes, at the moment the store can least afford it.
    blockedBeadIdsOrNull.mockResolvedValue(null);
    useBeadsStore.getState().startPolling("p1", "/proj");
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(BEADS_POLL_MIN_INTERVAL_MS);

    expect(polls()).toBeGreaterThan(1);
    expect(blockedQueries()).toBe(1);
  });
});

describe("the self-scheduling chain is fully torn down and self-healing", () => {
  it("stopPolling leaves NOTHING armed", async () => {
    useBeadsStore.getState().startPolling("p1", "/proj");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1); // the chain is armed — so the zero below is not vacuous

    useBeadsStore.getState().stopPolling("p1");
    const before = polls();

    // LITERALLY nothing pending, not merely "nothing that polls". A no-op timer left behind is
    // still a handle that outlives the viewer, and it is exactly what a `setTimeout` chain leaks
    // where a `setInterval` could not — invisible to any assertion that only counts `bd` calls.
    expect(vi.getTimerCount()).toBe(0);

    // Well past the ceiling — a chain that re-armed itself once more would show up here.
    await vi.advanceTimersByTimeAsync(BEADS_POLL_MAX_INTERVAL_MS * 3);

    expect(polls()).toBe(before);
  });

  it("a viewer released mid-refresh arms nothing when that refresh lands", async () => {
    listBeads.mockImplementation(listTaking(2000));
    useBeadsStore.getState().startPolling("p1", "/proj");
    // Released while the first scan is still running. The watchdog is pending right now, and
    // teardown has to take that with it — the scan itself cannot be cancelled, but the timer
    // waiting on it can.
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    useBeadsStore.getState().stopPolling("p1");
    expect(vi.getTimerCount()).toBe(1); // only the mock scan's own timer survives

    await vi.advanceTimersByTimeAsync(2000); // it lands here — and must not schedule a successor
    const before = polls();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(BEADS_POLL_MAX_INTERVAL_MS * 2);

    expect(polls()).toBe(before);
  });

  // ── THE CHAIN MUST OUTLIVE A REFRESH THAT NEVER RETURNS ───────────────────────────────────────
  //
  // `bd` reads are unbounded, so a scan against a wedged store can hang forever. A chain that
  // simply awaited its own refresh would stop for good — and with it the only thing that fires the
  // stale-claim steal, which is how a wedged project recovers. The watchdog is what buys that back.
  it("keeps polling after a refresh that never settles, so the steal path still runs", async () => {
    listBeads.mockReturnValueOnce(new Promise<Bead[]>(() => {})); // hangs forever
    listBeads.mockResolvedValue([bead({ id: "a" })]);

    useBeadsStore.getState().startPolling("p1", "/proj");
    expect(polls()).toBe(1); // hung and latched

    // The chain gives up waiting at the steal window and re-arms at the floor, so the next tick
    // arrives while the claim is stealable and a second scan actually launches.
    await vi.advanceTimersByTimeAsync(BEADS_STALE_REFRESH_MS + BEADS_POLL_MIN_INTERVAL_MS);

    expect(polls()).toBe(2);
  });
});
