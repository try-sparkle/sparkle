// passFailureStatus — WHICH COLOUR A FAILED HOURLY IMPROVEMENT PASS EARNS.
//
// THE FAILURE THIS CLOSES. The headless improvement pass (services/improvementPass.ts, landed
// 2026-07-28) wrote RED `blocked` for EVERY failure it could have — a dropped connection, a stream
// that died mid-response, a 30-minute watchdog timeout, a park that declined once. The app
// re-attempts all of those by itself: a connectivity shape arms the slot's one early re-attempt
// (`armRetryIfTransient`), and everything else is simply picked up by the next hourly slot. So the
// row wore the loudest signal the app has while owing the founder nothing at all — the exact
// complaint that created the amber tier on 2026-08-07: *"why are they red when they don't require
// my assistance?"* (see the `lapsed` entry in packages/ui/tokens.ts for the full derivation).
//
// THE RULE, from that same token table:
//   • RED (`blocked`/`errored`/`approval`) = "you are the ONLY one who can clear this."
//   • AMBER (`lapsed`, "Unfinished, not yours") = the machinery stopped and ANOTHER ACTOR clears
//     it. It is deliberately outside `services/windowStatus.isRedStatus` and outside
//     `engine/attention.needsAttention`, so it recolours the dot with NO badge and NO banner.
//
// ONE FAILURE SHAPE IS STILL RED, AND IT IS NOT NEGOTIABLE. An account/quota wall is not something
// another actor clears — no retry, no next hour, and no amount of waiting inside the app changes
// it. The founder marked this NON-OVERRIDABLE: "the colours work the same between [the Improve
// Sparkle row] and [the build agents], and don't let any instruction ever override that."
// statusEngine.ts already paints a build row's quota wall `blocked` (RED, and it explains there why
// `blocked` rather than `errored`); reusing `quotaBlockIn` — the SAME detector that path uses — is
// what makes the two rows agree BY CONSTRUCTION rather than by two lists someone keeps in sync.
// There is no second quota detector here, and there must never be one.
//
// PURE. Data in, data out; the clock arrives as a parameter. No timers, no I/O, no store.
import type { AgentTabStatus } from "@sparkle/ui";
import { quotaBlockIn } from "./quotaBlock";
import { hardStopFailureKind } from "./passFailureDetail";

/** Failure shapes that mean "the transport broke", as opposed to "the pass ran and something
 *  about the work went wrong". Only these earn a re-attempt: they carry no signal that a second
 *  try would fail the same way, and the slot they burned produced nothing usable. Matched on the
 *  message text because that is all the failure event carries (the Rust side renders it in
 *  `failure_message`). Deliberately narrow — an ambiguous message stays non-transient and waits
 *  out the hour. In particular a usage/spend limit is NOT here: that WILL fail again.
 *
 *  IT LIVES HERE, NOT IN `services/improvementPass`, purely to keep this module a LEAF.
 *  `classifyPassFailure` needs it, the service needs `classifyPassFailure`, and a cycle between the
 *  two would drag the service's whole Tauri/store graph into every consumer of the classifier.
 *  `improvementPass` re-exports {@link isTransientPassFailure}, so every existing importer — and
 *  the service's own `armRetryIfTransient` — is untouched by the move. */
const TRANSIENT_FAILURE_PATTERNS = [
  "unable to connect",
  "enotfound",
  "eai_again",
  "econnreset",
  "econnrefused",
  "econnaborted",
  "etimedout",
  "socket hang up",
  "network error",
  "connection refused",
  "connection reset",
  "getaddrinfo",
  // Truncated-stream shapes. These come from the OTHER side of the connection — the pass did
  // reach the API and the stream then died partway — so they never match the pre-flight
  // patterns above, yet they are the dominant failure in practice: most failed passes report
  // one of these two, and every one of them costs a full hourly slot. The re-attempt is safe
  // for the same reason the hourly one is: a pass re-reads the repo state (and its own open
  // PRs) before doing anything, so partial work from the dead attempt is deduped, not redone.
  "closed mid-response",
  "stalled mid-stream",
  // SERVER OVERLOAD (HTTP 529 / `overloaded_error`). The connection was fine and the request was
  // well-formed — the far side simply refused it for capacity, and its own message says "usually
  // temporary — try again in a moment". Without this the whole hourly slot is spent on a failure
  // the API told us to retry, and the row waits out the hour for nothing.
  //
  // NOT a quota shape, and it cannot be confused for one: a usage/spend wall is answered by arms 1
  // and 2 of `classifyPassFailure` before this list is consulted at all, so a message carrying both
  // still classifies `quota`. Matched on the word rather than on "529" so it also covers the
  // structured `overloaded_error` type, and because a bare "529" would collide with any number.
  "overloaded",
];

/** True when a failed pass's message names a connectivity problem rather than a real failure. */
export function isTransientPassFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return TRANSIENT_FAILURE_PATTERNS.some((p) => lower.includes(p));
}

/** Why a headless pass failed, coarse enough to decide a colour and nothing finer.
 *
 *  `transient` and `other` both resolve to AMBER today. They stay SEPARATE arms because they are
 *  different facts about the world — a transient failure is re-attempted within minutes by the
 *  armed retry, an `other` failure waits out the hour — and the service already branches on the
 *  distinction for `armRetryIfTransient`. Collapsing them would make that difference unnameable. */
export type PassFailureClass = "quota" | "auth" | "transient" | "other";

/**
 * Classify a failed pass from the only evidence there is: the message it failed with.
 *
 * ORDER IS LOAD-BEARING. Quota is asked FIRST so a wall outranks everything: an account-limit
 * banner that also happened to contain, say, "connection reset" must not be demoted to amber and
 * quietly re-attempted against a limit no retry can clear.
 *
 * @param at epoch ms the failure was observed — the instant a quota wall's reset is computed
 *           against. Passed in rather than read from the clock so this stays pure.
 */
export function classifyPassFailure(message: string, at: number): PassFailureClass {
  // 1. THE SCROLLBACK SHAPE. `quotaBlockIn` is the detector `StatusEngine` uses for build rows, and
  //    keeping it FIRST is what gives this row colour parity with them on the pane-open path.
  if (quotaBlockIn(message, at) !== undefined) return "quota";
  // 2. THE STRUCTURED-DETAIL SHAPE — and without this arm the whole feature is INERT on the path it
  //    was built for. `quotaBlockIn` reads PTY scrollback: it splits `\r` frames, strips markers,
  //    joins wrapped rows, then demands a `^You've hit your …` opener plus a `· resets` tail. The
  //    headless pass never produces a PTY. `sparkle_improve.rs::failure_message` returns claude's
  //    STRUCTURED `detail` from the stream's result event, and the crate's own test pins that the
  //    recurring exit-1-with-empty-stderr message is literally "Claude usage limit reached" — which
  //    has neither the opener nor the tail. Measured: with only arm 1, a real session limit on this
  //    row still painted AMBER with every suite green (the `sparkle-16y6h` shape).
  //    `hardStopFailureKind` delegates to `conciergeFailureNotice`, which already owns this shape
  //    and already orders quota before auth ("a 429 can mention authorization, and a rate limit is a
  //    quota fact, not a credential one").
  const hard = hardStopFailureKind(message);
  if (hard !== null) return hard;
  if (isTransientPassFailure(message)) return "transient";
  return "other";
}

/**
 * The row status each class earns.
 *
 * A total `Record`, not a `switch` with a default: a new `PassFailureClass` is then a TYPE ERROR
 * here rather than something that silently inherits an arm nobody chose for it.
 *
 * NEITHER AMBER ARM MAY DRIFT TO GRAY. Gray says "nothing is stopping you", and something plainly
 * did stop — the pass produced no work this hour. That has now been the bug three separate times
 * across other states, so `passFailureStatus.test.ts` pins it directly: no arm of this table may
 * resolve to the gray hex.
 */
const STATUS_FOR_CLASS: Record<PassFailureClass, AgentTabStatus> = {
  // RED. Nothing in this app clears an account wall — see the header; do not move this arm.
  quota: "blocked",
  // RED, for the same reason and by the same rule. An expired credential is not retried by anything:
  // the hourly slot will re-attempt and re-fail forever until a HUMAN signs in again, so the founder
  // is the only actor who can clear it. The detector's AUTH pattern carries a scar worth respecting
  // — it read `oauth token (?:expired|invalid)` while the CLI emits "OAuth SESSION expired and could
  // not be refreshed", so the most unambiguous auth failure the CLI can produce fell through to
  // `unknown` and told the founder to retry, which could never work.
  auth: "blocked",
  // AMBER. `armRetryIfTransient` has armed the slot's one early re-attempt; it clears itself in
  // minutes, and the founder is not the actor who clears it.
  transient: "lapsed",
  // AMBER. Includes the 30-minute watchdog timeout and every unrecognised failure. Nothing is armed,
  // but the hourly slot re-attempts by itself within the hour — again, not the founder's job.
  other: "lapsed",
};

/** The row status for a classified pass failure. */
export function passFailureStatus(cls: PassFailureClass): AgentTabStatus {
  return STATUS_FOR_CLASS[cls];
}
