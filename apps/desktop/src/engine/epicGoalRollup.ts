// epicGoalRollup — has the epic goal been achieved, and (the part that actually matters) can it be
// made to LOOK achieved by giving up on the hard parts?
//
// ── THE FAILURE MODE THIS MODULE EXISTS FOR ───────────────────────────────────────────────────
// The founder named one risk above every other in this feature: "the epic goal must not become
// silently satisfiable by dropping the hard parts." The naive rollup — "every agent working this
// epic has met its goal" — has exactly that hole, and it is not a subtle one: retire the agent on
// the hardest child and the epic reports COMPLETE, because the only evidence of that slice left the
// roster with it.
//
// So COMPLETION IS COUNTED OVER CHILD BEADS, NEVER OVER SURVIVING AGENT GOALS. Retiring an agent
// removes an AGENT; it does not remove a UNIT OF WORK. A bead stays open until something closes it,
// and nothing about an agent's disposal closes one — so `readyToClose` is structurally immune to the
// attack rather than defended against it case by case.
//
// The agent goals are still read, but only to ANNOTATE: to say WHY a slice is still open, so the
// human can see a stalled slice rather than merely a slow one. An annotation cannot make the epic
// closable and cannot make it un-closable — see the invariant test.
//
// ── NO CLOCK, NO IO, NO MODEL CALL ────────────────────────────────────────────────────────────
// Same discipline as `engine/epicContinuation`, its sibling: `now` arrives as an argument so every
// rule below is testable at a chosen instant.
import { goalStateOf, type AgentGoal } from "./agentGoal";

/** Where one slice of the epic stands. */
export type SliceState =
  /** Its bead is closed. The ONLY state that counts toward completion. */
  | "done"
  /** Its bead is open and something plausible is happening (an agent with a live goal, or it simply
   *  has not been picked up yet). */
  | "open"
  /** Its bead is open and the agent that took it gave up — escalated, expired, or abandoned. */
  | "dropped"
  /** Its bead is open, work on this epic HAS started, and nothing at all is carrying this slice.
   *  The shape a RETIRED agent leaves behind: the agent record is gone, so nothing names it as
   *  dropped, but the work is just as unowned. */
  | "stranded";

/** The bead fields this module reads. Structural, so a test builds three keys. */
export interface RollupBead {
  id: string;
  title: string;
  status: "open" | "in_progress" | "closed";
}

/** The agent fields this module reads. */
export interface RollupAgent {
  id: string;
  /** The ONE task bead this agent implements, if any. */
  beadId?: string;
  /** The epic handed to this agent, if it is an orchestrator. */
  epicId?: string;
  /** EVERY slice of this epic the agent's work sits under, already resolved by
   *  `services/epicLadder.agentsForEpicSlices`. Preferred over the two raw fields above, and the
   *  only one that answers correctly for an agent deeper than one rung — a worker on `e1.sub.t2`
   *  carries both that slice and its `e1.sub` ancestor. EMPTY means "carries the whole epic, not
   *  one slice" (this epic's own orchestrator). */
  sliceIds?: readonly string[];
  goal?: AgentGoal;
}

export interface EpicSlice {
  beadId: string;
  title: string;
  state: SliceState;
  /** One sentence for the human, on the two states that are not self-explanatory. */
  reason?: string;
}

export interface EpicGoalRollup {
  slices: EpicSlice[];
  /** Slices whose bead is closed. */
  done: number;
  /** Slices whose bead is open — however they got that way. */
  open: number;
  /** Open slices whose agent visibly gave up. A subset of `open`. */
  dropped: number;
  /** Open slices nobody is carrying, on an epic that HAS been started. A subset of `open`. */
  stranded: number;
  /**
   * Is every slice finished?
   *
   * ⚠️ READ THIS AS "SURFACE IT", NOT "CLOSE IT". The founder's standing preference is notify, do
   * not block — so nothing in the app closes an epic on the strength of this. It paints a
   * ready-to-close notice and the human decides. Silently closing an epic is the same class of move
   * as silently overwriting his goal text, and it would cost the same trust.
   */
  readyToClose: boolean;
}

/** Did this agent's goal end without the work being finished? */
function gaveUp(goal: AgentGoal | undefined, now: number): string | null {
  if (goal === undefined) return null;
  if (goal.abandonedAt !== undefined) {
    return goal.abandonedEvidence ?? "its agent's goal was abandoned";
  }
  const state = goalStateOf(goal, now);
  if (state === "escalated") return goal.escalationReason ?? "its agent's goal escalated to a human";
  if (state === "expired") return "its agent's goal expired with the work unfinished";
  return null;
}

/**
 * Roll an epic's children up against the agents laddering to it.
 *
 * `children` is the epic's child beads (`beads.childrenOf`).
 *
 * ⚠️ `agents` MUST come from `services/epicLadder.agentsForEpicSlices`, NOT `agentsLadderingTo`
 * (roborev 65856). The two answer different questions: `agentsLadderingTo` excludes a sub-epic's
 * orchestrator — correctly, since that agent ladders to the sub-epic — and that is precisely the
 * agent carrying the slice when a child bead is itself a sub-epic. Passing the narrower list made
 * every such slice report `stranded` while an agent was actively building it. No matching rule here
 * can rescue an agent that is not in the array, which is why the fix is in the caller's choice of
 * list rather than in `onIt` below.
 *
 * Neither input is re-derived here — this stays pure.
 */
export function rollUpEpicGoal(
  children: readonly RollupBead[],
  agents: readonly RollupAgent[],
  now: number,
): EpicGoalRollup {
  // "Has work on this epic actually BEGUN?" — the guard that separates a slice nobody is carrying
  // from one simply not picked up yet. Without it every fresh epic lights up as fully stranded,
  // which is noise, and noise is what makes a real stranded slice unreadable.
  //
  // ⚠️ IT IS READ FROM THE BEADS ALONE, AND NEITHER HALF OF THAT IS OBVIOUS.
  //
  // NOT from the live roster (roborev 65849): `agents.length > 0` cannot see the case `stranded` is
  // named for — retire the LAST agent and the roster is empty, so a mid-flight epic reverts to
  // reading like untouched backlog exactly when the signal matters. The bead side survives agent
  // disposal: a child that has been closed or picked up is proof work happened here, and nothing
  // about disposing of an agent takes that back.
  //
  // And NOT from the roster even as an OR (roborev 65885): an epic's own orchestrator matches no
  // slice — it carries the whole epic — so counting it made every child paint "nothing is carrying
  // this slice" during the ordinary window between `prepareHandoff` dispatching an orchestrator and
  // that orchestrator spawning its first worker. That is a red mark on every freshly-started epic,
  // and it contradicts `SliceState`'s own definition of `open`.
  //
  // What is lost is narrow and deliberate: a worker that dies before its bead ever moves leaves its
  // slice reading `open` rather than `stranded`. An epic that stops moving with nobody on it is
  // `engine/epicContinuation`'s business, and a false alarm on every new epic costs more than a
  // missed one on a slice no bead has recorded progress for.
  const started = children.some((b) => b.status !== "open");

  const slices: EpicSlice[] = children.map((bead) => {
    if (bead.status === "closed") {
      return { beadId: bead.id, title: bead.title, state: "done" as const };
    }
    // TWO WAYS TO OWN A SLICE. A worker carries its task bead in `beadId`; a sub-epic child is
    // carried by an orchestrator, which names it in `epicId`. `sendToBuild.prepareHandoff` stamps
    // an orchestrator's epic id into BOTH fields, so today `beadId` alone would match it — the
    // `epicId` arm is there so a future caller that stamps only one of them still resolves. Getting
    // that agent INTO this array at all is the caller's job; see the note on `agents` above.
    // `sliceId` FIRST — it is the resolved answer and the only one correct for an agent more than
    // one rung down (roborev 65874). The two raw arms remain for a caller that has not re-keyed;
    // they are never reached on the production path.
    // `sliceIds` FIRST — it is the resolved answer and the only one correct for an agent more than
    // one rung down (roborev 65874). The two raw arms remain for a caller that has not re-keyed;
    // they are never reached on the production path.
    //
    // Written as a named function with each rule on its OWN line, rather than as a nested ternary
    // inside the `filter`, because `scripts/mutation-check.sh` cannot judge a line whose mutant
    // does not parse — and a multi-line ternary is exactly that. A rule no tool can mutate is a
    // rule whose coverage rests on a test happening to pass, which is how the previous version of
    // this very attribution shipped inert.
    const carries = (a: RollupAgent): boolean => {
      if (a.sliceIds !== undefined) return a.sliceIds.includes(bead.id);
      return a.beadId === bead.id || a.epicId === bead.id;
    };
    const onIt = agents.filter(carries);
    if (onIt.length === 0) {
      return started
        ? {
            beadId: bead.id,
            title: bead.title,
            state: "stranded" as const,
            reason: "nothing is carrying this slice — its agent was retired, or it was never picked up",
          }
        : { beadId: bead.id, title: bead.title, state: "open" as const };
    }
    // A slice is dropped only when EVERY agent on it gave up. One live agent means someone is still
    // carrying it, however many earlier attempts failed — reporting it dropped while an agent is
    // working would be a false alarm, and false alarms are what get the real ones ignored.
    const verdicts = onIt.map((a) => gaveUp(a.goal, now));
    if (verdicts.every((v) => v !== null)) {
      return {
        beadId: bead.id,
        title: bead.title,
        state: "dropped" as const,
        reason: verdicts.find((v) => v !== null) ?? "its agent gave up",
      };
    }
    return { beadId: bead.id, title: bead.title, state: "open" as const };
  });

  const done = slices.filter((s) => s.state === "done").length;
  const dropped = slices.filter((s) => s.state === "dropped").length;
  const stranded = slices.filter((s) => s.state === "stranded").length;

  return {
    slices,
    done,
    open: slices.length - done,
    dropped,
    stranded,
    // ⚠️ THE WHOLE SAFETY PROPERTY IS THIS ONE LINE, and it is deliberately expressed over BEADS
    // ALONE. It does not consult `dropped`, `stranded`, or any agent goal — because anything that
    // read an agent's disposition here could be moved by disposing of the agent. An epic with no
    // children at all is NOT ready to close: an epic that was never decomposed has not been
    // achieved, it has been ignored, and `0 === 0` would have reported it complete.
    readyToClose: slices.length > 0 && done === slices.length,
  };
}
