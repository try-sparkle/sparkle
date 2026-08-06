//! Making WKWebView deliver the DROP half of a drag, not just the hover half.
//!
//! WHY THIS FILE EXISTS — the founder, for the fourth time: "I still can't drop images or text
//! files directly into terminal windows. I used to be able to do this. There was a regression."
//!
//! THE SYMPTOM IS SPLIT, and that split is the whole diagnosis. Dragging a file over an agent's
//! terminal paints the dashed drop affordance — so `enter`/`over` arrive, the coordinate hit test
//! resolves to the terminal stage, and every line of `hooks/useTerminalDrop` is correct and live.
//! Then you let go and NOTHING happens: no paste, no pill, and — the part that cost three previous
//! investigations — not one line in the log, from Rust or from JS. `attachments::note_drag_event`
//! never fires, so the drop does not merely go to the wrong listener; **no `DragDropEvent::Drop` is
//! ever produced at all.**
//!
//! Measured on the founder's own logs before this landed: 91 drops reached Rust across three window
//! sizes, and every single one was inside the concierge column — clustered at 44–50% across and
//! 85–89% down the window, which is the compose box. `reportDropWithNoTarget` — the alarm for "a
//! drop arrived and matched no target" — fired exactly ONCE in the app's entire history. Terminal
//! drops are not misrouted. They never arrive.
//!
//! THE CAUSE IS AN UNFILLED HOLE IN wry's macOS DRAG HANDLER. AppKit's drag destination protocol
//! runs `draggingEntered:` → `draggingUpdated:`* → `prepareForDragOperation:` →
//! `performDragOperation:`, and **`performDragOperation:` is only called if
//! `prepareForDragOperation:` returned YES**. wry (`wry-0.55.1/src/wkwebview/drag_drop.rs`)
//! overrides four methods — `draggingEntered:`, `draggingUpdated:`, `performDragOperation:`,
//! `draggingExited:` — and does NOT override `prepareForDragOperation:`. So the one method that
//! decides whether the drop is delivered is left to WKWebView's own implementation.
//!
//! That would be harmless if WebKit had been watching the drag, but it has not: Tauri's drag
//! handler returns `true` (`tauri-runtime-wry-2.11.3/src/lib.rs`, the `with_drag_drop_handler`
//! closure), and wry reads that as "handled", taking the branch that returns
//! `NSDragOperation::Copy` **without** forwarding to `super`. So `draggingEntered:` and
//! `draggingUpdated:` never reach WKWebView, and the drag arrives at `prepareForDragOperation:`
//! with WebKit deciding on its own terms — which come down to whether the DOM element under the
//! cursor is one WebKit natively accepts a file on. The concierge compose box is a `<textarea>`,
//! so it says YES and its drops have always worked. The terminal stage is a `<div>` wrapping an
//! xterm canvas, so it says NO, `performDragOperation:` is never called, wry's handler never runs,
//! and the drop evaporates one layer below anything JavaScript can see or log.
//!
//! THE FIX IS TO FILL THE HOLE, not to work around it. wry does not implement
//! `prepareForDragOperation:`, so adding it to wry's own webview class is not swizzling a method
//! anyone owns — it supplies the missing override, and `class_addMethod` REFUSES (returns NO) the
//! day a future wry adds its own, so this cannot silently fight an upstream fix.
//!
//! WHY UNCONDITIONAL YES IS SAFE, AND THE ONE PRECONDITION IT RESTS ON. Returning YES only means
//! "proceed to `performDragOperation:`" — it grants no capability by itself. wry's
//! `perform_drag_operation` returns `Bool::YES` without calling `super` whenever its listener
//! reports handled, and Tauri's listener returns `true` unconditionally, so WebKit's own drop
//! behaviour — inserting a filename into a text field, navigating to a dropped URL — is ALREADY
//! fully suppressed and this changes nothing about that. The only delta is that drops outside a
//! natively-droppable element now reach the frontend, where the existing hit test decides who owns
//! them and a drop matching no target is discarded exactly as before.
//!
//! THE PRECONDITION: every webview in the process must HAVE that Tauri listener. When a window is
//! built with `dragDropEnabled: false`, Tauri installs none and wry substitutes
//! `Box::new(|_| false)` (`wry-0.55.1/src/wkwebview/mod.rs`), which routes `performDragOperation:`
//! to `super` — i.e. to WebKit's native handling, which for a file over a non-editable area
//! NAVIGATES THE WEBVIEW TO THE FILE. Because the gate lives on the class, such a window would
//! inherit the forced YES and lose its UI to a stray drop. No window disables drag-drop today
//! (nothing in this crate calls `.drag_drop_enabled(false)`, and the config default is on), which
//! is what makes the unconditional form correct; if you ever add one, scope this install per
//! webview first.
//!
//! ONE INSTALL COVERS EVERY WINDOW, and that is deliberate rather than incidental. We add the
//! method to the CLASS, not to an instance, so every WryWebView in the process picks it up —
//! including satellite project windows, which stack their own terminal panes in a
//! `TERMINAL_STAGE_DND_TARGET` region (`satellite/SatelliteApp.tsx`) and would otherwise need their
//! own call at a point in their lifecycle where nothing convenient exists to hang it on. Windows
//! with no drop listener at all (the capture takeover, the helper island) are unaffected: a drop
//! there is delivered to a frontend that has registered nothing, and is discarded exactly as an
//! unclaimed drop is today.
//!
//! WHY IT LOOKED LIKE A REGRESSION RATHER THAN A GAP THAT WAS ALWAYS THERE: terminal drop worked
//! for two days (41 successful pastes, 2026-07-28 → 07-30) because the panes in that window still
//! put a `<textarea>` under the drop point. When the layout moved on, the terminal stage lost the
//! only element WebKit would accept a drop on, and the feature died without a single line of its
//! own code changing. That is why searching the git history for "what removed the drop handler"
//! found nothing to remove — and why the previous fix attempt stopped at "next step is a dev run".

/// What happened when we tried to supply `prepareForDragOperation:`. The startup log in `install`
/// below is the only reader; there is no separate installed-flag, because a flag nothing queries
/// is a second source of truth for what one log line already says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateOutcome {
    /// We added the override. This is the healthy result on wry 0.55.x.
    Installed,
    /// The class already implements it ITSELF (not merely inherited from WKWebView) — i.e. a
    /// future wry supplied its own. Leave it alone; upstream wins.
    AlreadyPresent,
    /// The runtime refused for some other reason. Logged, never fatal: a drop that does not arrive
    /// is the bug we already have, so failing to fix it must not also fail to start the app.
    Failed,
}

#[cfg(target_os = "macos")]
mod imp {
    use super::GateOutcome;
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    use std::ffi::CStr;

    /// `-(BOOL)prepareForDragOperation:(id<NSDraggingInfo>)sender`
    ///
    /// Always YES — see the module header for why that grants nothing on its own.
    ///
    /// `extern "C-unwind"` matches objc2's `Imp`. The body cannot panic (it returns a constant),
    /// so no unwind can actually cross the Objective-C frame.
    extern "C-unwind" fn prepare_for_drag_operation(
        _this: *mut AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> Bool {
        Bool::YES
    }

    /// The Objective-C type encoding for `BOOL (id, SEL, id)`.
    ///
    /// BOOL IS NOT THE SAME TYPE ON BOTH ARCHITECTURES and this ships as a universal binary, so a
    /// single hard-coded string would be wrong on one slice of every DMG. On arm64 `BOOL` is C
    /// `_Bool` (`B`); on x86_64 it is `signed char` (`c`). Getting this wrong does not fail to
    /// compile — it produces a method the runtime describes incorrectly.
    #[cfg(target_arch = "aarch64")]
    const TYPES: &CStr = c"B@:@";
    #[cfg(not(target_arch = "aarch64"))]
    const TYPES: &CStr = c"c@:@";

    /// Supply `prepareForDragOperation:` on `cls` if the class does not already define its own.
    ///
    /// Split out from the webview lookup ON PURPOSE: this half takes a plain class and so is
    /// testable in CI against a class built for the test, with no NSApplication, no webview, and no
    /// real drag — the three things that made this bug unreachable by the suite for three rounds.
    pub fn install_on_class(cls: &AnyClass) -> GateOutcome {
        let sel = objc2::sel!(prepareForDragOperation:);
        // NOTE: deliberately NOT `cls.responds_to(sel)`. That walks the SUPERCLASS chain, and
        // WKWebView — wry's superclass — implements this method; a `responds_to` guard would
        // therefore report "already present" for the exact class we need to override and this fix
        // would be a silent no-op. `class_addMethod` has precisely the semantics we want: it adds
        // the method when the class itself lacks it, and returns NO when the class itself has one.
        let imp: Imp = unsafe {
            std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool,
                Imp,
            >(prepare_for_drag_operation)
        };
        // SAFETY: `cls` is a live class; `sel` is a valid selector; `imp` has the signature
        // described by `TYPES` for this architecture.
        let added = unsafe {
            objc2::ffi::class_addMethod(
                cls as *const AnyClass as *mut AnyClass,
                sel,
                imp,
                TYPES.as_ptr(),
            )
        };
        let outcome = if added.as_bool() {
            GateOutcome::Installed
        } else {
            GateOutcome::AlreadyPresent
        };
        outcome
    }

    /// Find the class of the live WKWebView behind `webview_ptr` and install the gate on it.
    ///
    /// `webview_ptr` is what `tauri::webview::PlatformWebview::inner()` returns: the WryWebView
    /// instance (a WKWebView subclass). We take the object's class rather than looking one up by
    /// name so this keeps working if wry renames it.
    ///
    /// # Safety
    /// `webview_ptr` must be a live Objective-C object pointer.
    pub unsafe fn install_for_webview(webview_ptr: *mut std::ffi::c_void) -> GateOutcome {
        if webview_ptr.is_null() {
            return GateOutcome::Failed;
        }
        let obj = webview_ptr as *mut AnyObject;
        // SAFETY: caller guarantees a live object.
        let cls: &AnyClass = unsafe { (*obj).class() };
        install_on_class(cls)
    }
}

#[cfg(target_os = "macos")]
pub use imp::{install_for_webview, install_on_class};

/// Install the drop gate on the app's main webview.
///
/// Called from `lib.rs` setup. Non-fatal by construction: every failure path logs and returns, so
/// a webview we cannot reach costs the drop fix, never the launch.
#[cfg(target_os = "macos")]
pub fn install<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(webview) = app.get_webview_window("main") else {
        tracing::warn!(
            target: "ui",
            "drop gate: no main webview window at setup; terminal drops will not be delivered"
        );
        return;
    };
    if let Err(e) = webview.with_webview(|platform| {
        // SAFETY: Tauri hands us the live WKWebView for this window.
        let outcome = unsafe { install_for_webview(platform.inner()) };
        match outcome {
            GateOutcome::Installed => tracing::info!(
                target: "ui",
                "drop gate: prepareForDragOperation: installed — drops outside text fields will now be delivered"
            ),
            GateOutcome::AlreadyPresent => tracing::info!(
                target: "ui",
                "drop gate: wry already defines prepareForDragOperation:; leaving it alone"
            ),
            GateOutcome::Failed => tracing::warn!(
                target: "ui",
                "drop gate: could not install prepareForDragOperation:; terminal drops may not be delivered"
            ),
        }
    }) {
        tracing::warn!(target: "ui", error = %e, "drop gate: with_webview failed");
    }
}

/// No-op off macOS: `prepareForDragOperation:` is an AppKit concept and wry reaches its handler
/// directly on the other platforms.
#[cfg(not(target_os = "macos"))]
pub fn install<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, NSObject};
    // `NSObject::class()` comes from this trait, which must be in scope to call it.
    use objc2::ClassType;
    use std::ffi::CString;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Unique class names — the ObjC runtime refuses a duplicate registration, and tests share one
    /// process.
    static N: AtomicUsize = AtomicUsize::new(0);

    fn fresh_class(stem: &str) -> &'static AnyClass {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let name = CString::new(format!("SparkleDropGateTest_{stem}_{n}")).unwrap();
        ClassBuilder::new(&name, NSObject::class())
            .expect("class name should be unused")
            .register()
    }

    /// THE REGRESSION TEST. Asserts the SIDE EFFECT — that after installing, the class actually
    /// answers `prepareForDragOperation:` with YES — not merely that we called something.
    ///
    /// Against the broken state (no gate installed at all) the first assertion below is what fails:
    /// a plain NSObject subclass does not respond to the selector, which is exactly the position
    /// wry's webview class is in for this method's *own* implementation. Delete the `install_on_class`
    /// call and this test goes red.
    #[test]
    fn installs_the_missing_prepare_for_drag_operation() {
        let cls = fresh_class("install");
        let sel = objc2::sel!(prepareForDragOperation:);

        // Precondition: the method is genuinely absent before we act, so the assertion below
        // cannot be true for a reason other than our install.
        assert!(
            !cls.responds_to(sel),
            "test class should not already answer prepareForDragOperation:"
        );

        assert_eq!(install_on_class(cls), GateOutcome::Installed);

        // The side effect that matters: the runtime now dispatches the selector...
        assert!(
            cls.responds_to(sel),
            "after install the class must answer prepareForDragOperation:"
        );

        // ...and answering it returns YES, which is what makes AppKit go on to call
        // performDragOperation: and hence deliver the drop. A method that existed but returned NO
        // would leave the bug exactly as it is.
        // `msg_send!` applies ARC-style ownership rules in objc2 0.6, so `new` yields a `Retained`
        // and the object is released on drop — a manual `release` here would over-release it.
        let obj: Retained<AnyObject> = unsafe { objc2::msg_send![cls, new] };
        let answer: Bool = unsafe {
            objc2::msg_send![&*obj, prepareForDragOperation: std::ptr::null_mut::<AnyObject>()]
        };
        assert!(answer.as_bool(), "the gate must answer YES");
    }

    /// A future wry that supplies its own `prepareForDragOperation:` must win: we report
    /// `AlreadyPresent` and do NOT replace it. Guards against this fix quietly fighting an upstream
    /// one after a dependency bump.
    #[test]
    fn defers_to_a_class_that_already_defines_its_own() {
        let cls = fresh_class("existing");
        // First install stands in for "upstream defined it".
        assert_eq!(install_on_class(cls), GateOutcome::Installed);
        // Second must NOT replace it.
        assert_eq!(install_on_class(cls), GateOutcome::AlreadyPresent);
    }

    /// Inheriting the method from a superclass must NOT count as "already present" — that is the
    /// specific mistake (`responds_to` instead of `class_addMethod`) that would turn this whole fix
    /// into a silent no-op, because WKWebView already implements this method and wry's class
    /// inherits it.
    #[test]
    fn an_inherited_implementation_does_not_block_the_override() {
        let parent = fresh_class("parent");
        assert_eq!(install_on_class(parent), GateOutcome::Installed);

        let n = N.fetch_add(1, Ordering::Relaxed);
        let name = CString::new(format!("SparkleDropGateTest_child_{n}")).unwrap();
        let child = ClassBuilder::new(&name, parent)
            .expect("class name should be unused")
            .register();

        let sel = objc2::sel!(prepareForDragOperation:);
        // The child ALREADY answers the selector, by inheritance...
        assert!(
            child.responds_to(sel),
            "child inherits the parent's implementation"
        );
        // ...and we must still install our own on the child rather than treating that as done.
        assert_eq!(install_on_class(child), GateOutcome::Installed);
    }

    /// A null webview pointer is reported, not dereferenced.
    #[test]
    fn a_null_webview_is_reported_not_dereferenced() {
        let outcome = unsafe { install_for_webview(std::ptr::null_mut()) };
        assert_eq!(outcome, GateOutcome::Failed);
    }
}
