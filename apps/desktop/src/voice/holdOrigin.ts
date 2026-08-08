// WHEN THE GESTURE HAPPENED — the one stamp nothing upstream of Rust was taking.
//
// The founder's loudest, most-repeated complaint is that push to talk loses the first words of an
// utterance, and every attempt to attack it has been argued from numbers that begin TOO LATE. The
// earliest timestamp in the whole chain was `t_cmd` in `dictation.rs` `start_dictation`, which is
// command ENTRY in Rust. Everything before it — this keydown handler, the two zustand writes, React
// scheduling the `[enabled]` effect, the `await controllerPromiseRef` gate, and the JS→Tauri IPC hop
// — was unmeasured and unlogged. So the number the whole design rests on, keydown → first captured
// sample, had never once been observed. `PRD/fix/push-to-talk-leading-words.md` records three
// measured rounds and every one of them starts at `Capture::start`.
//
// This module is that missing stamp, and it is deliberately a module-level singleton rather than
// state threaded through the hooks. The value is a MONOTONIC CLOCK READING with exactly one writer
// (the keydown) and one reader (the `invoke`), and the two live in different components connected
// only by a zustand write and a React effect. Threading it would mean widening `onHoldStart`,
// `applyIntent`, the dictation store, and the effect's dependency list to carry a diagnostic — four
// production signatures changed so a log line can be complete. A one-slot handoff is the smaller
// blast radius, and it cannot desync the way a copy in the store could.
//
// ── WHY `performance.now()` AND NOT `Date.now()` ─────────────────────────────────────────────────
// `performance.now()` is monotonic. `Date.now()` is not: an NTP correction or a manual clock change
// mid-hold can make the age negative or wildly large, and this number is about to be published as
// the headline latency figure. `takeHoldOriginAge` rejects both shapes anyway (see below), but the
// monotonic clock means it almost never has to.

/**
 * The longest age this module will report, in ms.
 *
 * THIS IS A CORRECTNESS GUARD, NOT A TUNING KNOB. The origin is consumed by whichever arm reaches
 * `start_dictation` next, and an arm is not necessarily the hold that stamped it: a hold abandoned
 * before the arm lands (⌘-click, a chord, a ⌘Tab away) leaves the slot full, and a later arm from a
 * completely different gesture — the mic button, the voice menu, a cross-window sync — would then
 * be billed against a keydown it has nothing to do with.
 *
 * The slot is one-shot (taking it clears it), so at most ONE such arm can be mis-attributed, and
 * this cap stops that one from publishing an absurd number. It is deliberately generous: a real
 * keydown→arm span is single-digit ms warm, and the pathological cases this exists to measure (a
 * first-run model download) are minutes. 10s is comfortably above any span worth reporting and
 * comfortably below "the user wandered off", which is the mis-attribution being bounded.
 *
 * The residual — a stray arm within 10s of an abandoned hold — is ACCEPTED and not defended
 * further. Clearing the slot on `onHoldEnd`/`onAbandon` was considered and REJECTED: a short hold
 * releases in ~300ms while a slow arm may not have reached `invoke` yet, so clearing there would
 * discard the origin in exactly the slow case this instrumentation exists to catch. This is a
 * diagnostic, not behaviour; a rare mislabelled log line is the cheaper failure.
 */
export const HOLD_ORIGIN_MAX_AGE_MS = 10_000;

/** The pending origin, as a `performance.now()` reading. `null` means no hold is waiting to be billed. */
let pending: number | null = null;

/**
 * Stamp the gesture. Called from the push-to-talk keydown, on the same tick the hold begins.
 *
 * Overwrites any origin still pending rather than refusing: the newer gesture is the one whose arm
 * is about to run, so the older stamp is stale by definition (its arm either already consumed it or
 * never will).
 */
export function markHoldOrigin(at: number = performance.now()): void {
  pending = at;
}

/**
 * Consume the pending origin and return its age in whole ms, or `null` when there is nothing
 * trustworthy to report.
 *
 * ONE-SHOT BY DESIGN — it clears the slot even when it then rejects the value, so a rejected origin
 * cannot go on to mislabel the arm after it. `null` on: nothing pending, a non-finite reading, a
 * negative age (a non-monotonic clock, which `performance.now()` should make impossible), or an age
 * past `HOLD_ORIGIN_MAX_AGE_MS`. Rust treats a missing age as "this arm has no gesture origin" and
 * reports the stages it can measure without claiming a keydown span it cannot.
 */
export function takeHoldOriginAge(now: number = performance.now()): number | null {
  if (pending === null) return null;
  const age = now - pending;
  pending = null;
  if (!Number.isFinite(age) || age < 0 || age > HOLD_ORIGIN_MAX_AGE_MS) return null;
  return Math.round(age);
}

/** Is an origin waiting to be billed? For tests and for nothing else — reading it is not consuming it. */
export function holdOriginPending(): boolean {
  return pending !== null;
}

/** Drop any pending origin. Test seam, so one test's stamp cannot leak into the next. */
export function clearHoldOrigin(): void {
  pending = null;
}
