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
//
// -- WHY THE STAFFING PREDICATE IS AN ARGUMENT AND NOT A STORE READ ----------------------------
// The Unstaffed rung is a statement about the LIVE AGENT ROSTER, which lives in React stores. This
// module is pure data -- no React, no stores, exactly as the paragraph above says -- and keeping it
// that way is what makes the whole ladder unit-testable without a GUI: `epicBoard.test.ts` proves
// where an epic lands by handing `bucketEpics` a two-line predicate, with no roster, no runtime
// store and no jsdom. Reading `useRuntimeStore` here would put a hook boundary in the middle of a
// pure bucketing function and every one of those cases would need a rendered component instead.
//
// The predicate is also OPTIONAL, and that is load-bearing rather than a convenience: omitted, this
// function behaves exactly as it did before the rung existed, so every caller with no roster (and
// every fixture in the suite) keeps its previous behaviour and the new rung stays provably empty
// for them.
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
 *  `data-testid`s and its definable-stage wiring keep working with no widening. `planning` and
 *  `unstaffed` are the two genuinely new keys, because the board has never had a bucket for
 *  either.
 *
 *  BOTH ARE DERIVED HERE AND NEITHER IS EVER WRITTEN TO A BEAD. `planning` is derived from the
 *  epic's children; `unstaffed` is derived from the live agent roster, through the `buildRungFor`
 *  predicate {@link bucketEpics} takes. That is what makes the Unstaffed rung honest for every
 *  epic in the store the instant it ships — there is no migration, no sweep and no label — and it
 *  is what makes a card slide back to "Being built" BY ITSELF the moment an agent binds. */
export type EpicLadderKey = BoardColumn | "planning" | "unstaffed";

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
  // ══ THE BUILD STAGE IS TWO COLUMNS, AND THE SHARED PREFIX IS THE POINT ═══════════════════════
  // The founder, 2026-08-22, verbatim: *"I actually really like the idea that we have that we split
  // being built into two subcategories as follows: 'Build: Unstaffed' and 'Build: Active'. So the
  // unstaffed one would be right above the active one."*
  //
  // They read as ONE stage with two states rather than two unrelated rungs, which is the fact:
  // both hold work he has already said he wants built. The prefix is what says so — "Unstaffed"
  // alone, sitting between Blocked and Being built, looked like a fourth kind of not-started.
  //
  // "Being built" was this column's name from the beginning and is retired here deliberately. It
  // was TRUE ABOUT INTENT AND FALSE ABOUT ACTIVITY — the whole defect this ladder change exists to
  // fix — and leaving it on the staffed half would keep inviting the reading that its neighbour is
  // some lesser form of the same thing. "Build: Active" states the live fact the column now checks.
  unstaffed: "Build: Unstaffed",
  inProgress: "Build: Active",
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
 *  a key to {@link EpicLadderKey} a compile error HERE too. Same idiom as `beads.ts`'s
 *  `BOARD_COLUMNS` — the board's own six-column list, which `allBoardBeads` walks — for the same
 *  reason.
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
  // UNSTAFFED SITS BETWEEN BLOCKED AND BEING BUILT, on the founder's instruction: *"I don't have a
  // good understanding of why an epic can be in the being built category and yet there are no
  // active billed agents running against it."* The rung he picked reads
  // `Backlog | Planning | Blocked | Unstaffed | Being built | Done | Shipped | Archived`.
  //
  // It is immediately LEFT of "Being built" because that is where the card falls back FROM and
  // slides forward TO. An epic claimed to `in_progress` with nobody bound has not progressed; an
  // agent binding to it moves it one rung right, with no write to bd and no sweep. Putting it any
  // further left would make that one-rung slide look like a stage change it is not.
  unstaffed: true,
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
  unstaffed: [],
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
 *
 * == `buildRungFor` -- THE ONE THING "Being built" CANNOT ANSWER ABOUT ITSELF ==================
 * `bead.status === "in_progress"` is stamped ONCE, at promote-to-build, and never re-derived. No
 * agent, PID or pane is consulted anywhere on this path, so an epic whose build never bound an
 * orchestrator -- or whose orchestrator finished and went away -- sits under a header reading
 * "Being built" indefinitely. Measured on the founder's store the day this shipped: 129 beads
 * `in_progress`, three touched in the last two hours.
 *
 * So the caller may hand in the roster's answer, and an epic that would land in `inProgress` is
 * filed on whichever rung that answer NAMES -- `inProgress`, `unstaffed`, or `blocked` for a fleet
 * that is entirely red. BOTH ROUTES INTO `inProgress` GO THROUGH IT -- the
 * `board.inProgress` copy-through AND {@link openEpicStage}'s `in_progress` child-rollup arm, which
 * is how an `open` epic with in-flight children gets there. Covering only the first would leave the
 * founder's screen honest for one half of its Being-built column and silently wrong for the other.
 *
 * THE PREDICATE MUST BE `engine/epicHealth`'s RULE, NOT A SECOND ONE. Its callers pass
 * `(id) => rungForEpicHealth(healthOf(id))`, where `healthOf` is `hooks/useEpicHealthOf`. A local
 * "does the roster contain an agent" test looks equivalent and is not: `epicHealth` deliberately
 * collapses "no agents at all" AND "every bound agent has finished and gone gray" into one value,
 * and it FOLDS workers into their orchestrator. A rival rule would put the square and the column
 * header into disagreement about the same epic, which is the column-chip drift this codebase's own
 * comments record as already shipped twice.
 *
 * NOTE THE TWO VOCABULARIES, which used to share a word. `EpicHealth` is now `RollupDot` — a
 * COLOUR (`"gray"`, `"red"`, …) identical to what a build row paints. `"unstaffed"` is a RUNG, one
 * of the columns this function files an epic into. `rungForEpicHealth` is the translation between
 * them, and it is the only place that translation happens.
 *
 * OMITTED, NOTHING EVER REACHES `unstaffed` OR `blocked` BY THIS ROUTE, and this function behaves
 * exactly as it did before the rung existed. Note that `blocked` IS now a reachable outcome for a
 * bead whose OWN status is `in_progress` or `open` — an entirely red fleet files the epic beside
 * the dependency-blocked work, which is a thing this function previously could not say at all.
 * Behaving unchanged when omitted is the contract every rosterless caller and every fixture relies
 * on.
 */
export function bucketEpics(
  board: Board,
  allBeads: readonly Bead[],
  buildRungFor?: (epicId: string) => "blocked" | "unstaffed" | "inProgress",
): EpicBoard {
  const out = emptyEpicBoard();
  // CACHED, not `buildEpicIndex`. Both are one walk instead of one per bead, but this receives the
  // SAME `allBeads` identity every Card and EpicRow resolves through, so a direct uncached build
  // here pays a second full O(n) walk of a store the cache already holds -- 6-13 ms on the
  // founder's store, on the render path this index exists to make cheap (roborev 65662).
  const index = epicIndexOf(allBeads);
  const keep = (b: Bead) => isEpicIndexed(index, b);
  /**
   * THE ONE PLACE THE BUILD RUNG IS CHOSEN, so the two routes into it cannot diverge.
   *
   * ══ WHY THIS TAKES A RUNG AND NOT A BOOLEAN ═══════════════════════════════════════════════════
   * It used to take `isStaffed?: (id) => boolean`, and a boolean cannot express the founder's rule.
   * He named THREE outcomes for a live fleet, not two: *"if there are not any [agents] and it's not
   * finished then by definition it should be considered blocked … Meaning if the agents are Red then
   * it would go into blocked … Now if there are some agents that are red and there are some agents
   * that are not red … probably it should stay in Being Built."*
   *
   * With a boolean, the `red -> blocked` arm had nowhere to go. `engine/epicHealth.rungForEpicHealth`
   * held that rule and had **zero production callers** — five tests asserted it as though it were
   * live while the shipped path could only ever answer inProgress-or-unstaffed. A green suite over a
   * rule the screen never runs is the vacuous shape `AGENTS.md` names, and it is worse here than
   * usual: the arm that never fired is the one that tells the founder a human is needed.
   *
   * Taking the rung itself means ONE rule decides, it lives in `epicHealth`, and this module stays
   * pure data with no opinion about agents — see this file's header for why that separation is
   * load-bearing.
   */
  const buildingRung = (b: Bead): EpicLadderKey =>
    buildRungFor === undefined ? "inProgress" : buildRungFor(b.id);
  out.archived = board.archived.filter(keep);
  out.delivered = board.delivered.filter(keep);
  out.done = board.done.filter(keep);
  out.blocked = board.blocked.filter(keep);
  // ROUTE 1 -- the epic's OWN `in_progress` status. This is the 129-bead case.
  for (const b of board.inProgress) {
    if (!keep(b)) continue;
    out[buildingRung(b)].push(b);
  }
  // Only the open pile splits, and it is the split that gives Planning its column.
  for (const b of board.backlog) {
    if (!keep(b)) continue;
    const stage = openEpicStage(index, b.id);
    // ROUTE 2 -- an `open` epic whose CHILDREN roll up to in-progress. Same question, same answer.
    out[stage === "inProgress" ? buildingRung(b) : stage].push(b);
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

/** A task-shaped `Board` widened to the ladder's shape with EMPTY Planning and Unstaffed piles, so
 *  the view can index one type for every mode. Both are empty by construction here and that is
 *  correct: Planning is an EPIC-only stage (it is a statement about an epic's children), and
 *  Unstaffed is an EPIC-only stage for the same kind of reason (it is a statement about the agents
 *  bound to an epic). The task modes render neither column, so there is nothing to put in them. */
export function withPlanning(board: Board): EpicBoard {
  return { ...board, planning: [], unstaffed: [] };
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

/* `epicsFirst` LIVED HERE AND IS NOW `services/boardSort.ts`'s `sortBy: "type"`.
 *
 * It hoisted every epic above every task, in bd's arbitrary order within each group — the
 * founder's ORIGINAL spec for "I'm not seeing epics". He then corrected it: "we should have p
 * zero epics show first and then all the p zero tasks and then p one epics would show below
 * that … epics basically show at the beginning of the priority list", i.e. interleaved BY
 * PRIORITY BAND. The hoisting reading survives verbatim as one of the four Sort by options —
 * "Type (All Epics, then Tasks; In priority order)" — so no behaviour was dropped, it moved and
 * gained a priority order within each group.
 *
 * Its private helper `mapPiles` went with it — it had exactly one caller and became unused the
 * moment `epicsFirst` did, which CI caught as a lint error (`'mapPiles' is defined but never
 * used`). `mapBoard` below is the FILTERING twin and is still live; do not confuse them.
 *
 * Removed rather than left exported-and-unused: two functions answering "what order do board
 * cards go in" is the drift this file's own header is about, and this one had no caller and no
 * test once the comparator landed. See `boardSort.ts`.
 */


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
