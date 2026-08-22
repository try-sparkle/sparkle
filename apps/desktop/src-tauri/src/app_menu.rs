//! The application menu bar, and the custom items on it: View → Hide/Show Helper, View →
//! Release Input, and — on macOS — a stand-in for the system Quit item so ⌘Q can defer to a
//! staged update (see the ⌘Q header block further down).
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

use tauri::menu::{IsMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
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

/// Strip Windows/Linux mnemonic markers from a menu label. `&View` is "View" with `V` underlined;
/// `&&` is a literal ampersand and must survive. macOS labels carry none of this, but the same
/// labels are compared on every platform.
fn strip_mnemonics(text: &str) -> String {
    text.replace("&&", "\u{0}").replace('&', "").replace('\u{0}', "&")
}

/// Does this submenu title name the View menu? Windows/Linux titles carry `&` mnemonic markers
/// (`&View`), and `&&` is a literal ampersand, so strip single `&`s before comparing.
pub fn is_view_submenu(text: &str) -> bool {
    strip_mnemonics(text) == VIEW_SUBMENU_TEXT
}

// ── ⌘Q MUST REACH `AppHandle::exit`, NOT `terminate:` (bead sparkle-1ueh3) ────────────────────────
//
// `lib.rs`'s `updater_quit` module holds an exit open just long enough for the webview to install a
// DOWNLOADED-but-not-yet-installed update, because installing it any earlier replaces
// /Applications/Sparkle.app underneath the running process and permanently kills its microphone.
// That deferral hangs off `RunEvent::ExitRequested`, which tauri-runtime-wry 2.11.3 emits from
// exactly TWO sites (`src/lib.rs:4316` last-window-destroyed, `:4356` `Message::RequestExit` — i.e.
// `AppHandle::exit` / `restart`).
//
// macOS ⌘Q reaches NEITHER. muda maps the PREDEFINED Quit item straight to `sel!(terminate:)`
// (muda-0.19.3 `src/platform_impl/macos/mod.rs:994`), and tao's macOS app delegate implements only
// `applicationWillTerminate:` (tao-0.35.3 `src/platform_impl/macos/app_delegate.rs:131`) — there is
// no `applicationShouldTerminate:` — so that gesture arrives as `Event::LoopDestroyed` →
// `RunEvent::Exit`, which is NOT preventable and is far too late to await an async JS install. ⌘Q is
// how this app's primary user actually quits, so without this the deferral covers everything except
// the case that matters.
//
// The fix is to take macOS's own Quit item out of the app menu and put an identical-looking CUSTOM
// item in its place, whose handler calls `AppHandle::exit(0)` — which is `Message::RequestExit`, so
// the deferral runs. Label and key equivalent are copied from the item being replaced, so nothing
// about it is visible to the user.
//
// WHAT THIS DOES **NOT** COVER, stated rather than implied:
//   - **Force Quit** (⌥⌘⎋, Activity Monitor, `kill -9`) is SIGKILL. No process can intercept it, and
//     none of this runs. Nothing on disk has been touched, so the next launch simply re-checks.
//   - **A system logout, restart or shut down** sends `terminate:` to the app. An app can only
//     interpose there by implementing `applicationShouldTerminate:`, which tao does not, so this is
//     not covered either — nor can it be from this file.
//   - **The Dock icon's own Quit** (and any other `terminate:` sender, e.g. AppleScript `quit`) goes
//     down the same uninterceptable path for the same reason. It bypasses the menu bar entirely, so
//     replacing a menu item cannot reach it.
//   - **Windows and Linux** are deliberately untouched: `install_custom_quit` is called only under
//     `cfg(target_os = "macos")`. Their Quit stays the predefined one.
//
// AND EVERY ONE OF THOSE IS SURVIVABLE, which is the reason this whole file may fail open. Missing
// the install is DELAYED, never BROKEN: nothing on disk was touched, the next launch re-checks and
// re-downloads, and the banner's "Restart now" still works. The only cost is one repeated download.
//
// **A USER WHO CANNOT QUIT THEIR APP IS A FAR WORSE BUG THAN THE ONE THIS FIXES.** So — inverting
// this repo's usual fail-closed habit — every step below fails OPEN: if the predefined item cannot
// be found, if the replacement cannot be built, if the accelerator will not parse, if the insert is
// refused, the user is left with a working Quit and the update waits for the next launch.

/// Menu-item id for our replacement Quit. Matched in `on_menu_event`.
///
/// DELIBERATELY NON-NUMERIC. muda gives every predefined item an id of `COUNTER.next().to_string()`
/// (muda-0.19.3 `src/platform_impl/macos/mod.rs:373`) — i.e. `"1"`, `"2"`, … — so a numeric id here
/// could collide with About/Services/Hide and route their clicks into our quit handler.
/// `our_menu_item_ids_cannot_collide_with_mudas` pins that.
pub const QUIT_ID: &str = "app-quit";

/// ⌘Q, exactly what the item we are replacing carried: muda gives its predefined Quit
/// `Accelerator::new(Some(CMD_OR_CTRL), Code::KeyQ)` (muda-0.19.3 `src/items/predefined.rs:339`).
/// Asserted against that chord in `quit_accelerator_parses_to_the_chord_it_replaces`, because an
/// unparseable accelerator is SILENT — the item still builds, just with no key equivalent, and ⌘Q
/// would then do nothing at all.
pub const QUIT_ACCELERATOR: &str = "CmdOrCtrl+Q";

/// Is this the Quit item's label? Matched by TEXT because there is nothing else to match on: muda
/// derives a predefined item's id from a process-wide counter, so it is neither stable nor
/// meaningful. On macOS the label is `format!("Quit {}", app_name())` (muda-0.19.3
/// `src/platform_impl/macos/mod.rs:364`); the bare `&Quit` form is what the same item carries
/// off-macOS.
///
/// The space in `"Quit "` matters: without it "Quitter" would match.
fn is_quit_label(text: &str) -> bool {
    let text = strip_mnemonics(text);
    text == "Quit" || text.starts_with("Quit ")
}

/// The menu operations the swap needs, abstracted away from `tauri::menu` so the ORDER they run in
/// can be tested. That order is the entire safety property — build before removing, put the old one
/// back if the insert is refused — and a real menu cannot be built in a unit test (muda needs an
/// event loop and the main thread), so without this seam the one branch that decides whether the
/// user still has a Quit would be covered by nothing.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
trait QuitMenu {
    /// Our replacement item, held between being built and being inserted.
    type Custom;
    /// The item we took out, held only long enough to put it back if the insert fails.
    type Removed;

    /// Position and label of the predefined Quit item, if this menu has one.
    fn find_predefined_quit(&self) -> Option<(usize, String)>;
    /// Build the replacement carrying `label` and [`QUIT_ACCELERATOR`]. Fallible on purpose: muda
    /// parses the accelerator string right here.
    fn build_custom_quit(&self, label: &str) -> Result<Self::Custom, String>;
    /// Take the item at `position` out. `Ok(None)` means there was nothing there — so nothing was
    /// removed, which is a safe outcome, not a lost Quit.
    fn remove_at(&self, position: usize) -> Result<Option<Self::Removed>, String>;
    fn insert_custom(&self, custom: &Self::Custom, position: usize) -> Result<(), String>;
    /// Put the removed item back. The LAST LINE OF DEFENCE, so implementations should try every
    /// route they have before returning `Err`.
    fn restore(&self, removed: Self::Removed, position: usize) -> Result<(), String>;
}

/// What [`swap_in_custom_quit`] actually did. Returned rather than logged inside so the caller can
/// phrase the log line and a test can assert the branch taken.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
enum QuitSwap {
    /// ⌘Q now goes through `AppHandle::exit`.
    Replaced,
    /// Left macOS's own Quit exactly where it was. The staged update is merely DELAYED to the next
    /// launch — today's behaviour, and strictly better than a user who cannot quit.
    KeptPredefined(String),
    /// Took the predefined item out, could not insert ours, put it back. Same user-visible outcome
    /// as `KeptPredefined`.
    Restored,
    /// The one bad outcome: removed, insert failed, AND every restore route failed. Should be
    /// unreachable — `restore` tries three — but named so it can be logged loudly rather than
    /// silently folded into a success.
    Lost,
}

/// Swap the predefined Quit for ours, failing OPEN at every step.
///
/// THE ORDERING IS THE WHOLE POINT and it is why this is a separate function. Everything that can
/// fail — finding the item, muda parsing the accelerator, the main-thread hop that builds the item —
/// happens while the user's Quit is still installed. Only once a replacement exists in hand does
/// anything get removed. Doing it the obvious way round (remove, then build) turns any build failure
/// into an app with no Quit at all.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn swap_in_custom_quit<M: QuitMenu>(menu: &M) -> QuitSwap {
    let Some((position, label)) = menu.find_predefined_quit() else {
        return QuitSwap::KeptPredefined("no predefined Quit item in the app menu".into());
    };
    // BUILD FIRST. Nothing has been removed yet, so any failure here costs the update, not the Quit.
    let custom = match menu.build_custom_quit(&label) {
        Ok(c) => c,
        Err(e) => {
            return QuitSwap::KeptPredefined(format!("could not build a replacement Quit item: {e}"))
        }
    };
    match menu.remove_at(position) {
        Ok(Some(removed)) => {
            if let Err(e) = menu.insert_custom(&custom, position) {
                // The window where the app has no Quit is exactly these two statements long.
                return match menu.restore(removed, position) {
                    Ok(()) => QuitSwap::Restored,
                    Err(restore_err) => {
                        tracing::error!(
                            "removed macOS's Quit item, could not insert Sparkle's ({e}), and could \
                             not put the original back ({restore_err}) — the app menu may have no \
                             Quit item; the Dock icon's own Quit still quits the app"
                        );
                        QuitSwap::Lost
                    }
                };
            }
            QuitSwap::Replaced
        }
        // Nothing was at that position, so nothing came out and the menu is unchanged.
        Ok(None) => QuitSwap::KeptPredefined(format!("no menu item at position {position}")),
        Err(e) => QuitSwap::KeptPredefined(format!("could not remove the predefined Quit: {e}")),
    }
}

/// The real [`QuitMenu`], over the submenu that actually holds macOS's Quit item.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct AppMenuQuit<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    submenu: Submenu<R>,
}

impl<R: Runtime> QuitMenu for AppMenuQuit<'_, R> {
    type Custom = MenuItem<R>;
    type Removed = MenuItemKind<R>;

    fn find_predefined_quit(&self) -> Option<(usize, String)> {
        find_predefined_quit_in(&self.submenu)
    }

    fn build_custom_quit(&self, label: &str) -> Result<MenuItem<R>, String> {
        // `label` is the replaced item's OWN text, read back off the menu, so the user cannot tell
        // the two apart. Enabled, unconditionally — a disabled Quit is the bug this must not ship.
        MenuItem::with_id(self.app, QUIT_ID, label, true, Some(QUIT_ACCELERATOR))
            .map_err(|e| e.to_string())
    }

    fn remove_at(&self, position: usize) -> Result<Option<MenuItemKind<R>>, String> {
        self.submenu.remove_at(position).map_err(|e| e.to_string())
    }

    fn insert_custom(&self, custom: &MenuItem<R>, position: usize) -> Result<(), String> {
        self.submenu.insert(custom, position).map_err(|e| e.to_string())
    }

    fn restore(&self, removed: MenuItemKind<R>, position: usize) -> Result<(), String> {
        // THREE ROUTES, cheapest and most faithful first. A Quit in the wrong place beats no Quit,
        // and a freshly built predefined Quit beats both if the original object has somehow become
        // unusable.
        if self.submenu.insert(&removed, position).is_ok() {
            return Ok(());
        }
        if self.submenu.append(&removed).is_ok() {
            return Ok(());
        }
        let fresh = PredefinedMenuItem::quit(self.app, None).map_err(|e| e.to_string())?;
        self.submenu.append(&fresh).map_err(|e| e.to_string())
    }
}

/// Position and label of the predefined Quit item inside one submenu.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn find_predefined_quit_in<R: Runtime>(submenu: &Submenu<R>) -> Option<(usize, String)> {
    // ONLY predefined items are considered. Ours is a plain `MenuItem`, so a second pass over an
    // already-swapped menu finds nothing and changes nothing.
    submenu.items().ok()?.into_iter().enumerate().find_map(|(i, kind)| {
        let text = kind.as_predefined_menuitem()?.text().ok()?;
        is_quit_label(&text).then_some((i, text))
    })
}

/// Replace macOS's Quit item with ours. Best-effort by design — see the header block above.
#[cfg(target_os = "macos")]
fn install_custom_quit<R: Runtime>(app: &AppHandle<R>, menu: &Menu<R>) {
    // Scan every submenu rather than assuming the app menu is index 0: on macOS `Menu::default`
    // puts Quit in the app submenu and NOT in File (tauri-2.11.3 `src/menu/menu.rs:195,219`), but
    // taking the first match keeps this correct if that ever moves.
    let host = menu.items().ok().into_iter().flatten().find_map(|kind| {
        let sub = kind.as_submenu()?;
        find_predefined_quit_in(sub).map(|_| AppMenuQuit { app, submenu: sub.clone() })
    });
    let Some(host) = host else {
        tracing::warn!(
            "no predefined Quit item found in the app menu; leaving it alone — a staged update will \
             install on the next launch instead"
        );
        return;
    };
    match swap_in_custom_quit(&host) {
        QuitSwap::Replaced => {
            tracing::debug!("⌘Q now routes through AppHandle::exit so a staged update can install")
        }
        QuitSwap::KeptPredefined(why) => tracing::warn!(
            "keeping macOS's own Quit item ({why}); ⌘Q will not wait for a staged update, which \
             will install on the next launch instead"
        ),
        QuitSwap::Restored => tracing::warn!(
            "could not install Sparkle's Quit item; macOS's own has been put back and quitting works"
        ),
        // Already logged at error inside the swap, with detail this arm does not have.
        QuitSwap::Lost => {}
    }
}

/// The thing a Quit click quits. A trait for ONE reason: `AppHandle::exit` cannot be called in a
/// unit test, and "does this handler quit no matter what?" is the assertion worth having.
trait QuitsTheApp {
    fn exit_app(&self);
}

impl<R: Runtime> QuitsTheApp for AppHandle<R> {
    fn exit_app(&self) {
        // `AppHandle::exit` is `Message::RequestExit` (tauri-2.11.3 `src/app.rs:574`), which is one
        // of the two sites that emit `RunEvent::ExitRequested` — the event `updater_quit` hangs the
        // deferral off. If the runtime refuses the request tauri falls back to `process::exit`, so
        // even the failure mode quits.
        self.exit(0);
    }
}

/// The Quit branch of [`on_menu_event`].
///
/// **UNCONDITIONAL, and that is a safety requirement rather than a simplification.** It reads no
/// updater state, does not check whether the webview is alive, and has no early return: whether the
/// exit is worth deferring belongs to `updater_quit` alone (`lib.rs`), which owns BOTH halves of
/// that decision — the one-shot `claim_exit_deferral`, and `hold_second_exit`, which holds a second
/// quit only while a bundle swap is actually mid-rename and only while something is already on the
/// hook to release it. Anything conditional here would be a second gate on the same gesture, in a
/// place that cannot see either of those states.
fn on_quit_selected<Q: QuitsTheApp>(quitter: &Q) {
    tracing::info!("Quit chosen from the app menu; routing through AppHandle::exit");
    quitter.exit_app();
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

    // macOS ⌘Q — see the ⌘Q header block above. macOS ONLY: Windows and Linux keep the predefined
    // Quit exactly as before, because their install path does not delete the running bundle.
    // Best-effort by construction; it never returns an error and never leaves the app without a
    // working Quit.
    #[cfg(target_os = "macos")]
    install_custom_quit(app, &menu);

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

/// Wired into the builder's `on_menu_event`. Only our own items are handled; every other id belongs
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
    } else if event.id() == QUIT_ID {
        // Our replacement for macOS's Quit. Nothing is checked here on purpose — see
        // `on_quit_selected`.
        on_quit_selected(app);
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
    fn our_menu_items_have_distinct_ids() {
        // They are matched by id in `on_menu_event`; a collision would route one item's click to
        // the other's branch, and the `if/else if` chain would make it look like the later item was
        // dead — and with QUIT_ID in the chain, one of those outcomes is "⌘Q toggles the helper".
        let ids = [HELPER_TOGGLE_ID, INPUT_RELEASE_ID, QUIT_ID];
        for (i, a) in ids.iter().enumerate() {
            for b in &ids[i + 1..] {
                assert_ne!(a, b, "menu item ids must be distinct");
            }
        }
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

    // ── ⌘Q ROUTES THROUGH `AppHandle::exit` (bead sparkle-1ueh3) ─────────────────────────────────

    #[test]
    fn quit_label_matches_the_item_macos_actually_ships() {
        // What muda builds on macOS: `format!("Quit {}", app_name())` (0.19.3
        // src/platform_impl/macos/mod.rs:364).
        assert!(is_quit_label("Quit Sparkle"));
        assert!(is_quit_label("Quit Sparkle Dev"));
        // The bare form, and its mnemonic-carrying source string.
        assert!(is_quit_label("Quit"));
        assert!(is_quit_label("&Quit"));
        // THE SPACE IN "Quit " IS LOAD-BEARING. A prefix match with no separator swallows these,
        // and swallowing the wrong item means removing something that is not Quit while ⌘Q keeps
        // going straight to `terminate:` — a menu that is both wrong AND unfixed.
        assert!(!is_quit_label("Quitter"));
        assert!(!is_quit_label("Quitting Time"));
        // Its actual neighbours in the macOS app submenu.
        assert!(!is_quit_label("About Sparkle"));
        assert!(!is_quit_label("Hide Sparkle"));
        assert!(!is_quit_label("Hide Others"));
        assert!(!is_quit_label("Services"));
        assert!(!is_quit_label(""));
    }

    /// THE ACCELERATOR MUST ACTUALLY PARSE, and must be the SAME chord it replaces.
    ///
    /// muda parses the string at `MenuItem::with_id` and `build_custom_quit` degrades rather than
    /// aborting, so a typo ships a Quit item that looks perfectly correct and has no ⌘Q — which
    /// means the app's primary quit gesture does nothing at all. There is no runtime in a unit test
    /// to catch that, so it is caught here.
    #[test]
    fn quit_accelerator_parses_to_the_chord_it_replaces() {
        use muda::accelerator::{Accelerator, Code, Modifiers};
        use std::str::FromStr;

        let accel = Accelerator::from_str(QUIT_ACCELERATOR)
            .expect("QUIT_ACCELERATOR must be a string muda can parse");
        // Compared WHOLE, like the input-release chord above: it pins the modifier set exactly
        // rather than checking that one bit is present and letting a second slip in.
        let primary = if cfg!(target_os = "macos") { Modifiers::META } else { Modifiers::CONTROL };
        let expected = Accelerator::new(Some(primary), Code::KeyQ);
        assert_eq!(
            accel, expected,
            "the replacement must carry exactly what muda's predefined Quit carries \
             (Accelerator::new(Some(CMD_OR_CTRL), Code::KeyQ), 0.19.3 src/items/predefined.rs:339) \
             — anything else is visible to the user"
        );
        // A bare Q with no modifier would be swallowed by the menu bar and would make the letter q
        // untypeable app-wide. Implied by the equality, asserted separately because a dropped
        // modifier still parses.
        assert_ne!(accel, Accelerator::new(None, Code::KeyQ), "⌘Q, not Q");
    }

    #[test]
    fn our_menu_item_ids_cannot_collide_with_mudas() {
        // muda ids every PREDEFINED item with `COUNTER.next().to_string()` (0.19.3
        // src/platform_impl/macos/mod.rs:373) — "1", "2", "3"… A numeric id here would eventually
        // collide, and `on_menu_event` matches by id, so About or Hide would silently quit the app.
        for id in [HELPER_TOGGLE_ID, INPUT_RELEASE_ID, QUIT_ID] {
            assert!(
                id.parse::<u64>().is_err(),
                "{id} must not be a bare number — that is the shape of muda's predefined ids"
            );
        }
    }

    /// A stand-in for the submenu that holds Quit.
    ///
    /// A real menu cannot be built in a unit test (muda needs an event loop and the main thread),
    /// but the part that decides WHETHER THE USER STILL HAS A QUIT is the order in which the swap
    /// builds, removes, inserts and restores — and that order is pure. This models just enough to
    /// assert the side effect: which items the menu is holding once the dust settles.
    #[derive(Clone, Debug, PartialEq, Eq)]
    struct FakeItem {
        label: String,
        enabled: bool,
        /// True for macOS's own Quit, false for ours. The whole change is about being the second.
        predefined: bool,
    }

    struct FakeAppMenu {
        items: std::cell::RefCell<Vec<FakeItem>>,
        build_fails: bool,
        insert_fails: bool,
        restore_fails: bool,
    }

    /// Where Quit sits in `Menu::default`'s macOS app submenu (tauri-2.11.3 src/menu/menu.rs:190).
    const FAKE_QUIT_POSITION: usize = 7;

    impl FakeAppMenu {
        /// The macOS app submenu exactly as `Menu::default` builds it: About, ─, Services, ─, Hide,
        /// Hide Others, ─, Quit.
        fn macos_default() -> Self {
            let items = ["About Sparkle", "", "Services", "", "Hide Sparkle", "Hide Others", "", "Quit Sparkle"]
                .into_iter()
                .map(|label| FakeItem { label: label.into(), enabled: true, predefined: true })
                .collect();
            Self {
                items: std::cell::RefCell::new(items),
                build_fails: false,
                insert_fails: false,
                restore_fails: false,
            }
        }

        /// Every item on the menu that a user would read as "this quits the app".
        fn quit_items(&self) -> Vec<FakeItem> {
            self.items.borrow().iter().filter(|i| is_quit_label(&i.label)).cloned().collect()
        }

        fn labels(&self) -> Vec<String> {
            self.items.borrow().iter().map(|i| i.label.clone()).collect()
        }
    }

    impl QuitMenu for FakeAppMenu {
        type Custom = FakeItem;
        type Removed = FakeItem;

        fn find_predefined_quit(&self) -> Option<(usize, String)> {
            self.items
                .borrow()
                .iter()
                .enumerate()
                .find(|(_, i)| i.predefined && is_quit_label(&i.label))
                .map(|(pos, i)| (pos, i.label.clone()))
        }

        fn build_custom_quit(&self, label: &str) -> Result<FakeItem, String> {
            if self.build_fails {
                return Err("the accelerator would not parse".into());
            }
            Ok(FakeItem { label: label.into(), enabled: true, predefined: false })
        }

        fn remove_at(&self, position: usize) -> Result<Option<FakeItem>, String> {
            let mut items = self.items.borrow_mut();
            if position >= items.len() {
                return Ok(None);
            }
            Ok(Some(items.remove(position)))
        }

        fn insert_custom(&self, custom: &FakeItem, position: usize) -> Result<(), String> {
            if self.insert_fails {
                return Err("the insert was refused".into());
            }
            self.items.borrow_mut().insert(position, custom.clone());
            Ok(())
        }

        fn restore(&self, removed: FakeItem, position: usize) -> Result<(), String> {
            if self.restore_fails {
                return Err("the restore was refused too".into());
            }
            self.items.borrow_mut().insert(position, removed);
            Ok(())
        }
    }

    #[test]
    fn the_swap_puts_our_quit_where_the_system_one_was() {
        let menu = FakeAppMenu::macos_default();
        assert_eq!(swap_in_custom_quit(&menu), QuitSwap::Replaced);

        let quits = menu.quit_items();
        assert_eq!(quits.len(), 1, "exactly one Quit, never two and never none");
        assert!(!quits[0].predefined, "⌘Q must reach OUR handler, not muda's sel!(terminate:)");
        assert!(quits[0].enabled, "a disabled Quit is a user who cannot quit");
        assert_eq!(
            quits[0].label, "Quit Sparkle",
            "the label is copied off the item being replaced, so the swap is invisible"
        );
        // Position matters: Quit is the last item under the app name, and macOS users reach for it
        // there by muscle memory.
        assert_eq!(menu.labels().len(), 8, "the swap must not change how many items are on the menu");
        assert_eq!(menu.items.borrow()[FAKE_QUIT_POSITION].label, "Quit Sparkle");
        assert!(!menu.items.borrow()[FAKE_QUIT_POSITION].predefined);
    }

    /// **THE MOST IMPORTANT TEST IN THIS CHANGE.**
    ///
    /// A user who cannot quit their app is a far worse bug than the update this defers. So the
    /// assertion is the SIDE EFFECT — what is on the menu afterwards — not that the builder returned
    /// an error. Doing the swap the obvious way round (remove, then build) passes any test that only
    /// reads the return value and ships an app with no Quit at all.
    #[test]
    fn a_replacement_that_cannot_be_built_leaves_the_system_quit_working() {
        let mut menu = FakeAppMenu::macos_default();
        menu.build_fails = true;
        let before = menu.labels();

        let outcome = swap_in_custom_quit(&menu);
        assert!(matches!(outcome, QuitSwap::KeptPredefined(_)), "got {outcome:?}");

        let quits = menu.quit_items();
        assert_eq!(quits.len(), 1, "the user must still have a Quit item");
        assert!(quits[0].enabled, "and it must still be enabled");
        assert!(quits[0].predefined, "macOS's own Quit is what should have been left in place");
        assert_eq!(menu.labels(), before, "nothing at all should have been touched");
    }

    /// The other half of fail-open: the replacement built, the insert was refused, and the window in
    /// which the app has no Quit has to be closed again before anyone can open the menu.
    #[test]
    fn a_refused_insert_puts_the_system_quit_back() {
        let mut menu = FakeAppMenu::macos_default();
        menu.insert_fails = true;
        let before = menu.labels();

        assert_eq!(swap_in_custom_quit(&menu), QuitSwap::Restored);

        let quits = menu.quit_items();
        assert_eq!(quits.len(), 1, "the user must still have a Quit item");
        assert!(quits[0].enabled);
        assert!(quits[0].predefined);
        assert_eq!(menu.labels(), before, "and it must be back in its own position");
    }

    /// The unreachable-by-design arm, kept honest: if even the restore fails we say so loudly rather
    /// than reporting a success. The REAL `restore` has three routes precisely so this cannot happen;
    /// this pins that `swap_in_custom_quit` does not quietly swallow it if it ever does.
    #[test]
    fn a_restore_that_also_fails_is_reported_rather_than_hidden() {
        let mut menu = FakeAppMenu::macos_default();
        menu.insert_fails = true;
        menu.restore_fails = true;
        assert_eq!(swap_in_custom_quit(&menu), QuitSwap::Lost);
    }

    #[test]
    fn a_menu_with_no_predefined_quit_is_left_completely_alone() {
        // The shape a future tauri could hand us — or the shape of an already-swapped menu, since
        // our own item is not predefined. Either way: touch nothing.
        let menu = FakeAppMenu::macos_default();
        menu.items.borrow_mut().remove(FAKE_QUIT_POSITION);
        let before = menu.labels();

        let outcome = swap_in_custom_quit(&menu);
        assert!(matches!(outcome, QuitSwap::KeptPredefined(_)), "got {outcome:?}");
        assert_eq!(
            menu.labels(),
            before,
            "with no Quit found, nothing may be removed — deleting item 0 instead would take About \
             off the menu and still leave ⌘Q going to terminate:"
        );
    }

    struct CountingQuitter(std::cell::Cell<usize>);

    impl QuitsTheApp for CountingQuitter {
        fn exit_app(&self) {
            self.0.set(self.0.get() + 1);
        }
    }

    /// THE HANDLER MAY NOT BE CONDITIONAL ON ANYTHING.
    ///
    /// Whether an exit is worth deferring is `updater_quit::claim_exit_deferral`'s call, and that is
    /// one-shot on purpose so a second pass cannot trap the user. A gate here would be a second,
    /// un-shot gate on the same gesture — i.e. a user pressing ⌘Q and nothing happening.
    #[test]
    fn the_quit_handler_exits_every_single_time() {
        let quitter = CountingQuitter(std::cell::Cell::new(0));
        on_quit_selected(&quitter);
        assert_eq!(quitter.0.get(), 1, "the first ⌘Q must exit");
        on_quit_selected(&quitter);
        on_quit_selected(&quitter);
        assert_eq!(
            quitter.0.get(),
            3,
            "and so must every one after it — nothing about the updater's state may gate this"
        );
    }

    /// THE PRODUCTION WIRING, not the seam.
    ///
    /// Every test above injects its own `QuitMenu`/`QuitsTheApp`, so the lines that supply the real
    /// ones are covered by nothing: delete them and the whole suite above still passes while ⌘Q goes
    /// straight back to `terminate:`. Source-read for the same reason the sibling guards in this file
    /// are — a menu built against a real runtime cannot be exercised in a unit test.
    #[test]
    fn build_installs_the_custom_quit_on_macos_and_only_on_macos() {
        let src = include_str!("app_menu.rs");
        let body = src
            .split_once("pub fn build<R: Runtime>")
            .expect("build() should still exist")
            .1
            .split_once("\n}\n")
            .map(|(body, _)| body)
            .expect("build() should have a top-level closing brace");
        // ONE assertion, both halves: the call exists AND it is gated to macOS. Windows and Linux
        // keep the predefined Quit, because their install path does not delete the running bundle.
        assert!(
            body.contains("#[cfg(target_os = \"macos\")]\n    install_custom_quit(app, &menu);"),
            "build() must call install_custom_quit under a macOS cfg — an ungated call would change \
             Windows/Linux menu construction, and no call at all leaves ⌘Q on sel!(terminate:)"
        );
        assert_eq!(
            body.matches("install_custom_quit").count(),
            1,
            "exactly one call site, so the cfg above it cannot be bypassed by a second one"
        );
    }

    #[test]
    fn on_menu_event_routes_our_quit_id_to_the_handler() {
        let src = include_str!("app_menu.rs");
        let body = src
            .split_once("pub fn on_menu_event<R: Runtime>")
            .expect("on_menu_event() should still exist")
            .1
            .split_once("\n}\n")
            .map(|(body, _)| body)
            .expect("on_menu_event() should have a top-level closing brace");
        assert!(
            body.contains("event.id() == QUIT_ID"),
            "on_menu_event must match QUIT_ID — an unmatched id is silently ignored, so ⌘Q would \
             open nothing, do nothing, and never quit the app"
        );
        assert!(
            body.contains("on_quit_selected(app)"),
            "and it must hand the real AppHandle to on_quit_selected"
        );
    }

    #[test]
    fn the_production_quit_item_carries_our_id_and_the_accelerator() {
        let src = include_str!("app_menu.rs");
        let body = src
            .split_once("fn build_custom_quit(&self, label: &str) -> Result<MenuItem<R>, String>")
            .expect("the real QuitMenu impl should still build the item")
            .1
            .split_once("\n    }\n")
            .map(|(body, _)| body)
            .expect("build_custom_quit should have a closing brace at impl indentation");
        assert!(body.contains("MenuItem::with_id(self.app, QUIT_ID, label, true, Some(QUIT_ACCELERATOR))"),
            "the real item must be built with QUIT_ID (so on_menu_event can route it), the label \
             read off the item it replaces, enabled, and QUIT_ACCELERATOR — every one of those is \
             invisible if dropped and only this reads it");
    }

    #[test]
    fn the_real_quitter_goes_through_apphandle_exit() {
        let src = include_str!("app_menu.rs");
        let body = src
            .split_once("impl<R: Runtime> QuitsTheApp for AppHandle<R> {")
            .expect("the AppHandle QuitsTheApp impl should still exist")
            .1
            .split_once("\n}\n")
            .map(|(body, _)| body)
            .expect("the impl should have a top-level closing brace");
        assert!(
            body.contains("self.exit(0);"),
            "must be AppHandle::exit — that is Message::RequestExit, the ONLY route from a menu \
             click to RunEvent::ExitRequested. process::exit or std::process::abort here would skip \
             the deferral entirely and reintroduce the bug this change exists to fix"
        );
        // The `(` matters: the doc comment right above `exit_app` names `process::exit` as the
        // fallback tauri itself takes, so a bare substring would match this file's own prose.
        assert!(
            !body.contains("process::exit("),
            "a direct process::exit call skips RunEvent::ExitRequested and therefore the staged \
             install"
        );
    }

    /// THE ORDERING IS THE FAIL-OPEN GUARANTEE. Asserted on source as well as behaviour because the
    /// behavioural test above can only see the outcome the fake was configured to produce; this
    /// pins that nothing removable happens before the fallible build, for any implementation.
    #[test]
    fn the_swap_builds_the_replacement_before_it_removes_anything() {
        let src = include_str!("app_menu.rs");
        let body = src
            .split_once("fn swap_in_custom_quit<M: QuitMenu>")
            .expect("swap_in_custom_quit() should still exist")
            .1
            .split_once("\n}\n")
            .map(|(body, _)| body)
            .expect("swap_in_custom_quit() should have a top-level closing brace");
        let build_at = body.find("build_custom_quit").expect("the swap must build a replacement");
        let remove_at = body.find("remove_at").expect("the swap must remove the predefined item");
        assert!(
            build_at < remove_at,
            "build BEFORE remove — reversing these turns any build failure (an unparseable \
             accelerator, a refused main-thread hop) into an app with no Quit item at all"
        );
    }

}
