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
import { FiChevronDown, FiChevronRight } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../theme/colors";
import { FONT_UI, TYPE } from "../theme/scale";
import { ZOOM_COLUMN_ATTR, zoomColumnFor } from "../engine/columnZoom";
import { PAIR_COLUMN_ATTR } from "../engine/pairColumns";
import { ColumnPullTab, HEADER_H, TAB_TOP } from "./ColumnPullTab";
import { EpicGoalRowForEpic } from "./EpicGoalRow";
import { HeaderLink } from "./HeaderLink";
import { EpicInlineCard } from "./EpicInlineCard";
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
 *  collapsed — those are history, and they are the piles that actually grow without bound. */
const OPEN_BY_DEFAULT: ReadonlySet<EpicLadderKey> = new Set<EpicLadderKey>([
  "backlog",
  "blocked",
  "planning",
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
  const ladder = useMemo(
    () => (board ? bucketEpics(board, allBeads) : null),
    [board, allBeads],
  );

  // ── SELECTION ────────────────────────────────────────────────────────────────────────────────
  const focusedEpicId = useUiStore((s) => s.epicFocusBySide[side]);
  const setEpicFocus = useUiStore((s) => s.setEpicFocus);
  const openPlanBoard = useUiStore((s) => s.openPlanBoard);

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
        <span>Epics</span>
        {/* THE RIGHT SLOT IS A GROUP NOW, not a single conditional child. The row is
            `space-between`, so with only two children "right-aligned" was emergent — a third child
            would have parked `Clear` in the MIDDLE of the header. Wrapping the controls keeps the
            title at one end and every control at the other however many there are. */}
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
      </div>

      {/* CLEARANCE FOR THE SEAM, on whichever side it is on. The pull tab is an absolute child at
          this column's build-facing edge, and the stage counts are flush to that same edge — so
          without this the grip lands on top of the first two counts. Keyed off `side` rather than
          padded on both, because the seam mirrors with the row and symmetric padding would waste
          6px of a 280px column on the side that has no tab. */}
      <div
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
                          onClose={() => setEpicFocus(side, null)}
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
  selected,
  reveal = false,
  onSelect,
}: {
  epic: Bead;
  allBeads: readonly Bead[];
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
  const open = openChildCountIndexed(epicIndex, epic.id);

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
      <EpicGoalRowForEpic epicId={epic.id} beads={allBeads} />
      {total > 0 && (
        <span data-testid="epic-row-children" style={{ flex: "0 0 auto", color: C.muted }}>
          {open}/{total}
        </span>
      )}
    </button>
  );
}
