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
import { BEADS_CROSS_PROJECT_REFRESH_MS, beadsPolledAt, useBeadsStore } from "../../stores/beadsStore";
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { DELIVERED_LABEL, type Bead, type Board } from "../../services/beads";
import { beadsComment, beadsDetail, type BeadComment } from "../../services/beadsCommands";
import { beadLineageOf } from "../../engine/beadLineage";
import { openProjectTab, selectProjectOnItsSide } from "../../services/openProjectTab";
import { markProjectOpen } from "../../services/projectTabs";
// THE BOARD HANDOFF, SHARED. Extracted from this file (it was `viewOnBoard`, right here) the day
// the Epics column needed the identical sequence — the note the function carried asked for
// exactly that, having already been copy-derived WRONGLY once (roborev 55149 / 55192). A third
// hand-written copy is how `selectProject` and `selectProjectOnItsSide` diverged before.
import { openBeadOnBoard } from "../../services/openBeadOnBoard";
import { EPIC_LADDER, type EpicLadderKey } from "../../services/epicBoard";
import { beadStage, workersForBead } from "../../services/planView";
import { dispatchBeadChat } from "../../services/beadChat";
import type { WorkflowStageId } from "../../engine/workflowStage";
import type { AgentTab } from "../../types";
import { BeadCard } from "../BeadCard/BeadCard";
import { setBeadPriority } from "../BeadCard/beadPriority";
import { beadCardMenuIsOpen } from "../BeadCard/PriorityPill";
import { stageLabel, statusDot } from "../BeadCard/beadStatus";
import { useBeadBuildActions } from "../BeadCard/useBeadBuildActions";

/** A resolved bead, and WHICH PROJECT'S board holds it. The project id is not decoration: the
 *  concierge is cross-project by construction ("the concierge is not any project at all",
 *  ConciergeColumn), so the board a bead opens on cannot be inferred from the column. */
export interface ResolvedBead {
  bead: Bead;
  projectId: string;
  /**
   * WHICH BOARD COLUMN THAT PROJECT'S SNAPSHOT PUTS THE BEAD IN — the status chip's whole content,
   * and the pill tooltip's.
   *
   * ══ WHY IT IS INDEXED HERE AND NOT LOOKED UP AT THE POINT OF USE ═══════════════════════════
   * Two readers need it — the pill's `title` and the card the pill opens — and this component's
   * founding rule is that those two can never say different things about one bead (see
   * `BeadCard/beadStatus`). Deriving it twice is two chances to drift. Indexing it once also keeps
   * it O(n): `ladderKeyOf` scans a board, so calling it per bead while building this map would be
   * quadratic on a store with thousands of beads.
   *
   * OPTIONAL, and absent is a real state rather than an oversight: a `BeadPillProvider` handed a
   * fixture supplies no board, and a snapshot mid-load has none yet. `stageLabel` falls back to
   * deriving the column from the bead — still a stage word, never bd's `open`.
   */
  placedIn?: EpicLadderKey | null;
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
  /**
   * Jump to a BUILD AGENT — what a pill on the card's `Build agents:` row does.
   *
   * The founder's requirement is that those pills are not decoration: *"build agent pills are REAL
   * LINKS: clicking one jumps to that agent"* — the same affordance `Concierge/AgentPill` gives a
   * `@mention` in the same thread.
   *
   * ══ WHY IT TAKES A PROJECT ID AND DOES NOT RETURN AN OUTCOME ════════════════════════════════
   * The project, because a concierge answer is cross-project by construction and `openProjectTab`
   * is addressed by (project, agent) — a reveal keyed to the SELECTED project would land on the
   * wrong pair for exactly the agents a second pair exists to hold. An object rather than two
   * positional strings for the reason `onViewOnBoard` gives: both are `string`, so a swap
   * typechecks and its only symptom is a click that does nothing (roborev 54894).
   *
   * NO `RevealOutcome`, unlike `AgentPillContextValue.onOpenAgent`. `BeadCard.onOpenAgent` returns
   * `void`, so there is no surface here to turn "it was already showing" into a sentence, and
   * inventing one would mean this file deciding what a lineage row says — which belongs to the
   * shared card. Named as a known narrowing rather than left to be rediscovered: wiring
   * `ConciergeHost.openAgentFromPill` in (it is richer — it un-filters the band and expands the
   * orchestrator so the row is actually DRAWABLE) is the follow-up.
   *
   * OPTIONAL. Absent means "this surface has no reveal path", and the pills render as static text
   * rather than as buttons wired to nothing.
   */
  onOpenAgent?: (target: { agentId: string; projectId: string }) => void;
  /** Open the epic in the BUILD column, narrowed to the agents working it — and report whether it
   *  LANDED, on exactly the contract `onViewOnBoard` above describes. Same object-not-two-strings
   *  reasoning, same "absence means this surface cannot go there" reasoning.
   *
   *  IT IS OFFERED ONLY FOR AN EPIC, and that gate is NOT here: whether a bead is an epic is a
   *  question about the BEAD, answered by the shared resolver where the card is assembled
   *  (`ConciergeBeadCard`), not a property of the surface. This field says only that a build column
   *  exists to narrow — the same thing `onViewOnBoard` says about a board. */
  onViewInColumn?: (target: {
    beadId: string;
    projectId: string;
    isEpic: boolean;
  }) => boolean;
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

// ── EVERY CARD IN THE CHAT THREAD STARTS COLLAPSED — THE AUTO-EXPAND BUDGET IS RETIRED ─────────
//
// The founder, 2026-08-22 (bead sparkle-lm78sq): *"they're just taking up too much real estate, and
// I love them, but I want them to be click to expandable… maybe half the height when it's closed."*
// Settled the same day, when he was asked whether a bead he had NAMED BY ID should be the exception:
// EVERYTHING COLLAPSED, NO EXCEPTIONS. One rule, no surprises.
//
// ══ WHAT THIS REVERSES, AND WHY IT IS A REPURPOSE RATHER THAN A DEFAULT FLIP ═══════════════════
// This file used to compute, PER MESSAGE, which of a reply's bead ids rendered already-OPEN — a
// budget (`autoExpandedBeadIds` / `pickAutoExpanded`) over `[ui].bead_cards_expanded` and
// `[ui].bead_cards_expanded_max`. That machinery answered "should this card be open?", and the
// founder's ruling deletes the question: the answer is now `no`, unconditionally, for every bead.
// A budget whose every path returns the same value is not a setting, it is dead code that reads
// like one — so the counting, the cap and the two settings reads are gone.
//
// WHAT SURVIVES IT IS THE MARKER, AND ONLY THE MARKER. The provider `ConciergeMessageRow` wraps
// each answer in was also the only thing in the app that knew "this markdown is a CHAT MESSAGE",
// and that fact is still needed — see the next block. So it keeps its two call sites and loses its
// budget: it now supplies a boolean, reads no store, and re-parses no markdown on a bead poll.
//
// ══ WHY THE CARD IS NOT SIMPLY RENDERED EVERYWHERE ═════════════════════════════════════════════
// `BeadPill` draws inside every `<Markdown>` in the app, and only ONE of those surfaces is the one
// the founder is describing. Rendering a card unconditionally puts one in a MOUNTED AGENT'S
// TERMINAL — whose whole contract is that it declares no face but the terminal's
// (`MountedAgentThread.terminalFont.test.tsx`) — and in a support modal, and in a user's own
// bubble. None of that was asked for, and the terminal case is a straight regression. So: inside a
// chat message a resolved bead is a COLLAPSED CARD; everywhere else it is the pill it has always
// been, opening its card on a click.
//
// ══ WHAT REPLACED THE OLD DEFAULT IS NOT "A PILL AGAIN" — THAT IS THE TRAP ═════════════════════
// The instruction it supersedes ("render its card expanded by default — never collapsed to a bare
// pill the user has to click open") was reacting to a card collapsed SO FAR it showed nothing. He is
// not asking to go back to that. A resolved bead in the thread now renders a HALF-HEIGHT CARD —
// `<BeadCard collapsed>` — carrying Build It, the title, the id, the merged metadata line and the
// two lineage rows: enough to recognise and judge it at a glance, the rest on demand.
//
// ══ THE CONFIG KEYS ARE NOW INERT, AND THAT IS REPORTED RATHER THAN HIDDEN ══════════════════════
// `[ui].bead_cards_expanded` / `[ui].bead_cards_expanded_max` still parse (`config.rs`), still land
// on `settingsStore` as `beadCardsExpanded` / `beadCardsExpandedMax`, and are now read by NOTHING.
// Their docstrings there — and `services/config.ts`'s — still describe the retired behaviour. Those
// files are owned elsewhere; removing the keys is a follow-up, and it is named in this branch's
// result rather than left for someone to discover from a setting that does nothing.

/** Whether the markdown below is A CHAT MESSAGE. `false` — every other `<Markdown>` in the app —
 *  is the correct default: a support modal, an agent's own scrollback and a test fixture all keep
 *  the pill-until-clicked behaviour they have always had. */
const BeadChatSurfaceContext = createContext(false);

/**
 * Mark this markdown as a CHAT MESSAGE, so its resolved bead ids draw collapsed cards.
 *
 * Mounted by `ConciergeMessageRow` around each answer's `<Markdown>`. It takes `text` and ignores
 * it: the prop is what the budget this replaced needed, and it is kept so the two call sites — in a
 * file this branch does not own — go on compiling unchanged. Dropping the prop, and the alias
 * below, is a one-line follow-up there.
 */
export function BeadChatSurfaceProvider({ text: _text, children }: { text: string; children: ReactNode }) {
  return <BeadChatSurfaceContext.Provider value={true}>{children}</BeadChatSurfaceContext.Provider>;
}

/** @deprecated The name `ConciergeMessageRow` still imports. It no longer auto-EXPANDS anything —
 *  see {@link BeadChatSurfaceProvider}, which is the same component under the name that now
 *  describes it. Renaming the two call sites retires this alias. */
export const BeadAutoExpandProvider = BeadChatSurfaceProvider;

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
      for (const [id, path] of targets) {
        // ══ FRESHNESS, NOT EFFECT IDENTITY, DECIDES WHETHER TO SHELL OUT ═══════════════════════
        // `others` filters on `selectedProjectId`, so it changes on EVERY selection change and
        // re-arms this effect — which re-fires the immediate sweep below for all N−1 remaining
        // projects, including the N−2 that were read seconds ago and did not change. Clicking
        // through the project strip (or any "View on board", which calls `selectProject`) would
        // otherwise produce back-to-back convoys of `bd` subprocesses against the shared store —
        // exactly the load the 6× interval was chosen to avoid. `refresh`'s in-flight guard does
        // not cover this: it coalesces CONCURRENT calls for one project, not back-to-back ones.
        //
        // READ FROM `beadsPolledAt`, NOT FROM THE SNAPSHOT. This gate needs "when did we last
        // successfully READ this project", which is no longer the same thing as the snapshot's
        // `loadedAt` ("when did this content last CHANGE"): a poll that finds an unchanged backlog
        // now deliberately preserves the snapshot object so ~60 AgentRows are not re-rendered every
        // 5s. Reading `loadedAt` here would therefore see a timestamp frozen at the last real
        // change, and a project whose backlog is stable — the common case — would look permanently
        // stale and be re-shelled-out on every sweep, which is the exact convoy this gate exists to
        // prevent. Both stamps are written only on SUCCESS, so a failed read still re-tries.
        const at = beadsPolledAt(id);
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
      onViewOnBoard: openBeadOnBoard,
      onOpenAgent: openAgent,
      onViewInColumn: viewInColumn,
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
  byProject: Record<string, { beads: Bead[]; board?: Board } | undefined>,
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
    // ONE PASS OVER THE BOARD PER PROJECT, not one `ladderKeyOf` scan per bead — see
    // `ResolvedBead.placedIn`. A snapshot with no board yet yields an empty map and every bead
    // falls back, which is the loading state rather than an error.
    const placement = placementIndex(byProject[projectId]?.board);
    for (const bead of byProject[projectId]?.beads ?? []) {
      if (!out.has(bead.id))
        out.set(bead.id, {
          bead,
          projectId,
          projectName,
          rootPath,
          placedIn: placement.get(bead.id) ?? null,
        });
    }
  }
  return out;
}

/** Every bead in one project's board, mapped to the column holding it. Built once per project so
 *  the index above stays linear; see `ResolvedBead.placedIn`. A `board` that is absent or partial
 *  (a fixture, a snapshot still loading) simply contributes nothing. */
function placementIndex(board: Board | undefined): ReadonlyMap<string, EpicLadderKey> {
  const out = new Map<string, EpicLadderKey>();
  if (board === undefined) return out;
  // WALKS THE COLUMNS, never `ladderKeyOf` per bead — that function scans a whole board to answer
  // for one id, so calling it in a loop over the same board is quadratic. This is the inverted
  // form of the same fact: one visit per bead, total.
  for (const key of EPIC_LADDER) {
    for (const bead of (board as Partial<Record<EpicLadderKey, Bead[]>>)[key] ?? []) {
      if (!out.has(bead.id)) out.set(bead.id, key);
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
 * Show a build agent named on a card's `Build agents:` row.
 *
 * `openProjectTab` is the same call `ConciergePrChip` already makes for an agent named in the
 * thread, and it does the two things that matter: it opens the agent's PROJECT as a tab (a
 * concierge answer routinely names work in a project the reader has not opened) and then selects
 * the agent on that project's own side.
 *
 * A MODULE FUNCTION, not a closure built in `BeadPillHost`'s `useMemo` — it captures nothing, so a
 * stable identity costs nothing and the context value does not gain a new one on every render.
 *
 * Its boolean return is dropped deliberately: `BeadCard.onOpenAgent` is `void`, and the honest
 * narrowing is recorded on `BeadPillContextValue.onOpenAgent` rather than half-plumbed here.
 */
function openAgent(target: { agentId: string; projectId: string }): void {
  openProjectTab(target.projectId, target.agentId);
}

/**
 * Open the epic in the BUILD column on its own side — the other half of the founder's pair.
/**
 * Open this bead in the BUILD column on its own side — the other half of the founder's pair.
 *
 * ══ IT SERVES BOTH RUNGS, AND THE RUNG PICKS THE SETTER ════════════════════════════════════════
 * An EPIC narrows the column to the epic (`openEpicFocus`); a TASK narrows it one rung further, to
 * just the agents on that task (`openBeadFocus`). The founder asked for the second explicitly —
 * *"be able to see what actual active building is being done against any given task"* — and the
 * two are one gesture from the reader's side, so they are one function here.
 *
 * The asymmetry between the two setters is the store's composition rule, not a detail: focusing an
 * epic CLEARS a stale child beneath it (rule 3), while focusing a task LEAVES the epic in force
 * (rule 2), so clearing the task hands the column back to its epic. That second half is also what
 * keeps an open epic CARD open when a task is opened from chat — the epics column decides that from
 * `epicFocusBySide`, which the task path never touches.
 *
 * *"I have the option to open the epic in the build column or open the epic on the planning
 * board."* This is the first of those two, and it is the exact mirror of {@link viewOnBoard} above:
 * same project-existence check, same derived side, same boolean contract. Read that function's
 * docblock first — everything it says about WHICH SIDE and why the project is selected first
 * applies here unchanged, and is not repeated.
 *
 * ══ TWO STORE WRITES, AND THE SECOND ONE IS EASY TO MISS ═══════════════════════════════════════
 * `showBuildStage(side)` THEN `openEpicFocus(side, epicId)`. The narrowing alone is invisible: the
 * build column's focus banner — the only thing on screen that says a filter is in force, and the
 * only place its "Show all" clear lives — is gated on `mode !== "plan"` in `AgentSidebar`. So
 * focusing an epic on a side that is currently showing the Plan board narrows a column the reader
 * is not looking at, with nothing to explain it and no way to undo it. `showBuildStage` /
 * `openPlanBoard` are the store's documented pair of "make this stage actually visible" writes, and
 * this needs the build half for the same reason the board path needs the plan half.
 *
 * ══ `openEpicFocus`, NEVER `setEpicFocus` ══════════════════════════════════════════════════════
 * `setEpicFocus` TOGGLES — pressing it on the epic it already holds CLEARS the narrowing. That is
 * right for the epics-column row, which is its own off-switch, and wrong for a link labelled
 * **Open**: the second press would un-focus the epic the reader just asked to see, and read as the
 * link being broken. `openEpicFocus` is the idempotent write that exists for this call site.
 *
 * ══ UNLIKE THE BOARD, NOTHING HERE IS A ONE-SHOT ═══════════════════════════════════════════════
 * `setBoardFocusBeadId` is consumed and cleared by `BoardView`, which is what makes the board
 * path's ORDER load-bearing. `epicFocusBySide` is ordinary state that nothing consumes, so the two
 * writes here commute — but they are still both required, and the order is kept the same as the
 * board's so the two functions read as one pattern.
 */
function viewInColumn(target: {
  beadId: string;
  projectId: string;
  /** Which RUNG this bead is — see the note above. The caller already knows (it holds the shared
   *  resolver's answer), so this is passed rather than re-derived here. */
  isEpic: boolean;
}): boolean {
  const projects = useProjectStore.getState();
  // Same reported-not-assumed contract as `viewOnBoard`: `false` becomes a sentence on the card.
  if (!projects.projects.some((p) => p.id === target.projectId)) return false;
  // Same two rules as `viewOnBoard` above, and the same reasons — see that block. The tab must be
  // opened before the selection, or a closed project's selection is discarded by the side resolver.
  markProjectOpen(target.projectId);
  selectProjectOnItsSide(target.projectId);
  const ui = useUiStore.getState();
  const side = sideOf(ui.pairAssignment, target.projectId);
  ui.showBuildStage(side);
  // THE RUNG DECIDES THE SETTER, and both are the IDEMPOTENT ones because this is a link.
  if (target.isEpic) ui.openEpicFocus(side, target.beadId);
  else ui.openBeadFocus(side, target.beadId);
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
 *  top of the thread, which is the context switch the whole feature exists to avoid.
 *
 *  EXPORTED because `RecapCard`'s disclosure reuses it (bead `sparkle-o37mn`). The founder asked
 *  for the recap's expanded height to be "whatever we're using for the beads expand sizes" — so the
 *  two heights are ONE decision, and a second literal would be a second thing that can drift. Both
 *  cards sit in the same column and are read by the same person one scroll apart; they must not
 *  disagree about how much is "enough before it scrolls". */
export const DESC_MAX_H = 180;

/** What the card says when the board could not be opened. One sentence, non-alarming, and it names
 *  the bead — a paragraph can hold several cards. Matches `AgentPill`'s `closedSentence` in shape so
 *  the app says this kind of thing one way. */
const noBoardSentence = (beadId: string) => `${beadId} is not on an open board.`;

/**
 * …and what it says when the EPICS COLUMN could not be opened.
 *
 * ══ A SECOND SENTENCE, BECAUSE THERE IS NOW A SECOND DESTINATION ═════════════════════════════
 * `sparkle-huw924.12` sent the `Tasks:` pills to the Epics column instead of the board, and a miss
 * on that path would otherwise have reported *"… is not on an open board"* — a sentence about a
 * surface the click was no longer even trying to reach. AGENTS.md's rule, and it is the one that
 * bit here: a fix that changes WHERE something happens must update every message that described
 * the old destination, or the fix merely RELOCATES the bug into the copy.
 *
 * It is also a REMEDY the reader will act on, so it has to be true under the same conditions that
 * produced it: both misses mean "that project is not open here", so both sentences say the same
 * kind of thing about a different surface rather than sending the reader somewhere that would fail
 * for the identical reason.
 */
const noColumnSentence = (beadId: string) => `${beadId} has no open project column.`;

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
      const { beads, onViewOnBoard, onOpenAgent, onViewInColumn } = useContext(BeadPillContext);
  // ── EXPANDED IS THE READER'S DECISION, AND IT STARTS FALSE ──────────────────────────────────
  //
  // A plain boolean, seeded `false`, and BOTH halves of that are the founder's ruling rather than
  // a simplification. This used to be `boolean | null` — "the reader has not decided yet" — because
  // a message-level budget could answer for a card the reader had not touched. Nothing answers for
  // him any more: EVERY card starts collapsed, no exceptions (see the block at the top of this
  // file), so there is no second opinion for `null` to defer to.
  //
  // ══ COLLAPSED IS NOT "NO CARD" ══════════════════════════════════════════════════════════════
  // The card below is rendered in BOTH states. `false` draws `<BeadCard collapsed>` — the half-
  // height card carrying Build It, the title, the id, the merged metadata line and the lineage
  // rows — and `true` draws the full, writable card. What the click changes is HOW MUCH OF THE
  // CARD is on screen, never whether a card exists at all.
  //
  // IT SURVIVES A POLL, which is the property the old `useState(autoOpen)` note was really about:
  // this component holds no bead, re-reads `beads.get(beadId)` every render, and a bead that
  // resolves seconds after the message was written simply starts drawing its collapsed card.
  const [expanded, setExpanded] = useState(false);
  // IS THIS A CHAT MESSAGE — the one surface the founder's ruling is about. See the block at the
  // top of this file: in the thread a resolved bead draws a collapsed card without a click;
  // everywhere else it stays the pill it has always been until one.
  const inChat = useContext(BeadChatSurfaceContext);
  // Consecutive FAILED board opens, AND WHICH BEAD THE LAST ONE WAS FOR.
  //
  // A COUNT rather than a boolean for the reason `AgentPill` documents (roborev 55590): setting
  // `true` on an already-`true` state is an identical-value update, React bails out, and the
  // reader's retry click paints and announces nothing.
  //
  // THE ID IS NEW, and it is not decoration. The card can open a DIFFERENT bead than its own — the
  // `Tasks:` row's pills carry their own target — so a sentence hard-coded to this card's id would
  // name the wrong bead the moment a child failed to open.
  //
  // AND SO IS `where`, FOR THE SAME CLASS OF REASON. There are now TWO destinations reachable from
  // one card: the card's own `Board` link still goes to the Plan board, while a `Tasks:` pill
  // goes to the Epics column (`sparkle-huw924.12`). A single sentence can no longer describe both
  // misses truthfully, so the miss records which surface was actually attempted and the sentence is
  // chosen from it. Without this the column path would report "not on an open board" — a sentence
  // about a surface that click never tried to reach.
  const [miss, setMiss] = useState<{ id: string; n: number; where: "board" | "column" }>({
    id: "",
    n: 0,
    where: "board",
  });
  const cardId = useId();
  const anchorRef = useRef<HTMLButtonElement>(null);

  // ── ESCAPE AND CLICK-OUTSIDE COLLAPSE THE CARD ──────────────────────────────────────────────
  //
  // ══ WHAT "CLOSE" MEANS NOW ═════════════════════════════════════════════════════════════════
  // It COLLAPSES, it does not dismiss: the half-height card stays on screen and keeps answering
  // "which bead is this, and does it need me". That is the whole of the founder's ruling — the
  // expensive state is the expanded one, so the exits take back the height and nothing else.
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
  //   * REGISTERED ONLY WHILE EXPANDED. A concierge thread can hold dozens of cards, and a
  //     permanent listener each would be a real cost for a card nobody has opened.
  //   * THE ANCHOR-CONTAINS GUARD. The pill's own click toggles the card; without this the
  //     capture-phase mousedown would ALSO see that press, collapse the card, and the toggle would
  //     immediately re-expand it — one gesture, no visible response.
  //
  // A THIRD GUARD IS NEW HERE, and it is the one the template could not have: the card's priority
  // menu PORTALS to `document.body`, so a press on a menu row is, in DOM ancestry, outside this
  // card. Without `beadCardMenuIsOpen()` picking a priority would collapse the card underneath the
  // click, and Escape — whose listener this component registered FIRST, since the card expanded
  // first — would collapse the card instead of peeling the menu.
  //
  // ══ THE `override === true` GATE IS GONE BECAUSE THE STATE IT GUARDED IS GONE ═══════════════
  // Click-outside used to be registered only for a HAND-OPENED card, so that an AUTO-expanded one
  // survived the founder clicking into his own composer to answer the reply. Nothing auto-expands
  // any more: every expanded card in the thread is one he pressed, which is exactly the "popover
  // you summoned" case the listener was always right for. And the press that used to be the
  // problem — the one into his composer — now costs him a re-click at worst, not a card.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      // Cable etiquette: honour a prior consumer, then consume, so one press peels one layer.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (beadCardMenuIsOpen()) return; // the menu is the innermost layer; let it take this press
      e.preventDefault();
      setExpanded(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t === null) return;
      if (anchorRef.current?.contains(t) === true) return;
      const el = t instanceof Element ? t : t.parentElement;
      if (el?.closest(`[data-testid="${CARD_TESTID}"]`) != null) return;
      if (beadCardMenuIsOpen() && el?.closest("[data-bead-card-menu]") != null) return;
      setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [expanded]);

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
        aria-expanded={expanded}
        aria-controls={cardId}
        // The STAGE, the same word the card below it shows — not bd's wire status. The pill and
        // the card it opens must never name one bead's state two ways; that is the whole reason
        // `beadStatus` is a shared module.
        title={`${bead.id} · ${bead.title || "untitled"} — ${stageLabel(bead, resolved.placedIn)}`}
        // A SECOND PATH TO THE SAME TOGGLE the card body itself offers. The founder asked for the
        // card to be the target — *"instead of having a Chevron, you just click on each of these
        // cards to expand it"* — and the pill stays clickable because it is the inline word in the
        // sentence, which is what a reader who has scrolled past the card reaches for.
        //
        // The updater is PURE — it folds the boolean it is handed and navigates nothing — for the
        // reason the `onOpenBead` note below spells out.
        onClick={() => setExpanded((v) => !v)}
        style={{
          ...base,
          border: "none",
          cursor: "pointer",
          // The mention vocabulary's fill, from the constant rather than re-spelled. A fourth
          // hand-copied `color-mix(… teal 18% …)` is exactly the drift `MentionPill`'s header was
          // written to stop, and a shade of difference between a bead pill and an agent pill in the
          // same sentence fails no test while breaking the founder's "make mentions symmetrical" ask.
          background: MENTION_PILL_FILL,
          // See C.pillInk: a clickable chip's label is neutral, never de-emphasised with its row.
          color: C.pillInk,
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
      {/* ── IN THE THREAD THE CARD IS ALWAYS HERE; THE CLICK ONLY CHANGES HOW MUCH OF IT IS ──
          `inChat` is the founder's ruling in one line of JSX — everything collapsed, no exceptions
          — and its `false` side is every other `<Markdown>` in the app, where a bead reference is
          still a pill that opens a full card on a click and closes back to nothing. */}
      {(inChat || expanded) && (
        <ConciergeBeadCard
          id={cardId}
          resolved={resolved}
          collapsed={!expanded}
          onToggleCollapsed={() => setExpanded((v) => !v)}
          onClose={() => setExpanded(false)}
          notice={
            miss.n > 0
              ? miss.where === "board"
                ? noBoardSentence(miss.id)
                : noColumnSentence(miss.id)
              : undefined
          }
          noticeKey={miss.n}
          onOpenAgent={onOpenAgent}
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
          //
          // ONE OPENER, TWO CALLERS. "View on board" asks for THIS card's bead; a pill on the
          // `Tasks:` row asks for a child's. Both are the same handoff to the same board, so they
          // share one function rather than growing a second copy that can drift about what a miss
          // means or which project answers for the id.
          // ══ A `Tasks:` PILL GOES TO THE EPICS COLUMN, NOT TO THE BOARD ═════════════════════
          // The founder, 2026-08-25 (`sparkle-huw924.12`): *"when I click on a task from the
          // concierge window, I want it to by default open up in the epic column. I want it to
          // open the epic that is its parent. And then I want it to open up the build agents that
          // are assigned to that task. So I can basically get a filtered view of the build agents
          // that are assigned to the tasks that live in the epic."*
          //
          // THIS IS A REWIRING, NOT A FEATURE. All three behaviours he asked for already existed
          // and already worked; they simply hung off the wrong control. `viewInColumn` →
          // `openBeadFocus` stamps a reveal request, `EpicsColumn` consumes it through
          // `revealFor` → `focusEpicWithChild` (opens the PARENT epic without clearing the child,
          // un-collapses its stage, scrolls to the task pill and flashes it), and `AgentSidebar`
          // narrows the Build column via `agentIdsInEpic`. Parent epic, task revealed inside it,
          // agents filtered to that task — his three asks, already built.
          //
          // WHAT IT USED TO DO, AND WHY IT WAS THE EXACT OPPOSITE OF THE ASK: this handler was
          // `onViewOnBoard`, which opens the Plan board — and the board is an `inset: 0` sibling
          // that COVERS the Epics column (`Workspace.tsx`, `covered={leftBoardActive}`). So the
          // one gesture he wanted to REVEAL the column was the gesture that hid it.
          //
          // THE SIBLING SURFACE WAS CONVERTED LONG AGO AND THIS COPY WAS MISSED — that is the
          // whole bug. `EpicInlineCard` wires the identical pill to `focusChildTaskInColumn`, with
          // his ask quoted verbatim above it. Only the concierge kept the board handoff.
          //
          // ══ `isEpic: false`, AND IT IS NOT AN ASSUMPTION ABOUT THE TARGET ═══════════════════
          // It selects the SETTER — `openBeadFocus` rather than `openEpicFocus` — and
          // `openBeadFocus` is the one that stamps the reveal. The reveal is what this call site
          // needs from a cold start: `focusChildTaskInColumn` can use the toggling `setBeadFocus`
          // with no reveal because it fires on a row INSIDE an already-open epic, whereas from the
          // concierge the epic is not open yet and nothing would open it.
          //
          // The RUNG of the target is then answered by `revealFor`, which is the shared resolver
          // and handles all three shapes — a task under an epic, a bead that IS an epic (the
          // parent chip's target), and a parentless task, which reveals as its own row. So this
          // line is not claiming the target is a task; it is choosing the setter that lets the
          // resolver decide. Re-deriving epic-ness here instead would be the extra definition
          // `epic-membership-guard.sh` fails CI on.
          onOpenBead={
            onViewInColumn === undefined
              ? undefined
              : (targetId: string) => {
                  const landed = onViewInColumn({
                    beadId: targetId,
                    projectId: resolved.projectId,
                    isEpic: false,
                  });
                  setMiss((m) =>
                    landed
                      ? { id: "", n: 0, where: "column" }
                      : { id: targetId, n: m.n + 1, where: "column" },
                  );
                }
          }
          // ══ THE CARD'S OWN `Board` LINK KEEPS THE BOARD — THAT IS THE WHOLE ESCAPE HATCH ═
          // Split out of `onOpenBead` above, which used to serve BOTH (the file called it "ONE
          // OPENER, TWO CALLERS"). Rewiring that shared handler wholesale would have taken the
          // board away from this link too — and asked directly whether the concierge should keep a
          // route to a task's board card, the founder chose to let the pill always open the Epics
          // column *because* the card's own `Board` link still goes to the board. That answer
          // is only true if these two are separate handlers, so they are.
          onViewOnBoardSelf={
            onViewOnBoard === undefined
              ? undefined
              : () => {
                  const landed = onViewOnBoard({ beadId: bead.id, projectId: resolved.projectId });
                  setMiss((m) =>
                    landed
                      ? { id: "", n: 0, where: "board" }
                      : { id: bead.id, n: m.n + 1, where: "board" },
                  );
                }
          }
          // THE SAME SHAPE, AND THE SAME WARNING APPLIES — the navigation runs in the handler, the
          // updater only folds an outcome already decided. See the block above; it is not repeated
          // because the hazard is identical and one copy of that explanation is enough.
          onViewInColumn={
            onViewInColumn === undefined
              ? undefined
              : (isEpic: boolean) => {
                  // `isEpic` ARRIVES FROM THE CARD rather than being computed here. The pill holds
                  // no project backlog, and epic membership is a question about the BEAD that only
                  // the shared resolver may answer — `ConciergeBeadCard` already has that answer
                  // memoized, so it is threaded down rather than re-derived (a second derivation
                  // here would be the extra definition `epic-membership-guard.sh` fails CI on).
                  const landed = onViewInColumn({
                    beadId: bead.id,
                    projectId: resolved.projectId,
                    isEpic,
                  });
                  // Miss state is keyed BY BEAD on this branch, not a bare counter, so the
                  // sentence it drives can name the bead that missed — and by DESTINATION, so it
                  // says "no open project column" rather than borrowing the board's sentence.
                  setMiss((m) =>
                    landed
                      ? { id: "", n: 0, where: "column" }
                      : { id: bead.id, n: m.n + 1, where: "column" },
                  );
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
  collapsed,
  onToggleCollapsed,
  onOpenBead,
  onViewOnBoardSelf,
  onOpenAgent,
  onViewInColumn,
  onClose,
  notice,
  noticeKey,
}: {
  id: string;
  resolved: ResolvedBead;
  /** Draw the half-height card. The concierge's DEFAULT and its only unconditional state — every
   *  card in the thread starts here, and a press opens it. */
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Open a bead on the board — this card's own, from "View on board", or a child's, from a pill on
   *  the `Tasks:` row. Absent when the surface has no board to open, which makes both a missing
   *  SECOND step rather than a dead end: the card itself was already the result of the click. */
  /**
   * Open ANOTHER bead — a `Tasks:` pill's target, or the parent-epic chip's — in the EPICS COLUMN.
   *
   * ══ IT IS NOT THIS CARD'S OWN DESTINATION ═══════════════════════════════════════════════════
   * This used to serve the card's own `Board` link as well, and the two have been split
   * ({@link onViewOnBoardSelf}). They point at different surfaces now, so one callback could not
   * honestly do both: `sparkle-huw924.12` sends a task pill to the Epics column while the card's
   * own link still goes to the Plan board.
   */
  onOpenBead?: (beadId: string) => void;
  /** THIS card's own `Board` link. Separate from {@link onOpenBead} because the two
   *  destinations diverged — see that field. Absence means this surface has no board to offer, the
   *  same callback-is-the-switch rule every other affordance here follows. */
  onViewOnBoardSelf?: () => void;
  /** Jump to a build agent on the `Build agents:` row. Absent on a surface with no reveal path. */
  onOpenAgent?: (target: { agentId: string; projectId: string }) => void;
  /** Absent when the surface has no build column to narrow. Passed through to the card ONLY for an
  /** Absent when the surface has no build column to narrow. Takes the RUNG, because the epic and
   *  task paths write different store keys and only this component holds the resolver's answer. */
  onViewInColumn?: (isEpic: boolean) => void;
  onClose: () => void;
  notice?: string;
  noticeKey: number;
}) {
  const { bead, projectId, projectName, rootPath, placedIn } = resolved;
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

  // ── LINEAGE: THE PARENT, THE TASKS, AND THE BUILD AGENTS ON THEM ────────────────────────────
  //
  // Resolved by the shared engine so the concierge's two rows and the planning board's are the same
  // two rows — the founder's requirement, not a nicety: *"whether it's in the concierge chat or on
  // the planning board, I think it would still just show me two rows."*
  //
  // ══ THE INDEX IS THE WHOLE PERFORMANCE STORY, AND IT IS ALREADY PAID FOR ════════════════════
  // The index `beadLineageOf` builds is WeakMap-cached on the ARRAY IDENTITY of `allBeads`, so passing the store's own
  // array straight through means every card in a thread of fifty messages shares ONE index per
  // snapshot. A raw per-card scan measured 3.4-4.0s on the founder's 7,364-bead store, and these
  // cards re-render on the 5s poll — so the rule is: never copy, filter or spread `allBeads` on the
  // way in, because a fresh array is a fresh index.
  //
  // MEMOIZED ON TOP OF THAT because `beadLineageOf` itself walks the roster and the children on
  // every call, and a `lineage` object with a new identity each render would repaint
  // `BeadLineageRows` (and re-run its width measurement) on every unrelated store write.
  const lineage = useMemo(
    () => beadLineageOf({ beads: allBeads, bead, agents, projectId }),
    [allBeads, bead, agents, projectId],
  );

  // ── THE COMMENT THREAD — READ LAZILY, ONLY WHILE EXPANDED ───────────────────────────────────
  //
  // The founder, about the card in the chat: *"When I click to expand the card in the chat, I should
  // see the full card. I should be able to make a comment. I should be able to do everything in the
  // card when it's expanded in the chat view."* So the concierge stops being the one surface that
  // omits `comments`/`onComment`, and follows the pattern `BoardView`'s DetailOverlay and
  // `EpicInlineCard` already use.
  //
  // ══ WHY THE `collapsed` GATE IS LOAD-BEARING RATHER THAN TIDY ═══════════════════════════════
  // Unlike those two surfaces, this component is MOUNTED FOR EVERY BEAD THE CONCIERGE EVER NAMED —
  // the card is always on screen now, collapsed. Fetching on mount would therefore put one
  // `beads_detail` (which carries `--include-comments`) per bead per thread against a single-writer
  // bd store the app already polls every 5s. Gating on expansion keeps the read where the founder's
  // gesture is: one call, when he opens one card.
  //
  // It re-reads on each expansion rather than caching across a collapse, which is the same "hold no
  // snapshot" rule the pill itself is built on — a thread that was right ten minutes ago is not
  // evidence about the thread now.
  const [comments, setComments] = useState<BeadComment[] | undefined>(undefined);
  // Bumped after a successful post so the thread re-reads and shows the new comment.
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (collapsed || rootPath === undefined || rootPath === "") return;
    let alive = true;
    beadsDetail(rootPath, bead.id)
      .then((d) => {
        if (alive) setComments(d.comments);
      })
      // A failed read degrades to an EMPTY thread rather than to no thread: the compose box has its
      // own error surface, and a card that cannot be commented on because a read failed is worse
      // than one that shows nothing yet.
      .catch(() => {
        if (alive) setComments([]);
      });
    return () => {
      alive = false;
    };
  }, [collapsed, rootPath, bead.id, reload]);
  return (
    <BeadCard
      id={id}
      chrome="concierge"
      bead={bead}
      stage={stage}
      // From the index rather than re-derived here — the pill's tooltip reads the SAME value, and
      // the two must not be able to disagree. See `ResolvedBead.placedIn`.
      placedIn={placedIn}
      workers={workersForBead(agents, bead.id)}
      projectName={projectName}
      // THE FOUNDER CHOSE TO KEEP 180px. It was reconsidered at 90 and he said no: a card that
      // shows six lines of a description is a card you have to open the board to read.
      //
      // NOT WHILE COLLAPSED, and that is a rule rather than a saving: *"when it's collapsed, it
      // would not scroll — would just have less of the actual text."* A scrollable region nested
      // inside a scrolling thread captures the wheel and stops the thread, so the collapsed card
      // must never be handed a clamp to build an inner scroller out of.
      descMaxHeight={collapsed ? undefined : DESC_MAX_H}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      lineage={lineage}
      onOpenBead={onOpenBead}
      // The card's pills carry their own project (a build agent's roster row lives in one), and the
      // card's own project answers for anything that does not — so a reveal is never addressed by
      // the SELECTED project, which for a cross-project concierge answer is routinely the wrong one.
      onOpenAgent={
        onOpenAgent === undefined
          ? undefined
          : (a) => onOpenAgent({ agentId: a.agentId, projectId: a.projectId ?? projectId })
      }
      // BOTH HALVES OF THE THREAD ARE GATED ON EXPANSION, not just the fetch above. `BeadCard`
      // renders `CommentThread` when EITHER `comments` or `onComment` is set, so passing the writer
      // through while collapsed would paint a compose box on the half-height card — the exact
      // height this change exists to reclaim, and content the founder put in the expanded state.
      comments={collapsed ? undefined : comments}
      // WRITE FROM THE THREAD. Callback-is-the-switch, this codebase's convention: a `rootPath` of
      // undefined (a support modal, an agent's own markdown, a fixture) passes nothing, and the
      // reader gets a read-only thread rather than a composer whose send can only fail.
      onComment={
        !collapsed && canWrite
          ? async (text: string) => {
              await beadsComment(rootPath, bead.id, text);
              setReload((n) => n + 1);
            }
          : undefined
      }
      // ══ THIS CARD'S OWN BOARD LINK — ITS OWN CALLBACK, NOT THE LINEAGE ONE ═══════════════════
      // It used to be `() => onOpenBead(bead.id)`, back when `onOpenBead` meant "open a bead on the
      // board" for every target this card could name. `sparkle-huw924.12` pointed the lineage
      // targets at the Epics column, and this link stayed on the board — so the two stopped being
      // the same handoff and stopped sharing a callback. Reusing `onOpenBead` here now would send
      // the card's own `Board` link to the COLUMN, silently removing the board escape hatch
      // the founder's answer explicitly relies on.
      onViewOnBoard={onViewOnBoardSelf}
      // ══ NO CLOSE AFFORDANCE ON A COLLAPSED CARD (roborev job 68044) ══════════════════════════
      // `BeadCard` draws its `×` on the presence of this callback and nowhere else, so an ABSENT
      // `onClose` is how a surface says "this card has no dismiss" — the same callback-is-the-switch
      // convention `onComment` and `onOpenAgent` above are written on.
      //
      // Why it has to be absent rather than merely harmless: in the thread the card is mounted for
      // EVERY bead the concierge has ever named and its default state is collapsed, so the `×` was
      // being painted on the single most common surface in the app with `() => setExpanded(false)`
      // behind it — a write of `false` onto a state that is already `false`. React bails out on the
      // identical value, and the button's own handler calls `stopPropagation`, so the card body's
      // expand toggle never saw the press either: one click, no repaint, nothing announced.
      //
      // Collapsing is what the `×` MEANT on the expanded card, and there it still does it — the
      // card survives the press, which is why this is `onClose` and not a dismissal. `onStarted`
      // above deliberately keeps the raw `onClose`: Build It rides the COLLAPSED card too, and
      // folding the card shut after a build starts is a real state change in both states.
      onClose={collapsed ? undefined : onClose}
      // ══ THE EPIC GATE — READ OFF THE SHARED RESOLVER, NEVER RE-DERIVED ═════════════════════════
      // `build.isEpic` is `isEpicIndexed(epicIndexOf(allBeads), bead)`, memoized inside the hook
      // that is already mounted here. Asking it any other way would be a second definition of epic
      // membership, which `scripts/lib/epic-membership-guard.sh` fails CI on — and the tempting
      // wrong answer — comparing the bead's raw `type` field — is a DIFFERENT question
      // (`isTypedEpic`) that misses every structural epic nobody declared.
      // ══ EVERY BEAD GETS IT NOW — AND THE RUNG IS READ OFF THE SHARED RESOLVER ═════════════════
      // This was gated on `build.isEpic`, on the reading that "both destinations are epic-shaped".
      // Half of that was wrong, and the founder named the missing half himself: *"be able to see
      // what actual active building is being done against any given TASK."* The build column can
      // narrow to a task — `beadIdsInEpic` seeds with whatever id it is handed — so a task card
      // withholding this link was hiding a view the column could already render.
      //
      // The rung still has to be ANSWERED, because it picks the setter (epic clears a stale child,
      // task leaves the epic in force), and it travels with the call rather than gating it.
      // `build.isEpic` is `isEpicIndexed(epicIndexOf(allBeads), bead)`, memoized inside the hook
      // already mounted here. Asking it any other way would be a second definition of epic
      // membership, which `scripts/lib/epic-membership-guard.sh` fails CI on — and the tempting
      // wrong answer, comparing the bead's raw `type` field, is a DIFFERENT question
      // (`isTypedEpic`) that misses every structural epic nobody declared.
      //
      // NOT gated on `canWrite`, unlike Chat and the priority control: this navigates, it does not
      // write, so a project with no `bd` path can still send the reader to the column or the board.
      onOpenInColumn={
        onViewInColumn === undefined ? undefined : () => onViewInColumn(build.isEpic)
      }
      // ══ YES, EVEN INSIDE THE CONCIERGE ═══════════════════════════════════════════════════════
      // Clicking Chat on a card that is ALREADY in a concierge thread looks like a loop, and it
      // isn't: this thread is wherever the bead happened to come up — a board answer, a fleet
      // summary, a support reply — and the button starts a NEW message pinned to this one bead, so
      // the next thing the founder types is unambiguously about it. Omitting it here would also
      // make "a Chat button on every bead card" false on the one surface where bead cards are most
      // common. Gated on `canWrite` like its neighbours: a surface with no project path is the
      // read-only card, and offering a chat about a bead we cannot even resolve a project for is
      // the same dead control the gate exists to remove.
      onChat={canWrite ? () => dispatchBeadChat(bead, projectId) : undefined}
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
