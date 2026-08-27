// THE ONE READER of the macOS delivered-notification list, and the two jobs it serves:
//
//  1. Expire attention banners the user never touched, so the delivered list stops growing without
//     bound and the in-flight slots their parked threads hold are released.
//  2. Publish what it just read as the SHARED SNAPSHOT every parked banner consults to learn
//     whether it has been auto-dismissed (`sparkle_delivered_snapshot_*` -> attention.rs).
//
// Job 2 used to be done per banner, by each parked thread, against the OS itself: the vendored
// notify.m's `wasAutoDismissed()` iterated `deliveredNotifications` every 0.5s per banner — a
// synchronous whole-list XPC round-trip each time, ~32/second at the 16-banner cap, forever. This
// file was already reading exactly that list on its own cadence, so the two readers were merged
// into this one. Adding a second read anywhere in the notification path reinstates the defect.
//
// ── THE DEFECT THIS EXISTS TO BOUND ───────────────────────────────────────────────────────────
// attention.rs asks mac-notification-sys for a CLICKABLE banner (`wait_for_click(true)`), because a
// tap has to route to the specific worker that asked. In 0.6.15 that sets `shouldWait = YES`, and
// when `send()` is called off the main thread — which it is, from a detached thread, because it
// blocks — objc/notify.m installs a REPEATING 0.5s NSTimer ON THE MAIN RUN LOOP, one per
// notification. Its block calls `wasAutoDismissed()`, which iterates
// `notificationCenter.deliveredNotifications`: a SYNCHRONOUS cross-process XPC query to
// usernotificationd. The UI is blocked for however long that daemon takes to answer.
//
// The timer is invalidated only on activate / dismiss / auto-dismiss. Nothing expires a banner the
// user never clicks, so it polls FOREVER. `MAX_IN_FLIGHT_NOTIFICATIONS` (16) bounds the parked
// threads but not this, so under agent load the app fills to the cap and stays there.
//
// ── WHAT THE VENDORED PATCH ALREADY FIXED, AND WHAT IT DID NOT ────────────────────────────────
// The `ON THE MAIN RUN LOOP` half of that is fixed elsewhere and not by this file: the vendored
// mac-notification-sys patch (`vendor/mac-notification-sys/objc/notify.m`) moved the poll onto the
// caller's background thread, so a lingering banner no longer touches the UI thread. This file must
// not claim credit for that, and must not undo it — see the threading note on the function below.
//
// What that move did NOT do is stop the list from GROWING. Every poll still marshals the whole
// delivered list, so the per-poll cost keeps climbing for the life of the process (measured: 22% ->
// 38% blocked share across one session while the parked-thread count stayed pinned, footprint
// 919MB -> 1.1GB), and — the sharper one — a banner that never leaves the center never releases the
// in-flight slot its parked thread holds, so attention banners eventually stop being posted at all.
// Bounding the list is this file's job.
//
// Measured, not theorised: `sample` of a live 30s latency episode (pid 72770, 2026-07-29 13:03:30,
// 5159 samples at 1ms) found 1160 samples — 22% of wall clock — parked in
// `semaphore_timedwait_trap` under `-[_NSConcreteUserNotificationCenter deliveredNotifications]`,
// reached from `__NSFireTimer`. Of NON-idle main-thread time that is essentially all of it, and 17
// threads sat in `rust_wait_for_notification`, i.e. the cap was saturated. It is also why the
// minute-long beachball left no crash file, no panic and no jank line: a main thread asleep in the
// kernel cannot write one.
//
// ── WHY REMOVAL IS THE LEVER ──────────────────────────────────────────────────────────────────
// We do not fight the crate's timer; we satisfy its exit condition. `wasAutoDismissed()` returns YES
// exactly when the notification is no longer in `deliveredNotifications`, and the crate then
// invalidates the timer, calls `resolveAutoDismiss`, and unparks the waiting thread — which returns
// `NotificationResponse::None` and releases its in-flight slot. So removing a stale banner unwinds
// the whole chain through the crate's OWN designed path, with no fork and no patch.
//
// Nothing is lost by expiring one. An attention banner says an agent needs you NOW; it is stale
// within seconds. The durable signals — the dock badge (`apply_badge`) and the in-app attention
// state — are unaffected and continue to reflect every waiting agent.
//
// Pinned to mac-notification-sys 0.6.15 by the same reasoning as force_present.m: this depends on
// the crate posting via NSUserNotification, so a bump to UNUserNotificationCenter would leave this
// sweeping an empty legacy center while the real notifications polled on unbothered. That would be
// SILENT, which is why the crate is `=`-pinned in Cargo.toml and why a bump is a reviewed step.
#import <Foundation/Foundation.h>
#import <math.h>
#import <stdbool.h>
#import <stdlib.h>

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

// EVERY DECISION LIVES IN RUST (attention.rs `select_evictions`), not here.
//
// This file cannot be unit-tested: it needs a live usernotificationd, so nothing in CI can catch an
// inverted comparison, an off-by-one, or a flipped sort order in it. That is exactly where such a
// bug hides. So this half owns only what MUST be Objective-C — reading the delivered list, dating
// each entry, and performing the removals — and hands Rust the ages, getting back the indices to
// remove, in the order to remove them.
//
// Both halves of the policy were once here and both were wrong to be. The staleness comparison came
// back first; the eviction ORDER followed, after review pointed out that flipping two constants in
// the comparator would evict NEWEST-first — killing the click-through route for the agent that just
// asked while leaving five-minute-old banners polling, which is the precise harm the budget exists
// to prevent — with every Rust test still green, because the budget decides how many and never
// which. Same shape as mac-notification-sys's own `rust_notification_is_delivered` callback.
//
// Writes at most `outCap` indices into `out`; returns how many.
extern size_t sparkle_select_notifications_to_evict(const double *ages, size_t count,
                                                    double ttlSeconds, unsigned int maxRemovals,
                                                    unsigned int *out, size_t outCap);

// THE OTHER CONSUMER OF THE ONE READ BELOW (attention.rs, the "ONE READER" note).
//
// Every parked banner used to answer "am I still delivered?" by asking the OS itself — the vendored
// notify.m called `wasAutoDismissed()`, which iterated `deliveredNotifications` once per banner
// every 0.5s. At the 16-banner cap that is ~32 whole-list XPC round trips per second, forever,
// each one marshalling and unarchiving the entire list. This file was ALREADY reading exactly that
// list on its own 15s cadence, so the two readers are now one: we publish the identifiers we just
// read as a snapshot, and notify.m answers from it with a hash lookup and no XPC at all.
//
// Publish protocol, in this order and from a single read: begin, add each identifier, commit.
// Only a COMMITTED snapshot is consulted, so a partial publish can never read as "the rest are
// gone" and auto-dismiss the tail of the list.
extern void sparkle_delivered_snapshot_begin(size_t capacity);
extern void sparkle_delivered_snapshot_add(const char *identifier);
extern void sparkle_delivered_snapshot_commit(void);

// Remove delivered notifications the Rust selector picks: stale ones, oldest first, at most
// `maxRemovals`. Returns how many were removed.
//
// There is NO value of `maxRemovals` that means unbounded — the Rust selector clamps whatever it is
// given to MAX_EVICTIONS_PER_SWEEP. An earlier version of this comment offered UINT_MAX as "no
// budget", which would have invited a future caller to restore the arbitrarily large main-thread
// batch the ceiling exists to prevent.
//
// ── THREADING: CALL THIS FROM A BACKGROUND THREAD, NOT MAIN ───────────────────────────────────
// An earlier version of this file demanded the opposite ("MAIN THREAD ONLY"), on the reasoning that
// NSUserNotificationCenter carries no documented thread-safety guarantee. That reasoning is now
// obsolete and following it would be actively harmful: the vendored mac-notification-sys patch
// (`vendor/mac-notification-sys/objc/notify.m`, the notification-xpc-offthread change) moved the
// auto-dismiss poll's `deliveredNotifications` call OFF the main run loop precisely because that
// synchronous XPC round-trip was the largest source of main-thread jank in the app. Up to 16 of the
// crate's own threads now read `deliveredNotifications` concurrently off-main as a matter of course.
// A 15-second main-thread sweep here would put back a slice of the exact cost that change removed,
// and would be the ONLY main-thread XPC left in the notification path.
//
// So this follows the same shape the vendored patch established: the read and the ageing happen on
// the caller's background thread, and we `dispatch_sync` to main ONLY to perform the removals —
// skipped entirely when there is nothing to expire, which is the overwhelmingly common case.
// Mutation stays on main because removal is what touches the user-visible Notification Center;
// reading does not.
//
// That batch is bounded UNCONDITIONALLY, by `MAX_EVICTIONS_PER_SWEEP` in `removal_budget`, not just
// by the pressure budget. The distinction matters: with slack there is no slot scarcity to ration,
// so an earlier version passed UINT_MAX and the hop was unbounded exactly in the low-pressure case
// — worst of all at launch, where the sweep is deliberately started early to collect banners left
// over from a previous run, so the first tick could meet an arbitrarily large backlog with zero
// pressure and block main for the whole of it. Deferring the remainder to the next tick costs
// nothing, because the TTL is absolute rather than a countdown.
unsigned int sparkle_sweep_delivered_notifications(double ttlSeconds, unsigned int maxRemovals) {
  // @autoreleasepool IS LOAD-BEARING, not hygiene. This runs on a raw pthread from
  // std::thread::spawn, which — unlike the main run loop, and unlike a GCD queue — has NO ambient
  // autorelease pool. It used to run via run_on_main_thread and inherited the run loop's pool; it
  // no longer does. Without this, every autoreleased temporary below is permanently leaked and
  // each one prints "Object 0x… autoreleased with no pool in place - just leaking" to stderr:
  // the marshalled deliveredNotifications array, the NSDate, and every per-entry temporary — on
  // every tick, forever, in the one file whose stated job is to stop this list growing without
  // bound. ARC does not save this; Foundation's convenience constructors are precisely the case
  // its fast path cannot elide. The vendored notify.m wraps its own off-main poll the same way.
  @autoreleasepool {
  NSUserNotificationCenter *center = [NSUserNotificationCenter defaultUserNotificationCenter];
  if (center == nil) {
    // Deliberately publish NOTHING. We did not read the list, and an empty snapshot is not the
    // same statement as "no notifications" — committing one here would tell every parked banner
    // it had been dismissed.
    return 0;
  }

  // ── THE ONE READ ────────────────────────────────────────────────────────────────────────────
  // Everything below — the snapshot the parked banners consult AND the expiry decision — comes
  // out of this single `deliveredNotifications` call. Adding a second read anywhere reinstates
  // the defect this merge removed.
  NSArray<NSUserNotification *> *delivered = center.deliveredNotifications;
  NSUInteger total = delivered.count;

  // Publish first, and unconditionally: an empty delivered list is a real and important reading
  // (it is what tells every parked banner it is gone), and the watchers must not depend on the
  // expiry budget or on there being anything stale to remove.
  sparkle_delivered_snapshot_begin((size_t)total);
  for (NSUInteger i = 0; i < total; i++) {
    NSString *identifier = delivered[i].identifier;
    if (identifier != nil) {
      sparkle_delivered_snapshot_add([identifier UTF8String]);
    }
  }
  sparkle_delivered_snapshot_commit();

  if (total == 0 || maxRemovals == 0) {
    return 0;
  }

  NSDate *now = [NSDate date];
  double *ages = (double *)calloc(total, sizeof(double));
  unsigned int *picked = (unsigned int *)calloc(total, sizeof(unsigned int));
  if (ages == NULL || picked == NULL) {
    free(ages);
    free(picked);
    return 0;
  }

  for (NSUInteger i = 0; i < total; i++) {
    NSUserNotification *n = delivered[i];
    // `actualDeliveryDate` is when it was really shown and is the honest clock for "how long has
    // this been sitting there". It is nil for a notification that has not been delivered yet (a
    // scheduled one), so fall back to `deliveryDate`; if BOTH are nil we cannot age it. NAN rather
    // than a guess — `should_expire` rejects non-finite ages, so an undatable banner is KEPT.
    // Removing one we cannot date risks pulling it out from under the user mid-read, and an
    // undatable notification is not the accumulating case.
    NSDate *shownAt = n.actualDeliveryDate ?: n.deliveryDate;
    ages[i] = (shownAt == nil) ? NAN : [now timeIntervalSinceDate:shownAt];
  }

  size_t take = sparkle_select_notifications_to_evict(ages, (size_t)total, ttlSeconds, maxRemovals,
                                                      picked, (size_t)total);
  free(ages);
  if (take == 0) {
    // The common case, and the reason this is cheap: nothing stale means we never touch main.
    free(picked);
    return 0;
  }

  NSMutableArray<NSUserNotification *> *doomed = [NSMutableArray arrayWithCapacity:take];
  for (size_t i = 0; i < take; i++) {
    unsigned int idx = picked[i];
    if ((NSUInteger)idx < total) {
      [doomed addObject:delivered[idx]];
    }
  }
  free(picked);

  // The ONLY main-thread hop, and only when there is something to remove. One batch, not one hop
  // per notification. `dispatch_sync` from a non-main thread is safe here — this function is never
  // called ON main (see the threading note above) — but guard anyway rather than deadlock.
  void (^removeAll)(void) = ^{
    for (NSUserNotification *n in doomed) {
      [center removeDeliveredNotification:n];
    }
  };
  if ([NSThread isMainThread]) {
    removeAll();
  } else {
    dispatch_sync(dispatch_get_main_queue(), removeAll);
  }
  return (unsigned int)doomed.count;
  } // @autoreleasepool
}

#pragma clang diagnostic pop
