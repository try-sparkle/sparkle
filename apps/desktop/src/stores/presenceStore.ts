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
// THE PIN — FOUNDER OVERRIDE, 2026-07-27 (design §1, decision 2, recorded there as OVERRIDDEN with
// the rationale it reverses left intact). Manually choosing Here PINS Here against EVERYTHING
// automatic: the idle timer, blur, a screen lock, a machine that slept overnight. It holds until
// the user takes it off — `togglePinnedHere`, or choosing Away.
//
// The decision it replaces said blur wins for the duration of the blur, because a pin that survived
// blur leaves the concierge unblocked-but-unwatched — the exact failure Away exists to prevent.
// That cost is real and was accepted. What outweighed it: a pin the app can silently revoke is not
// a pin. Switching to a browser to read a doc for ten minutes is ordinary work, and under the old
// rule that switch handed the concierge the autonomy the user had just explicitly refused, with
// nothing said about it. An override the user cannot feel is worse than no override at all.
//
// Two consequences a reader should hold onto:
//   • A pin left on overnight DOES strand the queue. That is now the user's to fix, which is why
//     the slider carries a visible pin affordance (Concierge/PresenceSlider) rather than hiding a
//     mode this sticky behind a state nobody can see. It also SURVIVES A RESTART — see
//     {@link PRESENCE_PIN_STORAGE_KEY}; "until you unpin" cannot have an unspoken "…or until the
//     app relaunches" in it.
//   • `manualAway` still outranks the pin (see `resolveMode`). The pin has to be escapable or the
//     control is a trap, and `setAway` drops it outright.
import { create } from "zustand";
import { getFrontmost, onFrontmostChanged } from "../services/helper";
import { safeUnlisten } from "../services/safeUnlisten";

export type PresenceMode = "here" | "away";

/** No input for this long, while focused, means Away. Five minutes — see the header. */
export const IDLE_AWAY_MS = 5 * 60 * 1000;

/** How often the idle deadline is re-checked. Polling rather than one long `setTimeout` per input:
 *  a timeout would have to be cleared and re-armed on every keystroke (and a machine that slept
 *  through its deadline would fire late by however long it slept), whereas a cheap wall-clock
 *  comparison on a coarse tick is correct across sleep/wake for free. 15s of granularity on a
 *  5-minute threshold is 5% — invisible, and it costs one comparison per tick. */
export const PRESENCE_TICK_MS = 15_000;

/**
 * Where the pin outlives the process (roborev 54146-M2).
 *
 * The pin is the one presence fact that is a STANDING INSTRUCTION rather than an observation. The
 * other three are re-derived from the world at launch — focus comes from the backend, the idle
 * clock restarts, an explicit Away is a decision about a moment that has passed — but "hold Here
 * until I say otherwise" is unfinished business, and the control promises exactly that in words:
 * "stays Here through app-switches, screen lock and overnight, until you unpin".
 *
 * An in-memory-only pin broke that promise on the ONE transition the user never chose — a restart,
 * a crash-relaunch, an auto-update, a dev reload — and broke it in the UNSAFE direction: presence
 * fell back to auto-Away, which is precisely the state that lets the concierge dispatch unattended,
 * with nothing on screen to say the override the user set had been dropped.
 *
 * Raw localStorage, not zustand `persist`: one boolean, rehydrated deliberately inside
 * {@link startPresenceTracking} rather than at module load. `persist` would rehydrate
 * asynchronously after the store is already being read from the non-React dispatch path, which is
 * a window where the gate would see the wrong answer.
 *
 * DELIBERATELY THE ONLY PERSISTED FACT. `manualAway` stays session-scoped: "I'm stepping out" is
 * about a stretch of time the relaunch has already ended, and restoring it would strand the queue
 * with no visible cause. Restoring a pin fails safe (the concierge asks first); restoring an Away
 * would not.
 */
export const PRESENCE_PIN_STORAGE_KEY = "sparkle.presence.pinnedHere";

/** Read the persisted pin. Never throws — a webview with storage disabled or a quota-blocked
 *  read must degrade to "not pinned", not take the whole presence signal down with it. */
function readPersistedPin(): boolean {
  try {
    return localStorage.getItem(PRESENCE_PIN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Write (or clear) the persisted pin. Same never-throws posture: presence is on the dispatch
 *  path, so a storage failure may cost the restart promise but must not cost the signal. */
function persistPin(on: boolean): void {
  try {
    if (on) localStorage.setItem(PRESENCE_PIN_STORAGE_KEY, "1");
    else localStorage.removeItem(PRESENCE_PIN_STORAGE_KEY);
  } catch {
    /* storage unavailable — the pin is still live for this session */
  }
}

/** The facts a mode is computed FROM. Split out so the rule is testable without a store. */
export interface PresenceFacts {
  /** A real Sparkle window is frontmost (services/helper.onFrontmostChanged). */
  focused: boolean;
  /** The user manually chose Here — pins against BOTH automatic signals, the idle timer and blur
   *  alike, until they unpin. See the header's override note. */
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
 * 1. Manually Away → Away. An explicit choice is not undone by activity; the user said they are
 *    stepping out, and typing one more line before they go does not change that. FIRST, because it
 *    is the escape hatch from the pin below: `setAway` also clears `pinnedHere`, so the two are
 *    never both set in practice, but an explicit "I am gone" must never resolve to Here even if a
 *    future edit lets them coexist.
 * 2. Pinned Here → Here. Beats the blur clause AND the idle clock — the founder override. Nothing
 *    automatic gets past this line; only unpinning or an explicit Away does.
 * 3. Not focused → Away. The strong automatic signal, and (since the override) the strongest thing
 *    that is still allowed to move presence on its own.
 * 4. Otherwise the idle clock decides.
 *
 * The pre-override order had (3) first and unconditional, which is what made a pin transient.
 */
export function resolveMode(facts: PresenceFacts, now: number): PresenceMode {
  if (facts.manualAway) return "away";
  if (facts.pinnedHere) return "here";
  if (!facts.focused) return "away";
  return now - facts.lastInputAt >= IDLE_AWAY_MS ? "away" : "here";
}

interface PresenceState extends PresenceFacts {
  /** The resolved answer. Stored, not derived on read, so non-React callers on the dispatch path
   *  get it from a plain `usePresenceStore.getState().mode` with no computation. */
  mode: PresenceMode;
  /**
   * What `manualAway` was when the pin last went ON — so taking the pin back OFF is a true no-op.
   *
   * NOT a {@link PresenceFacts} member on purpose: `resolveMode` must not consult it. It is
   * bookkeeping for one gesture, not an input to the rule.
   *
   * WHY IT EXISTS (roborev 54146-M1). Pinning ON has to clear `manualAway` — `resolveMode` puts
   * the explicit Away first, so a pin sitting on top of a latched Away would resolve to Away while
   * the pin showed lit, which is a control that lies. But the pin's two gestures (a fast
   * double-tap, two deliberate single taps) both END where they started, so the ON→OFF pair has to
   * end where presence started too. Without this, a user in an explicit Away who double-tapped the
   * pin came out in Here with the pin unlit: their "I'm stepping out" silently revoked by a gesture
   * that visibly changed nothing.
   *
   * The story it encodes: pinning from Away is a TEMPORARY OVERRIDE of that Away, and unpinning
   * hands it back. Clicking the Here segment is different — that is the user saying they are here,
   * and it ends the Away for good (`setHere` clears this).
   */
  awayBeforePin: boolean;
  /** The user typed — in the compose box or straight into a terminal. Resets the idle clock. */
  noteInput: () => void;
  /** Frontmost changed. Already coalesced 120ms upstream in src-tauri/src/frontmost.rs, which is
   *  what keeps a window-to-window switch from flickering Away — see `startPresenceTracking`. */
  setFocused: (focused: boolean) => void;
  /** The user chose Here on the slider: pin it, and clear any manual Away. */
  setHere: () => void;
  /** The user chose Away on the slider: latch it, and drop the pin. */
  setAway: () => void;
  /**
   * Set the pin directly (the slider's pin button, and its double-click gesture — which computes
   * the new value from the state BEFORE the gesture's own clicks landed).
   *
   * ON clears `manualAway`, because a pin that left a latched Away underneath it would resolve to
   * Away while showing a lit pin — but it REMEMBERS the Away it cleared (see
   * {@link PresenceState.awayBeforePin}), so the gesture is undoable.
   *
   * OFF removes the pin, restores whatever Away the pin was overriding, and otherwise lets the
   * facts speak: if the window is blurred or the idle deadline has passed, unpinning is immediately
   * Away, which is the whole point of being able to take the pin off.
   */
  setPinnedHere: (on: boolean) => void;
  /** Flip the pin — the slider's pin button. */
  togglePinnedHere: () => void;
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
    awayBeforePin: false,
    noteInput: () => commit({ lastInputAt: Date.now() }),
    setFocused: (focused) => commit({ focused }),
    setHere: () => {
      persistPin(true);
      // An explicit Here is a statement about NOW, not an override of an earlier Away — so it
      // discards the pre-pin memory rather than arming an unpin to resurrect that Away.
      set({ awayBeforePin: false });
      commit({ pinnedHere: true, manualAway: false, lastInputAt: Date.now() });
    },
    setAway: () => {
      persistPin(false);
      // The newest explicit choice, so nothing older is left to restore.
      set({ awayBeforePin: false });
      commit({ pinnedHere: false, manualAway: true });
    },
    setPinnedHere: (on) => {
      persistPin(on);
      if (on) {
        // Only capture on the OFF→ON edge: re-pinning an already-pinned Here would otherwise
        // overwrite the remembered Away with the `false` the pin itself installed.
        if (!get().pinnedHere) set({ awayBeforePin: get().manualAway });
        commit({ pinnedHere: true, manualAway: false, lastInputAt: Date.now() });
      } else {
        const restore = get().awayBeforePin;
        set({ awayBeforePin: false });
        commit({ pinnedHere: false, manualAway: restore });
      }
    },
    togglePinnedHere: () => get().setPinnedHere(!get().pinnedHere),
    evaluate: () => {
      const s = get();
      const next = resolveMode(s, Date.now());
      // Only write on a real edge — the tick runs forever, and an unconditional `set` would wake
      // every subscriber (and every consuming render) four times a minute for nothing.
      if (next !== s.mode) set({ mode: next });
    },
    // Deliberately leaves STORAGE alone: this resets the in-memory store, which is exactly what a
    // relaunch does, so a test can seed the key and then reset to express "the app came back up
    // with the pin still set". Suites clear the key themselves.
    reset: () => set({ ...initialFacts(), mode: "here", awayBeforePin: false }),
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

  // REHYDRATE THE PIN FIRST, synchronously, before anything can observe presence (roborev
  // 54146-M2). The frontmost seed below is async, so a relaunch into the background would otherwise
  // resolve Away for a moment — and "a moment" is enough on the dispatch path, which reads
  // `getState().mode` off any tick.
  if (readPersistedPin()) usePresenceStore.getState().setPinnedHere(true);

  const store = usePresenceStore.getState();
  void getFrontmost().then((f) => {
    // null = not running under Tauri (tests, browser dev). Leave the optimistic seed alone rather
    // than reporting a permanent Away in an environment that has no focus signal to recover with.
    if (f !== null) usePresenceStore.getState().setFocused(f);
  });
  const unlistenPromise = onFrontmostChanged((f) => usePresenceStore.getState().setFocused(f));
  unlistenPromise.then((u) => {
    // Disposed before the listener resolved — drop it immediately or it outlives the tracker.
    // Through safeUnlisten: this IS race #2 from its header (the listen promise resolving after
    // teardown), so a raw call here rejects with the "handlerId" TypeError and, being un-awaited,
    // surfaces as an app-level unhandled rejection rather than anything this .catch can see.
    if (refCount === 0) void safeUnlisten(u);
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
    // Race #1 from safeUnlisten's header: the last disposer commonly runs while the window is
    // closing, after Tauri has torn its listeners map down. Tauri's unlisten is async, so a raw
    // call returns a REJECTED PROMISE nobody holds — an unhandled rejection, not a throw.
    void safeUnlisten(unlisten);
    unlisten = null;
  };
}
