import { useCallback, useEffect, useRef, useState } from "react";
import { INITIAL_TRIGGER, reduceTrigger, type TriggerState } from "./hintTrigger";
import { matchesChord } from "./keybindings";
import { isRebinding, useKeybindingsStore } from "../stores/keybindingsStore";

// Drives the on/off state of the keyboard-hint overlay.
//
// OPEN/CLOSE is the user's configured "toggleHints" shortcut (default: a clean tap of Control — see
// hintTrigger). A TAP binding goes through the tap state machine (it needs the keyUP); a CHORD
// binding toggles on its keydown. We listen in the CAPTURE phase on the window so the event reaches
// us even when the xterm terminal has focus (xterm attaches its own keydown handler on its textarea,
// deeper in the tree; capture runs top-down so we see it first). We deliberately do NOT suppress the
// trigger when a text field is focused: a lone modifier tap types nothing, and the user wants hints
// to work while the terminal/composer is focused.
//
// Label-key SELECTION (pressing "t", "1", … to activate a control) is handled by the overlay, which
// owns the label→element map. This hook only owns open/close.
//
// ESCAPE IS DELEGATED, via `onEscape`. The overlay has an inner layer to unwind before the whole
// thing should close — the z prefix layer, and today that is the only one — and it cannot do that by
// intercepting the key itself: BOTH listeners are capture-phase on `window`, so dispatch order is
// registration order, this hook's effect runs first, and by the time the overlay sees Escape the
// overlay is already closing. stopPropagation cannot reach backwards. Handing the decision down is
// the alternative that does not depend on which effect happened to register first — a dependency
// that would break silently the day someone changed a useEffect to a useLayoutEffect.
//
// Contract: return true to say "I consumed this Escape"; the overlay stays open. Return false (or
// pass nothing) and Escape dismisses, as it always has.
export function useHintMode(onEscape?: () => boolean): { active: boolean; close: () => void } {
  const [active, setActive] = useState(false);
  const trigger = useRef<TriggerState>(INITIAL_TRIGGER);
  const binding = useKeybindingsStore((s) => s.bindings.toggleHints);

  // Read through a ref so a caller passing an inline arrow doesn't tear down and rebind the window
  // listeners on every render — the same stale-listener hazard HintOverlay documents for chiclets.
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;

  // STAND DOWN while the Shortcuts pane is recording a binding (`isRebinding`). This hook is the
  // one that most needed it: `toggleHints` is the FIRST row of that pane and its default is a bare
  // Control TAP, so recording it drives this very tap machine and pops the chiclet overlay over the
  // whole UI mid-gesture. The recorder's own `stopPropagation()` cannot prevent that — it is on
  // `window` in capture and so are we, `stopPropagation` does not stop same-node listeners, and we
  // register at mount while it registers on click, so we always run first. Applied to keyUP as well
  // as keydown, or a tap begun before the capture started would still complete through it.
  useEffect(() => {
    // A fresh binding starts the tap machine clean (a half-pressed old modifier can't leak across).
    trigger.current = INITIAL_TRIGGER;
    const modifier = binding.kind === "tap" ? binding.modifier : null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (isRebinding()) return;
      if (modifier) {
        trigger.current = reduceTrigger(trigger.current, { type: "keydown", key: e.key }, modifier).state;
      } else if (matchesChord(e, binding)) {
        // Chord trigger: toggle on the chord's keydown, and swallow it so it can't also type/route.
        // Toggle only on the leading edge — ignore OS auto-repeat keydowns while the chord is held,
        // or the overlay would flicker open/closed (the tap path is already auto-repeat-safe).
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) setActive((v) => !v);
      }
      // Escape dismisses unless the overlay claims it to unwind an inner layer first (see header).
      //
      // A CLAIMED Escape is SUPPRESSED, or the press would unwind two things at once. The key keeps
      // travelling after we handle it, and half the app dismisses on Escape — the ⋯ kebab menu and
      // the status strip from `document`, the model pill and the selection popup as they bubble,
      // and the composer lightbox, the shortcuts menu and the command palette from `window` in the
      // CAPTURE phase, same as us. With any of those open, backing out of a hint sub-layer would
      // also close the thing underneath: two layers per press, the exact behaviour this delegation
      // exists to prevent.
      //
      // stopIMMEDIATEPropagation, not stopPropagation. The plain one does not stop other listeners
      // on the SAME NODE, which is where the window/capture cohort above lives — it would have
      // covered only the document/bubble half, and registration order has no bearing on it either
      // way. The immediate form does stop same-node listeners registered after ours, and ours is
      // registered at mount while those surfaces register theirs when they open.
      //
      // preventDefault stays alongside it for the cohort that checks `defaultPrevented` rather than
      // relying on propagation (ModelPill already does; it is the tell that the app expects a
      // consumer to mark this event).
      if (e.key === "Escape") {
        if (escapeRef.current?.()) {
          e.preventDefault();
          e.stopImmediatePropagation();
        } else {
          setActive(false);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isRebinding()) return;
      if (!modifier) return;
      const out = reduceTrigger(trigger.current, { type: "keyup", key: e.key }, modifier);
      trigger.current = out.state;
      if (out.tapped) setActive((v) => !v);
    };
    // Clear any latent tap candidate when the app loses focus. Otherwise a system-level window
    // switch (Cmd+Tab / Cmd+`) — where macOS swallows the next keydown so we never see the chord —
    // leaves the tap armed; returning focus with the modifier still held and then releasing it would
    // fire a spurious "tap" and open the overlay. Always-on (not gated on `active`).
    const onBlur = () => {
      trigger.current = INITIAL_TRIGGER;
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [binding]);

  // While open, any scroll or window blur dismisses (the chiclets were positioned against the old
  // layout, and a blur means focus left the app — e.g. Cmd+Tab). A mousedown anywhere also closes.
  useEffect(() => {
    if (!active) return;
    const close = () => setActive(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("mousedown", close, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("blur", close);
    };
  }, [active]);

  // Stable identity so consumers can list it in effect deps without churning listeners.
  const close = useCallback(() => setActive(false), []);
  return { active, close };
}
