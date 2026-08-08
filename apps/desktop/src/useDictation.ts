import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useDictationStore } from "./stores/dictationStore";
import {
  classifyCloudOutcome,
  noteCloudLate,
  noteCloudLateAttemptStart,
  sawCloudLateThisAttempt,
  useDictationEngineStore,
  type CloudStreamOutcome,
} from "./stores/dictationEngineStore";
import { useAiFeature, aiFeatureNow } from "./services/aiGate";
import { useAuthStore } from "./stores/authStore";
import { openCloudDictationWindow, nextBalanceCents } from "./services/cloudDictation";
import { safeUnlisten } from "./services/safeUnlisten";
import { selectedProjectName } from "./services/creditProject";
import { classifyVoiceError, isWatchdogFault } from "./voice/dictationCopy";
import type { Phase } from "./voice/dictationPhase";
import { routeDictationToTerminal } from "./services/dictationTerminalSink";
import {
  armedStatus,
  dictationPauseReason,
  focusOwnerNow as readFocusOwnerFromDom,
  terminalRoutingArmed as terminalRoutingArmedFor,
  type FocusOwner,
  type PauseReason,
} from "./voice/dictationFocus";

/**
 * How long the room may stay quiet before this window PARKS its billable relay.
 *
 * Not a UX delay — a COST bound. See the idle-park block in `createDictationController` for the full
 * story; in short, the relay bills per elapsed minute and nothing else closes it now that the stop
 * word and pause-on-submit are gone. The microphone is unaffected: it stays armed, the tray never
 * moves, and the next word reopens the socket through the same warm-standby resume a window refocus
 * uses.
 *
 * 60s is chosen against the BILLING GRANULARITY rather than against human pause length. The relay
 * debits a first minute up front, so parking sooner cannot recover money already spent on the
 * current minute — it only risks paying a fresh first minute for someone who was merely thinking
 * mid-sentence. Waiting a full minute makes the park free by construction and still bounds an idle
 * Speak session at one minute of charge instead of an unbounded number.
 */
export const IDLE_RELAY_PARK_MS = 60_000;

/**
 * The cloud-stream command (if any) a PHASE EDGE implies. Pure so the "local gate, then stream"
 * wiring is unit-testable without the hook: only a real CHANGE acts — entering ACTIVE opens the
 * Deepgram relay, returning to PASSIVE closes it, and a re-observation of an unchanged phase
 * leaves the stream alone.
 *
 * ── WHAT MOVED, AND WHY IT HAD TO ───────────────────────────────────────────────────────────────
 * This used to take a wake-machine `Advance` and fire on the transition a SPOKEN PHRASE caused: the
 * wake word opened the relay, the stop word closed it. Both phrases are gone (voice/dictationPhase),
 * so segments no longer move the phase at all and a decision keyed on them would never fire again —
 * i.e. Speak would arm a microphone whose cloud relay never opened.
 *
 * The phase still moves, on exactly the edges that matter, and now for a better reason: the tray is
 * its only writer. Entering Speak, and each push-to-talk hold, IS the edge. So the relay's lifetime
 * is keyed on the phase itself rather than on the thing that used to change it.
 */
export function cloudStreamCommandFor(
  prevPhase: Phase,
  nextPhase: Phase,
): "start_cloud_stream" | "stop_cloud_stream" | null {
  if (prevPhase === nextPhase) return null;
  return nextPhase === "active" ? "start_cloud_stream" : "stop_cloud_stream";
}

// ---------------------------------------------------------------------------
// Controller factory
//
// Extracted so it can be instantiated without React (e.g. in tests) and also
// used by useAmbientVoice.  Returns `{ toggle, cleanup }`.
// ---------------------------------------------------------------------------

interface DictationOptions {
  /**
   * Hand a COMMITTED segment to its destination.
   *
   * `ctx.terminal` says where the text is bound. For the composer the callee inserts it and returns
   * nothing; for a terminal it returns the text to type, or null when the mic is not routing. It
   * used to run a wake/stop MATCHER first and hand back only the words that survived the stripping;
   * with both phrases retired every committed word is the user's, so nothing is consumed.
   */
  onSegment: (text: string, ctx: { terminal: boolean }) => string | null | void;
  /** Called when this window's cloud relay should be OPEN — on a passive→active phase edge, and on
   *  focus REGAIN while a session is still ACTIVE, so moving away and back does not cost the user
   *  their dictation session. Optional (tests may omit it). */
  onResumeActive?: () => void;
  /** True when THIS window is the active/focused OS window. The backend broadcasts every
   *  `dictation://*` event to ALL Sparkle windows (focus is tracked app-globally — see
   *  dictation.rs), so without this gate the same dictated phrase types into every open window's
   *  composer at once. Each Tauri window is its own webview, so `document.hasFocus()` is true in
   *  exactly the focused one. Injected so the multi-window routing is unit-testable; defaults to a
   *  real `document.hasFocus()` check (and `true` in the document-less test/node env). */
  isWindowActive?: () => boolean;
  /** WHO holds the DOM caret right now — the sibling of `isWindowActive` for focus WITHIN this
   *  window. Injected for the same reason: the node/test env has no real caret to move, and the
   *  listener must not reach into the store to re-derive a decision that lives in one pure place.
   *  Defaults to classifying the LIVE `document.activeElement`, which is race-free by construction
   *  (nothing can be stale about reading the DOM at the moment the event arrives). */
  focusOwner?: () => FocusOwner;
}

interface DictationController {
  toggle: () => Promise<void>;
  cleanup: () => void;
  /** Drive the caret-owner transition within this window: "terminal" = the caret moved INTO a
   *  terminal pane (pause, mirroring a window blur), anything else = it left one (resume, through
   *  the same guard a window refocus uses). Wired to the focus tracker's store field in a real
   *  webview; exposed so the terminal handoff is unit-testable without a DOM. */
  notifyFocusOwner: (owner: FocusOwner) => void;
  /** Drive the per-WINDOW OS-focus transition for THIS window (not the app-level `dictation://focus`,
   *  which never fires on a window-to-window switch — see dictation.rs `set_focused`). Wired to the
   *  DOM `window` focus/blur events in a real webview; exposed so the multi-window ownership handoff is
   *  unit-testable in the (window-less) node env. `false` = this window lost OS focus; `true` = regained. */
  notifyWindowFocus: (focused: boolean) => void;
}

/**
 * Registers Tauri event listeners for all `dictation://*` events and returns
 * a controller with `toggle()` and `cleanup()`.
 *
 * Suitable for use from tests or from useAmbientVoice.
 */
export async function createDictationController(
  options: DictationOptions,
): Promise<DictationController> {
  // Keep a stable reference to the callback so callers can swap it out
  // without recreating the controller (mirrors the useRef pattern in the hook).
  const onSegment = options.onSegment;
  const onResumeActive = options.onResumeActive;
  // Only the focused window should consume the (app-broadcast) committed text + live preview, so a
  // phrase doesn't land in every open window at once. Default to a real per-window focus check.
  const isWindowActive =
    options.isWindowActive ?? (() => typeof document === "undefined" || document.hasFocus());
  // Who holds the caret. Read LIVE from the DOM by default (see the option's doc) — the store's
  // `focusOwner` mirror exists for the COPY, which needs to be reactive; routing needs to be right.
  const focusOwnerNow = options.focusOwner ?? readFocusOwnerFromDom;

  // --- THE ONE GATE ------------------------------------------------------------------------------
  // Every routed `dictation://*` event asks THIS question and no other: "may dictation route here
  // right now?" It used to ask only `isWindowActive()`, which is why the terminal case half-happened
  // — transcription kept flowing into a composer the user couldn't see while the auto-send rail,
  // reading a different signal, never armed. Widening the ONE predicate rather than adding a second
  // check per listener is what makes "arming and transcription can never disagree about the active
  // target" STRUCTURALLY true instead of merely tested: `dictation://speech-end` (the rail's clock)
  // and `dictation://partial` (the text) are gated by the same expression, evaluated at the same
  // instant, so there is no state in which one passes and the other doesn't.
  //
  // `isWindowActive()` stays as its own term: it is the per-WINDOW ownership signal (which of our
  // webviews consumes the app-wide broadcast), while dictationPauseReason answers the user-facing
  // "is dictation paused, and why". They coincide on the window axis but are not the same question,
  // and only the first is meaningful while the mic is disarmed.
  // --- THE SECOND DESTINATION -------------------------------------------------------------------
  // A terminal used to be a place dictation STOPPED. It is now a place dictation GOES: a committed
  // phrase is typed at the focused agent's own input line (services/dictationTerminalSink).
  //
  // THE ROUTING GATE IS PART OF THIS, DELIBERATELY. Typing into a live agent is a much sharper
  // action than filling a compose box the user can read and edit before sending, so it requires that
  // the mic is actually ROUTING (`phase === "active"`), not merely left armed. An armed-but-passive
  // mic near an open terminal — Push to talk between holds — must stay inert.
  const terminalRoutingArmed = (): boolean => {
    const s = useDictationStore.getState();
    return terminalRoutingArmedFor({
      enabled: s.enabled,
      errored: s.status === "error",
      woken: s.phase === "active",
    });
  };

  const focusPauseReason = (): PauseReason | null =>
    dictationPauseReason({
      windowFocused: isWindowActive(),
      focusOwner: focusOwnerNow(),
      enabled: useDictationStore.getState().enabled,
      terminalRoutes: terminalRoutingArmed(),
    });
  // MAY A PHRASE GO TO THE COMPOSER? The original ONE GATE, with the terminal now excluded
  // EXPLICITLY rather than by way of `dictationPauseReason`. That function no longer calls a
  // routable terminal a pause (it isn't one — see `terminalRoutes`), so without this term the same
  // committed phrase would land in the composer AND be typed into the terminal. The two
  // destinations must stay mutually exclusive, and this is where that is enforced.
  //
  // `!isTerminalRoutable()`, NOT a blanket `focusOwnerNow() !== "terminal"`. The blanket form also
  // silences a DISARMED mic whose caret happens to sit in a terminal — a case that never routed to a
  // terminal and always routed to the composer, because a muted mic is OFF rather than paused
  // (dictationPauseReason returns null on `!enabled`). Excluding exactly the state where the
  // terminal is taking the phrase is what keeps this a widening, not a silent narrowing elsewhere.
  const isRoutable = () =>
    isWindowActive() && focusPauseReason() === null && !isTerminalRoutable();
  /** MAY A PHRASE BE TYPED INTO THE FOCUSED TERMINAL? Requires the caret AND the routing gate. */
  const isTerminalRoutable = () =>
    isWindowActive() && focusOwnerNow() === "terminal" && terminalRoutingArmed();
  /** Is the mic feeding EITHER destination? The relay's lifetime and the live meters key on this —
   *  they care that capture is being consumed, not which box consumes it. */
  const isCapturable = () => isRoutable() || isTerminalRoutable();
  /** Is the caret in a terminal that CANNOT take the phrase? The status-claiming paths below used to
   *  ask `focusOwnerNow() !== "terminal"` for this, which was the same question only while a terminal
   *  was always a dead end. Now that it can receive, the honest term is "a terminal, and no route
   *  out of it" — otherwise the UI would go quiet while it is actively typing. */
  const terminalIsPaused = () => focusOwnerNow() === "terminal" && !terminalRoutingArmed();

  const { setLevel, setSpeaking, setError, setModelProgress } =
    useDictationStore.getState();

  // --- Per-window cloud-stream ownership (sparkle-ozvr) ------------------------------------------
  // The billable Deepgram relay is a single backend resource, but it is logically OWNED by the one
  // window that put the mic into dictation — i.e. the window whose OWN per-window store has
  // `phase: "active"`.
  // Committed partials route by focus (isWindowActive), but ownership lived only in the old window's
  // store, and `dictation://focus` fires only on APP-level focus flips — never on a window-to-window
  // switch (dictation.rs keeps `focused` true while any Sparkle window is up). So starting dictation
  // in window A then switching to window B left A's relay streaming (and billing) until it was ended
  // or timed out, while B (still PASSIVE) inserted nothing. Fix: tie the relay's lifetime to whether the
  // owner window is the focused dictation target — tear it down when the owner loses focus, and resume
  // it when the owner regains focus (the session follows its window).
  //
  // `true` once this window has torn its relay down and is waiting to resume on refocus. Guards resume
  // so it only fires after a real teardown (never spuriously re-opens an already-running stream).
  let streamTornDown = false;

  // Close THIS window's relay when it stops being the focused dictation target. Only the OWNER (its own
  // phase is ACTIVE) has a billable stream to close; a passive/background window is a no-op. Phase is
  // intentionally RETAINED so refocusing the owner resumes the same session rather than dropping it.
  const tearDownOwnedStream = () => {
    const store = useDictationStore.getState();
    if (store.phase !== "active") return;
    // THE PARK'S LIFETIME IS THE RELAY'S — cancel it here, where the relay closes.
    //
    // I DECLINED THIS ONCE, on the reasoning that both teardown callers were already covered by the
    // timer's own guards ("a blur by `isWindowActive()`, a non-routable terminal by the
    // `phase !== "active"` early-return above"). THAT WAS WRONG FOR THE TERMINAL PATH, and the
    // correction is worth keeping because the false version was written into this file as fact: a
    // terminal teardown deliberately RETAINS `phase: "active"` (see the note on `notifyFocusOwner`;
    // `reconcileStatusForOwner` writes interim/level/speaking/status and never `phase`), so that
    // early-return is never reached there.
    //
    // The sequence it misses: quiet on Speak arms a park; the caret then moves into a NON-routable
    // terminal, which closes the relay and leaves the park pending; the timer fires in the SAME
    // still-focused window, so `isWindowActive()` passes too, and the whole teardown runs a second
    // time — a redundant `stop_cloud_stream` on the single global relay. It is benign today only
    // because of an invariant nothing stated: both reopen paths now re-arm, and DOM focus is
    // exclusive across webviews. A future reopen path that does not re-arm turns it into the exact
    // cross-window kill the timer's guard exists to prevent (roborev 57802).
    //
    // Falsifiable, unlike the version I first argued against: without this line, the errored-
    // terminal case in useDictation.test.ts sees a second close ~60s later.
    clearIdlePark();
    invoke("stop_cloud_stream").catch(() => {});
    streamTornDown = true;
    store.setInterim("");
    store.setLevel(0);
    store.setSpeaking(false);
    // CLEARED WITH IT, ALWAYS. `onDeviceSpeech` is a LATCH fed only by edges from a LIVE capture,
    // and Rust's edge state is per-capture starting false — so a capture torn down while it is true
    // emits no falling edge, and a rebuilt capture computing false sees no change and emits nothing
    // either. Left set, `useAutoSend` reads "the user is still talking" forever: startClock
    // early-returns on every speech-end and auto-send never fires again for the whole session.
    // Capture is not running in any of these states, so the level is false by definition.
    store.setOnDeviceSpeech(false);
  };

  // Resume THIS window's relay when it (re)gains focus mid-session. Guarded so ONLY the focused
  // (isWindowActive) window that owns a torn-down ACTIVE session reopens the stream — a backgrounded
  // stale-active window must never grab the single cloud stream on an app-level refocus. The short
  // cooldown de-dupes the DOM-focus and app-level `dictation://focus` signals that both fire when the
  // whole app is re-focused (only one reopen).
  let lastResumeAt = 0;
  const maybeResumeOwnedStream = () => {
    if (!streamTornDown) return;
    const now = Date.now();
    if (now - lastResumeAt < 300) return;
    const store = useDictationStore.getState();
    // `isCapturable()`, not a bare `isWindowActive()`: a window that is focused but has NO
    // destination for the words is not somewhere the relay may resume into. Same predicate as the
    // listeners, so the relay can never be open in a state where the events it produces are dropped.
    // A terminal caret now qualifies — that is the whole feature — so this had to widen with it, or
    // the stream would stay torn down and there would be nothing to type.
    if (!isCapturable() || !store.enabled || store.status === "error" || store.phase !== "active") {
      return;
    }
    lastResumeAt = now;
    streamTornDown = false;
    store.setStatus("listening");
    onResumeActive?.();
    // ARM THE CLOCK WHERE THE SOCKET OPENS. The idle park was originally armed only on the VAD's
    // falling edge and on the phase edge, which left the commonest re-entry uncovered: once a park
    // has fired, `speaking` is ALREADY false, so no VAD edge can fire again — and every resume path
    // (a window refocus, `dictation://focus`, leaving a terminal) reopened the billable relay with
    // no timer behind it. Dictate, go quiet, park at 60s, alt-tab away and back, and the relay took
    // a fresh first-minute debit and then billed indefinitely while the user read. That is the exact
    // High this park exists to close, surviving on the most-travelled path (roborev 57795).
    armIdlePark();
  };

  // ── THE IDLE PARK: A LIVE MICROPHONE IS NOT A REASON TO KEEP PAYING FOR A SOCKET ───────────────
  //
  // THE COST BUG THIS EXISTS TO CLOSE (roborev 57785, High). The relay's lifetime is now the tray
  // position (see the phase-edge branch below), and BOTH things that used to close it went with the
  // wake word: the stop word, and pause-on-submit — which defaulted to true and shut the socket
  // after every message. Nothing replaced them, so "Speak is always on" meant the billable socket
  // was too. Metering is per ELAPSED minute, debited up front (apps/orchestration relay
  // `firstMinuteCents`), and the backend only parks on blur — never on silence. So sitting in a
  // focused window on Speak, reading the thread and saying nothing, drained credits for zero
  // transcription.
  //
  // "ALWAYS ON" IS ABOUT THE MICROPHONE, NOT THE SOCKET, and that distinction is the whole fix. The
  // mic stays armed and the tray never moves; only the paid relay parks, and the very next word
  // brings it back. What the user was promised is preserved exactly — they never touch anything.
  //
  // IT REUSES THE WARM-STANDBY PATH RATHER THAN INVENTING ONE. `tearDownOwnedStream` /
  // `maybeResumeOwnedStream` already do precisely this for a window blur, including the
  // `streamTornDown` latch that stops a resume firing without a real teardown and the guard that
  // keeps a background window from grabbing the single global stream. Silence is just another
  // reason to park, so it goes through the same two functions — which also means it cannot drift
  // from the focus path's rules.
  //
  // THE SIGNAL IS THE VAD, NOT THE TRANSCRIPT. `speaking` is the raw Silero flag on BOTH capture
  // paths (dictation.rs `frame_speaking` ignores `cloud_active`), so it is true of a user who is
  // talking regardless of whether anything has been recognised yet — which is what makes it safe to
  // park on its absence. Keying on committed segments instead would park mid-utterance whenever
  // recognition lagged, which is the truncation failure `useSendMode`'s drain exists to prevent.
  let idlePark: ReturnType<typeof setTimeout> | null = null;
  const clearIdlePark = () => {
    if (idlePark !== null) clearTimeout(idlePark);
    idlePark = null;
  };
  const armIdlePark = () => {
    clearIdlePark();
    idlePark = setTimeout(() => {
      idlePark = null;
      // Re-read rather than trusting the state that armed the timer: a minute is a long time, and
      // the mic may have been released, faulted or moved off Speak since. `tearDownOwnedStream`
      // early-returns unless this window's phase is still ACTIVE, so a park that is no longer
      // wanted is a no-op rather than a wrong teardown.
      if (useDictationStore.getState().speaking) return armIdlePark();
      // THE SAME OWNERSHIP GUARD THE PHASE EDGE CARRIES, and for the same reason: `phase` is
      // cross-window synced, so `tearDownOwnedStream`'s own `phase !== "active"` test cannot tell
      // "this window owns the relay" from "some window does". Closing the socket from a background
      // window is the roborev-56061 failure, reached here by a timer instead of by a store event.
      if (!isWindowActive()) return;
      tearDownOwnedStream();
    }, IDLE_RELAY_PARK_MS);
  };

  // Per-WINDOW OS-focus transition (DOM window focus/blur), the signal the app-level event misses on a
  // window-to-window switch. Exposed on the controller so it is unit-testable without a real webview.
  const notifyWindowFocus = (focused: boolean) => {
    if (focused) maybeResumeOwnedStream();
    else tearDownOwnedStream();
  };

  // The caret moved into (or out of) a terminal pane inside THIS window. Deliberately the SAME
  // shape as a window blur/refocus, because to the user it is the same event: something else took
  // the keyboard, so Sparkle stops listening until they come back to the box.
  //
  // What it does NOT touch, exactly as the window path doesn't: `enabled` (the mic stays armed —
  // this is a gate on top of the mute toggle, not the toggle) and `phase` (an ACTIVE Speak session
  // must survive clicking into a terminal and back without the user touching the tray).
  /**
   * Bring `status` (and the live-UI fields that go with it) into line with the caret — and NOTHING
   * else. Split out of {@link notifyFocusOwner} because a PHASE edge needs exactly this and must not
   * re-enter the FOCUS handler (roborev 56061): reconciling through the whole handler also
   * re-entered `maybeResumeOwnedStream`, so the phase edge fired a resume synchronously and then
   * the segment handler opened the relay again — two `start_cloud_stream` invokes in one tick, two
   * relay handshakes, and two first-minute debits for one session.
   *
   * THE PHASE EDGE DOES NOW OWN THE RELAY, and that is not a reversal of the above. What was wrong
   * was TWO openers racing in one tick, and the segment handler is no longer one of them: segments
   * cannot move the phase since the wake word was retired (voice/dictationPhase), so the phase edge
   * is the SINGLE opener and the double-open warned about here is structurally unreachable. The
   * stream calls still sit in the subscriber beside this function rather than inside it, so "what
   * the caret implies" and "what the phase implies" stay separable — see the subscriber for the
   * per-window ownership guard the stream calls need and this status decision deliberately does not.
   */
  const reconcileStatusForOwner = (owner: FocusOwner) => {
    const store = useDictationStore.getState();
    if (owner === "terminal" && isTerminalRoutable()) {
      if (store.status !== "error") store.setStatus("listening");
      return;
    }
    if (owner === "terminal") {
      store.setInterim("");
      store.setLevel(0);
      store.setSpeaking(false);
      store.setOnDeviceSpeech(false);
      if (store.status !== "error") store.setStatus("idle");
      return;
    }
    if (store.enabled && store.status !== "error" && isRoutable()) store.setStatus("listening");
  };

  /**
   * A focus change: the status decision PLUS the stream lifetime that only a focus change implies.
   *
   * DELEGATES the status half rather than restating it (roborev 56064). The two were written out
   * twice, verbatim — same three-way owner test, same `status !== "error"` guards, same four
   * flattened fields — with nothing enforcing agreement, which is how the next pause term or extra
   * field lands in one copy and silently diverges the other. That is precisely the "gate and copy
   * disagree" class this file's design exists to prevent, so it must not be reintroduced inside the
   * fix for it. The split was needed; the duplication was not.
   *
   * State is identical to the old inline version: `tearDownOwnedStream` writes the same four fields
   * to the same values and never touches `status`, and `maybeResumeOwnedStream` is internally
   * guarded (`streamTornDown` + `isCapturable()` + enabled/error/phase), which subsumes the
   * condition that used to wrap it.
   */
  const notifyFocusOwner = (owner: FocusOwner) => {
    // ROUTING, NOT PAUSING. When the phrase can be typed into this terminal, entering it is not a
    // handoff away from dictation at all — tearing the relay down here is precisely what would make
    // the feature impossible, since there would be no transcription left to route.
    if (owner === "terminal" && isTerminalRoutable()) {
      reconcileStatusForOwner(owner);
      return;
    }
    if (owner === "terminal") {
      // Close the BILLABLE relay (no-op unless this window owns one), then let the shared
      // reconciliation flatten the live UI and say why.
      tearDownOwnedStream();
      reconcileStatusForOwner(owner);
      return;
    }
    // Left the terminal. Resume through the SAME guard a window refocus uses, rather than a second
    // resume path, so the two can't drift: only a window that actually tore a stream down reopens
    // one, and only once.
    reconcileStatusForOwner(owner);
    maybeResumeOwnedStream();
  };

  /**
   * DELIVER ONE COMMITTED SEGMENT to whichever destination is bound. Returns true iff a destination
   * gate passed and the text was handed on.
   *
   * ── WHY THIS IS A FUNCTION AND NOT THE BODY OF THE `partial` LISTENER ──────────────────────────
   * There are TWO producers of committed text, not one. `dictation://partial` is the ordinary one;
   * the other is the orphaned-tail recovery in `dictation://cloud-ended` (see there). They must make
   * the identical decision — same gates in the same order, same `noteCommittedSegment`, same
   * terminal branch with its refusal fallback — because a tail delivered by a second, similar-looking
   * copy of this logic is exactly how one destination grows a rule the other lacks. In particular a
   * copy that skipped `isTerminalRoutable()` would type the tail into the composer while the user was
   * driving a PTY, and one that skipped the refusal fallback would drop it silently.
   */
  const deliverCommittedSegment = (text: string): boolean => {
    // THE ONE GATE (see isRoutable). Committed text must land in exactly one place: the focused
    // window, and only while dictation is routable there. Background windows bail — otherwise the
    // same phrase types into every open window's composer — and so does a window whose caret sits
    // in a terminal, where the composer the text would land in isn't the thing the user is typing
    // into at all.
    // ══ THE TERMINAL DESTINATION ═══════════════════════════════════════════════════════════
    // Checked BEFORE the composer gate and returning unconditionally, so exactly one destination
    // ever sees a given phrase. Only COMMITTED text reaches here (`dictation://partial` is the
    // committed-segment event; the live preview is `dictation://interim`), which is the contract
    // the sink depends on — streaming a phrase the recognizer is still revising into a live PTY
    // would type, and partly execute, words the speaker never finished saying.
    if (isTerminalRoutable()) {
      useDictationStore.getState().setModelProgress(null);
      useDictationStore.getState().setInterim("");
      // A COMMITTED segment arrived. The push-to-talk drain keys its "is anything still landing"
      // question on this rather than on the composer's text, which cannot tell a transcript from a
      // keystroke (roborev 57295).
      useDictationStore.getState().noteCommittedSegment();
      // ══ ONE HANDLER, BOTH DESTINATIONS ═══════════════════════════════════════════════════
      // `onSegment` decides delivery for the composer and the terminal alike, and passing
      // `{ terminal: true }` is what makes it hand the text BACK rather than insert it. Keeping
      // one handler (rather than short-circuiting past it here) is why the routing gate cannot
      // apply to one destination and not the other — the shape that let a spoken command be typed
      // onto an agent's command line instead of being acted on, back when segments carried
      // commands at all (roborev 56038).
      //
      // `{ terminal: true }` NAMES THE DESTINATION, NOT THE SEGMENT'S FINALITY. It means "hand this
      // back to be typed into a PTY" and nothing else — there is no "this is the last segment" flag
      // here, and reading it as one is how unfinished words get typed into a live terminal.
      const toType = onSegment(text, { terminal: true });
      if (!toType) return true;
      // Fire-and-forget: the write is chained per-agent inside the sink, so ordering is preserved
      // without this listener awaiting anything. The outcome is logged WITHOUT the transcript —
      // dictation captures whatever was said near the mic, which is not all of it meant for a log.
      void routeDictationToTerminal(toType).then((out) => {
        if (out.kind === "delivered") return;
        // ══ A REFUSAL PUTS THE WORDS IN THE COMPOSER, IT DOES NOT DROP THEM ═════════════════
        // The refusing states (a live picker, a password prompt, an unreadable screen) are the
        // LIKELY ones, and the user is watching a live meter and a placeholder that says "I'm
        // listening". A phrase that simply vanishes there is indistinguishable from dictation
        // being broken. The composer is the safe destination: it is a text box the user can read
        // and edit, so nothing is executed and nothing is lost.
        // `insertTarget` is ONE app-wide slot, registered by whichever compose box mounted last,
        // and `insert` is a silent no-op when it is null (roborev 56057). Claiming "left in the
        // composer" without checking would re-create the exact silent drop the fallback exists to
        // close, and would say so in the log while it happened.
        const placed = useDictationStore.getState().insertTarget !== null;
        if (placed) useDictationStore.getState().insert(toType);
        console.info(
          placed
            ? "[dictation] terminal declined; text left in the composer"
            : "[dictation] terminal declined and no composer was mounted to catch it",
          {
            outcome: out.kind,
            reason: out.kind === "refused" ? out.reason : undefined,
            chars: toType.length,
          },
        );
      });
      return true;
    }
    if (!isRoutable()) return false;
    // Capture started — clear any lingering model-download progress.
    useDictationStore.getState().setModelProgress(null);
    // A committed (final) segment supersedes the live preview — clear it so the interim text
    // doesn't briefly double up with the text that's about to land in the box.
    useDictationStore.getState().setInterim("");
    // …and record the ARRIVAL itself, for the push-to-talk drain (roborev 57295).
    useDictationStore.getState().noteCommittedSegment();
    onSegment(text, { terminal: false });
    return true;
  };

  // Register event listeners — each `listen()` returns an unsubscribe fn.
  const unsubscribes = await Promise.all([
    listen<string>("dictation://partial", (e) => {
      deliverCommittedSegment(e.payload);
    }),

    // ── THE RELAY CONNECTED, JUST TOO LATE ────────────────────────────────────────────────────
    // Emitted by start_cloud_stream's parked/discard arms, both of which answer
    // `CloudStreamOutcome::Raced` — "a stop interleaved; don't meter, don't count it". That is
    // right about billing and about the corroboration counter (it classifies as `ignore`) and says
    // NOTHING to the user, and before the outcome existed it was a bare `Ok(false)` the frontend
    // could not tell apart from a handshake that never completed. So a socket that opened fine was
    // reported as "Sparkle can't reach the cloud transcription service": false on this path by
    // construction, since it demonstrably reached it. This event is what carries that fact.
    // Measured 2026-08-06: 171 opened / 170 closed, 136 discarded for landing after the utterance
    // ended, on a network measured healthy at the moment the banner fired.
    listen("dictation://cloud-late", () => {
      // BOTH, deliberately — the event and the invoke's response race, and the order is not
      // guaranteed by Tauri. Setting the flag fixes the case where this lands FIRST (startCloudStream
      // then reads it instead of defaulting to "unavailable"); writing the store fixes the case where
      // it lands SECOND (it corrects the "unavailable" already written). Doing only one of the two
      // leaves the reason wrong in exactly one of the two orderings — which is the bug a reviewer
      // caught in the first version of this wiring, where the true reason was written and then
      // immediately overwritten with the false one it exists to replace.
      noteCloudLate();
      // GATED LIKE ITS SIBLINGS, and for the reason 59964 established for `cloud-ended`: this is an
      // `app.emit`, so every open window runs it, and every project window paints its own banner. The
      // EVIDENCE (a completed handshake) is app-wide and lands unconditionally; the CLAIM is about
      // one window's utterance. Ungated, dictating in window A painted "connected too late for that
      // utterance" in B and C — which cannot take it down, because every clearing path needs
      // `isCapturable()` — so it stood there for the full notice TTL.
      useDictationEngineStore.getState().noteCloudConnectedLate(isCapturable());
    }),

    // Cloud-only: Deepgram interim results — the live, word-by-word preview. Volatile; replaced in
    // place and never routed through the segment handler (that only acts on committed segments).
    listen<string>("dictation://interim", (e) => {
      // Same ONE GATE as the partial path: only a window dictation may route into paints the live
      // ghost. Anywhere else clears any stale preview it might still be showing and ignores the
      // rest — a ghost left up in a terminal-paused composer would advertise a live transcription
      // that is not happening.
      // ══ EVIDENCE FIRST, ROUTING SECOND — THEY ARE DIFFERENT QUESTIONS ══════════════════════════
      // This block sits ABOVE the routing gate deliberately (roborev 59975). Whether an interim may
      // be PAINTED depends on `isRoutable()`; what it PROVES about the relay does not depend on
      // which destination is consuming the words. Below the gate, the two predicates disagreed on
      // exactly one supported mode: with the caret in a terminal and routing armed,
      // `isTerminalRoutable()` is true, so `isCapturable()` is true (the counter is FED) while
      // `isRoutable()` is false (the counter was never CLEARED). Terminal dictation therefore
      // accumulated refusals with no way to discharge them and would raise the banner over a
      // perfectly live relay — the same flap, surviving in the one mode the fix had not covered.
      // `isCapturable()` matches the predicate that feeds the counter, which is what keeps the two
      // sides of this ledger in step.
      if (isCapturable()) {
        const eng = useDictationEngineStore.getState();
        if (eng.fallbackReason !== null || eng.openRefusals > 0) eng.noteCloudLive();
      }
      // Same ONE GATE as the partial path for the PAINT: only a window dictation may route into
      // shows the live ghost; anywhere else clears any stale preview and ignores the rest.
      if (!isRoutable()) {
        useDictationStore.getState().setInterim("");
        return;
      }
      // ══ AN INTERIM IS PROOF THE CLOUD ENGINE IS LIVE — SO IT RETIRES ANY STANDING NOTICE ═══════
      // The on-device engine is an OFFLINE transducer with no interim results at all, so this event
      // can only have come from the relay. That is stronger evidence of cloud health than anything
      // the open seam reports, and a banner claiming "Sparkle can't reach the cloud transcription
      // service" while relay text is arriving is simply false. It used to be reachable because
      // `cloud_reuse` answered `AlreadyRouting -> Ok(false)` for a socket that was alive and
      // actively routing; that outcome now classifies as `live` at the seam itself, so this is a
      // backstop for the one remaining ambiguous outcome (`unreachable`) rather than the primary
      // fix it once was (see the open seam below, and bead sparkle-omznw).
      //
      // IT ALSO CLEARS PARTIAL CORROBORATION, NOT ONLY A PAINTED NOTICE (roborev 59964/59966).
      // Gating on `fallbackReason !== null` alone left the counter climbing through a HEALTHY
      // session, because when this was written nothing else brought it down: the open path zeroed
      // it only when `start_cloud_stream` returned TRUE, and a warm socket answered
      // `AlreadyRouting -> Ok(false)` on EVERY passive→active edge, so consecutive no-ops were the
      // normal case rather than the exception. Two holds onto one live socket would reach the
      // threshold and paint "Sparkle can't reach the cloud transcription service" while relay text
      // was visibly streaming in, with the next interim clearing it: the reported flap made rarer
      // rather than removed.
      //
      // THE PRIMARY FIX FOR THAT NOW LIVES AT THE SEAM — `already_routing` is its own outcome and
      // classifies as `live`, so the counter is zeroed by the open path itself on exactly the edge
      // that used to climb it. This stays because the rule it encodes is the durable one: evidence
      // of a live cloud resets the count whether or not a notice is up, and an interim is the
      // strongest evidence there is.
      //
      // Still gated, because this fires ~25x/sec while speaking and an unconditional write would
      // churn the store and every subscriber for a no-op. Both terms are false in the steady state.
      // (The write itself lives above the routing gate — see the block at the top of this handler.)
      useDictationStore.getState().setInterim(e.payload);
    }),

    // The cloud (relay) worker exited — clean close, a mid-stream failure, OR the relay signalling
    // out-of-credits (payload `exhausted`). Clear the stale interim ghost and call stop_cloud_stream,
    // which flips cloud_active off so the capture callback resumes routing frames to the on-device
    // model (seamless fallback; on a mid-stream death the on-device path resumes
    // instead of dictation getting stranded). Idempotent on the normal stop path (cloud already torn
    // down). Metering is server-side now, so there's no client meter to stop here.
    listen<boolean>("dictation://cloud-ended", (e) => {
      // ══ THE TAIL RECOVERY: THE USER'S LAST WORDS ARE IN `interim`, AND THEY WERE BEING DROPPED ══
      // This handler used to clear `interim` unconditionally, which is correct on exactly one of the
      // three paths that reach it. On a CLEAN close Rust has already sent Finalize/CloseStream and
      // read-drained the socket, so the trailing final arrived as a `dictation://partial` and
      // `interim` is already "" — clearing is a no-op. On a mid-stream RELAY FAILURE, and on the
      // out-of-credits teardown, no final is coming: `interim` still holds words the user actually
      // said, and clearing them is a silent, unrecoverable loss. Dictation is how nearly everything
      // here gets written, so a truncated tail is the most expensive bug this file can have.
      //
      // THE INVARIANT THAT MAKES COMMITTING IT SAFE — i.e. why this cannot DUPLICATE text. The
      // `dictation://partial` path clears `interim` on EVERY committed segment (both branches of
      // `deliverCommittedSegment`), and the `dictation://interim` handler clears it whenever this
      // window is not routable. So a NON-EMPTY `interim` at this instant is by construction text
      // that no committed segment has carried. Committing it adds words; it can never repeat them.
      //
      // It goes through `deliverCommittedSegment` rather than a private insert so the recovered tail
      // obeys the identical destination rules as every other committed segment — including the
      // terminal branch, which hands the text back to be typed into the PTY the user is actually
      // driving instead of into a composer they are not looking at.
      const tail = useDictationStore.getState().interim;
      if (tail.trim() !== "") {
        const recovered = deliverCommittedSegment(tail);
        // NEVER THE TRANSCRIPT ITSELF — only its length. Dictation captures whatever was said near
        // the microphone, which is not all of it meant for a log (see emit_partial in dictation.rs).
        console.info(
          recovered
            ? "[dictation] committed an orphaned interim tail at cloud-ended"
            : "[dictation] dropped an orphaned interim tail at cloud-ended (no routable destination)",
          { chars: tail.length, exhausted: e.payload === true },
        );
      }
      useDictationStore.getState().setInterim("");
      invoke("stop_cloud_stream").catch(() => {});
      // The cloud engine is gone, so dictation continues on-device — which has no interim results at
      // all, meaning the live word-by-word preview structurally stops existing. Say so rather than
      // letting the user read a silent engine swap as a broken feature (see dictationEngineStore).
      // `e.payload` is the relay's `exhausted` flag: out-of-credits is the one cause the user can act
      // on, so it is reported distinctly from an ordinary outage.
      //
      // ══ THE SAME ONE GATE AS THE TEXT AND THE METER, AND FOR THE SAME REASON ═══════════════════
      // This is an app-wide broadcast, and EVERY project window mounts its own
      // DictationEngineBanner (Workspace.tsx). Ungated, one relay death lit the bar in every open
      // window — but `noteCloudLive` fires only in the window that reopens the stream, so the others
      // had no path back at all: a notice they never earned, clearable only by dictating into each
      // of them in turn. Same defect the level meter already had (sparkle-ozvr), on the same
      // broadcast, one listener away.
      //
      // `isCapturable()`, not `isRoutable()`: the question is whether THIS window's capture was
      // being consumed by the stream that just died, and a phrase on its way into a terminal counts
      // exactly as much as one bound for the composer. It is the predicate the relay's own lifetime
      // keys on. The teardown above and the balance refresh below stay UNGATED on purpose: those
      // are app-wide, and only the user-facing claim is per-window.
      // …EXCEPT FOR OUT-OF-CREDITS, WHICH IS NOT WINDOW-SCOPED (roborev 59964). The gate above fixes
      // over-reporting but introduces the opposite gap: `isCapturable()` needs this window focused
      // AND a live routing destination, so a teardown landing after focus moved — blurred
      // mid-stream, caret in a non-routable terminal — is reported by NO window at all. Losing an
      // ordinary outage that way is acceptable (the next attempt re-reports it, and the notice is
      // about a stream that is no longer running). Losing `exhausted` is not: the balance refresh
      // below is deliberately ungated because the balance is app-wide, so the credits pill would
      // drop to zero with nothing anywhere explaining why — and refilling is the one remedy the
      // user can act on. An empty balance is equally true in every window, so it speaks in all of
      // them, exactly like the refresh it accompanies.
      if (isCapturable() || e.payload) {
        useDictationEngineStore
          .getState()
          .noteCloudUnavailable(e.payload ? "exhausted" : "unavailable");
      }
      // Out-of-credits teardown → refresh the balance so the credits pill reflects the now-depleted
      // balance (the last relay `balance` frame was pre-decline). A clean close (payload false) skips
      // the round-trip.
      if (e.payload) void useAuthStore.getState().refresh();
    }),

    // The relay's per-minute `balance` control frame (server-authoritative). Cloud metering lives on
    // the server now, so this is how the credits pill ticks down in real time: prefer the server's
    // post-debit balance, optimistically decrement by the debited amount when it's absent. Broadcast
    // to every window (they all show the same balance), so no per-window focus gate is needed.
    listen<{ balanceCents: number | null; debitedCents: number }>(
      "dictation://cloud-balance",
      (e) => {
        const { me, setMe } = useAuthStore.getState();
        if (!me) return;
        const { balanceCents, debitedCents } = e.payload;
        // setMe, not setState: this frame carries a real balance change, and setMe is the seam that
        // re-arms a dismissed $0 banner when the balance crosses back above zero (roborev 48271).
        setMe({
          ...me,
          balanceCents: nextBalanceCents(me.balanceCents, balanceCents, debitedCents),
        });
      },
    ),

    listen<number>("dictation://level", (e) => {
      // THE ONE GATE: broadcast to EVERY window, but only one dictation may route into drives the
      // waveform — without it a background window animates its meter off another window's capture
      // (sparkle-ozvr), and a terminal-paused one animates a meter for speech it is discarding.
      // `isCapturable`: a phrase on its way into a TERMINAL is still being consumed by this window,
      // so a flat meter over that live capture would be the same half-state in the other direction.
      if (!isCapturable()) return;
      // Capture started — clear any lingering model-download progress. This fires ~25×/sec, so
      // only write when there's actually progress to clear; an unconditional set(null) would churn
      // the store (and every subscriber) 25 times a second for a no-op.
      const dict = useDictationStore.getState();
      if (dict.modelProgress !== null) {
        dict.setModelProgress(null);
      }
      setLevel(e.payload);
    }),

    // Real-time voice-activity edge from the Silero VAD (rising/falling only, not per-frame).
    // The waveform animates only while this is true, so the meter sits flat in silence instead
    // of wiggling on ambient noise. `level` still drives bar HEIGHT; this gates the MOTION.
    listen<boolean>("dictation://speaking", (e) => {
      // Same ONE GATE as the level meter: only a window dictation may route into animates its
      // waveform, so it never wiggles off voice activity it is not consuming (sparkle-ozvr).
      // `isCapturable`: speech routed into a TERMINAL is still being consumed by this window, and a
      // flat meter over a live capture is the same half-state in the other direction.
      if (!isCapturable()) return;
      setSpeaking(e.payload);
    }),

    // THE SPEAKER STOPPED — Deepgram's own endpoint decision (`speech_final`, or the standalone
    // `UtteranceEnd` frame), which is what the auto-send rail measures its silence against.
    //
    // Registered next to the partial/interim handlers on purpose: it belongs to the same utterance
    // they carry, and it MUST ride the very same gate expression. Without that a background window
    // would count down and fire a send off a phrase that was typed into another window's composer —
    // the same "one phrase, every window" bug the partial gate exists to stop (sparkle-ozvr),
    // except this one presses Send. Sharing `isRoutable()` with the partial listener is also what
    // closes the terminal half-state: there is no snapshot in which the text is being transcribed
    // but the rail isn't arming, or vice versa, because it is ONE predicate, not two agreeing ones.
    //
    // No payload: the event asserts only "as of now, speech has ended". The frontend already holds
    // a fresher transcript than any payload could carry.
    listen<null>("dictation://speech-end", () => {
      if (!isRoutable()) return;
      useDictationStore.getState().noteSpeechEnd();
    }),

    // THE COUNTDOWN'S CANCEL on the on-device path (see dictationStore.onDeviceSpeech). Rides the
    // SAME gate as the speech-end it cancels, which is the point: a window where the arm is
    // delivered but the cancel is not would be strictly worse than neither, since it can only fire
    // sends and never stop them.
    listen<boolean>("dictation://on-device-speech", (e) => {
      if (!isRoutable()) {
        // Not routable → nothing here can be counting, and a latched `true` would suspend the next
        // countdown that legitimately starts. Clear rather than ignore.
        useDictationStore.getState().setOnDeviceSpeech(false);
        return;
      }
      useDictationStore.getState().setOnDeviceSpeech(e.payload);
    }),

    listen<string>("dictation://error", (e) => {
      setModelProgress(null);
      setError(e.payload);
      // Record the dead-mic FAULT alongside the notice that reports it. STICKY, not assigned: an
      // earlier version wrote the boolean unconditionally, so any unrelated error landing between
      // the fault and its all-clear erased the fault, the recovery handler early-returned, and once
      // the user dismissed THAT notice the mic was drawn as paused over a live capture — the same
      // incident by a different route (roborev 55351). Only the recovery event, which is the only
      // positive evidence frames resumed, may clear it.
      // The WHOLE watchdog family, not just `no-audio`: the same watchdog also reports the
      // stale-grant case, and testing one kind here latched nothing for the other — so its
      // all-clear early-returned below and the notice never came down (knightwatch probe 1).
      if (isWatchdogFault(classifyVoiceError(e.payload))) {
        useDictationStore.getState().setDeadMicSilent(true);
      }
    }),

    // The frame-liveness watchdog's all-clear: audio frames are arriving again after a stretch of
    // none. No payload — the event asserts only "as of now, frames are flowing".
    //
    // It clears the error ONLY when the notice currently on screen is the watchdog's own. The
    // backend emits this whenever frames resume, which includes resuming while some UNRELATED
    // failure is showing (a model-download error, a permission denial). A blanket `setError(null)`
    // there would wipe a failure that is still true and still needs the user — trading the bug
    // where the UI hid a dead mic for the bug where it hides a denied one. `classifyVoiceError` is
    // the same bucketing the notice itself renders from, so what we clear is exactly what the user
    // is looking at, and it stays correct if the backend rewords the watchdog sentence.
    listen<null>("dictation://audio-recovered", () => {
      const store = useDictationStore.getState();
      // Gate on the FAULT, not on the visible notice. Keying off `store.error` discarded the very
      // evidence this handler exists for whenever the user dismissed the notice first — and
      // dismiss-then-fix is the ordinary sequence: read the warning, close it, quit the screen
      // recorder, frames resume. That arrived here with `error === null`, early-returned, and left
      // a live capturing mic drawn as PAUSED for as long as the user stayed in the window (only an
      // app blur/refocus would have corrected it). The fault is not dismissible; the notice is.
      if (!store.deadMicSilent) return;
      store.setDeadMicSilent(false);
      // Clear the notice only if it is still up AND still the watchdog's own. With the fault now
      // sticky, this check is what keeps an UNRELATED failure on screen: the all-clear says frames
      // are flowing, which is no evidence at all about a failed model download or a denied
      // permission. Trading the bug where the UI hid a dead mic for the bug where it hides a denied
      // one would be no trade at all.
      if (store.error && isWatchdogFault(classifyVoiceError(store.error))) setError(null);
      // Clearing the notice is only half the retraction. `setError(null)` moves status "error" →
      // "idle", but the mic never actually stopped: the watchdog fires MID-SESSION, so capture is
      // still live and `enabled` is still true. Left at idle, deriveMicState(enabled=true, "idle",
      // …) renders "paused" (MicButton.tsx) — a mic that has demonstrably recovered, drawn as if it
      // weren't listening, until the user cycles it by hand.
      //
      // THIS is the only place allowed to make that claim: the event is the sole positive evidence
      // that frames resumed. The notice's Dismiss buttons deliberately do NOT restore listening —
      // dismissing means "I've read this", not "the mic works again", and claiming it there would
      // paint a live mic over a still-dead one. Understating (paused) is the safe direction;
      // overstating rebuilds the incident.
      //
      // Gated on `enabled` so recovery can never un-mute a mic the user muted while the fault was
      // showing, and on focus because this notice's own remedy sends the user to System Settings →
      // Sound, which BLURS Sparkle: frames can resume while we are unfocused and not capturing, and
      // the dictation://focus(true) handler below already restores listening on refocus.
      // …and only when NO notice is left standing. Reading the store fresh, because setError above
      // just wrote to it. A surviving unrelated error means some other thing is still broken, and
      // "listening" would paint over it — the same overstatement, one failure across.
      // …and only if the caret is somewhere dictation may actually route. The sibling
      // dictation://focus(true) handler below carries this same term; without it here, a watchdog
      // fault that recovers while the caret sits in a terminal flips the UI back to claiming live
      // capture while the gate keeps discarding every event — the same contradiction by a second
      // path (roborev 55497). `focusOwnerNow()` rather than the full `isRoutable()` for the reason
      // given at that handler: the window term is already checked here.
      if (
        useDictationStore.getState().error === null &&
        store.enabled &&
        isWindowActive() &&
        !terminalIsPaused()
      ) {
        store.setStatus("listening");
      }
    }),

    // App-level window focus changed (sparkle-9oz6). The backend has already released or rebuilt the
    // OS mic; here we keep the frontend's billable/UI state consistent. `false` = no Sparkle window is
    // the active OS window (the user tabbed to another app): stop the per-minute cloud meter and close
    // the Deepgram socket so tabbing away mid-dictation can't keep billing, and clear the live
    // preview/level. We deliberately DON'T touch `enabled` (the mic stays armed) NOR `phase`: an
    // ACTIVE "Hey Sparkle" session must survive tabbing away and back so the user never has to
    // move the tray — it simply stops writing/billing while unfocused. `true` = focus
    // returned: reflect listening again, and resume the cloud stream if we were mid-dictation.
    listen<boolean>("dictation://focus", (e) => {
      const store = useDictationStore.getState();
      if (!e.payload) {
        invoke("stop_cloud_stream").catch(() => {});
        // The relay is now closed; arm the owner-resume guard so refocus reopens it exactly once.
        streamTornDown = true;
        store.setInterim("");
        store.setLevel(0);
        // Capture is paused — no more frames, so clear the VAD flag ourselves (the backend
        // emits edges only while capturing) to freeze the waveform flat while unfocused.
        store.setSpeaking(false);
        store.setOnDeviceSpeech(false);
        if (store.status !== "error") store.setStatus("idle");
      } else if (store.enabled && store.status !== "error" && !terminalIsPaused()) {
        // `terminalIsPaused()`, not the full `isRoutable()`: this event IS the app
        // telling us focus returned, and `document.hasFocus()` can still be false for a beat when
        // it arrives — gating on the window term would drop the very signal it is reporting. The
        // terminal term has no such race (the caret is wherever it is), and without it, returning
        // to the app with the caret parked in a terminal would flip the UI back to "listening"
        // while the gate above keeps discarding every event — the exact half-state this fixes.
        store.setStatus("listening");
        // Mid-dictation when focus left → resume the cloud stream now, no tray gesture needed. Routed
        // through the owner guard so only the FOCUSED window (not a background stale-active one)
        // reopens the single stream, and so it can't double-open with the DOM-focus signal.
        maybeResumeOwnedStream();
      }
    }),

    // [doneBytes, totalBytesOrNull]
    listen<[number, number | null]>("dictation://model-progress", (e) => {
      const [done, total] = e.payload;
      // Clear on completion so the UI doesn't linger on "Downloading… 100%".
      setModelProgress(total !== null && done >= total ? null : { done, total });
    }),
  ]);

  // Wire the per-window OS focus/blur to the ownership handoff. Each Tauri window is its own webview,
  // so its DOM `window` focus/blur fires on window-to-window switches WITHIN the app — the gap the
  // app-level `dictation://focus` never covers (sparkle-ozvr). Guarded for the window-less test/node
  // env (tests drive `notifyWindowFocus` directly instead).
  const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";
  // A BLUR THE DOM CONTRADICTS IS NOT A BLUR. This latch is LEVEL-HELD — it tears the owned relay
  // down and only a real `focus` builds it back — so believing a spurious blur strands dictation
  // until the user switches apps and returns. The input-release hatch (services/inputRelease)
  // dispatches exactly such a blur on purpose, as a stand-down pulse for the EDGE-triggered latches
  // (hint mode, push-to-talk, the drag shield). Answering it here, rather than having the hatch
  // dispatch a corrective `focus`, is what keeps the correction cheap: that focus would have run
  // `maybeResumeOwnedStream` in the same tick as the teardown — a fresh first-minute relay debit for
  // the user, and an unordered stop/start race on one global resource that can leave the relay dead
  // (roborev 59651). `hasFocus` guarded for exotic hosts; missing it means "trust the event".
  // TWO guards, because the hatch's stand-down pulse reaches EVERY window and the relay is GLOBAL.
  //
  // `app_menu.rs` emits INPUT_RELEASE_EVENT with a broadcast `app.emit`, and both App and HelperApp
  // subscribe — so `releaseAllInputCapture`, and its synthetic blur, run in every webview at once.
  //
  //   1. NOT A REAL BLUR. In the FOCUSED window the DOM contradicts the event, so ignore it. Routed
  //      through `isWindowActive()` — the module's documented injectable seam — rather than reading
  //      `document` directly, so the suite that owns every focus-handoff test can reach it.
  //   2. NOT AN EDGE. `isWindowActive()` is false in a BACKGROUND window, so guard 1 falls through
  //      there — and believing it is destructive precisely there: `tearDownOwnedStream` gates only
  //      on `store.phase`, which is cross-window synced, so a backgrounded window would `invoke`
  //      `stop_cloud_stream` and close the FOCUSED window's live relay. That window never tore down,
  //      so `maybeResumeOwnedStream` early-returns on `!streamTornDown` forever: its UI keeps
  //      painting "listening" over a closed socket until Speak is toggled. Acting only on a true →
  //      false EDGE for this window makes the pulse a no-op wherever the window is already
  //      background, which mirrors the ownership guard the idle park needed (roborev 56061).
  let domWindowFocused = isWindowActive();
  const onWinBlur = () => {
    if (isWindowActive()) return;
    if (!domWindowFocused) return;
    domWindowFocused = false;
    notifyWindowFocus(false);
  };
  const onWinFocus = () => {
    domWindowFocused = true;
    notifyWindowFocus(true);
  };
  if (hasWindow) {
    window.addEventListener("blur", onWinBlur);
    window.addEventListener("focus", onWinFocus);
  }

  // Caret-owner transitions arrive through the store, which the app-root focus tracker
  // (voice/dictationFocusTracker) is the sole writer of. Subscribing HERE rather than wiring it
  // through useAmbientVoice keeps the terminal handoff working for every controller instance —
  // including the ones created directly by tests — and means there is exactly one place that turns
  // "the caret moved" into "tear the relay down". Only real CHANGES act; the store setter already
  // suppresses no-op writes, and this second guard makes the handler idempotent against any other
  // store update.
  //
  // ══ PHASE IS AN INPUT TO THE STATUS, SO IT MUST WAKE THIS TOO (roborev 56057/56056) ═══════════
  // Making a terminal a destination made `status` a function of `phase`, via the routing gate inside
  // `terminalRoutingArmed`. But the only two writers of `status` were the arm effect (deps
  // `[enabled]`) and this subscriber (focus only) — so a PHASE change with the caret sitting still
  // left the copy pinned to whatever the last arm or focus event claimed, and it lied in BOTH
  // directions:
  //   passive → active (a push-to-talk hold, or the tray moving to Speak — `setActive()` does not
  //     touch `enabled` when the mic was already armed): the sink starts typing into the PTY while
  //     every surface still paints "Listening paused: Your cursor is in a terminal".
  //   active → passive (the hold ending, or the tray leaving Speak): the gates both shut, but
  //     `status` stays "listening", so the surfaces paint a live-capture invitation over a pipeline
  //     that discards every word.
  //
  // THE TWO EDGES CARRY DIFFERENT AUTHORITY, and an earlier version of this fix got that wrong by
  // routing both through `notifyFocusOwner` (roborev 56061). A FOCUS change owns stream lifetime AND
  // the resume guard — "the caret left" really is a reason to close or resume a relay — so it goes
  // through the full handler. A PHASE change owns the status and the relay's open/close, but NOT the
  // torn-down/resume bookkeeping, so it is written out separately below rather than re-entering that
  // handler. They share ONE status decision (`reconcileStatusForOwner`) and differ in what else they
  // are allowed to touch.
  const unsubscribeFocusOwner = useDictationStore.subscribe((s, prev) => {
    // ── THE IDLE PARK'S TWO EDGES, checked before anything else and independent of the branches
    // below: they are about the ROOM, not about the caret or the tray.
    if (s.speaking !== prev.speaking) {
      if (s.speaking) {
        // A word. Cancel any pending park, and bring the relay back if the last one already fired —
        // `maybeResumeOwnedStream` no-ops unless `streamTornDown` is set, so this cannot double-open
        // a socket that never parked.
        clearIdlePark();
        maybeResumeOwnedStream();
      } else if (!streamTornDown) {
        // Quiet. Start the clock; it re-arms itself if the room is noisy again when it expires.
        //
        // `!streamTornDown` IS THE POINT, not a defensive extra: A PARK IS MEANINGLESS WHILE THE
        // RELAY IS ALREADY TORN DOWN. Without it, `tearDownOwnedStream` re-armed the very park it
        // had just cancelled — it writes `setSpeaking(false)` a few lines after `clearIdlePark()`,
        // and zustand notifies synchronously, so a teardown that happened while the user was
        // MID-UTTERANCE ended with a fresh 60s timer armed against a socket it had just closed.
        // A minute later that timer ran the whole teardown again in the same still-focused window
        // (the terminal path retains `phase: "active"`), emitting the redundant `stop_cloud_stream`
        // the cancel exists to prevent (roborev 57804).
        //
        // Reachable exactly there: `dictation://error` sets `status: "error"` and never clears
        // `speaking`, so a mic that faults mid-word leaves `speaking: true`; the caret then landing
        // in a now-unroutable terminal tears down with the room still "noisy".
        //
        // Stated as the invariant rather than fixed by moving the `clearIdlePark()` line below the
        // write: ordering inside the teardown would then be load-bearing and silently breakable by
        // the next field added to it, whereas this holds however that function is rearranged.
        armIdlePark();
      }
    }
    if (s.focusOwner !== prev.focusOwner) {
      // A focus CHANGE: the store field IS the event, so it is the honest input here.
      notifyFocusOwner(s.focusOwner);
    } else if (s.phase !== prev.phase) {
      // A PHASE change with the caret sitting still. TWO separate consequences, and they take
      // DIFFERENT guards — which is the whole reason they are written out here rather than folded
      // into one call.
      //
      // (a) THE STATUS, unguarded. NO `isWindowActive()` TERM, deliberately: what this writes is
      // this window's OWN status, and a background window whose caret is in a terminal is already
      // described by the `window` pause term, which outranks `terminal`. A guard whose removal no
      // test can detect is the thing this branch keeps getting caught adding (roborev 55812).
      //
      // The caret is read LIVE rather than from the store's `focusOwner` mirror: that mirror is
      // written only by the app-root focus tracker, so it can lag, and reconciling a stale value
      // leaves the status exactly as wrong as no reconciliation at all.
      reconcileStatusForOwner(focusOwnerNow());

      // (b) THE BILLABLE RELAY, guarded by per-window ownership — and this is NEW on this edge.
      //
      // It used to be forbidden here, for a reason that has since expired. The prohibition existed
      // because the SEGMENT HANDLER already opened the relay on the wake word, so doing it here too
      // double-opened it (two handshakes, two first-minute debits), and because a background window
      // could call `stop_cloud_stream` on the single global relay the FOCUSED window had just
      // opened (roborev 56061). With the wake word retired, segments cannot move the phase at all —
      // so there is no second opener left to race, and if this edge did nothing the relay would
      // simply never open: Speak would arm a microphone with no cloud stream behind it.
      //
      // THE SECOND HALF OF THAT ROBOREV STILL BITES, so it keeps its guard. `phase` is a
      // CROSS-WINDOW SYNCED slice (dictationStore), so this subscriber runs in EVERY open window
      // for one tray gesture in one of them. `isCapturable()` is the same predicate the event
      // listeners use — it contains `isWindowActive()` — so only the window that can actually
      // consume the transcript touches the stream. Without it, a background window would close the
      // relay the focused one just opened, which is precisely the bug quoted above.
      const cmd = cloudStreamCommandFor(prev.phase, s.phase);
      if (cmd === "start_cloud_stream") {
        if (isCapturable()) {
          onResumeActive?.();
          // Start the idle clock WITH the socket. Without this, a user who selects Speak and never
          // says anything at all is the one case the VAD edges cannot cover — `speaking` never
          // changes, so no edge ever fires and the relay would bill indefinitely on the exact path
          // the park exists for.
          armIdlePark();
        }
      } else if (cmd === "stop_cloud_stream") {
        // Leaving the routing phase closes the socket outright, so there is nothing left to park.
        clearIdlePark();
        // Closing is gated on window ownership only, NOT on `isCapturable()`: dropping to passive
        // is itself one of the things that makes this window uncapturable (the routing gate reads
        // `phase`), so requiring capturability here would mean the relay could be opened but never
        // closed — a socket that bills until something else happens to tear it down.
        if (isWindowActive()) invoke("stop_cloud_stream").catch(() => {});
      }
    }
  });

  const cleanup = () => {
    // The park timer outlives nothing: a controller torn down mid-wait would otherwise fire against
    // a store the next controller owns, parking a relay it never opened.
    clearIdlePark();
    // safeUnlisten (not a bare `u()`): a window-close during teardown can tear down Tauri's
    // listeners map first, and a raw unlisten then throws the benign "handlerId" race. Routing
    // each call through it also means a throw can't abort the loop and leak the remaining
    // dictation listeners OR the window blur/focus removals below (sparkle teardown-leak sweep).
    unsubscribes.forEach((u) => void safeUnlisten(u));
    unsubscribeFocusOwner();
    if (hasWindow) {
      window.removeEventListener("blur", onWinBlur);
      window.removeEventListener("focus", onWinFocus);
    }
  };

  const toggle = async () => {
    const state = useDictationStore.getState();
    if (state.status === "listening") {
      // stop_dictation tears down any live relay stream in Rust, which stops server-side metering.
      await invoke("stop_dictation");
      state.setModelProgress(null);
      // The capture the fault described is gone, so the fault goes with it — otherwise a stale
      // `deadMicSilent` could let a later recovery event claim "listening" for a session that
      // no longer exists.
      state.setDeadMicSilent(false);
      state.setStatus("idle");
      state.setLevel(0);
      state.setSpeaking(false);
      state.setOnDeviceSpeech(false);
      state.setInterim("");
    } else {
      state.setError(null);
      // Not a bare "listening": see armedStatus. Arming with the caret already in a terminal must
      // read as paused-with-a-reason, not as an invitation to talk into a gate that drops everything.
      state.setStatus(armedStatus(focusOwnerNow(), terminalRoutingArmed()));
      try {
        // The cloud-dictation preference is read LIVE at the passive→active phase edge
        // (start_cloud_stream), not frozen here, so toggling the menu mid-session takes effect
        // without restarting.
        await invoke("start_dictation");
      } catch (e) {
        state.setModelProgress(null);
        state.setError(String(e));
      }
    }
  };

  return { toggle, cleanup, notifyWindowFocus, notifyFocusOwner };
}

// ---------------------------------------------------------------------------
// App-level ambient hook
// ---------------------------------------------------------------------------

/**
 * App-level dictation controller. Mount ONCE at the app root.
 *
 * Wires the on-device dictation pipeline to the send tray's mic intent: every closed VAD segment is
 * routed into the active destination while the mic is ACTIVE (Speak, or a push-to-talk hold) and
 * dropped while it is PASSIVE. `enabled` (the mute toggle) starts/stops the underlying capture.
 */
export function useAmbientVoice(): void {
  const enabled = useDictationStore((s) => s.enabled);
  const cloudDictation = useAiFeature("voiceDictation");
  const aiComposer = useAiFeature("composer");

  // If the user turns voice dictation OR the composer off WHILE a cloud stream is open, close it
  // immediately rather than waiting for the tray to move — otherwise a billable relay socket lingers
  // (and, with the composer off, streams into a sink that no longer renders). Closing the socket
  // stops the server-side meter. Idempotent; re-enabling reopens on the next phase edge.
  useEffect(() => {
    // Only when the mic is hot can a cloud stream be open, so gate on `enabled` to avoid a backend
    // round-trip on mount / benign re-renders when nothing is streaming.
    if (enabled && (!cloudDictation || !aiComposer)) {
      invoke("stop_cloud_stream").catch(() => {});
      useDictationStore.getState().setInterim("");
    }
  }, [enabled, cloudDictation, aiComposer]);

  // Open the cloud (relay) dictation window. Shared by BOTH the passive→active phase edge AND
  // focus-regain resume, so a Speak session stays active across tabbing away and back without the
  // user touching the tray. Gated on the live cloud-dictation prefs — a no-op when off, so
  // a signed-out / composer-off user never opens a stream. Metering + entitlement/affordability are
  // enforced SERVER-side by the relay: start_cloud_stream reports a NAMED `CloudStreamOutcome` when
  // it refuses (401/403/402/503, or unreachable) and dictation stays on-device; mid-stream
  // out-of-credits still arrives via the cloud-ended event. Balance updates
  // arrive via the cloud-balance event (both wired in createDictationController above).
  const openCloud = useRef(() => {
    if (!(aiFeatureNow("composer") && aiFeatureNow("voiceDictation"))) return;
    void openCloudDictationWindow({
      // Metering-only: attributes the per-minute dictation debits to the project the user is
      // dictating into. Resolved at open time; undefined when no project is selected.
      // THE RELAY'S OWN ANSWER, RECORDED — and now it is an ANSWER, not a bit. The command returns a
      // `CloudStreamOutcome` naming what happened: `opened`/`resumed`/`already_routing` mean the
      // cloud engine is live and any standing notice retires; `raced` means a stop interleaved and
      // says nothing; the rest name a specific cause (signed out, 401, 403, 402, 503, unreachable)
      // and dictation silently continues on-device without interim results. Only `unreachable` is
      // ambiguous enough to still need corroboration — see dictationEngineStore's
      // `classifyCloudOutcome` and OPEN_REFUSALS_BEFORE_WARNING, and the call below.
      //
      // THE ONE PLACE THIS INVOKE LIVES, which is why wiring it here covers every opener: both the
      // passive→active phase edge and the focus-regain resume reach the relay through
      // `onResumeActive` → this closure, so neither can open a stream without reporting what happened.
      // REFUSALS ARE NO LONGER INDISTINGUISHABLE HERE, and an earlier version of this note said they
      // were ("'unavailable' is the only honest reason available here"). That was true of the bool
      // and is the very thing this seam stopped doing: a 401/403/402/503 now arrives by name and is
      // reported by name. The mid-stream `cloud-ended` teardown still reports out-of-credits for a
      // stream that DIED rather than one that was refused — the two paths are complementary, not a
      // fallback for a seam that cannot tell.
      startCloudStream: async () => {
        // Clear BEFORE the invoke so the flag can only ever describe THIS attempt. A stale `true`
        // from a previous utterance would report a genuine outage as a timing fault — the same lie
        // as before, pointing the other way.
        noteCloudLateAttemptStart();
        const outcome = await invoke<CloudStreamOutcome>("start_cloud_stream", {
          project: selectedProjectName(),
        });
        const engine = useDictationEngineStore.getState();
        // ONE FACT THE OUTCOME CANNOT CARRY. `start_cloud_stream` now answers a classified
        // `CloudStreamOutcome`, and `noteCloudOutcome` routes it: `already_routing` is evidence the
        // cloud is LIVE, a named 401/402/403/503 reports at once, and only a genuine `unreachable`
        // still corroborates. That fixes what a bare `false` could not say — but BOTH of the raced
        // arms answer `Raced`, which is classified `ignore`, and `ignore` is right about billing and
        // about the counter while saying nothing to the user about why the live preview never
        // appeared. The `cloud-late` latch carries that one fact: the handshake COMPLETED and the
        // socket was then thrown away for landing after the utterance ended. Unambiguous, so it
        // reports immediately rather than spending a corroboration round on something the backend
        // already proved, and `speaks: true` because this path is not a broadcast — it runs only in
        // the window whose own `openCloud` made the attempt.
        //
        // ITS ORPHAN SIBLING HAS NO ARM HERE, DELIBERATELY (roborev 60408/60429). An orphaned
        // handshake belongs to a session the user already left, and its own attempt answers `Raced`
        // — which is already "records nothing". A latch for it could therefore only ever suppress a
        // DIFFERENT attempt's outcome, and the one outcome worth suppressing (`unreachable`) is the
        // only one that is real evidence. See dictationEngineStore for the full argument.
        //
        // CLASSIFY FIRST — THE RELAY'S OWN ANSWER OUTRANKS THE LATCH (roborev 60394). Reading the
        // latch first is what the pre-outcome branch did, and carrying that order across the merge
        // let it DISCARD the outcome: a re-hold that answered `resumed` skipped `noteCloudLive`,
        // leaving a standing banner up and the counter armed.
        const verdict = classifyCloudOutcome(outcome);
        if (verdict.kind === "live" || verdict.kind === "definitive") {
          engine.noteCloudOutcome(outcome);
        } else if (sawCloudLateThisAttempt()) engine.noteCloudConnectedLate(true);
        else engine.noteCloudOutcome(outcome);
        // THE CAUSE, AT THE SOURCE — deliberately in the log and NOT in the banner. The store holds
        // only a coarse reason on purpose (copy rules: no raw errors, no status codes), which is
        // right for the user and useless for diagnosis. This is the transition record that answers
        // "is it flapping, and how often": one line per open attempt with the running count of
        // consecutive refusals and whether this one crossed into a warning. No transcript, no PII.
        console.info("[dictation] cloud open attempt", {
          // THE CAUSE, BY NAME. This line used to carry a bare `opened: false`, which is precisely
          // the log you cannot debug from — it is the same string whether the relay was down, the
          // token was stale, or nothing was wrong at all.
          outcome,
          consecutiveRefusals: useDictationEngineStore.getState().openRefusals,
          warning: useDictationEngineStore.getState().fallbackReason,
          at: new Date().toISOString(),
        });
        return outcome;
      },
      stopCloudStream: () => void invoke("stop_cloud_stream").catch(() => {}),
      isStillActive: () =>
        useDictationStore.getState().phase === "active" &&
        aiFeatureNow("composer") &&
        aiFeatureNow("voiceDictation"),
      clearInterim: () => useDictationStore.getState().setInterim(""),
    });
  });

  /**
   * Stable segment handler: deliver a COMMITTED segment to whichever destination is bound.
   *
   * ── THIS USED TO BE A STATE MACHINE. IT IS NOW A GATE ───────────────────────────────────────────
   * Every committed segment ran through `wakeMachine.advance`, which could START dictation (a wake
   * word in a passive segment), END it (a stop word in an active one), and STRIP the matched phrase
   * out of the text before delivering the remainder. That is all gone with the wake word, and what
   * survives is the one branch that was doing the real work: route the words when the mic is
   * routing, drop them when it is not.
   *
   * TWO THINGS WENT WITH IT, deliberately, because neither has anything left to guard:
   *  - the 750ms transition cooldown, which debounced two spoken transitions landing back to back.
   *    Phase edges now come from a tray gesture or a key hold, which the user cannot emit at that
   *    rate — and if they somehow did, `usePushToTalk`'s own `repeat`/`held` guards already own it.
   *  - the phase write itself. A segment moving the phase is exactly the "something changed the
   *    microphone behind the user's back" defect the retirement exists to delete; the tray is the
   *    only writer now (voice/dictationPhase).
   *
   * WHAT IS NOT DROPPED: the destination split. A terminal-bound segment is handed BACK for the
   * caller to type — it owns the danger guards for writing into a live PTY — rather than inserted
   * here. Reaching this function at all already means the routing gate passed.
   */
  const onSegment = useRef((seg: string, ctx: { terminal: boolean } = { terminal: false }) => {
    const store = useDictationStore.getState();
    // The mic is armed but not routing — Push to talk between holds. The words are not addressed to
    // anything, so they are dropped rather than inserted somewhere the user is not looking.
    if (store.phase !== "active") return ctx.terminal ? null : undefined;
    const text = seg.trim();
    if (!text) return ctx.terminal ? null : undefined;
    if (ctx.terminal) return text;
    store.insert(text);
    return null;
  });

  // Register the dictation event listeners once.
  const controllerRef = useRef<DictationController | null>(null);
  // Holds the in-flight promise so the enabled effect can gate start_dictation
  // on listeners being fully attached (fix for startup race).
  const controllerPromiseRef = useRef<Promise<DictationController> | null>(null);
  useEffect(() => {
    let cancelled = false;
    const p = createDictationController({
      onSegment: onSegment.current,
      onResumeActive: () => openCloud.current(),
    });
    controllerPromiseRef.current = p;
    p.then((ctrl) => {
      if (cancelled) ctrl.cleanup();
      else controllerRef.current = ctrl;
    });
    return () => {
      cancelled = true;
      controllerRef.current?.cleanup();
      controllerRef.current = null;
      controllerPromiseRef.current = null;
    };
  }, []);

  // Start/stop the mic to match `enabled`.
  useEffect(() => {
    let activeRun = true;
    const store = useDictationStore.getState();
    if (enabled) {
      store.setError(null);
      // Optimistic: the real arm can be minutes of model download away, and a dead-looking button is
      // worse. KNOWN GAP: if that start aborts (a stop landed first), nothing retracts this — the
      // ring keeps claiming to listen until the else-branch below settles it on the next mute. A
      // `dictation://not-armed` broadcast was tried and removed; matching it to per-window intent
      // needs a monotonic start id echoed back from Rust. See
      // PRD/sparkle/mic-multi-window-start-stop-race.md.
      //
      // Optimistic about the DOWNLOAD, never about WHERE the caret is (armedStatus, roborev 55497).
      // THIS IS THE PRODUCTION ARM PATH — the mic button and the voice menu both arm via
      // `setEnabled(true)`, which lands here; `toggle` on the controller has no caller in the app
      // (roborev 55555). It is also the launch path (`enabled` persists across restarts) and the
      // cross-window path (`enabled` is the synced slice), which are the arms that reach the paused
      // branch below without any click of ours to have moved the caret — see `armedStatus` for why
      // the same-document click cases are NOT claimed here (roborev 55589).
      //
      // Through the shared `focusOwnerNow` seam, not an inline re-read: that duplication is what left
      // this path — the one that actually runs — without anything a test could reach.
      // …and never about whether that terminal can RECEIVE the phrase. Passing the same term the
      // routing gate uses is what stops this path claiming "paused" over a sink that is typing —
      // arming from the mic pill sets `enabled` AND `phase: "active"` at once, so this is reachable
      // with no focus change to correct it afterwards (roborev 56038).
      store.setStatus(
        armedStatus(
          readFocusOwnerFromDom(),
          terminalRoutingArmedFor({
            enabled: store.enabled,
            errored: store.status === "error",
            woken: store.phase === "active",
          }),
        ),
      );
      // Wait until the dictation listeners are attached before starting capture,
      // so the first VAD segment after launch isn't dropped.
      (controllerPromiseRef.current ?? Promise.resolve(null))
        .then(() => {
          if (!activeRun) return;
          invoke("start_dictation").catch((e) => {
            store.setModelProgress(null);
            store.setError(String(e));
            store.setEnabled(false); // permission denied / no device → fall back to muted
          });
        })
        .catch((e) => {
          // Controller creation (listen()) failed — fall back to muted with a visible error
          // rather than leaving enabled=true with a silently dead mic.
          if (!activeRun) return;
          store.setError(String(e));
          store.setEnabled(false);
        });
    } else {
      // Muting the mic tears down dictation in Rust, which closes any relay stream (stopping
      // server-side metering). The Rust stop also bumps the stop epoch so an in-flight
      // start_dictation still downloading the model aborts instead of resurrecting a live capture
      // under a muted UI (see dictation.rs). Reset ALL runtime UI state here so muting can never
      // leave a desynced view: clear status/level/speaking/phase/interim AND any lingering
      // model-download progress (a mute mid-download would otherwise keep the "Downloading…" pill
      // up; the aborted start emits no further capture events to clear it).
      invoke("stop_dictation").catch(() => {});
      store.setStatus("idle");
      store.setLevel(0);
      store.setSpeaking(false);
      store.setOnDeviceSpeech(false);
      store.setPhase("passive");
      store.setInterim("");
      store.setModelProgress(null);
      // Muting tears the capture down, so the dead-mic fault it described is over too. Left set, a
      // later recovery event could re-assert "listening" against a session that no longer exists.
      store.setDeadMicSilent(false);
    }
    return () => { activeRun = false; };
  }, [enabled]);
}
