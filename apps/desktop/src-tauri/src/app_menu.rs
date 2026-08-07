//! The application menu bar, and the one custom item on it: View → Hide/Show Helper.
//!
//! WHY THIS EXISTS. The floating helper island is an always-on-top panel that sits over every other
//! app, and until now it could not be dismissed at all while Sparkle ran. It used to be dismissable
//! via its own right-click menu, but the only route BACK was a "Show Helper" button in the main
//! window's sidebar — so hiding the island was a one-way door the moment that button was moved or
//! deleted, which is exactly what happened. Both halves were then removed together, leaving the
//! island permanently on screen (roborev 53791-M).
//!
//! The menu bar is the fix, because it is the one surface that can never itself be hidden. With a
//! guaranteed way back, the island can be dismissable again AND the choice can persist across a
//! relaunch without stranding anyone.
//!
//! WHY WE START FROM `Menu::default`. Setting ANY application menu REPLACES the platform default —
//! including the macOS app menu (About/Services/Hide/Quit) and the Edit menu that carries ⌘X/⌘C/⌘V/
//! ⌘A. Losing ⌘C in a text-heavy app would be a far worse regression than the one this fixes, so we
//! never enumerate those items ourselves: we take Tauri's default menu and INSERT into it. There is
//! no list here that can fall out of step, and `build_augments_the_default_menu` below pins that a
//! future edit cannot quietly turn this into a hand-rolled menu.
//!
//! WHY THE STATE LIVES IN JS. The island's `enabled` flag is a localStorage-backed zustand record
//! (src/helper/helperPrefs.ts) shared by origin between the main window and the helper webview. A
//! native menu handler cannot read or write localStorage, so this module does not own the state and
//! never guesses it. Clicking the item EMITS `helper://toggle-requested`; the helper webview flips
//! the store and calls back into `set_helper_menu_state` so the label follows. One authority, one
//! direction of truth.

use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

/// Menu-item id for the helper toggle. Matched in `on_menu_event`.
pub const HELPER_TOGGLE_ID: &str = "view-helper-toggle";

/// Emitted when the user picks the item. Payload-free ON PURPOSE: this is a "flip it" request, not
/// a value — Rust does not know the current preference, and a native menu that shipped its own
/// opinion of the state would fight the store on any race.
///
/// Must match `HELPER_TOGGLE_REQUESTED` in src/services/helper.ts — asserted by a test below, not
/// merely by this comment.
pub const HELPER_TOGGLE_EVENT: &str = "helper://toggle-requested";

/// The submenu we hang the item off. macOS's default menu already HAS a View menu (it holds Enter
/// Full Screen), so we extend that one rather than adding a second menu titled the same thing.
pub const VIEW_SUBMENU_TEXT: &str = "View";

// ── THE ESCAPE HATCH THAT CANNOT ITSELF BE WEDGED (bead sparkle-thm9o) ────────────────────────────
//
// The founder's app wedged today with "I could not unmount the concierge", and the audit that
// followed found there was NO global "release all input capture" path at all. Every hatch that
// existed ran through the webview's own DOM event pipeline, which is exactly the thing that had
// stopped answering:
//
//   - The Escape ladder failed closed on `dismissibleOpen`, and one leaked hidden `role="dialog"`
//     node disabled it app-wide (fixed separately, in engine/cable.ts).
//   - ⌘⇧U worked, but it is a `window` keydown listener like the rest: an earlier CAPTURE-phase
//     listener that stops propagation, a rebinding capture stuck latched, or focus sitting outside
//     the document entirely all defeat it — and nothing in the UI told the user it existed.
//
// A NATIVE MENU ITEM IS NOT ON THAT PIPELINE. macOS dispatches a key equivalent through the menu
// bar before the webview is consulted, and the item can be reached with the MOUSE even when the
// keyboard is captured outright — so this hatch works while the thing that trapped input is still
// mounted. The webview handler is a plain listener, but it is only ever the SECOND way in.
//
// The frontend's DOM keydown fallback (services/inputRelease.ts) is deliberately secondary for the
// same reason: it exists for the non-Tauri dev server and for a build where `build()` below could
// not attach the item, not as the mechanism.

/// Menu-item id for the input-release hatch. Matched in `on_menu_event`.
pub const INPUT_RELEASE_ID: &str = "view-release-input";

/// Emitted when the user picks the item (or presses its key equivalent). Payload-free: "let go of
/// everything" takes no argument, and Rust knows nothing about what the webview is holding.
///
/// Must match `INPUT_RELEASE_EVENT` in src/services/inputRelease.ts — asserted by a test below, not
/// merely by this comment.
pub const INPUT_RELEASE_EVENT: &str = "input://release-requested";

/// Says what it DOES, in the imperative, like every other menu verb. Not "Unstick" or "Panic":
/// someone reading this menu is already confused about why the app stopped responding, and the item
/// has to read as a deliberate action rather than as a diagnostic.
pub const INPUT_RELEASE_LABEL: &str = "Release Input";

/// ⌘⇧⎋ — "Escape, harder", which is what the gesture is.
///
/// UNLIKE the helper toggle, this item DOES take a key equivalent, and the reasoning that denied one
/// there ("a floating panel toggled by accident is worse than one that takes two clicks") inverts
/// here: an escape hatch you can only reach by opening a menu with the mouse is not much of an
/// escape hatch, and firing it by accident costs a blurred field.
///
/// IT IS DELIBERATELY NOT ⌘⇧U, the rebindable `unmountCable` chord. A native key equivalent is
/// consumed by the menu bar BEFORE the webview sees it, so giving this item ⌘⇧U would make that
/// chord permanently un-rebindable in Settings and silently dead in the webview handler that owns
/// it. Two different keys for two different scopes: ⌘⇧U unmounts the cable, ⌘⇧⎋ lets go of
/// everything.
///
/// ⌘⇧⎋ is free on macOS — ⌥⌘⎋ is Force Quit and ⌘⇧⎋ is unclaimed (the Windows Task Manager chord is
/// ⌃⇧⎋, a different modifier). `input_release_accelerator_parses` below asserts the string is one
/// muda can actually parse, because an unparseable accelerator is silent: the item still builds,
/// just without the key.
pub const INPUT_RELEASE_ACCELERATOR: &str = "CmdOrCtrl+Shift+Escape";

/// Dynamic label rather than a checkmark. A checkbox would have to be titled something static like
/// "Show Helper", which reads wrong while the island is already showing; "Hide Helper" ⇄ "Show
/// Helper" is the macOS idiom for this (Safari's Hide/Show Tab Bar) and says what the click does.
pub const LABEL_HIDE: &str = "Hide Helper";
pub const LABEL_SHOW: &str = "Show Helper";

/// The label for a given preference.
///
/// `enabled` is the PERSISTED preference, deliberately not "is the island on screen right now".
/// The island is also suppressed while Sparkle is frontmost — which is precisely when someone is
/// reading this menu — so a label driven by on-screen state would say "Show Helper" every single
/// time the menu was opened, and clicking it would do nothing visible.
pub fn helper_label(enabled: bool) -> &'static str {
    if enabled {
        LABEL_HIDE
    } else {
        LABEL_SHOW
    }
}

/// Does this submenu title name the View menu? Windows/Linux titles carry `&` mnemonic markers
/// (`&View`), and `&&` is a literal ampersand, so strip single `&`s before comparing.
pub fn is_view_submenu(text: &str) -> bool {
    text.replace("&&", "\u{0}").replace('&', "").replace('\u{0}', "&") == VIEW_SUBMENU_TEXT
}

/// Build the app menu: Tauri's platform default, plus the helper toggle at the top of View.
///
/// Fail-soft is NOT appropriate here — a `?` that bailed would leave the app with no menu bar at
/// all — so every step after the default menu is best-effort and logged. The worst case is the
/// stock menu without our item, which is the state the app shipped in before this change.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let item = MenuItem::with_id(
        app,
        HELPER_TOGGLE_ID,
        // Built showing the DEFAULT preference (visible). The helper webview pushes the real one
        // via `set_helper_menu_state` as soon as it mounts, which is well before a menu can be
        // opened — the menu bar needs the app to be frontmost, and the webview hydrates on launch.
        helper_label(true),
        true,
        // No accelerator. Every obvious ⌘-chord near "hide" is already taken on macOS (⌘H hides the
        // app, ⌥⌘H hides others), and a floating panel toggled by accident is worse than one that
        // takes two clicks.
        None::<&str>,
    )?;

    // The input-release hatch. Built FAIL-SOFT, and unlike the helper item above it never uses `?`:
    // its accelerator string is parsed by muda at construction, so a `?` here would turn one
    // unparseable accelerator into "the app has no menu bar at all" — the exact catastrophic
    // failure this module's header says a `?` must not be allowed to cause. A parse failure falls
    // back to the item with NO key equivalent, because a hatch reachable only by mouse still beats
    // no hatch, and only a failure to build even that drops it.
    let release = build_input_release_item(app);

    match view_submenu(&menu) {
        Some(view) => {
            // Top of View, above Enter Full Screen, with a separator under it.
            let separator = PredefinedMenuItem::separator(app)?;
            let mut items: Vec<&dyn IsMenuItem<R>> = Vec::with_capacity(3);
            // RELEASE INPUT FIRST. Someone opening this menu because the app stopped responding
            // should meet the hatch before anything else on it.
            if let Some(r) = release.as_ref() {
                items.push(r);
            }
            items.push(&item);
            items.push(&separator);
            if let Err(e) = view.insert_items(&items, 0) {
                tracing::warn!("could not add Sparkle's items to the View menu: {e}");
            }
        }
        None => {
            // No default View menu on this platform. Append our own rather than dropping the item —
            // the whole point is that the way back is always reachable.
            let mut items: Vec<&dyn IsMenuItem<R>> = Vec::with_capacity(2);
            if let Some(r) = release.as_ref() {
                items.push(r);
            }
            items.push(&item);
            match Submenu::with_items(app, VIEW_SUBMENU_TEXT, true, &items) {
                Ok(view) => {
                    if let Err(e) = menu.append(&view) {
                        tracing::warn!("could not append a View menu: {e}");
                    }
                }
                Err(e) => tracing::warn!("could not build a View menu: {e}"),
            }
        }
    }
    Ok(menu)
}

/// The "Release Input" item, degrading rather than failing — see the call site.
fn build_input_release_item<R: Runtime>(app: &AppHandle<R>) -> Option<MenuItem<R>> {
    match MenuItem::with_id(
        app,
        INPUT_RELEASE_ID,
        INPUT_RELEASE_LABEL,
        true,
        Some(INPUT_RELEASE_ACCELERATOR),
    ) {
        Ok(i) => Some(i),
        Err(e) => {
            tracing::warn!(
                "could not build \"{INPUT_RELEASE_LABEL}\" with accelerator \
                 {INPUT_RELEASE_ACCELERATOR} ({e}); retrying without a key equivalent"
            );
            MenuItem::with_id(app, INPUT_RELEASE_ID, INPUT_RELEASE_LABEL, true, None::<&str>)
                .map_err(|e| tracing::warn!("could not build \"{INPUT_RELEASE_LABEL}\": {e}"))
                .ok()
        }
    }
}

/// The default menu's View submenu, if this platform has one.
fn view_submenu<R: Runtime>(menu: &Menu<R>) -> Option<Submenu<R>> {
    menu.items().ok()?.into_iter().find_map(|kind| {
        let sub = kind.as_submenu()?;
        let text = sub.text().ok()?;
        is_view_submenu(&text).then(|| sub.clone())
    })
}

/// Wired into the builder's `on_menu_event`. Only our two items are handled; every other id belongs
/// to a predefined item Tauri handles itself, so anything unrecognised is ignored rather than logged.
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    if event.id() == HELPER_TOGGLE_ID {
        // Broadcast. Exactly ONE listener acts on it (HelperApp, the webview that owns the island);
        // a second handler would flip the store twice and the toggle would look dead.
        if let Err(e) = app.emit(HELPER_TOGGLE_EVENT, ()) {
            tracing::warn!("could not emit {HELPER_TOGGLE_EVENT}: {e}");
        }
    } else if event.id() == INPUT_RELEASE_ID {
        // LOGGED AT INFO, unlike the toggle. This item only ever fires because the app stopped
        // responding to the user, and the whole reason it exists is that we could not tell from the
        // logs whether that had happened. A line here plus the frontend's own (services/inputRelease
        // .ts) brackets the release: if only this one appears, the webview never received the event,
        // which is a materially different failure from a release that ran and did not help.
        tracing::info!("input release requested from the app menu");
        // Broadcast to every webview. Unlike the helper toggle, MULTIPLE listeners acting on this
        // is correct and harmless — releasing input capture is idempotent, and a wedged helper
        // webview deserves the same escape as the main one.
        if let Err(e) = app.emit(INPUT_RELEASE_EVENT, ()) {
            tracing::warn!("could not emit {INPUT_RELEASE_EVENT}: {e}");
        }
    }
}

/// Push the current preference back onto the menu item's label.
///
/// Called by the helper webview on mount and on every change, so the item follows a hide made from
/// the island's own right-click menu just as it follows one made from the menu itself. `set_text`
/// hops to the main thread internally (Tauri's `run_item_main_thread!`), so this is safe to call
/// from a command on any thread.
#[tauri::command]
pub fn set_helper_menu_state(app: AppHandle, enabled: bool) {
    let Some(menu) = app.menu() else {
        // No menu bar (a platform without one, or `build` failed). Nothing to sync, and the island
        // still works — do not treat it as an error.
        return;
    };
    let Some(item) = helper_toggle_item(&menu) else {
        tracing::debug!("helper toggle item not found in the app menu");
        return;
    };
    if let Err(e) = item.set_text(helper_label(enabled)) {
        tracing::warn!("could not relabel the helper toggle: {e}");
    }
}

/// Find the toggle wherever it ended up. `Menu::get` does NOT recurse into submenus, so the search
/// walks one level down — which is where every item on a macOS menu bar lives.
fn helper_toggle_item<R: Runtime>(menu: &Menu<R>) -> Option<MenuItem<R>> {
    for kind in menu.items().ok()? {
        let Some(sub) = kind.as_submenu() else { continue };
        if let Some(found) = sub.get(HELPER_TOGGLE_ID) {
            return found.as_menuitem().cloned();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_label_says_what_the_click_does() {
        // The whole point of a dynamic label: it must never read "Show Helper" while the island is
        // the user's current preference, and vice versa.
        assert_eq!(helper_label(true), "Hide Helper");
        assert_eq!(helper_label(false), "Show Helper");
    }

    #[test]
    fn view_submenu_is_matched_through_mnemonics() {
        assert!(is_view_submenu("View"));
        // Windows/Linux mnemonic form.
        assert!(is_view_submenu("&View"));
        assert!(!is_view_submenu("Window"));
        assert!(!is_view_submenu("Edit"));
        // A literal ampersand is `&&` and must survive, so it can't collapse into a match.
        assert!(!is_view_submenu("Vi&&ew"));
    }

    /// THE ⌘C/⌘V GUARD.
    ///
    /// Setting an app menu replaces the platform default outright, so the failure mode is silent:
    /// a hand-rolled `Menu::with_items` that forgets the Edit submenu type-checks, builds, and only
    /// shows up as "copy and paste stopped working". `Menu::default` cannot lose those items by
    /// construction, so the invariant worth pinning is that we still start from it and only INSERT.
    /// A menu built with a real runtime can't be exercised here (muda needs an event loop and a
    /// main thread), so this reads the source — the same include_str! coherence trick worktree.rs
    /// and capture_window.rs use.
    #[test]
    fn build_augments_the_default_menu_rather_than_replacing_it() {
        let src = include_str!("app_menu.rs");
        let build = src
            .split_once("pub fn build<R: Runtime>")
            .expect("build() should still exist")
            .1
            .split_once("\n/// The default menu's View submenu")
            .expect("build() should still be followed by view_submenu")
            .0;
        assert!(
            build.contains("Menu::default(app)"),
            "build() must start from Tauri's default menu — that is what keeps the macOS app menu \
             and the Edit menu's Cut/Copy/Paste/Select All alive. Building a menu from scratch \
             DROPS them, and nothing else in this app would notice."
        );
        for forbidden in ["Menu::with_items", "Menu::new(", "Menu::with_id"] {
            assert!(
                !build.contains(forbidden),
                "build() must not construct a Menu itself ({forbidden}); augment Menu::default"
            );
        }
    }

    #[test]
    fn the_typescript_listener_uses_the_same_event_name() {
        // Same coherence check capture_window.rs runs for capture://closed: a renamed event is
        // otherwise silent on both sides.
        const HELPER_TS: &str = include_str!("../../src/services/helper.ts");
        assert!(
            HELPER_TS.contains(HELPER_TOGGLE_EVENT),
            "src/services/helper.ts must listen for {HELPER_TOGGLE_EVENT}"
        );
        assert!(
            HELPER_TS.contains("set_helper_menu_state"),
            "src/services/helper.ts must invoke set_helper_menu_state to sync the menu label"
        );
    }

    /// THE ACCELERATOR MUST ACTUALLY PARSE.
    ///
    /// This is the one failure in the hatch that is completely SILENT: muda parses the string at
    /// `MenuItem::with_id`, and `build_input_release_item` deliberately degrades to an item with no
    /// key equivalent rather than taking the whole menu bar down with it. So a typo
    /// ("Cmd+Shift+Esc ", "Escape+Shift+Cmd", a renamed key token) ships a menu item that looks
    /// entirely correct, has no shortcut, and is therefore not reachable at all by someone whose
    /// keyboard is the thing that stopped working. Parsing it here is the only place that can catch
    /// it — a menu built against a real runtime cannot be exercised in a unit test (muda needs an
    /// event loop and the main thread), which is why the sibling guards read source instead.
    #[test]
    fn input_release_accelerator_parses_to_the_chord_we_documented() {
        use muda::accelerator::{Accelerator, Code, Modifiers};
        use std::str::FromStr;

        let accel = Accelerator::from_str(INPUT_RELEASE_ACCELERATOR)
            .expect("INPUT_RELEASE_ACCELERATOR must be a string muda can parse");
        // COMPARED WHOLE, not field by field: muda keeps `key`/`mods` private, so an equality
        // against a chord we build here is the only way to assert this from outside the crate — and
        // it is the stronger assertion anyway, since it pins the modifier set exactly rather than
        // checking that two specific bits are present and letting a third slip in.
        //
        // `CmdOrCtrl` resolves to Meta on macOS and Control elsewhere; build whichever this target
        // uses rather than hard-coding one and going red on the other.
        let primary = if cfg!(target_os = "macos") { Modifiers::META } else { Modifiers::CONTROL };
        let expected = Accelerator::new(Some(primary | Modifiers::SHIFT), Code::Escape);
        assert_eq!(accel, expected, "the hatch is CmdOrCtrl+Shift+Escape");
        // NOT the plain Escape the cable ladder already owns: a bare Escape as a menu key
        // equivalent would be swallowed by the menu bar and would break every in-app Escape.
        // Implied by the equality above, asserted separately because it is the failure that would
        // actually ship — a modifier dropped from the constant still parses.
        assert_ne!(
            accel,
            Accelerator::new(None, Code::Escape),
            "a bare Escape would steal the key from the whole app"
        );
    }

    /// ⌘⇧U MUST STAY THE WEBVIEW'S. A native key equivalent is consumed by the menu bar before the
    /// webview is consulted, so giving this item the rebindable `unmountCable` chord would make that
    /// chord permanently un-rebindable in Settings and silently dead in the handler that owns it.
    #[test]
    fn the_hatch_does_not_steal_the_rebindable_unmount_chord() {
        let upper = INPUT_RELEASE_ACCELERATOR.to_ascii_uppercase();
        assert!(
            !upper.ends_with("+U"),
            "INPUT_RELEASE_ACCELERATOR must not be the ⌘⇧U unmountCable chord — a menu key \
             equivalent is consumed before the webview sees it, which would kill the rebindable one"
        );
    }

    #[test]
    fn our_two_menu_items_have_distinct_ids() {
        // They are matched by id in `on_menu_event`; a collision would route one item's click to
        // the other's branch, and the `if/else if` would make it look like the second item was dead.
        assert_ne!(HELPER_TOGGLE_ID, INPUT_RELEASE_ID);
        assert_ne!(HELPER_TOGGLE_EVENT, INPUT_RELEASE_EVENT);
    }

    #[test]
    fn the_input_release_listener_uses_the_same_event_name() {
        // Same coherence check the helper toggle runs: a renamed event is otherwise silent on both
        // sides, and this one fails in the state where nobody can report it.
        const RELEASE_TS: &str = include_str!("../../src/services/inputRelease.ts");
        assert!(
            RELEASE_TS.contains(INPUT_RELEASE_EVENT),
            "src/services/inputRelease.ts must listen for {INPUT_RELEASE_EVENT}"
        );
    }

    /// THE HATCH MUST NOT BE ABLE TO TAKE THE MENU BAR DOWN.
    ///
    /// `build()`'s header says a `?` that bailed would leave the app with no menu bar at all. The
    /// helper item predates the accelerator and has no string to misparse; this one does, so a `?`
    /// on it would convert a typo into "Sparkle launched with no menus, including Edit → Copy".
    /// Source-read for the same reason `build_augments_the_default_menu` is.
    #[test]
    fn the_input_release_item_is_built_fail_soft() {
        let src = include_str!("app_menu.rs");
        // BOUNDED TO THIS FUNCTION. Terminating the capture at `#[cfg(test)]` instead swept up the
        // whole rest of the file — 88 lines and four other functions — so `view_submenu`'s perfectly
        // ordinary `kind.as_submenu()?` failed this assertion and the pin reported a defect that was
        // not there. A source-scan that over-captures is not merely noisy: had those `?` reads not
        // existed, the same scan would have gone green over any function added later, which is the
        // failure that actually costs you. `\n}\n` is the function's own closing brace at column 0,
        // which rustfmt guarantees.
        let after_sig = src
            .split_once("fn build_input_release_item<R: Runtime>")
            .expect("build_input_release_item() should still exist")
            .1;
        let f = after_sig
            .split_once("\n}\n")
            .map(|(body, _)| body)
            .expect("build_input_release_item() should have a top-level closing brace");
        assert!(
            !f.contains(")?;") && !f.contains(")?\n"),
            "build_input_release_item must never use `?` — a failed accelerator parse has to \
             degrade to an item without a key equivalent, not abort the whole menu"
        );
        assert!(
            f.contains("None::<&str>"),
            "build_input_release_item must retry with no accelerator; a mouse-reachable hatch \
             still beats no hatch"
        );
    }

    #[test]
    fn lib_rs_installs_the_menu_and_its_handler() {
        // A menu that is built but never installed, or installed with no event handler, is exactly
        // as broken as no menu — and both are one deleted line away.
        let lib_rs = include_str!("lib.rs");
        assert!(lib_rs.contains(".menu(app_menu::build)"), "lib.rs must install the app menu");
        assert!(
            lib_rs.contains(".on_menu_event(app_menu::on_menu_event)"),
            "lib.rs must route menu events to app_menu::on_menu_event"
        );
        assert!(
            lib_rs.contains("app_menu::set_helper_menu_state"),
            "lib.rs must register set_helper_menu_state in the invoke handler"
        );
    }
}
