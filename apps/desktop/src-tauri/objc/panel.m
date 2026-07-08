// Non-activating panel support for the menu-bar popover and the capture takeover window.
//
// Problem: tao creates plain NSWindow instances. When Tauri's set_focus() shows one it calls
// makeKeyAndOrderFront + NSApp activateIgnoringOtherApps, which activates the WHOLE app and
// raises every Sparkle window over whatever the user was working in. For a menu-bar popover /
// capture overlay that is exactly wrong: the user wants their front app to stay front.
//
// Fix: reclass the window instance to a minimal NSPanel subclass and set the
// NSWindowStyleMaskNonactivatingPanel style bit (only NSPanel honors it). A non-activating
// panel can be ordered front and become key — receiving clicks and keystrokes — WITHOUT
// activating the app, so the previously-active app stays the active/front app. This is the same
// object_setClass technique the community `tauri-nspanel` crate uses; NSWindow and NSPanel share
// instance layout, so reclassing preserves the tao window's ivars, delegate, and content view.
//
// Compiled by build.rs (cc, -fobjc-arc) alongside force_present.m; linked against AppKit.

#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>

// Minimal non-activating panel. Adds NO ivars (object_setClass keeps the original instance
// memory), so reclassing a tao NSWindow to this is safe.
@interface SparkleNonactivatingPanel : NSPanel
@end
@implementation SparkleNonactivatingPanel
// Allow typing / the dictation caret to land here without activating the app.
- (BOOL)canBecomeKeyWindow { return YES; }
// This is an auxiliary floating panel, never the app's "main" window.
- (BOOL)canBecomeMainWindow { return NO; }
@end

// Reclass an existing tao NSWindow into a non-activating NSPanel. Call ONCE at window creation.
void sparkle_make_nonactivating_panel(void *ns_window) {
    if (!ns_window) return;
    NSWindow *win = (__bridge NSWindow *)ns_window;
    object_setClass(win, [SparkleNonactivatingPanel class]);
    NSPanel *panel = (NSPanel *)win;
    panel.styleMask |= NSWindowStyleMaskNonactivatingPanel;
    // A plain panel hides when its app deactivates; we want it to persist over the user's app.
    panel.hidesOnDeactivate = NO;
    // Float over other Spaces / fullscreen apps without yanking the user to Sparkle's Space.
    panel.collectionBehavior |=
        NSWindowCollectionBehaviorCanJoinAllSpaces |
        NSWindowCollectionBehaviorFullScreenAuxiliary;
}

// Order the panel front + make it key WITHOUT activating the app. For a non-activating panel,
// makeKeyAndOrderFront: does not call activateIgnoringOtherApps, so the user's frontmost app
// stays frontmost. Replaces Tauri's app-activating set_focus() for these windows.
void sparkle_present_panel_key(void *ns_window) {
    if (!ns_window) return;
    NSWindow *win = (__bridge NSWindow *)ns_window;
    [win makeKeyAndOrderFront:nil];
}
