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
import { ASKING_BANDS, STATUS_BANDS, bandOfStatus, type StatusBand } from "../engine/buildSections";
import { resolveStage, type WorkflowStageId } from "../engine/workflowStage";
import { isDismissibleRed } from "../engine/alertDismissal";
import {
  noteMovement,
  noteRedEpochs,
  withMovementRetraction,
  type MovementEvidence,
  type RetractionLedger,
} from "../engine/movementRetraction";
import {
  notePromptEpisodes,
  withBlockedPromptGrace,
  type PromptAsk,
  type PromptGraceLedger,
} from "../engine/blockedPromptGrace";
import { publishedStatusFor } from "../useAttentionNotifications";
import type { NudgeFlagSnapshot } from "./humanBlockFor";
import type { BranchStatus } from "./branchStatus";
import type { Roster } from "./rosterTypes";
// Used only by the column-one population selectors at the foot of this file.
import { accountedNeedsYou } from "./conciergeProactive";
import { isSparkleAgentId } from "./sparkleAgent";
import { findKnownAgent } from "./knownAgents";
import type { AwaySnapshot } from "./conciergeRecap";
import type { AgentKind, LastObserved, Project } from "../types";

export interface ConciergeAgent {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  kind: AgentKind;
  status: AgentTabStatus;
  /** Did THIS WINDOW observe this agent's status, or is `status` a stand-in — or another window's
   *  reading relayed through the tray roster?
   *
   *  THE NAME CARRIES THE RESTRICTION ON PURPOSE (roborev 65208). An earlier spelling was
   *  `statusObserved`, whose first sentence promised the broader "was it observed anywhere", and the
   *  two answers DIVERGE for a cross-window row in the direction the broad name does not suggest:
   *  `trayStatusMap(input.roster)` can carry a perfectly genuine reading — the hosting window
   *  published `working` — so `status` is emphatically not a stand-in, yet this is `false`. Harmless
   *  today, because the only consumer governs a locally hosted pane; not harmless for the next
   *  consumer that reads the field by its name and gets a silent wrong answer on every unhosted row.
   *  That is the prose-vs-code divergence this whole series exists to remove, so it does not get to
   *  live in the field's own header.
   *
   *  WHY IT EXISTS. `status` cannot answer the question and one caller must not guess: the feed
   *  substitutes `DEFAULT_STATUS = "stopped"` for a missing entry, and `runtimeStore.status` is
   *  live-only with a mounted `AgentPane` as its sole writer — so before the first `setStatus` an
   *  agent reads `stopped`, indistinguishable from a PTY that genuinely exited.
   *
   *  WHY THE LOCAL MAP AND NOT THE MERGED ONE. The roster is not an independent witness: it
   *  republishes our own `DEFAULT_STATUS` stand-in and hands it straight back, so a merged read
   *  cannot tell an observation from an echo of our own guess (roborev 65188). See the assignment
   *  for the full four-hop chain.
   *
   *  Harmless for the band, the dot and the label (an unobserved agent SHOULD read as not-running).
   *  Not harmless for the terminal's calm theme, which means "this process has exited": a freshly
   *  mounted pane painted grey and snapped to full contrast the instant the engine emitted
   *  `working` — the mount-state flash, in the grey→white direction (bead sparkle-e7a3f3).
   *  `Workspace.terminalCalm` requires this to be true. */
  statusObservedLocally: boolean;
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
  /** The nudger flag table — which agents have answered that a PERSON is blocking them.
   *
   *  ⚠️ THREADED IN FOR THE SAME REASON `interaction` IS — the "Pure" claim above (roborev 65448).
   *
   *  ⚠️ AND OMITTING IT DEMOTES, IT DOES NOT FALL BACK TO THE LIVE TABLE (roborev 65473). An earlier
   *  version of this sentence said the opposite, which is the dangerous reading: this function
   *  destructures a `new Map()` default and passes it UNCONDITIONALLY, so `publishedStatusFor`'s own
   *  live-registry default can never apply on this path. A caller that leaves this out therefore
   *  gets an EMPTY table — no agent exempt, every stated human block demoted back to amber across
   *  the whole feed — rather than the correct-by-accident behaviour the old comment implied.
   *
   *  ⚠️ OPTIONAL, AND ITS DEFAULT IS THE DEMOTING ONE — stated plainly because the commit that added
   *  it claimed the compiler holds this seam, and it does not (roborev 65465). With 54 call sites,
   *  making it REQUIRED is churn rather than safety; what actually holds the production wiring in
   *  place is `useConciergeFeed.test.tsx`'s after-mount test, which fails if the caller stops
   *  passing this. Do not read the comment on the caller's dep array as a compiler guarantee. */
  nudgeFlags?: NudgeFlagSnapshot;
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
  /** WHICH DRAWN PROMPTS ARE BEING HELD BACK while an automated answerer works — a caller-owned
   *  ledger this builder both MUTATES (`notePromptEpisodes`) and reads (`withBlockedPromptGrace`),
   *  exactly like `retraction` above and for the same reason: the episode has to be opened against
   *  the merged status, and that merge only exists in here.
   *
   *  OMITTED MEANS NO HOLD, which is precisely today's behaviour — every existing caller and every
   *  existing test is unchanged by this field's arrival. See `engine/blockedPromptGrace` for the
   *  whole rule; the short version is that a routine permission dialog an answerer disposes of in
   *  under a second must not spend a second in the founder's needs-you list. */
  promptGrace?: PromptGraceLedger;
  /** The captured ask screen per agent (runtimeStore.attentionScreen) — what the hold's identity is
   *  hashed from. NO TEXT → NO IDENTITY → NO HOLD: a rule that cannot tell two prompts apart cannot
   *  honour "never suppress the same prompt twice", so it declines to run rather than guess. Omit
   *  for no hold. */
  attentionScreen?: Record<string, string>;
  /** When each `attentionScreen` entry was WRITTEN (runtimeStore.attentionScreenAt) — the instant the
   *  30s ceiling is measured from.
   *
   *  A SIBLING MAP, mirroring the store's own shape (bead sparkle-5wbhn) rather than collapsing the
   *  pair into `{ text, at }` here: the two are written in lockstep by `runtimeStore`, and re-shaping
   *  them at this boundary would give the feed a third representation to keep in step. Its absence is
   *  not fatal — an entry with no timestamp measures from `nowMs` instead, which merely means a
   *  prompt that predates this window's first observation earns a fresh window rather than surfacing
   *  at once. */
  attentionScreenAt?: Record<string, number>;
  /** The clock, for tests. Defaults to `Date.now()`; read by the red-epoch stamp and the prompt
   *  grace window (which is the SAME clock on purpose — two would let the epoch a hold is measured
   *  from and the moment it is judged against disagree inside one rebuild). */
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
 *  THE ONE-LINE ANSWER: only once its PROCESS HAS EXITED. `{done, stopped}`, and nothing else.
 *
 *  HISTORY, because this predicate used to mean something bigger and the old name still shows in
 *  places: it also drove a `grayscale(1) opacity(.72)` CSS filter over the agent's SIDEBAR ROW, so
 *  that only the rows asking for you carried color. That was removed on 2026-07-27 and must not
 *  come back. `working` WAS in the calm set at the time, so the filter desaturated the green dot of
 *  every agent that was actually running — erasing the one thing the Build column exists to show at
 *  a glance. That membership is gone (bead sparkle-e7a3f3), but the removal still stands on its own:
 *  the rows carry status by DOT COLOR now, and a filter over them would fight that whatever this
 *  predicate answers. The row treatment is gone entirely rather than gated; see
 *  AgentSidebar.liveStatusDots.test.tsx, which fails if any row regains an inline filter.
 *
 *  What survives is the TERMINAL treatment (Workspace.tsx → AgentPane → Terminal → xtermTheme),
 *  which desaturates an EXITED agent's own text through the theme rather than a filter over the
 *  stage. That distinction has its own history — see the `calm is a terminal theme, not a filter
 *  over the pane` commits.
 *
 *  THE SET CHANGED (bead sparkle-e7a3f3); the reasoning below is why it is shaped the way it is.
 *
 *  Deliberately NOT "is this row's band `done`", and deliberately NOT "is it anything but
 *  needs_you" alone. The set is exactly {done, stopped} — the two statuses whose PTY has exited.
 *  `unmerged` is excluded for free by that shape, and its carve-out is documented below because the
 *  reasoning still governs anyone tempted to widen this again.
 *
 *  `idle` IS EXCLUDED, and it is the second half of bead sparkle-e7a3f3. Dropping only `working`
 *  did not remove the flash, it RELOCATED it — and made it recur. `StatusEngine.settle()` fires on
 *  a `setTimeout(…, IDLE_MS = 2500)` and sets `idle` whenever the viewport is not awaiting input,
 *  i.e. ~2.5s after every response finishes streaming. With `working` non-calm and `idle` calm, the
 *  END of each turn became the theme swap: the founder's reply repainted from near-white to grey
 *  about two and a half seconds after it landed — while he was reading it — and back to white on
 *  the next turn. Once per turn, forever, instead of once. `working` and `idle` must therefore
 *  answer this predicate IDENTICALLY; they are two halves of one live session, not two states.
 *
 *  `undefined` IS EXCLUDED TOO, for the same reason in the other direction: an agent the feed has
 *  not seen yet is the MOUNT state, so admitting it painted a pane grey and flipped it to white on
 *  first output. A flash is a flash whichever way it runs.
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
 *  `working` IS EXCLUDED, and it is the whole of bead sparkle-e7a3f3. It used to be IN the calm set,
 *  guarded by a comment and a test that both spelled out the requirement — "the terminal you are
 *  watching desaturating the moment it starts working would be a treatment nobody wants" — while
 *  the assertion beside it pinned `isCalmBand("working") === true`, i.e. exactly that treatment.
 *  The prose stated the rule and the code did the opposite for as long as both existed.
 *
 *  What the founder actually saw, and why it reads as a FLASH rather than as a wrong colour: an
 *  agent that is asking you something bands `needs_you`/`questions`, so its terminal carries the
 *  normal foreground (dark-mode `#dce8fc`, a near-white). You answer it; it starts running; the
 *  status flips to `working`; this predicate said calm; Workspace re-hands xterm a whole new theme
 *  object, and xterm re-resolves EVERY cell that carries no explicit SGR colour — which is most of
 *  a TUI's body text, Claude Code included: a live PTY capture of its own output paints the prompt
 *  and the response with `\e[39m` (default foreground) and reserves truecolor for its chrome. So
 *  the text ALREADY ON SCREEN turned from near-white to `#7d818e` grey, retroactively. White first,
 *  then grey, on the one pane you are reading.
 *
 *  The band split running from done for POSITION and COUNTS. Dimming is a legibility treatment and
 *  a running agent is the single worst thing to apply it to: `terminalCalm` (Workspace.tsx) is only
 *  ever true for the VISIBLE, SELECTED pane, so calm never recedes anything you are not looking at.
 *  Its counterpart — the sidebar row filter that made quiet rows recede so colored ones stood out —
 *  was removed on 2026-07-27. What was left applied only to the terminal in front of you.
 *
 *  `questions` IS EXCLUDED TOO, for the plainest possible reason: an agent that has stopped to ask
 *  the founder something is not calm. Desaturating its terminal would be the mirror of the trap
 *  above — the row the founder most needs to read is the one this would make hardest to read. Note
 *  it must be named explicitly, because the predicate is written as "not needs_you" and `questions`
 *  is its own band; the negative form is exactly what let a fourth band silently fall into "calm". */
export function isCalmBand(status: AgentTabStatus | undefined): boolean {
  // AN ALLOW-LIST OF TWO, AND NOTHING ELSE IN THE EXPRESSION. `done` and `stopped` are the only
  // statuses whose PTY HAS EXITED — statusEngine emits `done` from exactly one place, the
  // `process-exit` transition, and `stopped` is its explicit twin. Every other value is a state a
  // LIVE session moves through, and any live state admitted here is a flip the founder can watch.
  //
  // The band guards that used to be conjoined here were DEAD, not defensive: `bandOfStatus`
  // (engine/buildSections.ts) maps both `done` and `stopped` to the `done` band, so once the
  // allow-list holds, `band !== "needs_you" && band !== "questions" && band !== "running"` is
  // unconditionally true. Keeping them cost real verification — a mutation to any of the three
  // could not turn a test red — while the comment above them claimed the expression was an
  // allow-list and not a negation. It is one now.
  return status === "done" || status === "stopped";
}

/** Is this agent's work WAITING ON THE USER — i.e. is it something he owes an action on?
 *
 *  FOUNDER'S RULING, 2026-08-05 (bead sparkle-qogah): "We should never hide a row that needs action
 *  from me." Asked directly whether "Needs merge" belongs in the concierge's WANTS YOU column, he
 *  chose: "Yes, but as one honest group — one row reading '27 need merge' that expands in place.
 *  Nothing hidden, count is true, column stays readable."
 *
 *  So this is DELIBERATELY WIDER THAN THE BAND, and the two must not be collapsed into each other:
 *
 *   • `band === "needs_you"` is the INTERRUPTION BUDGET — what earns a red nudge card and a tab
 *     glow. `unmerged` is correctly out of it (see `conciergeBand`): landing state must not buy an
 *     interruption, and 27 of 51 agents in that band would have meant 27 nudge cards.
 *   • THIS predicate is the ACCOUNTING — what the column may not report zero of while it exists.
 *     Excluding `unmerged` from the interruption was right; excluding it from the COUNT is what let
 *     column one say "0 Need you" over a fleet with 27 un-landed PRs. A number that sounds complete
 *     while concealing work is the exact false confidence the bead exists to remove.
 *
 *  The fix for "too many cards" is GROUPING, not exclusion — see conciergeDigest's `unmerged`
 *  variant, which collapses them into the one honest line the founder asked for.
 *
 *  IT IS THE ASKING BANDS PLUS `unmerged`, and the narrowness is a ruling, not an oversight. In
 *  the same interview he ruled "Done — your turn" / idle / finished INFORMATIONAL: those may be
 *  capped, summarised, or dropped. Only a blocking prompt and un-landed work are actions he owes.
 *  Widening this to `idle` would put the whole `done` band back in the count and make the number
 *  meaningless again, in the other direction.
 *
 *  READS `ASKING_BANDS` RATHER THAN NAMING `needs_you`, because naming it was wrong the moment a
 *  fourth band landed: `questions` means the agent cannot proceed without you, and this predicate
 *  counted it as calm — so an all-questions fleet made column one say "0 Need you" while every
 *  agent on it was blocked on him. Identical to the `unmerged` defect two paragraphs up, entered
 *  through the newest band, and the FOURTH surface in this change set with one cause: a set of
 *  askers enumerated by name or colour instead of derived from the taxonomy. Derived here, so the
 *  fifth band is a decision in engine/buildSections rather than another silent omission. */
export function isOwedAction(a: Pick<ConciergeAgent, "band" | "status">): boolean {
  return ASKING_BANDS.includes(a.band) || a.status === "unmerged";
}

/** The THREE GATES the concierge surfaces anything through: in scope (per the pin), not muted, and
 *  not already spoken for by an ancestor's row (either because it is represented there, or because
 *  this agent is only a routing hop for a descendant's red).
 *
 *  ONE EXPRESSION, used by `buildConciergeFeed` to accumulate `scopedCounts` and by every selector
 *  below. That is why it is a function and not four inline `&&`s repeated per call site: a count the
 *  column STATES and a list the column SHOWS that are gated by two copies of this rule is precisely
 *  how the vitals line and the thread came to disagree (see the `scopedCounts` accumulation below).
 *
 *  `services/conciergeProactive.accountedNeedsYou` still spells the same four terms out by hand —
 *  it predates this helper and lives one layer up. It should delegate here; until it does, the two
 *  are pinned equal by `conciergeFeed.test.ts` → "the two copies of the accounting gate agree",
 *  which compares `accountedNeedsYou` against `accountedOwed`'s needs-you half over a mixed fleet.
 *
 *  That sentence used to claim the pin WITHOUT the test existing (roborev 59062): `accountedOwed`
 *  had no reference outside this file, so a comment asserted a guarantee nobody had written. If you
 *  make the hand-written copy delegate, delete the test with it — but never the other way round. */
export function isAccounted(
  a: Pick<ConciergeAgent, "inScope" | "muted" | "representedElsewhere" | "redIsInherited">,
): boolean {
  return a.inScope && !a.muted && !a.representedElsewhere && !a.redIsInherited;
}

/** Every agent in the feed, in rendered order, across all projects. */
export function allAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return feed.projects.flatMap((p) => p.agents);
}

/** What the column ACCOUNTS FOR, split by why. `total` is the number that may never read zero while
 *  either half is non-empty — the founder's "nothing hidden, count is true".
 *
 *  The two halves are DISJOINT by construction (`unmerged` bands `done`, never `needs_you`), so
 *  `total` is a sum and not a union that could double-count one agent. */
export interface ConciergeOwedCounts {
  /** Blocking prompts: waiting · approval · blocked · errored. Equal to `scopedCounts.needs_you`. */
  needsYou: number;
  /** Committed-but-unlanded work — "Needs merge". */
  unmerged: number;
  /** `needsYou + unmerged`. Kept as a field rather than left to each caller to add up: the whole
   *  point is that one number is stated, and a caller that forgot a term is the bug again. */
  total: number;
}

/** Agents the column owes an action on, in feed order (Needs you first, then the unmerged). */
export function accountedOwed(feed: ConciergeFeed): ConciergeAgent[] {
  return allAgents(feed).filter((a) => isAccounted(a) && isOwedAction(a));
}

/** The un-landed half of {@link accountedOwed} — the digest's `unmerged` pool.
 *
 *  NOT filtered to `topLevel`, unlike the needs-you digest's pool. A `rows` line's count is a
 *  promise that its click leaves exactly that many ROWS standing in column two, so a worker folded
 *  into it would state a number the click cannot produce. The unmerged line makes no such promise:
 *  it EXPANDS IN PLACE (`ConciergeDigestGroup.memberIds`), so every member it counts is reachable
 *  from the line itself whether or not column two would draw a row for it. Filtering here would
 *  reintroduce the omission this whole change exists to remove — quietly, for exactly the workers
 *  with the least other representation. */
export function accountedUnmerged(feed: ConciergeFeed): ConciergeAgent[] {
  return allAgents(feed).filter((a) => isAccounted(a) && a.status === "unmerged");
}

/** The honest tally column one states. See {@link ConciergeOwedCounts} and {@link isOwedAction}. */
export function owedCounts(feed: ConciergeFeed): ConciergeOwedCounts {
  const owed = accountedOwed(feed);
  const unmerged = owed.filter((a) => a.status === "unmerged").length;
  return { needsYou: owed.length - unmerged, unmerged, total: owed.length };
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
    nudgeFlags = new Map(),
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
  const retractedStatus =
    ledger === undefined
      ? observedStatus
      : withMovementRetraction(allAgents, observedStatus, isDismissibleRed, ledger);

  // ── A PROMPT SOMEBODY IS ABOUT TO ANSWER IS NOT YET THE FOUNDER'S PROBLEM ────────────────────
  //
  // The rule, and every word of the reasoning behind it, lives in `engine/blockedPromptGrace`. Two
  // placement decisions are made HERE, and both are load-bearing.
  //
  // (1) BEFORE `publishedStatusFor`, for the identical reason retraction is. That call bubbles a
  // worker's red onto its orchestrator and rolls subtrees up; holding afterwards would calm the
  // WORKER while leaving the parent wearing a copy of a red whose owner is calm — a needs-you row
  // naming an agent that is not asking, which is exactly what this is trying to remove. Holding
  // first means the held prompt never enters the bubble at all.
  //
  // (2) AFTER `withMovementRetraction`, which is the less obvious call, so: the two overlays produce
  // the SAME output in either order (retraction only ever de-escalates a red, and a de-escalated
  // status is no longer a demonstrated ask, so whichever runs second finds nothing left to do). What
  // the order really decides is which map the MUTATOR observes — and an episode carries a cost the
  // overlay does not. Opening one BURNS that prompt's identity, permanently and by design ("never
  // suppress the same prompt twice"), so a burn spent on a red that retraction was about to withdraw
  // is a burn the same question cannot spend later when it is genuinely re-drawn. Retraction answers
  // the prior question — is this red even a claim about NOW? — so it goes first, and an episode is
  // only ever opened for a prompt the founder would otherwise really have seen.
  //
  // Same clock as the epoch stamp above (`nowMs`), never a second `Date.now()`: the instant a hold is
  // measured from and the instant it is judged against must not be able to disagree within one build.
  const promptGrace = input.promptGrace;
  let mergedStatus = retractedStatus;
  if (promptGrace !== undefined) {
    const askOf = (id: string): PromptAsk | undefined => {
      const text = input.attentionScreen?.[id];
      if (text === undefined) return undefined;
      const at = input.attentionScreenAt?.[id];
      return at === undefined ? { text } : { text, at };
    };
    const fleetIds = allAgents.map((a) => a.id);
    notePromptEpisodes(promptGrace, retractedStatus, askOf, nowMs, fleetIds);
    mergedStatus = withBlockedPromptGrace(allAgents, retractedStatus, promptGrace, nowMs);
  }
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
    undefined, // `thrashOf` — the live registry default is correct here.
    undefined, // `isFinishedOf` — this surface polls no git state of its own.
    undefined, // `deathCauseOf` — live window-local registry default.
    undefined, // `hasBackgroundTasksOf` — live registry default.
    // Passed for the same purity reason as `interaction` directly above (roborev 65448), and always
    // passed — so `publishedStatusFor`'s live-registry default is unreachable from here and the
    // input's own `new Map()` default is what a caller omitting it actually gets: nobody exempt
    // (roborev 65473). A MAP rather than a predicate so it cannot be transposed with the
    // identically-typed `hasBackgroundTasksOf` beside it (65465).
    nudgeFlags,
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
      // OBSERVEDNESS IS READ FROM THE LOCAL LIVE MAP, NOT FROM `derived`, and that is the whole of
      // roborev 65188. `derived` descends from `observedStatus`, which merges `trayStatusMap(roster)`
      // UNDER `input.status` — and the roster is not an independent witness: `buildRoster` publishes
      // `calmNewAgent(status[a.id], …) ?? DEFAULT_STATUS`, `calmNewAgent(undefined, …)` returns
      // `undefined`, and `get_roster` hands every window its OWN slice back. So an agent nobody has
      // a reading for is published as `"stopped"` and returns as a first-class entry — the roster
      // echoing our own stand-in. Reading `derived` therefore called that echo an observation, and
      // `statusObserved` flipped true one publish + one `roster://changed` tick after mount, exactly
      // restoring the grey→white mount flash it was added to remove.
      //
      // The local map is the right source rather than a narrower one: the only consumer is
      // `Workspace.terminalCalm`, which governs the LOCALLY HOSTED visible pane, so a cross-window
      // row never needs an answer to this question.
      //
      // INTENDED CONSEQUENCE, stated here rather than discovered later: an agent restored after a
      // restart whose process genuinely DID exit reads unobserved, so its terminal stays at full
      // contrast until something writes a status. That is the honest reading of "we did not look",
      // and full contrast is the safe side of that uncertainty — a pane that is too legible costs
      // nothing, a pane that greys the text you are reading is the bug.
      const statusObservedLocally = input.status[a.id] !== undefined;
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
      //
      // THE GATE ITSELF IS `isAccounted`, not four inline terms — the selectors above
      // (`accountedOwed` / `accountedUnmerged` / `owedCounts`) apply the identical expression to the
      // built feed, so the number the column states and the items it can show are one population by
      // construction rather than two copies that have to be kept in step.
      const out: ConciergeAgent = {
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
        statusObservedLocally,
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
      if (isAccounted(out)) {
        scopedCounts[band]++;
        projectScoped[band]++;
      }
      return out;
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

// ══ COLUMN-ONE POPULATION SELECTORS ═════════════════════════════════════════════════════════════
// Moved verbatim out of components/ConciergeHost, which is where they had accumulated. They belong
// here: this module already owns `isAccounted`, `accountedOwed` and `accountedUnmerged`, and these
// are the same family — "which agents does column one account for, and which of them get a row".
// Having them in a React component meant a second agent could not touch the surfacing rule without
// editing the app's highest-churn file.
//
// ONE OF THE NINE DID NOT COME ACROSS: the host carried its own `allAgents`, byte-identical to the
// one this module already had (`feed.projects.flatMap((p) => p.agents)`), which was private until
// now. The duplicate is dropped and the existing one exported — same function, one definition.

/** Does THIS window hold a promptable target with this id? Feed membership, OR the app-owned Sparkle
 *  agent, which is never a feed member (services/knownAgents) but IS a live local PTY whenever its
 *  pane is mounted — so feed membership ALONE reads the Improve-Sparkle mount as "gone" and strands
 *  every send at the brain (bead sparkle-0rf5). For any non-sparkle id this is exactly the old
 *  `allAgents(feed).some(...)` test, so no other target's resolution changes. */
export function isPromptableTarget(feed: ConciergeFeed, id: string | undefined): boolean {
  if (!id) return false;
  if (allAgents(feed).some((a) => a.id === id)) return true;
  return isSparkleAgentId(id) && findKnownAgent(id)?.source === "sparkle";
}

/**
 * The fleet's statuses AS THE CARDS SEE THEM, for the Away recap's two edges.
 *
 * Read from the FEED, never from `runtimeStore.status`, and that is the whole point (roborev
 * 53631-H2). The feed's per-agent status is the DERIVED/published one — the cross-window merged
 * roster plus the unstarted-worker, red-worker, unmerged and dismissed-alert overlays
 * (services/conciergeFeed → publishedStatusFor) — and it is what every `statusLabel` and every
 * nudge card in this thread already speaks. Diffing the raw store against feed-supplied labels made
 * them two vocabularies, with two visible failures:
 *
 *   • `runtimeStore.status` only holds agents THIS window hosts (useConciergeFeed), so a
 *     roster-fed agent was absent from BOTH sides of the diff and `newlyEntered` skipped it — the
 *     recap said nothing about an agent in another window that went `waiting` while the same
 *     thread rendered a nudge card for it. On a concierge column pinned to a project this window
 *     does not host, the recap could never fire at all.
 *   • A red the user had DISMISSED reads de-escalated (`idle`/`stopped`) in the feed but still
 *     `waiting` in the raw store, so the recap filed it under "Wants you" while printing the feed's
 *     "Done — your turn" beside it — resurfacing an alarm the user had explicitly silenced.
 *
 * Building both sides here makes status, label and card one vocabulary by construction, and picks
 * up cross-window agents for free.
 */
export function feedStatuses(feed: ConciergeFeed): Omit<AwaySnapshot, "at"> {
  const agents = allAgents(feed);
  return {
    status: Object.fromEntries(agents.map((a): [string, AgentTabStatus] => [a.id, a.status])),
    agentIds: agents.map((a) => a.id),
    // Carried so the recap can tell a head that was genuinely working at the away edge from one
    // standing in for its subtree — see AwaySnapshot.rolledUpGreen.
    rolledUpGreen: agents.filter((a) => a.rolledUpGreen).map((a) => a.id),
  };
}

/** EVERYTHING column one accounts for right now: in scope, un-muted, needing you, and not already
 *  spoken for by an ancestor's row.
 *
 *  `band === "needs_you"` is the interruption gate. It covers exactly what the old `priority < 2`
 *  did — waiting, approval, blocked, errored — and, critically, still excludes `unmerged`, which
 *  bands `done`. On the reported fleet 27 of 51 agents were committed-but-unlanded; surfacing them
 *  here is 27 nudge cards (see services/conciergeFeed.conciergeBand).
 *
 *  These are THE SAME THREE GATES `conciergeFeed` counts `scopedCounts` on, and that is the point:
 *  the vitals line states `scopedCounts.needs_you` while the thread renders this list, so they are
 *  one population by construction rather than two computations that have to be kept in step. They
 *  did drift — `scopedCounts` counted a red worker AND the orchestrator that inherited its red, so
 *  the line said "2 Need you" over a thread holding one card.
 *
 *  Note the remaining asymmetry is the SAFE direction. `muted` can make this set smaller than the
 *  rows the filter leaves standing, so the sentence can under-state. That is fine — every row it
 *  promised is there, plus one you asked not to be interrupted about. Over-stating is the bug,
 *  because the missing rows do not exist to be shown.
 *
 *  ONE IMPLEMENTATION, in services/conciergeProactive — this delegates rather than restating the
 *  filter (roborev 54166-M5). The proactive push channel builds its prompt from the same population
 *  and the two copies were verbatim duplicates, which is exactly the drift the paragraph above is
 *  about: the brain would announce, unprompted, a count this column does not show. It lives there
 *  and not here because that module is pure and React-free, so the rule is testable as data. */
export function accountedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return accountedNeedsYou(feed);
}

/** The half of {@link accountedAgents} that is OWED A ROW in column two — the digest's pool.
 *
 *  `topLevel` is what makes the digest's number honest. Every LINE this feeds is clickable, and the
 *  click isolates that band in the Build column — which narrows top-level rows and nothing else.
 *  Folding a worker into a line's count would state a number the click cannot produce: two blocked
 *  workers rendered "2 Need you in web", and clicking it left an empty column plus an empty-state
 *  chip. */
export function surfacedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return accountedAgents(feed).filter((a) => a.topLevel);
}

/** The other half: accounted-for agents with NO row of their own, which therefore have to speak for
 *  themselves.
 *
 *  They are digested by the SAME rule as everything else — one keeps its card, two or more become a
 *  line — but as the `rowless` variant, because a normal line's count is a promise about rows and
 *  these have none. This population is NOT bounded by one: gap 3 below fires once per blocked
 *  worker, so several under an absent or in-motion parent used to be several cards, which is the
 *  card wall the digest exists to prevent, reintroduced through the one path that skipped it.
 *
 *  What survives from the card era is the AFFORDANCE, not the shape: a single one still gets a card
 *  whose "Show me" reveals it (`openProjectTab` selects it, and the sidebar pops a red worker out
 *  under its orchestrator), and the collapsed line's click does that same reveal for its lead.
 *
 *  Non-empty only when a rowless agent's red reached nobody — a worker with no `parentId`, one whose
 *  orchestrator is not in the fleet, or a `blocked` one whose bubble `withRedWorkerAttention`
 *  suppressed while its orchestrator was in motion. Before this existed, the `topLevel` gate turned
 *  all three into silence: no row, no card, no line, no count. See
 *  `ConciergeAgent.representedElsewhere` for why the test is band equality and not kind. */
export function unrepresentedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return accountedAgents(feed).filter((a) => !a.topLevel);
}

/** The part of {@link unrepresentedAgents} a LINE may collapse: those that do get a nested row.
 *
 *  A digest line's click reveals exactly one agent, so collapsing is only honest when the click can
 *  nonetheless put the WHOLE group on screen. That is not a free property of the sidebar — it is
 *  something the click has to DO. The original version of this comment claimed the former ("reveal
 *  one and the siblings are on screen beside it") and was wrong twice over: `collapsedOrchestrators`
 *  reads a missing entry as collapsed, so on a fresh launch the subtree is shut, and a leftover band
 *  filter can drop the head entirely (roborev 53679, then 53734).
 *
 *  So the guarantee is attributed where it actually lives: `revealAgent` and the rowless branch of
 *  `onDigestClick` call `showAllStatusBands()` + `expandOrchestrators(...)` before opening. What
 *  makes this population collapsible is having a head at all — one the click can name and open. */
export function nestedRowlessAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return unrepresentedAgents(feed).filter((a) => a.parentRowId !== null);
}

/** The part that may NOT be collapsed: accounted-for agents with no row ANYWHERE.
 *
 *  A worker with no `parentId`, or one whose orchestrator is not in this project's fleet, is not
 *  drawn by column two at all — not as a head, not as a child. Its nudge card's "Show me" is its
 *  ONLY affordance in the app, so folding several into one line strands all but the lead: the line
 *  read "2 workers inside web need you" and the click could satisfy one of them, with no way to
 *  reach the other until the first resolved (roborev 53679).
 *
 *  So these stay one card each, on purpose. That is not the card wall coming back — the wall is the
 *  HIGH-VOLUME case, a blocked worker under a present-but-in-motion orchestrator, which fires once
 *  per worker and is exactly what {@link nestedRowlessAgents} still collapses. This population is
 *  the rare ancestor-less remainder, and a card apiece is the cheapest thing that keeps every one of
 *  them reachable. */
export function strandedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return unrepresentedAgents(feed).filter((a) => a.parentRowId === null);
}
