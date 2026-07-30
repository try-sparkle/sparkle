// The command palette's typed controller (bead sparkle-2yqm / CM-U5). Owns the open/closed
// state and the global ⌘K / Ctrl+K binding so the shell integrator (U7) wires the palette
// with two lines:
//
//   const palette = useCommandPalette();
//   <PaletteTrigger onOpen={palette.openPalette} />
//   <CommandPalette open={palette.open} onClose={palette.closePalette} />
//
// The listener is window-level and capture-phase so ⌘K works from anywhere — including the
// concierge compose box and a focused terminal (xterm swallows bubbling keys, not capture).
import { useCallback, useEffect, useMemo, useState } from "react";
import { isRebinding } from "../../stores/keybindingsStore";

export interface CommandPaletteController {
  /** Feed straight into CommandPalette's `open` prop. */
  open: boolean;
  openPalette: () => void;
  /** Feed straight into CommandPalette's `onClose` prop. */
  closePalette: () => void;
  togglePalette: () => void;
}

/** Is this keydown the palette shortcut (⌘K on mac, Ctrl+K elsewhere)? Pure for tests.
 *  Alt/Option excluded so option-K glyph input can't trigger it; Shift excluded so the
 *  binding is strictly ⌘K and can't collide with ⌘⇧K shortcuts. */
export function isPaletteShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

export function useCommandPalette(): CommandPaletteController {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Stand down while the Shortcuts pane is recording a binding. Same trap as ⌘, had: we are on
      // `window` in capture and registered at Workspace mount, so the recorder's `stopPropagation()`
      // cannot reach us and pressing ⌘K to record would open the palette on top of the pane.
      if (isRebinding()) return;
      if (isPaletteShortcut(e)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Stable identities: consumers wire these as props/effect deps (U7), so they must not
  // change on every open/close.
  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);
  const togglePalette = useCallback(() => setOpen((v) => !v), []);

  return useMemo(
    () => ({ open, openPalette, closePalette, togglePalette }),
    [open, openPalette, closePalette, togglePalette],
  );
}
