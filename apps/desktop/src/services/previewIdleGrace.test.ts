// @vitest-environment jsdom
//
// `reconcilePreviewIdleGrace` arms a stop timer for every LIVE preview and, when that timer comes
// up, stops the server ONLY if nothing has touched the preview inside `[preview] idle_grace_min`.
//
// ══ WHAT THESE ROWS ARE PINNING, AND WHY THE OLD ONES COULD NOT ═════════════════════════════════
// This suite used to assert a VISIBILITY clock: not-on-screen armed a timer, on-screen cancelled
// it. When the preview pane became a concierge card (2026-08-19) "on screen" became permanently
// true for every healthy `ready`/`serving` preview — so the timer never armed for exactly the case
// the grace window exists for, and this suite asserted that as correct behaviour. Bead
// `sparkle-9yck3i`. The clock is now idle-since-last-ACTIVITY, and the two rows that matter are a
// PAIR:
//
//   • no activity for the window  -> `stopPreviewForAgent` IS called   (the bug, fixed)
//   • one touch inside the window -> it is NOT called at that deadline (the fix, bounded)
//
// Either alone is half the evidence: the first passes for a clock that stops everything on a fixed
// timer, the second for a clock that never stops anything at all.
//
// EVERY ROW DRIVES THE STORE THROUGH `setPreview`, not through a hand-built entry, because
// `lastActivityAt` is written BY that setter — including on the unchanged-value bail path, which is
// the whole mechanism under test. A fixture carrying the field would be asserting against itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PARTIAL MOCK — only the one function that talks to Rust, so the module's own call site is the one
// under test. `isLoopbackPreviewUrl` and the rest stay REAL.
vi.mock("./preview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./preview")>()),
  stopPreviewForAgent: vi.fn().mockResolvedValue(null),
}));

import { stopPreviewForAgent } from "./preview";
import {
  reconcilePreviewIdleGrace,
  resetPreviewIdleGraceStateForTests,
  setPreviewIdleGraceClockForTests,
  setPreviewIdleGraceMinutesForTests,
  startPreviewIdleGraceWatcher,
} from "./previewIdleGrace";
import { notePreviewActivity, usePreviewStore, type PreviewUpdate } from "../stores/previewStore";
import { useProjectStore } from "../stores/projectStore";

const MIN = 60_000;
const GRACE = 10 * MIN;

/** A healthy preview: `serving`, on a loopback url — the case that used to be immortal. */
const SERVING: PreviewUpdate = {
  id: "srv1",
  status: "serving",
  url: "http://127.0.0.1:5199",
  port: 5199,
  error: null,
};

/** Seed through the PRODUCTION setter, which is what stamps `lastActivityAt`. */
function seed(agentId: string, patch: Partial<PreviewUpdate> = {}): void {
  usePreviewStore.getState().setPreview(agentId, { ...SERVING, ...patch });
}

/** The fleet the orphan rule resolves against. A preview whose agent is NOT here has no card and
 *  nobody who could touch it, so its clock ignores activity — see `idleSinceFor`. */
function seedRoster(...agentIds: string[]): void {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        agents: agentIds.map((id) => ({ id, name: `Agent ${id}` })),
      },
    ],
    selectedProjectId: "p1",
  } as never);
}

beforeEach(() => {
  // FAKE TIMERS FIRST, so `Date.now()` is faked before anything stamps a timestamp with it. The
  // store's clock and this module's clock are the same faked `Date.now()` — controlling only one of
  // a coupled pair is how an idle window silently becomes the wrong length.
  vi.useFakeTimers();
  resetPreviewIdleGraceStateForTests();
  setPreviewIdleGraceMinutesForTests(10);
  usePreviewStore.setState({ byAgent: {}, capability: {} } as never);
  seedRoster("ag1", "ag2");
  // RESET AND RE-DEFAULT, not `mockClear` (roborev 65694). The file-scope mock's
  // `mockResolvedValue(null)` is established ONCE; a test that calls `mockReset()` discards it for
  // the rest of the file. That was harmless while the call site was a bare `void stop(...)`, but
  // the production path now chains `.catch(...).then(...)`, so the next test to reach the deadline
  // would throw `Cannot read properties of undefined (reading 'catch')` from inside a timer
  // callback — a failure surfacing nowhere near its cause. Re-establishing the default here makes
  // every test start from a known thenable regardless of what its predecessors did.
  vi.mocked(stopPreviewForAgent).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconcilePreviewIdleGrace — the idle clock", () => {
  it("does nothing for an agent with no preview entry", () => {
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(60 * MIN);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
  });

  // ══ THE BUG, FIXED ════════════════════════════════════════════════════════════════════════════
  // A `serving` preview on a loopback url whose agent the fleet can name — i.e. one whose card is
  // on screen right now. Under the visibility clock this was reported visible forever and NOTHING
  // ever stopped it; `config.rs` meanwhile documented `idle_grace_min` as one of only three things
  // that stop a server. The assertion is the SIDE EFFECT: the stop actually happened.
  it("stops a HEALTHY serving preview after the grace window with no activity", () => {
    seed("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(GRACE - 1);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });

  it("stops a healthy READY preview too, not only `serving`", () => {
    seed("ag1", { status: "ready" });
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(GRACE);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });

  // ══ THE PAIRED ROW ════════════════════════════════════════════════════════════════════════════
  // Same setup, one touch at minute 5. The deadline the timer was armed with comes and goes without
  // a stop, and the server dies a full window after the TOUCH rather than after the arm — which is
  // what makes this an idle clock rather than a max-lifetime cap. Without this row the fix above is
  // satisfied by a timer that stops everything unconditionally.
  it("does NOT stop a preview touched inside the window, and re-arms from the touch", () => {
    seed("ag1");
    reconcilePreviewIdleGrace();

    vi.advanceTimersByTime(5 * MIN);
    expect(notePreviewActivity("ag1")).toBe(true);

    vi.advanceTimersByTime(5 * MIN); // the ORIGINAL deadline passes
    expect(stopPreviewForAgent).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * MIN - 1); // a full window after the touch, less a tick
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });

  // A REPEAT WIRE EVENT IS ACTIVITY, and this is the row that proves the store's bail no longer
  // eats it. `setPreview` returns the state by identity for an identical payload — deliberately, so
  // the card does not re-render — and the timestamp is nonetheless moved in place. Driven through
  // the real setter with a freshly-allocated identical object, which is what deserialization hands
  // production every time.
  it("counts a REPEAT `setPreview` with an identical payload as activity", () => {
    seed("ag1");
    reconcilePreviewIdleGrace();

    vi.advanceTimersByTime(9 * MIN);
    seed("ag1"); // identical payload -> the bail path

    vi.advanceTimersByTime(1 * MIN); // original deadline
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9 * MIN);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });

  // THE OTHER BRANCH OF THE SAME SETTER, and it is not covered by the row above: a CHANGED update
  // takes the allocating path, and `startedAt` is carried forward from the original entry. So an
  // implementation that stamps only on the bail leaves a live-to-live transition anchored to when
  // the preview first appeared — a preview that compiled at minute 9 of its window would be
  // reclaimed one minute later, in the middle of becoming useful.
  it("counts a live-to-live status CHANGE as activity, not just a repeat", () => {
    seed("ag1", { status: "listening" });
    reconcilePreviewIdleGrace();

    vi.advanceTimersByTime(9 * MIN);
    seed("ag1"); // listening -> serving: a real change, so the allocating path

    vi.advanceTimersByTime(1 * MIN); // the original deadline
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(9 * MIN);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });

  it("keeps re-arming for as long as something keeps touching it", () => {
    seed("ag1");
    reconcilePreviewIdleGrace();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(8 * MIN);
      notePreviewActivity("ag1");
    }
    vi.advanceTimersByTime(8 * MIN);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
    // …and it is still a bounded window, not an immortal server.
    vi.advanceTimersByTime(2 * MIN);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });

  it("arms for a preview that is still `installing` (roborev 63963)", () => {
    // `installing` was added to `preview.rs`'s `live_for_reattach` without a matching update to
    // `LIVE_STATES` once before. A preview waiting on `node_modules` (up to 300s on the Rust side)
    // was never counted as live, so it never entered the "worth timing" set at all.
    seed("ag1", { status: "installing", url: null, port: null });
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(GRACE - 1);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });

  it("cancels the timer once the entry is no longer live (it already stopped or failed)", () => {
    seed("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(5 * MIN);
    seed("ag1", { status: "stopped" });
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(60 * MIN);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
  });

  // A RECONCILE IS NOT A TOUCH. Store writes for OTHER agents wake this module constantly; if a
  // reconcile re-armed a pending timer, every one of them would push the deadline out and the
  // window would silently become unbounded again — the very shape of the bug being fixed.
  it("does not push the deadline out when an unrelated reconcile runs", () => {
    seed("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(9 * MIN);
    seed("ag2", { id: "srv2", port: 5200, url: "http://127.0.0.1:5200" });
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(1 * MIN);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
    expect(stopPreviewForAgent).toHaveBeenCalledTimes(1); // ag2 is 9 minutes younger
  });

  it("respects a configured idle_grace_min other than the default", () => {
    setPreviewIdleGraceMinutesForTests(1);
    seed("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(1 * MIN - 1);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });
});

// ══ THE ORPHAN RULE ═════════════════════════════════════════════════════════════════════════════
// The one narrowing carried over from the visibility clock rather than replaced by it. A preview
// whose agent the roster cannot name paints no card, so nobody can be looking at it and nobody can
// touch it — and a dev server still rebuilding for a worktree with no owner must not be able to
// hold itself alive by doing so.
describe("reconcilePreviewIdleGrace — an orphaned preview", () => {
  it("reclaims a live preview whose agent the fleet cannot name", () => {
    seedRoster("ag2"); // ag1 is serving; nothing in the fleet can name it
    seed("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(GRACE - 1);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });

  // THE ROW THAT MAKES THE ORPHAN RULE FALSIFIABLE. Activity saves a resolvable preview (asserted
  // above) and must NOT save this one — without this, "orphan" could be implemented as an ordinary
  // idle clock and nothing would notice.
  it("reclaims it even though something keeps touching it", () => {
    seedRoster("ag2");
    seed("ag1");
    reconcilePreviewIdleGrace();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(2 * MIN);
      notePreviewActivity("ag1");
    }
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });

  // THE REVERSE. An agent can come BACK — a roster refresh, a project re-added, a window that
  // reloaded before the fleet had answered — and the orphan verdict has to be reversible, or a
  // preview whose owner blinked out for one poll is dead 10 minutes later no matter who is using
  // it. This is the paired row for the two above: same orphaning, then un-orphaned, and the
  // ordinary activity clock takes over again.
  it("stops treating it as an orphan when its agent comes back", () => {
    seed("ag1");
    reconcilePreviewIdleGrace();

    vi.advanceTimersByTime(1 * MIN);
    seedRoster("ag2"); // ag1 leaves at minute 1
    reconcilePreviewIdleGrace();

    vi.advanceTimersByTime(1 * MIN);
    seedRoster("ag1", "ag2"); // …and is back at minute 2, well inside the window
    reconcilePreviewIdleGrace();

    // Touched every 2 minutes from here on. An entry still carrying its orphan stamp would ignore
    // every one of them and die at minute 11; an un-orphaned one rides the activity clock.
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(2 * MIN);
      notePreviewActivity("ag1");
    }
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
  });

  // The window starts when the agent LEAVES, not when the preview started. A preview that has been
  // serving happily for an hour and loses its agent gets the full grace period, exactly as it did
  // when losing a card was what armed the old timer.
  it("counts the window from when the agent LEFT, not from when the preview started", () => {
    seed("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(9 * MIN);
    notePreviewActivity("ag1"); // still owned, still wanted

    seedRoster("ag2"); // ag1 leaves the fleet at minute 9
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(GRACE - 1);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });
});

// ══ THE CLOCK SEAM ══════════════════════════════════════════════════════════════════════════════
// Every row above runs the PRODUCTION clock (`Date.now`, faked) — the repo's "defaulted seam every
// test injects" trap is a seam nothing exercises in its real form. This one row injects, and it
// exists to prove something no fake-timer row can: the fired timer's verdict comes from READING the
// clock, not from the delay it was armed with. Skew the clock behind the timer queue and the timer
// still fires on schedule — and must decline to stop, because by the clock the preview is not idle
// yet. Inline the `Date.now()` back into `onIdleDeadline` and this row goes red.
describe("the injectable clock", () => {
  it("decides at the deadline by READING the clock, not by the delay it was armed with", () => {
    let skewMs = 0;
    setPreviewIdleGraceClockForTests(() => Date.now() + skewMs);

    seed("ag1");
    reconcilePreviewIdleGrace();

    skewMs = -5 * MIN; // the clock now runs five minutes behind the timer queue
    vi.advanceTimersByTime(GRACE); // the armed delay elapses…
    expect(stopPreviewForAgent).not.toHaveBeenCalled(); // …and the clock says: not idle yet

    vi.advanceTimersByTime(5 * MIN);
    expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
  });
});

// ══ THE WATCHER'S SUBSCRIPTIONS ═════════════════════════════════════════════════════════════════
// `reconcilePreviewIdleGrace` is pure-ish and every row above calls it by hand, which cannot prove
// anything CALLS it in production.
describe("startPreviewIdleGraceWatcher", () => {
  it("reclaims a healthy preview with no hand-driven reconcile at all", () => {
    seedRoster("ag1");
    const stop = startPreviewIdleGraceWatcher();
    try {
      seed("ag1"); // the ONLY trigger: a preview store write, exactly as `applyPreviewStatus` makes
      vi.advanceTimersByTime(GRACE - 1);
      expect(stopPreviewForAgent).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
    } finally {
      stop();
    }
  });

  it("reconciles when the FLEET changes, not only when a preview does", () => {
    seedRoster("ag1");
    seed("ag1");
    const stop = startPreviewIdleGraceWatcher();
    try {
      // Premise: owned, and touched often enough that the idle clock alone would never fire.
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(2 * MIN);
        notePreviewActivity("ag1");
      }
      expect(stopPreviewForAgent).not.toHaveBeenCalled();

      // ONE WRITE, TO THE PROJECT STORE ONLY — the preview is untouched and still serving. Without
      // the projectStore subscription nothing would wake, the orphan clock would never start, and
      // the touches above would keep this server alive indefinitely.
      seedRoster("ag2");
      vi.advanceTimersByTime(GRACE);
      expect(stopPreviewForAgent).toHaveBeenCalledWith("ag1");
    } finally {
      stop();
    }
  });

  it("cancels every pending timer when the watcher is torn down", () => {
    seedRoster("ag1");
    const stop = startPreviewIdleGraceWatcher();
    seed("ag1");
    stop();
    vi.advanceTimersByTime(60 * MIN);
    expect(stopPreviewForAgent).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE STOP IS IN FLIGHT FOR A WHILE, AND THE ENTRY STAYS LIVE THE WHOLE TIME — roborev 65675
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// `onIdleDeadline` deletes its handle and fires the stop, but the store entry stays `serving` until
// the IPC resolves and `clearPreview` runs. Any preview-store write during that await reconciles —
// and a second live preview emitting `preview:state` is the ORDINARY case, not a contrived one. A
// reconcile that saw a live entry with no pending timer armed one whose delay was already expired
// and stopped the same agent twice.
describe("previewIdleGrace — a stop in flight is not re-stopped", () => {
  it("does not issue a second stop when another preview's event reconciles mid-flight", async () => {
    // A stop that never settles, so the whole test runs inside the window the bug lives in.
    vi.mocked(stopPreviewForAgent).mockReset().mockReturnValue(new Promise(() => {}));
    seed("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(GRACE);
    expect(stopPreviewForAgent).toHaveBeenCalledTimes(1);

    // The second agent arrives — exactly what a live fleet does — and reconciles while ag1's stop
    // is still in flight and its entry still reads live.
    seed("ag2");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(0);

    expect(vi.mocked(stopPreviewForAgent).mock.calls.filter((c) => c[0] === "ag1")).toHaveLength(1);
  });

  it("re-arms rather than leaking when the stop REJECTS", async () => {
    // Without a `.catch` a rejected stop is an unhandled rejection AND leaves a live entry with no
    // pending timer, so nothing re-times that preview until some unrelated store write happens to
    // reconcile it — the grace period silently stops applying to that one preview.
    vi.mocked(stopPreviewForAgent).mockReset().mockRejectedValue(new Error("ipc down"));
    seed("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(GRACE);
    expect(stopPreviewForAgent).toHaveBeenCalledTimes(1);

    // Let the rejection settle so the catch arm runs and re-arms a full window.
    await vi.runAllTicks?.();
    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(GRACE);
    expect(vi.mocked(stopPreviewForAgent).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// A SETTLE FROM A TORN-DOWN WORLD IS INERT, IN BOTH ARMS — roborev 65694 + 65701
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// A stop's promise outlives teardown. Its settle then lands in a module whose maps have been
// cleared and possibly repopulated, and the first version of this guard checked only the `.catch`
// arm — so a stale `.then` could delete a LIVE stop's entry and reopen the double-stop it was
// added to prevent. Both arms compare a per-stop token now, and both directions are pinned here:
// asymmetric guards are exactly what decays.
describe("previewIdleGrace — a stop that settles after teardown changes nothing", () => {
  it("does not arm a timer in a watcher that was torn down", () => {
    let reject!: (e: unknown) => void;
    vi.mocked(stopPreviewForAgent)
      .mockReset()
      .mockReturnValue(new Promise((_res, rej) => {
        reject = rej;
      }));
    seed("ag1");
    reconcilePreviewIdleGrace();
    vi.advanceTimersByTime(GRACE);
    expect(stopPreviewForAgent).toHaveBeenCalledTimes(1);

    // The world goes away while the stop is still in flight.
    resetPreviewIdleGraceStateForTests();
    setPreviewIdleGraceMinutesForTests(GRACE / MIN);
    vi.mocked(stopPreviewForAgent).mockReset().mockResolvedValue(null);

    // …and only then does the old stop fail.
    reject(new Error("ipc down"));
    return Promise.resolve()
      .then(() => Promise.resolve())
      .then(() => {
        // Nothing may have been armed by that late settle. Advancing well past a full window is the
        // assertion: a resurrected timer would fire and stop an agent this world never seeded.
        vi.advanceTimersByTime(GRACE * 3);
        expect(stopPreviewForAgent).not.toHaveBeenCalled();
      });
  });
});
