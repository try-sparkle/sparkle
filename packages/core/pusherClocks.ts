// SINCE-WHEN, for conditions nothing else in the app times.
//
// ── WHY THE PUSHER HAS TO KEEP ITS OWN CLOCKS ────────────────────────────────────────────────────
// Two of the four triggers are about DURATION — "4 commits unpushed for 38 minutes", "you asked a
// question 23 minutes ago" — and neither duration is recorded anywhere.
//
//   • `goalContinuationRunner.idleSinceFor` looks like the answer and is not: its `RESTING` set is
//     `["idle", "unmerged"]`, so an agent in `waiting` or `approval` — precisely the one that asked
//     a question — never gets an `idleSince` at all.
//   • `AgentAlertRecord` carries `{seq, lastRed, dismissedSeq}`: episode counters, no timestamp.
//   • `runtimeStore.lastObserved` is written only by `close()`, so it says when a pane shut, never
//     how long a live agent has been asking.
//   • Only `errored` has a real since-clock (`apiRecoveryEpisode().erroredSince`), and that is one
//     status the Pusher does not trigger on.
//
// So the Pusher measures elapsed time itself, from its own observations. That is honest about what
// it can know — "how long WE have seen this" rather than a git author date or a message timestamp we
// never had — and it is also the quantity the challenge should cite, because it is the one the
// partner can act on.
//
// ── THE RULE IS `trackIdleSince`'s, GENERALIZED ──────────────────────────────────────────────────
// One function serves both clocks, and it is deliberately the same rule the goal runner already
// uses for its idle clock: still-true and already-stamped keeps the ORIGINAL stamp (that is what
// makes it "continuously true since", not "true as of the last sweep"); newly true stamps `now`;
// no longer true is DROPPED.
//
// Dropping on absence does two jobs at once, which is why it is worth stating. It garbage-collects
// a closed agent's entry — the map only ever holds keys the caller just observed — and it is the
// same signal `expireClearedTriggers` keys on, so a condition that clears and returns is correctly
// timed from its SECOND onset rather than its first. An agent that pushed its commits and wrote new
// ones is "unpushed for 2 minutes", not "for 3 hours".
//
// Pure: no clock of its own, no I/O. The caller passes `now` and the keys it just saw.

/**
 * `key → epoch ms the condition became continuously true`.
 *
 * A `Map`, not a `Record`, and that is a correctness choice rather than a style one — it mirrors
 * `goalContinuationRunner`'s `IdleClock = ReadonlyMap`. A plain object resolves `Object.prototype`
 * members, so a key like `"constructor"` reads back an inherited FUNCTION instead of `undefined`,
 * `elapsedSince` computes `now - fn` and returns **NaN typed as number**, and `"__proto__"` fails a
 * second way (the write is silently discarded while the read still answers non-undefined).
 *
 * That defeats this module's whole contract: `undefined` is supposed to be the fail-closed answer,
 * and NaN is not `undefined`. A `Map` has no prototype chain, so the class of bug does not exist.
 */
export type SinceClock = ReadonlyMap<string, number>;

/**
 * Advance a since-clock by one observation.
 *
 * `activeKeys` is every key for which the condition holds RIGHT NOW. Anything absent is dropped,
 * which is what makes a cleared-and-returned condition restart its clock — see the header.
 */
export function trackSince(
  prev: SinceClock | undefined,
  activeKeys: readonly string[],
  now: number,
): Map<string, number> {
  const next = new Map<string, number>();
  for (const key of activeKeys) {
    next.set(key, prev?.get(key) ?? now);
  }
  return next;
}

/**
 * How long `key`'s condition has been continuously true, in ms — or `undefined` if it is not.
 *
 * `undefined` is a real answer and must not be read as zero: "we have never observed this" and
 * "this just started" are different facts, and only the second one is evidence of anything. Every
 * trigger that consumes this is fail-closed on `undefined`, matching `agentStall`'s rule that an
 * absent input never manufactures a finding.
 */
export function elapsedSince(clock: SinceClock | undefined, key: string, now: number): number | undefined {
  const at = clock?.get(key);
  if (at === undefined) return undefined;
  // A clock stamped in the future (a clock adjustment, a caller passing a stale `now`) reads as 0
  // rather than negative: a negative duration would render as "-3 minutes ago" in a challenge, and
  // the citation gate would happily pass it because the number IS measured.
  return Math.max(0, now - at);
}
