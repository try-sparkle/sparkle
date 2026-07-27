// presenceStore — "is the user HERE, watching, or AWAY?" This is the SIGNAL only. Nothing in this
// file decides what the concierge may do with it; the dispatch gate and the send countdown that
// consume it live elsewhere (services/dispatchIntent, a sibling branch). Design:
// docs/superpowers/specs/2026-07-27-concierge-control-design.md §3 A2.
//
// WHY IT EXISTS. The concierge is gaining the ability to act on its own. "Away" tells it the user
// is not watching, so a destructive action must QUEUE rather than fire; "Here" means someone is at
// the keyboard to cancel. The agreed precedence rule is that presence OUTRANKS the countdown, so
// this store is read from non-React code on the dispatch path — hence a plain
// `usePresenceStore.getState().mode` read must be cheap, synchronous, and always current. It is:
// `mode` is stored (not derived at read time), recomputed eagerly on every event that can change it.
//
// THE TWO AUTO-AWAY SIGNALS, and why they are weighted so differently (locked decision 1):
//   • BLUR — the app is no longer frontmost → Away IMMEDIATELY. Strong signal: the user is
//     demonstrably looking at something else.
//   • IDLE — the window is focused but nothing has been typed for FIVE MINUTES → Away. Weak signal,
//     deliberately generous. A focused window usually means eyes on the screen, and the most common
//     focused-but-not-typing activity is READING TERMINAL OUTPUT — exactly the moment the user does
//     NOT want the concierge acting alone. A short idle timeout would unblock autonomy precisely
//     when it is least wanted.
//
// THE PIN, and the one subtlety worth reading twice (locked decision 2). Manually choosing Here
// PINS Here against the idle timer. Blur still wins — a pin that survived blur would leave the
// concierge unblocked-but-unwatched, the exact failure Away exists to prevent — but it wins only
// FOR THE DURATION OF THE BLUR. `pinnedHere` is NOT cleared on blur, so refocusing restores Here
// without the user having to re-assert it. That is why blur is a fact about the world (`focused`)
// rather than a mutation of the pin.
import { create } from "zustand";
import { getFrontmost, onFrontmostChanged } from "../services/helper";

export type PresenceMode = "here" | "away";

/** No input for this long, while focused, means Away. Five minutes — see the header. */
export const IDLE_AWAY_MS = 5 * 60 * 1000;

/** How often the idle deadline is re-checked. Polling rather than one long `setTimeout` per input:
 *  a timeout would have to be cleared and re-armed on every keystroke (and a machine that slept
 *  through its deadline would fire late by however long it slept), whereas a cheap wall-clock
 *  comparison on a coarse tick is correct across sleep/wake for free. 15s of granularity on a
 *  5-minute threshold is 5% — invisible, and it costs one comparison per tick. */
export const PRESENCE_TICK_MS = 15_000;

/** The facts a mode is computed FROM. Split out so the rule is testable without a store. */
export interface PresenceFacts {
  /** A real Sparkle window is frontmost (services/helper.onFrontmostChanged). */
  focused: boolean;
  /** The user manually chose Here — pins against the idle timer, but not against blur. */
  pinnedHere: boolean;
  /** The user manually chose Away — an explicit "I'm stepping out", which no amount of typing
   *  undoes. Only choosing Here clears it. See `setAway`. */
  manualAway: boolean;
  /** `Date.now()` of the last compose-box or terminal keystroke. */
  lastInputAt: number;
}

/**
 * The whole presence rule, as a pure function. Ordering IS the policy — read it top to bottom:
 *
 * 1. Not focused → Away. Unconditional, so it outranks both pins. This is the clause that makes a
 *    pin transient rather than permanent.
 * 2. Manually Away → Away. An explicit choice is not undone by activity; the user said they are
 *    stepping out, and typing one more line before they go does not change that.
 * 3. Pinned Here → Here, regardless of the idle clock. This is the pin's entire job.
 * 4. Otherwise the idle clock decides.
 */
export function resolveMode(facts: PresenceFacts, now: number): PresenceMode {
  if (!facts.focused) return "away";
  if (facts.manualAway) return "away";
  if (facts.pinnedHere) return "here";
  return now - facts.lastInputAt >= IDLE_AWAY_MS ? "away" : "here";
}

interface PresenceState extends PresenceFacts {
  /** The resolved answer. Stored, not derived on read, so non-React callers on the dispatch path
   *  get it from a plain `usePresenceStore.getState().mode` with no computation. */
  mode: PresenceMode;
  /** The user typed — in the compose box or straight into a terminal. Resets the idle clock. */
  noteInput: () => void;
  /** Frontmost changed. Already coalesced 120ms upstream in src-tauri/src/frontmost.rs, which is
   *  what keeps a window-to-window switch from flickering Away — see `startPresenceTracking`. */
  setFocused: (focused: boolean) => void;
  /** The user chose Here on the slider: pin it, and clear any manual Away. */
  setHere: () => void;
  /** The user chose Away on the slider: latch it, and drop the pin. */
  setAway: () => void;
  /** Re-resolve against the wall clock. Called by the tick; the only way the idle edge fires. */
  evaluate: () => void;
  /** Test seam: back to a fresh, focused, just-typed state. */
  reset: () => void;
}

function initialFacts(): PresenceFacts {
  return {
    // Optimistic seed. `startPresenceTracking` immediately corrects it from the real backend, and
    // outside Tauri (tests, plain-browser dev) there is no frontmost signal at all — starting at
    // `false` there would report a permanent, unrecoverable Away.
    focused: true,
    pinnedHere: false,
    manualAway: false,
    lastInputAt: Date.now(),
  };
}

export const usePresenceStore = create<PresenceState>((set, get) => {
  /** Apply a fact change and re-resolve in the same `set`, so `mode` is never observably stale. */
  const commit = (patch: Partial<PresenceFacts>) =>
    set((s) => {
      const facts: PresenceFacts = { ...s, ...patch };
      return { ...facts, mode: resolveMode(facts, Date.now()) };
    });

  return {
    ...initialFacts(),
    mode: "here",
    noteInput: () => commit({ lastInputAt: Date.now() }),
    setFocused: (focused) => commit({ focused }),
    setHere: () => commit({ pinnedHere: true, manualAway: false, lastInputAt: Date.now() }),
    setAway: () => commit({ pinnedHere: false, manualAway: true }),
    evaluate: () => {
      const s = get();
      const next = resolveMode(s, Date.now());
      // Only write on a real edge — the tick runs forever, and an unconditional `set` would wake
      // every subscriber (and every consuming render) four times a minute for nothing.
      if (next !== s.mode) set({ mode: next });
    },
    reset: () => set({ ...initialFacts(), mode: "here" }),
  };
});

/**
 * Wire the store to the real world: seed + subscribe to frontmost, and start the idle tick.
 * Returns a disposer. Idempotent by ref-count, so a double-mount (HMR, a second host) doesn't
 * install two tickers or two listeners.
 *
 * THE 120ms COALESCING IS NOT REIMPLEMENTED HERE, on purpose. macOS emits the old window's
 * `resignKey` BEFORE the new window's `becomeKey`, so a bare focus-loss event during an internal
 * window switch means "Sparkle went away" for about one runloop turn. `src-tauri/src/frontmost.rs`
 * already defers a LOSS by `FOCUS_BLUR_COALESCE_MS = 120` and re-polls (module docs at :1-27), so
 * `app://frontmost-changed` only ever carries settled transitions. Adding a second debounce here
 * would delay the real blur — the strongest Away signal we have — by another 120ms for no gain.
 */
export function startPresenceTracking(): () => void {
  refCount += 1;
  if (refCount > 1) return makeDisposer();

  const store = usePresenceStore.getState();
  void getFrontmost().then((f) => {
    // null = not running under Tauri (tests, browser dev). Leave the optimistic seed alone rather
    // than reporting a permanent Away in an environment that has no focus signal to recover with.
    if (f !== null) usePresenceStore.getState().setFocused(f);
  });
  const unlistenPromise = onFrontmostChanged((f) => usePresenceStore.getState().setFocused(f));
  unlistenPromise.then((u) => {
    // Disposed before the listener resolved — drop it immediately or it outlives the tracker.
    if (refCount === 0) void u();
    else unlisten = u;
  }).catch((e) => console.debug("presence: frontmost subscribe failed", e));
  ticker = setInterval(() => usePresenceStore.getState().evaluate(), PRESENCE_TICK_MS);
  store.evaluate();
  return makeDisposer();
}

let refCount = 0;
let ticker: ReturnType<typeof setInterval> | null = null;
let unlisten: (() => void) | null = null;

function makeDisposer(): () => void {
  let called = false;
  return () => {
    if (called) return; // a disposer must be idempotent or it can drive the refcount negative
    called = true;
    refCount -= 1;
    if (refCount > 0) return;
    if (ticker !== null) clearInterval(ticker);
    ticker = null;
    unlisten?.();
    unlisten = null;
  };
}
