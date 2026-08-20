// The ONE predicate that decides whether the compose window is being USED right now — and
// therefore whether the auto-send countdown is allowed to run (bead sparkle-wfwypy).
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// WHY A PREDICATE AND NOT A LIST OF SPECIAL CASES
//
// The founder reported this as a class, twice, a month apart, and the second report is what makes
// the shape obvious:
//
//   *"when I start by talking, and then I start typing in the compose window, it's not pausing the
//    auto send."*
//   *"If I click the screenshot or the upload icons, I want you to pause the countdown while those
//    are active … because it means that I'm taking an action, basically."*
//
// Those are not two features. They are one rule — **the composer must not fire underneath a user
// who is mid-action** — reported through whichever gesture happened to bite him that week. The
// countdown grew a separate `||` term for each report, and each new gesture (a drag-select, an
// emoji picker, a slash command) would have earned another one, with the rule itself living
// nowhere and drifting apart at every call site.
//
// So the terms live HERE, in one place, and every caller asks ONE question: {@link interactionInFlight}.
// Adding a trigger is adding a term to this file and nothing else.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// TWO SHAPES OF EVIDENCE, AND THEY ARE NOT INTERCHANGEABLE
//
// Some interactions are STATES with two honest edges — an `@`-address is being composed for a
// stretch of time; a Finder panel is up until it closes. Those are booleans, and the pause lasts
// exactly as long as they are true.
//
// Others are INSTANTS with no end to observe. A keystroke is over the moment it lands; so is a
// caret move and a mention pick. There is no `keyup`-shaped event that means "and now the user has
// stopped typing", so an instant has to be given a duration — {@link TYPING_SETTLE_MS} of quiet
// after the last one. That is what `lastGestureAt` is: not "when typing began", but "when the most
// recent gesture landed", re-stamped by every keystroke so a burst of typing is ONE unbroken pause
// rather than a strobe of pause/resume that would re-anchor the clock on every character.
export const TYPING_SETTLE_MS = 1_000;

/**
 * What a single compose-window gesture WAS. The kinds exist for exactly one downstream decision —
 * whether the draft is now hand-edited (see {@link interactionEdits}) — never for the pause itself,
 * which treats all of them identically. A pause that branched on kind would be the list of special
 * cases this module exists to delete.
 */
export type ComposeInteractionKind =
  /** The draft's TEXT changed by the user's hand: typing, backspace, cut, undo/redo, an IME commit, a paste. */
  | "edit"
  /** The caret moved or a selection changed by a user gesture: arrowing, ⌘A, a click into the box, a drag-select. */
  | "caret"
  /** A name was picked from the `@`-mention list. */
  | "mention";

/**
 * Did this gesture change the DRAFT, as opposed to merely aiming at it?
 *
 * Only an edit floors the threshold (autoSendTimer `noteHandEdit`). Arrowing through a dictated
 * sentence pauses the countdown while you read it, but it leaves a purely dictated message purely
 * dictated — so the speech ladder is still the honest judge of it, and a `high`-scoring sentence
 * you merely LOOKED at keeps its fast lane.
 */
export function interactionEdits(kind: ComposeInteractionKind): boolean {
  return kind === "edit";
}

/** Every fact that can hold the countdown still. One term per way the user takes an action. */
export interface ComposeInteractionTerms {
  /** Part-way through typing an `@`-address, so the message is not finished (bead sparkle-14dtu). */
  composingMention: boolean;
  /** A native attach picker this composer opened — screenshot crosshairs, Finder panel — is on screen. */
  attachPickerOpen: boolean;
  /**
   * When the most recent discrete gesture landed, or null once it has settled.
   *
   * See the header: instants have to be given a duration, and every new gesture re-stamps this
   * rather than queueing behind the last one.
   */
  lastGestureAt: number | null;
}

/**
 * Is the user mid-action in the compose window RIGHT NOW?
 *
 * The single question every caller asks. Pure, so it is testable without a clock, a DOM, or React —
 * and so the rule can be read in one screen instead of reconstructed from the call sites.
 */
export function interactionInFlight(t: ComposeInteractionTerms, now: number): boolean {
  // Stateful terms: true for exactly as long as the action is happening.
  if (t.composingMention || t.attachPickerOpen) return true;
  // Instantaneous terms: true until the settle window since the last one closes.
  if (t.lastGestureAt === null) return false;
  return now - t.lastGestureAt < TYPING_SETTLE_MS;
}

/** A monotonic count of gestures, plus what the latest one was. See useAutoSend's arg of this name. */
export interface ComposeInteraction {
  /**
   * Bumped once per gesture. A COUNT, not a boolean, for the reason `draftGrewSeq` is one: two
   * consecutive keystrokes are two gestures, and an edge on a boolean would collapse them into one.
   */
  seq: number;
  /** Whether the gesture at `seq` changed the draft's text. Meaningless while `seq` is 0. */
  edited: boolean;
}

/** No gesture has happened yet. `seq: 0` is the sentinel every reader tests against. */
export const NO_COMPOSE_INTERACTION: ComposeInteraction = { seq: 0, edited: false };

/** Fold one gesture into the running count. */
export function noteComposeInteraction(
  prev: ComposeInteraction,
  kind: ComposeInteractionKind,
): ComposeInteraction {
  return { seq: prev.seq + 1, edited: interactionEdits(kind) };
}

/**
 * Keys that MOVE THE CARET or change the selection without producing text.
 *
 * ── WHY THIS IS A KEY LIST AND NOT REACT'S `onSelect` ──────────────────────────────────────────
 * `onSelect` is the obvious wire for "the caret moved", and it is a trap here. React implements it
 * off the DOM's `selectionchange`, which the browser also fires when a textarea's `value` is
 * assigned PROGRAMMATICALLY — and this composer's value is assigned programmatically several times
 * a second while dictation is running, as committed segments land in the box.
 *
 * Wiring the pause to `onSelect` would therefore pause the countdown on TRANSCRIPTION LAG: a
 * segment the user spoke seconds ago arrives, moves the caret to the end, and reads as "the user is
 * mid-action". That is precisely the failure autoSendTimer's header exists to prevent — the
 * deadline gets pushed out by the very chunks that are supposed to move only the threshold, and the
 * send never fires. It would also be invisible in tests: jsdom never originates `selectionchange`
 * at all (docs/jsdom-test-caveats.md), so the suite would stay green while the feature deadlocked
 * in the real app.
 *
 * A keydown is unambiguously the USER. So caret interactions are reported from the gestures that
 * cause them — these keys, plus a pointer press on the box — and never from the resulting selection
 * state. The cost is that a caret move made by some other means goes unreported; the benefit is
 * that no machine-driven edit can ever be mistaken for a human one.
 */
const CARET_KEYS: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** Is this keypress a caret/selection gesture rather than one that types a character? */
export function isCaretGestureKey(e: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): boolean {
  // ⌘A / Ctrl-A — select-all is aiming at the whole draft, and it types nothing.
  if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) return true;
  return CARET_KEYS.has(e.key);
}
