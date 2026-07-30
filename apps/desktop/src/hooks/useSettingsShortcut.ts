// useSettingsShortcut — ⌘, (Ctrl+, elsewhere), the platform-standard "open Settings" gesture.
//
// WHY THIS EXISTS. It didn't. There was no `,` key handler anywhere in the frontend, and no menu
// item carrying the accelerator either: `app_menu.rs` starts from Tauri's `Menu::default`, which
// has no Preferences/Settings item on any platform, and the one custom item it adds deliberately
// takes `None::<&str>` for its accelerator. So the most reflexive gesture a Mac user makes did
// nothing at all, in every focus context equally. This was a MISSING FEATURE, not a binding that
// some other handler was swallowing.
//
// WHY `window` + CAPTURE. The press has to be heard wherever focus happens to be — the composer, a
// focused terminal, plain `body` after a click on chrome, or on top of an already-open modal. A
// component-local `onKeyDown` only sees what React's tree delivers it, so it misses `body` and any
// subtree it doesn't own; and xterm.js consumes keys that reach its hidden textarea, but it does so
// on the BUBBLE path — never in capture. `window` + capture is therefore the single binding site
// that hears the chord in all four contexts. `useCommandPalette` (⌘K) already leans on exactly this
// for exactly this reason; this is the same shape, deliberately.
//
// WHY IT ONLY *REQUESTS*. This hook does not own, render, or even import the settings dialog. It
// sets `uiStore.settingsRequest` via `openSettings` — the same deep-open seam AuthStatusButton uses
// for "accounts" and BalanceBadge for "credits" — and whichever component currently hosts the
// dialog honors it. That indirection is the point: the host has moved before (TopBar → the kebab)
// and is moving again, and a shortcut wired straight into a component would break each time.
import { useEffect } from "react";
import { log } from "../logger";
import { isRebinding } from "../stores/keybindingsStore";
import { useUiStore, type CategoryId } from "../stores/uiStore";

/** Pane ⌘, lands on. Matches `SettingsDialog`'s own `initialCategory ?? "ai"` default, so the
 *  shortcut and clicking "Settings" in the menu open the same place rather than disagreeing. */
export const SETTINGS_SHORTCUT_CATEGORY: CategoryId = "ai";

/** Is this keydown the Settings chord? ⌘, on macOS, Ctrl+, elsewhere (the VS Code / GTK form).
 *
 *  Alt is excluded so ⌥⌘, can be bound to something else later without colliding. Shift is
 *  excluded belt-and-braces: shift+comma already produces `"<"` rather than `","`, so the guard is
 *  redundant on a US layout, but it keeps the chord strictly defined on layouts where it isn't.
 *  Pure, and exported, so the matching rules are pinned by tests without a DOM. */
export function isSettingsShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ",";
}

/** Bind ⌘, app-wide. Mount ONCE (App.tsx) — a second mount would request the same category twice
 *  per press, which is harmless today but only by accident. Paints nothing. */
export function useSettingsShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSettingsShortcut(e)) return;
      // STAND DOWN while the Shortcuts pane is recording a new binding. That handler is also on
      // `window` in capture, but this one registers at app mount — long before the user clicks
      // "Press a key…" — so it runs FIRST, and the recorder's `stopPropagation()` cannot stop a
      // listener already invoked on the same node. Without this, pressing ⌘, to record a binding
      // also opened Settings on the "ai" pane, which unmounted the recorder mid-gesture. Read live
      // via getState so this never re-subscribes.
      if (isRebinding()) return;
      // preventDefault even though WebKit has no default action for ⌘, — an unhandled ⌘-chord
      // arriving at a focused text field is what makes macOS beep, which reads as "the app ignored
      // me" and is precisely the complaint this fixes.
      e.preventDefault();
      log.info("ui", "settings shortcut pressed");
      useUiStore.getState().openSettings(SETTINGS_SHORTCUT_CATEGORY);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
