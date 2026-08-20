// THE RESEARCH POOL'S SHAPE, MIRRORED ON THE TYPESCRIPT SIDE — and pinned to the Rust that owns it.
//
// ══ WHY THIS FILE EXISTS AT ALL ════════════════════════════════════════════════════════════════
// The pool is declared once, in `apps/desktop/src-tauri/src/research.rs`, and that is correct: it
// governs how many children the runner will actually spawn, so the number has to live where the
// permits are handed out. But three separate TypeScript comments went on asserting the OLD value
// for six days after it changed — `conciergeAutoDispatch`, `pusherFleet` and `pusherFleet.test` all
// still read *"`MAX_CONCURRENT_RESEARCH` is 2"* long after `bf597a494` (2026-08-13) raised it to 16
// and shipped it in v0.106.0.
//
// That is not a documentation nit. Both of those comments are ARGUMENTS — each one reasons from the
// value to a conclusion about whether a rule is satisfiable — so a stale value is a stale argument,
// and the next reader inherits it. It is also what let the auto-dispatcher crawl at one child per
// fifteen seconds against a pool that had been sixteen wide the whole time, while the founder
// watched sixteen messages queue behind a badge reading `+2`.
//
// So the value gets a HOME on this side, imported rather than restated in prose, and
// `researchPool.test.ts` reads `research.rs` and fails when the two drift. A comment cannot be
// tested; a constant can.
//
// ══ AND WHY A CONSTANT RATHER THAN AN IPC READ ═════════════════════════════════════════════════
// The runner already publishes its pool shape (`research.rs`'s `cap` / `room` fields), so a live
// read is possible. It is the wrong instrument here: every consumer of this number is a PURE
// decision module — `pusherFleet`'s conditions, `conciergeAutoDispatch`'s decider — deliberately
// holding no store, no Tauri and no clock. Threading an async read into them to learn a compile-time
// constant would buy nothing but the ability to be wrong asynchronously. The drift test gives the
// same guarantee at zero runtime cost.

/**
 * How many research children the runner will run at once.
 *
 * SIXTEEN since 2026-08-13. Raised from 2 by the founder — *"the concierge fans ~20 questions out
 * at once and expects most of them running in parallel, not draining two at a time"* — so anything
 * on this side that paces itself against a cap of two is pacing against a pool that no longer
 * exists.
 *
 * NOT A DISPATCH BUDGET BY ITSELF. A burst past this does not fail; it queues in the waiting room
 * ({@link MAX_RESEARCH_WAITERS}). It is a ceiling on how many children can be RUNNING, which is why
 * `conciergeAutoDispatch` uses it as the target its ramp climbs toward rather than as a refusal.
 */
export const MAX_CONCURRENT_RESEARCH = 16;

/**
 * How many dispatched tasks may WAIT for a permit on top of those holding one.
 *
 * Deliberately generous: `dispatch` itself is never refused, and a task only fails at the far edge
 * of this room. Mirrored here for the same reason as the cap above — so a rule that reasons about
 * "what happens past the cap" can cite the number instead of guessing at it.
 */
export const MAX_RESEARCH_WAITERS = 64;
