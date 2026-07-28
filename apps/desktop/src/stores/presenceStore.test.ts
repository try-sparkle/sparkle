import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_AWAY_MS,
  PRESENCE_PIN_STORAGE_KEY,
  PRESENCE_TICK_MS,
  resolveMode,
  startPresenceTracking,
  usePresenceStore,
  type PresenceFacts,
} from "./presenceStore";

// The store reaches the outside world through exactly these two, so the whole tracker is testable
// without Tauri. `helper.ts` already no-ops outside Tauri, but a real no-op gives no way to DRIVE a
// blur — and blur is the signal under test.
const frontmostListeners: Array<(f: boolean) => void> = [];
let frontmostSeed: boolean | null = true;
vi.mock("../services/helper", () => ({
  getFrontmost: () => Promise.resolve(frontmostSeed),
  onFrontmostChanged: (cb: (f: boolean) => void) => {
    frontmostListeners.push(cb);
    return Promise.resolve(() => {
      const i = frontmostListeners.indexOf(cb);
      if (i >= 0) frontmostListeners.splice(i, 1);
    });
  },
}));

const emitFrontmost = (f: boolean) => frontmostListeners.forEach((cb) => cb(f));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
  frontmostListeners.length = 0;
  frontmostSeed = true;
  // The pin outlives the process now (see the persistence block below), so a leftover key would
  // leak a pin into the next case. `reset()` deliberately does NOT clear storage — that is what
  // makes "relaunch with the pin still set" expressible below.
  localStorage.clear();
  usePresenceStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

const facts = (over: Partial<PresenceFacts> = {}): PresenceFacts => ({
  focused: true,
  pinnedHere: false,
  manualAway: false,
  lastInputAt: Date.now(),
  ...over,
});

describe("resolveMode — the rule, as a pure function", () => {
  it("a focused window with recent input is Here", () => {
    expect(resolveMode(facts(), Date.now())).toBe("here");
  });

  it("blur is Away immediately, with no idle grace at all", () => {
    // Same instant as the input — the point is that focus alone decides, not elapsed time.
    expect(resolveMode(facts({ focused: false }), Date.now())).toBe("away");
  });

  it("focused but idle past the threshold is Away", () => {
    const t0 = Date.now();
    expect(resolveMode(facts({ lastInputAt: t0 }), t0 + IDLE_AWAY_MS)).toBe("away");
    // One millisecond short is still Here — the threshold is a deadline, not a window.
    expect(resolveMode(facts({ lastInputAt: t0 }), t0 + IDLE_AWAY_MS - 1)).toBe("here");
  });

  it("the pin beats the idle clock", () => {
    const t0 = Date.now();
    expect(resolveMode(facts({ pinnedHere: true, lastInputAt: t0 }), t0 + IDLE_AWAY_MS * 10)).toBe(
      "here",
    );
  });

  // FOUNDER OVERRIDE (design §1 decision 2, 2026-07-27). This assertion is the reverse of the one
  // it replaces ("blur beats the pin") — deliberately. A pin the machine can revoke is not a pin.
  it("the pin beats BLUR too — app-switch cannot revoke it", () => {
    expect(resolveMode(facts({ pinnedHere: true, focused: false }), Date.now())).toBe("here");
  });

  it("the pin beats blur AND the idle clock together — a screen lock overnight is still Here", () => {
    const t0 = Date.now();
    expect(
      resolveMode(
        facts({ pinnedHere: true, focused: false, lastInputAt: t0 }),
        t0 + 14 * 60 * 60 * 1000,
      ),
    ).toBe("here");
  });

  it("an explicit Away still wins, because it is the way OUT", () => {
    // The pin has to be escapable or it is a trap. `setAway` drops the pin (asserted below), so
    // this combination is unreachable through the store — the ordering is asserted anyway, because
    // "unreachable today" is not a property a future edit preserves for free.
    expect(resolveMode(facts({ pinnedHere: true, manualAway: true }), Date.now())).toBe("away");
  });

  it("a manual Away is not undone by typing", () => {
    expect(resolveMode(facts({ manualAway: true }), Date.now())).toBe("away");
  });
});

describe("presenceStore transitions", () => {
  it("blur → Away, and refocus → Here", () => {
    const s = usePresenceStore.getState();
    s.setFocused(false);
    expect(usePresenceStore.getState().mode).toBe("away");
    usePresenceStore.getState().setFocused(true);
    expect(usePresenceStore.getState().mode).toBe("here");
  });

  it("five minutes idle while focused → Away", () => {
    expect(usePresenceStore.getState().mode).toBe("here");
    vi.advanceTimersByTime(IDLE_AWAY_MS);
    usePresenceStore.getState().evaluate();
    expect(usePresenceStore.getState().mode).toBe("away");
  });

  it("input resets the idle timer", () => {
    // Four minutes in, type: the deadline moves, so the original five-minute mark passes as Here.
    vi.advanceTimersByTime(IDLE_AWAY_MS - 60_000);
    usePresenceStore.getState().noteInput();
    vi.advanceTimersByTime(60_000);
    usePresenceStore.getState().evaluate();
    expect(usePresenceStore.getState().mode).toBe("here");
    // And it still goes Away once the NEW deadline passes — the timer was reset, not disabled.
    vi.advanceTimersByTime(IDLE_AWAY_MS);
    usePresenceStore.getState().evaluate();
    expect(usePresenceStore.getState().mode).toBe("away");
  });

  it("a pin survives the idle timer indefinitely", () => {
    usePresenceStore.getState().setHere();
    vi.advanceTimersByTime(IDLE_AWAY_MS * 4);
    usePresenceStore.getState().evaluate();
    expect(usePresenceStore.getState().mode).toBe("here");
  });

  // ── FOUNDER OVERRIDE (design §1 decision 2) ────────────────────────────────────────────────
  // The pin is now absolute. These four are the override's contract; the pair they replace
  // asserted the opposite ("blur overrides the pin, and refocus restores it").
  it("a pinned Here survives a BLUR — the app-switch cannot move it", () => {
    usePresenceStore.getState().setHere();
    usePresenceStore.getState().setFocused(false);
    expect(usePresenceStore.getState().mode).toBe("here");
    expect(usePresenceStore.getState().pinnedHere).toBe(true);
  });

  it("a pinned Here survives an IDLE-TIMER expiry, blurred, overnight", () => {
    usePresenceStore.getState().setHere();
    usePresenceStore.getState().setFocused(false);
    // Fourteen hours: the machine slept, the screen locked, the idle deadline passed long ago.
    vi.advanceTimersByTime(14 * 60 * 60 * 1000);
    usePresenceStore.getState().evaluate();
    expect(usePresenceStore.getState().mode).toBe("here");
  });

  it("UNPINNING restores ordinary transitions — the blur that was ignored now applies", () => {
    usePresenceStore.getState().setHere();
    usePresenceStore.getState().setFocused(false);
    expect(usePresenceStore.getState().mode).toBe("here");
    // The manual unpin. Nothing else changed: still blurred, still idle.
    usePresenceStore.getState().togglePinnedHere();
    expect(usePresenceStore.getState().pinnedHere).toBe(false);
    expect(usePresenceStore.getState().mode).toBe("away");
    // And the idle clock is live again too, once focus comes back.
    usePresenceStore.getState().setFocused(true);
    expect(usePresenceStore.getState().mode).toBe("here");
    vi.advanceTimersByTime(IDLE_AWAY_MS);
    usePresenceStore.getState().evaluate();
    expect(usePresenceStore.getState().mode).toBe("away");
  });

  it("togglePinnedHere pins Here from Away, clearing an explicit Away", () => {
    usePresenceStore.getState().setAway();
    expect(usePresenceStore.getState().mode).toBe("away");
    usePresenceStore.getState().togglePinnedHere();
    expect(usePresenceStore.getState().pinnedHere).toBe(true);
    expect(usePresenceStore.getState().manualAway, "pinning is not half an Away").toBe(false);
    expect(usePresenceStore.getState().mode).toBe("here");
  });

  // ── THE PIN ROUND-TRIP (roborev 54146-M1) ──────────────────────────────────────────────────
  // The pin's two gestures (a fast double-tap on the button, two deliberate single taps) both end
  // with the pin exactly where it started, so they must leave PRESENCE where it started too.
  // Before this, pinning ON delegated to `setHere` — which also clears `manualAway` — while
  // pinning OFF only dropped the pin, so a user who had explicitly stepped Away came back to a
  // silently revoked Away with the pin unlit and nothing on screen saying so.
  it("a pin ON→OFF round-trip restores an explicit Away instead of silently revoking it", () => {
    usePresenceStore.getState().setAway();
    usePresenceStore.getState().togglePinnedHere();
    expect(usePresenceStore.getState().mode, "the pin overrides Away while it is ON").toBe("here");
    usePresenceStore.getState().togglePinnedHere();
    expect(usePresenceStore.getState().pinnedHere).toBe(false);
    expect(usePresenceStore.getState().manualAway, "the explicit Away comes back").toBe(true);
    expect(usePresenceStore.getState().mode).toBe("away");
  });

  it("an explicit HERE is not an override, so unpinning after it does NOT resurrect an old Away", () => {
    // The distinction the restore turns on: clicking the Here SEGMENT is the user saying "I am
    // here", which ends the Away for good; clicking the PIN from Away is a temporary override of
    // it. Only the second one unwinds.
    usePresenceStore.getState().setAway();
    usePresenceStore.getState().setHere();
    usePresenceStore.getState().togglePinnedHere();
    expect(usePresenceStore.getState().pinnedHere).toBe(false);
    expect(usePresenceStore.getState().manualAway).toBe(false);
    expect(usePresenceStore.getState().mode).toBe("here");
  });

  it("a fresh explicit Away taken DURING a pin is not undone by the later unpin", () => {
    // `setAway` drops the pin and is itself the newest explicit choice, so the pre-pin memory it
    // would otherwise restore has to be discarded with it.
    usePresenceStore.getState().togglePinnedHere();
    usePresenceStore.getState().setAway();
    usePresenceStore.getState().togglePinnedHere(); // pin back ON from Away
    usePresenceStore.getState().togglePinnedHere(); // …and OFF again
    expect(usePresenceStore.getState().manualAway).toBe(true);
    expect(usePresenceStore.getState().mode).toBe("away");
  });

  it("choosing Away is the OTHER way out of a pin", () => {
    // The pin outranks blur and the clock, so an explicit Away has to remain able to break it or
    // the control is a trap.
    usePresenceStore.getState().setHere();
    usePresenceStore.getState().setAway();
    expect(usePresenceStore.getState().pinnedHere).toBe(false);
    expect(usePresenceStore.getState().mode).toBe("away");
  });

  it("choosing Away drops the pin and choosing Here takes it back", () => {
    usePresenceStore.getState().setHere();
    usePresenceStore.getState().setAway();
    expect(usePresenceStore.getState().mode).toBe("away");
    expect(usePresenceStore.getState().pinnedHere).toBe(false);
    // Typing does not overturn an explicit "I'm stepping out".
    usePresenceStore.getState().noteInput();
    expect(usePresenceStore.getState().mode).toBe("away");
    usePresenceStore.getState().setHere();
    expect(usePresenceStore.getState().mode).toBe("here");
  });

  it("mode is readable synchronously from non-React code", () => {
    // The dispatch gate on the sibling branch reads exactly this, off the hot path.
    usePresenceStore.getState().setAway();
    expect(usePresenceStore.getState().mode).toBe("away");
  });
});

describe("startPresenceTracking", () => {
  it("seeds from the backend and follows frontmost changes", async () => {
    frontmostSeed = false;
    const stop = startPresenceTracking();
    await vi.runOnlyPendingTimersAsync();
    expect(usePresenceStore.getState().mode).toBe("away");
    emitFrontmost(true);
    expect(usePresenceStore.getState().mode).toBe("here");
    stop();
  });

  it("leaves the optimistic seed alone when there is no frontmost signal (non-Tauri)", async () => {
    frontmostSeed = null;
    const stop = startPresenceTracking();
    await vi.runOnlyPendingTimersAsync();
    expect(usePresenceStore.getState().mode).toBe("here");
    stop();
  });

  it("the tick flips to Away once the idle deadline passes", async () => {
    const stop = startPresenceTracking();
    await vi.runOnlyPendingTimersAsync();
    expect(usePresenceStore.getState().mode).toBe("here");
    vi.advanceTimersByTime(IDLE_AWAY_MS + PRESENCE_TICK_MS);
    expect(usePresenceStore.getState().mode).toBe("away");
    stop();
  });

  it("a fast window switch does NOT flicker Away — the 120ms coalescing is upstream", async () => {
    const stop = startPresenceTracking();
    await vi.runOnlyPendingTimersAsync();
    // macOS emits the OLD window's resignKey before the NEW window's becomeKey. frontmost.rs defers
    // a loss by FOCUS_BLUR_COALESCE_MS and re-polls, so an internal switch never reaches us as a
    // `false` at all — this asserts we consume that contract rather than re-deriving it. If this
    // store ever grew its own debounce, the assertion below would still hold but the REAL blur
    // (which does arrive as `false`) would be delayed; that is covered by the seed test above.
    const before = usePresenceStore.getState().mode;
    vi.advanceTimersByTime(200); // a full coalescing window passes with no event
    expect(usePresenceStore.getState().mode).toBe(before);
    expect(usePresenceStore.getState().mode).toBe("here");
    stop();
  });

  it("rehydrates a pin that was left ON before the relaunch", async () => {
    // roborev 54146-M2. The tooltip promises "stays Here through app-switches, screen lock and
    // overnight, until you unpin"; an in-memory-only pin breaks that promise on the ONE transition
    // the user cannot see coming (restart, crash-relaunch, auto-update) and does it in the unsafe
    // direction — presence falls back to auto-Away and the concierge is free to act unattended.
    localStorage.setItem(PRESENCE_PIN_STORAGE_KEY, "1");
    frontmostSeed = false; // relaunched into the background: without the pin this is Away
    const stop = startPresenceTracking();
    await vi.runOnlyPendingTimersAsync();
    expect(usePresenceStore.getState().pinnedHere).toBe(true);
    expect(usePresenceStore.getState().mode).toBe("here");
    stop();
  });

  it("comes up unpinned when nothing was stored, and a live pin is what gets stored", async () => {
    const stop = startPresenceTracking();
    await vi.runOnlyPendingTimersAsync();
    expect(usePresenceStore.getState().pinnedHere).toBe(false);
    expect(localStorage.getItem(PRESENCE_PIN_STORAGE_KEY)).toBeNull();
    usePresenceStore.getState().togglePinnedHere();
    expect(localStorage.getItem(PRESENCE_PIN_STORAGE_KEY)).toBe("1");
    // …and taking it off takes it out of storage, so the NEXT launch is genuinely unpinned.
    usePresenceStore.getState().togglePinnedHere();
    expect(localStorage.getItem(PRESENCE_PIN_STORAGE_KEY)).toBeNull();
    // Choosing Away is the other way out of a pin, and it has to reach storage too.
    usePresenceStore.getState().setHere();
    expect(localStorage.getItem(PRESENCE_PIN_STORAGE_KEY)).toBe("1");
    usePresenceStore.getState().setAway();
    expect(localStorage.getItem(PRESENCE_PIN_STORAGE_KEY)).toBeNull();
    stop();
  });

  it("stops ticking and unsubscribes once every holder disposes", async () => {
    const stopA = startPresenceTracking();
    const stopB = startPresenceTracking();
    await vi.runOnlyPendingTimersAsync();
    // Ref-counted: one listener for two holders, and the first disposal keeps it alive.
    expect(frontmostListeners.length).toBe(1);
    stopA();
    expect(frontmostListeners.length).toBe(1);
    stopB();
    expect(frontmostListeners.length).toBe(0);
    // A double-disposal must not drive the refcount negative and re-arm nothing.
    stopB();
    expect(frontmostListeners.length).toBe(0);
  });
});
