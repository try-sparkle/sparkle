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
  toggleComposer: { title: "Composer ⇄ Terminal", blurb: "Move focus between the prompt box and the terminal.", allowsTap: false },
};

interface KeybindingsState {
  bindings: Record<ShortcutId, KeyBinding>;
  setBinding: (id: ShortcutId, binding: KeyBinding) => void;
  resetBinding: (id: ShortcutId) => void;
}

export const useKeybindingsStore = create<KeybindingsState>()(
  persist(
    (set) => ({
      bindings: { ...SHORTCUT_DEFAULTS },
      setBinding: (id, binding) => set((s) => ({ bindings: { ...s.bindings, [id]: binding } })),
      resetBinding: (id) => set((s) => ({ bindings: { ...s.bindings, [id]: SHORTCUT_DEFAULTS[id] } })),
    }),
    {
      name: "sparkle-keybindings",
      storage: createJSONStorage(() => localStorage),
      // Merge persisted bindings over the defaults so a newly-added ShortcutId always has a value
      // even when an older persisted blob predates it.
      merge: (persisted, current) => {
        const p = persisted as Partial<KeybindingsState> | undefined;
        return { ...current, bindings: { ...SHORTCUT_DEFAULTS, ...(p?.bindings ?? {}) } };
      },
    },
  ),
);
