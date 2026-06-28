// Force Notification Center banners to show even while Sparkle is the frontmost app.
//
// mac-notification-sys (0.6.15) posts via the deprecated NSUserNotification API and installs an
// NSUserNotificationCenter delegate (class `NotificationCenterDelegate`) to capture banner clicks
// — but it never implements `userNotificationCenter:shouldPresentNotification:`. With
// NSUserNotification, macOS SUPPRESSES the banner whenever the posting app is active/frontmost
// unless that delegate method returns YES. The result: you got no banners for an agent while you
// were looking at Sparkle (the very case that matters when one agent finishes/errors while you
// work in another) — they were silently filed into Notification Center instead.
//
// This adds the missing method as an Objective-C CATEGORY on the crate's existing delegate class,
// returning YES so banners ALWAYS present. A category augments the class in place, so the crate's
// click handling (its own delegate methods) is untouched. Pinned to mac-notification-sys 0.6.15
// by the `NotificationCenterDelegate` class name; if a crate bump renames it, this fails LOUD at
// link time (undefined `_OBJC_CLASS_$_NotificationCenterDelegate`) rather than silently no-op'ing.
#import <Foundation/Foundation.h>

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

@interface NotificationCenterDelegate : NSObject
@end

@interface NotificationCenterDelegate (SparkleForcePresent)
@end

@implementation NotificationCenterDelegate (SparkleForcePresent)
- (BOOL)userNotificationCenter:(NSUserNotificationCenter *)center
     shouldPresentNotification:(NSUserNotification *)notification {
  return YES;
}
@end

#pragma clang diagnostic pop

// Anchor referenced from Rust (attention.rs init_application). Categories living in a static lib
// are dead-stripped unless something pulls their object file into the link; calling this empty
// symbol forces force_present.o — and thus the category above — to be retained and loaded.
void sparkle_force_present_anchor(void) {}
