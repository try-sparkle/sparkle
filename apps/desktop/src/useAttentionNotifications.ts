// Drives the dock badge + Notification Center banners off live agent status, and routes a
// notification click back to the exact worker that asked. Mounted once per window (inside the
// CurrentProjectProvider) by <AttentionController/>.
//
// Each window owns ONE project, so it only knows/reports the status of that project's agents:
//  - badge: report this window's red count; the backend sums across windows (the macOS dock
//    badge is app-global) — see attention.rs.
//  - notification: fire once when an agent crosses INTO a status the user has enabled for
//    notifications (Settings ⋯ → Notifications; newlyEntered), not on every tick. Switching the
//    window to a different project re-baselines silently so the switch itself doesn't ping you
//    for agents that were already in a notifiable status.
//  - click: the backend broadcasts attention://focus-agent to every window; the window that
//    owns that project brings itself forward and selects the agent (main adopts an orphaned
//    project no window is currently showing).
import { useEffect, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  countAttention,
  needsAttention,
  newlyEntered,
  notificationFor,
  suppressNotification,
  type StatusMap,
} from "./engine/attention";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useScrollIntentStore } from "./stores/scrollIntentStore";
import { useProjectStore } from "./stores/projectStore";
import {
  useCurrentProjectId,
  useCurrentWindowLabel,
  useIsMainWindow,
  useReplaceCurrentProject,
} from "./windowContext";
import {
  reportAttentionCount,
  notifyAttention,
  summarizeAttention,
  onFocusAgent,
  onSelectProject,
  onFocusTier,
  type FocusAgentPayload,
  type SelectProjectPayload,
  type FocusTierPayload,
} from "./services/attention";
import { agentExists, selectAndOpen } from "./services/agentReveal";
import { openProjectTab } from "./services/openProjectTab";
import { useUiStore } from "./stores/uiStore";
import { emitAttention, emitResolved } from "./services/relayClient";
import { reportAttentionSource } from "./services/selfReportObservability";
import type { AttentionSource } from "./stores/selfReportMetrics";
import { getAgentScrollback } from "./services/terminalScrollback";
import { suggestedRepliesFor } from "./services/suggestions/attentionReplies";
import { safeUnlisten } from "./services/safeUnlisten";
import { withDismissedAlerts, alertControlKind } from "./engine/alertDismissal";
import { isInMotion } from "./engine/inMotion";
import { isActivityStale } from "./engine/activityFreshness";
import {
  rollupDotAccessor,
  withWorkerRollupGreen,
  withBackgroundTaskGreen,
  type RollupDot,
} from "./engine/workerRollup";
import { hasLiveBackgroundTasksForAgent } from "./services/backgroundTaskRegistry";
import { withUnmergedWork } from "./engine/unmergedAttention";
import { withNewAgentCalm } from "./engine/newAgentAttention";
import { withDeadSessionCalm } from "./engine/deadSessionAttention";
import { deathCauseForAgent } from "./services/deadSessionRegistry";
import { isHumanBlockedIn, type NudgeFlagSnapshot } from "./services/humanBlockFor";
import { nudgeFlagsSnapshot } from "./services/authRecovery";
import type { DeathCause } from "./engine/deathTypes";
import { useNewAgentCalm } from "./hooks/useNewAgentCalm";
import { withBlockedPromptGrace, windowPromptGraceLedger } from "./engine/blockedPromptGrace";
import { usePromptGraceTick } from "./hooks/useBlockedPromptGrace";
import { useInteractionStore } from "./stores/interactionStore";
import {
  withRedWorkerAttention,
  withUnstartedWorkerAttention,
  type LastObservedMap,
} from "./engine/workerAttention";
import { resolveStage } from "./engine/workflowStage";
import { withNudgeLoopCalm } from "./engine/nudgeLoopCalm";
import { withFinishedHeadCalm } from "./engine/finishedHeadCalm";
import { thrashReportFor, type ThrashReport } from "./engine/agentThrash";
import type { AgentTab, AgentTabStatus } from "./types";
import { projectNameForAgent } from "./services/creditProject";

// `isRelayRed` USED TO LIVE HERE and was deleted, not renamed. Once `questions` joined the set it
// was character-for-character `engine/attention.needsAttention` — two seams answering one question,
// which is the drift this file's own header warns about. Call `needsAttention` directly; the phone
// payload already distinguishes the kinds (`kind: "question"` for anything that is not an approval).

/** The PUBLISHED status map — the same chain AgentSidebar's `effectiveStatus` applies to color its
 *  own rows, kept here as one exported function so the two can be compared (and tested) instead of
 *  drifting as two hand-copied call stacks. Read today by the concierge feed (services/
 *  conciergeFeed) for its P0/P1/P2 banding. Order is the contract:
 *
 *   0. `withNewAgentCalm` — a spawned-but-never-briefed agent reads `new` (GRAY) instead of the red
 *      `blocked` statusEngine's 25s stall timer gives it for being quiet. FIRST, and on the RAW map,
 *      so a briefless agent's false red is corrected before steps 1–2 can bubble it to an
 *      orchestrator, where it would be indistinguishable from the parent's own.
 *   0b. `withDeadSessionCalm` — an agent whose SESSION HAS EXITED with a cause the app will recover
 *      from reads the amber `lapsed` instead of the red `errored` statusEngine writes on exit. Same
 *      placement as (0) and for the identical reason: it must land before steps 1–2 can bubble a
 *      dead worker's red onto its orchestrator. `RED = THE FOUNDER IS THE ONLY ACTOR WHO CAN
 *      UNBLOCK THIS` (engine/redAttentionTaxonomy.test.ts), and a dead session is blocked on a
 *      RESTART — which `services/resurrectionRunner` is already performing. See
 *      engine/deadSessionAttention for why `blocked-on-human` cannot reach it.
 *   1. `withUnstartedWorkerAttention` — a worker whose worktree was cut but which never went live has
 *      NO status entry, so nothing downstream would call it red. Invents the red and bubbles it.
 *   2. `withRedWorkerAttention` — a worker that started and then went red paints its orchestrator.
 *      After (1) so a strand's synthetic red bubbles too.
 *      Steps 1–2 are load-bearing, not cosmetic: consumers list orchestrators, not workers, so
 *      without these bubbles a build whose worker is stuck would surface nothing at all — the
 *      orchestrator carries it, which is the row the user can act on anyway.
 *   3. `withUnmergedWork` — a finished agent with un-landed committed work goes `unmerged`. That is
 *      a GRAY status (packages/ui/tokens.ts), so it never reaches this file's red paths; it is
 *      composed here only so the published map matches the sidebar's exactly.
 *   4. `withDismissedAlerts` — a dismissed red alarm de-escalates, so a row that reads calm in its own
 *      project is not broadcast as red elsewhere (the original cross-project bug). Strictly after (3):
 *      dismissal last, or it would re-redden a just-calmed row (see withUnmergedWork's header).
 *
 *  `blocked` is red purely by its token color, so `isRedStatus` picks it up with no overlay. */
export function publishedStatusFor(
  agents: readonly AgentTab[],
  status: StatusMap,
  openIds: ReadonlySet<string>,
  /** runtimeStore.lastObserved — lets the unstarted-worker overlay tell a closed pane (ran, then
   *  stopped) from a never-started strand, so a closed worker no longer synthesizes red (sparkle-w340). */
  lastObserved: LastObservedMap,
  stageOf: (id: string) => ReturnType<typeof resolveStage>,
  /** Optional out-param: receives the ids step (5) promoted from calm to `working`. Only the
   *  away-recap needs it — see withWorkerRollupGreen. Everything else ignores it. */
  promoted?: Set<string>,
  /** Injected clock — see composeRollup. */
  now?: number,
  /** agentId → last terminal keystroke. Injected — see composeRollup. Defaults to the live store at
   *  this OUTERMOST boundary, so ordinary callers keep working and the pure core stays pure. */
  interaction: Record<string, number> = useInteractionStore.getState().lastAt,
  /** agentId → thrash report, for the red contract's `nudge-loop` arm. Defaults to the live registry
   *  at this OUTERMOST boundary, exactly as `interaction` does, so ordinary callers keep working
   *  while `composeRollup` itself stays pure. */
  thrashOf: (id: string) => ThrashReport | undefined = (id) =>
    thrashReportFor(id, now ?? Date.now(), {}),
  /** agentId → positively read as finished. Defaults to "unread" (demotes nothing), because this
   *  file has no git state of its own — only the sidebar polls it. See composeRollup. */
  isFinishedOf: (id: string) => boolean | undefined = () => undefined,
  /** agentId → why its session ended, for step (0b). Defaults to the live window-local registry at
   *  this OUTERMOST boundary, exactly as `interaction` and `thrashOf` do — so every production
   *  caller drives the real de-redding without passing anything, while `composeRollup` itself stays
   *  pure. `undefined` from it means "no reading", never "alive". */
  deathCauseOf: (id: string) => DeathCause | undefined = deathCauseForAgent,
  /** agentId → does it have live background tasks (a `run_in_background` Bash, a backgrounded Task
   *  subagent, a backgrounded MCP call)? Defaults to the live window-local registry at this
   *  OUTERMOST boundary, exactly as `deathCauseOf` does — so every production caller drives the real
   *  green-while-delegating without passing anything, while `composeRollup` itself stays pure.
   *  `false` from it means "no live background work", never "we did not look". See bead sparkle-262p7. */
  hasBackgroundTasksOf: (id: string) => boolean = hasLiveBackgroundTasksForAgent,
  /** The nudger flag table — which agents have answered that a PERSON is blocking them.
   *
   *  ⚠️ A SNAPSHOT, NOT A PREDICATE, AND THE TYPE IS THE POINT (roborev 65465). Its neighbour
   *  `hasBackgroundTasksOf` is `(id: string) => boolean` and so was this; the two were ADJACENT and
   *  IDENTICALLY TYPED at the end of a 12-argument positional call, so a parameter inserted above or
   *  a dropped placeholder would slide this into that slot and TYPECHECK CLEANLY — every
   *  human-blocked agent silently read as "has live background work", and the exemption gone, on the
   *  exact path it was added for. A `ReadonlyMap` cannot be mistaken for a function, so that
   *  mis-wiring is now a compile error instead of a silent behaviour change.
   *
   *  Defaults to the live table at this OUTERMOST boundary, exactly as `deathCauseOf` and
   *  `hasBackgroundTasksOf` do, so every production caller drives the real exemption without passing
   *  anything while `composeRollup` itself stays pure. */
  nudgeFlags: NudgeFlagSnapshot = nudgeFlagsSnapshot(),
): StatusMap {
  const { published, dotOf } = composeRollup(
    agents,
    status,
    openIds,
    lastObserved,
    stageOf,
    now,
    interaction,
    thrashOf,
    isFinishedOf,
    deathCauseOf,
    hasBackgroundTasksOf,
    nudgeFlags,
  );
  return withWorkerRollupGreen(agents, published, dotOf, promoted);
}

/** The Build column's view of the same composition: the rolled-up dot per row, plus the un-bubbled
 *  `own` map the column needs to decide whether that dot overrides the row's own status.
 *
 *  EXPORTED SO THE COLUMN DOES NOT ASSEMBLE ITS OWN. AgentSidebar used to build `own`, the dismissed
 *  set and the in-motion predicate inline — a second copy of `composeRollup`, and therefore a second
 *  thing to keep in step with this file. Any slip in that copy (passing `effectiveStatus` where
 *  `bubbled` is required, say, which silently returns null for every dismissed agent) would make the
 *  column band differently from every other surface with nothing failing. That is the exact class of
 *  drift this rollup has already shipped twice, so there is one composition and three consumers. */
export function rollupViewFor(
  agents: readonly AgentTab[],
  status: StatusMap,
  openIds: ReadonlySet<string>,
  lastObserved: LastObservedMap,
  stageOf: (id: string) => ReturnType<typeof resolveStage>,
  /** Injected clock — see composeRollup. */
  now?: number,
  /** agentId → last terminal keystroke. Injected — see composeRollup. Defaults to the live store at
   *  this OUTERMOST boundary, so ordinary callers keep working and the pure core stays pure. */
  interaction: Record<string, number> = useInteractionStore.getState().lastAt,
  /** See `publishedStatusFor`'s parameter of the same name. The Build column needs it too: `dotOf`
   *  reads the CONTRACTED published map, so a column that skipped this would paint a worker red
   *  under a head the rest of the app had already calmed. */
  thrashOf: (id: string) => ThrashReport | undefined = (id) =>
    thrashReportFor(id, now ?? Date.now(), {}),
  /** See `publishedStatusFor`'s parameter of the same name. The Build column needs it too: `dotOf`
   *  reads the finished-calmed published map, so a column that skipped it would keep painting a
   *  finished head red while every other surface had calmed it. */
  isFinishedOf: (id: string) => boolean | undefined = () => undefined,
  /** See `publishedStatusFor`'s parameter of the same name. The Build column needs it too: a dead
   *  agent's row must read amber HERE as well, or the column would paint red while every other
   *  surface had calmed it — the column↔feed drift this file exists to prevent. */
  deathCauseOf: (id: string) => DeathCause | undefined = deathCauseForAgent,
  /** See `publishedStatusFor`'s parameter of the same name. The Build column needs it too: `dotOf`
   *  reads the background-promoted map, so a column that skipped this would paint an idle-but-
   *  delegating head gray while every other surface had turned it green. */
  hasBackgroundTasksOf: (id: string) => boolean = hasLiveBackgroundTasksForAgent,
  /** The nudger flag table — which agents have answered that a PERSON is blocking them.
   *
   *  ⚠️ A SNAPSHOT, NOT A PREDICATE, AND THE TYPE IS THE POINT (roborev 65465). Its neighbour
   *  `hasBackgroundTasksOf` is `(id: string) => boolean` and so was this; the two were ADJACENT and
   *  IDENTICALLY TYPED at the end of a 12-argument positional call, so a parameter inserted above or
   *  a dropped placeholder would slide this into that slot and TYPECHECK CLEANLY — every
   *  human-blocked agent silently read as "has live background work", and the exemption gone, on the
   *  exact path it was added for. A `ReadonlyMap` cannot be mistaken for a function, so that
   *  mis-wiring is now a compile error instead of a silent behaviour change.
   *
   *  Defaults to the live table at this OUTERMOST boundary, exactly as `deathCauseOf` and
   *  `hasBackgroundTasksOf` do, so every production caller drives the real exemption without passing
   *  anything while `composeRollup` itself stays pure. */
  nudgeFlags: NudgeFlagSnapshot = nudgeFlagsSnapshot(),
): { own: StatusMap; dotOf: (id: string) => RollupDot } {
  const { own, dotOf } = composeRollup(
    agents,
    status,
    openIds,
    lastObserved,
    stageOf,
    now,
    interaction,
    thrashOf,
    isFinishedOf,
    deathCauseOf,
    hasBackgroundTasksOf,
    nudgeFlags,
  );
  return { own, dotOf };
}

/** Steps 1–4 plus the rollup accessor they feed. The single place the chain is spelled out. */
function composeRollup(
  agents: readonly AgentTab[],
  status: StatusMap,
  openIds: ReadonlySet<string>,
  lastObserved: LastObservedMap,
  stageOf: (id: string) => ReturnType<typeof resolveStage>,
  /** Injected clock for step (0)'s spawn-age backstop. Defaults to now; passed explicitly by tests
   *  so the time-dependent rule needs no fake timers (house style — stores/conciergeApprovals.ts). */
  now: number = Date.now(),
  /** agentId → when the user last typed into that agent's terminal. INJECTED, alongside `now`, for
   *  the same reason: this composition is consumed by `buildConciergeFeed`, which documents itself
   *  as pure and ALREADY receives this map as a parameter. Reading the global store in here made the
   *  two independently sourced, so the feed could emit `since` from the caller's map and `status:
   *  "new"` from an empty singleton — a self-contradictory payload for one agent — and made route 4
   *  untestable through the feed except by mutating a module singleton (roborev 54771). Defaults to
   *  empty, i.e. "never touched", which is the pre-route-4 behaviour rather than a crash. */
  interaction: Record<string, number> = {},
  /** agentId → its thrash report. INJECTED for the same reason `interaction` is: this composition is
   *  consumed by `buildConciergeFeed`, which documents itself as pure, and `thrashReportFor` reads a
   *  module-level registry. Defaults to "no report", i.e. NOT OBSERVED — never a healthy-looking
   *  default, which is the distinction `thrashReportFor`'s own `undefined` arm exists to preserve.
   *  Only step (5) reads it, and only for the `nudge-loop` verdict. */
  thrashOf: (id: string) => ThrashReport | undefined = () => undefined,
  /** agentId → has this row been POSITIVELY READ as finished (engine/agentStall's `finished`
   *  verdict)? `undefined` means "we did not look", which demotes nothing — see engine/
   *  finishedHeadCalm. Injected for the same reason `thrashOf` is: the stall inputs are assembled
   *  from git state the sidebar polls, and this composition documents itself as pure. Defaults to
   *  "unread", i.e. exactly today's behaviour for any caller with no evidence to give. */
  isFinishedOf: (id: string) => boolean | undefined = () => undefined,
  /** agentId → why its session ended (services/deadSessionRegistry), or `undefined` for "we did not
   *  look". Injected for the same reason `thrashOf` and `isFinishedOf` are — this composition is
   *  consumed by `buildConciergeFeed`, which documents itself as pure, and the registry is module
   *  state. Defaults to "no reading", which demotes nothing: exactly today's behaviour for a caller
   *  with no evidence to give. The real registry is wired in at the two OUTERMOST boundaries above,
   *  so no production path relies on this default. */
  deathCauseOf: (id: string) => DeathCause | undefined = () => undefined,
  /** agentId → does it have live background tasks? Injected for the same reason `deathCauseOf` is —
   *  this composition is consumed by `buildConciergeFeed`, which documents itself as pure, and the
   *  backing store (`services/backgroundTaskRegistry`) is module state. Defaults to `() => false`
   *  ("no background work"), which promotes nothing: exactly today's behaviour for a caller with no
   *  evidence to give. The real registry is wired in at the OUTERMOST boundaries above. */
  hasBackgroundTasksOf: (id: string) => boolean = () => false,
  /** The nudger flag table. Injected for the same reason `deathCauseOf` and `hasBackgroundTasksOf`
   *  are: this composition is consumed by `buildConciergeFeed`, which documents itself as PURE, and
   *  the backing table is module state. Defaults to EMPTY, which exempts nothing — exactly today's
   *  behaviour for a caller with no evidence to give. The real table is wired in at the two
   *  OUTERMOST boundaries above.
   *
   *  ⚠️ THIS WAS AN IMPORT INSIDE THIS FUNCTION FOR ONE COMMIT (roborev 65408), which made the
   *  composition impure — the test files driving it began depending on whatever flag state a prior
   *  test had left behind — and left the production wiring reachable by no test at all. It is also a
   *  MAP rather than a predicate on purpose; see the boundary parameters above (roborev 65465). */
  nudgeFlags: NudgeFlagSnapshot = new Map(),
): { published: StatusMap; own: StatusMap; dotOf: (id: string) => RollupDot } {
  // (0): a spawned-but-never-briefed agent is `new`, not red. FIRST, on the RAW map, so the two
  // bubbles below never carry a briefless agent's false red up to its orchestrator — a bubbled red
  // is indistinguishable from the parent's own once it lands, so this has to be corrected before it
  // can spread. It cannot interfere with step (1): withUnstartedWorkerAttention invents a red for a
  // STRANDED WORKER, and a worker carries its orchestrator's `task` as its brief, so it is never
  // briefless. See engine/newAgentAttention.ts.
  // (0b): a session that has EXITED with a recoverable cause is amber, never red. Beside (0), on
  // the RAW map, and for the same reason — steps (1)+(2) below make a bubbled red indistinguishable
  // from the parent's own, so a dead worker's red has to be corrected before it can spread to an
  // orchestrator the founder would then have to triage. The two overlays cannot collide: (0)
  // reaches only agents that have never been briefed, (0b) only agents whose session has ended.
  // See engine/deadSessionAttention — `blocked-on-human` stays RED by construction, because the
  // gate is `isResurrectable` and that cause is not.
  // (0c): an agent whose turn CLOSED (idle) while its own background work runs on — a
  // `run_in_background` Bash, a backgrounded Task subagent, a backgrounded MCP call — is promoted
  // back to `working` (GREEN). This is the missing motion `engine/inMotion` never covered: it keeps
  // a parent green for a `kind:"worker"` child TAB, but the "Improve Sparkle" agent (and any agent
  // that delegates through background tasks with no tab) holds zero such children and so settled to
  // GRAY the instant its turn closed. See engine/workerRollup.withBackgroundTaskGreen and bead
  // sparkle-262p7. LAST of the three base-map overlays, on purpose: it promotes only `idle`, so it
  // cannot touch the `new` (0) and `lapsed` (0b) an agent may have just been corrected to, and it
  // runs BEFORE the bubbles/unmerged/rollup so the single `working` it writes is the one source of
  // truth every downstream surface reads — the dot, isInMotion's worker-red suppression, the
  // withUnmergedWork "is this agent finished?" test, and the published map itself.
  const calm = withBackgroundTaskGreen(
    agents,
    withDeadSessionCalm(
      agents,
      withNewAgentCalm(agents, status, now, interaction),
      deathCauseOf,
    ),
    hasBackgroundTasksOf,
  );
  // (1)+(2): the two worker-attention bubbles. Kept as its own binding because the rollup below
  // needs exactly this map — pre-unmerged, pre-dismissal — to answer "is this parent in motion?" and
  // "which reds has the user dismissed?".
  const bubbled = withRedWorkerAttention(
    agents,
    withUnstartedWorkerAttention(agents, calm, openIds, lastObserved),
  );
  // (3)+(4) over the bubbled map: the published chain as it has always been.
  // (5): a row SPARKLE has been pinging into silence stops asking — see engine/nudgeLoopCalm.
  //
  // LAST, so it filters the map that is actually rendered rather than an intermediate nobody paints.
  //
  // IT CANNOT SWALLOW THE STALL ESCALATION, which is the one red it must not touch.
  // `withStallAttention` escalates `human-verified-goal` to `blocked` — a goal whose stated check no
  // agent may ever discharge, i.e. the one cause where the founder genuinely IS the only actor. That
  // runs downstream of this, in AgentSidebar, and only ever on `idle`/`unmerged` rows
  // (stallEscalation.ESCALATABLE), which are never in the `needs_you` band this pass looks at. The
  // two operate on disjoint inputs by construction rather than by agreement.
  //
  // AND IT LEAVES EVERY WORKER BUBBLE ALONE. Demoting an inherited red was the OTHER half of bead
  // sparkle-hpbkw (a finished head painted red by its stranded worker), and it is deliberately NOT
  // done here: it contradicts `publishedRollupAgreement.test.ts`'s stated expectation that a head in
  // motion with a WAITING worker still asks. That is the founder's call to make, not this file's.
  // (6): a head we have POSITIVELY READ as finished stops inheriting its worker's alarm — the other
  // half of bead sparkle-hpbkw. `calm` is the OWN reference for the same reason it would be for any
  // "is this the row's own ask" question: `bubbled` has by then made an inherited red
  // indistinguishable from a real one, so feeding it that map collapses the rule to a no-op (the
  // trap `rollupDotAccessor` documents on `ownStatusOf`).
  //
  // This is the NARROW rule, and narrow on purpose. The general form — `needsYou === false ⇒ never
  // red` — turned seven pinned expectations red when it was wired, including
  // `publishedRollupAgreement`'s stated "head in motion + WAITING worker still asks". This one
  // cannot reach any of them: it fires only where the app has positively read the head as FINISHED,
  // and a head with live workers under it is not resting. `undefined` (nobody polled) demotes
  // nothing, so a caller with no evidence gets exactly today's behaviour.
  const published = withFinishedHeadCalm(
    agents,
    withNudgeLoopCalm(
      agents,
      withDismissedAlerts(agents, withUnmergedWork(agents, bubbled, stageOf)),
      thrashOf,
      // ⚠️ THIS CALLER WAS MISSING IT (roborev 65373), and only making the parameter REQUIRED
      // surfaced that. A stated human block must survive the nudge-loop demotion on the
      // notification path too — otherwise the dot and the banner disagree about the same row.
      (id) => isHumanBlockedIn(nudgeFlags, id),
    ),
    calm,
    isFinishedOf,
  );
  // The same chain with the worker bubbles left OUT. Without it the rollup reads a bubbled red as
  // the head's OWN red and returns early, which makes every mixed subtree unreachable (the trap
  // documented on rollupDotAccessor's `ownStatusOf`). Built from `calm`, not `status`: this is the
  // same chain minus steps (1)+(2), so feeding it the uncorrected map would make a row's OWN status
  // disagree with its published one for exactly the briefless agents this change is about.
  const own = withDismissedAlerts(agents, withUnmergedWork(agents, calm, stageOf));
  const dismissed = new Set(
    agents.filter((a) => alertControlKind(a.alert, bubbled[a.id]) === "reenable").map((a) => a.id),
  );
  const dotOf = rollupDotAccessor(
    agents,
    (id) => published[id] ?? "stopped",
    (id) => own[id] ?? "stopped",
    {
      isDismissed: (id) => dismissed.has(id),
      isInMotion: (parentId) => isInMotion(parentId, agents, bubbled),
    },
  );
  return { published, own, dotOf };
}

/** Cap the raw terminal `detail` we relay to the phone. The trigger sits at the BOTTOM of the
 *  screen/scrollback, so keep the tail (a runaway scrollback would otherwise bloat the payload).
 *  Trailing blank lines a terminal snapshot pads with are stripped so the card doesn't render a
 *  wall of empty space. */
export const DETAIL_MAX = 4000;
export const truncateDetail = (raw: string): string => {
  const trimmed = raw.replace(/[ \t]*\n(?:[ \t]*\n)+$/g, "\n").trimEnd();
  if (trimmed.length <= DETAIL_MAX) return trimmed;
  return `…\n${trimmed.slice(trimmed.length - DETAIL_MAX)}`;
};

// --- Phase-2b: prefer a FRESH self-reported activity over the paid Haiku ask-summary ----------
// An agent narrates "what I'm building now" via the sparkle-control `set_agent_activity` MCP op
// (AgentTab.activity). When that narration was updated within a short window of the agent crossing
// into a needs-you (waiting/approval) state, it almost certainly describes the current ask — so we
// use it as the notification body and SKIP the credit-metered summarize_attention screen-scrape.
//
// `activity` now carries a DURABLE timestamp: `AgentTab.activityAt`, stamped by setAgentActivity
// (bead sparkle-s8y5t6). When present it is authoritative — it is written at narration time and
// survives a restart — so `selfReportBody` reads it directly. The in-memory `stampActivity` map
// below is the FALLBACK for legacy/restored records that carry no `activityAt`: it derives age from
// when THIS window first observed the string (this effect re-runs whenever the owned `agents` array
// changes, and `setAgentActivity` produces a new array). First sighting of an id is stamped `at = 0`
// — "unknown age" — so a stamp-less activity restored from a previous session is treated as stale
// (conservative: we keep calling Haiku) until the agent re-narrates in this session. The durable
// stamp fixes exactly the case this fallback cannot: a narration written just before the window
// mounted reads as fresh from `activityAt` instead of being discarded as unknown-age.
//
// WHY 2 MINUTES AND NOT 10 SECONDS (roborev 53476, 2026-07-27). This window has to match the
// narration cadence the persona actually asks for, and that cadence changed. The 10s original was
// tuned when `sparkleControlProtocol()` told agents to narrate at every sub-task, so a narration
// was almost always seconds old. It now says narrate at PHASE boundaries and skip narration with
// nothing to batch it against — which is a cost fix, but it aims squarely at the moment this gate
// depends on: the turn where an agent hands back to the human contains no other tool call, so the
// narration rides in the LAST tool-using turn and then has to survive however long the agent takes
// to finish that turn and write its hand-back message. At 10s this gate went near-dead and every
// `waiting` notification fell through to the credit-metered summarize_attention scrape — trading a
// token saving for a paid call, which is not a saving at all.
// The cost of widening is bounded: only `waiting` is eligible (approval is excluded above, where
// the body MUST describe the action), the text is a phase description, and the ask lies inside that
// phase — so a 90s-old "Wiring the control listener" is still a fair answer to "what does it want?",
// and strictly better than the generic fallback it would otherwise get. Two minutes covers "narrated
// in my last tool-using turn, then finished and asked" while still rejecting a line from an earlier
// phase. The shift is observable without new telemetry: selfReportMetrics.attentionSources counts
// self_report vs paid_haiku vs generic_fallback, so a regression here shows up as paid_haiku rising.
export const ACTIVITY_FRESH_MS = 120_000;

interface ActivityStamp {
  value: string; // the last-observed trimmed activity text
  at: number; // epoch ms we first observed THIS value ( 0 = first sighting / unknown age )
}

/** Fold this tick's owned agents into the activity-change stamp map. For each agent: first sighting
 *  → `at = 0` (unknown age); value changed vs last seen → `at = now` (just narrated); unchanged →
 *  keep the prior stamp. The returned map is pruned to exactly the current agents (an agent that
 *  left the set and returns gets a fresh first-sighting). Pure. */
export function stampActivity(
  prev: Record<string, ActivityStamp>,
  agents: ReadonlyArray<{ id: string; activity?: string }>,
  now: number,
): Record<string, ActivityStamp> {
  const next: Record<string, ActivityStamp> = {};
  for (const a of agents) {
    const value = (a.activity ?? "").trim();
    const seen = prev[a.id];
    const at = seen === undefined ? 0 : seen.value !== value ? now : seen.at;
    next[a.id] = { value, at };
  }
  return next;
}

/** The notification body to use FROM a self-report, or null to fall back to the Haiku summary. Only
 *  the two "ask" statuses (waiting/approval) are eligible — the exact scope summarize_attention
 *  covers — so errored/other statuses keep their existing generic copy unchanged. Returns the
 *  activity text only when it is present AND fresh: stamped in-session (`at > 0`) and updated within
 *  ACTIVITY_FRESH_MS of `now` (≈ the needs-you transition, which fires this same tick). Pure. */
export function selfReportBody(
  activity: string | undefined,
  stamp: ActivityStamp | undefined,
  now: number,
  status: AgentTabStatus | undefined,
  activityAt?: number,
): string | null {
  // Only substitute the activity narration for a WAITING body, where "what I'm doing now" is a
  // reasonable proxy for the question. For APPROVAL we must NOT — the body has to describe the
  // action being approved (e.g. "Approve `rm -rf build/`?"), which the narration ("Refactoring
  // auth") does not capture and could dangerously misrepresent; approval always uses the Haiku
  // ask-summary. (roborev sparkle-jze5 review.)
  if (status !== "waiting") return null;
  const text = (activity ?? "").trim();
  if (!text) return null;
  // DURABLE STAMP WINS. `activityAt` is written at narration time and survives a restart, so when it
  // is present it is the authoritative age — use it and ignore the fragile in-window observation
  // stamp entirely (bead sparkle-s8y5t6). A report is usable only while it is not stale by the
  // notification window; `isActivityStale` also folds a missing/future stamp to stale for us.
  if (activityAt !== undefined) {
    return isActivityStale(activityAt, now, ACTIVITY_FRESH_MS) ? null : text;
  }
  // FALLBACK for a legacy/restored record with no durable stamp: the in-window observation stamp.
  if (!stamp || stamp.at <= 0) return null; // unknown age → treat as stale
  if (now - stamp.at > ACTIVITY_FRESH_MS) return null; // stale narration → Haiku fallback
  return text;
}

/** Classify what actually supplied a needs-you notification body (Phase-2c gate, sparkle-rl84):
 *  a fresh self-report wins; else the paid Haiku ask-summary if it produced a body; else the generic
 *  reason copy. `selfReported` is selfReportBody's result; `haikuBody` is the trimmed
 *  summarize_attention output (null if not called / empty / failed). Pure — no identifying data. */
export function attentionBodySource(
  selfReported: string | null,
  haikuBody: string | null,
): AttentionSource {
  if (selfReported != null) return "self_report";
  if (haikuBody != null) return "paid_haiku";
  return "generic_fallback";
}

/** No agent's prompt is being held. A shared frozen instance so the common path allocates nothing. */
const NO_HELD_PROMPTS: ReadonlySet<string> = new Set<string>();

/**
 * Which of `agents` currently have a DRAWN PROMPT BEING HELD BACK from the founder — the ids
 * `engine/blockedPromptGrace` de-escalated, read off the two maps rather than re-deriving the rule.
 *
 * Derived by DIFFING the overlay's output against its input, and not by exporting a second predicate
 * from the engine, because the overlay already answers this question exactly once. A separate
 * "is this one held?" export would be a second copy of a rule with three end conditions and a burn
 * set, i.e. two chances to disagree about which prompts the founder is being spared. The overlay's
 * documented no-op contract — the SAME reference back when nothing is held — makes the common case
 * a single identity comparison.
 */
export function heldPromptIds<T extends { id: string }>(
  agents: readonly T[],
  status: StatusMap,
  graced: StatusMap,
): ReadonlySet<string> {
  if (graced === status) return NO_HELD_PROMPTS;
  const out = new Set<string>();
  for (const a of agents) if (graced[a.id] !== status[a.id]) out.add(a.id);
  return out.size === 0 ? NO_HELD_PROMPTS : out;
}

/**
 * The snapshot `newlyEntered` should compare against NEXT tick, given that this tick deliberately
 * did not act on the FROZEN agents.
 *
 * THE EDGE MUST BE DEFERRED, NOT DROPPED, and that distinction is the whole reason this exists.
 * Simply `continue`-ing past a held agent in the dispatch loop would ALSO record its red in the
 * baseline — so when the hold ends there is no longer an edge to detect, and the banner + phone push
 * are lost permanently. That is strictly worse than not holding at all: the founder would be spared
 * the notification for the routine prompts AND for the wedged ones, which inverts the entire feature.
 *
 * So a FROZEN agent's baseline keeps its PREVIOUS value: this tick never happened as far as that
 * agent is concerned. WHICH agents are frozen is the caller's decision and NOT "the ones held right
 * now" — the sole caller passes the OWED set (see `owedBanner`), because a hold is only a reason to
 * freeze when the run doing the hiding is also the run that would have delivered the banner. An
 * earlier version of this paragraph said "held", and that reading is what a later edit would restore
 * the fleet-wide freeze from (roborev 62898). Whatever it is really doing when the hold lifts is then a fresh transition from where
 * it genuinely was, which is also why the previous value is restored rather than the de-escalated one
 * — recording `idle` would swallow the ordinary "Finished — your turn" edge if the agent went on to
 * finish. An agent with NO previous entry has its key removed, since `undefined` is what "never
 * observed" means to `newlyEntered` and writing the red in would be the dropped-edge bug again.
 *
 * Returns the SAME reference when nothing is frozen, so the common path allocates nothing.
 */
export function baselineWithFrozenPrompts(
  next: StatusMap,
  prev: StatusMap,
  /** The agents whose banner this run still OWES — not simply the ones held right now. A hold is
   *  only a reason to freeze when the run that is hiding the prompt is also the run that would have
   *  delivered its banner; see `owedBanner` at the call site for why those are different sets. */
  frozenIds: ReadonlySet<string>,
): StatusMap {
  if (frozenIds.size === 0) return next;
  const out: StatusMap = { ...next };
  for (const id of frozenIds) {
    const before = prev[id];
    if (before === undefined) delete out[id];
    else out[id] = before;
  }
  return out;
}

/** Bring this window to the foreground (notification click landed here). */
async function bringToFront(): Promise<void> {
  try {
    const w = getCurrentWindow();
    await w.unminimize();
    await w.show();
    await w.setFocus();
  } catch (e) {
    console.debug("bringToFront failed", e);
  }
}

/** The shared reveal, now in services/agentReveal (it had to leave this module so openProjectTab
 *  could use it without the two importing each other). Re-exported: every existing caller — the
 *  sidebar, the concierge feed, openProjectTab — keeps its import path. */
export { selectAndOpen } from "./services/agentReveal";

export function useAttentionNotifications(): void {
  const rawStatus = useRuntimeStore((s) => s.status);
  // NOTE (roborev 46897): branchStatus / workflowStage / openAgentIds are deliberately NOT
  // subscribed here any more. Their only consumer was the cross-window publish's overlay chain,
  // deleted with that channel — and `branchStatus` takes a fresh object identity on every poll, so
  // keeping the subscription re-rendered this hook's host and re-ran the notification effect on
  // every branch poll to service a dependency nothing read. `publishedStatusFor` still takes them
  // as PARAMETERS for the concierge feed, which is now their only caller.
  const projectId = useCurrentProjectId();
  const label = useCurrentWindowLabel();
  const isMain = useIsMainWindow();
  const replace = useReplaceCurrentProject();
  const agents = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.agents ?? EMPTY_AGENTS,
  );
  // THE WHOLE FLEET, and what it is load-bearing FOR is debt SURVIVAL, not the held set.
  //
  // A banner owed to an agent in project A must outlive the founder switching to project B and back
  // — `liveIds` below is built from this, and it is the only thing that stops the carry-forward loop
  // pruning that debt as "agent is gone" while he is looking elsewhere. Losing it lost a real
  // notification: the prompt's edge was consumed while away and there was no transition left to fire
  // on when the ceiling lapsed (roborev 62857), which is strictly worse than never holding at all.
  //
  // NOT because the held set must span `prevStatus`'s keys — an earlier version of this comment said
  // that, and it stopped being true when the freeze was narrowed to the debt (roborev 62893).
  // `heldIds` is now only ever consulted for owned ids.
  //
  // `agents` still scopes everything else — the dispatch loop, the badge count, the activity stamps
  // — because those are about what THIS window owns.
  const projectsForFleet = useProjectStore((s) => s.projects);
  const fleetAgents = useMemo(
    () => projectsForFleet.flatMap((p) => p.agents),
    [projectsForFleet],
  );
  // The badge count and the banner edge-detector BOTH read this map, and both were firing for
  // agents nobody had briefed: `errored` inside the spawn window inflates countAttention, and `idle`
  // — which notifies by DEFAULT as "Finished — your turn" — is simply false about an agent that was
  // never given a turn. withNewAgentCalm resolves those to `new`, which is in neither set. Same
  // step (0) publishedStatusFor applies, so the banner and the row cannot describe an agent
  // differently. Returns the SAME reference when nothing is corrected, so the effect below does not
  // re-run on unrelated renders.
  // Terminal keystrokes are recorded ONLY here (Terminal.onData → touch), so this is the only
  // evidence a hand-driven agent has been briefed — see newAgentAttention route 4.
  const interactionAt = useInteractionStore((s) => s.lastAt);
  // Via the hook, not a bare memo: the backstop is a deadline, and an `errored` agent emits no
  // further status writes to recompute one. See hooks/useNewAgentCalm (roborev 54743, finding 1).
  const status = useNewAgentCalm(agents, rawStatus, interactionAt);
  // A PROMPT THE CONCIERGE IS ABOUT TO ANSWER MUST NOT PING THE FOUNDER. This is the same window
  // ledger the concierge feed both fills and reads (engine/blockedPromptGrace) — read-only here, and
  // EMPTY unless the feed has opened an episode, which is what makes this addition inert for every
  // caller and test that does not exercise the hold.
  //
  // It matters more on this path than on the feed's. A row the founder never looks at costs him
  // nothing; a macOS banner and a phone push are an INTERRUPTION, delivered to a second device, about
  // a permission dialog that will be answered before he can reach for it. Holding the row while still
  // firing the banner would have left the whole feature defeated by its loudest channel.
  const promptGrace = windowPromptGraceLedger();
  // …and the hold needs a clock here for the same reason it does in the feed, with one extra twist:
  // this effect's deps are `status` and `agents`, and a prompt whose answerer died changes NEITHER
  // again. Without the tick the deferred banner below would be deferred FOREVER — the ceiling would
  // silence a real question instead of merely delaying it. See hooks/useBlockedPromptGrace.
  // The two ask-capture maps are what let the tick SEE a hold begin — the ledger is a mutated
  // singleton whose identity never changes, and `setStatus` no-ops on an unchanged value while
  // `setAttentionScreen` always writes fresh maps (roborev 62851). Subscribed here rather than read
  // via `getState()` for that exact reason: a `getState()` read would not re-render this hook.
  const attentionScreen = useRuntimeStore((s) => s.attentionScreen);
  const attentionScreenAt = useRuntimeStore((s) => s.attentionScreenAt);
  const promptTick = usePromptGraceTick(fleetAgents, promptGrace, attentionScreen, attentionScreenAt, status);
  const projectName = useProjectStore(
    (s) => s.projects.find((p) => p.id === projectId)?.name ?? "",
  );
  // Which statuses the user wants notifications for (⋯ → Notifications). Built into a Set so the
  // edge detector is a cheap membership test. Recomputed only when the prefs object changes.
  const notifyStatuses = useSettingsStore((s) => s.notifyStatuses);
  const enabled = useMemo(
    () =>
      new Set(
        (Object.keys(notifyStatuses) as Array<keyof typeof notifyStatuses>).filter(
          (k) => notifyStatuses[k],
        ),
      ),
    [notifyStatuses],
  );

  // Previous status snapshot + which project it was for, so a project switch re-baselines
  // instead of firing a notification for every already-notifiable agent in the new project.
  const prevStatus = useRef<StatusMap>({});
  /**
   * Agents whose banner is OWED — held at some point, and not yet delivered by a run that could
   * actually deliver it.
   *
   * A HELD SET ALONE IS NOT ENOUGH, and that is the whole reason this ref exists. The hold defers an
   * edge, and an edge is only deferred safely if the baseline stays frozen until someone ACTS on it.
   * But two ordinary things stop this effect acting: the `sameProject` gate (a tab switch
   * deliberately re-baselines without notifying, so it does not burst banners), and the dispatch
   * loop being scoped to the selected project's agents. So with the deferral keyed only on "is it
   * held right now", a founder who switched tabs inside the 30-second window got: ceiling lapses
   * while away → nothing held any more → red baselined by a run that could not notify → switch back
   * → no transition left to detect → the question is silenced permanently (roborev 62857). That is
   * the "DEFERRED, NOT DROPPED" contract failing in exactly the direction that is strictly worse
   * than never holding at all.
   *
   * Carrying the debt forward instead means the baseline is preserved until a run both owns the
   * agent and is allowed to fire. Pruned to the live fleet, so a closed agent cannot leak.
   */
  const owedBanner = useRef<ReadonlySet<string>>(NO_HELD_PROMPTS);
  const prevProject = useRef<string | null>(null);
  // agentId -> the attention_id we sent the phone, so we can resolve it when it clears.
  const attentionIds = useRef<Record<string, string>>({});
  // agentId -> {value, at}: the last activity narration we observed and WHEN it first appeared this
  // session. Feeds selfReportBody's freshness test (Phase-2b). Pruned to the current owned agents
  // each run by stampActivity.
  const activitySeen = useRef<Record<string, ActivityStamp>>({});

  // Badge + notification side-effects, recomputed whenever status, the owned agent set, or the
  // notify prefs change. The badge stays strictly waiting/approval (countAttention); the banner
  // fires for any newly-entered status the user enabled.
  useEffect(() => {
    const now = Date.now();
    const ownedIds = agents.map((a) => a.id);
    // The whole fleet's ids, for pruning the owed-banner debt below. Fleet-wide for the same reason
    // the hold is: the baseline it protects spans every project.
    const liveIds = new Set(fleetAgents.map((a) => a.id));
    // The held prompts, computed ONCE and used twice below: the dock badge counts the de-escalated
    // map, and the dispatch loop skips these ids. Same reference back when nothing is held, so an
    // ordinary tick does no extra work.
    const graced = withBlockedPromptGrace(fleetAgents, status, promptGrace, now);
    const heldIds = heldPromptIds(fleetAgents, status, graced);
    // THE BADGE FOLLOWS THE HOLD TOO. It is the quietest of the three channels, but it is the one
    // that is always on screen: a dock badge reading "3" that clears itself twice a minute is the
    // same self-clearing noise in miniature, and leaving it alone would mean the founder still sees a
    // number he cannot act on. Nothing about edge detection is involved — `countAttention` is a level
    // reading, so this is a pure count over a map that already exists.
    reportAttentionCount(label, countAttention(graced, ownedIds));

    // Observe activity narrations so we can judge their freshness at fire time (Phase-2b). Done
    // every run (before the sameProject gate) so a project switch still re-baselines the stamps.
    activitySeen.current = stampActivity(activitySeen.current, agents, now);

    // The cross-window status BROADCAST is gone (roborev 46485-M). It existed so a second window
    // could list this window's red agents at the top of its sidebar; CM-U7 part 2 deleted that
    // reader along with the multi-window shell, and a writer with no reader is a localStorage
    // write plus a Tauri emit on every status change, feeding nothing. What replaced it: one
    // window shows every project (the tab bar surfaces other projects' reds), and the island/phone
    // read the roster published by useRosterPublisher.
    const sameProject = prevProject.current === projectId;
    if (sameProject) {
      // Read live at fire time (no extra deps / re-baselining): is THIS window the OS-focused
      // window, and which of its agents is the selected tab. Together they let us suppress the
      // single "you're already looking at this exact agent" case while still firing for a
      // different agent, a background window/project, or another app in front.
      const windowFocused = typeof document !== "undefined" && document.hasFocus();
      const selectedAgentId =
        useProjectStore.getState().projects.find((p) => p.id === projectId)?.selectedAgentId ?? null;
      // For each agent that just crossed into a notifiable status, dispatch ONE independent
      // fire-and-forget task. The task computes the Haiku "what is it asking" summary ONCE (for the
      // waiting/approval ask statuses) and feeds it to BOTH channels — the paired phone (emitAttention
      // → the iOS push body) and the native macOS banner (notifyAttention body) — so the Mac and the
      // phone read identically. Tasks are independent (not serialized behind one another's await) so a
      // slow/hung summary (the Haiku call can take up to ~40s before its timeout falls back) never
      // delays an unrelated notice. The effect can't be async, so each task has its own catch.
      const pid = projectId;
      for (const { id, status: st } of newlyEntered(prevStatus.current, status, ownedIds, enabled)) {
        // A prompt still inside its grace window: neither channel fires. The edge is DEFERRED, not
        // dropped — `baselineWithFrozenPrompts` below keeps this agent's previous baseline, so when the
        // hold ends (ceiling lapsed, answerer declined, pane unreachable) this same transition is
        // detected afresh and both channels fire then.
        if (heldIds.has(id)) continue;
        const agent = agents.find((a) => a.id === id);
        if (!agent || pid == null) continue;
        const agentName = agent.name;
        const relay = needsAttention(st); // mirrored to the phone regardless of local suppression
        const suppressed = suppressNotification({ windowFocused, selectedAgentId, agentId: id });
        if (!relay && suppressed) continue; // not relayed and locally suppressed — nothing to send
        // Phase-2b: if the agent FRESHLY self-reported what it's doing (within ACTIVITY_FRESH_MS of
        // this needs-you transition), prefer that text as the body and skip the paid Haiku scrape.
        // Captured synchronously here — the ref reflects this tick's stamping above. Null for stale/
        // absent narration (and for non-ask statuses), which falls through to Haiku exactly as before.
        const selfReported = selfReportBody(
          agent.activity,
          activitySeen.current[id],
          now,
          st,
          agent.activityAt,
        );
        void (async () => {
          // The agent's ask, summarized once and shared by phone + banner. A fresh self-report wins;
          // otherwise only the two "ask" statuses are summarized (cost control), and any miss/empty/
          // throw → null → generic copy below. `awaited` records whether we actually yielded on the
          // Haiku call — it gates the live status re-check below so the synchronous path (self-report
          // or no screen) doesn't second-guess the just-validated `st`.
          let summary: string | null = selfReported;
          let awaited = false;
          // Phase-2c gate: track whether the PAID Haiku summary actually produced a usable body, so
          // we can classify the body source (self-report vs paid vs generic) below — observation only.
          let haikuBody: string | null = null;
          if (summary == null && (st === "waiting" || st === "approval")) {
            const screenText = useRuntimeStore.getState().attentionScreen[id];
            // Match the backend's own empty-check: `summarize_attention` trims the screen before
            // deciding there's nothing to summarize, so a whitespace/newline-only snapshot would slip
            // past a bare truthiness guard, cost an IPC round-trip, and come back as a "failed empty
            // screen" non-error. Pre-trim here so we only summarize a screen with real content.
            if (screenText?.trim()) {
              awaited = true;
              // Metering-only: attributes the summarizer's debit to the agent's OWNING project.
              const trimmed = (
                await summarizeAttention(screenText, projectNameForAgent(id))
              )?.trim();
              if (trimmed) {
                summary = trimmed;
                haikuBody = trimmed;
              }
            }
          }
          // Record which source supplied the body, once per DISPATCHED needs-you event (privacy-safe
          // enums only: source, status, kind — never the body text itself). Population = events that
          // reached at least one channel: red statuses always fire the phone relay here (even when the
          // LOCAL banner is suppressed because you're already looking at the agent), and the `!relay &&
          // suppressed` case already `continue`d above, so it never reaches this line. So this counts
          // "of needs-you events we surfaced somewhere," NOT "of banners visibly shown on this Mac."
          reportAttentionSource(attentionBodySource(selfReported, haikuBody), st, agent.kind);

          // Phone relay (separate device — fires regardless of local suppression). Only when we
          // actually awaited the summary do we re-check that the agent is STILL red: that await is the
          // gap in which the user could have answered/cleared it, and emitting after the fact would
          // race the resolve-cleanup below and leave a stale card on the phone. With no await we run
          // synchronously in the same tick `newlyEntered` validated `st`, so the captured status holds
          // and no re-check is needed (it would only re-read the same snapshot).
          if (relay && (!awaited || needsAttention(useRuntimeStore.getState().status[id]))) {
            const attentionId = crypto.randomUUID();
            attentionIds.current[id] = attentionId;
            const approval = st === "approval";
            // `errored` covers both a crash and a mid-stream API-error/self-prompt stall — the agent
            // is stuck until you look, so it relays as a (reply-less) "needs you" with its own copy.
            const errored = st === "errored";
            // The EXACT terminal text that put this agent into the red state — the ask-screen
            // snapshot captured when it crossed into waiting/approval, else the recent scrollback
            // tail (errored/stalled agents have no ask snapshot). The phone renders this verbatim in
            // monospace under the plain-English `question` summary.
            const detail = truncateDetail(
              useRuntimeStore.getState().attentionScreen[id] ?? getAgentScrollback(id) ?? "",
            );
            emitAttention({
              attention_id: attentionId,
              agent_id: id,
              agent_name: agentName, // plain — the relay server prefixes the 🔴 in the push title
              project_name: projectName,
              kind: approval ? "approval" : "question",
              question:
                summary ??
                (approval
                  ? `${agentName} needs you to approve an action in ${projectName}.`
                  : errored
                    ? `${agentName} hit an error / stalled in ${projectName} and needs you.`
                    : `${agentName} is waiting on your answer in ${projectName}.`),
              ...(detail ? { detail } : {}),
              // Real heuristic-detected direct-answers (y/n, numbered menu) when present, else a
              // generic Approve/Deny for approvals. See suggestedRepliesFor.
              suggested_replies: suggestedRepliesFor(getAgentScrollback(id) ?? "", approval),
              created_at: new Date().toISOString(),
            });
          }

          // Native macOS banner — emoji'd title from notificationFor, body = the SAME summary the
          // phone got (or its generic reason fallback). Skipped only when you're already looking at
          // this exact agent (suppressNotification). Unlike the phone relay above, the banner does
          // NOT re-check live status after the await: a banner is a transient OS notification (it
          // appears and auto-dismisses), so a slightly-stale one is low-harm — whereas a phone card
          // persists until resolved, which is why only the relay re-validates. Intentional asymmetry.
          if (!suppressed) {
            const banner = notificationFor(st, agentName, projectName);
            notifyAttention({
              projectId: pid,
              agentId: id,
              title: banner.title,
              body: summary ?? banner.body,
            });
          }
        })().catch((e) => console.debug("attention notify dispatch failed", e));
      }
    }
    // Clear the phone's card for any agent we raised that is no longer red — including agents
    // that left the owned set entirely (project switch / removed), which the loop above misses.
    for (const [id, attentionId] of Object.entries(attentionIds.current)) {
      if (!needsAttention(status[id])) {
        emitResolved(attentionId);
        delete attentionIds.current[id];
      }
    }
    // What is still OWED after this run: everything held right now, plus every earlier debt this run
    // was not in a position to pay. A debt is paid only by a run that is BOTH allowed to notify
    // (`sameProject`) and actually looking at that agent (`ownedIds`) — the two conditions the
    // dispatch loop above needs to have considered it.
    const ownedSet = new Set(ownedIds);
    // A DEBT IS ONLY TAKEN ON BY A RUN THAT COULD HAVE PAID IT — the acquisition condition mirrors
    // the payment condition exactly, and it must (roborev 62869). `heldIds` is fleet-wide, and the
    // dispatch loop is `ownedIds`-scoped, so no banner was ever suppressed for an agent in another
    // project and there is nothing owed to it. (The FREEZE below mirrors this same set — it does not
    // use `heldIds` either, for the reason spelled out there.)
    // Seeding the debt from the fleet froze those agents' baselines at their pre-hold value for as
    // long as they stayed unowned — and then the first tick after the founder opened that project
    // read every one of them as a fresh entry and fired a banner AND a phone push for each. That is
    // the burst the `sameProject` gate exists to prevent, reintroduced through the back door.
    // ONE definition of "this run was in a position to deliver that agent's banner", used to both
    // ACQUIRE and PAY the debt. Written on one line so a mutation check can judge it — the two
    // conditions drifting apart is precisely how a debt becomes unpayable.
    const canPay = (id: string): boolean => sameProject && ownedSet.has(id);
    const stillOwed = new Set([...heldIds].filter(canPay));
    for (const id of owedBanner.current) {
      if (!liveIds.has(id)) continue; // agent is gone; nothing left to notify about
      const couldHaveFired = canPay(id) && !heldIds.has(id);
      if (!couldHaveFired) stillOwed.add(id);
    }
    owedBanner.current = stillOwed.size === 0 ? NO_HELD_PROMPTS : stillOwed;
    // THE FREEZE MIRRORS THE DEBT EXACTLY — `owedBanner`, not the fleet-wide held set.
    //
    // It is the FREEZE, not the debt, that produces a burst (roborev 62893). Freezing an unowned
    // agent's baseline held it at `working` for as long as the hold was live, so a founder who opened
    // that project BEFORE the ceiling lapsed got a fresh `working → waiting` edge at the lapse tick —
    // one banner and one phone push per held agent. Opening a project with the same number of
    // NON-held reds delivers zero, because the `sameProject` gate re-baselines silently.
    //
    // That inconsistency is the thing to remove, so this picks PARITY: arriving at a held prompt is
    // the same experience as arriving at any other red — the row is there, and the founder is not
    // interrupted about a question that was never being deferred on his behalf. An agent only ever
    // has its baseline frozen while a run that could actually deliver its banner is the one holding
    // it back, which is precisely what `owedBanner` means.
    prevStatus.current = baselineWithFrozenPrompts(status, prevStatus.current, owedBanner.current);
    prevProject.current = projectId;
    // `promptTick` is deliberately NOT referenced in the body — it is the only dependency that
    // changes when a grace window closes with nothing else happening in the app, which is precisely
    // when a deferred banner is due. Same pattern, and the same reason, as useConciergeFeed's memo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    status,
    agents,
    fleetAgents,
    projectId,
    label,
    projectName,
    enabled,
    promptTick,
  ]);

  // Report 0 on unmount so a closed window stops contributing to the app-global badge total.
  useEffect(
    () => () => {
      reportAttentionCount(label, 0);
    },
    [label],
  );

  // Notification-click routing. Registered once; reads the live current project via a ref.
  const ctx = useRef({ projectId, label, isMain, replace });
  ctx.current = { projectId, label, isMain, replace };
  useEffect(() => {
    // A cross-webview payload can name a project/agent this window's store hasn't rehydrated yet
    // (crossWindowSync coalesces up to 300ms — another webview adds a project, then immediately asks us
    // to show it). Dropping would be a dead click (roborev 46328-M2), so on an unknown id we
    // DEFER the whole response — raise included — and act once the id appears.
    //
    // Exactly ONE deferral is ever in flight, and the effect's cleanup cancels it (roborev
    // 46485-M). Both properties are load-bearing: an untracked deferral fires `replace` /
    // `selectAndOpen` after this hook unmounts (store writes from a dead tree, and cross-test
    // bleed, since the stores are module state); and N un-deduped deferrals mean the tab you
    // land on is whichever project rehydrated last, not the notification you clicked.
    let cancelPending: (() => void) | null = null;
    /** Drop whatever deferral is watching the store. Called by BOTH handlers before they act —
     *  `awaitInStore` cancelling its own predecessor covers deferral-vs-deferral, but the
     *  focus-agent FAST path reveals inline and never enters awaitInStore, so a pending deferral
     *  would still fire afterwards and re-point the tab at the older click (roborev 46897). */
    const cancelDeferral = (): void => cancelPending?.();
    const awaitInStore = (
      probe: () => boolean,
      act: () => void,
      timeoutMs = 3_000,
    ): void => {
      cancelDeferral();
      if (probe()) {
        act();
        return;
      }
      const stop = () => {
        cancelPending = null;
        unsub();
        clearTimeout(timer);
      };
      const unsub = useProjectStore.subscribe(() => {
        if (!probe()) return;
        stop();
        act();
      });
      const timer = setTimeout(stop, timeoutMs);
      cancelPending = stop;
    };
    const handle = (p: FocusAgentPayload) => {
      const { replace: setProject } = ctx.current;
      // VALIDATE FIRST. The broadcast can be stale (the roster lags a deletion) or rogue,
      // and everything below is a side effect: `runtimeStore.open` does not check that the agent
      // exists, so a phantom id would sit in `openAgentIds` forever (roborev 46249-L1). But a
      // stale AGENT id must still raise the window and land on its project when that project
      // exists (roborev 46328-M3) — the user clicked a notification; give them the closest thing.
      //
      // The RAISE rides along with that validation instead of preceding it (roborev 46485-L):
      // a window that jumps to the front is a real interruption, so it is owed to a payload that
      // names something we can show — immediately when the project is already here, one coalesce
      // later when it is still rehydrating, and never for an id that never arrives.
      if (!agentExists(p.projectId, p.agentId)) {
        awaitInStore(
          () => useProjectStore.getState().projects.some((x) => x.id === p.projectId),
          () => {
            void bringToFront();
            if (agentExists(p.projectId, p.agentId)) {
              // The agent arrived with the rehydrate — do the full reveal after all.
              //
              // UNCONDITIONAL, for the same reason as the fast path below, and this branch needs it
              // MORE: it runs when the agent was not in the store yet, i.e. the cross-webview case
              // where `requestProjectTabFromOtherWindow` has already written `selectedProjectId`
              // side-blind and projectStore has synced it in. Comparing against that value — the
              // RIGHT pair's selection — saw an equal id for a LEFT-assigned project, skipped the
              // write, and left `leftProjectId` untouched while `selectAndOpen` mounted the agent
              // into a stage showing something else. The seam is idempotent. (roborev 55196)
              ctx.current.replace(p.projectId);
              selectAndOpen(p.projectId, p.agentId);
            } else {
              openProjectTab(p.projectId);
            }
          },
        );
        return;
      }
      // If the click carried a specific prompt (a breadcrumb), queue a scroll to that turn; the
      // target agent's AgentPane consumes it once its terminal is mounted + PTY-ready. Missing/
      // scrolled-out markers (or think agents with no terminal) simply open without scrolling.
      const jumpToPrompt = () => {
        if (p.promptId) useScrollIntentStore.getState().request(p.agentId, p.promptId);
      };
      // SINGLE-WINDOW SHELL (CM-U7): this window shows every project, one per TAB, so it always
      // handles the broadcast — there is no owning-window question and no orphan case. A target in
      // another project simply selects that project's tab first (which is what `replace` now does).
      // This click resolves NOW, so any older deferral still waiting for its project is stale.
      cancelDeferral();
      void bringToFront();
      // UNCONDITIONAL — the `p.projectId !== mine` guard was wrong once the left pair existed.
      //
      // `mine` is `selectedProjectId`, which is the RIGHT pair's selection; for a LEFT-assigned
      // project it is not that pair's selection at all. The tray/capture webview reaches here with
      // `selectedProjectId` ALREADY pointing at the left project — `requestProjectTabFromOtherWindow`
      // writes it side-blind and projectStore is cross-window synced synchronously — so the guard
      // saw `p.projectId === mine`, skipped the write, and `leftProjectId` never moved. The agent
      // then mounted and selected into a stage whose pair was showing something else: a dead click.
      // The fix cannot live in the emitting webview, because uiStore (which holds the assignment
      // map) is deliberately NOT cross-window synced — only the main window can route this.
      // `setProject` is idempotent for a project already selected on its own side. (roborev 55192)
      setProject(p.projectId);
      selectAndOpen(p.projectId, p.agentId);
      jumpToPrompt();
    };
    // "Show me this project" from the tray/capture webview: select the tab, raise the window, and
    // drop the app-global Improve Sparkle overlay (with the workMode that pairs with it, see
    // services/openProjectTab) — nothing agent- or PTY-related. NO agent is mounted and no PTY is
    // spawned: that is the whole difference from focus-agent, and the reason this is its own event.
    const handleSelectProject = (p: SelectProjectPayload) => {
      // Raise + select together, deferring briefly if the project was just added in another
      // webview and hasn't rehydrated here yet (roborev 46328-M2 / 46485-L).
      awaitInStore(
        () => useProjectStore.getState().projects.some((x) => x.id === p.projectId),
        () => {
          void bringToFront();
          openProjectTab(p.projectId);
        },
      );
    };
    // A band chiclet on the floating helper island: raise the window and put that band in front of
    // the user. Deliberately does NOT mount an agent or spawn a PTY — the click means "show me
    // what's urgent", not "open this specific agent", which is why it is its own event.
    const handleFocusTier = (p: FocusTierPayload) => {
      void bringToFront();
      // Isolating writes the SAME statusFilter the sidebar's chips render, so the click's effect is
      // visible in the chip bar and clearable by the ordinary "Show all" — rather than an invisible
      // mode with its own bespoke dismiss control. (The older note here worried about clobbering
      // `agentOrdering`; that preference no longer exists — the column has one ordering now.)
      useUiStore.getState().isolateStatusBand(p.band);
    };
    // Keep the listen() promise; safeUnlisten awaits it on cleanup so a listener that resolves
    // AFTER unmount is still torn down (and the Tauri teardown race is swallowed).
    const unlistenPromise = onFocusAgent(handle);
    const unlistenSelect = onSelectProject(handleSelectProject);
    const unlistenTier = onFocusTier(handleFocusTier);
    return () => {
      void safeUnlisten(unlistenPromise);
      void safeUnlisten(unlistenSelect);
      void safeUnlisten(unlistenTier);
      // Drop any deferral still watching the store: without this it fires into an unmounted tree
      // (and, in tests, into the NEXT case's stores — roborev 46485-M).
      cancelDeferral();
    };
  }, []);
}

// Stable empty reference so the agents selector doesn't return a fresh [] each render.
const EMPTY_AGENTS: AgentTab[] = [];
