// WHO owns the keyboard right now, and therefore whether dictation may route speech here at all.
//
// DICTATION FOLLOWS FOCUS. Tabbing to another app already pauses it (dictation://focus, and the
// per-window blur handoff in useDictation). A TERMINAL pane inside our own window was the hole: it
// is a live PTY that OWNS the keyboard, so every keystroke — and every dictated word — belongs to a
// process the composer can't see. Dictation used to half-pause there: transcription kept running,
// auto-send never armed, and nothing on screen said so. That is strictly worse than either honest
// answer, so a terminal now pauses on the same terms as a lost window.
//
// SCOPE, deliberately narrow. Only a terminal counts. NOT a dialog, a menu, a button, or `body`:
// the concierge compose box holds the app-wide dictation insert target WITHOUT holding DOM focus
// (see useConciergeDictation), and the flagship hands-free flow is saying "Hey Sparkle …" with the
// caret nowhere in particular. Pausing on every non-composer target would kill wake-word dictation
// outright. A terminal is different IN KIND — not "some other element", but another keyboard owner.
//
// Pure + exported so the classification and the precedence are unit-tested directly without React,
// Tauri, or a DOM (this codebase's convention — cf. deriveMicPresentation, classifyVoiceError). The
// tracker that feeds it lives in dictationFocusTracker.ts; the words it selects live in
// dictationCopy.ts; the gate it decides lives in useDictation.ts.

/** Who holds the DOM caret, reduced to the only distinction dictation routing cares about. */
export type FocusOwner =
  | "terminal" // an xterm surface — a live PTY that owns the keyboard
  | "other"; // anything else, INCLUDING nothing at all (the hands-free case)

/** Why dictation is paused for this window, or null when it is free to route.
 *  Ordered by the precedence {@link dictationPauseReason} applies. */
export type PauseReason =
  | "window" // this window is not the active OS window
  | "terminal"; // the caret is in a terminal pane inside this window

/** Marker the app puts on the element xterm is mounted into (components/Terminal.tsx). An
 *  APP-OWNED attribute is the stable half of the match: xterm's own class names are a vendor
 *  detail that a major bump can rename, and if that ever happens the DOM this app builds still
 *  carries this. */
export const TERMINAL_SURFACE_ATTR = "data-terminal-surface";

/** Matches the terminal surface and everything inside it. Both halves are load-bearing:
 *  - `[data-terminal-surface]` — our own wrapper (see above).
 *  - `.xterm*` — xterm's own root, screen, and (crucially) `.xterm-helper-textarea`, the hidden
 *    textarea that actually holds the caret while a terminal has focus. It is what the focus trace
 *    recorded in the field (`activeElement=textarea .xterm-helper-textarea`), and it is kept here
 *    as a belt-and-braces match in case a terminal is ever mounted without the wrapper. */
const TERMINAL_SELECTOR = `[${TERMINAL_SURFACE_ATTR}],.xterm,.xterm-screen,.xterm-helper-textarea`;

/** Classify the element that holds the caret. `closest` matches the element ITSELF as well as its
 *  ancestors, so the helper textarea resolves on its own class without needing the wrapper.
 *  Null/undefined (no focused element at all) is "other" — that is the hands-free wake-word case,
 *  which must never be treated as a pause. */
export function classifyFocusOwner(el: Element | null | undefined): FocusOwner {
  // Guard the call rather than the type: `document.activeElement` can hand back an SVGElement or a
  // stale node, and a missing `closest` must degrade to "not a terminal" (routing stays on) rather
  // than throwing inside a focus handler.
  if (!el || typeof el.closest !== "function") return "other";
  try {
    return el.closest(TERMINAL_SELECTOR) ? "terminal" : "other";
  } catch {
    return "other";
  }
}

/** WHICH agent's terminal holds the caret — set beside {@link TERMINAL_SURFACE_ATTR} on the same
 *  element, so one `closest` finds both. Separate from the surface marker because the surface marker
 *  is a boolean the focus classifier tests for presence, and a value that is sometimes absent would
 *  make `[data-terminal-surface]` stop matching a terminal whose id hasn't resolved yet. */
export const TERMINAL_AGENT_ATTR = "data-terminal-agent-id";

/**
 * The agent whose terminal owns the caret, or null when none does.
 *
 * ══ WHY THE DOM, AND NOT THE CABLE ══════════════════════════════════════════════════════════════
 * The cockpit's cable already names an agent, and reusing it would avoid a second source of truth —
 * but it answers "what is the concierge MOUNTED to", which is only the same agent once clicking a
 * terminal auto-mounts. It does not today. Routing dictated speech by the cable in the meantime
 * would type into whichever agent the concierge was last aimed at, which can be a different pane
 * from the one the user is looking at and typing in. The caret is the honest answer to "where is the
 * user working", and it is the question this routes on.
 *
 * NULL IS "NO TERMINAL", never a default agent. An unresolvable caret must refuse, because the cost
 * of guessing is a phrase typed into someone else's session.
 */
export function focusedTerminalAgentId(): string | null {
  if (typeof document === "undefined") return null;
  return terminalAgentIdOf(document.activeElement);
}

/** {@link focusedTerminalAgentId} for an element you already hold, rather than for the live caret.
 *
 *  Split out so a caller that was HANDED an element (a focus guard inspecting the element that holds
 *  the caret, say) answers about THAT element instead of re-reading `document.activeElement` — two
 *  reads of a moving value in one decision is how a guard ends up describing one element and acting
 *  on another. `focusedTerminalAgentId` is this function applied to the live caret, so the two cannot
 *  disagree about what a terminal is. */
export function terminalAgentIdOf(el: Element | null | undefined): string | null {
  if (!el || typeof el.closest !== "function") return null;
  try {
    // Scoped to the ATTRIBUTE, not to TERMINAL_SELECTOR: matching the wider selector and then
    // reading the id off it would resolve null for xterm's helper textarea (which carries the caret
    // but not our attribute) and quietly refuse every real dictation. `closest` walks ancestors, so
    // the textarea finds the host div that does carry it.
    const host = el.closest(`[${TERMINAL_AGENT_ATTR}]`);
    return host?.getAttribute(TERMINAL_AGENT_ATTR) || null;
  } catch {
    return null;
  }
}

export interface TerminalRoutingInput {
  /** The mic's own on/off, as the user set it. */
  enabled: boolean;
  /** Is dictation in a fault state? A faulted mic types nowhere. */
  errored: boolean;
  /** THE WAKE GATE — has dictation been woken (`phase === "active"`), not merely armed? */
  woken: boolean;
}

/**
 * Can a committed phrase be typed into a focused terminal right now — the mic-state half of the
 * question, with the caret half left to the caller.
 *
 * ══ WHY THIS IS A SHARED FUNCTION AND NOT AN INLINE `&&` ════════════════════════════════════════
 * It had been inline in the controller only, so the PRODUCTION ARM PATH (the `enabled` effect —
 * `toggle` has no caller in the app) never learned the term. The result was the precise contradiction
 * this feature exists to delete, one layer over: arming from the mic pill with the caret already in a
 * terminal wrote `status: "idle"`, so every surface rendered *"Listening paused: Your cursor is in a
 * terminal"* while the sink was busy typing into that same terminal, and nothing corrected it because
 * `notifyFocusOwner` fires only on a focus CHANGE and the caret never moved (roborev 56038).
 *
 * Anything that decides whether a terminal is a destination — the routing gate, the arm status, the
 * paused COPY — calls this, so they cannot disagree.
 */
export function terminalRoutingArmed(i: TerminalRoutingInput): boolean {
  return i.enabled && !i.errored && i.woken;
}

export interface DictationPauseInput {
  /** Is THIS window the active OS window? */
  windowFocused: boolean;
  /** Who holds the caret within it — see {@link classifyFocusOwner}. */
  focusOwner: FocusOwner;
  /** Is the mic armed at all? A disarmed mic has no dictation to pause. */
  enabled: boolean;
  /**
   * Can a committed phrase actually be TYPED into the focused terminal right now?
   *
   * This is what turns a terminal from a PAUSE into a DESTINATION. The header above describes the
   * terminal as "another keyboard owner" that dictation must yield to — true while there was nowhere
   * for the words to go, and false once they can be typed at the agent's own input line.
   *
   * Defaults false so every existing caller keeps the original meaning: the caller that flips it
   * (useDictation) is the one that also owns the delivery, so the copy can never claim to be routing
   * into a terminal that nothing is writing to.
   */
  terminalRoutes?: boolean;
}

/** THE single precedence decision for "is dictation paused here, and why".
 *
 *  Highest first:
 *    1. not armed  → null. Nothing is being dictated, so nothing is paused; saying "paused" about a
 *       mic the user switched OFF would be a second, contradictory story about the same mic.
 *    2. window     → the window is not the active one. OUTRANKS terminal on purpose: the caret can
 *       still be sitting in a terminal while the user is away in another app, and the true, useful
 *       thing to say then is "you're in another window", not "you're in a terminal".
 *    3. terminal   → the caret is in a live PTY inside this window.
 *
 *  Both the routing gate (useDictation) and both mic surfaces' copy call THIS function, which is
 *  what makes "what we transcribe" and "what we claim to be doing" the same decision. */
export function dictationPauseReason(i: DictationPauseInput): PauseReason | null {
  if (!i.enabled) return null;
  if (!i.windowFocused) return "window";
  // A terminal that can RECEIVE the phrase is not a pause — the words have somewhere to go, so
  // saying "dictation is paused, you're in a terminal" while typing into that very terminal would be
  // the app narrating the opposite of what it is doing. See `terminalRoutes`.
  if (i.focusOwner === "terminal" && !i.terminalRoutes) return "terminal";
  return null;
}

/** The `status` an ARM is allowed to claim — the arm being an unmute, a mic-button toggle, or a
 *  launch with `enabled` already persisted true.
 *
 *  WHY THIS EXISTS (roborev 55497, High). The pause above is driven by focus TRANSITIONS, and an arm
 *  is not a transition: the caret does not move when the user clicks the mic. So every arm path used
 *  to assert `"listening"` outright, and arming with the caret already in a terminal produced the
 *  precise half-state this feature exists to delete — the routing gate discarded every event while
 *  deriveMicPresentation, seeing `"listening"`, painted `passiveWaiting` on both surfaces: *"Mic
 *  paused. Say Hey Sparkle to activate"*. An invitation to speak, over a pipeline guaranteed to
 *  throw the words away, with the terminal copy suppressed because that only renders under
 *  `focusPaused`. Nothing corrected it either, since the next focus CHANGE might be minutes away.
 *
 *  WHICH PATHS ACTUALLY REACH THIS (roborev 55555 — an earlier version of this paragraph got it
 *  wrong, and the correction matters more than the claim did). It said: in WKWebView, clicking a
 *  `<button>` does not move focus off a focused textarea, so clicking the mic ring with the caret in
 *  an xterm pane leaves `activeElement` on `.xterm-helper-textarea`. **dictationFocusTracker's own doc
 *  asserts the direct opposite for the same gesture on the same platform** — that WebKit blurs the
 *  focused element without focusing the button unless Full Keyboard Access is on — and that is the
 *  claim with live code riding on it (the `focusout` listener + deferred read exist because of it).
 *  Both cannot hold. Neither was measured here, so this doc does not pick a winner; it stops resting
 *  on the contested one.
 *
 *  On the tracker's reading, a mic-ring CLICK never reaches this branch at all: focus lands on
 *  `<body>` or the button, `classifyFocusOwner` says "other", and the arm claims "listening"
 *  correctly. EVERY in-app arm control is a same-document `<button>` click and so carries exactly
 *  that same uncertainty — the ring (MicButton), and the voice menu's toggle too, which is a
 *  `SettingCheckbox` rendering a plain `<button type="button" onClick>`. Do not list the menu as a
 *  path that escapes the doubt; it is the same gesture (roborev 55589).
 *
 *  The paths that reach this branch under EITHER reading are the ones with no click in THIS document
 *  to move the caret:
 *    - a relaunch (or window reopen) with `enabled` already persisted true and focus restored into a
 *      terminal pane — no focus transition follows, so the transition-driven gate never fires;
 *    - an unmute performed in ANOTHER Sparkle window: `enabled` is the persisted slice and is
 *      cross-window synced (`sparkle://dictation-changed`), so this effect runs here with the caret
 *      untouched and no click of ours to have blurred it;
 *    - `dictation://audio-recovered`, whose sibling handler already carried this term.
 *
 *  Those three justify the branch on their own. The same-document clicks may or may not join them,
 *  and a keyboard shortcut is NOT on the list because no key handler arms the mic today — the only
 *  registered accelerator is `[capture].popover_shortcut`.
 *
 *  `"idle"` is what makes the surfaces honest: deriveMicPresentation maps any non-`"listening"`
 *  status to `focusPaused`, which is the one arm that renders the paused copy WITH its cause. The
 *  mic still arms (`enabled` is untouched) and capture still starts — leaving the terminal then
 *  resumes through notifyFocusOwner's existing guard, so a caret in a terminal costs the user a
 *  pause, never a re-arm.
 *
 *  Deliberately keyed on `focusOwner` ALONE, not the full pause reason: the window term is a race
 *  at arm time (`document.hasFocus()` can read false for a beat while the click that armed the mic
 *  is still settling), and treating that as a pause would show "you're in another window" to a user
 *  looking straight at it. The terminal term has no such race — the caret is wherever it is. */
export function armedStatus(
  focusOwner: FocusOwner,
  terminalRoutes = false,
): "listening" | "idle" {
  // Carries the same `terminalRoutes` term as dictationPauseReason, and MUST: this function exists
  // because arming is not a focus transition, so it is the only thing that decides the status in
  // that window. If it kept saying "idle" for a terminal that now receives phrases, arming with the
  // caret already in one would paint "paused" over a pipeline that is actively typing.
  return focusOwner === "terminal" && !terminalRoutes ? "idle" : "listening";
}

/** Who holds the caret RIGHT NOW, read from the live DOM, with the document-less (node/test) host
 *  answering "other" so nothing pauses a mic in an environment that has no caret to move.
 *
 *  One exported function rather than the same ternary written out at each call site: it was
 *  duplicated verbatim in two places, and the second copy was the PRODUCTION arm path, which meant
 *  the path that actually runs when a user arms the mic had no seam a test could reach (roborev
 *  55555). Reading live is deliberate — see the `focusOwner` option on the controller: the store's
 *  mirror exists for the reactive COPY, whereas anything deciding where to route re-reads the DOM so
 *  it cannot act on a stale observation. */
export function focusOwnerNow(): FocusOwner {
  return typeof document === "undefined" ? "other" : classifyFocusOwner(document.activeElement);
}
