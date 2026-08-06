// Cross-project roster + status-band feed for Concierge Mode (bead sparkle-ld0t, CM-U3).
//
// This is the data layer the concierge column reads: ONE view of everything across all projects,
// with each agent placed in one of the three STATUS BANDS the whole app now speaks in —
// "Needs you" · "Running" · "Done". The core is a PURE builder (like useRosterPublisher.buildRoster)
// so it unit-tests without a DOM or Tauri; useConciergeFeed.ts wires it to the live stores.
//
// THE VOCABULARY IS IMPORTED, NOT INVENTED — `bandOfStatus`/`STATUS_BANDS` live in
// engine/buildSections, where the Build column's filter chips read them, so a status can never band
// one way in the sidebar and another in the concierge:
//   needs_you ← waiting | approval | blocked | errored   ("this cannot proceed without you")
//   running   ← working
//   done      ← idle | done | stopped | unmerged
// This replaced a P0/P1/P2 scheme that split `blocked` off into its own amber tier and lumped
// `working` in with the finished rows. The split that matters to a user is the one that survived:
// in-flight work is not finished work. The one that didn't — "asks you now" vs "wants you
// eventually" — bought a second alarm color for a distinction nobody acted on differently, so
// `blocked` now reads RED like every other Needs-you status and there is exactly ONE red treatment.
//
// `unmerged` is in `done`, and that is load-bearing: the band buys an INTERRUPTION (see
// `conciergeBand`), and landing state must not. It is kept out of the DIMMING predicate separately —
// see `isCalmBand`, and do not collapse the two.
//
// The status each agent is banded ON is the same overlaid status the sidebar colors its rows with
// and the cross-window channel broadcasts: useAttentionNotifications.publishedStatusFor (unstarted-
// worker red → worker-red bubble → unmerged escalation → alert-dismissal de-escalation, in that
// contractual order). A red worker therefore also paints its orchestrator here, exactly as it does
// everywhere else.
import { AGENT_STATUS, type AgentTabStatus } from "@sparkle/ui";
import { agentDisplayName } from "../engine/agentDisplayName";
import { isTopLevelAgent } from "../engine/agentOrdering";
import { STATUS_BANDS, bandOfStatus, type StatusBand } from "../engine/buildSections";
import { resolveStage, type WorkflowStageId } from "../engine/workflowStage";
import { isDismissibleRed } from "../engine/alertDismissal";
import {
  noteMovement,
  noteRedEpochs,
  withMovementRetraction,
  type MovementEvidence,
  type RetractionLedger,
} from "../engine/movementRetraction";
import { publishedStatusFor } from "../useAttentionNotifications";
import type { BranchStatus } from "./branchStatus";
import type { Roster } from "./rosterTypes";
import type { AgentKind, LastObserved, Project } from "../types";

export interface ConciergeAgent {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  kind: AgentKind;
  status: AgentTabStatus;
  statusColor: string;
  statusLabel: string;
  band: StatusBand;
  /** Epoch ms of the user's last touch of this agent (interactionStore.lastAt / promptHistory) —
   *  the within-tier recency tiebreak. Absent when the agent was never touched this session. */
  since?: number;
  /** False only when a pin (pinnedProjectId) scopes the concierge to a DIFFERENT project. An
   *  out-of-scope agent stays in the feed (the roster is the full truth) but never counts toward
   *  scopedCounts — pinning means "disregard other projects' alerts", not "hide them". */
  inScope: boolean;
  /** True when a do-not-interrupt rule (sparklePrefsStore.shouldInterrupt) mutes one of this
   *  item's topics (see conciergeTopics). A muted item stays listed so the UI can dim it, but is
   *  excluded from scopedCounts — the concierge doesn't surface what you asked it not to. */
  muted: boolean;
  /** Whether this agent gets a ROW OF ITS OWN in the Build column, per the one shared rule
   *  (engine/agentOrdering.isTopLevelAgent) — i.e. it is not a worker, and not nested under a build
   *  agent that is present in the same project.
   *
   *  Stamped here, on the feed, because the digest's count is a PROMISE the click has to keep:
   *  clicking "2 Need you in web" isolates that band in column two, which narrows top-level rows and
   *  nothing else. A digest that counted workers would state a number column two cannot produce —
   *  two blocked workers gave the user "2" and an empty column. The feed still LISTS workers (it is
   *  the full cross-project truth, and a worker's red still bubbles to its orchestrator); this field
   *  is what lets the surfacing gate count only what is clickable-to. */
  topLevel: boolean;
  /** The id of the HEAD ROW this agent nests under, or `null` when it has no row anywhere. The third
   *  state between `topLevel` and "invisible" — and an id rather than a boolean because the digest
   *  needs to name the subtree, not merely know one exists.
   *
   *  It exists because "rowless" was being used to mean two different things, and only one of them
   *  is really rowless. `AgentSidebar` renders a worker from `childrenByParent` under its head, and
   *  the head is drawn `top.kind === "build"` only, one level deep — so a worker whose `parentId`
   *  names a present top-level BUILD agent in this project does have a row. A worker with no
   *  `parentId`, or one whose orchestrator is not in the fleet, has none.
   *
   *  Load-bearing for the digest, because a digest line's click can reveal ONE agent. Collapsing
   *  agents that share a head is safe — the click expands that head, so the whole group lands on
   *  screen together. Collapsing agents with no head, or with DIFFERENT heads, is not: the click
   *  satisfies the lead and strands the rest, which is what roborev 53679/53734 caught. The line
   *  said "2 workers inside web need you" and could deliver one.
   *
   *  Judged against THIS PROJECT's agents, the same population `isTopLevel` is closed over, because
   *  that is the list the sidebar builds `childrenByParent` from. An orchestrator in another project
   *  is a real ancestor for `representedElsewhere` (a red bubbles across projects) but it is NOT a
   *  row this project's column can show. */
  parentRowId: string | null;
  /** True when this agent gets NO row of its own AND a present ancestor ALREADY carries its band —
   *  so the concierge would be saying the same thing twice if it counted both.
   *
   *  This is the other half of `topLevel`, and the two only make sense together. `topLevel` says
   *  "can the Build column show this?"; a rowless agent that nothing else speaks for still has to
   *  reach the user SOMEHOW, or the `topLevel` gate turns it into silence. That is precisely what
   *  happened: `isTopLevelAgent` excludes every worker unconditionally, while
   *  `engine/workerAttention.withRedWorkerAttention` bubbles a worker's red to its orchestrator only
   *  sometimes — it skips a worker with no `parentId`, it writes to a status-map key with no agent
   *  behind it when the parent is not in the fleet, and it deliberately SUPPRESSES a non-ask red
   *  (`blocked`) while the orchestrator is still in motion. A worker in any of those three cases had
   *  no row, no card, no digest line and no count.
   *
   *  So the rule is representation, not kind: counted once, at whichever agent actually stands for
   *  the work. Represented → the ancestor's row speaks for it. Not represented → it speaks for
   *  itself (ConciergeHost surfaces it as its own nudge card, never folded into a digest line's
   *  count, because a line's count is a promise about ROWS).
   *
   *  BAND EQUALITY is the test, not mere parenthood: a `blocked` worker under a `working`
   *  orchestrator is NOT represented (the orchestrator's row is banded Running — the Needs-you
   *  filter hides it), while a `waiting` worker under the orchestrator that inherited that exact
   *  `waiting` IS. It also keeps the `running` band honest in the other direction: a `working`
   *  worker under an `idle` parent still counts, because nothing else is reporting that work.
   *
   *  Walked over the FLATTENED fleet, so a worker whose orchestrator lives in another project is
   *  represented by that orchestrator's row — which is where `publishedStatusFor` put its red.
   *  Mute and scope are deliberately NOT consulted: they are applied to the agent itself, and a
   *  user who muted an orchestrator muted its build, workers included. */
  representedElsewhere: boolean;
  /** WHO speaks for it — the ancestor {@link representedElsewhere} found, or null when nobody does.
   *
   *  The same fact as the boolean, kept as an ID because a boolean cannot answer the question a
   *  surface acting on a rollup card has to ask: WHICH agents is this card standing in for?
   *
   *  The concrete failure (roborev 55986). The nudge card's new [x] dismisses the agent the card
   *  names. On the rollup shape — an idle orchestrator carrying a red worker's band, which this
   *  design deliberately keeps — the card names the ORCHESTRATOR. Dismissing only that
   *  de-escalates its red, which makes the worker un-represented, so the very next tick raises a
   *  new, near-identical card naming the worker. The reader who reflexively acknowledged one alarm
   *  gets it straight back under a different name, once per red descendant. Acknowledging a rollup
   *  has to acknowledge what was rolled up, and this is the field that makes that reachable without
   *  the consumer re-deriving the parent walk. */
  representedBy: string | null;
  /** This agent reads `working` only because its WORKERS do — engine/workerRollup promoted it in
   *  publishedStatusFor. Consumers that diff status over time must not read the promotion as the
   *  head starting and finishing work of its own: the away-recap did exactly that and reported one
   *  unit of work twice, as the worker AND the orchestrator standing in for it. */
  rolledUpGreen: boolean;
  /** The MIRROR IMAGE of {@link rolledUpGreen}: this agent reads RED only because a worker under it
   *  does, while it is itself `working`. The band is real — the row must go red so the subtree is
   *  findable — but this agent is a ROUTING HOP, not the subject of the alert.
   *
   *  WHY IT EXISTS (founder, 2026-07-30, with screenshots). The column showed
   *  "Needs you — Cockpit Column Resize" while that agent was seven commits ahead and mid-rebase.
   *  `engine/workerAttention.withRedWorkerAttention` bubbles a worker's ASK unconditionally — in
   *  motion or not, which is right, a busy sibling must not hide a question — and the write lands on
   *  any parent that is not itself asking, `working` included. `representedElsewhere` then saw the
   *  worker's band matched by its ancestor and suppressed the worker's own card. Net effect: the one
   *  card on screen named the one agent in the pair that did NOT need him, and the one that did was
   *  silent. His verdict is the reason this is a defect rather than a nuance: "a stale alert that
   *  says BLOCKED about a working agent is worse than no alert, because it trains him to ignore the
   *  real ones."
   *
   *  READ OFF THE PRE-BUBBLE STATUS, not off a second rollup pass. `own` (the same chain minus the
   *  worker bubbles) and the raw merged map cannot disagree about the value `working`: of the three
   *  overlays between them, `withNewAgentCalm` maps errored/idle → `new`, `withUnmergedWork` maps
   *  done/stopped → `unmerged`, and `withDismissedAlerts` de-escalates a red → `idle`. None produces
   *  `working`, and none consumes it. So this is exact, and it costs no extra composeRollup.
   *
   *  ONLY `working` COUNTS, and the narrowness is the point. An IDLE orchestrator with a red worker
   *  is not a routing hop — it is resting, so its row is a fair place to knock, and that rollup is
   *  what the head's row is FOR. What disqualifies an agent from being the subject of an alert is
   *  that it is visibly, currently producing output: the exact thing the founder saw when he clicked
   *  through and the exact thing that makes the sentence false.
   *
   *  CONSEQUENCE, chosen rather than inherited: a hop's red descendants surface under the ORDINARY
   *  in-scope/mute gates, so a hop whose only red descendant is muted or out of the pin's scope goes
   *  quiet instead of relaying. That is the correct direction — the alternative is telling the
   *  founder that a working agent needs him on behalf of a worker he asked not to be interrupted
   *  about — and it is pinned by a test rather than left to be rediscovered. */
  redIsInherited: boolean;
}

/** How many agents sit in each band. Every band is counted — a surface that only cares about
 *  "Needs you" reads that one field rather than the feed having to guess which ones matter. */
export type ConciergeCounts = Record<StatusBand, number>;

/** All-zero counts — the shape every accumulator starts from. */
export function emptyCounts(): ConciergeCounts {
  return { needs_you: 0, questions: 0, running: 0, done: 0 };
}

export interface ConciergeProject {
  id: string;
  name: string;
  /** False only when a pin scopes the concierge to a different project. */
  inScope: boolean;
  /** This project's raw per-band totals (mute/scope ignored) — the per-tab glow + count. */
  counts: ConciergeCounts;
  /** This project's share of `ConciergeFeed.scopedCounts` — the SAME three gates (in scope, not
   *  muted, not already spoken for), applied per project. Summing this field over every project
   *  reproduces `scopedCounts` exactly, by construction rather than by two computations agreeing.
   *
   *  That identity is what lets column one's header state a cross-project split (PRD §2a, answered
   *  2026-07-28: column one is the GLOBAL index, column two stays project-scoped) without the
   *  header's number drifting from the one the thread accounts for. `counts` above cannot do the
   *  job: it is the RAW truth for the tab badges, so it counts muted, out-of-scope and
   *  already-represented agents that the concierge deliberately never surfaces. */
  scopedCounts: ConciergeCounts;
  /** Sorted Needs you → Running → Done; within a band, live questions first, then most recent,
   *  then name. */
  agents: ConciergeAgent[];
}

export interface ConciergeFeed {
  projects: ConciergeProject[];
  /** Raw totals across ALL projects, mute/scope ignored — the full truth. */
  counts: ConciergeCounts;
  /** What the concierge actually surfaces: in-scope (per the pin) AND not muted. This is the
   *  vitals line (U1's `vitals`) and the "needs surfacing" gate. */
  scopedCounts: ConciergeCounts;
  pinnedProjectId: string | null;
}

export interface ConciergeFeedInput {
  /** All projects (projectStore.projects) — the concierge spans every one, not just the tab. */
  projects: readonly Project[];
  /** THIS window's live status map (runtimeStore.status). */
  status: Record<string, AgentTabStatus>;
  /** Stage inputs for the `unmerged` escalation (runtimeStore); omit in tests for no overlay. */
  workflowStage?: Record<string, WorkflowStageId>;
  branchStatus?: Record<string, BranchStatus>;
  /** Live agent ids (runtimeStore.openAgentIds) for the unstarted-worker red overlay. */
  openAgentIds?: readonly string[];
  /** runtimeStore.lastObserved — a worker with an entry RAN and was closed, so the unstarted-worker
   *  overlay must not synthesize a red for it (sparkle-w340). Omit in tests for no such demotion. */
  lastObserved?: Record<string, LastObserved>;
  /** Agent id → epoch ms of last user touch (interactionStore.lastAt). */
  interaction?: Record<string, number>;
  /** The merged cross-window fleet (getRoster/onRosterChanged). Fills statuses for agents
   *  another window runs — this window's own `status` map only covers agents it hosts, and an
   *  agent covered by NEITHER falls back to "stopped" (same default as buildRoster). Local status
   *  always wins over the tray's. */
  roster?: Roster | null;
  /** Artifact evidence of who has ACTED (runtimeStore.agentMovement, refreshed by
   *  services/fleetWatch off `fleet_digest`). Omit in tests for no retraction. */
  agentMovement?: Record<string, MovementEvidence>;
  /** WHEN EACH RED BEGAN, AND WHAT MOVEMENT HAS BEEN SEEN SINCE — a caller-owned ledger this builder
   *  both STAMPS and reads.
   *
   *  An out-param in the same spirit as `rolledUpGreen` below: the epoch has to be taken from the
   *  MERGED status (local plus the cross-window roster), and that merge only exists in here. The
   *  caller (`useConciergeFeed`) holds the window's shared ledger. Omit in tests for no retraction —
   *  a red whose beginning was never observed is never retracted. */
  retraction?: RetractionLedger;
  /** The clock, for tests. Defaults to `Date.now()`; only the red-epoch stamp reads it. */
  nowMs?: number;
  /** The mute gate (sparklePrefsStore.shouldInterrupt). Defaults to allow-everything. */
  shouldInterrupt?: (topic: string) => boolean;
  /** Pin scope: set → only that project's alerts count toward scopedCounts; null/omitted → all. */
  pinnedProjectId?: string | null;
}

const DEFAULT_STATUS: AgentTabStatus = "stopped";

/** The name the concierge shows — the one shared rule (engine/agentDisplayName). */
const displayName = agentDisplayName;

/** The status band for a status, tolerating "no status at all" (an agent no window is running):
 *  that reads as `done`, the same place `stopped` — the builder's default — lands.
 *
 *  A thin `undefined`-shim over engine/buildSections.bandOfStatus, NOT a second opinion about where
 *  a status belongs. Adding an arm here instead of there is how the sidebar's filter chips and the
 *  concierge start disagreeing about the same agent.
 *
 *  `unmerged` bands `done`. This band is the concierge's INTERRUPTION budget, not a display tier:
 *  `band === "needs_you"` is what `ConciergeHost.surfacedAgents` renders as a nudge card, what feeds
 *  the "N Need you" line, and what lights a project tab's glow via `ProjectTabs.tabBand`. On the
 *  fleet that started all this — 27 of 51 agents in the committed-but-unlanded band — banding
 *  `unmerged` as needs_you would mean 27 nudge cards and "27 Need you": the same undismissable pile
 *  the taxonomy fix exists to remove (roborev on f7b43dc8). Landing state must not buy an
 *  interruption.
 *
 *  It must not buy a DIMMING either, which is the trap the other direction — see `isCalmBand`. */
export function conciergeBand(status: AgentTabStatus | undefined): StatusBand {
  return status === undefined ? "done" : bandOfStatus(status);
}

/** Should this agent's TERMINAL desaturate — i.e. render in the calm xterm theme?
 *
 *  HISTORY, because this predicate used to mean something bigger and the old name still shows in
 *  places: it also drove a `grayscale(1) opacity(.72)` CSS filter over the agent's SIDEBAR ROW, so
 *  that only the rows asking for you carried color. That was removed on 2026-07-27 and must not
 *  come back. `working` is in the calm set (see below), so the filter desaturated the green dot of
 *  every agent that was actually running — erasing the one thing the Build column exists to show at
 *  a glance. The row treatment is gone entirely rather than gated; see
 *  AgentSidebar.liveStatusDots.test.tsx, which fails if any row regains an inline filter.
 *
 *  What survives is the TERMINAL treatment (Workspace.tsx → AgentPane → Terminal → xtermTheme),
 *  which desaturates a landed agent's own text through the theme rather than a filter over the
 *  stage. That distinction has its own history — see the `calm is a terminal theme, not a filter
 *  over the pane` commits.
 *
 *  The SET is unchanged, and the reasoning below is why it is shaped the way it is.
 *
 *  Deliberately NOT "is this row's band `done`", and deliberately NOT "is it anything but
 *  needs_you" alone. The set is {idle, done, stopped, working, no-status}: everything that is not
 *  asking for you, MINUS `unmerged`.
 *
 *  Those questions look identical to the band and are not: the band is an interruption budget,
 *  dimming is a legibility treatment, and `unmerged` needs opposite answers from them — no nudge
 *  card (so, `done`), but not visually muted either, because "your work hasn't landed" is exactly
 *  the thing you should still be able to see at a glance.
 *
 *  Conflating them is a two-way trap that this series hit from BOTH sides in consecutive commits:
 *  the calm band silently dimmed every "Needs merge" row, and the fix for that silently turned each
 *  one into a concierge nudge. Naming the predicate is what stops the next person rediscovering it.
 *
 *  Note `working` is in here even though it is its own band now: a running agent is not asking you
 *  for anything, and the terminal you are watching desaturating the moment it starts working would
 *  be a treatment nobody wants. The band split running from done for POSITION and COUNTS; it did not
 *  change what dims.
 *
 *  `questions` IS EXCLUDED TOO, for the plainest possible reason: an agent that has stopped to ask
 *  the founder something is not calm. Desaturating its terminal would be the mirror of the trap
 *  above — the row the founder most needs to read is the one this would make hardest to read. Note
 *  it must be named explicitly, because the predicate is written as "not needs_you" and `questions`
 *  is its own band; the negative form is exactly what let a fourth band silently fall into "calm". */
export function isCalmBand(status: AgentTabStatus | undefined): boolean {
  const band = conciergeBand(status);
  return band !== "needs_you" && band !== "questions" && status !== "unmerged";
}

/** The do-not-interrupt topics a feed item is keyed under, for sparklePrefsStore.shouldInterrupt:
 *  the agent id ("never interrupt me about THIS agent") and a `status:<status>` event-kind slug
 *  ("never interrupt me about approvals"). Muting EITHER mutes the item. Exported so the
 *  integration layer (U7) and any settings UI key rules identically. */
export function conciergeTopics(agentId: string, status: AgentTabStatus): string[] {
  return [agentId, `status:${status}`];
}

/** Flatten a tray roster to agent id → status, keeping only statuses in the AGENT_STATUS taxonomy
 *  (the tray's field is a plain string that crossed the Rust boundary). Null/absent roster → {}. */
export function trayStatusMap(
  roster: Roster | null | undefined,
): Record<string, AgentTabStatus> {
  const out: Record<string, AgentTabStatus> = {};
  if (!roster) return out;
  for (const p of roster.projects) {
    for (const a of p.agents) {
      // Own-property check (NOT `in`): status is a raw string from the Rust boundary, so `in` would
      // also match Object.prototype keys ("toString", "constructor", …) and leak a bogus status.
      if (Object.hasOwn(AGENT_STATUS, a.status)) out[a.id] = a.status as AgentTabStatus;
    }
  }
  return out;
}

// Within-band rank: a live question (waiting/approval — the user is actively blocking) outranks
// the rest of its band. Mirrors windowStatus.attentionRank (module-private there).
function tierRank(status: AgentTabStatus): number {
  return status === "waiting" || status === "approval" ? 0 : 1;
}

// Sort key for a band, read off STATUS_BANDS' declared order rather than a second table here — the
// chips render top-to-bottom in that order, and the feed must not be able to disagree with them.
function bandRank(band: StatusBand): number {
  const i = STATUS_BANDS.findIndex((b) => b.id === band);
  return i === -1 ? STATUS_BANDS.length : i;
}

// Needs you → Running → Done; within a band live questions first, then most-recently-touched, then
// name — a total order (name last) so the rendered list is stable across rebuilds. Red still sorts
// above calm; what changed is that a RUNNING agent now sorts above a finished one instead of tying
// with it.
function compareAgents(a: ConciergeAgent, b: ConciergeAgent): number {
  return (
    bandRank(a.band) - bandRank(b.band) ||
    tierRank(a.status) - tierRank(b.status) ||
    (b.since ?? 0) - (a.since ?? 0) ||
    a.name.localeCompare(b.name)
  );
}

/** Build the concierge's cross-project status-band feed. Pure — no store reads, no Tauri. */
export function buildConciergeFeed(input: ConciergeFeedInput): ConciergeFeed {
  const {
    projects,
    workflowStage = {},
    branchStatus = {},
    openAgentIds = [],
    lastObserved = {},
    interaction = {},
    shouldInterrupt = () => true,
  } = input;
  const pinnedProjectId = input.pinnedProjectId ?? null;

  // Cross-window completeness: the tray's merged fleet fills statuses this window doesn't run;
  // the local live map wins wherever both know the agent.
  const observedStatus: Record<string, AgentTabStatus> = {
    ...trayStatusMap(input.roster),
    ...input.status,
  };

  // The same overlaid status every other surface bands/colors on. Run over the FLATTENED fleet so
  // a worker's red bubbles to its orchestrator regardless of which project holds them.
  const allAgents = projects.flatMap((p) => p.agents);

  // ── A RED IS A CLAIM ABOUT NOW (bead sparkle-7ba9e) ──────────────────────────────────────────
  //
  // Neither map above has a writer for an agent this window is not hosting: `input.status` is
  // written only by a MOUNTED `components/AgentPane`, and panes mount lazily per project, so an
  // unhosted agent's red is a frozen last reading that nothing can retract. The founder saw the
  // consequence — a "● BLOCKED:" pill above the composer naming an agent that was working, clearable
  // only by hand. `engine/movementRetraction` is the second witness: it retracts a red that the
  // agent's own artifacts show it has ACTED past.
  //
  // APPLIED HERE, BEFORE `publishedStatusFor`, and the order is load-bearing. That call bubbles a
  // worker's red onto its orchestrator and rolls subtrees up; retracting afterwards would clear the
  // worker while leaving the parent wearing a copy of a red whose owner is no longer red — a card
  // naming an agent that is fine, which is the exact shape `ConciergeAgent.redIsInherited` exists to
  // prevent. Retracting first means the stale red never enters the bubble at all.
  // Stamp the epochs from what was OBSERVED, before anything below can change it. Feeding the
  // post-retraction map instead would be circular and self-defeating: a retracted red leaves the
  // map, its epoch is dropped, and the next tick reads the still-frozen red as a NEW episode with a
  // NEW raise time that no earlier movement can beat — so the pill would return on every tick,
  // forever. The epoch belongs to when the red was first SEEN, not to whether it survived.
  //
  // PRUNED AGAINST THE FLEET, NOT AGAINST `observedStatus` — see `noteRedEpochs`. This window's
  // status view is PARTIAL until the cross-window roster arrives, and the ledger is shared, so
  // pruning on "absent from the status map" would let a just-mounted consumer wipe the very frozen
  // reds only the roster can see, for every consumer at once.
  //
  // MOVEMENT IS FOLDED IN AFTER the epochs are stamped, so a red raised THIS tick already has its
  // raise time to be compared against, and accumulated as a high-water mark so a later quiet tick
  // cannot un-retract it (the `Stop`-overwrites-the-work-event case).
  const ledger = input.retraction;
  const nowMs = input.nowMs ?? Date.now();
  if (ledger !== undefined) {
    noteRedEpochs(
      ledger,
      observedStatus,
      isDismissibleRed,
      nowMs,
      allAgents.map((a) => a.id),
    );
    noteMovement(ledger, (id) => input.agentMovement?.[id], nowMs);
  }
  const mergedStatus =
    ledger === undefined
      ? observedStatus
      : withMovementRetraction(allAgents, observedStatus, isDismissibleRed, ledger);
  // `rolledUpGreen` collects the heads whose `working` is their SUBTREE's, not their own. The away-
  // recap needs that distinction: a promoted head goes idle→working→idle purely because its worker
  // ran, which reads as the head finishing a job it never started (roborev 53886).
  const rolledUpGreen = new Set<string>();
  const derived = publishedStatusFor(
    allAgents,
    mergedStatus,
    new Set(openAgentIds),
    lastObserved,
    (id) => resolveStage(branchStatus[id], workflowStage[id]),
    rolledUpGreen,
    undefined, // `now` — this function has no injected clock of its own.
    // OUR OWN map, not the global store. It already feeds `since` below, and sourcing the two
    // independently let the feed emit `since: <the user's last touch>` alongside
    // `status: "new"` ("not briefed") for the SAME agent — and made route 4 untestable here
    // except by mutating a module singleton. Also what keeps the "Pure" claim above true.
    interaction,
  );

  // Band + parent for EVERY agent in the fleet, so representation can be resolved across projects
  // (a worker's orchestrator may live in another one — that is where publishedStatusFor, which runs
  // over this same flattened list, put its red).
  const bandById = new Map<string, StatusBand>();
  const parentById = new Map<string, string | null>();
  /** The routing hops — see `ConciergeAgent.redIsInherited`. Collected in the same pass that bands
   *  the fleet, because `isRepresented` below has to consult it: an ancestor that is only RELAYING a
   *  red does not speak for the worker that owns it, and treating it as though it did is what left
   *  the owner with no surface of its own. */
  const inheritedRed = new Set<string>();
  for (const a of allAgents) {
    const band = conciergeBand(derived[a.id] ?? DEFAULT_STATUS);
    bandById.set(a.id, band);
    parentById.set(a.id, a.parentId);
    if (band === "needs_you" && mergedStatus[a.id] === "working") inheritedRed.add(a.id);
  }

  /** WHICH present ancestor already carries this agent's band, or null. See
   *  `ConciergeAgent.representedElsewhere` for the rule, and `representedBy` for why the ANSWER is an
   *  id rather than a boolean: a surface that acts on a rollup card has to be able to reach the
   *  agents that card is standing in for.
   *
   *  Walks the chain rather than checking only the parent so a deeper nesting can't silently open the
   *  same hole, and carries a `seen` set because `parentId` is persisted data — a cycle in it must
   *  not hang the feed. An ABSENT ancestor ends the walk with `false`: a bubble aimed at an agent
   *  that is not in the fleet lands nowhere, which is the very case this exists to catch. */
  const representedBy = (agent: { id: string; parentId: string | null }): string | null => {
    const band = bandById.get(agent.id);
    const seen = new Set<string>([agent.id]);
    let pid = agent.parentId;
    while (pid !== null && !seen.has(pid)) {
      seen.add(pid);
      const parentBand = bandById.get(pid);
      if (parentBand === undefined) return null; // parent not in the fleet — nothing speaks for it
      // A HOP DOES NOT REPRESENT. Its band matches only because this agent's own red was bubbled
      // ONTO it while it was working, so counting it as "already spoken for" hands the alert to an
      // ancestor that is busy and silences the agent that owns it. Keep walking: a further ancestor
      // that is genuinely resting in this band still speaks for it.
      if (parentBand === band && !inheritedRed.has(pid)) return pid;
      pid = parentById.get(pid) ?? null;
    }
    return null;
  };

  const counts = emptyCounts();
  const scopedCounts = emptyCounts();
  const outProjects: ConciergeProject[] = projects.map((p) => {
    const inScope = pinnedProjectId === null || p.id === pinnedProjectId;
    const projectCounts = emptyCounts();
    // This project's share of the scoped total — incremented from the SAME gate below, never
    // recomputed, so the per-project split and the global number cannot disagree.
    const projectScoped = emptyCounts();
    // Closed over THIS PROJECT's agents, matching AgentSidebar exactly: the sidebar asks
    // `isTopLevelAgent(project.agents)`, so nesting is judged against the same population on both
    // sides. Judging it against the flattened fleet instead would call a worker whose orchestrator
    // lives in another project "nested" here, where it has no parent row to nest under.
    const isTopLevel = isTopLevelAgent(p.agents);
    // The heads this project's column actually draws, for `parentRowId`. Mirrors AgentSidebar's
    // own nesting exactly: it buckets by `parentId` and renders children only under a row where
    // `top.kind === "build"`, so a head that is not a present top-level build agent nests nothing.
    const rowHeadIds = new Set(
      p.agents.filter((a) => a.kind === "build" && isTopLevel(a)).map((a) => a.id),
    );
    const agents = p.agents.map((a): ConciergeAgent => {
      const status = derived[a.id] ?? DEFAULT_STATUS;
      const tok = AGENT_STATUS[status] ?? AGENT_STATUS[DEFAULT_STATUS];
      const band = conciergeBand(status);
      const muted = conciergeTopics(a.id, status).some((t) => !shouldInterrupt(t));
      const since = interaction[a.id];
      const topLevel = isTopLevel(a);
      // Not a row of its own, but a row nonetheless — see `parentRowId`. One level deep and
      // in-project, because that is all the sidebar draws.
      const parentRowId =
        !topLevel && a.parentId !== null && rowHeadIds.has(a.parentId) ? a.parentId : null;
      // A rowless agent an ancestor already speaks for. See `representedElsewhere` — this is what
      // stops one piece of work being counted twice (the red worker AND the orchestrator that
      // inherited its red), which is what made the vitals line and the thread disagree.
      const speaker = topLevel ? null : representedBy(a);
      const representedElsewhere = speaker !== null;
      const redIsInherited = inheritedRed.has(a.id);
      projectCounts[band]++;
      // The scoped view applies the SAME gates to every band (in scope per the pin, not muted, not
      // already spoken for), so "3 Running" shrinks when you pin exactly the way "3 Need you" does.
      // The old shape only ever scoped the interrupting tiers because it had no field for the rest.
      //
      // These are the counts column one STATES, and `ConciergeHost` derives the thread from the same
      // three gates — so the vitals number and the items the thread accounts for are one population
      // by construction, not two computations that happen to agree. `counts` above stays the raw
      // truth (every agent, once per agent), which is what the per-project tab badges read.
      // `redIsInherited` joins the gate for the same reason `representedElsewhere` is in it: both
      // mark an agent that is NOT the one this piece of work belongs to, and counting either would
      // state a number the thread does not show items for. The two are exact complements here — a
      // hop is excluded, and the descendant it was standing in for stops being represented and is
      // counted in its place — so the total is unchanged and the vitals line still equals what
      // column one accounts for.
      if (inScope && !muted && !representedElsewhere && !redIsInherited) {
        scopedCounts[band]++;
        projectScoped[band]++;
      }
      return {
        id: a.id,
        name: displayName(a),
        // This row is `working` only because its workers are. See ConciergeAgent.rolledUpGreen.
        rolledUpGreen: rolledUpGreen.has(a.id),
        // …and this row is RED only because a worker is, while it works on. See redIsInherited.
        redIsInherited,
        projectId: p.id,
        projectName: p.name,
        kind: a.kind,
        status,
        statusColor: tok.color,
        statusLabel: tok.label,
        band,
        ...(since !== undefined && since > 0 ? { since } : {}),
        inScope,
        muted,
        topLevel,
        parentRowId,
        representedElsewhere,
        representedBy: speaker,
      };
    });
    agents.sort(compareAgents);
    for (const b of STATUS_BANDS) counts[b.id] += projectCounts[b.id];
    return {
      id: p.id,
      name: p.name,
      inScope,
      counts: projectCounts,
      scopedCounts: projectScoped,
      agents,
    };
  });

  return { projects: outProjects, counts, scopedCounts, pinnedProjectId };
}
