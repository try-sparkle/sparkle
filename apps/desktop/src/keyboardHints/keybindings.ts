// Configurable keyboard shortcuts: the binding model + pure helpers, shared by the live key
// handlers and the "Press a key…" capture UI. DOM-free so it's unit-tested in isolation.
//
// A binding is one of two shapes, because the two configurable shortcuts have different natural
// gestures and the capture UI supports both:
//   - tap:   a lone modifier pressed and released with no other key (the hint-menu trigger —
//            "tap Control"). Detected via the tap state machine (hintTrigger.ts), which needs
//            the keyUP, so it can't be matched in a plain keydown handler.
//   - chord: modifiers + a key, matched on keydown (⌘J and friends).

export type ModifierName = "Control" | "Meta" | "Alt" | "Shift";

export type TapBinding = { kind: "tap"; modifier: ModifierName };
export type ChordBinding = {
  kind: "chord";
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string; // lowercased e.key, e.g. "j"
};
export type KeyBinding = TapBinding | ChordBinding;

const MODIFIER_KEYS = new Set<string>(["Control", "Meta", "Alt", "Shift"]);
export function isModifierKey(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

const MOD_SYMBOL: Record<ModifierName, string> = { Meta: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧" };

/** Human label for a binding, e.g. "Tap ⌃ Control" or "⌘J". */
export function formatBinding(b: KeyBinding): string {
  if (b.kind === "tap") return `Tap ${MOD_SYMBOL[b.modifier]} ${b.modifier}`;
  // Order modifiers ⌃⌥⇧⌘ (Apple's convention) before the key.
  const mods = (b.ctrl ? "⌃" : "") + (b.alt ? "⌥" : "") + (b.shift ? "⇧" : "") + (b.meta ? "⌘" : "");
  return mods + b.key.toUpperCase();
}

export interface KeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  type?: string;
}

/** True when a keydown event exactly matches a CHORD binding (modifiers + key). Tap bindings
 *  never match here — they're handled by the tap state machine, which needs the key release. */
export function matchesChord(e: KeyEventLike, b: KeyBinding): boolean {
  if (b.kind !== "chord") return false;
  if (e.type !== undefined && e.type !== "keydown") return false;
  return (
    e.key.toLowerCase() === b.key &&
    e.metaKey === b.meta &&
    e.ctrlKey === b.ctrl &&
    e.altKey === b.alt &&
    e.shiftKey === b.shift
  );
}

// ── Capture: classify a "press a key" gesture into a binding ────────────────────────────────
// Feed keydown/keyup events until `binding` is non-null. A non-modifier keydown completes a
// chord immediately (reading the held modifiers); a lone modifier pressed then released with no
// other key completes a tap. A multi-modifier combo with no real key never completes (keep listening).

export type CaptureState = { firstKey: string | null; multi: boolean };
export const INITIAL_CAPTURE: CaptureState = { firstKey: null, multi: false };

export function captureReduce(
  s: CaptureState,
  e: KeyEventLike & { type: "keydown" | "keyup" },
): { state: CaptureState; binding: KeyBinding | null } {
  if (e.type === "keydown") {
    if (!isModifierKey(e.key)) {
      // A real key → chord, with whatever modifiers are currently held. Require at least one of
      // ⌘/⌃/⌥: a bare key (or Shift-only, i.e. a capital letter) would fire on every keystroke of
      // that key while typing — a footgun. With no qualifying modifier, ignore it and keep listening.
      if (!e.metaKey && !e.ctrlKey && !e.altKey) return { state: s, binding: null };
      return {
        state: INITIAL_CAPTURE,
        binding: { kind: "chord", meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, key: e.key.toLowerCase() },
      };
    }
    // Modifier down: remember the first; any further key makes this not a clean single-mod tap.
    if (s.firstKey === null) return { state: { firstKey: e.key, multi: false }, binding: null };
    return { state: { ...s, multi: true }, binding: null };
  }
  // keyup: a clean single-modifier tap completes when the first (and only) modifier is released.
  if (isModifierKey(e.key) && s.firstKey === e.key && !s.multi) {
    return { state: INITIAL_CAPTURE, binding: { kind: "tap", modifier: e.key as ModifierName } };
  }
  return { state: s, binding: null };
}
