// The EPIC view of the Plan board — the founder's seven-stage ladder, bucketed from an already
// bucketed Board. Pure data: no React, no stores, so the ladder is unit-testable without a GUI,
// exactly like `planView` beside it.
//
// ── WHY THIS IS A SECOND BUCKETING AND NOT A WIDER `rollupEpicStatus` ─────────────────────────
// `planView.rollupEpicStatus` answers a question the SWEEPER asks: is there a plan here, and has
// anyone started it. `services/epicSweepRunner` and `engine/epicContinuation` both branch on its
// four values, and widening that type would change what the live sweeper decides — a data change
// made for a display reason. So the extra three stages the founder's ladder names (Blocked,
// Shipped, Archived) are derived HERE, at the view layer, from the board bucket the epic bead
// already sits in. The sweeper is untouched by anything in this file.
import {
  epicIndexOf,
  isEpicIndexed,
  type Bead,
  type Board,
  type BoardColumn,
  type EpicIndex,
} from "./beads";
import { rollupEpicStatus } from "./planView";

/** A column of the epic ladder.
 *
 *  The keys deliberately REUSE the Board snapshot's vocabulary wherever one already exists —
 *  `inProgress` renders as "Being built", `delivered` as "Shipped" — so `BoardView`'s `Column`, its
 *  `data-testid`s and its definable-stage wiring keep working with no widening. `planning` is the
 *  one genuinely new key, because the board has never had a bucket for it. */
export type EpicLadderKey = BoardColumn | "planning";

/**
 * THE ONE PLACE A STAGE IS PUT INTO WORDS. Every surface that names a stage — the task board's
 * column headers, the epic ladder's column headers, and the status chip on a bead card — reads it
 * from here.
 *
 * ══ WHY ONE RECORD AND NOT A LABEL PER LIST ════════════════════════════════════════════════════
 * There used to be two hand-written lists and they had already drifted: this file called
 * `inProgress` "Building" while `BoardView`'s `COLUMNS` called the SAME column "Being built". A
 * reader who switched the Epics toggle watched a card change its stage name without changing its
 * stage. That is not a wording nit — the whole point of the status chip is that a card and the
 * column holding it agree, and two vocabularies make agreement impossible to state.
 *
 * "Being built" wins over "Building" because it is the founder's own phrase for this column and it
 * is what the task board — the default view, the one he is looking at — has always said.
 *
 * The KEYS are the wire vocabulary (`inProgress`, `delivered`) and deliberately stay that way; see
 * {@link EpicLadderKey}. Only the values are read by a human.
 */
export const STAGE_LABELS: Record<EpicLadderKey, string> = {
  backlog: "Backlog",
  blocked: "Blocked",
  planning: "Planning",
  inProgress: "Being built",
  done: "Done",
  delivered: "Shipped",
  archived: "Archived",
};

/** The founder's ladder. The ORDER ITSELF is the array below and the reason for it is the comment
 *  inside it — deliberately NOT restated here. This doc used to carry its own copy of the sequence
 *  plus a rationale, which is the shape that silently went stale the first time the order changed:
 *  an IDE surfaces this block on hover, so a reader got a confident argument for an order the code
 *  no longer had, and a stated reason to "restore" it. The pinned test asserts the array, never a
 *  comment, so nothing would have flagged the drift.
 *
 *  ══ WHY THE ODD `Object.keys(… satisfies Record<…>)` SHAPE ══════════════════════════════════
 *  EXHAUSTIVENESS, at compile time. Written as a plain `readonly EpicLadderKey[]` literal this
 *  list could silently OMIT a rung — the type is satisfied by any subset — while `STAGE_LABELS`,
 *  `emptyEpicBoard` and `EpicBoard` (all `Record<EpicLadderKey, …>`) would refuse to compile until
 *  the new rung was added to them. The omission would then be invisible in three places at once:
 *  the ladder never renders that column, {@link ladderKeyOf} returns `null` for every bead sitting
 *  in it, and `BeadPill`'s placement index never indexes them — so those cards' chips fall back to
 *  `columnFor` and print a stage that has no header on screen. The `satisfies` clause makes adding
 *  a key to {@link EpicLadderKey} a compile error HERE too. Same idiom as `beadsStore`'s
 *  `BOARD_COLUMNS`, for the same reason.
 *
 *  `Object.keys` preserves the literal's insertion order for string keys, so the sequence written
 *  below IS the rendered order — the exhaustiveness check costs nothing in expressiveness. */
export const EPIC_LADDER: readonly EpicLadderKey[] = Object.keys({
  // PLANNING SITS BEFORE BLOCKED, on the founder's instruction: "let's put Planning to the left of
  // Blocked so it should be Backlog, Planning, Blocked, Building, Done, Shipped, Archive."
  //
  // It also reads better as a LADDER, which is what this list is: Backlog → Planning → Being built
  // is the path work actually travels, and Blocked is not a rung on it — it is a state work falls
  // into from any rung. Putting it between the first two rungs interrupted the only sequence here
  // that means anything.
  backlog: true,
  planning: true,
  blocked: true,
  inProgress: true,
  done: true,
  delivered: true,
  archived: true,
} satisfies Record<EpicLadderKey, true>) as EpicLadderKey[];

/** The ladder as RENDERED — its order from {@link EPIC_LADDER}, its words from
 *  {@link STAGE_LABELS}. Derived rather than written out a second time: two hand-maintained copies
 *  of one order is how a column ends up rendered in one place and bucketed in another, and two
 *  copies of one LABEL is the drift `STAGE_LABELS` was extracted to end. */
export const EPIC_LADDER_COLUMNS: readonly { key: EpicLadderKey; label: string }[] =
  EPIC_LADDER.map((key) => ({ key, label: STAGE_LABELS[key] }));

export type EpicBoard = Record<EpicLadderKey, Bead[]>;

/** Every ladder column present and EMPTY.
 *
 *  Exported because it is now a state the board can actually be IN, not just the accumulator
 *  `bucketEpics` fills: with two independent kind toggles the user can switch both off, and the
 *  board has to render that as "nothing selected" rather than as a loading board or a crash. */
export const emptyEpicBoard = (): EpicBoard => ({
  backlog: [],
  blocked: [],
  planning: [],
  inProgress: [],
  done: [],
  delivered: [],
  archived: [],
});

// The membership index this file walks is `beads.buildEpicIndex`, deliberately NOT defined here:
// it restates the parent-child edge, and that edge is stated in exactly ONE file. See its doc
// comment there for why a *fast* copy of the rule is still a copy.
/**
 * Where an OPEN epic sits once its own bead tells us nothing more — the split that gives Planning
 * its column. The epic bead is `open` either way; only its children distinguish "nobody has decided
 * what this is" from "the plan is written and nobody picked it up".
 *
 * `done` is reachable from here and is not a mistake: an open epic whose children have ALL closed
 * is finished work whose epic bead nobody closed. Filing it under Backlog would bury it; Done
 * surfaces it as something to close.
 */
function openEpicStage(index: EpicIndex, epicId: string): EpicLadderKey {
  switch (rollupEpicStatus(index.statusesByParent.get(epicId) ?? [])) {
    case "planning":
      return "planning";
    case "in_progress":
      return "inProgress";
    case "done":
      return "done";
    default:
      return "backlog"; // "unplanned" — a title with nothing under it
  }
}

/**
 * Re-bucket an ALREADY BUCKETED board into the epic ladder, keeping only epics.
 *
 * Takes the bucketed `Board` rather than a raw bead list on purpose: by the time BoardView calls
 * this, the snapshot has had the agent filter, the label filter and the date/priority filter
 * applied to it. Re-deriving the columns from `allBeads` here would quietly discard all three and
 * show a board the user's own controls say should be narrower.
 *
 * `allBeads` is still needed and is a DIFFERENT set: epic-ness and the child roll-up are properties
 * of the whole store (a bead cannot tell you whether anything points at it), so both must be asked
 * against the unfiltered list or a filtered-out child would silently demote its parent's stage.
 *
 * THE EPIC'S OWN STATE WINS OVER ITS CHILD ROLL-UP, and the mechanism is DISJOINTNESS, not the
 * order of the lines below — this was written as "order is load-bearing" first and that was wrong.
 * `beads.columnFor` has already sent each bead to exactly one source column, so the roll-up split
 * is only ever reached for a bead whose own state is plain `open`. Rearranging these statements
 * changes nothing; a blocked epic cannot be re-filed by its children because it is never in
 * `board.backlog` to begin with. Measured: routing `board.blocked` through the split as well reds
 * exactly one test (the blocked case), while every other case stays green — which is what "the
 * blocked pile is separate" looks like from the outside, and is the invariant to protect if this
 * ever stops walking the source buckets one for one.
 */
export function bucketEpics(board: Board, allBeads: readonly Bead[]): EpicBoard {
  const out = emptyEpicBoard();
  // CACHED, not `buildEpicIndex`. Both are one walk instead of one per bead, but this receives the
  // SAME `allBeads` identity every Card and EpicRow resolves through, so a direct uncached build
  // here pays a second full O(n) walk of a store the cache already holds -- 6-13 ms on the
  // founder's store, on the render path this index exists to make cheap (roborev 65662).
  const index = epicIndexOf(allBeads);
  const keep = (b: Bead) => isEpicIndexed(index, b);
  out.archived = board.archived.filter(keep);
  out.delivered = board.delivered.filter(keep);
  out.done = board.done.filter(keep);
  out.blocked = board.blocked.filter(keep);
  out.inProgress = board.inProgress.filter(keep);
  // Only the open pile splits, and it is the split that gives Planning its column.
  for (const b of board.backlog) {
    if (!keep(b)) continue;
    out[openEpicStage(index, b.id)].push(b);
  }
  return out;
}

/** Everything that is NOT an epic — the Tasks mode.
 *
 *  This and {@link bucketEpics} PARTITION the board: every bead the user can see in "both" is in
 *  exactly one of them, so no mode can make work disappear. That property is asserted directly
 *  rather than left implied, because the failure it guards against is silent — a bead dropped by
 *  both halves is simply gone from the app, with a green suite and nothing on screen to notice. */
export function tasksOnly(board: Board, allBeads: readonly Bead[]): Board {
  const index = epicIndexOf(allBeads); // cached — see the note in `bucketEpics`
  return mapBoard(board, (b) => !isEpicIndexed(index, b));
}

/** A task-shaped `Board` widened to the ladder's shape with an EMPTY Planning pile, so the view
 *  can index one type for every mode. Planning is empty by construction here and that is correct:
 *  it is an EPIC-only stage (it is a statement about an epic's children), and the task modes never
 *  render a Planning column to put anything in. */
export function withPlanning(board: Board): EpicBoard {
  return { ...board, planning: [] };
}

/**
 * WHICH BUCKET ALREADY HOLDS THIS BEAD — the question a card's status chip asks.
 *
 * ══ WHY IT READS THE BOARD RATHER THAN RE-DERIVING FROM THE BEAD ═══════════════════════════════
 * The chip has to say the stage the card is SITTING IN, and "sitting in" is a fact about the
 * bucketing that placed it, not about the bead. Re-running `columnFor` here would answer a
 * different question and would be WRONG in exactly the mode that matters: an open epic in Epics
 * mode was placed by `openEpicStage`'s child roll-up, which `columnFor` cannot see and would call
 * "Backlog" while the card sits under the Planning header. Reading the placement back off the
 * board makes card and header agree by construction — there is no second rule to keep in step.
 *
 * Takes a `Board` OR an `EpicBoard`: the store keeps the plain six-column board and the view keeps
 * the widened one, and both are legitimate answers to "where is this card". A column the given
 * board does not have is simply skipped, so a partial fixture degrades to `null` rather than
 * throwing.
 *
 * Returns `null` when nothing holds it — a bead filtered off the board, or a surface whose snapshot
 * has not loaded. The caller decides what to say then; see `BeadCard/beadStatus.stageLabel`.
 */
export function ladderKeyOf(board: Board | EpicBoard, beadId: string): EpicLadderKey | null {
  for (const key of EPIC_LADDER) {
    const column = (board as Partial<EpicBoard>)[key];
    if (column?.some((b) => b.id === beadId) === true) return key;
  }
  return null;
}

/** BOTH KINDS ON: epics rise to the top of every column, tasks keep their order beneath them.
 *
 *  WHY THIS EXISTS. With both toggles on, the board is the six task columns and an epic is bucketed
 *  by its own status like anything else — so it lands in Backlog among however many tasks are
 *  there. The founder reported this as "I don't see any epics when I have tasks turned on", and he
 *  was reading it correctly: on a store with thousands of open beads an epic is on the board and
 *  unfindable, which is the same thing as absent. Epics-only worked, which is what made it look
 *  like a filter bug rather than an ordering one.
 *
 *  It does NOT re-bucket. An epic stays in the column its status puts it in — moving it would make
 *  the same bead sit in different columns depending on a toggle, and the Epics rail's own ladder is
 *  where an epic-shaped view belongs. This only decides ORDER WITHIN a column.
 *
 *  STABLE, and that is load-bearing rather than incidental: the piles arrive in the order
 *  `bucketBeads` preserved, and both groups have to keep it. A comparator returning ±1 on an
 *  epic/epic or task/task pair would reshuffle each group on every render.
 */
export function epicsFirst(board: Board, allBeads: readonly Bead[]): Board {
  // CACHED, not `buildEpicIndex` — same reason as `epicsOnly` above. main replaced the uncached
  // walk here (the 43.5s -> 92ms epic-index wiring); this branch predates that, and the merge took
  // main's import list while keeping this call site, so it referenced a name no longer imported.
  // Re-importing `buildEpicIndex` would have compiled and silently undone the perf fix.
  const index = epicIndexOf(allBeads);
  const split = (pile: Bead[]): Bead[] => {
    const epics = pile.filter((b) => isEpicIndexed(index, b));
    // Nothing to reorder — hand the SAME array back so React sees an unchanged reference.
    if (epics.length === 0 || epics.length === pile.length) return pile;
    return [...epics, ...pile.filter((b) => !isEpicIndexed(index, b))];
  };
  return mapPiles(board, split);
}

function mapPiles(board: Board, f: (pile: Bead[]) => Bead[]): Board {
  return {
    backlog: f(board.backlog),
    blocked: f(board.blocked),
    inProgress: f(board.inProgress),
    done: f(board.done),
    delivered: f(board.delivered),
    archived: f(board.archived),
  };
}

function mapBoard(board: Board, keep: (b: Bead) => boolean): Board {
  return {
    backlog: board.backlog.filter(keep),
    blocked: board.blocked.filter(keep),
    inProgress: board.inProgress.filter(keep),
    done: board.done.filter(keep),
    delivered: board.delivered.filter(keep),
    archived: board.archived.filter(keep),
  };
}

/** WHICH KINDS of work the Plan board is showing — two INDEPENDENT toggles, not one mode.
 *
 *  This replaces an exclusive `"both" | "tasks" | "epics"` switch, and the reason is not cosmetic:
 *  "Both" is not a third kind of thing. Tasks and epics are the two kinds the board holds, and
 *  "Both" named the ABSENCE of a filter — so the control had three buttons for two facts, and the
 *  user had to work out that the way to see epics alongside tasks was a button whose label named
 *  neither. Two checkboxes state the same thing with nothing to learn, and they compose: each one
 *  answers exactly "is this kind on the board".
 *
 *  BOTH ON IS THE DEFAULT, and it is the board EXACTLY as it behaved before either control
 *  existed. That matters more than it looks — a default that changed what the board shows would
 *  make every existing expectation about the Plan board wrong for a reason nobody asked for.
 *
 *  BOTH OFF IS REACHABLE, and that is a decision rather than an oversight. The tempting guard is
 *  to refuse the last un-toggle (or to silently re-enable the other kind), but that makes the
 *  second click of an ordinary two-click gesture undo the first with no explanation, which is the
 *  shape users read as a broken control. The board renders {@link emptyEpicBoard} and says why
 *  instead, and the toggles are right there to undo it. */
export type PlanKind = "tasks" | "epics";

/** Which kinds are currently shown. Independent — any of the four combinations is legal. */
export type PlanKindFilter = Readonly<Record<PlanKind, boolean>>;

export const PLAN_KINDS = [
  { kind: "tasks", label: "Tasks" },
  { kind: "epics", label: "Epics" },
] as const satisfies readonly { kind: PlanKind; label: string }[];

/** The default: everything on, i.e. the pre-filter board. */
export const PLAN_KINDS_ALL: PlanKindFilter = { tasks: true, epics: true };
