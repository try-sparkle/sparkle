import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IDLE_AWAY_MS,
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

  it("blur beats the pin", () => {
    expect(resolveMode(facts({ pinnedHere: true, focused: false }), Date.now())).toBe("away");
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

  it("blur overrides the pin, and refocus RESTORES it without re-asserting", () => {
    usePresenceStore.getState().setHere();
    // Idle past the threshold as well, so the restore can only come from the pin.
    vi.advanceTimersByTime(IDLE_AWAY_MS * 2);
    usePresenceStore.getState().setFocused(false);
    expect(usePresenceStore.getState().mode).toBe("away");
    // The pin itself is untouched — that is what makes the override transient.
    expect(usePresenceStore.getState().pinnedHere).toBe(true);
    usePresenceStore.getState().setFocused(true);
    expect(usePresenceStore.getState().mode).toBe("here");
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
