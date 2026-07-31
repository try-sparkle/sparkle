// Which chords a rebindable shortcut may NOT be bound to, and why that check has to exist now.
//
// Before global handlers stood down during a capture (roborev 55310/55487), a colliding chord
// announced itself: recording ⌘K opened the command palette on top of the pane, recording a Control
// tap popped the chiclet overlay. Ugly, but it told the user the gesture was taken. Standing the
// handlers down removed the collision's only symptom WITHOUT removing the collision — `setBinding`
// accepts whatever the capture produces — so the recording now completes cleanly and the conflict
// becomes permanent, persisted to localStorage, and discoverable only by using the app afterwards
// (roborev 55540). Silently trading a visible annoyance for an invisible durable bug is a bad deal;
// this rejects the binding instead.
//
// Two kinds of conflict, both real:
//   - a RESERVED chord — one owned by a hard-coded global handler that is not rebindable at all
//     (⌘K opens the palette, ⌘, opens Settings). Bind Composer ⇄ Terminal to ⌘K and every press
//     both opens the palette and jumps focus, forever.
//   - another REBINDABLE shortcut's current binding, which would fire two of our own features.
//
// The reserved chords are tested with the OWNING HANDLERS' OWN exported predicates rather than a
// re-declared table of modifiers, so this cannot drift away from what actually fires. That is the
// whole reason those predicates are exported and pure.
import type { KeyBinding } from "./keybindings";
import { isPaletteShortcut } from "../components/Concierge/useCommandPalette";
import { isSettingsShortcut } from "../hooks/useSettingsShortcut";
import { SHORTCUT_LABELS, type ShortcutId } from "../stores/keybindingsStore";

/** The synthetic event a binding would produce, for feeding to the owners' predicates. */
function asKeyEvent(b: Extract<KeyBinding, { kind: "chord" }>) {
  return { key: b.key, metaKey: b.meta, ctrlKey: b.ctrl, altKey: b.alt, shiftKey: b.shift };
}

const RESERVED: { name: string; matches: (e: ReturnType<typeof asKeyEvent>) => boolean }[] = [
  { name: "the command palette", matches: isPaletteShortcut },
  { name: "Settings", matches: isSettingsShortcut },
];

/** Human reason this binding can't be used, or null if it is free.
 *
 *  `forId` is excluded from the cross-check so re-recording a shortcut to the value it already has
 *  is not reported as colliding with itself. A TAP can never collide with a reserved chord (those
 *  all require a non-modifier key), but it CAN collide with another shortcut's tap. */
export function bindingConflict(
  binding: KeyBinding,
  current: Record<ShortcutId, KeyBinding>,
  forId: ShortcutId,
): string | null {
  if (binding.kind === "chord") {
    const e = asKeyEvent(binding);
    const reserved = RESERVED.find((r) => r.matches(e));
    if (reserved) return `already opens ${reserved.name}`;
  }
  for (const [id, existing] of Object.entries(current) as [ShortcutId, KeyBinding][]) {
    if (id !== forId && sameBinding(existing, binding)) {
      return `already used by "${SHORTCUT_LABELS[id].title}"`;
    }
  }
  return null;
}

function sameBinding(a: KeyBinding, b: KeyBinding): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tap" && b.kind === "tap") return a.modifier === b.modifier;
  if (a.kind === "chord" && b.kind === "chord") {
    return (
      a.key === b.key &&
      a.meta === b.meta &&
      a.ctrl === b.ctrl &&
      a.alt === b.alt &&
      a.shift === b.shift
    );
  }
  return false;
}
