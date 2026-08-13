// THE ONE WAY TO PUSH THE CONCIERGE FROM OUTSIDE ITS OWN MOUNT — a registered sink, not a call.
//
// ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────────────────────────
// Founder, on the state he keeps finding: *"the build agent AND THE CONCIERGE are both just sitting
// silent."* The half that matters is the second one. The concierge acts when he speaks and otherwise
// sits idle, so when a build agent goes quiet AND the concierge does not notice, there is no third
// party to break the tie. Every watchdog in this app points at build agents; none points at the
// thing supposed to be watching them.
//
// The obstacle was structural rather than a missing feature. The concierge is a headless `claude -p`
// child (`concierge.rs`) with no row in the roster and no self; the inbox is concierge→agent ONLY
// (every enqueue hardcodes `from: "concierge"`); and no control op prompts it. The single channel
// that can make it speak unprompted is `concierge_proactive_turn`, and that is owned by
// `ConciergeHost` — which must own it, because it is also the thing that records each push's digest
// so a stale one can be retracted. `conciergeProactive`'s header is explicit that a transport used
// without that mount produces an unretractable push.
//
// So this is a registration point, not a transport. `ConciergeHost` hands over its scheduler's
// `notify`, which keeps every cost control and every retraction guarantee where they already live,
// and callers elsewhere get one function that either reaches the concierge or honestly says it did
// not.
//
// ── AN UNVERIFIED PUSH IS A FAILED PUSH ──────────────────────────────────────────────────────────
// `notifyConcierge` returns a BOOLEAN and the boolean is the point. Three of this app's five
// delivery paths have been caught reporting success they did not observe — `inbox_send` returning an
// id for a message never queued (sparkle-bbghz), `send_control_key` returning ok for an Enter that
// did nothing (sparkle-bhhu1), a bridge timeout misreported as an agent error (sparkle-b3coh). A
// fourth that returned `void` and let the caller assume would be the same defect wearing a new
// name, so the "nobody is listening" case is a value the caller has to handle rather than a silence
// it can miss.
//
// Nobody listening is a REAL state, not a defect: no window is open, the host is unmounted, or this
// is a satellite window that never had a concierge. The Pusher treats it as an undelivered push,
// keeps the finding owed, and retries next sweep.
//
// AND FOR A LONG TIME THE BOOLEAN ONLY MEASURED THAT ONE STATE (bead sparkle-qogah). It answered
// "was a sink registered", then returned `true` for everything the sink itself refused — a disposed
// scheduler, an overflowing owed list. So this file made the fifth delivery path the fourth
// false-success rather than the exception to them, in the middle of a header saying it must not be.
// The sink type now returns a boolean and that answer is propagated verbatim; "somebody was
// listening" and "the message was accepted" are two facts and only the second one is reported.

import { log } from "../logger";
import type { NoticeKind } from "./conciergeProactive";

/**
 * What a registered sink looks like — `ProactiveScheduler.notify`, structurally.
 *
 * IT RETURNS A BOOLEAN, and that is the fix for the defect the header above describes arriving
 * through this very file (bead sparkle-qogah). While this was `=> void` there was no way for a sink
 * to refuse: `notifyConcierge` called it and returned `true` unconditionally, so the scheduler's own
 * `disposed` guard and its overflow drop both read to the Pusher as successful deliveries. The
 * contract is now the same one `notifyConcierge` publishes to its callers — true only if the text is
 * genuinely owed and will be acted on.
 */
export type ConciergeNotifier = (text: string, kind?: NoticeKind) => boolean;

let sink: ConciergeNotifier | null = null;

/**
 * Register the concierge's push sink. Clearing is {@link clearConciergeNotifier}, never this.
 *
 * IT DOES NOT TAKE `null`, and that is deliberate rather than an omission (roborev 57705). It used
 * to accept one and silently ignore it while the doc invited callers to clear that way — so a caller
 * following the documented contract would leave the PREVIOUS sink installed, and if that sink
 * belonged to a disposed scheduler, `notifyConcierge` would return `true` for text `notify()`
 * discards on its own `disposed` guard. That is the false-success this whole file exists to prevent,
 * arriving through its own API. An unclearable clear is not a small doc bug here; it is the bug
 * class, so the type no longer permits it.
 *
 * LAST REGISTRATION WINS, and that is the correct rule for the way this is mounted. `ConciergeHost`
 * registers in an effect and clears in its cleanup; under React's strict-mode double-invoke, and
 * during any remount, the mount of the new instance runs BEFORE the cleanup of the old. Keeping the
 * first would mean the survivor of a remount is the dead one.
 *
 * The clear is therefore identity-checked: a cleanup only clears the sink if it is still its own, so
 * an outgoing instance cannot unregister its replacement.
 */
export function setConciergeNotifier(fn: ConciergeNotifier): void {
  sink = fn;
}

/** Clear `fn` if it is still the registered sink. See {@link setConciergeNotifier}. */
export function clearConciergeNotifier(fn: ConciergeNotifier): void {
  if (sink === fn) sink = null;
}

/** Is anyone listening? Exposed so a caller can decide before composing an expensive message. */
export function conciergeNotifierAvailable(): boolean {
  return sink !== null;
}

/**
 * Push one finding to the concierge. Returns whether it was actually ACCEPTED — not merely whether
 * there was somebody to hand it to.
 *
 * `false` means the caller's message went NOWHERE and must stay owed — see the header.
 *
 * THE SINK'S OWN ANSWER IS THE ANSWER (bead sparkle-qogah). This used to be `fn(text); return true;`,
 * which turned "a sink exists" into "the message was delivered" — two different facts, and the gap
 * between them is where findings died. A registered-but-disposed scheduler, or one refusing at its
 * ceiling, discards the text on its own guards; reporting that as success made `pusherRunner` spend
 * a rate-budget slot and stamp the condition as reported for four hours, so the finding was not just
 * lost but suppressed at source. A sink that says no is now propagated as no.
 */
export function notifyConcierge(text: string, kind: NoticeKind = "pusher"): boolean {
  const fn = sink;
  if (fn === null) {
    log.debug("pusher", "concierge push dropped — no notifier registered in this window");
    return false;
  }
  try {
    const accepted = fn(text, kind);
    if (!accepted) {
      // A REFUSAL IS NOT AN ERROR, and it is not silence either: the sink is alive and declining
      // this specific text, so it is worth a line the way a failed inbox write is. The finding
      // stays owed and comes back next sweep.
      log.warn("pusher", "concierge push refused by the sink; the finding stays owed");
      return false;
    }
    return true;
  } catch (e) {
    // A throwing sink is a failed delivery, not a crashed sweep. Reported as false so the finding is
    // retried rather than silently counted as spoken.
    log.warn("pusher", "concierge push threw", { error: String(e) });
    return false;
  }
}

/** Test seam: forget the registration. */
export function _resetConciergeNotifierForTests(): void {
  sink = null;
}
