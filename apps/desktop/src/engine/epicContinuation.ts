// epicContinuation — the PURE decision half of "an epic was planned and then nobody finished it".
//
// ── THE PROBLEM THIS EXISTS FOR ───────────────────────────────────────────────────────────────
// A build agent is handed an epic, decomposes it into child beads, writes the plan… and stops. The
// plan is real and complete; the orchestrator dies, or finishes its turn, or says it will spin the
// workers back up and then does not. Nothing in the app is watching, so the epic sits with every
// child `open` indefinitely and the founder only finds out by remembering. In his words: "big tasks
// get partially done and do not get done to completion."
//
// Nothing here spawns anything. This module answers ONE question per epic — restart it, escalate it,
// clear its escalation, or leave it alone — over plain numbers and enums, so every rule below is
// testable without an agent, a store, or a timer. `services/epicSweepRunner` is the half that spends
// something.
//
// ── IT IS THE FOURTH SIBLING, AND THE FOUR MUST NOT FIGHT ─────────────────────────────────────
// The app already has three recovery sweeps, and this one is deliberately disjoint from all of them
// on the axis each keys off:
//   • engine/apiRecovery       — an agent whose process is ALIVE but wedged. Recovers by typing.
//   • engine/resurrection      — an agent whose process is DEAD. Recovers by re-mounting its pane.
//   • engine/goalContinuation  — an AGENT whose stated goal is unmet. Re-prompts that agent.
//   • this                     — an EPIC that is not moving, whatever its agents are doing.
// The first three are all about an agent that still exists. This one fires precisely when NO
// orchestrator is alive on the epic (see `orchestratorAlive` below, which is a hard skip): the
// agent is gone and the WORK is what survives it. So a wedged or dead agent is never this module's
// business, and an epic with nobody on it is never theirs.
//
// ── NO MODEL CALL, NO CLOCK, NO I/O ───────────────────────────────────────────────────────────
// Same rule the other three follow: a recovery path that consults an LLM is dead exactly when the
// account wall is what killed the work. `now` arrives as an argument for the same reason — a sweep
// that reads the clock itself cannot be tested at a chosen instant.
import type { EpicStatus } from "../services/planView";

/**
 * How long an epic must show NO child progress before the sweep treats it as stalled.
 *
 * Two hours. The founder was asked and left this one unanswered, so it is the recommended default
 * and is stated here rather than buried: long enough that an ordinary build round, a long CI wait,
 * or a worker chewing on one hard problem never trips it, and short enough that a stall discovered
 * in the morning is hours old rather than a day. It is exported so a test names the real constant
 * instead of hard-coding a duplicate of it.
 */
export const EPIC_STALL_MS = 2 * 60 * 60 * 1000;

/**
 * How far BACK the sweep will reach. An epic whose work stopped longer ago than this is left alone.
 *
 * Fourteen days, chosen by the founder. The reasoning is that beyond about two weeks a silent epic
 * is a decision he already made rather than a stall to recover — and the measurement backs it: of
 * the 39 epics in the live store, 15 are past the two-hour stall line, with a tail at 53 days, 47
 * days and a cluster around 20. Without a cap the sweep's FIRST run surfaces all of them at once,
 * so a 53-day-old epic resurfaces as though it were live work, and the genuinely recent stalls are
 * buried in the noise.
 *
 * It is a REACH limit, not an expiry: an old epic that starts moving again re-enters the window on
 * its own, because the window is measured from the last child progress rather than from creation.
 */
export const EPIC_MAX_STALL_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** What the sweep decided to do about one epic. */
export type EpicSweepAction =
  /** Hand the epic to a build agent again — the plan exists and nobody is carrying it. */
  | "restart"
  /** Stop trying and put it in front of the human. One restart already failed to move it. */
  | "escalate"
  /** It is moving again (or finished). Take the escalation mark back off. */
  | "clear"
  /** Do nothing. `reason` says which rule answered. */
  | "skip";

/** Why the sweep left an epic alone. Every skip names its rule — an unexplained no-op in a
 *  recovery sweep is indistinguishable from the sweep being broken. */
export type EpicSkipReason =
  /** Never handed to a build agent, so not something the founder asked to be driven. */
  | "not-watched"
  /** The founder vetoed automatic restarts for this epic (`beads.NO_AUTO_RESTART_LABEL`). */
  | "opted-out"
  /** No children at all: there is no plan for a build agent to execute. */
  | "nothing-planned"
  /** Every child is closed. */
  | "already-done"
  /** A build agent is on it right now — recovering THAT is another sweep's job. */
  | "orchestrator-alive"
  /** Already escalated and still not moving. Waiting on the human, by design. */
  | "already-escalated"
  /** We cannot tell how old the last progress is, so we refuse to act. */
  | "unknown-age"
  /** Stalled for less than the window. */
  | "too-soon"
  /** Stalled for LONGER than {@link EPIC_MAX_STALL_AGE_MS} — out of the sweep's reach on purpose. */
  | "too-old";

export interface EpicSweepDecision {
  epicId: string;
  action: EpicSweepAction;
  /** Set exactly when `action === "skip"`. */
  reason?: EpicSkipReason;
}

/**
 * One epic, reduced to the facts the decision needs. Every field is a plain value the runner reads
 * off the bead list and the agent roster — no live objects, so a test states a situation directly.
 */
export interface EpicSweepCandidate {
  epicId: string;
  /** Rolled up by `planView.rollupEpicStatus`. `planning` — a written plan nobody started — is the
   *  state this whole sweep was built for, and it did not exist as a distinct word until now. */
  status: EpicStatus;
  /**
   * Has a build agent ever been handed this epic?
   *
   * THE WATCH GATE, and the founder's answer to "which epics should this touch": any epic he has
   * promoted to Build at least once, and nothing else. Promotion is already his statement that he
   * wants the thing delivered, so it costs him no new switch to remember — and the alternative,
   * watching every epic, would aim a spawner at 23 de-facto epics and thousands of retro beads in a
   * session he spent RECLAIMING agent capacity.
   */
  promoted: boolean;

  /**
   * When THIS SWEEP last restarted the epic (epoch ms), or null if it never has.
   *
   * ── IT MUST BE THE SWEEP'S OWN MARKER, NOT "the last handoff" ─────────────────────────────────
   * The first version used the creation time of the newest build agent bound to the epic, and that
   * was wrong in two independent ways that review caught and the suite did not:
   *
   *   1. IT NEVER ADVANCED. `sendToBuild` REUSES the build agent already bound to an epic rather
   *      than creating a new one, and reuse leaves `createdAt` untouched. The ROSTER-DERIVED gate
   *      then in force meant a bound agent always existed before anything could be restarted, so
   *      the timestamp was frozen by construction — the escalate branch below was UNREACHABLE and
   *      the sweep would restart the same dead epic every tick, forever, while its own message told
   *      the founder it would stop.
   *
   *      PAST TENSE, AND DELIBERATELY SO. That premise died with the roster gate: `promoted` is now
   *      `bound.length > 0 || isPromotedToBuild(epic)`, so a watched epic need have NO bound agent
   *      at all — the runner's "restarts a label-watched epic that has no agent bound at all" case
   *      is a direct counterexample. Stated in the present tense (as it was until this line was
   *      fixed) it tells a maintainer reading the candidate contract top-down that the roster still
   *      bounds the restart path, in the very paragraph explaining why this field must stay a
   *      separate, sweep-written fact. Its twin in `epicSweepRunner.ts` was corrected one commit
   *      earlier and this copy survived, so grep both files before rewording either.
   *   2. IT COULD NOT TELL A SWEEP RESTART FROM A HUMAN PROMOTION. A founder promoting an
   *      already-planned epic whose orchestrator then dies would be escalated on the FIRST sweep
   *      with "I restarted it once and it still has not moved" — a restart never spent, and the
   *      epic denied the one it was owed.
   *
   * Only the sweep writes it (a `sweep-restarted:<ms>` label on the epic — see
   * `services/beads.SWEEP_RESTART_PREFIX`), so only the sweep's own attempts can exhaust the
   * sweep's budget. It lives on the BEAD rather than on an agent because the fact is about the
   * work: an agent tab can be closed, and closing one must not silently re-grant a restart.
   */
  lastSweepRestartAt: number | null;
  /** A build agent bound to this epic is alive right now. */
  orchestratorAlive: boolean;
  /**
   * The newest `updatedAt` across the epic's CHILDREN, or null when none is readable.
   *
   * CHILDREN ONLY — the epic's own timestamp is deliberately excluded, and that is load-bearing
   * rather than tidy. Escalating writes a label to the EPIC, which bumps the epic's `updatedAt`; if
   * that counted as progress, the sweep's own escalation would reset the staleness clock it just
   * measured and the epic would read as freshly active forever after. The children are the work,
   * and only the work counts as movement.
   */
  lastChildProgressAt: number | null;
  /** The epic already carries the stalled mark — we escalated it and the human has not acted. */
  alreadyEscalated: boolean;
  /**
   * The founder vetoed automatic restarts for this epic (`beads.NO_AUTO_RESTART_LABEL`).
   *
   * OPTIONAL, AND ABSENCE MEANS "NOT VETOED". Every candidate built before this field existed
   * omits it, and the safe reading of a missing veto is that none was given — the epic keeps the
   * behaviour it already had. Reading `undefined` as opted-out would silently switch the sweep off
   * for the entire installed base, which is the failure this whole fix exists to end.
   */
  optedOut?: boolean;
}

/**
 * Decide what to do about one epic.
 *
 * ── ONE RESTART PER STALL, WHICH IS NOT THE SAME AS ONE RESTART EVER ──────────────────────────
 * The founder asked for "restart once, then escalate". The rule that implements it is the last
 * comparison in this function: `lastSweepRestartAt > lastChildProgressAt` — the sweep restarted
 * this epic, and nothing has moved SINCE. That is the honest reading of "we already tried":
 *
 *   promoted → agent writes children at t1 → dies → stalled at t1+2h
 *      no sweep restart yet          ⇒ RESTART. Nobody has tried since the plan appeared.
 *   sweep restarts at t3 → nothing moves → stalled again
 *      restart(t3) > progress(t1)    ⇒ ESCALATE. A restart was spent and bought nothing.
 *   sweep restarts at t3 → children move at t5 → stalls again months later
 *      restart(t3) < progress(t5)    ⇒ RESTART. This is a NEW stall, not the same one retried.
 *
 * So a broken epic gets exactly one automatic restart and then stops costing agent slots, while an
 * epic the sweep genuinely rescued stays eligible if it stalls again later. The strictest possible
 * reading — one restart ever, for the life of the epic — would mean an epic this sweep successfully
 * revived in March can never be helped again in September, which reads as a bug rather than a
 * safeguard. Flagging the interpretation because it is a real choice and it is reversible.
 *
 * NO COUNTER AND NO IN-MEMORY STATE. Both sides are timestamps that outlive the app: bead
 * `updatedAt` comes from bd, and the restart marker is a label on the bead. An in-memory attempt
 * counter would have silently re-granted a restart on every app relaunch — the exact shape of bug
 * this sweep exists to catch.
 *
 * THE MARKER IS THE SWEEP'S OWN, and both halves of that matter. It has to be WRITTEN by the sweep
 * (the first version read the bound build agent's `createdAt`, which `sendToBuild`'s reuse path
 * never advances — so escalate was unreachable and the loop was infinite), and it has to be
 * EXCLUSIVE to the sweep (a human promotion must not spend the budget the sweep owes the epic).
 */
export function decideEpicSweep(
  c: EpicSweepCandidate,
  now: number,
  stallMs: number = EPIC_STALL_MS,
  maxAgeMs: number = EPIC_MAX_STALL_AGE_MS,
): EpicSweepDecision {
  const skip = (reason: EpicSkipReason): EpicSweepDecision => ({
    epicId: c.epicId,
    action: "skip",
    reason,
  });
  const clear = (): EpicSweepDecision => ({ epicId: c.epicId, action: "clear" });

  // Never handed to a build agent ⇒ not something the founder asked to be driven. Checked FIRST so
  // that no later rule can reach an epic outside the watch set, whatever else is true of it.
  if (!c.promoted) return skip("not-watched");

  // Finished, or someone is on it. Both are "not stalled" — but if we had previously marked it
  // stalled, that mark is now wrong and comes off. A stale escalation is worse than none: it is a
  // false alarm sitting in the lane the human scans for real ones.
  if (c.status === "done") return c.alreadyEscalated ? clear() : skip("already-done");
  if (c.orchestratorAlive) return c.alreadyEscalated ? clear() : skip("orchestrator-alive");

  // No children at all: there is no plan here to execute. Restarting would hand a build agent an
  // empty brief, which is how you get an agent that invents work. This is the distinction the
  // `unplanned` / `planning` split was made for — while both said `not_started`, this rule could
  // not be written.
  if (c.status === "unplanned") return skip("nothing-planned");

  // FAIL CLOSED on a missing timestamp. "We could not tell how old this is" must never be able to
  // authorize a spawn; an unreadable date is not evidence of a stall.
  if (c.lastChildProgressAt === null) return skip("unknown-age");

  // NOT STALLED — the work moved inside the window. If we had marked it, the mark is now wrong.
  //
  // FRESHNESS IS THE TEST, and the obvious alternative is wrong in a way that matters: comparing
  // `lastChildProgressAt > lastHandoffAt` ("the last thing that happened was work, not a handoff")
  // is TRUE of an epic planned three weeks ago and untouched ever since, so it would clear the
  // escalation on precisely the dead epics escalation exists to surface — and then re-escalate them
  // on the next tick, flapping the human's lane forever. A test caught this; it is kept as
  // "does NOT clear a still-stalled escalated epic".
  if (now - c.lastChildProgressAt < stallMs) {
    return c.alreadyEscalated ? clear() : skip("too-soon");
  }

  // ── THE FOUNDER'S EXPLICIT VETO ──────────────────────────────────────────────────────────────
  // Suppresses every rule that ACTS — restart, escalate — and nothing else. This replaces the
  // opt-out that closing the orchestrator used to provide; see `beads.NO_AUTO_RESTART_LABEL`.
  //
  // IT SITS BELOW THE THREE `clear` BRANCHES, AND THE FIRST CUT HAD IT ABOVE THEM. Checking it
  // straight after the watch gate reads as "leave a vetoed epic entirely alone", but `clear` is not
  // something done TO the epic — it is the retraction of a `stalled` mark THIS SWEEP wrote, and the
  // board routes that mark to the Blocked lane. Vetoing the retraction therefore stranded a false
  // "this needs you" flag in front of the founder permanently, for an epic he had just told the
  // sweep to stop touching: it could never be cleared again, because every later tick returned at
  // the veto. The veto is about not STARTING work, not about keeping a stale alarm alive.
  //
  // A vetoed epic still reaches the three branches above, so a recovered one is un-marked exactly
  // as any other would be, and a still-stalled one stops here instead of being restarted.
  if (c.optedOut) return skip("opted-out");

  // OUT OF REACH. Checked AFTER the freshness branch above so an already-escalated epic that starts
  // moving can still have its mark cleared — an epic falling out of the window must not strand a
  // stale "this needs you" flag in the founder's Blocked lane forever. Checked BEFORE the escalate
  // and restart branches so nothing is newly marked or handed over on its account.
  if (now - c.lastChildProgressAt > maxAgeMs) return skip("too-old");

  // Escalated and STILL not moving ⇒ wait for the human. That is the whole point of escalating: it
  // stops the retry loop rather than slowing it down.
  if (c.alreadyEscalated) return skip("already-escalated");

  // THE SWEEP restarted this epic more recently than anything moved on it — its one restart was
  // spent and bought nothing. Stop, and put it in front of the human.
  //
  // `null` here means the sweep has never restarted this epic, so it is still owed its one attempt
  // — which is exactly the common case (a build agent the founder promoted wrote the plan and
  // died). Reading a missing marker as "we already tried" would escalate every stall on sight and
  // the sweep would never restart anything at all.
  if (c.lastSweepRestartAt !== null && c.lastSweepRestartAt > c.lastChildProgressAt) {
    return { epicId: c.epicId, action: "escalate" };
  }

  return { epicId: c.epicId, action: "restart" };
}

/** Decide across a whole project's epics. Order is preserved so a caller can report in board order;
 *  every candidate yields exactly one decision, including the skips, because a sweep that silently
 *  drops candidates cannot be debugged from its own output. */
export function decideEpicSweeps(
  candidates: readonly EpicSweepCandidate[],
  now: number,
  stallMs: number = EPIC_STALL_MS,
  maxAgeMs: number = EPIC_MAX_STALL_AGE_MS,
): EpicSweepDecision[] {
  return candidates.map((c) => decideEpicSweep(c, now, stallMs, maxAgeMs));
}
