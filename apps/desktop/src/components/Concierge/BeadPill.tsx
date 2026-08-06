// The pill a BEAD ID draws as, and the card it opens in place. The founder's ask, verbatim: "I want
// to make the beads clickable in the concierge window… it just opens the card up. And then if
// there's a spot on the card where I can click to view it on the board, it opens up the whole plan
// board." (bead sparkle-t6wje.)
//
// The sibling of `AgentPill`, and built to the same three rules, because the founder's standing ask
// for mentions was that they be SYMMETRICAL — what the concierge names should read as one
// vocabulary whether it is an agent or a unit of work:
//
//   1. IT RE-READS LIVE STATE ON EVERY RENDER. Never a snapshot. See below — this is the bead's
//      fourth requirement and the single easiest thing to get wrong.
//   2. EVERY CLICK PRODUCES A VISIBLE RESULT. A reference that cannot do anything is not a control;
//      it is prose, and it renders as prose. `AgentPill.deadEnd.test.tsx` exists to forbid the
//      alternative and this component is held to it.
//   3. INLINE ELEMENTS ONLY. This renders inside `<Markdown>`, i.e. inside a `<p>`, where a `<div>`
//      is invalid nesting that React emits happily and the browser silently reparents — moving the
//      card out of the paragraph that explains it.
//
// ══ WHY A CANDIDATE THAT DOES NOT RESOLVE IS PLAIN TEXT ═════════════════════════════════════════
// The bead is explicit that an id which does not exist must not be linkified, "since a link that
// opens nothing is worse than plain text". The linkifier upstream (`remarkBeadRefs`) deliberately
// does NOT make that test — it cannot, being a parse-time pass inside a `memo`ized renderer — so it
// is made HERE, against the live store, on every render.
//
// That split is what makes the two halves of the requirement true at once. A bare `auto-heal` in
// prose is id-SHAPED, arrives here as a candidate, misses the map, and renders as the two words it
// always was. A bead filed five minutes after the message was written starts resolving on the next
// poll, without the message being re-parsed. Neither behaviour is expressible if existence is
// decided while the text is being read.
//
// ══ WHY THE LIVE STATE TRAVELS BY CONTEXT ═══════════════════════════════════════════════════════
// The same reason `AgentPill` gives, and it is worth not re-deriving: `<Markdown>` is `memo`ized on
// `text` ALONE because ReactMarkdown re-parses the entire string on every render and a concierge
// reply streams in token by token. Handing it a bead list or a click handler would defeat that memo
// on every render, turning a streaming reply into O(bubbles × tokens) markdown parses.
//
// `React.memo` blocks re-render from PROPS. It does not block a context update from reaching a
// consumer inside the memoized subtree. So the board travels by context, the memo stays intact, and
// a pill — AND AN ALREADY-OPEN CARD — repaints the instant the bead's status changes.
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { C } from "../../theme/colors";
import { MD_CODE_FACE } from "../mdCodeFace";
import { MENTION_PILL_FILL } from "./MentionPill";
import { sideOf } from "../../engine/pairs";
import { BEADS_CROSS_PROJECT_REFRESH_MS, useBeadsStore } from "../../stores/beadsStore";
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { DELIVERED_LABEL, type Bead } from "../../services/beads";
import { beadStage, workersForBead } from "../../services/planView";
import type { WorkflowStageId } from "../../engine/workflowStage";
import type { AgentTab } from "../../types";
import { BeadCard } from "../BeadCard/BeadCard";
import { setBeadPriority } from "../BeadCard/beadPriority";
import { beadCardMenuIsOpen } from "../BeadCard/PriorityPill";
import { statusDot, statusLabel } from "../BeadCard/beadStatus";
import { useBeadBuildActions } from "../BeadCard/useBeadBuildActions";

/** A resolved bead, and WHICH PROJECT'S board holds it. The project id is not decoration: the
 *  concierge is cross-project by construction ("the concierge is not any project at all",
 *  ConciergeColumn), so the board a bead opens on cannot be inferred from the column. */
export interface ResolvedBead {
  bead: Bead;
  projectId: string;
  /**
   * The project's checkout root — the path every WRITE needs.
   *
   * ══ WHY IT TRAVELS WITH THE BEAD RATHER THAN BEING LOOKED UP ═══════════════════════════════
   * The card can now change a bead's priority and hand it to the Build orchestrator, and both go
   * through `bd`, which is addressed by PATH. `BeadPillHost` has the selected project's id but the
   * card may be showing a bead from a DIFFERENT project entirely (see `projectName`) — so a lookup
   * at the point of use would have to re-derive which project the bead came from, which is exactly
   * the question `indexBeads` has already answered.
   *
   * OPTIONAL, and its absence is what makes a surface READ-ONLY. A `BeadPillProvider` handed a
   * fixture (a support modal, an agent reply, a test) supplies no paths, so its cards render
   * without the priority control and without Build It rather than with controls that cannot work.
   */
  rootPath?: string;
  /**
   * The project's name, set ONLY when the bead lives outside the SELECTED project.
   *
   * ══ WHY THIS IS ON THE CARD AND NOT ON THE PILL ═════════════════════════════════════════════
   * The pill cannot carry it. An unresolved candidate is deliberately indistinguishable from
   * ordinary hyphenated English, so there is no "this one is elsewhere" state to render before a
   * bead resolves — the component does not know the token is an id at all. Only a bead that HAS
   * resolved can say where it lives, and by then the card is the surface.
   *
   * ══ WHY IT IS WORTH SAYING AT ALL ═══════════════════════════════════════════════════════════
   * `viewOnBoard` below calls `selectProject` before opening the board, so "View on board" on a
   * bead from another project SWITCHES the reader's whole selected project. That is the right
   * behaviour — the board is per-side and would otherwise never contain the bead — but it is a
   * large, silent jump to make on an unannounced click. Naming the project turns it into a
   * choice.
   *
   * OPTIONAL, and absence means "same project as the reader's" rather than "unknown": a surface
   * that supplies no names (a test fixture, `SupportModal`) simply shows no line, which is the
   * same thing it showed before.
   */
  projectName?: string;
}

export interface BeadPillContextValue {
  /** The live board, indexed. A MAP rather than the array `BoardView` linear-scans: a concierge
   *  answer can name a dozen beads and the thread holds many answers, so an O(n) scan per pill per
   *  render is the shape that gets slow quietly. Empty means "nothing resolves", which is the
   *  correct default — a surface that has not opted in renders every id as the prose it was. */
  beads: ReadonlyMap<string, ResolvedBead>;
  /** Open the Plan board focused on this bead, and report whether it LANDED.
   *
   *  THE RETURN VALUE IS THE CONTRACT: `false` means the board could not be focused on this bead,
   *  and the card turns that into a sentence rather than leaving the reader looking at an unchanged
   *  screen. Stated in its own terms rather than by reference to
   *  `AgentPillContextValue.onOpenAgent`, which it used to point at and which no longer returns a
   *  boolean at all.
   *
   *  IT CARRIES THE SAME UNCLOSED GAP THAT POINTER USED TO SHARE, and it is worth knowing about
   *  before trusting this value: `true` here means the OPEN RAN, not that anything moved. A board
   *  already focused on this bead reports success and the card says nothing, which is exactly the
   *  invisible click `AgentPillContextValue.onOpenAgent` grew a three-way `RevealOutcome` to fix
   *  (bead sparkle-ixsb3 / roborev 58643). Deliberately NOT changed here — the board path has its
   *  own reveal semantics and no reported bug — but a `RevealOutcome` is the shape it wants.
   *
   *  AN OBJECT, NOT TWO POSITIONAL STRINGS (roborev 54894). Both fields are `string`, so a swapped
   *  pair typechecks cleanly and its only symptom is a board that focuses nothing.
   *
   *  OPTIONAL. Its absence means "this surface has no board to open", which is a fact about the
   *  surface — the card still opens and still shows the bead, it simply offers no second step. That
   *  is not a dead end: the click already produced the card. */
  onViewOnBoard?: (target: { beadId: string; projectId: string }) => boolean;
}

/** One project the reader is NOT currently in: `[id, rootPath, name]`. The sweep needs the first
 *  two, the card needs the third, and carrying them as one tuple is what keeps "which projects are
 *  foreign" from being answered twice and differently. */
type ForeignProject = [string, string, string];

/** A STABLE empty default — a module const, not an inline literal, so every `<Markdown>` outside the
 *  concierge column (SupportModal, agent replies) shares one identity and never re-renders on it. */
const EMPTY_BEADS: ReadonlyMap<string, ResolvedBead> = new Map();
const EMPTY: BeadPillContextValue = { beads: EMPTY_BEADS };

const BeadPillContext = createContext<BeadPillContextValue>(EMPTY);

/** Supplies the live board to every pill below it. The raw provider, mirroring `AgentPillProvider`
 *  — `BeadPillHost` below is what production mounts; this is what a test hands a fixture to. */
export const BeadPillProvider = BeadPillContext.Provider;

// ── THE HOST ────────────────────────────────────────────────────────────────────────────────────

/**
 * Wires the live beads store to every pill in the thread, and keeps it polling.
 *
 * ══ IT STARTS THE POLLER ITSELF, AND IT HAS TO ══════════════════════════════════════════════════
 * `beadsStore` is polled by exactly one component today — `BoardView`, on mount. So before this
 * host existed, a bead id could only resolve while a Plan board happened to be open, which is
 * precisely the situation the founder is NOT in when he reads a bead id in the concierge and wants
 * to know what it says. Without this the feature would be dead text most of the time and nobody
 * would be able to say why.
 *
 * `startPolling` is reference-counted (see the store), so this co-exists with a `BoardView` on the
 * same project instead of racing it: whichever unmounts second stops the timer. That counting was
 * added for this and fixes a latent bug it did not cause — two boards on one project (a project can
 * be shown in both pairs) already had the first board's poller killed by the second board's unmount.
 *
 * ══ WHICH PROJECT — EVERY ONE OF THEM, AT TWO DIFFERENT SPEEDS ══════════════════════════════════
 * The SELECTED project is polled at the board's own cadence: it is the project the founder is
 * working in and the one whose ids the concierge is overwhelmingly writing, so its bead statuses
 * stay live to the second.
 *
 * EVERY OTHER REGISTERED PROJECT is swept on the much slower `BEADS_CROSS_PROJECT_REFRESH_MS`, and
 * that sweep is the fix for a bug that made this feature look broken to the founder rather than
 * incomplete. `indexBeads` below has always spanned every project in `byProject`, so the LOOKUP was
 * never single-project — but `byProject` only ever holds projects something is actively polling,
 * and until the sweep the only passive poller was this host on the selected project. A bead id the
 * concierge wrote for any other project therefore missed the index and rendered as dead prose.
 *
 * That failure was INVISIBLE by construction, which is why it survived. An id that does not resolve
 * is deliberately indistinguishable from the ordinary hyphenated English the loose pattern also
 * matches ("auto-heal", "one-shot"), so the pill cannot announce "this one lives in another
 * project" — it does not know the token is a bead id at all. There is no degraded state to notice.
 * The only place the difference can be made visible is on a bead that HAS resolved, which is what
 * the card's project line does. So the fix has to be resolution, not a better error.
 *
 * The sweep reads and never writes: no decompose watcher (nobody is viewing those boards) and no
 * auto-init (creating a `.beads/` store in every repo the user ever registered is not something a
 * concierge render should do). See `refresh`'s `allowAutoInit`.
 */
export function BeadPillHost({ children }: { children: ReactNode }) {
  const byProject = useBeadsStore((s) => s.byProject);
  const project = useProjectStore((s) =>
    s.selectedProjectId === null ? null : (s.projects.find((p) => p.id === s.selectedProjectId) ?? null),
  );
  const projectId = project?.id;
  const rootPath = project?.rootPath;

  // A DEPENDENCY, NOT A READ. `startPolling` refuses to arm a timer while beads are off, and it is
  // the SETTING that changes, not this component's props — so without `beadsEnabled` in the deps
  // below, a host that mounted while `[tools].beads` was off would never re-arm when the user
  // switched it on, and every bead id would stay unresolved until some other viewer happened to
  // start polling (roborev 57672). Re-running the effect is balanced: the cleanup releases the old
  // claim before the new one is taken.
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);

  /**
   * Every project EXCEPT the selected one, flattened to a string.
   *
   * A STRING RATHER THAN AN ARRAY, because this is an effect dependency. A selector returning a
   * fresh `Project[]` (or even a fresh array of ids) is a new reference on every projectStore write
   * — and projectStore is written constantly, by agent status ticks — so the sweep effect would tear
   * down and re-arm its interval several times a second, re-firing the immediate sweep each time.
   * That turns a 30-second read into a hot loop of `bd` subprocesses. Comparing a string means the
   * effect re-runs only when the SET of projects (or the selection) genuinely changes.
   */
  const others = useProjectStore((s) =>
    JSON.stringify(
      s.projects
        .filter((p) => p.id !== s.selectedProjectId && p.rootPath !== "")
        // The NAME rides along because the card needs it (see `ResolvedBead.projectName`) and
        // deriving both from one string keeps the sweep and the index from disagreeing about which
        // projects count as foreign. Annotated as a TUPLE rather than inferred: without it the
        // elements widen to `string | undefined` under `noUncheckedIndexedAccess` and the sort below
        // cannot compare them.
        .map((p): ForeignProject => [p.id, p.rootPath, p.name])
        // SORTED, so two stores holding the same projects in a different order compare EQUAL and
        // the effect does not re-arm on a reorder that changes nothing about what to read.
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    ),
  );

  // THE CROSS-PROJECT SWEEP — see this component's header for why it exists.
  //
  // Deliberately NOT `startPolling`. That path keeps ONE timer per project and the first claimant's
  // interval wins, so a slow claim here would pin a project a `BoardView` later opens to this
  // interval instead of the board's — a silent downgrade of someone else's live board. Calling
  // `refresh` directly avoids the shared timer entirely, and `refresh`'s own in-flight guard already
  // makes an overlapping board poll safe (the later call is coalesced, not stacked).
  useEffect(() => {
    if (!beadsEnabled) return;
    const targets = JSON.parse(others) as ForeignProject[];
    if (targets.length === 0) return;
    // A one-shot `visibilitychange` re-arm, mirroring the store's own `armVisibilityRefresh`.
    //
    // The first version of this skipped a hidden tick and simply waited for the next interval, on
    // the reasoning that a stale cross-project snapshot "shows nothing wrong on screen". That was
    // wrong about the symptom: an unswept project's ids are not stale, they are DEAD PROSE — the
    // exact bug this whole change exists to fix, reappearing for up to a full interval every time
    // the founder comes back to the app. Staleness is invisible; a dead id is the complaint.
    let onVisible: (() => void) | null = null;
    const disarm = () => {
      if (onVisible !== null && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
      onVisible = null;
    };
    const armVisible = () => {
      if (typeof document === "undefined" || onVisible !== null) return;
      onVisible = () => {
        // Also fires on visible→hidden; only the return trip is interesting.
        if (document.visibilityState !== "visible") return;
        disarm();
        sweep();
      };
      document.addEventListener("visibilitychange", onVisible);
    };
    const sweep = () => {
      // Same gate the poll interval uses: don't shell out for a window nobody is looking at — but
      // arm the re-entry above so the wait ends when the reader returns, not when the timer says so.
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        armVisible();
        return;
      }
      const now = Date.now();
      const loaded = useBeadsStore.getState().byProject;
      for (const [id, path] of targets) {
        // ══ FRESHNESS, NOT EFFECT IDENTITY, DECIDES WHETHER TO SHELL OUT ═══════════════════════
        // `others` filters on `selectedProjectId`, so it changes on EVERY selection change and
        // re-arms this effect — which re-fires the immediate sweep below for all N−1 remaining
        // projects, including the N−2 that were read seconds ago and did not change. Clicking
        // through the project strip (or any "View on board", which calls `selectProject`) would
        // otherwise produce back-to-back convoys of `bd` subprocesses against the shared store —
        // exactly the load the 6× interval was chosen to avoid. `refresh`'s in-flight guard does
        // not cover this: it coalesces CONCURRENT calls for one project, not back-to-back ones.
        const at = loaded[id]?.loadedAt;
        if (at !== undefined && now - at < BEADS_CROSS_PROJECT_REFRESH_MS) continue;
        // `false, false` — no watchers, no auto-init. Both are WRITES (one spends AI and files
        // child beads, the other creates a `.beads/` store in the user's repo), and nobody asked a
        // concierge render to write anything.
        void useBeadsStore.getState().refresh(id, path, false, false);
      }
    };
    // Immediately, so an id resolves on the first render the founder actually reads rather than up
    // to a full interval later.
    sweep();
    const timer = setInterval(sweep, BEADS_CROSS_PROJECT_REFRESH_MS);
    return () => {
      clearInterval(timer);
      disarm();
    };
  }, [others, beadsEnabled]);

  useEffect(() => {
    if (projectId === undefined || rootPath === undefined) return;
    // "passive", NOT the default "board". This host is mounted for the whole app session (the
    // concierge always is), and a board-kind claim would leave `runDecomposeWatcherForPoll` — which
    // WRITES beads and reaches the AI gate — running permanently in the background instead of only
    // while someone is looking at a board (roborev 57655). The claim still keeps ids resolving; it
    // just does not vote for the watcher. Released with the SAME kind, or the tally drifts.
    useBeadsStore.getState().startPolling(projectId, rootPath, undefined, "passive");
    return () => useBeadsStore.getState().stopPolling(projectId, "passive");
  }, [projectId, rootPath, beadsEnabled]);

  // `others` rather than the `projects` array, for the reason its own docstring gives: an array
  // dependency here would rebuild the whole index on every agent status tick.
  // THE INDEX IS DERIVED FROM WHAT IS REGISTERED NOW, not from whatever the store still holds.
  //
  // `byProject` is a CACHE and nothing prunes it: removing a project only touches `projectStore`,
  // and switching `[tools].beads` off stops the pollers rather than clearing snapshots (the clear
  // in `refresh` only reaches projects that get another call, and with beads off none do). Indexing
  // it raw therefore outlives both events — a pill for a project that no longer exists, or beads
  // still resolving after the user turned beads off. Narrowing here fixes both without a new
  // clearing path, and it cannot go stale because it is recomputed from the live stores.
  const value = useMemo<BeadPillContextValue>(
    () => ({
      beads: beadsEnabled
        ? indexBeads(byProject, foreignProjects(others), projectId, rootPath)
        : EMPTY_BEADS,
      onViewOnBoard: viewOnBoard,
    }),
    [byProject, others, projectId, rootPath, beadsEnabled],
  );
  return <BeadPillProvider value={value}>{children}</BeadPillProvider>;
}

/**
 * Every bead in every loaded project, indexed by id.
 *
 * ══ THE READER'S OWN PROJECT IS INDEXED FIRST, AND THAT IS NOT A TIE-BREAK NICETY ═══════════════
 * The rule used to be "first project wins", justified by ids carrying a project prefix so a
 * collision was unreachable. The cross-project sweep RETIRED that premise, and the collision it
 * opens is not exotic: `bd` resolves `.beads/` through `git-common-dir`, so a worktree of a repo
 * registered as its own project reads THE SAME DATABASE as the repo. Every id then collides, and
 * which side won depended on refresh ORDER — with the sweep dispatched before the passive poll, the
 * foreign copy usually landed first.
 *
 * The visible damage was on the reader's own beads: the card would show another project's snapshot,
 * label it `in <other>`, and — worst — "View on board" would `selectProject` away from the project
 * the reader was already in, for a bead that lives right there. Seeding from the selected project
 * makes the winner a property of WHOSE BEAD IT IS rather than of which `bd` call returned first.
 */
function indexBeads(
  byProject: Record<string, { beads: Bead[] } | undefined>,
  /** The projects that are registered but NOT selected. Doubles as the membership test that keeps
   *  a removed project's cached snapshot out of the index, and as the source of `projectName`. */
  foreign: readonly ForeignProject[],
  /** The selected project, indexed before all others. `undefined` when nothing is selected, in
   *  which case there is no "reader's own" to prefer and insertion order decides as before. */
  selectedProjectId: string | undefined,
  /** The SELECTED project's checkout root. The foreign projects carry their own in the tuple; this
   *  is the one the tuple list deliberately excludes. */
  selectedRootPath: string | undefined,
): ReadonlyMap<string, ResolvedBead> {
  const out = new Map<string, ResolvedBead>();
  const names = new Map(foreign.map(([id, , name]) => [id, name]));
  const roots = new Map(foreign.map(([id, root]) => [id, root]));
  if (selectedProjectId !== undefined && selectedRootPath !== undefined) {
    roots.set(selectedProjectId, selectedRootPath);
  }
  // The selected project FIRST, then every other registered one. Anything still sitting in
  // `byProject` that is no longer registered is simply not visited.
  const ordered = [
    ...(selectedProjectId === undefined ? [] : [selectedProjectId]),
    ...foreign.map(([id]) => id),
  ];
  for (const projectId of ordered) {
    const name = names.get(projectId);
    // Empty string is treated as "no name to show" rather than rendering `in ` with nothing after.
    const projectName = name === undefined || name === "" ? undefined : name;
    // Same reading for the path: an empty root cannot address `bd`, so it is an ABSENT path rather
    // than a path that happens to be "" — which would render write controls that fail on every use.
    const root = roots.get(projectId);
    const rootPath = root === undefined || root === "" ? undefined : root;
    for (const bead of byProject[projectId]?.beads ?? []) {
      if (!out.has(bead.id)) out.set(bead.id, { bead, projectId, projectName, rootPath });
    }
  }
  return out;
}

/** The `others` string, read back. Parsed rather than threaded as a second selector so there is
 *  exactly one definition of "which projects are foreign". */
function foreignProjects(others: string): readonly ForeignProject[] {
  return JSON.parse(others) as ForeignProject[];
}

/**
 * Open the Plan board on the bead's own side, focused on the card.
 *
 * ══ THE ORDER IS LOAD-BEARING ═══════════════════════════════════════════════════════════════════
 * `openPlanBoard` FIRST, `setBoardFocusBeadId` SECOND. The focus id is a ONE-SHOT that `BoardView`
 * consumes and clears once the bead is present; set against a board the Sparkle pane is still
 * covering, the handoff is spent on a surface that never renders and the overlay simply never opens
 * (roborev 55887, the same trap the sidebar's epic pill documents).
 *
 * `openPlanBoard`, never a bare `setWorkMode(side, "plan")` — the latter only moves the chevron and
 * leaves the board invisible, which is the identical failure by a different route.
 *
 * ══ WHICH SIDE, AND WHY IT IS DERIVED RATHER THAN PICKED ════════════════════════════════════════
 * This is the real design question in the handoff, and it is worth naming: `boardFocusBeadId` is
 * GLOBAL while its sibling `boardAgentFilterBySide` is keyed by side, and the concierge column has
 * no natural `PairSide` at all — it sits BETWEEN the two pairs and belongs to neither.
 *
 * So the side is not chosen; it is READ from where the bead's project already lives.
 * `sideOf(pairAssignment, projectId)` is total and defaults to `"right"` (the historical single-pair
 * home), so every install answers, including one that has never assigned anything. That beats a
 * hard-coded side on the case that actually matters — a two-pair cockpit, where a fixed choice
 * would open the board in the wrong half of the screen for exactly the projects the second pair
 * exists to hold.
 *
 * The bead's project is also SELECTED first. The board is per-side and shows that side's current
 * project, so focusing a bead in a project the side is not displaying would open a board that never
 * contains it — the handoff would sit unconsumed and the click would look like it did nothing.
 */
function viewOnBoard(target: { beadId: string; projectId: string }): boolean {
  const projects = useProjectStore.getState();
  // Nothing to open a board FOR. Reported rather than assumed: the caller turns `false` into a
  // sentence, which is the whole point of the boolean.
  if (!projects.projects.some((p) => p.id === target.projectId)) return false;
  projects.selectProject(target.projectId);
  const ui = useUiStore.getState();
  ui.openPlanBoard(sideOf(ui.pairAssignment, target.projectId));
  ui.setBoardFocusBeadId(target.beadId);
  return true;
}

// ── PRESENTATION ────────────────────────────────────────────────────────────────────────────────

/** The shared shape, so the pill and its card differ only where they must. Mirrors `AgentPill`'s
 *  `base` — same radius, same padding, same baseline alignment — because a bead reference and an
 *  agent reference sitting in one sentence must read as one vocabulary. */
const base: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  borderRadius: 4,
  padding: "1px 5px",
  // A pill broken across two lines stops reading as one object.
  whiteSpace: "nowrap",
  fontSize: "inherit",
  fontFamily: "inherit",
  lineHeight: "inherit",
  verticalAlign: "baseline",
};

// `statusColor` / `statusLabel` / `statusDot` MOVED to `BeadCard/beadStatus.ts` when the card
// became shared. They were duplicated by construction the moment a second surface drew a bead, and
// the pill and the card it opens must not be able to disagree about what "closed" looks like.

/** How much description the card shows before it scrolls instead of growing.
 *
 *  THE BEAD NAMES THIS AS A REQUIREMENT — "beads carry long descriptions, so the card needs to
 *  handle that without swallowing the conversation". A bead description runs to several screens
 *  (this one does), and a card that grows to fit pushes the sentence the reader was reading off the
 *  top of the thread, which is the context switch the whole feature exists to avoid. */
const DESC_MAX_H = 180;

/** What the card says when the board could not be opened. One sentence, non-alarming, and it names
 *  the bead — a paragraph can hold several cards. Matches `AgentPill`'s `closedSentence` in shape so
 *  the app says this kind of thing one way. */
const noBoardSentence = (beadId: string) => `${beadId} is not on an open board.`;

/**
 * One bead reference.
 *
 * `beadId` is what the linkifier found (or what an explicit `sparkle-bead:` reference carried). The
 * label the author wrote is deliberately NOT used: a pill shows the id, always.
 *
 * That is the opposite of `AgentPill`, which prefers the live roster NAME over the written label,
 * and the asymmetry is deliberate rather than an oversight. An agent's name is what a human calls
 * it and the id is an internal uuid nobody reads; a bead's id is what the FOUNDER types, greps,
 * and asks other agents about — it is the readable handle, and the title is on the card one click
 * away. It also closes a small forgery seam for free: model-authored text can contain
 * `[something reassuring](sparkle-bead:sparkle-17hm1)`, and since the pill renders the id and the
 * live status rather than the label, a misleading label buys nothing.
 */
export function BeadPill({ beadId }: { beadId: string }) {
  const { beads, onViewOnBoard } = useContext(BeadPillContext);
  const [open, setOpen] = useState(false);
  // Consecutive FAILED board opens. A COUNT rather than a boolean for the reason `AgentPill`
  // documents (roborev 55590): setting `true` on an already-`true` state is an identical-value
  // update, React bails out, and the reader's retry click paints and announces nothing.
  const [misses, setMisses] = useState(0);
  const cardId = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);

  // ── ESCAPE AND CLICK-OUTSIDE CLOSE THE CARD ─────────────────────────────────────────────────
  //
  // ══ THE DEAD END THIS CLOSES ═══════════════════════════════════════════════════════════════
  // The only way out of an open card used to be clicking the SAME pill again — which the founder
  // called "a dead end nobody discovers", and he is right: nothing on screen says the pill is still
  // the exit, and by the time a card has scrolled a paragraph the pill is off screen. Every other
  // popover in this app closes on Escape and on a press outside itself, and a bead card is not
  // special enough to be the exception.
  //
  // Built to `AgentInboxBadge`'s template, including the two subtleties that template exists for:
  //
  //   * REGISTERED ONLY WHILE OPEN. A concierge thread can hold dozens of pills, and a permanent
  //     listener each would be a real cost for a card nobody has opened.
  //   * THE ANCHOR-CONTAINS GUARD. The pill's own click toggles the card; without this the
  //     capture-phase mousedown would ALSO see that press, close the card, and the toggle would
  //     immediately reopen it — one gesture, no visible response.
  //
  // A THIRD GUARD IS NEW HERE, and it is the one the template could not have: the card's priority
  // menu PORTALS to `document.body`, so a press on a menu row is, in DOM ancestry, outside this
  // card. Without `beadCardMenuIsOpen()` picking a priority would close the card underneath the
  // click, and Escape — whose listener this component registered FIRST, since the card opened
  // first — would close the card instead of peeling the menu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Cable etiquette: honour a prior consumer, then consume, so one press peels one layer.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (beadCardMenuIsOpen()) return; // the menu is the innermost layer; let it take this press
      e.preventDefault();
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t === null) return;
      if (anchorRef.current?.contains(t) === true) return;
      const el = t instanceof Element ? t : t.parentElement;
      if (el?.closest(`[data-testid="${CARD_TESTID}"]`) != null) return;
      if (beadCardMenuIsOpen() && el?.closest("[data-bead-card-menu]") != null) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [open]);

  // RE-READ EVERY RENDER — the bead's fourth requirement, and the whole of its implementation. There
  // is deliberately no `useState`/`useRef` holding a bead anywhere in this component: a bead cited
  // as open an hour ago and since closed shows CLOSED, in the pill's dot and in an already-open
  // card alike, because both read from here rather than from anything captured at click time.
  const resolved = beads.get(beadId);

  // ── IT DOES NOT RESOLVE ───────────────────────────────────────────────────────────────────────
  // Ordinary text, with no wrapper element at all. Not a muted span, not a `title` tooltip, not a
  // button that explains itself — the id was prose before this feature and it stays prose, which is
  // the bead's own requirement ("it must not linkify an id that does not exist").
  //
  // THIS IS THE COMMON CASE, not an edge one, and that is why it is written first: the linkifier
  // buys recall on purpose and hands this component every id-SHAPED token in the thread, so most of
  // what arrives here is an ordinary hyphenated word like "auto-heal" that must come out unchanged.
  if (resolved === undefined) return <>{beadId}</>;

  const { bead } = resolved;
  const showMiss = misses > 0;

  return (
    <span style={{ display: "inline" }}>
      <button
        ref={anchorRef}
        type="button"
        data-testid="concierge-bead-pill"
        data-bead-id={bead.id}
        data-bead-status={bead.status}
        // A GENUINE DISCLOSURE — the click toggles the card open and shut and nothing is attempted —
        // so `aria-expanded` describes it correctly. (`AgentPill`'s resolved pill deliberately omits
        // it because that one is a RETRY, which can never collapse.)
        aria-expanded={open}
        aria-controls={cardId}
        title={`${bead.id} · ${bead.title || "untitled"} — ${statusLabel(bead.status)}`}
        onClick={() => setOpen((v) => !v)}
        style={{
          ...base,
          border: "none",
          cursor: "pointer",
          // The mention vocabulary's fill, from the constant rather than re-spelled. A fourth
          // hand-copied `color-mix(… teal 18% …)` is exactly the drift `MentionPill`'s header was
          // written to stop, and a shade of difference between a bead pill and an agent pill in the
          // same sentence fails no test while breaking the founder's "make mentions symmetrical" ask.
          background: MENTION_PILL_FILL,
          color: C.cream,
          // A bead id is an identifier the founder greps for, so it is set in the mono face. The
          // SIZE stays `inherit` (from `base`): an `em`-relative nudge here is off-scale sprawl, and
          // theme/scale.test.ts ratchets exactly that — there is no scale step between body and
          // small, so a pill mid-sentence takes the sentence's own size or a TYPE value, never a
          // fraction of one.
          //
          // WHICH mono is the surface's decision, not this pill's — the same argument the size
          // comment above makes, applied to the face. A hardcoded `FONT_MONO` here paints SF Mono
          // mid-sentence inside the mounted concierge thread, whose prose is the terminal's Source
          // Code Pro: a second monospace, invisible because it is monospace too. This pill is
          // rendered INSIDE `Markdown` (by `remarkBeadRefs`), so it reads the same custom property
          // the code renderers do and follows whatever face that root declared, with `FONT_MONO` as
          // the fallback for a pill rendered outside one.
          fontFamily: MD_CODE_FACE,
        }}
      >
        <span style={statusDot(bead.status)} aria-hidden />
        {bead.id}
      </button>
      {open && (
        <ConciergeBeadCard
          id={cardId}
          resolved={resolved}
          onClose={() => setOpen(false)}
          notice={showMiss ? noBoardSentence(bead.id) : undefined}
          noticeKey={misses}
          // THE NAVIGATION RUNS IN THE HANDLER, NEVER INSIDE THE UPDATER.
          //
          // React re-invokes a state updater whenever it discards and replays a render — an
          // interrupted concurrent render, a Suspense retry, StrictMode's double-invoke — so an
          // updater that performed the jump would run `selectProject` → `openPlanBoard` →
          // `setBoardFocusBeadId` TWICE for one click. The visible cost is not a duplicated no-op:
          // the second `setBoardFocusBeadId` re-arms a ONE-SHOT that `BoardView` has already
          // consumed and cleared, so the overlay can reopen under a reader who has since closed it.
          //
          // This shipped the wrong way round and was caught in review. `AgentPill`'s click handler
          // carries the identical warning (roborev 55618), and `voice/useAutoSend` designs around
          // the same hazard — writing it a third time here because the mistake survived reading
          // both. The updater below is pure: it only folds an outcome that is already decided.
          onViewOnBoard={
            onViewOnBoard === undefined
              ? undefined
              : () => {
                  const landed = onViewOnBoard({ beadId: bead.id, projectId: resolved.projectId });
                  setMisses((n) => (landed ? 0 : n + 1));
                }
          }
        />
      )}
    </span>
  );
}

/** The testid the concierge card carries. Named because the pill's own click-outside guard has to
 *  ask "was that press inside the card?" and a literal in two places is a literal that drifts. */
const CARD_TESTID = "concierge-bead-card";

/** A STABLE empty roster / backlog, so a project with neither does not hand the selectors below a
 *  fresh array on every store write. */
const NO_AGENTS: AgentTab[] = [];
const NO_BEADS: Bead[] = [];

/**
 * The shared `BeadCard`, wired to the concierge.
 *
 * ══ WHY THIS IS A COMPONENT AND NOT JSX INSIDE `BeadPill` ══════════════════════════════════════
 * It reads four live things the card needs — the project's agents, their workflow stages, the
 * project's backlog, and the build actions — and `BeadPill` returns EARLY for the common case of an
 * id that does not resolve. Hooks cannot live behind that return, and hoisting them above it would
 * make every ordinary hyphenated word in the thread subscribe to three stores.
 *
 * ══ THE CARD IS THE BOARD'S CARD ═══════════════════════════════════════════════════════════════
 * Everything below is a prop, not a variant. `BeadCard` decides what a bead looks like; this decides
 * which project's data answers for it and what the buttons do. The founder's ask was that the two
 * surfaces stop being two surfaces, so the only difference this file is allowed to introduce is the
 * one he named: the description scrolls at `DESC_MAX_H`.
 */
function ConciergeBeadCard({
  id,
  resolved,
  onViewOnBoard,
  onClose,
  notice,
  noticeKey,
}: {
  id: string;
  resolved: ResolvedBead;
  /** Absent when the surface has no board to open. The card is still the result of the click, so
   *  this is a missing SECOND step, not a dead end. */
  onViewOnBoard?: () => void;
  onClose: () => void;
  notice?: string;
  noticeKey: number;
}) {
  const { bead, projectId, projectName, rootPath } = resolved;
  // The bead's OWN project's agents, which is not necessarily the selected one — a concierge answer
  // is cross-project by construction, and a worker on another project's bead still belongs on the
  // card for that bead.
  const agents = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.agents ?? NO_AGENTS,
  );
  const workerIds = agents.filter((a) => a.kind === "worker" && a.beadId === bead.id).map((a) => a.id);
  // Subscribe to ONLY this bead's workers' stages (shallow-compared), the same way the board's card
  // does, so a stage tick on an unrelated agent does not repaint every open card in the thread.
  const workerStages = useRuntimeStore(
    useShallow((s) => workerIds.map((wid) => s.workflowStage[wid]).filter(Boolean) as WorkflowStageId[]),
  );
  const stage = beadStage(bead.status, bead.labels.includes(DELIVERED_LABEL), workerStages);
  const allBeads = useBeadsStore((s) => s.byProject[projectId]?.beads ?? NO_BEADS);
  const build = useBeadBuildActions({ bead, projectId, allBeads, onStarted: onClose });
  // WRITES NEED A PATH. Without one the card is a read-only view of the bead — which is exactly
  // what every surface that supplies no project (a support modal, an agent reply, a test fixture)
  // rendered before any of these controls existed.
  const canWrite = rootPath !== undefined && rootPath !== "";
  return (
    <BeadCard
      id={id}
      chrome="concierge"
      bead={bead}
      stage={stage}
      workers={workersForBead(agents, bead.id)}
      projectName={projectName}
      // THE FOUNDER CHOSE TO KEEP 180px. It was reconsidered at 90 and he said no: a card that
      // shows six lines of a description is a card you have to open the board to read.
      descMaxHeight={DESC_MAX_H}
      onViewOnBoard={onViewOnBoard}
      onClose={onClose}
      onSetPriority={
        canWrite ? (p) => setBeadPriority(rootPath, bead.id, p) : undefined
      }
      onBuildIt={canWrite ? (build.buildIt ?? undefined) : undefined}
      // `build.buildAllPrd` is already null unless this bead is an epic with siblings in its PRD —
      // that gate moved into the hook after BOTH surfaces independently shipped a `length > 1`-only
      // check, which offered "Build all N epics" on a task that merely carried a PRD back-link.
      onBuildAllPrd={canWrite ? (build.buildAllPrd ?? undefined) : undefined}
      prdEpicCount={build.prdEpics.length}
      notice={notice}
      noticeKey={noticeKey}
    />
  );
}
