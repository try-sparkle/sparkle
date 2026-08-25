// THE EPICS COLUMN — the founder's seven-stage ladder, rendered VERTICALLY as a real cockpit column.
//
// ── WHY A COLUMN AND NOT THE BOARD'S EPICS MODE ────────────────────────────────────────────────
//
// v0.116.1 shipped kind toggles INSIDE the Plan board (PR #2093 — a Both/Tasks/Epics mode then,
// two independent Tasks and Epics toggles now), and clearing Tasks swaps the board's status columns
// for this same ladder laid out horizontally. That is a different thing from what was asked for
// twice, and both survive on purpose:
//
//   • The BOARD is the wide drag surface. Seven columns at a 220px floor need ~1644px, which is why
//     `PlanBoardSlot` spans the whole pair — and why it COVERS this column rather than sitting
//     beside it. You go there to move work about.
//   • This COLUMN is the always-on glance-and-select surface. It is ~280px, it is never a mode, and
//     its job is one gesture: pick an epic, and the build column beside it narrows to the
//     orchestrators working on it. The founder: "a layer where I can be looking at EPICS and I can
//     see all of the orchestrators that have to do with that epic."
//
// They are never on screen together (constraint 4: "When I'm on the Plan board I should not see the
// EPICS column"), so the duplication is in the data, not in what the user is looking at.
//
// ── MEMBERSHIP IS NOT DEFINED HERE, AND THAT IS ENFORCED ───────────────────────────────────────
//
// Epic-ness and the parent-child edge are stated in exactly ONE file — `services/beads.ts` — and
// `scripts/lib/epic-membership-guard.sh` fails CI if a second definition appears anywhere else.
// This file therefore never re-derives epic-ness from a bead's type, and never re-derives the
// parent-child edge from its fields; it calls
// `bucketEpics` (which walks `buildEpicIndex` for it) and `childrenOf`. That guard exists because
// this codebase already grew THREE incompatible answers to "what is an epic", and the founder's
// constraint is not "pick one" but "keep it one".
//
// ── THE DATA COSTS NOTHING NEW ─────────────────────────────────────────────────────────────────
//
// `bucketEpics` is a pure function over the SAME `beadsStore` snapshot `BoardView` already reads,
// and `startPolling` is reference-counted with a `"passive"` `PollKind` designed for exactly this
// second-consumer case. So mounting this column adds no fetch, no poller and no second source of
// truth — it adds one more claim on a poll that was already running.

import { Fragment, useMemo, useState, useCallback, useEffect, useRef } from "react";
import { FiChevronDown, FiChevronRight, FiX } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../theme/colors";
import { FONT_UI, TYPE } from "../theme/scale";
import { ZOOM_COLUMN_ATTR, zoomColumnFor } from "../engine/columnZoom";
import { PAIR_COLUMN_ATTR } from "../engine/pairColumns";
import { ColumnPullTab, HEADER_H, TAB_TOP } from "./ColumnPullTab";
import { HeaderLink } from "./HeaderLink";
import { EpicInlineCard } from "./EpicInlineCard";
// REUSED, never re-derived. This is the same read-only chip the board cards wear
// (`BoardView`), split out of the editable `PriorityPill` precisely for the "hundreds on
// screen" case — a plain span with no state, no listeners and no portal. Two different-looking
// priority treatments in one app is the class of defect this import exists to avoid, and it
// matters more than usual here: `sparkle-hhb5re` makes priority the board's primary sort key,
// so the chip and the ordering are read together and must agree.
import { BeadPriorityChip } from "./BeadCard/BeadPriorityChip";
import { EPICS_COLUMN_Z } from "./layers";
import { useColumnZoom } from "../hooks/useZoomColumn";
import { useWindowWidth } from "../hooks/useWindowWidth";
import { useBeadsStore } from "../stores/beadsStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { PairSide } from "../engine/pairs";
import type { Project } from "../types";
import {
  EPICS_COLUMN_MIN_WIDTH,
  EPICS_COLUMN_PAINTED_WIDTH,
  epicsColumnMax,
  epicsWidthKey,
  epicsWidthVar,
  readStoredEpicsWidth,
} from "../engine/columnResize";
import { EPIC_LADDER_COLUMNS, bucketEpics, type EpicLadderKey } from "../services/epicBoard";
// ── THE ORDER IS THE PLAN BOARD'S, NOT A SECOND ONE ───────────────────────────────────────────
// `sortEpicBoard` is `sparkle-hhb5re`'s comparator — the same one `BoardView` applies to the same
// `EpicBoard` shape — and `BoardSort`/`SORT_LABEL` are the same identifiers and words its chip
// offers. This column contributes a CONTROL (`EpicsColumnSortControl`) and nothing about ordering;
// see that file's header for why `type` is the one option it does not offer.
import { sortEpicBoard } from "../services/boardSort";
import type { BoardSort } from "../services/boardFilters";
import { EpicsColumnSortControl } from "./EpicsColumnSortControl";
// WHERE a bead sits, decided once, as data — see that module's header for the founder's ruling that
// this question is answered by MOVING THE COLUMN and never by a sentence on screen.
import { flashTargetId, revealFor } from "../engine/epicReveal";
// ── THE HEALTH WIRING IS ONE HOOK, SHARED WITH THE PLAN BOARD ─────────────────────────────────
// It used to be a memo right here, which was correct while this column was the only surface asking.
// `BoardView`'s Epics mode now renders the same ladder and needs the same answer for its Unstaffed
// rung, so the chain lives in `hooks/useEpicHealthOf` and both callers read it. Its header explains
// why each link in that chain is the SHARED one; the short version is that two hand-written copies
// is how two columns come to disagree about one epic.
import { epicHealthApplies, rungForEpicHealth, type EpicHealth } from "../engine/epicHealth";
import { useEpicHealthOf } from "../hooks/useEpicHealthOf";
import type { AgentTab } from "../types";
import { EpicHealthSquare } from "./EpicHealthSquare";
import {
  childrenOfIndexed,
  epicDisplayTitle,
  epicIndexOf,
  openChildCountIndexed,
  type Bead,
} from "../services/beads";

/** How much room the ladder leaves for the pull tab on the seam side. The rail is 6px and the grip
 *  chiclet overhangs it slightly, so 10 clears both without eating a readable amount of a 280px
 *  column. */
const SEAM_CLEARANCE = 10;

/** A stable empty list, so a project with no snapshot yet does not hand a fresh array to the memo
 *  below on every render and re-bucket the whole store for nothing. */
const NO_BEADS: Bead[] = [];

/** The same trick for the roster: a pair with no project must not hand a fresh `[]` to the health
 *  memos each render and rebuild the whole rollup for a column that has nothing in it. */
const NO_AGENTS: AgentTab[] = [];

// ══ THE REVEAL — "SHOW ME WHERE THIS SITS", NEVER A SENTENCE SAYING WHERE ══════════════════════
//
// The founder pressed **Open in column** on a TASK, the column lists epics, and nothing moved. He
// was offered an explanatory message ("this is a task, not an epic") and rejected it by name:
//
//   *"instead of saying this is a task, not an epic […] it should open the parent epic […] And then
//   I should already be able to see all the children that are attached to that epic. So maybe it
//   scrolls me to that child […] And then it flashes it briefly […] So it draws my attention to it
//   […] I would just want you to show me where it sits inside of the Epic."*
//
// So the four verbs below are the whole feature: OPEN the parent epic, EXPAND it, SCROLL to the
// child, FLASH the child. `engine/epicReveal` decides WHAT; everything from here down is HOW.

/** How long the highlight is held. ~1.2s: long enough that an eye arriving late still catches it,
 *  short enough that it reads as a flash rather than as a new selected state (the row already has
 *  one of those, and two persistent highlights in one column is the ambiguity this must not add). */
const FLASH_MS = 1200;

/** The reveal target may not be in the DOM on the commit that asks for it: expanding a collapsed
 *  stage, opening the epic's card and PACKING its task pills each take a render, and the pills are
 *  packed by a measurement pass rather than painted straight out. So the lookup RETRIES — briefly,
 *  and then gives up silently. Giving up is the correct end state: the alternative is a notice
 *  saying the reveal failed, which is the message the founder ruled out wearing a different hat. */
const FLASH_FIND_ATTEMPTS = 20;
const FLASH_FIND_INTERVAL_MS = 16;

/** Does this reader want motion suppressed? Read at flash time rather than subscribed to: the
 *  answer only matters for the 1.2s a flash lasts, and the OS setting does not change mid-flash.
 *  Same probe `SendModeTray` uses, and guarded the same way — `matchMedia` is absent in some test
 *  environments and a missing accessibility probe must never take the reveal down with it. */
function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The first of `selectors` that resolves inside `root`, or null. ORDERED, and the order carries
 *  the fallback: a child reveal asks for the task's pill INSIDE the open card first and settles for
 *  the epic's row only if the pill is not drawn (it can be packed behind "+N more"). Landing on the
 *  row is still an answer to "where does this sit"; landing nowhere is not. */
function findFlashTarget(root: HTMLElement, selectors: readonly string[]): HTMLElement | null {
  for (const sel of selectors) {
    const el = root.querySelector<HTMLElement>(sel);
    if (el !== null) return el;
  }
  return null;
}

/**
 * Paint the flash onto `el` and hand back the undo.
 *
 * WRITTEN IMPERATIVELY, ONTO A NODE THIS FILE DOES NOT RENDER — because the child being revealed is
 * a task pill inside `EpicInlineCard`'s `BeadCard`, several components away and owned by neither
 * this file nor this change. Threading a "are you the flashed one" prop down that chain would put
 * a transient viewport concern into three components' APIs; setting one attribute and two style
 * properties on the resolved node, and putting them back afterwards, keeps it entirely here.
 *
 * `data-bead-flash` is the marker the tests read, and it carries WHICH treatment was applied so
 * that the reduced-motion path is observable rather than merely believed.
 */
function applyFlash(el: HTMLElement, motion: "animate" | "static"): () => void {
  const prevBackground = el.style.backgroundColor;
  const prevColor = el.style.color;
  const prevTransition = el.style.transition;
  el.setAttribute("data-bead-flash", motion);
  // UNDER `reduce` THE HIGHLIGHT IS STILL PAINTED, AND HELD FOR THE SAME 1.2s — only the fade is
  // dropped. Skipping the reveal for a reduced-motion reader would take away the ONLY confirmation
  // the click did anything, which is a strictly worse outcome than the movement it avoids.
  el.style.transition =
    motion === "animate" ? "background-color 220ms ease-out, color 220ms ease-out" : "";
  // The epic pill's fill and its PAIRED ink, so the flashed row does not lose its text for 1.2s.
  // These two are themed together for exactly this reason; a hand-picked highlight here would be a
  // fourth un-themed colour in a column the repaint just finished cleaning up.
  el.style.backgroundColor = C.epicPillFill;
  el.style.color = C.onEpicPillFill;
  return () => {
    el.removeAttribute("data-bead-flash");
    el.style.backgroundColor = prevBackground;
    el.style.color = prevColor;
    el.style.transition = prevTransition;
  };
}

/** Which stages start OPEN.
 *
 *  The four the founder scans for "what have I asked for, what is happening, and what is stuck" —
 *  everything else is history, and opening all seven puts a hundred rows in a 280px column.
 *  Collapsing is per-side session state rather than persisted: this is a reading posture, not a
 *  preference, and a restored one is a column that looks empty for a reason the user did not set
 *  this session (the same argument `uiStore` makes for every transient key it has).
 *
 *  BACKLOG IS ON THIS LIST BECAUSE IT IS WHERE NEW WORK ARRIVES, and leaving it off broke the one
 *  gesture this column exists to serve. `create_plan` files a typed epic with no children, which
 *  `openEpicStage` buckets to `backlog` — so with Backlog collapsed the founder describes a feature
 *  to the concierge, the bead is filed correctly, and what he sees is a COUNT tick from 3 to 4
 *  behind a closed chevron. It is also the pile he came here to read: "so much that I have asked
 *  for that I have not been able to track" is a description of Backlog. Done/Shipped/Archived stay
 *  collapsed — those are history, and they are the piles that actually grow without bound.
 *
 *  UNSTAFFED IS ON THIS LIST BECAUSE IT IS THE WHOLE POINT OF THE RUNG. The founder's complaint was
 *  *"I don't have a good understanding of why an epic can be in the being built category and yet
 *  there are no active billed agents running against it."* — i.e. these epics were ALREADY invisible
 *  to him, hidden inside a column whose header said the opposite. Shipping the new rung collapsed
 *  would re-hide exactly the epics it exists to surface, and swap one wrong header for a closed
 *  chevron with a count beside it. It is a live state, not history; it belongs with the other three
 *  he scans for "what have I asked for, what is happening, and what is stuck". */
const OPEN_BY_DEFAULT: ReadonlySet<EpicLadderKey> = new Set<EpicLadderKey>([
  "backlog",
  "blocked",
  "planning",
  "unstaffed",
  "inProgress",
]);

/**
 * The epics column for one pair.
 *
 * `project` may be null — the left pair renders whenever anything is assigned to it, and a pair
 * whose tab has just been closed has no project for a frame. An empty column is the right answer
 * there; unmounting would take the seam and the stored width with it.
 */
export function EpicsColumn({
  project,
  side,
  covered = false,
}: {
  project: Project | null;
  side: PairSide;
  /** Covered by this pair's Plan board or preview overlay — the same contract `AgentSidebar` takes.
   *  Layout box kept, everything inside unreachable: no tab stop, no a11y announcement, no click
   *  landing on a control the user cannot see. `visibility: hidden` alone leaves all three. */
  covered?: boolean;
}) {
  const windowWidth = useWindowWidth();
  const zoomColumn = zoomColumnFor("epics", side);
  const columnZoom = useColumnZoom(zoomColumn);

  // ── WIDTH ────────────────────────────────────────────────────────────────────────────────────
  // Seeded from storage ONCE and never reconciled against the live ceiling again — the
  // painted-not-stored split `AgentSidebar` documents at length. `width > MAX_WIDTH` after a window
  // shrink is this column's normal steady state and is exactly what makes the preference survive a
  // trip through a small display.
  const MAX_WIDTH = epicsColumnMax(windowWidth);
  const [width, setWidth] = useState<number>(() => readStoredEpicsWidth(side, windowWidth));

  const commitWidth = useCallback(
    (next: number) => {
      setWidth(next);
      try {
        localStorage.setItem(epicsWidthKey(side), String(next));
      } catch {
        // Storage can be unavailable outright; losing the persistence is not worth a broken drag.
      }
    },
    [side],
  );

  // The live var the drag writes, so the column repaints without a React commit. Mirrored into
  // state above on commit so a remount reads the same number.
  useEffect(() => {
    document.documentElement.style.setProperty(epicsWidthVar(side), `${width}px`);
  }, [side, width]);

  // ── DATA ─────────────────────────────────────────────────────────────────────────────────────
  // GATED ON `beadsEnabled`, and the empty state below is the reason rather than the poll. With
  // beads off there is no snapshot and never will be, so an ungated column sits on "Loading epics…"
  // FOREVER — a spinner for a thing that is not coming, which reads as a broken feature rather than
  // as a setting the user turned off. `PlanBoardSlot` reads the same flag for the same reason.
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);
  const snapshot = useBeadsStore((s) => (project ? s.byProject[project.id] : undefined));
  // THE OTHER WAY A SNAPSHOT NEVER ARRIVES. `refresh` writes `error[projectId]` and leaves
  // `byProject[projectId]` undefined when `bd` is missing or a read fails — so without reading this
  // the column sits on "Loading epics…" forever exactly as it did with beads off, the same defect
  // reached by a different cause. `BoardView` already reads this for the same reason.
  const readError = useBeadsStore((s) => (project ? s.error[project.id] : undefined));
  const projectId = project?.id;
  const projectPath = project?.rootPath;
  useEffect(() => {
    if (!beadsEnabled) return;
    if (!projectId || !projectPath) return;
    // A "passive" claim: this column wants the snapshot but does NOT want the post-poll decompose
    // watcher a board viewer asks for. `startPolling` is reference-counted precisely so a second
    // consumer costs nothing and a `stopPolling` here cannot switch the board's poll off.
    useBeadsStore.getState().startPolling(projectId, projectPath, undefined, "passive");
    return () => useBeadsStore.getState().stopPolling(projectId, "passive");
  }, [beadsEnabled, projectId, projectPath]);

  const board = snapshot?.board;
  const allBeads = snapshot?.beads ?? NO_BEADS;

  // ── HEALTH ───────────────────────────────────────────────────────────────────────────────────
  // The founder: *"The epics should be tied to the corresponding build agents and the statuses
  // should be showing next to the epic row."* The rule is `engine/epicHealth`; the wiring is
  // `hooks/useEpicHealthOf`, shared with `BoardView`'s Epics mode so the two surfaces cannot
  // disagree about one epic.
  //
  // ⚠️ IT SITS ABOVE `ladder` BECAUSE THE LADDER NOW DEPENDS ON IT. This used to be the other way
  // round, and swapping the order is the whole reason the block moved: `bucketEpics` asks this
  // function which epics are staffed, so a `ladder` memo declared above it would close over a
  // `healthOf` that does not exist yet. Both are unconditional hook calls in a fixed order — do not
  // "fix" this by moving one inside a branch.
  const agents = project?.agents;
  const roster = agents ?? NO_AGENTS;
  const healthOf = useEpicHealthOf(roster, allBeads);

  // ── THE LADDER, WITH THE UNSTAFFED RUNG DERIVED FROM THAT SAME RULE ──────────────────────────
  // The founder, on an epic sitting under "Being built" with nothing running: *"I don't have a good
  // understanding of why an epic can be in the being built category and yet there are no active
  // billed agents running against it."* `bead.status` is stamped once at promote-to-build and never
  // re-derived, so it cannot answer him; the roster can, and this is where it is asked.
  //
  // ONE RULE, NOT TWO. `epicHealth(readings) === "gray"` is the same predicate that paints the
  // square beside the row, so the mark and the header above it cannot contradict each other.
  // A local "does the roster contain an agent for this epic" test would look equivalent and would
  // not be: `epicHealth` folds workers into their orchestrator and reads an epic whose agents have
  // ALL finished and gone gray as gray too — which is the founder's case as much as the empty one
  // is.
  //
  // `"gray"` IS THE COLOUR, `"unstaffed"` IS THE RUNG. `EpicHealth` is now literally `RollupDot`
  // (the founder's colour-parity rule; see `engine/epicHealth`), so the health value that used to be
  // called `"unstaffed"` is spelled the way the build column spells it, and the rung keeps the name.
  //
  // NO WRITE TO BD HAPPENS ANYWHERE ON THIS PATH. The rung is purely derived, which is what makes it
  // honest for every existing `in_progress` bead the instant it ships, and what makes a card slide
  // back to "Being built" by itself the moment an agent binds.
  // ── THE ORDER WITHIN EACH RUNG ───────────────────────────────────────────────────────────────
  // The founder, item 4 of `sparkle-huw924`: a sort-by control belongs in this header. The
  // SELECTION lives here, in the column's own state, rather than in `uiStore`: it is a reading
  // posture for one column on one side — the same argument `collapsed` above makes — and it is
  // deliberately NOT folded into `boardFilterBySide`, which is the PLAN BOARD's control and would
  // then swing this column from a chip the user cannot see while the board is up.
  const [sortBy, setSortBy] = useState<BoardSort>("priority");
  // READ, NEVER WRITTEN. The date sorts have to read SOME timestamp field, and the app already
  // holds exactly one answer to "created or updated" — the board's own chip. Minting a second
  // switch here would let the two surfaces disagree about what "Newest" means, which is the whole
  // reason `boardFilters` keeps `sortBy` and `dateField` in one object.
  const dateField = useUiStore((s) => s.boardFilterBySide[side].dateField);

  const ladder = useMemo(() => {
    // ONE RULE DECIDES THE RUNG, and it is `engine/epicHealth`'s. This passed a BOOLEAN
    // (`healthOf(id) !== "unstaffed"`), which could only ever say inProgress-or-unstaffed — so the
    // founder's *"if the agents are Red then it would go into blocked"* had nowhere to land, and
    // `rungForEpicHealth` sat with zero production callers while its tests asserted it as live.
    const bucketed = board
      ? bucketEpics(board, allBeads, (id) => rungForEpicHealth(healthOf(id)))
      : null;
    // SORTED WITHIN EACH RUNG, NOT FLATTENED. `sortEpicBoard` walks the ladder's own key list and
    // orders each column's array in place of itself, so the seven stages, their counts and their
    // collapse state are all exactly as they were — only the rows inside one stage move. Applied
    // HERE rather than at the render loop so the rendering below reads one `ladder` as it always
    // has, and so the sort's own cache is keyed on the bucketed arrays' identity.
    return bucketed ? sortEpicBoard(bucketed, sortBy, dateField, allBeads) : null;
  }, [board, allBeads, healthOf, sortBy, dateField]);

  // ── SELECTION ────────────────────────────────────────────────────────────────────────────────
  const focusedEpicId = useUiStore((s) => s.epicFocusBySide[side]);
  const setEpicFocus = useUiStore((s) => s.setEpicFocus);
  const openPlanBoard = useUiStore((s) => s.openPlanBoard);
  // ── THE REVEAL REQUEST ───────────────────────────────────────────────────────────────────────
  // An EVENT, not a selection — `uiStore.columnRevealBySide` explains at length why those cannot be
  // the same key, and the short version is that a bead already on screen must still flash.
  const revealRequest = useUiStore((s) => s.columnRevealBySide[side]);
  const focusEpicWithChild = useUiStore((s) => s.focusEpicWithChild);

  const [collapsed, setCollapsed] = useState<ReadonlySet<EpicLadderKey>>(
    () => new Set(EPIC_LADDER_COLUMNS.map((c) => c.key).filter((k) => !OPEN_BY_DEFAULT.has(k))),
  );
  const toggleStage = useCallback((key: EpicLadderKey) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── A NEWLY FILED EPIC REVEALS ITSELF ────────────────────────────────────────────────────────
  //
  // `OPEN_BY_DEFAULT` above answers the GLANCE case (the column he walks up to already shows
  // Backlog). This answers the LIVE case, which is the one the founder actually described: he is
  // mid-conversation, he asks the concierge for an epic, and the card has to come to HIM. Two
  // things defeat the default on its own — he may have collapsed Backlog himself to read something
  // else, and a `create_plan` against an epic that already has children does not land in Backlog at
  // all (its child roll-up sends it to Planning, Building or Done). A reveal keyed to one stage
  // would miss both.
  //
  // THE DIFF IS AGAINST WHAT WE HAVE SEEN, NOT AGAINST THE PREVIOUS RENDER. `ladder` is a fresh
  // object on every poll (5s), so "did this list change" is true constantly and would re-open every
  // stage he closed, forever. A set of ids seen so far is the only thing that distinguishes an
  // ARRIVAL from a re-render — and it is SEEDED, not empty, on the first snapshot, because
  // otherwise every epic in the store is an arrival at mount and all seven stages fly open.
  //
  // THE SEED IS KEYED TO THE PROJECT, NOT TO THIS COMPONENT. `EpicsColumn` takes `project` as a
  // PROP and is not remounted when the pair's project changes, so a bare ref survives the switch —
  // and every epic in the newly selected project is then, correctly by the ref's reckoning, unseen.
  // The first one would expand its stage and scroll, on the most ordinary navigation gesture in the
  // app, re-opening a stage the founder had deliberately closed. That is the same "everything is new
  // at mount" failure the seeding exists to prevent, arriving through a door the mount case does not
  // cover — and a test that only ever renders ONE project cannot see it (bead `sparkle-foqoe`'s
  // shape: absence asserted against a state that was never mounted).
  const seenEpicIds = useRef<{ projectId: string | null; ids: ReadonlySet<string> } | null>(null);
  const [revealEpicId, setRevealEpicId] = useState<string | null>(null);

  useEffect(() => {
    if (!ladder) return;
    const present = new Set<string>();
    let arrived: { id: string; key: EpicLadderKey } | null = null;
    // A different project is a FIRST SNAPSHOT, not a wave of arrivals.
    const prior = seenEpicIds.current;
    const seen = prior && prior.projectId === (projectId ?? null) ? prior.ids : null;
    for (const { key } of EPIC_LADDER_COLUMNS) {
      for (const epic of ladder[key]) {
        present.add(epic.id);
        // FIRST in ladder order wins, which is deliberate rather than arbitrary: the ladder reads
        // Backlog-first, and a create lands in the earliest stage it can. If two arrive at once the
        // founder is shown the newer-looking end of the ladder rather than the archive.
        if (seen && !seen.has(epic.id) && !arrived) arrived = { id: epic.id, key };
      }
    }
    seenEpicIds.current = { projectId: projectId ?? null, ids: present };
    if (!seen || !arrived) {
      // Clear any reveal held over from the PREVIOUS project — its row is gone, so leaving the id
      // set would re-fire the scroll the moment an unrelated epic happened to share it.
      if (!seen) setRevealEpicId(null);
      return; // first snapshot for this project, or nothing new — leave his posture alone
    }
    const target = arrived;
    setCollapsed((prev) => {
      if (!prev.has(target.key)) return prev; // already open; don't churn the set
      const next = new Set(prev);
      next.delete(target.key);
      return next;
    });
    setRevealEpicId(target.id);
  }, [ladder, projectId]);

  // ── "OPEN IN COLUMN" ON ANY BEAD — RESOLVE, FOCUS, EXPAND ────────────────────────────────────
  //
  // Step one of the founder's four. `engine/epicReveal` says WHICH epic (or, for a parentless task,
  // that there is none); this writes the focus that opens that epic's card and un-collapses the
  // stage holding it. The scroll and the flash are step two, in the effect below, because they can
  // only run once this one's render has put the row and the card in the DOM.
  //
  // THE REQUEST IS RE-TRIED UNTIL IT RESOLVES, NOT DROPPED. `revealFor` returns null while the id
  // names nothing in this snapshot — which is the ordinary state for the first seconds after launch,
  // when the link fires against a store that has not polled yet. Marking the nonce handled only on
  // a successful resolve means the next snapshot completes the gesture, instead of the reveal being
  // silently lost to a race the user cannot see and would have no way to retry except by pressing
  // the link again.
  const [standaloneRevealId, setStandaloneRevealId] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ selectors: readonly string[]; nonce: number } | null>(null);
  const handledRevealNonce = useRef<number>(0);

  useEffect(() => {
    if (!revealRequest || revealRequest.nonce === handledRevealNonce.current) return;
    const resolved = revealFor(allBeads, revealRequest.beadId);
    // NO ELSE BRANCH, AND THAT IS THE FOUNDER'S RULING. An unresolvable id does nothing at all —
    // there is no "couldn't find it" notice anywhere on this path, by design.
    if (resolved === null) return;
    handledRevealNonce.current = revealRequest.nonce;

    // NARROWED ON THE DISCRIMINANT, NOT ON `revealedEpicId(resolved) === null`. The two agree at
    // runtime — that helper returns null for exactly the standalone variant and nothing else — but
    // only the tag test narrows the union for the COMPILER, so the `epicId === null` form cannot
    // read `.beadId` in one branch or pass a non-null `epicId` in the other. Keeping the tag test
    // also means a future variant carrying no epic id fails to compile here rather than silently
    // taking the standalone path.
    if (resolved.kind === "standalone") {
      // A PARENTLESS, CHILDLESS TASK — today the COMMON case (45 of 46 agent-linked beads), so this
      // is the main path wearing the name of an edge case. It is revealed as its OWN row with its
      // own card open, rendered above the ladder: "where it sits" is still answered positionally,
      // and the answer is "on its own".
      setStandaloneRevealId(resolved.beadId);
      focusEpicWithChild(side, resolved.beadId, null);
    } else {
      setStandaloneRevealId(null);
      // `focusEpicWithChild`, NOT `openEpicFocus` — the latter clears the child rung (rule 3), which
      // would undo the very narrowing the link just performed on the task the user clicked. See the
      // action's own note; the child here is known to be inside this epic, so rule 3 does not apply.
      focusEpicWithChild(side, resolved.epicId, resolved.kind === "child" ? resolved.childId : null);
      // ── EXPAND: "I should already be able to see all the children attached to that epic" ──────
      // The stage holding the epic is un-collapsed, so a reveal into a stage the reader had closed
      // (or that starts closed — Done, Shipped, Archived) still lands on a visible row rather than
      // behind a chevron with a count beside it.
      if (ladder) {
        const stage = EPIC_LADDER_COLUMNS.find(({ key }) =>
          ladder[key].some((e) => e.id === resolved.epicId),
        );
        if (stage) {
          setCollapsed((prev) => {
            if (!prev.has(stage.key)) return prev; // already open; don't churn the set
            const next = new Set(prev);
            next.delete(stage.key);
            return next;
          });
        }
      }
    }

    const targetId = flashTargetId(resolved);
    setFlash({
      // ORDERED FALLBACK — see `findFlashTarget`. The task's pill inside the open card first; the
      // epic's own row if that pill is not drawn.
      selectors:
        resolved.kind === "child"
          ? [`[data-pill-id="${resolved.childId}"]`, `[data-reveal-id="${resolved.epicId}"]`]
          : [`[data-reveal-id="${targetId}"]`],
      nonce: revealRequest.nonce,
    });
  }, [revealRequest, allBeads, ladder, side, focusEpicWithChild]);

  // ── SCROLL AND FLASH ─────────────────────────────────────────────────────────────────────────
  //
  // Steps three and four, and they are one effect because they act on the same node: the thing that
  // gets scrolled to is the thing that gets highlighted, or the gesture points the reader's eye at
  // one place and their attention at another.
  //
  // KEYED ON THE NONCE, so pressing the link on a bead that is ALREADY revealed flashes it again.
  // The founder was explicit that a task he can already see must still flash, because the flash is
  // the only confirmation the click did anything — and a reveal derived from the focus keys cannot
  // do that, since re-focusing the current value is correctly a no-op.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (flash === null) return;
    const root = listRef.current;
    if (root === null) return;
    const motion = prefersReducedMotion() ? "static" : "animate";
    let undo: (() => void) | null = null;
    let findTimer: ReturnType<typeof setTimeout> | undefined;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const tick = () => {
      const el = findFlashTarget(root, flash.selectors);
      if (el === null) {
        attempts += 1;
        if (attempts >= FLASH_FIND_ATTEMPTS) return; // silently, on purpose — see the constant
        findTimer = setTimeout(tick, FLASH_FIND_INTERVAL_MS);
        return;
      }
      // CALLED DEFENSIVELY for the same reason `EpicRow` calls it that way — the target can be
      // unmounted between the state write and this timer, and jsdom has no layout at all, which is
      // why the test for this spies on the CALL and never on a scroll position.
      el.scrollIntoView?.({ block: "nearest" });
      undo = applyFlash(el, motion);
      holdTimer = setTimeout(() => {
        undo?.();
        undo = null;
      }, FLASH_MS);
    };
    tick();
    return () => {
      if (findTimer !== undefined) clearTimeout(findTimer);
      if (holdTimer !== undefined) clearTimeout(holdTimer);
      // PUT THE NODE BACK ON THE WAY OUT. The flash writes inline styles onto a node this component
      // does not render, so an unmount (or a second reveal) mid-flash would otherwise leave a task
      // pill permanently painted gold.
      undo?.();
    };
  }, [flash]);

  // The standalone row is a REVEAL, not a pinned view: it tidies itself away as soon as the reader
  // moves off it, so a task row does not sit above the ladder for the rest of the session. Guarded
  // on having actually been focused once, because the focus write above lands in the same batch as
  // `setStandaloneRevealId` and an unguarded check would fire on the frame between them.
  const standaloneWasFocused = useRef(false);
  useEffect(() => {
    if (standaloneRevealId === null) {
      standaloneWasFocused.current = false;
      return;
    }
    if (focusedEpicId === standaloneRevealId) {
      standaloneWasFocused.current = true;
      return;
    }
    if (standaloneWasFocused.current) setStandaloneRevealId(null);
  }, [standaloneRevealId, focusedEpicId]);

  const standaloneBead = useMemo(
    () =>
      standaloneRevealId === null
        ? null
        : (allBeads.find((b) => b.id === standaloneRevealId) ?? null),
    [standaloneRevealId, allBeads],
  );

  return (
    <div
      data-testid="epics-column"
      data-side={side}
      // ONE OF THE PAIR'S COLUMNS, so a project tab sitting above it paints its face in this
      // column's plane by READING it rather than naming the token a second time — see
      // engine/pairColumns for why that second naming was the bug.
      {...{ [PAIR_COLUMN_ATTR]: "epics" }}
      // THIS EPICS COLUMN, for Cmd +/- — and PER SIDE. Every row here is a <button>, which is
      // exactly the case DOM focus cannot answer in this webview (WKWebView does not focus a plain
      // button on click), so the marker is what the pointer-press tracker resolves against.
      {...{ [ZOOM_COLUMN_ATTR]: zoomColumn }}
      data-covered={String(covered)}
      // THE HALF A DESCENDANT CANNOT UNDO. React 19 renders this as the real `inert` attribute;
      // `false` omits it entirely.
      inert={covered}
      data-width={String(width)}
      style={{
        // The CSS clamp, built in engine/columnResize so this component and the row's arithmetic
        // model cannot spell it differently — then DIVIDED BY THE ZOOM, because `zoom` below scales
        // this element's own box as well as its text. Without the division a column zoomed to 1.2×
        // would occupy 1.2× the row it was budgeted, pushing its neighbours out; with it the column
        // holds the width the row solved for and only the text inside it grows. Same cancellation,
        // and the same reason, as `RENDERED_WIDTH` in AgentSidebar.
        width: `calc(${EPICS_COLUMN_PAINTED_WIDTH(side)} / ${columnZoom})`,
        // THIS COLUMN'S TEXT SIZE. `zoom` rather than `transform: scale()`: a transform paints at
        // the new size but lays out at the old one, so the column would visually overlap its
        // neighbours while the row still reserved the unscaled width, and every hit-test inside
        // would be offset from what the user sees. `zoom` participates in layout.
        zoom: columnZoom,
        flex: "0 0 auto",
        position: "relative",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        background: C.deepForest,
        zIndex: EPICS_COLUMN_Z,
        ...(covered ? { visibility: "hidden" as const, pointerEvents: "none" as const } : null),
      }}
    >
      <div
        data-testid="epics-column-header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          padding: "0 10px",
          minHeight: 34,
          flex: "0 0 auto",
          fontFamily: FONT_UI,
          fontSize: TYPE.small,
          fontWeight: FONT_WEIGHT.semibold,
          color: C.muted,
          // 0.01em, not the 0.06em this carried as "EPICS". Tracking that wide is an UPPERCASE
          // convention — it exists to open up caps, which have no ascenders or descenders to
          // separate them. On sentence case the same value reads as spaced-out and loose.
          letterSpacing: "0.01em",
        }}
      >
        {/* THE TITLE'S OWN GROUP, and the board link belongs to it — not to the controls.
            Founder, 2026-08-20: "I wanted the open planning board to be left justified and not
            right… It should just show to the right of the word epics."

            GROUPING IS THE WHOLE FIX; there is no alignment property to set. The header is
            `space-between`, so the link's old right-edge position was EMERGENT from it being the
            second of two children rather than anything written down. Moving it in here makes the
            title side two items wide and leaves `Clear` alone on the other end, which is the
            arrangement he described. `minWidth: 0` so a narrow column ellipsises the title rather
            than shoving the link out of the box. */}
        <span
          data-testid="epics-header-left"
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
        >
          <span>Epics</span>
          {/* THE WAY IN TO THE BOARD, and it is the ONLY one in the main window now that the
              Build/Plan toggle is gone. Gated on `beadsEnabled` because `planBoardUp()` requires
              it — an ungated link would be a control that visibly does nothing.

              It can only ever say OPEN. While the board is up this whole column is `covered`, i.e.
              `inert` + `visibility: hidden`, per the founder's own constraint quoted at the top of
              this file ("when I'm on the Plan board I should not see the EPICS column"). The CLOSE
              half therefore lives in the board's own header, where it stays visible. */}
          {beadsEnabled && (
            <HeaderLink
              testId="epics-open-plan-board"
              hint="plan"
              label="Open Planning Board"
              onClick={() => openPlanBoard(side)}
            />
          )}
        </span>
        {/* THE RIGHT SLOT IS A GROUP, not a single conditional child. The row is `space-between`,
            so a bare conditional child would park `Clear` in the MIDDLE of the header whenever the
            title side grew. Wrapping the controls keeps the title at one end and every control at
            the other however many there are. */}
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {/* THE ONLY WAY BACK from a narrowed build column, and it lives here rather than in the
              build column because this is where the narrowing was set. A filter whose clear control
              is in a different column from the one that looks empty is the failure `uiStore`'s
              transient-key comments keep naming. Rendered only while something is selected. */}
          {focusedEpicId && (
            <button
              data-testid="epics-clear-focus"
              onClick={() => setEpicFocus(side, null)}
              style={{
                background: "transparent",
                border: "none",
                color: C.tealInk,
                cursor: "pointer",
                fontFamily: FONT_UI,
                fontSize: TYPE.micro,
                padding: 0,
                flex: "0 0 auto",
              }}
            >
              Clear
            </button>
          )}
          {/* SORT SITS RIGHTMOST, after the epic filter's own control — the founder's item 4 on
              `sparkle-huw924` ("a sort-by control belongs to the right of the filter"), and the
              same placement `BoardFilterBar` records for the board's chip: what sits to its LEFT
              decides WHICH epics you are looking at, this decides in what ORDER.

              It renders unconditionally, unlike `Clear`. `Clear` is the exit from a state you are
              in; a sort has no off position — the column is always in one of these orders — so a
              control that appeared only once you had used it could never be the thing you reach
              for the first time. That is exactly the founder's report: he went looking for it and
              it was not there. */}
          <EpicsColumnSortControl value={sortBy} onPick={setSortBy} />
        </span>
      </div>

      {/* CLEARANCE FOR THE SEAM, on whichever side it is on. The pull tab is an absolute child at
          this column's build-facing edge, and the stage counts are flush to that same edge — so
          without this the grip lands on top of the first two counts. Keyed off `side` rather than
          padded on both, because the seam mirrors with the row and symmetric padding would waste
          6px of a 280px column on the side that has no tab. */}
      <div
        ref={listRef}
        data-testid="epics-column-list"
        style={{
          flex: 1,
          overflowY: "auto",
          overflowX: "hidden",
          minHeight: 0,
          [side === "right" ? "paddingRight" : "paddingLeft"]: SEAM_CLEARANCE,
        }}
      >
        {!project && <EmptyNote>Nothing assigned to this side yet.</EmptyNote>}
        {project && !beadsEnabled && (
          <EmptyNote>Beads are switched off, so there are no epics to show.</EmptyNote>
        )}
        {project && beadsEnabled && !ladder && readError && (
          <EmptyNote>Couldn’t read epics: {readError}</EmptyNote>
        )}
        {/* "Loading" is now only the GENUINELY still-loading case: beads on, no error, no snapshot
            yet. The two branches above take the two states that never resolve. */}
        {project && beadsEnabled && !ladder && !readError && <EmptyNote>Loading epics…</EmptyNote>}
        {/* ── A REVEALED TASK THAT BELONGS TO NO EPIC ────────────────────────────────────────────
            The founder's "where does this sit?" still gets a positional answer when the answer is
            "on its own" — the task is drawn as its own row, with its own card open, ABOVE the
            ladder rather than inside a rung it is not a member of. Above, because it is the thing
            the reader just asked for and a reveal that arrives below seven collapsible stages is
            a reveal they have to hunt for.

            NO LABEL, NO EXPLANATION. There is deliberately nothing here saying "this task has no
            epic" — that is the sentence the founder rejected, and a heading is the same sentence
            in a smaller font. The row's own position says it.

            IT REUSES `EpicRow` RATHER THAN DRAWING A SECOND KIND OF ROW: two row treatments in one
            column is exactly the drift `EpicInlineCard`'s header describes ending. `total` comes
            out at 0 for a childless bead, so the count slot simply does not render. */}
        {project && beadsEnabled && standaloneBead && (
          <div data-testid="epics-standalone-reveal">
            <EpicRow
              epic={standaloneBead}
              allBeads={allBeads}
              /* No health square: a bead with no children has no roll-up to report, and an empty
                 gutter beside a single row would read as a missing reading rather than as none. */
              health={null}
              selected={focusedEpicId === standaloneBead.id}
              onSelect={() => setEpicFocus(side, standaloneBead.id)}
            />
            {focusedEpicId === standaloneBead.id && (
              <EpicInlineCard
                bead={standaloneBead}
                projectId={project.id}
                rootPath={project.rootPath ?? null}
                allBeads={allBeads}
              />
            )}
          </div>
        )}
        {project &&
          beadsEnabled &&
          ladder &&
          EPIC_LADDER_COLUMNS.map(({ key, label }) => {
            const rows = ladder[key];
            const isCollapsed = collapsed.has(key);
            return (
              <div key={key} data-testid={`epics-stage-${key}`}>
                <button
                  data-testid={`epics-stage-toggle-${key}`}
                  aria-expanded={!isCollapsed}
                  onClick={() => toggleStage(key)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: "transparent",
                    border: "none",
                    borderTop: `1px solid ${C.hairline}`,
                    color: C.muted,
                    cursor: "pointer",
                    fontFamily: FONT_UI,
                    fontSize: TYPE.micro,
                    fontWeight: FONT_WEIGHT.semibold,
                    padding: "6px 10px",
                    textAlign: "left",
                  }}
                >
                  {/* REACT-ICONS, NEVER A CHARACTER GLYPH. The founder bans glyph-as-icon across
                      the product and `glyphIcons.test.ts` is a falling ratchet on it — the pair of
                      typographic chevrons this row was first written with would have been the
                      fifth site against a ceiling of four. They also render at whatever the
                      platform font decides, so they never lined up with the board's own chevrons. */}
                  <span
                    style={{ width: 10, flex: "0 0 auto", display: "flex", alignItems: "center" }}
                  >
                    {isCollapsed ? (
                      <FiChevronRight size={10} aria-hidden />
                    ) : (
                      <FiChevronDown size={10} aria-hidden />
                    )}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
                  <span data-testid={`epics-stage-count-${key}`}>{rows.length}</span>
                </button>
                {!isCollapsed &&
                  rows.map((epic) => (
                    <Fragment key={epic.id}>
                      <EpicRow
                        epic={epic}
                        allBeads={allBeads}
                        /* `null` on the three terminal rungs — a finished epic has no health to
                           report, and `epicHealthApplies` is where that is decided. */
                        health={epicHealthApplies(key) ? healthOf(epic.id) : null}
                        selected={focusedEpicId === epic.id}
                        reveal={revealEpicId === epic.id}
                        onSelect={() => setEpicFocus(side, epic.id)}
                      />
                      {/* THE CARD OPENS IN PLACE, DIRECTLY UNDER ITS OWN ROW. A sibling rather than
                          a child (EpicRow is a <button>, and this card carries buttons of its own),
                          and in normal flow — so the epics below it are pushed down for free, with
                          no positioning and no portal.

                          `setEpicFocus` already TOGGLES, so the row that opened the card closes it,
                          and the header's Clear does too. Both also drop the build column's
                          narrowing, which is the same gesture from the user's side: this card being
                          open IS "I am working this epic". */}
                      {focusedEpicId === epic.id && project && (
                        <EpicInlineCard
                          bead={epic}
                          projectId={project.id}
                          rootPath={project.rootPath ?? null}
                          allBeads={allBeads}
                        />
                      )}
                    </Fragment>
                  ))}
              </div>
            );
          })}
      </div>

      {/* THE SEAM — this column's own pull tab, INSIDE the column rather than a new row rail.
          Keeping the row's two rails the concierge's alone is what keeps `assertRowStructure()`
          green: it pins "a rail immediately either side of the concierge box, and nothing else
          inside it", and this column sits outboard of those rails.

          ANCHORED TO THE BUILD-FACING EDGE, WHICH IS THE ONLY FREE ONE. The row is
          `TERM │ BUILD │ EPICS │ CONCIERGE │ EPICS │ BUILD │ TERM`, so this column has a neighbour
          on both sides — and the concierge-facing one is ALREADY OWNED by the concierge's rail.
          Putting the tab there (the first version of this did) stacks two drag controls on one
          boundary: the row rail that moves the concierge and this tab that moves Epics, a few px
          apart, competing for the same press. It also parks the grip on top of the first ladder
          row's chevron. The build-facing edge is free on both sides, because `AgentSidebar` anchors
          its own tab at `[pairSide]` — the TERMINAL side — which is the far edge of the build
          column from here.

          So: on the RIGHT pair Build is to our right, and on the LEFT pair `row-reverse` puts it to
          our left. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          [side === "right" ? "right" : "left"]: 0,
          width: 6,
          display: "flex",
          alignItems: "stretch",
        }}
      >
        <ColumnPullTab
          width={Math.min(width, MAX_WIDTH)}
          onWidth={commitWidth}
          min={EPICS_COLUMN_MIN_WIDTH}
          max={MAX_WIDTH}
          label="epics column"
          // `grows` names where the OWNED column sits relative to the boundary, so it follows the
          // edge above: on the RIGHT pair the seam is our right edge and we are LEFT of it; on the
          // LEFT pair the seam is our left edge and we are RIGHT of it.
          //
          // Both resolve to the founder's settled rule — THE ARROW IS ALWAYS OUTBOARD FROM THE
          // CONCIERGE. Right pair: drag right, away from the concierge, to grow. Left pair: drag
          // left, away from the concierge, to grow. The gesture is the same physical motion on both
          // sides of the row, which is what "mirrored exactly" has to mean for a drag.
          grows={side === "right" ? "left" : "right"}
          cssVar={epicsWidthVar(side)}
          // ZOOM-CANCELLED, and it is the SAME expression `AgentSidebar` uses on its own tab — this
          // rail sits inside the element carrying `zoom: columnZoom`, so its painted offset is
          // `(topOffset + TAB_TOP) * Z` while a rail in the ROW is a flat `HEADER_H + TAB_TOP`.
          // At 1× they agree; at 1.2× they separate by 8px and keep going. Solving
          // `(t + TAB_TOP) * Z = HEADER_H + TAB_TOP` for `t` holds the painted position at the row's
          // whatever the text size.
          //
          // NOT `rowGripTop(side)`, which is the ROW rails' offset: that one pushes down by the
          // pair's tab-strip height because those rails start above the strip. This column is
          // INSIDE the pair and already below the strip, so adding it again would push this grip a
          // whole strip lower than the Build grip beside it — the opposite of the alignment the
          // founder settled on.
          topOffset={(HEADER_H + TAB_TOP) / columnZoom - TAB_TOP}
          testId={`epics-pull-tab-${side}`}
        />
      </div>
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "12px 10px",
        color: C.muted,
        fontFamily: FONT_UI,
        fontSize: TYPE.micro,
      }}
    >
      {children}
    </div>
  );
}

/** One epic. The click is the whole point of the column — see `epicFocusBySide` in `uiStore`. */
function EpicRow({
  epic,
  allBeads,
  health,
  selected,
  reveal = false,
  onSelect,
}: {
  epic: Bead;
  allBeads: readonly Bead[];
  /** The square's verdict, or `null` on a terminal rung where no square renders. Passed IN rather
   *  than computed here: the column builds one rollup for every row (see `healthOf`). */
  health: EpicHealth | null;
  selected: boolean;
  /** This row just ARRIVED and the column has expanded its stage for it — bring it on screen. Only
   *  ever true for one row at a time (see `revealEpicId`). */
  reveal?: boolean;
  onSelect: () => void;
}) {
  // Still the RESOLVER's edge, never a local re-derivation — see this file's header and
  // scripts/lib/epic-membership-guard.sh. Only the lookup changed: these are the indexed reads of
  // the same rule, so one epic row costs two map reads instead of two whole-store scans. The row
  // renders once per epic, so on the founder's store this was the difference between 2 x 7,331
  // comparisons per row and 2.
  const epicIndex = epicIndexOf(allBeads);
  const total = childrenOfIndexed(epicIndex, epic.id).length;
  // ══ THE PAIR COUNTS UP TO THE TOTAL, NOT DOWN FROM IT ═══════════════════════════════════════
  // This rendered `{open}/{total}` — REMAINING work over total — and the founder read it as its own
  // opposite: *"I'm not sure I understand what the '14/14' etc numbers mean exactly. […] I would
  // make the assumption that if all of the children are done, then the epic itself is done but for
  // example I see an epic called 'Productized Work Tree Workflow Book Ends' that has a 6/6 on it,
  // and yet it is still in the 'being built' status so I don't understand […] how that's possible."*
  //
  // Nothing was wrong with the epic. `6/6` meant SIX STILL OPEN of six — nothing finished — which is
  // exactly why it had not moved. But a fraction whose numerator SHRINKS as work completes reads as
  // progress running backwards, and `14/14` reads as "all done" at the precise moment none of it is.
  // His ruling: *"flip it so that it builds up to the total versus building down."*
  //
  // Derived as `total - open` rather than by counting closed children directly, so the two halves of
  // the fraction cannot disagree: they come from ONE membership walk, and `openChildCountIndexed`
  // stays the single definition of "still open" (`in_progress` counts as open — bd's only terminal
  // state is `closed`). A second closed-child count here would be a rival definition of done.
  const done = total - openChildCountIndexed(epicIndex, epic.id);

  const rowRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!reveal) return;
    // CALLED DEFENSIVELY, and not for jsdom's benefit — WKWebView is the target and it does have
    // this, but a row can also be unmounted between the state write and the effect. `block:
    // "nearest"` scrolls the ladder only as far as it must, so revealing a Backlog card does not
    // yank a column the founder is already reading.
    rowRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [reveal]);
  return (
    <button
      ref={rowRef}
      data-testid="epic-row"
      data-epic-id={epic.id}
      /* THE REVEAL'S ANCHOR. `data-epic-id` beside it is what the column's own selection reads;
         this one is what the "show me where this sits" lookup resolves against, and they are two
         attributes rather than one because the reveal also has to anchor a STANDALONE task row
         that is not an epic at all. One name for both would make the selector claim something
         about the bead that is not true. */
      data-reveal-id={epic.id}
      data-revealed={reveal ? "true" : undefined}
      data-selected={String(selected)}
      aria-pressed={selected}
      onClick={onSelect}
      title={epic.title}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "baseline",
        gap: 6,
        background: selected ? C.epicCardFill : "transparent",
        border: "none",
        borderLeft: `2px solid ${selected ? C.tealInk : "transparent"}`,
        color: selected ? C.cream : C.muted,
        cursor: "pointer",
        fontFamily: FONT_UI,
        fontSize: TYPE.micro,
        padding: "5px 10px 5px 8px",
        textAlign: "left",
      }}
    >
      {/* ── THE HEALTH SQUARE, LEADING ────────────────────────────────────────────────────────
          FIRST IN THE ROW, before the name, because it is the only thing here meant to be read
          without reading. A leading slot puts every epic's mark in one vertical line down a 280px
          column, so "which of these is nobody building" is answered by scanning an edge rather than
          by reading nineteen titles. The founder's own placements — the count, and the priority
          chiclet "farthest thing on the right" — are all TRAILING, and none of them was asked for
          as a glance surface; this one was ("the statuses should be showing next to the epic
          row").

          NOTHING ELSE MOVES. The slot is `flex: "0 0 auto"` at 9px + the row's 6px gap, so the
          title (already ellipsised at `flex: 1`) truncates 15px sooner and the count and chiclet
          keep their positions exactly.

          NO SLOT IS RESERVED ON A TERMINAL RUNG. `health === null` renders nothing at all rather
          than an empty 9px gutter: Done/Shipped/Archived rows then sit flush left, which is a
          second, free signal that those rungs are not reporting health. Alignment across rungs is
          not worth defending here — the rungs are separate collapsible lists with their own
          headers, never interleaved. */}
      {health !== null && <EpicHealthSquare health={health} />}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {epicDisplayTitle(epic.title)}
      </span>
      {/* ── THE GOAL IS NOT ON THE ROW, AND ITS ABSENCE IS THE FIX ──────────────────────────────
          `EpicGoalRowForEpic` (PR #2244) used to mount here, after the title.
          It is gone, and this comment stands in its place because putting it back would restore a
          bug the founder hit live (`sparkle-huw924.3`).

          WHY IT BROKE THE CLICK. This row is ONE `<button>`, and the goal painted inside it as a
          `role="button"` span that called `stopPropagation()` to open the goal editor. With a goal
          set, that span took `flex: 1 1 auto` and covered most of the row, so most clicks never
          reached the row at all: "instead of opening up the card, it opens up the goal". With no
          goal it was only the words "Set a goal", a target too small to hit often — so the SAME
          defect looked like two different behaviours decided by what data the epic carried.

          WHY REMOVAL RATHER THAN A QUIETER TRIGGER. Asked which he wanted, the founder said "no
          goal should show in the row at all", and the interview says it three times: 02:33 "let's
          not have the goals showing on the build rows", 04:29 "we're not gonna show the goal in the
          row... we should, however, be showing the goal in the epic when it's opened up", 14:13
          "we're not gonna show 'set a goal' on here". The row is the epic's NAME; the goal belongs
          to the opened card.

          THE COMPONENT IS NOT DELETED. `EpicGoalRow` keeps its editor, validation, portal and
          suite, because the card is where it is going next (item 12 of `sparkle-huw924`, bead
          `sparkle-huw924.4`).

          BUT UNTIL THAT LANDS, THE EPIC GOAL IS LIVE STATE WITH NO SURFACE — and that is a wider
          gap than "you cannot edit it" (roborev 66336). The goal is not a readout: it is an INPUT
          TO DISPATCH. `workerSpawn.ladderGoalFor` injects its text into every spawned worker's
          goal, and `sendToBuild.epicGoalLadder` pastes it verbatim into the handoff prompt ("THIS
          TASK LADDERS UP TO EPIC …, whose goal, verbatim, is:"). `conciergeTools/plans.ts`
          auto-generates it at epic creation. So a wrong or stale auto-written goal now steers
          every dispatch under that epic while being readable nowhere in the app, and the only way
          back is asking the concierge to regenerate. THIS ROW IS NOT THE PLACE TO FIX THAT — the
          founder ruled the goal off the row three times — so the fix is to land the card field,
          not to re-mount here.

          IF YOU MOUNT ANYTHING CLICKABLE HERE, read `Workspace.epicsColumn.test.tsx`'s "opens the
          card wherever inside the row the click lands" first. It clicks every descendant of this
          row in turn, so a child that swallows the row's click reds immediately — which is exactly
          what the goal span did. `BeadPriorityChip` below is safe because it is a readout with no
          handler, by its own documented design. */}
      {/* ── THE COUNT SLOT BECOMES THE CLOSE X WHILE THE CARD IS OPEN ────────────────────────────
          Item 15 of the 2026-08-20 self-interview, and the founder placed it by pointing AT this
          slot: [07:51] "let's put the x in the top, where it says the six out of six when it's
          closed. That's where the x would go to close the card out." So it is a SUBSTITUTION —
          collapsed shows the ratio, expanded shows the X — not a second control crowding a 280px
          row.

          ══ IT IS A READOUT WITH NO HANDLER, AND THAT IS THE WHOLE DESIGN ══════════════════════
          This row is ONE `<button>`. A real `<button>` here would be an interactive element nested
          inside an interactive element, and it would have to `stopPropagation()` to avoid
          double-firing — which is EXACTLY the shape that produced the bug the founder hit live,
          where the goal span swallowed the click that was meant to open the card (`sparkle-huw924.3`,
          fixed in PR #2285). Rebuilding that shape to add a close affordance would trade a fixed
          bug for a new one.

          It does not need to be a button. The row's own `onSelect` already TOGGLES, so a click
          anywhere on an open row closes it — including on these pixels. The X therefore has to
          *look* like the close control and do nothing itself; the row underneath it is what acts.
          Same rule `BeadPriorityChip` follows in the slot BELOW this one, and the comment block
          above says why any
          clickable child here reds `Workspace.epicsColumn.test.tsx`'s "opens the card wherever
          inside the row the click lands" — a guard this change deliberately leaves at full
          strength rather than narrowing.

          `aria-hidden` because the button already announces its state through `aria-pressed`:
          a screen reader hears one control that is pressed, not a stray "X" with no role. */}
      {selected ? (
        <span
          data-testid="epic-row-close"
          aria-hidden
          title="Close"
          style={{ flex: "0 0 auto", display: "inline-flex", alignItems: "center", color: C.muted }}
        >
          <FiX size={13} />
        </span>
      ) : (
        total > 0 && (
          <span
            data-testid="epic-row-children"
            // THE NUMBER NOW COUNTS THE RIGHT WAY; THIS SAYS WHAT IT COUNTS. The founder's original
            // complaint was not only the direction — *"I'm not sure I understand what the '14/14'
            // etc numbers mean exactly"* — it was that a bare fraction on a row states nothing at
            // all. Flipping it without saying so leaves the next reader to infer the meaning again.
            title={`${done} of ${total} ${total === 1 ? "task" : "tasks"} done`}
            style={{ flex: "0 0 auto", color: C.muted }}
          >
            {done}/{total}
          </span>
        )
      )}
      {/* ── THE PRIORITY CHICLET IS THE LAST THING IN THE ROW, AND IT IS PINNED THERE ────────────
          THIS SUPERSEDES ITEM 8 of `sparkle-huw924`, which put the chiclet to the LEFT of the count
          ("a little priority chicklet pill to the right of the epic name, before the count like,
          the 9/10"). The founder changed his mind after seeing it (`sparkle-5izbbz`): *"The
          priority pills need to be to the right of the '9/13' etc, not to the left"*, then *"The
          pills should be the farthest thing on the right. For that column."* Nothing above this
          line describes the old order any more; if you are re-reading item 8, this bead outranks it.

          ══ IT IS RIGHT-ALIGNED, NOT MERELY REORDERED — THAT IS THE WHOLE BEAD ══════════════════
          `total > 0` means MANY ROWS CARRY NO COUNT AT ALL, and the founder's screenshot is full of
          them (an epic with no children renders a chiclet and nothing else). Swapping two siblings
          satisfies the with-count rows and leaves the without-count rows sitting wherever the flow
          happens to end — which is the case he could already see on screen. So the pin is
          `marginLeft: "auto"` on this wrapper: the slot eats every pixel of free space to its left,
          so the chiclet lands on the column's right edge on EVERY row, with a count, without one,
          and whatever the title's own flex is later changed to. Do not replace it with a plain
          reorder that "looks the same" — it only looks the same on the rows that have a count.

          THE WRAPPER EXISTS BECAUSE THE CHIP TAKES NO `style`. `BeadPriorityChip` owns its own
          treatment by design (see its header), so the alignment lives on a slot around it rather
          than being threaded through as a prop no other call site wants.

          IT SITS AFTER THE COUNT SLOT, WHICH INCLUDES THE OPEN ROW'S X. Item 15 put the close X
          *in the count slot* ("where it says the six out of six when it's closed"), which is a
          statement about that slot, not about the row's right edge — so the X keeps its slot and
          the chiclet stays farthest right whether the row is open or closed. One rule, no branch.

          A CHICLET, NOT A CAPSULE. `BeadPriorityChip` is built on `tag()` at `RADIUS.sm` — a
          near-square corner, and the 999-radius capsule is the thing this codebase purged. Do not
          override the radius to round it off.

          THE LITERAL IS SPELLED AROUND ON PURPOSE. `labelTreatment.test.ts` ratchets the tree-wide
          count of that literal and skips comment lines by testing whether the line STARTS with
          `//`, `/*` or `*` — which a JSX block comment's continuation lines do not. So writing the
          literal in prose here counts as a USE and reddens the ratchet on an unrelated PR, which is
          exactly what it did on the PR that introduced this chiclet.

          IT SITS INSIDE THE ROW'S `alignItems: "baseline"`, which is correct rather than tolerated:
          an inline-flex box takes the baseline of its first line, so the chip's rendered level sits
          on the same baseline as the title beside it. Its 6px dot is centred within the chip, not
          against the row, so it does not drag the alignment — and the wrapper is `inline-flex` for
          the same reason, so it forwards the chip's baseline rather than inventing one.

          IT IS `flex: "0 0 auto"`, so its ~28px comes permanently out of the title's width — the
          title is already ellipsised at `flex: 1` in a 280px column, so a long epic name truncates
          slightly sooner. That is the trade the founder asked for. */}
      <span
        data-testid="epic-row-priority-slot"
        style={{ flex: "0 0 auto", display: "inline-flex", marginLeft: "auto" }}
      >
        <BeadPriorityChip priority={epic.priority} testId="epic-row-priority" />
      </span>
    </button>
  );
}
