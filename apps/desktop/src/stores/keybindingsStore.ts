// Per-user configurable keyboard shortcuts, persisted to localStorage. Read synchronously by the
// live key handlers (useHintMode, the composer⇄terminal toggle) and edited in the ⋯ Settings →
// Shortcuts pane. These are UI preferences (not workflow/engine config), so they live here rather
// than in config.toml.
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { KeyBinding } from "../keyboardHints/keybindings";

// The shortcuts a user can rebind. Add an id here + a default below + a row in KeyboardShortcutsMenu.
export type ShortcutId = "toggleHints" | "toggleComposer";

export const SHORTCUT_DEFAULTS: Record<ShortcutId, KeyBinding> = {
  // Tap Control to show/hide the keyboard-hint chiclets.
  toggleHints: { kind: "tap", modifier: "Control" },
  // ⌘J toggles focus between the composer and the terminal.
  toggleComposer: { kind: "chord", meta: true, ctrl: false, alt: false, shift: false, key: "j" },
};

// `allowsTap`: whether a lone-modifier TAP is a valid gesture for this shortcut. Only the hint
// overlay runs a tap state machine; the composer toggle is matched in keydown handlers (no keyup),
// so a tap binding there would silently never fire — the capture UI rejects taps for it.
export const SHORTCUT_LABELS: Record<ShortcutId, { title: string; blurb: string; allowsTap: boolean }> = {
  toggleHints: { title: "Show shortcut hints", blurb: "Pops the gold chiclet overlay over clickable controls.", allowsTap: true },
  toggleComposer: { title: "Composer ⇄ Terminal", blurb: "Improve-Sparkle pane only: move focus between its prompt box and terminal. (Builder agents have no terminal composer — the Sparkle box is the composer.)", allowsTap: false },
};

interface KeybindingsState {
  bindings: Record<ShortcutId, KeyBinding>;
  setBinding: (id: ShortcutId, binding: KeyBinding) => void;
  resetBinding: (id: ShortcutId) => void;
  /** Which shortcut the "Press a key…" UI is currently recording, or null.
   *
   *  Lives in the store rather than as KeyboardShortcutsMenu's local state because GLOBAL chord
   *  handlers have to be able to stand down while a capture is live, and they cannot see a
   *  component's `useState`. The capture handler's own `stopPropagation()` is not enough: it is on
   *  `window` in the capture phase, and so are the global handlers, but `stopPropagation` does not
   *  stop other listeners on the SAME node — and the globals register at app mount, long before the
   *  user clicks "Press a key…", so they run FIRST regardless. Without this flag, recording a
   *  binding also fires whatever global chord the user happens to press. */
  capturingShortcut: ShortcutId | null;
  setCapturingShortcut: (id: ShortcutId | null) => void;
}

export const useKeybindingsStore = create<KeybindingsState>()(
  persist(
    (set) => ({
      bindings: { ...SHORTCUT_DEFAULTS },
      setBinding: (id, binding) => set((s) => ({ bindings: { ...s.bindings, [id]: binding } })),
      resetBinding: (id) => set((s) => ({ bindings: { ...s.bindings, [id]: SHORTCUT_DEFAULTS[id] } })),
      capturingShortcut: null,
      setCapturingShortcut: (id) => set({ capturingShortcut: id }),
    }),
    {
      name: "sparkle-keybindings",
      storage: createJSONStorage(() => localStorage),
      // Only the bindings persist. `capturingShortcut` is transient UI state — writing it would
      // mean a relaunch mid-capture came back believing it was still recording, and every global
      // chord would stay dead with no visible cause. (`merge` below already rebuilds everything but
      // `bindings` from defaults, so this is belt-and-braces; it keeps the flag out of localStorage
      // entirely rather than relying on the read side to discard it.)
      partialize: (s) => ({ bindings: s.bindings }) as unknown as KeybindingsState,
      // Merge persisted bindings over the defaults so a newly-added ShortcutId always has a value
      // even when an older persisted blob predates it.
      merge: (persisted, current) => {
        const p = persisted as Partial<KeybindingsState> | undefined;
        return { ...current, bindings: { ...SHORTCUT_DEFAULTS, ...(p?.bindings ?? {}) } };
      },
    },
  ),
);

/** "A rebinding capture is live — global chord handlers must stand down."
 *
 *  Every window-level chord handler calls this and returns early when it is true. It exists as one
 *  exported function rather than three inline `getState()` reads because the requirement is a
 *  CONTRACT the store owns, and a handler that quietly forgets to honor it is invisible: the bug is
 *  "recording a binding also triggered the thing I was rebinding", which nobody attributes to a
 *  missing line in an unrelated hook. `keybindingsStore.rebindStandDown.test.ts` enumerates the
 *  handlers and fails when a new one appears without the guard, which a comment could not do.
 *
 *  Read via `getState()`, not a selector, so calling it inside a listener never re-subscribes and
 *  never re-registers the listener. */
export function isRebinding(): boolean {
  return useKeybindingsStore.getState().capturingShortcut !== null;
}
