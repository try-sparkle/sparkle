import { useCallback, useEffect, useRef, useState } from "react";
import { INITIAL_TRIGGER, reduceTrigger, type TriggerState } from "./hintTrigger";
import { matchesChord } from "./keybindings";
import { useKeybindingsStore } from "../stores/keybindingsStore";

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
export function useHintMode(): { active: boolean; close: () => void } {
  const [active, setActive] = useState(false);
  const trigger = useRef<TriggerState>(INITIAL_TRIGGER);
  const binding = useKeybindingsStore((s) => s.bindings.toggleHints);

  useEffect(() => {
    // A fresh binding starts the tap machine clean (a half-pressed old modifier can't leak across).
    trigger.current = INITIAL_TRIGGER;
    const modifier = binding.kind === "tap" ? binding.modifier : null;

    const onKeyDown = (e: KeyboardEvent) => {
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
      // Escape always dismisses (cheap to handle here; the overlay also intercepts label keys).
      if (e.key === "Escape") setActive(false);
    };
    const onKeyUp = (e: KeyboardEvent) => {
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
