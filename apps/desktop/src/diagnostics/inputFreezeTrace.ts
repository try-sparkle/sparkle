// Diagnostics for the "can't type in ANY box while dictation is live" freeze (bead sparkle-d2ec).
// The app logs no first-responder / keyboard-focus transitions, so a recurrence could not be pinned
// from logs. This records — PII-SAFELY — the two signals that were missing: which element holds the
// DOM caret (the first responder within the webview, recorded while speech is actively routing),
// and whether keystrokes are reaching an editable target at all (recorded ALWAYS — see below).
// It NEVER logs key values or field contents.
//
// The keydown arm is deliberately UN-gated from the mic (bead sparkle-thm9o). It used to require the
// persisted master mute to be off, which meant an app-wide freeze with dictation idle produced an
// empty log — indistinguishable from a freeze in which keystrokes never reached the webview at all.
// That ambiguity is the thing this module now exists to remove. The mic state is a FIELD of the
// line, and a `focus-trace` silence is now evidence in itself.
// The two arms' gates are still different — see `installInputFreezeTrace`.

import { isEditableElement } from "../engine/focusGuard";
import { log } from "../logger";
import type { Phase } from "../voice/dictationPhase";

/** A PII-safe descriptor of a focus/event target: STRUCTURAL identity only — tag, id, filtered
 *  class tokens, data-testid, role, contentEditable. NEVER value or textContent. Pure, so the
 *  no-PII guarantee is unit-assertable. */
export function describeFocusTarget(el: Element | null | undefined): string {
  if (!el) return "none";
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : "";
  const testid = el.getAttribute?.("data-testid");
  const role = el.getAttribute?.("role");
  const editable = (el as HTMLElement).isContentEditable ? " [ce]" : "";
  // Class tokens can carry structural hints (e.g. "xterm-helper-textarea"). Include up to 3 short,
  // non-numeric tokens; drop long or digit-heavy tokens that could be hashed/identifying.
  const cls =
    typeof el.className === "string"
      ? el.className
          .split(/\s+/)
          .filter((c) => c && c.length <= 24 && !/\d{3,}/.test(c))
          .slice(0, 3)
      : [];
  return [
    tag + id,
    testid ? `testid=${testid}` : "",
    role ? `role=${role}` : "",
    cls.length ? `.${cls.join(".")}` : "",
  ]
    .filter(Boolean)
    .join(" ") + editable;
}

/** The two gates this trace runs on, and they are DIFFERENT — see {@link traceGates}. */
export interface TraceGates {
  /** The mic is hot (master mute off). Persisted across relaunch. */
  enabled: boolean;
  /** Speech is actually being ROUTED into a box (`enabled && phase === "active"`). */
  active: boolean;
}

/** Derive both gates from the dictation store's state. PURE and exported so the derivation itself
 *  is unit-testable: this predicate IS the roborev 54719 fix, and left inline at the single call
 *  site it was pinned by nothing — reverting it to bare `enabled` kept the whole suite green
 *  (roborev 56006), the same vacuity this commit set out to remove one level down. */
export function traceGates(s: { enabled: boolean; phase: Phase }): TraceGates {
  return { enabled: s.enabled, active: s.enabled && s.phase === "active" };
}

/** The mic's state as a FIELD of the fingerprint line, three-valued.
 *
 *  The keydown arm used to early-return on `!enabled`, so the mic was a PRECONDITION of the line.
 *  That is what made the founder's app-wide freeze unreadable (bead sparkle-thm9o): the trace wrote
 *  nothing, and no one could tell "keystrokes never reached the webview" from "the master mute was
 *  off, so the arm was gated out". Now the arm always runs and the mic is reported instead of
 *  gating — a silent log means keys are not arriving, full stop.
 *
 *  "off" must stay distinct from "passive": `enabled` is the persisted master mute and `active` is
 *  speech actually routing, so collapsing them would re-introduce the false claim roborev 54719
 *  removed (a merely-hot-but-paused mic described as live). */
export function micPhaseLabel(g: TraceGates): "active" | "passive" | "off" {
  if (!g.enabled) return "off";
  return g.active ? "active" : "passive";
}

/** Does this keystroke represent the user trying to TYPE TEXT?
 *
 *  The fingerprint is "I typed a character and nothing received it" — not "a key reached a
 *  non-editable element", which is ordinary: `Escape`, `Tab`, arrow navigation and every `Cmd`/`Ctrl`
 *  shortcut legitimately land on non-editable targets all day, and gating only on `enabled` (the
 *  persisted master mute) meant an unbounded WARN stream for normal keyboard use, indefinitely
 *  (roborev 56020). Space is excluded because it ACTIVATES a focused button — the one printable key
 *  with a routine non-editable destination. Prose produces plenty of non-space characters, so
 *  nothing about the freeze becomes harder to see.
 *
 *  Deliberately NOT also capped per install: after this filter every surviving line is by
 *  construction abnormal, and a hard cap would reintroduce exactly the "goes silent when it matters"
 *  failure the previous round removed. The 1/s throttle still bounds the rate. */
export function isTextKeystroke(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  return e.key.length === 1 && e.key !== " " && !e.metaKey && !e.ctrlKey && !e.altKey;
}

export interface InputFreezeTraceDeps {
  /** Read both gates. Sampled per event, so it always reflects the live store. */
  dictationState: () => TraceGates;
  doc?: Document;
  win?: Window;
  now?: () => number;
}

/** Install the trace; returns an uninstall fn.
 *
 *  The two signals are gated DIFFERENTLY, and the asymmetry is the point:
 *
 *  - **focusin** (the first-responder stream) runs only while `active` — speech actually routing.
 *    Bare `enabled` is the persisted master mute, so gating this stream on it meant every user who
 *    had ever switched the mic on kept emitting a line per focus change forever (roborev 54719).
 *  - **keydown** (the freeze FINGERPRINT) runs ALWAYS — no mic gate at all. It was gated on
 *    `enabled` (the persisted master mute), and that gate is what made the founder's app-wide
 *    freeze undiagnosable: the trace wrote nothing, and the log could not tell "keystrokes never
 *    reached the webview" from "the mic was off, so the arm never ran" (bead sparkle-thm9o). The
 *    freeze is not a dictation-only failure and it outlives the segment that caused it — it is "a
 *    global-looking freeze recoverable only by restart" — so ANY mic gate goes quiet at exactly the
 *    moment a user reacts by muting. The mic is a FIELD of the line now (`micPhaseLabel`), which is
 *    strictly more information than the gate ever provided. Bounded by `isTextKeystroke` and the
 *    1/s throttle, which is what made the previous stream tolerable (roborev 56020 / 56006). */
export function installInputFreezeTrace(deps: InputFreezeTraceDeps): () => void {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const now = deps.now ?? (() => Date.now());
  let lastFocus = "";
  // -Infinity, not 0: the throttle compares against `now()`, and seeding it at 0 swallows the FIRST
  // line for any clock whose epoch starts near zero (an injected `now` in a test, a monotonic
  // `performance.now`). Under `Date.now` it never mattered, which is exactly why it would have gone
  // unnoticed until the one line that matters went missing.
  let lastNonEditableLogAt = -Infinity;

  const onFocusIn = () => {
    if (!deps.dictationState().active) return;
    const d = describeFocusTarget(doc.activeElement);
    if (d !== lastFocus) {
      lastFocus = d;
      // INFO, deliberately. This line is the whole reason the module exists: a real user's
      // `focus-trace: activeElement=textarea .xterm-helper-textarea` in ~/Library/Logs is what
      // proved the terminal case was real. `debugForwardEnabled` defaults to DEV-only and NOTHING
      // in the app calls `setDebugForwarding`, so at `debug` this never reaches disk in a shipped
      // build — i.e. demoting it deletes the signal rather than deferring it (roborev 56006). The
      // volume worry that argued for `debug` is answered instead by the `active` gate above plus
      // the `d !== lastFocus` dedupe: it no longer fires per click for every user who ever
      // switched the mic on.
      log.info("dictation", `focus-trace: activeElement=${d}`);
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    // NO mic gate. See `micPhaseLabel`: the master mute is reported as a field, never used as a
    // precondition, so the freeze is visible whatever the mic is doing (bead sparkle-thm9o).
    // The two bounds that stopped the unbounded WARN stream are unchanged and now carry the whole
    // load — do not remove either (roborev 56020 = the filter, 56006 = the throttle).
    if (!isTextKeystroke(e)) return;
    if (isEditableElement(e.target as Element)) return;
    const t = now();
    if (t - lastNonEditableLogAt < 1000) return; // throttle: at most one line per second
    lastNonEditableLogAt = t;
    // Reports the phase it OBSERVED instead of asserting "mic live" — the old gate could not know
    // that, and said it anyway on a merely-hot-but-paused mic (roborev 54719). Carrying the phase
    // also makes the paused case readable in the log, which is the case that matters most: the
    // user has just clicked the mic down because their keyboard went dead.
    //
    // `defaultPrevented` is the discriminator this line exists for: TRUE means a global capture
    // handler swallowed the key (a stuck shortcut/menu path), FALSE means nothing consumed it and
    // the caret is simply nowhere. It was the ONE useful field the trace produced during the real
    // freeze — it is unit-pinned now so it cannot be dropped silently.
    log.warn(
      "dictation",
      `focus-trace: keydown reached NON-editable target=${describeFocusTarget(
        e.target as Element,
      )} micPhase=${micPhaseLabel(deps.dictationState())} defaultPrevented=${
        e.defaultPrevented
      } activeElement=${describeFocusTarget(doc.activeElement)}`,
    );
  };

  doc.addEventListener("focusin", onFocusIn, true);
  win.addEventListener("keydown", onKeyDown, true);
  return () => {
    doc.removeEventListener("focusin", onFocusIn, true);
    win.removeEventListener("keydown", onKeyDown, true);
  };
}
