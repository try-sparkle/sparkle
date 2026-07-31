// projectStore — the persisted structure (spec §4): projects, their agent tabs, names,
// last prompts. Persisted to localStorage (durable in the Tauri webview) so quit/relaunch
// restores everything. Live process/status state is NOT here (see runtimeStore).
import { create } from "zustand";
import type { GoalVerify } from "@sparkle/core";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import type {
  AgentKind,
  AgentName,
  AgentTab,
  AgentTabStatus,
  Project,
  PromptHistoryEntry,
  PromptSource,
  Runtime,
} from "../types";
import {
  advanceAlertRecord,
  dismissedRecord,
  reenabledRecord,
  EMPTY_ALERT,
} from "../engine/alertDismissal";
import {
  chargeGoalDebt,
  type GoalDebt,
  clearGoalMet,
  escalateGoal,
  goalDebtOf,
  markGoalMet,
  newGoal,
  noteContinue,
  resetGoalRetries,
} from "../engine/agentGoal";
import { isDefaultModel } from "../services/models";
import { clearPin } from "../services/accountStore";
import { clearBrief } from "../services/agentBrief";
import { usageTelemetry } from "../services/usageTelemetry";
import { perfSpan, perfStart } from "../perfTrace";
import { useUiStore } from "./uiStore";
import { openProjectsOf } from "../engine/openProjects";
import { normalizeAgentName } from "../engine/decodeEntities";
import { noteAgentTranscriptWorktree } from "../services/agentTranscriptRegistry";

// Cap on how many prompts we keep per agent so the persisted localStorage record stays bounded.
// The oldest entries fall off; the most recent PROMPT_HISTORY_LIMIT are kept — PER SOURCE (see
// capPromptHistory), so a burst of picker answers can never evict real composer prompts.
export const PROMPT_HISTORY_LIMIT = 100;

/**
 * Trim prompt history to the most recent {@link PROMPT_HISTORY_LIMIT} entries **of each source**,
 * preserving chronological order. Capping the union would let a picker-heavy session (the exact use
 * case this tagging targets) push real composer prompts off the end, shrinking the breadcrumb —
 * `composerPrompts` reads this already-capped list. Independent caps keep each class bounded (so the
 * persisted record stays small — at most 2×limit) while guaranteeing composer history is only ever
 * evicted by more composer prompts, exactly as before picker entries were recorded. A missing
 * `source` counts as composer. Pure; exported for unit testing.
 */
export function capPromptHistory(entries: PromptHistoryEntry[]): PromptHistoryEntry[] {
  if (entries.length <= PROMPT_HISTORY_LIMIT) return entries; // fast path: can't exceed either cap
  const keep = new Set<number>();
  for (const wantPicker of [true, false]) {
    let kept = 0;
    for (let i = entries.length - 1; i >= 0 && kept < PROMPT_HISTORY_LIMIT; i--) {
      if ((entries[i]!.source === "picker") === wantPicker) {
        keep.add(i);
        kept++;
      }
    }
  }
  return entries.filter((_, i) => keep.has(i));
}

// Options for creating an agent. `kind` defaults to "build" (the orchestrator you talk to);
// `parentId` is set only for workers spawned under a build agent.
export interface AddAgentOpts {
  kind?: AgentKind;
  parentId?: string | null;
  name?: string;
  task?: string;
  parentBranch?: string;
  shellCommand?: string;
  beadId?: string;
  /** Claude model id for this agent (services/models.ts); undefined/"default" → inherit the
   *  user's Claude Code default. */
  model?: string;
  /** "plan" launches the agent in plan mode (`--permission-mode plan`). Omitted = ordinary mode;
   *  there is deliberately no "build" value, so a spawn that didn't ask can't override the user's
   *  own permission default. See AgentTab.permissionMode. */
  permissionMode?: "plan";
  /** Pre-issued tab id. For a CLOUD agent the server-issued session id IS the tab id (spec
   *  §Identity: server session id = AgentTab id), so the caller passes it here instead of letting
   *  the store mint a uuid. Local agents omit it and get a fresh uuid. */
  id?: string;
  /** Execution runtime. Defaults to "local" (today's behavior). "cloud" tabs are created after a
   *  successful POST /sessions/start and rely on W4's CloudTransport to attach. */
  runtime?: Runtime;
  /** Whether creating this agent also SELECTS it. Defaults to true — a tab the user asked for should
   *  be the one they land on. Pass `false` for a MACHINE-created agent (spawnWorker, driven by an
   *  MCP request from an orchestrator): yanking the user's terminal to an agent they never asked for
   *  is disruptive on its own, and a selected worker forces its orchestrator's subtree open (the
   *  sidebar reveals a selected worker), which is how "subtrees open only on attention" was defeated
   *  once already. Suppressing the selection HERE rather than selecting-then-restoring is what keeps
   *  it invisible: there is no intermediate state for a render to observe, so nothing depends on
   *  React batching the two writes, and no phantom `switch:` perf waterfall is opened.
   *
   *  `false` is ABSOLUTE — it means "never select", with no condition the caller can't see. It used
   *  to self-cancel when nothing was selected ("fill the empty slot"), which quietly made the flag
   *  mean two different things depending on invisible state: a null selection is NOT a hole to
   *  backfill, it is DELIBERATE (Workspace's ladder pick and closeAgent's selectionAfterClose both
   *  produce it — e.g. every row hidden by the status filter — and mergePreservingLiveWorkers
   *  documents a live null as authoritative intent, not "no opinion"). Backfilling it handed the
   *  user's terminal to a machine-created worker and, through the sidebar's selection-reveal effect,
   *  forced its orchestrator's subtree open — the exact expand-on-spawn behavior §14 removed. The
   *  pane-less case belongs to whoever PRODUCED the deselect, not to a spawn. */
  select?: boolean;
  /** Epoch ms this row was created (AgentTab.createdAt). Defaults to Date.now(). Exposed mainly so a
   *  test can BACKDATE a worker past the unstarted-worker dwell (engine/workerAttention) to exercise a
   *  genuine strand; production callers omit it. */
  createdAt?: number;
}

// Default display name for a freshly created agent, numbered within its kind so you get
// "Build 1", "Worker 2", etc.
function defaultAgentName(p: Project, kind: AgentKind): string {
  const label = kind === "worker" ? "Worker" : kind === "shell" ? "Shell" : "Build";
  const n = p.agents.filter((a) => a.kind === kind).length + 1;
  return `${label} ${n}`;
}

function uuid(): string {
  return crypto.randomUUID();
}

export interface ProjectState {
  projects: Project[];
  selectedProjectId: string | null;

  /** Shared removal tombstones: id → removedAt (epoch ms), for both AGENT and PROJECT ids (both are
   *  uuids, so one map can't collide). This is the EXPLICIT delete signal that makes the union merge
   *  safe (sparkle-pckz / sparkle-8osl). Before it, the merge inferred deletion from ABSENCE in the
   *  incoming snapshot — but absence has two irreconcilable meanings across windows: "deleted
   *  elsewhere" and "the writer hadn't seen it yet". Treating absence as deletion is what silently
   *  evicted live build agents ("my build agents keep disappearing"); treating it as not-yet-seen
   *  would resurrect closed ones. Recording deletes explicitly separates the two: the merge UNIONS
   *  by id and drops exactly what is tombstoned. Persisted (so it crosses windows) and bounded to
   *  MAX_TOMBSTONES, evicting the oldest removals first. */
  removedIds?: Record<string, number>;

  addProject: (name: string, rootPath: string) => string;
  removeProject: (id: string) => void;
  selectProject: (id: string) => void;
  /** Set the cold-start restore hint (the project a relaunch reopens) without bumping
   *  lastOpenedAt. ONLY the main window claims this as it navigates — it's the window a restart
   *  restores. Accepts null (main window showing no project) so restart falls back to the first
   *  project. Secondary windows never call this; each owns its own current project. */
  setSelectedProject: (id: string | null) => void;
  /** Bump lastOpenedAt only (for Recent ordering) without claiming the shared
   *  selectedProjectId — multi-window: each window owns its own current project. */
  touchProjectOpened: (id: string) => void;
  /** Update name + folder location together (after the on-disk move succeeds). Recomputes
   * each agent's worktree path under the new root. */
  relocateProject: (id: string, newName: string, newRootPath: string) => void;
  /** Persist the project's logical integration branch (auto-detected on first agent, editable). */
  setDefaultBranch: (projectId: string, branch: string) => void;
  /** Cache the ORCHESTRATION-side project id this local project maps to (cloud agents). Resolved
   *  once by services/cloudAgents/projectLink.ts, then reused for every start/list call. */
  setCloudProjectId: (projectId: string, cloudProjectId: string) => void;

  /** Create an agent tab in `projectId`. Returns its id, or NULL when no such project exists in
   *  this window's store (nothing is created — see the guard in the implementation). */
  addAgent: (projectId: string, opts?: AddAgentOpts) => string | null;
  /** Attach a bead id to an existing agent (e.g. after async bead creation on build-agent spawn). */
  setAgentBeadId: (projectId: string, agentId: string, beadId: string) => void;
  /** Set the agent's Claude model (a models.ts id, or "default"/undefined to inherit the user's
   *  Claude Code default). Persisted only — delivering the change to a live PTY is the caller's
   *  job (services/agentModel.ts). */
  setAgentModel: (projectId: string, agentId: string, model: string | undefined) => void;
  /** Set the agent's live "what I'm building now" activity narration (sparkle-control MCP
   *  set_agent_activity). Free-text; empty string clears the line. Persisted like the name. */
  setAgentActivity: (projectId: string, agentId: string, activity: string) => void;
  /**
   * Set / replace / clear an agent's GOAL — the standing objective that decides whether an idle turn
   * gets auto-continued (engine/goalContinuation) and whether an idle row reads "done" or "stalled"
   * (engine/agentStall). An empty string CLEARS it, which also disables auto-continue for that agent.
   *
   * `actor` decides how much the caller is TRUSTED with. `"human"` (the default) starts genuinely new
   * text on a clean budget and releases any stashed debt — clearing really is an opt-out for them.
   * `"agent"` carries the old goal's `totalContinues` and any escalation forward, ACROSS A CLEAR as
   * well as across a rewording (see `GoalDebt` in engine/agentGoal), so no sequence of self-calls can
   * launder either invariant. The agent-facing control op passes `"agent"`.
   */
  setAgentGoal: (
    projectId: string,
    agentId: string,
    text: string,
    ttlMs?: number,
    actor?: "human" | "agent",
    /** HOW this goal is checked. Stating it is what makes the goal UN-SELF-MARKABLE — see
     *  @sparkle/core `canSelfMarkMet`, enforced in controlListener.handleSetGoalMet. Absent leaves the
     *  goal self-markable, which is the compatibility path for every goal predating the field.
     *
     *  THREE VALUES, NOT TWO. `undefined` = "not stated", which KEEPS whatever check the goal or its
     *  stashed debt already owed. `null` = **drop the check** — the deliberate human take-back, and
     *  the only route by which a stated check ever leaves an agent. This store does not police who
     *  may pass `null`; `controlListener.handleSetGoal` restricts it to the concierge, which is where
     *  caller authority already lives (roborev 55933). */
    verify?: GoalVerify | null,
  ) => void;
  /** Mark the current goal met (or un-mark it). This is the only thing that makes an idle agent
   *  legitimately finished, so it is the agent's own way to stop being resumed. */
  setAgentGoalMet: (projectId: string, agentId: string, met: boolean) => void;
  /** Record that an auto-continue was just spent, against the progress mark it was spent at.
   *  Advances the retry counters the escalation bound is read from. */
  noteAgentGoalContinue: (projectId: string, agentId: string, mark: string) => void;
  /** Hand the goal to the human — auto-continue has given up. Latched; only `resetAgentGoalRetries`
   *  or a HUMAN's new goal clears it. An AGENT's own `setAgentGoal` does not, however it rephrases or
   *  clears first — see `GoalDebt` in engine/agentGoal for why that distinction is load-bearing. */
  escalateAgentGoal: (projectId: string, agentId: string, reason: string) => void;
  /** Clear the retry budget and any escalation, because a human acted on this agent. */
  resetAgentGoalRetries: (projectId: string, agentId: string) => void;
  /** Bind the epic an orchestrator is building (set at sendToBuild handoff — drives the sidebar
   *  epic pill immediately, before any of its workers bind to a bead). */
  setAgentEpicId: (projectId: string, agentId: string, epicId: string) => void;
  removeAgent: (projectId: string, agentId: string) => void;
  /** Manual rename: sets the name AND freezes it against auto-renaming (shows the chip). It no
   *  longer anchors the row — row order is the human's drag arrangement (see reorderAgent). */
  renameAgent: (projectId: string, agentId: string, name: string) => void;
  /** Self-name: the AGENT names ITSELF via the sparkle-control `rename_agent` op. Sets the name and
   *  marks it authoritative (`selfNamed` — freezes auto-naming, skips paid Haiku, survives rehydrate)
   *  WITHOUT freezing it against the human: no chip, so there is nothing to "unpin". A human rename
   *  (`namePinned`) still wins — a self-name is a no-op over it. */
  selfNameAgent: (projectId: string, agentId: string, name: string) => void;
  /** Auto-rename from the naming model. No-op if the user has pinned the name. Records the
   *  basis prompt so we can later detect when the work has shifted enough to re-name. Pass
   *  `autoName` (title + description) to enable the truncated title + hover description; `name` is
   *  the canonical fallback (callers set it to the title). */
  autoRenameAgent: (
    projectId: string,
    agentId: string,
    name: string,
    basis: string,
    autoName?: AgentName | null,
    /** The `aiTitle` the caller's naming decision was made against. The store applies the rename
     *  only if the agent's title still matches it — see the implementation for why this replaces a
     *  blanket "never overwrite an aiTitle" guard. */
    seenAiTitle?: string | null,
  ) => void;
  /** Apply Claude Code's session title (`ai-title`) as the authoritative auto-name. No-op if the
   *  user has pinned the name, the title is empty, or it's already applied. Supersedes any
   *  prompt-derived name and records `aiTitle` so later changes are detected and further Haiku
   *  naming is suppressed. */
  applyAiTitle: (projectId: string, agentId: string, title: string) => void;
  /** Reset an agent's name back to the kind default and drop all auto-name metadata
   *  (`autoNameBasis`/`autoNameVariants`/`aiTitle`). Called when a slot starts a FRESH Claude
   *  session (nothing to `claude --resume`) so a reused worktree slot doesn't keep showing the
   *  PRIOR occupant's auto-name. No-op when the name is pinned — a manual rename is the user's
   *  choice and survives a fresh start. */
  resetAutoName: (projectId: string, agentId: string) => void;
  /** Move `agentId` so it sits immediately BEFORE `beforeAgentId` in `project.agents` (or at the
   *  end when that is null). This is the ONE source of row order in the Build column: rows are
   *  grouped into the stage ladder (engine/buildSections.ts) and, within a stage, render in
   *  `project.agents` order — so reordering the array IS the user's arrangement, and it persists
   *  with the project like any other agent field.
   *
   *  Replaces the old `pinAgentAt`/`pinnedIndex` anchor, which existed only to hold a row still
   *  against the attention sort. With nothing re-sorting rows behind the user's back there is
   *  nothing to anchor against, so the pin concept is gone entirely. */
  reorderAgent: (projectId: string, agentId: string, beforeAgentId: string | null) => void;
  /** Move a project before `beforeProjectId`, or to the end when it is null. This IS tab reorder:
   *  engine/openProjects.ts renders the strip in `projects` order and deliberately does not
   *  re-derive order from the open set, so the drag has to move the project itself. Same
   *  drop-onto-a-slot semantics as reorderAgent, including its direction rule. */
  reorderProject: (projectId: string, beforeProjectId: string | null) => void;
  /** Release a manual name freeze so the agent auto-names again. (Formerly also cleared a row
   *  anchor; row anchoring no longer exists — see reorderAgent.) */
  /** Advance every agent's alert-episode record for the current (pre-dismissal) status map
   *  (engine/alertDismissal.ts). Called from the sidebar whenever the overlaid status map changes;
   *  writes ONLY when some record actually changed — which is only on a red-tier transition, not on
   *  every status tick — so it doesn't churn the persisted blob. */
  advanceAlerts: (projectId: string, statusMap: Record<string, AgentTabStatus>) => void;
  /** Dismiss an agent's current red alert: the row recolors to its non-alerting tone and drops out
   *  of the red zone, WITHOUT changing its true status. Re-alerts automatically on a new/different
   *  red episode (a fresh question, an error, a re-entered red). `status` is the agent's current TRUE
   *  (pre-dismissal) status — threaded so the episode is recorded even if `advanceAlerts` hasn't run
   *  yet, otherwise the next advance would treat it as a fresh episode and discard the dismissal. */
  dismissAlert: (projectId: string, agentId: string, status: AgentTabStatus) => void;
  /** Re-enable a dismissed alert: clears the dismissal so the row goes red again immediately. */
  reenableAlert: (projectId: string, agentId: string) => void;
  /** Select an agent, or pass `null` to clear selection (routes the main pane to the blank state). */
  selectAgent: (projectId: string, agentId: string | null) => void;
  setAgentWorktree: (projectId: string, agentId: string, path: string, branch: string) => void;
  /** Re-adopt a worker whose worktree + on-disk manifest survive on disk but whose in-memory
   *  record was evicted by a reconcile/relocation/cross-window race (sparkle-3xus). Inserts a
   *  worker AgentTab under `worker.parentId` if none with `worker.id` exists; a no-op when the
   *  record is already present. Deliberately does NOT touch `selectedAgentId` — reconcile is a
   *  background self-heal, not a user navigation, so it must not yank the user's active tab. */
  adoptWorker: (
    projectId: string,
    worker: {
      id: string;
      parentId: string;
      branch: string | null;
      worktreePath: string | null;
      task?: string;
      beadId?: string;
      parentBranch?: string;
    },
  ) => void;
  /** Record a submitted prompt: updates `lastPrompt` (pinned header) AND appends to
   *  `promptHistory` (capped). Returns the new entry's id so the caller can register the matching
   *  terminal scroll marker under the same key. */
  /** `humanAuthored` decides whether this send RELEASES the agent's goal debt (see
   *  `releaseGoalDebt`). Defaults to true because every gesture-driven caller is a person typing or
   *  clicking; the concierge's own tool layer passes false, because prose an LLM composed is not "a
   *  human changed the picture" even when a human's policy authorized it (roborev 55588). */
  appendPrompt: (
    projectId: string,
    agentId: string,
    text: string,
    source?: PromptSource,
    humanAuthored?: boolean,
  ) => string;
  /** Record that the user submitted a line straight into this agent's terminal — the DURABLE twin
   *  of interactionStore's in-memory `lastAt`. Stamps once and never moves, because the only
   *  question it answers is "has anyone ever briefed this?" (engine/newAgentAttention route 5). */
  noteTerminalBrief: (projectId: string, agentId: string) => void;
}

function mapProject(
  projects: Project[],
  id: string,
  fn: (p: Project) => Project,
): Project[] {
  return projects.map((p) => (p.id === id ? fn(p) : p));
}

/** Wrap a single Claude Code session title as an {@link AgentName}. The session title has no
 *  separate description (it's derived from the whole conversation, not a title+blurb pair), so the
 *  description is empty — the hover card then shows just the title. Exported for unit testing. */
export function nameFromTitle(title: string): AgentName {
  return { title: title.trim(), description: "" };
}

/** Backfill the main-first-defaults fields on persisted state so legacy records rehydrate with
 *  `null` (matching fresh records) rather than `undefined` — an undefined baseBranch would
 *  otherwise reach the git commands as "". Exported for direct unit testing. */
export function migratePersisted(persisted: unknown, version: number): unknown {
  const state = persisted as ProjectState | undefined;
  if (!state || !Array.isArray(state.projects)) return state;
  if (version < 11) {
    // Shared removal tombstones (sparkle-pckz). A legacy blob records no deletions; the union merge
    // then keeps everything it sees, and the first close under the new build seeds the map. Also
    // repairs a non-object value written by a hand-edited/corrupt blob.
    state.removedIds =
      state.removedIds && typeof state.removedIds === "object" ? state.removedIds : {};
  }
  if (version < 1) {
    state.projects = state.projects.map((p) => ({
      ...p,
      defaultBranch: p.defaultBranch ?? null,
      // Defensively default a missing nested array so a malformed legacy record degrades
      // instead of throwing out of zustand's migrate and breaking rehydration entirely.
      agents: (p.agents ?? []).map((a) => ({ ...a, baseBranch: a.baseBranch ?? null })),
    }));
  }
  if (version < 2) {
    // Auto-naming fields (main #23). Treat an existing legacy name as user-chosen so we never
    // silently rewrite a name the user already saw — they can unpin if they want auto-naming.
    state.projects = state.projects.map((p) => ({
      ...p,
      agents: (p.agents ?? []).map((a) => ({
        ...a,
        namePinned: a.namePinned ?? true,
        autoNameBasis: a.autoNameBasis ?? null,
      })),
    }));
  }
  if (version < 3) {
    // Think/Build split: every legacy agent was a plain terminal agent, which now maps to
    // a top-level "build" agent (a Claude terminal you talk to). Backfill kind + parentId so the
    // sidebar tree and panel routing have defined values. Kept as its own step (not folded into
    // the v2 block) so records already migrated to v2 — auto-naming only — still gain these.
    state.projects = state.projects.map((p) => ({
      ...p,
      agents: (p.agents ?? []).map((a) => ({
        ...a,
        kind: a.kind ?? "build",
        parentId: a.parentId ?? null,
      })),
    }));
  }
  if (version < 4) {
    // Width-fitted names: agents gain `autoNameVariants`. Legacy records have only a single
    // `name`; default the field to null so display falls back to `name` until the next prompt
    // produces variants.
    state.projects = state.projects.map((p) => ({
      ...p,
      agents: (p.agents ?? []).map((a) => ({
        ...a,
        autoNameVariants: a.autoNameVariants ?? null,
      })),
    }));
  }
  if (version < 5) {
    // Prompt history (pinned-header dropdown). Backfill an empty array so existing agents
    // rehydrate with a defined list. We intentionally do NOT seed it from the legacy single
    // `lastPrompt`: that prompt predates the feature so it has no scroll marker, and its submit
    // time is unknown — history simply starts accumulating from the next prompt.
    state.projects = state.projects.map((p) => ({
      ...p,
      agents: (p.agents ?? []).map((a) => ({
        ...a,
        promptHistory: a.promptHistory ?? [],
      })),
    }));
  }
  if (version < 6) {
    // Run-as-cmd "shell" agents (terminal selection popup) added the shellCommand field.
    // Folded in from PR #62 as v6: it shipped as v4 on its own branch, but main had already
    // taken v4 (autoNameVariants) and v5 (promptHistory), so it becomes the next step here.
    state.projects = state.projects.map((p) => ({
      ...p,
      agents: (p.agents ?? []).map((a) => ({ ...a, shellCommand: (a as AgentTab).shellCommand ?? null })),
    }));
  }
  if (version < 7) {
    // The agent kind formerly persisted as "brainstorm" was renamed to "think", which has since been
    // removed entirely. Remap the legacy literal straight to "build" (the v12 step below does the same
    // for "think"), so a legacy chat-only agent becomes a build agent that provisions its worktree on
    // next open. Matched as a raw string since neither literal is part of AgentKind anymore.
    state.projects = state.projects.map((p) => ({
      ...p,
      agents: (p.agents ?? []).map((a) =>
        (a.kind as string) === "brainstorm" ? { ...a, kind: "build" } : a,
      ),
    }));
  }
  if (version < 9) {
    // Heal the sparkle-pel7 residue. Before that fix, the `rename_agent` control op routed through
    // renameAgent(), which froze the row (namePinned:true) every time an agent named ITSELF. Pel7
    // rerouted self-naming to selfNameAgent() (name authoritative, row NOT pinned) — but nothing
    // cleared the pins already written to localStorage, so those rows kept showing a pin chip
    // ("rows get pinned without the user pinning them"). The frozen self-name has an exact
    // fingerprint that no legitimate pin shares:
    //   • namePinned:true                    — it's showing the pin chip
    //   • pinnedIndex == null                — a real manual/drag pin (renameAgent w/ index, or
    //                                           pinAgentAt) always records a row anchor; this never did
    //   • kind is "build" | "worker"         — a Think→epic rename (renameAgent, index-less) is kind
    //                                           "think"; a Run-as-cmd tab is "shell" — both deliberate
    //   • !selfNamed                          — the old path never set selfNamed
    // Convert exactly that shape to the state the fixed path would have produced: keep the chosen
    // name, drop the pin (namePinned:false → rejoins the attention sort, no chip) and mark it
    // selfNamed so the name stays authoritative and is never clobbered by auto-naming. Anything with
    // a pinnedIndex, a think/shell kind, or already-selfNamed is a real pin and left untouched.
    //
    // KNOWN, ACCEPTED AMBIGUITY (roborev): before bbea8ac4 (2026-06-27, the "rename anchors at the
    // displayed row" change) the sidebar's MANUAL rename also called renameAgent() WITHOUT an index,
    // so a pre-bbea8ac4 user rename of a build/worker agent has the IDENTICAL fingerprint and no field
    // distinguishes it from the pel7 residue. Such a record is also healed to selfNamed. Trade-off,
    // deliberately taken:
    //   • Removing the erroneous pin is the whole point, and it fixes the COMMON case (agents that
    //     named themselves — the reported bug).
    //   • selfNamed is the LEAST-lossy heal available: like namePinned it freezes the name against
    //     auto-naming, so the name the user sees is preserved. The ONLY divergence from the old
    //     namePinned state is resetAutoName (AgentPane slot-reuse): a namePinned row was kept forever,
    //     whereas a selfNamed row is cleared to the kind default when its worktree is wiped and the
    //     slot is reused with no resumable session. For the common (self-name) case that clear is
    //     CORRECT — the name belonged to the prior occupant. For the rare mislabeled manual rename it
    //     means the name reverts to "Build 1" on that specific reuse event — accepted as strictly
    //     better than leaving every self-named row wearing a stuck, un-earned pin chip.
    // See projectStore.migrate.test.ts ("ambiguous pre-unified-pin manual rename") for the pinned-down
    // behavior of this case.
    state.projects = state.projects.map((p) => ({
      ...p,
      agents: (p.agents ?? []).map((a) => {
        const isStaleSelfNamePin =
          a.namePinned === true &&
          (a as { pinnedIndex?: number | null }).pinnedIndex == null &&
          !a.selfNamed &&
          (a.kind === "build" || a.kind === "worker");
        return isStaleSelfNamePin ? { ...a, namePinned: false, selfNamed: true } : a;
      }),
    }));
  }
  if (version < 10) {
    // Picker-tagging (Task 2.3): promptHistory entries gain a `source`. Every entry that predates
    // this change was a real composer/seed prompt (picker answers were never recorded before), so
    // backfill "composer". Readers already treat a missing `source` as "composer", so this is for
    // explicitness/consistency rather than correctness — but it means a re-serialized record carries
    // the field, and any future logic keyed on `source` sees a fully-populated history.
    state.projects = state.projects.map((p) => ({
      ...p,
      agents: (p.agents ?? []).map((a) => ({
        ...a,
        promptHistory: (a.promptHistory ?? []).map((e) => ({ ...e, source: e.source ?? "composer" })),
      })),
    }));
  }
  if (version < 12) {
    // The "think" agent kind (Chief chat, no worktree/PTY) was removed with the Think tab. Remap any
    // persisted think agent to "build" so it becomes a normal build agent — its worktree is
    // provisioned lazily on next open, and its chat prompt history rides along harmlessly. Matched as
    // a raw string since "think" is no longer part of AgentKind.
    state.projects = state.projects.map((p) => ({
      ...p,
      agents: (p.agents ?? []).map((a) =>
        (a.kind as string) === "think" ? { ...a, kind: "build" } : a,
      ),
    }));
  }
  // Version-collision safety net. PR #62 shipped shellCommand as v4 on its own branch while main
  // independently used v4=autoNameVariants and v5=promptHistory. A store persisted under #62's v4
  // would report version===4, so the version-gated `< 4` block above (now autoNameVariants) is
  // skipped and that agent rehydrates with autoNameVariants `undefined` — violating its
  // non-optional type. Normalize all three fields unconditionally (idempotent `??` no-ops on
  // records that already have them) so every agent satisfies its type regardless of which branch's
  // version number it was saved under.
  //
  // HEAL NAMES ALREADY WRITTEN ESCAPED. The ingest normalizers (selfNameAgent via the control
  // listener, autoRenameAgent, applyAiTitle) stop NEW escaped names, but they cannot touch the ones
  // already sitting in localStorage — and the reported case ("Pane Mounting &amp; Resize Perf") is
  // exactly one of those. Decoding here is idempotent and a no-op for every name without an entity
  // in it, which is nearly all of them. Version-independent for the same reason as the fields
  // above: a blob saved under any prior version can carry one.
  state.projects = state.projects.map((p) => ({
    ...p,
    agents: (p.agents ?? []).map((a) => ({
      ...a,
      name: typeof a.name === "string" ? normalizeAgentName(a.name) : a.name,
      aiTitle: typeof a.aiTitle === "string" ? normalizeAgentName(a.aiTitle) : a.aiTitle,
      autoNameVariants: a.autoNameVariants
        ? {
            title: normalizeAgentName(a.autoNameVariants.title),
            description: normalizeAgentName(a.autoNameVariants.description),
          }
        : (a.autoNameVariants ?? null),
      promptHistory: a.promptHistory ?? [],
      shellCommand: (a as AgentTab).shellCommand ?? null,
      // NOTE: the v8 `pinnedIndex` backfill was dropped — the field no longer exists on AgentTab
      // (row anchoring is gone; see types.ts). A blob persisted before 2026-07-26 may still carry
      // the key on disk; it is inert and simply ignored rather than migrated away, since nothing
      // reads it and rewriting every agent to delete one dead key isn't worth a migration step.
    })),
  }));
  return state;
}

function mapAgent(p: Project, agentId: string, fn: (a: AgentTab) => AgentTab): Project {
  return { ...p, agents: p.agents.map((a) => (a.id === agentId ? fn(a) : a)) };
}

/**
 * THE HUMAN'S RELEASE. Clears the retry budget, any escalation, and the stashed {@link GoalDebt}.
 *
 * WHY THIS IS A SHARED HELPER AND NOT INLINE IN `resetAgentGoalRetries` (roborev 55525). Carrying the
 * debt across a goal clear closed a real laundering hole — but `resetAgentGoalRetries` had ZERO
 * production callers and the only caller of `setAgentGoal` always passes `"agent"`, so BOTH documented
 * release levers were dead code. The effect was worse than the hole: `chargeGoalDebt` floors every
 * later goal at `Math.max(…, debt.totalContinues)`, so the first escalation made `decideContinuation`
 * answer `already-escalated` for the life of the persisted `AgentTab`, across restarts. The old
 * clear-then-set exploit had at least been an escape hatch; closing it without a release traded a
 * recoverable exploit for an unrecoverable agent. And the agent-facing copy promised a human action
 * that did not exist, which is the "a remedy string is an instruction" rule in AGENTS.md.
 *
 * So it is wired to what `resetGoalRetries` always SAID the trigger was — "a HUMAN changed the
 * picture: they typed to the agent, or rewrote the goal". That is `appendPrompt` (every caller is a
 * human-authored send: the composer, a picker answer, a suggestion click, the Build seed) and
 * `noteTerminalBrief` (a line typed straight into the PTY).
 *
 * ⚠️ THE AUTO-CONTINUE PATH MUST NEVER REACH THIS. `goalContinuationRunner` dispatches with
 * `userPrompt: false`, and `conciergeDispatch` gates `recordPromptSideEffects` — the only path from a
 * dispatch to `appendPrompt` — on `userPrompt`. If that gate is ever loosened, auto-continue starts
 * refilling its own budget on every restart and `MAX_CONTINUES_TOTAL` becomes vacuous. That is the
 * whole bound this feature rests on, so check this note before changing how a dispatch records itself.
 */
function releaseGoalDebt(a: AgentTab): AgentTab {
  // NOTHING OWED → THE SAME OBJECT, and the guard has to ask that literally (roborev 55588). It first
  // asked only whether a goal EXISTED, which is not the same question: `resetGoalRetries` always
  // allocates, so for every goal-bearing agent — including one at `totalContinues: 0` with no
  // escalation — this returned a fresh object and the fast path never fired. That is not a missed
  // micro-optimisation: `noteTerminalBrief` bails on it, so every submitted terminal line replaced
  // the agent, its goal and its project, wrote the persisted `sparkle-projects` blob, broadcast
  // cross-window sync and re-rendered the fleet — once per line, for exactly the agents the fleet is
  // actually running. The pre-existing comment there says that must not happen, and my own docstring
  // claimed it did not.
  const g = a.goal;
  // A STASH THAT HOLDS ONLY A CHECK OWES THIS RELEASE NOTHING (roborev 55933). `verify` is not part
  // of what typing releases (see below), so a debt consisting solely of it must not defeat the fast
  // path — otherwise every terminal line rewrites the agent, its goal and the persisted blob again,
  // which is the exact regression the paragraph above documents.
  const debtOwesNothing =
    a.goalDebt === undefined ||
    (a.goalDebt.totalContinues === 0 && a.goalDebt.escalatedAt === undefined);
  const owesNothing =
    debtOwesNothing &&
    (g === undefined ||
      (g.continues === 0 &&
        g.totalContinues === 0 &&
        g.escalatedAt === undefined &&
        g.mark === undefined));
  if (owesNothing) return a;
  const { goalDebt: _released, ...rest } = a;
  // THE STASHED CHECK SURVIVES THIS RELEASE. What fires here is ANY human-authored line — a composer
  // send, a picker answer, a suggestion click — which is a human engaging, not a human taking back a
  // verification method. Dropping `verify` here left the bypass this debt closes open one ordinary
  // gesture wide: agent states a check, agent clears its goal (check stashed), a human types
  // anything, agent sets new text, and the goal is unverified and self-markable again (roborev
  // 55933). The deliberate take-back is `set_agent_goal {verify: null}` from the concierge.
  const keptVerify = a.goalDebt?.verify;
  const withStash =
    keptVerify !== undefined
      ? { ...rest, goalDebt: { totalContinues: 0, verify: keptVerify } }
      : rest;
  return a.goal ? { ...withStash, goal: resetGoalRetries(a.goal) } : withStash;
}

/**
 * Drop the CHECK from a stashed debt, keeping everything else — and return `undefined` when nothing
 * is left to owe, so a take-back does not persist a `{ totalContinues: 0 }` on every agent it touches
 * (the same reason `goalDebtOf` returns `undefined` for a clean goal).
 */
function stripVerify(debt: GoalDebt): GoalDebt | undefined {
  const { verify: _dropped, ...rest } = debt;
  return rest.totalContinues === 0 && rest.escalatedAt === undefined ? undefined : rest;
}

/** localStorage key the project store persists under. Shared so cross-window sync
 *  (crossWindowSync.ts) listens on the same key instead of duplicating the literal. */
export const PROJECTS_PERSIST_KEY = "sparkle-projects";

/** Trailing-debounce window for the projects blob write (sparkle-pngb). Long enough to coalesce a
 *  burst of prompt appends / rapid tab switches into ONE write, short enough that a normal pause
 *  flushes promptly. Structural (cross-window) changes bypass this via flushProjectsPersist(). */
export const PROJECTS_PERSIST_DEBOUNCE_MS = 400;

/** Wrap `localStorage` so writes are TRAILING-DEBOUNCED (sparkle-pngb). projectStore persists the
 *  ENTIRE projects array — each agent up to PROMPT_HISTORY_LIMIT prompts — on EVERY mutation
 *  (appendPrompt on each keystroke-submitted prompt, selectAgent on every tab switch, …), and the
 *  JSON.stringify + setItem ran synchronously on the main thread each time. Coalescing bursts into
 *  one write keeps the UI responsive. Durability: the pending write is flushed on the trailing timer
 *  AND eagerly on pagehide/beforeunload/visibility-hidden, so a quit/relaunch never loses the last
 *  write. `getItem` deliberately reads REAL localStorage (never this window's pending value) so a
 *  cross-window rehydrate reflects the shared on-disk truth and can't clobber another window's change
 *  with a not-yet-observed local edit. Exported for direct unit testing. */
export function debouncedLocalStorage(delayMs: number): { storage: StateStorage; flush: () => void } {
  const pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    for (const [k, v] of pending) {
      try {
        // Skip a redundant write when the value already on disk is byte-identical to what we'd write
        // (sparkle-noop-persist). The whole projects blob is re-persisted on many mutations that
        // don't change its serialized form (status ticks, reselecting the already-active tab, …), so
        // the same ~190KB string was re-written to localStorage over and over — pure synchronous
        // main-thread cost with no observable effect (and no cross-window storage event worth
        // firing, since disk already holds it). Compare against LIVE localStorage rather than a
        // cached last-written copy: that keeps the skip correct across windows — we only elide a
        // write when the shared on-disk truth ALREADY equals our value, never when another window
        // has since changed it.
        if (localStorage.getItem(k) === v) continue;
        // Time the synchronous main-thread write of the (potentially multi-MB) persisted blob — a
        // known past hotspot (sparkle-pngb). `bytes` shows whether a bloated projects blob (lots of
        // agents × promptHistory) is what's stalling writes (perfTrace).
        perfSpan("persist.setItem", () => localStorage.setItem(k, v), { key: k, bytes: v.length });
      } catch {
        /* quota exceeded / storage disabled — drop this write rather than throw out of persist */
      }
    }
    pending.clear();
  };
  if (typeof window !== "undefined") {
    // Never let a debounced write be lost to a quit or navigation.
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") flush();
      });
    }
  }
  const storage: StateStorage = {
    getItem: (name) => {
      try {
        return localStorage.getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      pending.set(name, value);
      if (!timer) timer = setTimeout(flush, delayMs);
    },
    removeItem: (name) => {
      pending.delete(name);
      try {
        localStorage.removeItem(name);
      } catch {
        /* ignore */
      }
    },
  };
  return { storage, flush };
}

/** EXPORTED for tests that must exercise the real 400ms coalescing window. A suite that swaps in a
 *  synchronous backend and then advances timers is testing nothing — the pending map it drains is
 *  no longer the one the store writes to (roborev 54833). Production wiring is unchanged: the store
 *  wraps this in `createJSONStorage` below. */
export const { storage: debouncedProjectsStorage, flush: flushProjectsPersistImpl } =
  debouncedLocalStorage(PROJECTS_PERSIST_DEBOUNCE_MS);

/** Synchronously flush any pending debounced projects write to localStorage. Called by the
 *  cross-window sync layer BEFORE it broadcasts a structural change (sparkle-pngb), so a receiving
 *  window rehydrates the fresh blob rather than a stale one still sitting in the debounce buffer. */
export function flushProjectsPersist(): void {
  flushProjectsPersistImpl();
}

/** Empty-set sentinel for the optional local-tombstone parameter below. */
const EMPTY_PENDING_ADDS: ReadonlySet<string> = new Set<string>();

/** Ids of agents REMOVED locally in THIS window but whose removal may not have propagated to the
 *  shared persisted blob yet. While an id lives here the merge
 *  FILTERS it out of any incoming snapshot, so a concurrent writer's stale snapshot that still
 *  carries the just-closed agent can't resurrect its row ("× closes the terminal but the row comes
 *  back", sparkle-close-resurrect). It also gates adoptWorker so the disk reconcile can't re-adopt a
 *  worker mid-teardown (its manifest lingers until the worktree is removed). Held until the id is
 *  deliberately re-created (addAgent clears it) — see registerLocalRemovals for why it is NOT cleared
 *  on propagation. Bounded by MAX_TOMBSTONES. Module-scoped: one set per window. */
const pendingLocalRemovals = new Set<string>();

/** Bound the tombstone set so a very long session (thousands of closes) can't grow it without limit.
 *  Ids are agent uuids, so the only entries that ever MATCH an incoming snapshot are ones a stale
 *  window is still broadcasting; once every window has converged past a removal, its tombstone is
 *  dead weight. Evicting the OLDEST first (Set preserves insertion order) drops the longest-settled
 *  entries. CAVEAT: this holds only when the worktree removal SUCCEEDED. removeAgentWorkspace is
 *  best-effort (errors swallowed), so a persistent git failure leaves the manifest on disk; then the
 *  tombstone is the sole thing stopping reconcileWorkersFromDisk from re-adopting the orphan, and
 *  evicting it after 500 further closes could re-expose that one row. That needs a persistent git
 *  failure AND 500+ closes in a single session AND a reconcile pass — vanishingly unlikely, and the
 *  cap is the lesser evil vs. an unbounded set. If it ever bites, gate eviction on confirmed cleanup. */
const MAX_TOMBSTONES = 500;

/** Register ids as locally removed so the merge/adopt paths suppress them. A removal tombstone is
 *  NOT cleared when a fresh snapshot arrives: doing so would reopen the race
 *  where a still-stale window (e.g. the hidden capture webview) re-broadcasts the closed agent AFTER
 *  the self-echo cleared the tombstone, resurrecting the row. A uuid is never legitimately re-added
 *  except by a deliberate local re-create (addAgent clears it), so keeping the tombstone is safe. */
export function registerLocalRemovals(ids: Iterable<string>): void {
  for (const id of ids) pendingLocalRemovals.add(id);
  while (pendingLocalRemovals.size > MAX_TOMBSTONES) {
    const oldest = pendingLocalRemovals.values().next().value;
    if (oldest === undefined) break;
    pendingLocalRemovals.delete(oldest);
  }
}

/** Drop ids from the removal tombstone — because the id is being re-created locally (addAgent) or
 *  a test is resetting state. Exported for tests. */
export function acknowledgeRemovals(ids: Iterable<string>): void {
  for (const id of ids) pendingLocalRemovals.delete(id);
}

/** True while an id is tombstoned (locally removed, not yet re-created). The disk reconcile consults
 *  this so it doesn't waste a no-op adoptWorker on a worker the user just closed. */
export function isLocallyRemoved(id: string): boolean {
  return pendingLocalRemovals.has(id);
}

/** Stamp ids into the PERSISTED tombstone map (sparkle-pckz) so the deletion crosses windows. The
 *  module-scoped `pendingLocalRemovals` above only protects THIS window; the union merge needs the
 *  removal to be visible in the shared blob, or another window's live copy would out-live it. */
function withTombstones(
  removedIds: Record<string, number> | undefined,
  ids: string[],
): Record<string, number> {
  if (ids.length === 0) return removedIds ?? {};
  const at = Date.now();
  const next = { ...(removedIds ?? {}) };
  for (const id of ids) next[id] = at;
  return boundTombstones(next);
}

/** Rehydration merge that NEVER drops a live worker (sparkle-3tqv). Every rehydrate — startup and,
 *  crucially, cross-window (crossWindowSync.ts rehydrates from the shared localStorage blob on
 *  every remote change) — replaces the in-memory `projects` with the persisted snapshot. If another
 *  window persisted a blob that predates a just-spawned worker (last-writer-wins), the default
 *  whole-array replace would EVICT that worker from this window even though its worktree + manifest
 *  are live on disk — the original corruption root cause Tier-1's `reconcileWorkersFromDisk` had to
 *  self-heal after the fact. This makes the merge itself protective: for each project, any in-memory
 *  worker with a cut worktree (`worktreePath` set) that is MISSING from the incoming snapshot is
 *  re-attached, provided its parent build agent still exists in that snapshot (so we never resurrect
 *  a worker whose orchestrator was deliberately closed). Everything else takes the persisted value,
 *  preserving the store's action functions (which the persisted JSON never carries). Pure + exported
 *  for direct unit testing.
 *
 *  PURE ONLY WHILE `onDropped` IS OMITTED, and that is the point. The merge DESTROYS agent rows that
 *  arrive tombstoned from another window, and those rows own per-agent state (an undelivered brief)
 *  that has to be torn down. An earlier cut did the teardown inside the merge, which made a function
 *  documented as pure quietly effectful — so calling it to PREVIEW or diff a rehydrate would have
 *  irreversibly destroyed live briefs (roborev 55888). The callback keeps the default pure for every
 *  test and hypothetical caller, and lets the ONE real caller (the persist `merge` hook) do the
 *  teardown explicitly, where it is visible. */
export function mergePreservingLiveWorkers(
  persistedState: unknown,
  currentState: ProjectState,
  pendingRemovals: ReadonlySet<string> = EMPTY_PENDING_ADDS,
  /** Receives the ids of agent rows this merge DROPPED (tombstoned elsewhere). Omit for a pure merge. */
  onDropped?: (ids: string[]) => void,
): ProjectState {
  const dropped: string[] | undefined = onDropped ? [] : undefined;
  const persisted = (persistedState ?? undefined) as Partial<ProjectState> | undefined;
  const merged = { ...currentState, ...(persisted ?? {}) } as ProjectState;
  const currentProjects = currentState.projects ?? [];
  const incoming = persisted?.projects ?? currentProjects;

  // UNION the tombstone maps from both sides so neither window loses a delete: a removal recorded
  // here but not yet propagated, and one propagated to us but not yet seen locally, must BOTH keep
  // suppressing. On the (impossible-in-practice) same-id collision the later removedAt wins.
  const tombstones = boundTombstones(mergeTombstones(currentState.removedIds, persisted?.removedIds));
  merged.removedIds = tombstones;
  /** Explicitly deleted — the ONLY reason the union drops something. `pendingRemovals` is the
   *  module-scoped local mirror kept for ids removed before this window wrote its tombstone. */
  const isRemoved = (id: string): boolean =>
    Object.prototype.hasOwnProperty.call(tombstones, id) || pendingRemovals.has(id);

  // Project UNION, in snapshot order first so the shared ordering stays stable, then any project
  // this window has that the snapshot hasn't caught up to. A project missing from the snapshot is
  // NOT evidence it was deleted (see removedIds) — only a tombstone deletes.
  const incomingById = new Map(incoming.map((p) => [p.id, p] as const));
  const projectOrder: string[] = [
    ...incoming.map((p) => p.id),
    ...currentProjects.map((p) => p.id).filter((id) => !incomingById.has(id)),
  ];
  merged.projects = projectOrder
    .filter((id) => {
      if (!isRemoved(id)) return true;
      // A whole PROJECT tombstoned in another window is discarded here, and every agent it carried
      // dies with it WITHOUT ever reaching `withoutRemovedAgents` or `mergeProject` — so without
      // this, none of their ids reach `dropped` and the callback's contract ("the ids of agent rows
      // this merge DROPPED") is false for a whole class of drops. That is the cross-window half of
      // the very path `removeProject` handles locally, so it is the shape most likely to occur
      // (roborev 55902). Consequence of missing it is a brief that never settles: the concierge's
      // spawn sits out its whole bound answering `unconfirmed`, and the held entry outlives the row.
      if (dropped) {
        for (const a of currentProjects.find((c) => c.id === id)?.agents ?? []) dropped.push(a.id);
      }
      return false;
    })
    .map((id) => {
      const ppMaybe = incomingById.get(id);
      const cur = currentProjects.find((c) => c.id === id);
      // Present only in memory (the snapshot's writer hadn't seen this project yet) — keep ours,
      // minus any agent that has since been tombstoned.
      if (!ppMaybe) return withoutRemovedAgents(cur as Project, isRemoved, dropped);
      return mergeProject(ppMaybe, cur, isRemoved, dropped);
    });

  // …and the array itself: when every project came back as its live reference (a no-op rehydrate),
  // reuse the live array so the whole merge is a true no-op for `useProjectStore(s => s.projects)`,
  // which is what Workspace subscribes to — otherwise a fresh array re-renders it on every rehydrate.
  if (
    merged.projects.length === currentProjects.length &&
    merged.projects.every((p, i) => p === currentProjects[i])
  ) {
    merged.projects = currentProjects;
  }

  // Keep the window on a live selection the incoming snapshot simply hadn't SEEN yet: a stale writer
  // must not yank the user off the project they just created (it carries its own older selection).
  // Deliberately narrow — when both sides know the project, the snapshot's selection still wins, as
  // before. Mirrors the per-agent selectedAgentId rule inside mergeProject.
  if (onDropped && dropped && dropped.length) onDropped(dropped);
  const liveSel = currentState.selectedProjectId;
  if (
    liveSel != null &&
    !incomingById.has(liveSel) &&
    merged.projects.some((p) => p.id === liveSel)
  ) {
    merged.selectedProjectId = liveSel;
  }
  return merged;
}

/** How long a removal is retained no matter how many others pile up. Under the union merge a
 *  tombstone is the ONLY thing suppressing a stale in-memory copy, so evicting a RECENT one lets a
 *  just-closed agent reappear in a window that never converged past it. Age is the honest criterion:
 *  a removal older than this has been seen by every window that is still running. */
const TOMBSTONE_RETAIN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Cap the tombstone map so a very long session can't grow it without bound — but only ever evict
 *  entries past TOMBSTONE_RETAIN_MS, oldest first. The count cap is a backstop against unbounded
 *  growth, NOT a correctness mechanism; when every entry is recent we keep them all rather than
 *  resurrect a closed agent (the map is ~50 bytes/entry, so this stays cheap). */
function boundTombstones(map: Record<string, number>): Record<string, number> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TOMBSTONES) return map;
  const cutoff = Date.now() - TOMBSTONE_RETAIN_MS;
  const recent = keys.filter((k) => (map[k] ?? 0) >= cutoff);
  if (recent.length === keys.length) return map; // nothing is safely evictable yet
  const evictable = keys
    .filter((k) => (map[k] ?? 0) < cutoff)
    .sort((a, b) => (map[b] ?? 0) - (map[a] ?? 0)); // newest of the stale first
  const room = Math.max(0, MAX_TOMBSTONES - recent.length);
  const out: Record<string, number> = {};
  for (const k of recent) out[k] = map[k] as number;
  for (const k of evictable.slice(0, room)) out[k] = map[k] as number;
  return out;
}

/** Union two tombstone maps, keeping the LATER removedAt on any overlap. */
function mergeTombstones(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = { ...(a ?? {}) };
  for (const [id, at] of Object.entries(b ?? {})) {
    const prev = out[id];
    if (prev === undefined || at > prev) out[id] = at;
  }
  return out;
}

/** Drop tombstoned agents from a project, returning the SAME object when nothing changed.
 *
 *  THIS IS A ROW-DESTRUCTION PATH — the third, alongside `removeAgent` and `removeProject`. It is
 *  reached when an agent closed in ANOTHER WINDOW arrives as a tombstone, since `isRemoved` is the
 *  union of this window's and the persisted snapshot's `removedIds`. It therefore owes the same
 *  per-agent teardown as an explicit close (roborev 55876).
 *
 *  It REPORTS the dropped ids rather than tearing them down itself, so this stays a pure function of
 *  its inputs. An earlier cut called `clearBrief` inline, which quietly made the whole merge
 *  effectful while `mergePreservingLiveWorkers` was still documented as pure — so a future caller
 *  invoking the merge to PREVIEW or diff a rehydrate would have irreversibly destroyed live briefs
 *  (roborev 55888). The one production caller performs the teardown; every test caller gets the pure
 *  behaviour by not asking for it. */
function withoutRemovedAgents(
  p: Project,
  isRemoved: (id: string) => boolean,
  dropped?: string[],
): Project {
  const agents = p.agents.filter((a) => !isRemoved(a.id));
  if (agents.length === p.agents.length) return p;
  if (dropped) {
    const kept = new Set(agents.map((a) => a.id));
    for (const a of p.agents) if (!kept.has(a.id)) dropped.push(a.id);
  }
  return { ...p, agents };
}

/** True for an object with no richer prototype than plain `{}` (or a null prototype). Anything else —
 *  Date, Map, Set, a class instance — is NOT value-comparable by an own-key walk, so `sameValue`
 *  fails closed on it (see below). */
function isPlainObject(o: object): boolean {
  const proto = Object.getPrototypeOf(o);
  return proto === Object.prototype || proto === null;
}

/** Deep VALUE equality for the JSON-ish shapes the projects blob carries (agents, projects, their
 *  nested arrays/records). Used only to decide whether a rehydrated value is INDISTINGUISHABLE from
 *  the live one, so we can keep the live object reference — see the canonicalization in `mergeProject`.
 *  Exported for direct unit testing.
 *
 *  Two rules the persisted blob forces:
 *   • Walk the UNION of both key sets, so an own key holding `undefined` (addAgent/setAgentModel store
 *     `model: undefined`; the name reconcile spreads `selfNamed`) compares EQUAL to the absent key
 *     `JSON.stringify` leaves behind. Comparing key COUNTS would report the most ordinary agent there
 *     is as "changed" forever, and one non-reused agent cascades to its project and then the whole
 *     `projects` array — silently returning it to the pre-fix behaviour.
 *   • Fail CLOSED on any non-plain object (Date/Map/Set/class): an own-key walk sees them as key-less
 *     and would call two DIFFERENT instances equal, which would canonicalize across a real change and
 *     render stale — the one failure mode this must never have. Latent today (the blob is JSON-only),
 *     but it now errs toward "no reuse" rather than "reuse". */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const av = a as unknown[];
    const bv = b as unknown[];
    return av.length === bv.length && av.every((v, i) => sameValue(v, bv[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!sameValue(ao[k], bo[k])) return false;
  }
  return true;
}

/** The project fields the merge resolves against the LIVE copy (compared directly, field-by-field, at
 *  the `mergeProject` return). Everything else is snapshot-owned metadata compared by value. */
const PROJECT_LIVE_RESOLVED_KEYS = new Set(["agents", "selectedAgentId", "freshBuildAgentId"]);

/** Deep-equal for a project's snapshot-owned metadata (name, rootPath, defaultBranch, …) — everything
 *  EXCEPT the live-resolved fields. Walks the UNION of both key sets, so an absent key and an explicit
 *  `undefined` compare equal — the merge normalizes `freshBuildAgentId` to null while a live project
 *  may omit the key, semantically identical but enough to defeat a strict whole-object compare, which
 *  is why those fields are excluded here and compared separately. */
function sameProjectMeta(a: Project, b: Project): boolean {
  const av = a as unknown as Record<string, unknown>;
  const bv = b as unknown as Record<string, unknown>;
  const keys = [...Object.keys(av), ...Object.keys(bv)].filter((k) => !PROJECT_LIVE_RESOLVED_KEYS.has(k));
  return keys.every((k) => sameValue(av[k], bv[k]));
}

/** Merge one project that exists in BOTH the incoming snapshot and memory: union its agents by id,
 *  drop tombstoned ones, and preserve the live per-window state (authoritative names, selection,
 *  fresh-agent boost) that a stale snapshot would otherwise revert. */
function mergeProject(
  ppIn: Project,
  curIn: Project | undefined,
  isRemoved: (id: string) => boolean,
  dropped?: string[],
): Project {
  // Removal tombstone (sparkle-close-resurrect): an agent closed in ANY window but still carried by
  // a concurrent writer's stale snapshot must NOT be re-added ("× closes the terminal but the row
  // comes back"). Filter tombstoned ids out of the incoming snapshot before anything else.
  const pp = withoutRemovedAgents(ppIn, isRemoved, dropped);
  const cur = curIn;
  {
    if (!cur) return pp;
    const present = new Set(pp.agents.map((a) => a.id));
    // Authoritative-identity preservation: a manual rename (renameAgent) sets namePinned=true, and a
    // self-name (the sparkle-control rename_agent op → selfNameAgent) sets selfNamed=true — both make
    // the chosen name authoritative in memory, but the projects blob is persisted on a trailing
    // debounce (see the 400ms write below). A rehydrate that fires before the write flushes carries the
    // SAME agent still un-renamed with its old auto-name; taking it verbatim reverted the name AND
    // cleared the authoritative flag, which re-opened the agent to auto-naming so the auto-title
    // silently won ("rename_agent returns ok but the row keeps its old name"). For an agent present in
    // BOTH, when the LIVE copy is authoritatively named and the incoming snapshot is NOT, keep the live
    // name + flags + autoNameVariants. A snapshot that is itself authoritatively named is a deliberate
    // (already-flushed or cross-window) rename and wins, so we only shield the revert case — symmetric
    // to how the live selectedAgentId is preserved below.
    // Precedence, strict: human pin (namePinned) > self-name (selfNamed) > auto-name. We shield the
    // live copy only when the incoming snapshot is a STRICTLY-lower-precedence revert — never when the
    // snapshot is an equal-or-higher deliberate/flushed rename (which wins, as before):
    //   • a live human pin beats any snapshot that is not ITSELF a human pin (incl. a self-named one —
    //     a self-name must never revert the human's deliberate pin);
    //   • a live self-name beats only an auto-named snapshot (a namePinned OR selfNamed snapshot is a
    //     flushed/cross-window rename and wins).
    const curById = new Map(cur.agents.map((a) => [a.id, a] as const));
    let pinnedIdentityReconciled = false;
    const reconciledAgents = pp.agents.map((a) => {
      const live = curById.get(a.id);
      const preserveLive =
        !!live &&
        ((live.namePinned && !a.namePinned) ||
          (live.selfNamed && !a.namePinned && !a.selfNamed));
      if (preserveLive) {
        pinnedIdentityReconciled = true;
        return {
          ...a,
          name: live.name,
          namePinned: live.namePinned,
          selfNamed: live.selfNamed,
          autoNameVariants: live.autoNameVariants,
        };
      }
      return a;
    });
    const baseAgents = pinnedIdentityReconciled ? reconciledAgents : pp.agents;
    // AGENT UNION (sparkle-pckz): keep every live agent the snapshot doesn't carry. Absence from a
    // snapshot only ever means "that writer hadn't seen it yet" — deletion travels as a tombstone
    // (isRemoved), which was already applied to both sides. This subsumes the two narrow shields
    // that came before it (a worker with a cut worktree + a still-pending local add): both were
    // attempts to guess which absences were real deletions, and both left the gap that silently
    // evicted acknowledged build agents. The old pending-add shields are strictly subsumed: a
    // just-created agent is just one more absence the union already keeps.
    const survivors = cur.agents.filter((a) => !present.has(a.id) && !isRemoved(a.id));
    // THIS is where a live in-memory row is actually destroyed by a cross-window tombstone: it is
    // absent from the incoming snapshot AND tombstoned, so the union deliberately does not re-add it.
    // Record those ids for the caller's per-agent teardown (an undelivered brief). Note the drop does
    // NOT happen in `withoutRemovedAgents` for this shape — the snapshot never carried the row at all
    // — which is exactly why the first cut of this accumulation reported nothing.
    if (dropped) {
      for (const a of cur.agents) if (!present.has(a.id) && isRemoved(a.id)) dropped.push(a.id);
    }
    // SURVIVORS GO ON TOP, on the same side `addAgent` inserts. A live-only row is almost always a
    // JUST-CREATED one — the projects blob is written on a trailing debounce, so every other
    // window's snapshot predates it — and `crossWindowSync` rehydrates on every event another
    // window emits. Appending them put the brand-new agent at the top of its rung and then dropped
    // it to the bottom a moment later, which is the placement this store just set out to fix, and a
    // symptom that did not exist under append (the merge's side agreed with `addAgent`'s, so the row
    // never moved). Ordering by `createdAt` would be the more principled union, but the stamp is
    // OPTIONAL — see its note in `addAgent` — so it cannot carry the invariant on its own.
    const mergedAgents = survivors.length > 0 ? [...survivors, ...baseAgents] : baseAgents;
    // Nav-bug fix (Unit A): `selectedAgentId` is LIVE per-window navigation state, not something a
    // concurrent writer's snapshot should reset. A cross-window rehydrate that predates a just-added
    // agent carries a stale `pp.selectedAgentId` (the previously-selected row); taking it verbatim
    // reverts the user's selection right after they clicked "New Build Agent" — whose row survives
    // via the union above but is unknown to `pp`, so `pp` still selects the
    // OLD row. Keep the live `cur.selectedAgentId` whenever it still resolves in the merged agent
    // set; fall back to `pp`'s only when the live selection is a DANGLING non-null id (the selected
    // agent was removed). A live `null` is an intentional deselect (`selectAgent(id, null)` — see the
    // "not deselects" note in that action), NOT "no opinion", so it too is authoritative and must not
    // be overwritten by a snapshot's stale selection. Mirrors ensureAgentPresent / adoptWorker, which
    // likewise refuse to yank the user's active tab on a background reconcile.
    const liveSelectionValid =
      cur.selectedAgentId == null || mergedAgents.some((a) => a.id === cur.selectedAgentId);
    const selectedAgentId = liveSelectionValid ? cur.selectedAgentId : pp.selectedAgentId;
    // Same as selectedAgentId: freshBuildAgentId is LIVE per-window UI state. A stale snapshot that
    // predates the just-opened build agent would otherwise revert the fresh-slot boost the instant
    // it lands — the ordering analog of the nav-bug above. Keep the live value whenever it still
    // resolves in the merged set (a live null is an intentional "no fresh agent", also authoritative);
    // fall back to the snapshot's only when the live id is dangling (its agent was removed elsewhere).
    const liveFreshValid =
      cur.freshBuildAgentId == null || mergedAgents.some((a) => a.id === cur.freshBuildAgentId);
    const freshBuildAgentId = liveFreshValid
      ? (cur.freshBuildAgentId ?? null)
      : (pp.freshBuildAgentId ?? null);
    // Reference canonicalization (supersedes #473). A rehydrate hands us structurally-fresh objects
    // for EVERY agent (JSON.parse mints new ones; migratePersisted's normalization rebuilds them
    // again), so taking them verbatim changes `agent` identity for every agent at once. That defeats
    // AgentPane's React.memo — arePanePropsEqual requires `a.agent === b.agent` — and re-renders every
    // open pane, hidden ones included, on every rehydrate (the render-thrash + jank fingerprint: one
    // Workspace render propagating 1:1 to every pane). Reusing the live reference is safe precisely
    // because it is gated on deep VALUE equality: the agent is indistinguishable from the live one, so
    // no render can observe the swap. An agent that genuinely changed still takes the incoming value,
    // so none of the merge semantics above are weakened.
    const canonicalAgents = mergedAgents.map((a) => {
      const live = curById.get(a.id);
      return live && sameValue(a, live) ? live : a;
    });
    // When every agent AND every live-resolved scalar survived unchanged, hand back the LIVE project
    // object so `projects` consumers (Workspace) don't churn either. Compared against `cur` (LIVE),
    // NOT `pp` (the incoming/fresh snapshot) — returning `pp` on a no-op would still hand out fresh
    // identities, which is exactly the bug. The three live-resolved fields are compared directly
    // rather than via a whole-object compare, because this merge normalizes `freshBuildAgentId` to
    // null while a live project may omit the key — semantically identical, but enough to defeat a
    // strict key-set comparison.
    const agentsUnchanged =
      canonicalAgents.length === cur.agents.length &&
      canonicalAgents.every((a, i) => a === cur.agents[i]);
    if (
      agentsUnchanged &&
      selectedAgentId === cur.selectedAgentId &&
      freshBuildAgentId === (cur.freshBuildAgentId ?? null) &&
      sameProjectMeta(pp, cur)
    )
      return cur;
    return { ...pp, agents: canonicalAgents, selectedAgentId, freshBuildAgentId };
  }
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      projects: [],
      selectedProjectId: null,

      addProject: (name, rootPath) => {
        const id = uuid();
        const now = new Date().toISOString();
        const project: Project = {
          id,
          name,
          rootPath,
          defaultBranch: null,
          createdAt: now,
          lastOpenedAt: now,
          agents: [],
          selectedAgentId: null,
          freshBuildAgentId: null,
        };
        set((s) => ({ projects: [...s.projects, project], selectedProjectId: id }));
        return id;
      },

      removeProject: (id) => {
        set((s) => {
          const gone = s.projects.find((p) => p.id === id);
          const projects = s.projects.filter((p) => p.id !== id);
          const selectedProjectId =
            s.selectedProjectId === id ? (projects[0]?.id ?? null) : s.selectedProjectId;
          // Tombstone the project AND its agents: under the union merge, absence no longer deletes,
          // so a removal that isn't recorded would be undone by any window still holding the project.
          const doomed = [id, ...(gone?.agents ?? []).map((a) => a.id)];
          registerLocalRemovals(doomed);
          // Destroying a project destroys its agents WITHOUT going through `removeAgent`, so the
          // per-agent teardown there has to be repeated here. An undelivered brief is one of those:
          // without this, closing a project while `spawnBuildAgent` is inside its wait leaves the
          // waiter unsettled, so the op sits out the whole bound and answers "unconfirmed — check
          // that it picked up the task", pointing the human at an agent AND a project that no longer
          // exist, while the held entry outlives the row for the life of the process.
          (gone?.agents ?? []).forEach((a) => clearBrief(a.id, "project closed"));
          return { projects, selectedProjectId, removedIds: withTombstones(s.removedIds, doomed) };
        });
        // Drop the concierge pin if it named THIS project. The pin is persisted and load-bearing
        // (it scopes the concierge's surfaced P0/P1), and no tab renders for a project that's
        // gone — so a dangling pin would silently zero the vitals with no affordance to clear it.
        // One-way edge: uiStore imports nothing from here, so there's no cycle.
        if (useUiStore.getState().pinnedProjectId === id) {
          useUiStore.getState().setPinnedProject(null);
        }
      },

      selectProject: (id) =>
        set((s) => ({
          selectedProjectId: id,
          projects: mapProject(s.projects, id, (p) => ({
            ...p,
            lastOpenedAt: new Date().toISOString(),
          })),
        })),

      setSelectedProject: (id) => set({ selectedProjectId: id }),

      touchProjectOpened: (id) =>
        set((s) => ({
          projects: mapProject(s.projects, id, (p) => ({
            ...p,
            lastOpenedAt: new Date().toISOString(),
          })),
        })),

      relocateProject: (id, newName, newRootPath) =>
        set((s) => ({
          projects: mapProject(s.projects, id, (p) => ({
            ...p,
            name: newName.trim() || p.name,
            rootPath: newRootPath,
            // worktreePath is in app-data, independent of rootPath — leave agents as-is.
          })),
        })),

      setDefaultBranch: (projectId, branch) =>
        set((s) => ({
          // Never persist an empty/whitespace branch — it would propagate to agents as
          // baseBranch "" and break the downstream git status/rebase commands.
          projects: mapProject(s.projects, projectId, (p) => ({
            ...p,
            defaultBranch: branch.trim() || null,
          })),
        })),

      setCloudProjectId: (projectId, cloudProjectId) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => ({ ...p, cloudProjectId })),
        })),

      addAgent: (projectId, opts) => {
        // No such project in THIS window's store → create nothing and say so. `mapProject` silently
        // no-ops on an unknown id, so without this guard the setter would return a plausible id for
        // a tab that was never inserted: createCloudAgent would selectAgent + open() a phantom id
        // (blank pane, no row) and the re-attach loop would count phantom creates. A caller can
        // legitimately race a project removal (multi-window close, a cloud re-attach resolving after
        // the project is gone), so this is a normal state, not an assertion.
        const project = get().projects.find((p) => p.id === projectId);
        if (!project) return null;
        // Cloud agents pass the server session id (spec §Identity); local agents mint a uuid.
        const id = opts?.id ?? uuid();
        // A pre-issued id (a cloud session id) can collide with a tab that already exists in THIS
        // project — e.g. a create racing the startup re-attach that already materialized the tab.
        // Never insert a second row: no-op and return the existing id. Selection is deliberately NOT
        // touched here — a re-add must not yank the user's active tab (the store's background-reconcile
        // invariant; see ensureAgentPresent / adoptWorker / the rehydrate-merge note). Callers that
        // want focus (createCloudAgent) call selectAgent explicitly after this returns.
        //
        // The scan is project-scoped on purpose: a cloud session id is created for, and listed under,
        // exactly ONE project (POST /sessions/start targets the current project; GET /sessions is
        // project-scoped), so the same id is only ever added to its own project in v1 — a
        // cross-project collision can't arise, and a global scan would only add a dangling-selection
        // hazard for a case that doesn't occur. Minted uuids can't collide, so this guards only the
        // caller-supplied-id path.
        const preId = opts?.id;
        if (preId && project.agents.some((a) => a.id === preId)) return preId;
        const kind: AgentKind = opts?.kind ?? "build";
        const parentId = opts?.parentId ?? null;
        // A fresh uuid can never collide with a tombstone, but clear defensively so a re-created id
        // is never suppressed by a stale removal record.
        acknowledgeRemovals([id]);
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => {
            const agent: AgentTab = {
              id,
              name: opts?.name ?? defaultAgentName(p, kind),
              kind,
              parentId,
              runtime: opts?.runtime ?? "local",
              worktreePath: null,
              branch: null,
              baseBranch: p.defaultBranch,
              lastPrompt: "",
              promptHistory: [],
              task: opts?.task,
              parentBranch: opts?.parentBranch,
              beadId: opts?.beadId,
              // Pin only an explicit caller-supplied name (opts.name — e.g. an import): that's a
              // deliberate choice auto-naming must not overwrite. Agents created without opts.name —
              // including the kind-based "Build 1"/"Worker 2"/"Think" defaults — stay unpinned
              // so the first prompt can auto-rename them.
              namePinned: opts?.name != null,
              autoNameBasis: null,
              autoNameVariants: null,
              shellCommand: opts?.shellCommand ?? null,
              // Normalize "inherit the default" to undefined at the store boundary, so persisted
              // records have ONE canonical form and consumers can compare raw values safely (the
              // "default" sentinel stays a UI-only dropdown value).
              model: isDefaultModel(opts?.model) ? undefined : opts?.model,
              // Spawn-time plan-mode request. Only "plan" is ever stored — ordinary mode is the
              // absence of the field, so a spawn that didn't ask for it never overrides the user's
              // own Claude Code permission default. Read on fresh launch only (see AgentTab).
              permissionMode: opts?.permissionMode,
              // The spawn stamp, now with THREE consumers — it was declared in types.ts since
              // sparkle-pckz and written by nobody, so every one of them read `undefined` and quietly
              // did nothing. (a) the unstarted-worker dwell (engine/workerAttention, sparkle-w340):
              // a just-cut worker is not a "Start this agent" strand until it has sat un-launched
              // past the dwell; (b) engine/newAgentAttention's 5-minute backstop, which needs to tell
              // a freshly spawned agent from an old one; (c) the eviction shield types.ts documents.
              // Kept OPTIONAL on the type: rows persisted by an older build genuinely have no stamp,
              // and every consumer must treat "no stamp" as "age unknown" rather than "age zero".
              createdAt: opts?.createdAt ?? Date.now(),
            };
            // ⚠️ `freshBuildAgentId` NO LONGER AFFECTS ROW POSITION. It used to mark the row that
            // `FRESH_BUILD_RANK` floated to the top of the attention sort, and that whole sort was
            // deleted on 2026-07-26 (see engine/agentOrdering's history note) — the field is still
            // written and cross-window merged, but nothing reads it to place a row. "Newest at the
            // top" is now a property of the ARRAY (see the prepend below), not of this flag. Left in
            // place because it is persisted state other windows reconcile against; do not reach for
            // it to order anything.
            const freshBuildAgentId = kind === "build" ? id : p.freshBuildAgentId;
            // opts.select === false leaves the selection EXACTLY as it was — including a null (or
            // absent) one, which is a deliberate deselect and not a hole for a machine-created agent
            // to fill. No condition, so the flag can't invert itself under state the caller can't
            // see. See AddAgentOpts.select.
            const selectedAgentId = opts?.select === false ? p.selectedAgentId : id;
            // NEWEST FIRST. The ladder reads top→bottom as least-done→most-done: that is what the
            // SECTIONS already say (uncommitted → committed → PR → merged → shipped), and this
            // applies the same rule one level down, WITHIN a section. A brand-new agent is the
            // least-done thing there is, so it belongs at the top — appending buried it at the
            // bottom of "Local: Uncommitted", underneath every older agent sharing that rung.
            //
            // Done by INSERTING at the front rather than by sorting, and that is the whole design:
            // `project.agents` order IS the rendered order (groupAgentsByStage buckets in input
            // order), so the human's drag arrangement stays the override for free — `reorderAgent`
            // rewrites this array, and nothing re-sorts it afterwards to undo them. A comparator
            // would have had to carry a "has been manually moved" flag per row to avoid fighting
            // the drag; position-as-state needs no such flag.
            return { ...p, agents: [agent, ...p.agents], selectedAgentId, freshBuildAgentId };
          }),
        }));
        // Anonymous funnel telemetry — every agent/worker tab creation flows through here.
        // Fire-and-forget; the service swallows all errors and never blocks this setter.
        void usageTelemetry.trackAgentSpawned(kind);
        return id;
      },

      setAgentBeadId: (projectId, agentId, beadId) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => ({
            ...p,
            agents: p.agents.map((a) => (a.id === agentId ? { ...a, beadId } : a)),
          })),
        })),

      setAgentModel: (projectId, agentId, model) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            // Same normalization as addAgent: undefined is the single persisted "default" form.
            mapAgent(p, agentId, (a) => ({
              ...a,
              model: isDefaultModel(model) ? undefined : model,
            })),
          ),
        })),

      setAgentActivity: (projectId, agentId, activity) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            // Trim so a whitespace-only report clears the line; store the string verbatim otherwise.
            // Unlike renameAgent this NEVER pins the name or touches auto-naming — activity is a
            // separate, always-live secondary field.
            mapAgent(p, agentId, (a) => ({ ...a, activity: activity.trim() })),
          ),
        })),

      // ── Goals ────────────────────────────────────────────────────────────────────────────────
      // All five delegate the actual rules to engine/agentGoal rather than editing the record
      // inline. That module is where the invariants live (met-before-expired, latched escalation,
      // idempotent marking), it is pure, and it is what the continuation engine and the stall
      // surface read — a second copy of the arithmetic here is exactly how those three fall out of
      // step about whether a goal is still outstanding.

      setAgentGoal: (projectId, agentId, text, ttlMs, actor = "human", verify) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => {
              const trimmed = text.trim();
              // Empty CLEARS — and clearing is the documented opt-out from auto-continue, so it
              // has to drop the whole record (counters included) rather than blank the text and
              // leave a goal that reads as unmet forever.
              //
              // BUT WHEN THE AGENT CLEARS, THE DEBT SURVIVES THE RECORD (roborev 55451). Dropping the
              // goal drops the only place `totalContinues` and `escalatedAt` are stored, so
              // clear-then-set was a two-call budget reset that also cancelled a human's escalation —
              // the same hole the paraphrase guard below closes, one extra call away and taught
              // verbatim by the agent-facing skill doc. `goalDebt` is that record outliving the goal;
              // a HUMAN clear is a genuine release and drops it too.
              if (trimmed === "") {
                const { goal: _dropped, goalDebt: _priorDebt, ...rest } = a;
                if (actor !== "agent") return rest;
                const owed = goalDebtOf(a.goal) ?? a.goalDebt;
                // An explicit `verify: null` drops the check from the stash too, or the take-back
                // would only reach a live goal and a cleared one would still owe it forever.
                const debt = verify === null && owed ? stripVerify(owed) : owed;
                return debt === undefined ? rest : { ...rest, goalDebt: debt };
              }
              // A goal whose TEXT is unchanged keeps its COUNTERS but RE-ARMS its lifecycle.
              //
              // Both halves matter. Keeping the counters stops a restarted agent — which
              // re-asserts its objective routinely — from silently refilling the retry budget and
              // defeating the bound. But keeping the lifecycle STAMPS made the call a silent no-op
              // in two common cases (roborev 55254): an agent that met "keep the build green" and
              // re-asserts it for the next round kept `metAt`, so the goal stayed `met` forever and
              // the row read "done"; and an expired goal could never be revived by re-typing it,
              // because `setAt` never moved, so expiry recurred immediately — and a fresh `ttlMs`
              // measured from the OLD `setAt` could even land in the past. The caller got no signal
              // that the set did nothing.
              //
              // An ESCALATION is deliberately NOT cleared here. Re-asserting the same text is
              // something the agent does on its own; taking back a goal a human has been handed is
              // the human's call, via `resetAgentGoalRetries`.
              if (a.goal && a.goal.text === trimmed) {
                // `verify` comes OFF here and is re-added below, or a take-back could never land:
                // spreading `rest` would put the old check straight back on top of the drop.
                const { metAt: _met, verify: _priorVerify, ...rest } = a.goal;
                // An explicitly supplied `verify` APPLIES here. Discarding it replied `{ ok: true }`
                // while the goal stayed unverified and self-markable — the exact failure handleSetGoal
                // refuses malformed input to avoid, relocated one layer down where that check cannot
                // see it. It also meant a check could never be ADDED to a standing goal without
                // rewording it (roborev 55893). Passing none keeps whatever the goal already had.
                // `null` DROPS it (the concierge's take-back); `undefined` keeps what was there.
                const kept = verify === null ? undefined : (verify ?? _priorVerify);
                return {
                  ...a,
                  goal: {
                    ...rest,
                    setAt: Date.now(),
                    ttlMs: ttlMs ?? a.goal.ttlMs,
                    ...(kept !== undefined ? { verify: kept } : {}),
                  },
                };
              }
              // GENUINELY NEW TEXT — new work, so a fresh budget… IF a human asked for it.
              //
              // WHEN THE AGENT ASKS, THE NEW GOAL INHERITS THE OLD ONE'S DEBTS. `set_agent_goal` is
              // agent-reachable and free-tier, so without this the substrate's two load-bearing
              // invariants were one paraphrase away from vacuous (roborev 55339):
              // `MAX_CONTINUES_TOTAL` is documented as a bound "nothing the agent itself does" can
              // reset, and an escalation is documented as the human's to take back. An agent
              // auto-continued to the ceiling gets `continuePrompt` — which replays its goal text —
              // restates it in slightly different words, and lands here with a zeroed budget and no
              // escalation, back in the auto-continue pool. Repeatable forever, and it silently
              // cancels an escalation a human already owns.
              //
              // So the agent-facing path carries `totalContinues` and the escalation forward across
              // a text change, exactly as `clearGoalMet` is deliberately weaker than
              // `resetGoalRetries`. The consecutive streak DOES reset: the work genuinely changed,
              // and that counter is the "is restarting getting anywhere" signal, not the ceiling.
              //
              // The debt is read from `a.goal ?? a.goalDebt`, so it does not matter whether the agent
              // overwrote its goal or cleared it first — both routes arrive here owing the same thing
              // (roborev 55451). A HUMAN setting new goal text is a fresh budget by design, and that
              // is also the moment the stashed debt is released.
              const fresh = newGoal(trimmed, Date.now(), ttlMs, verify ?? undefined);
              if (actor === "agent") {
                // `goalDebtOf` now includes the old goal's `verify`, and `chargeGoalDebt` inherits it
                // when `fresh` states none — so an agent cannot shed its check by rewording, and
                // cannot shed it by clear-then-set either (the cleared goal's debt survives in
                // `a.goalDebt`). Supplying a NEW verify still wins; only silent removal is blocked.
                // What IS inherited is the obligation, not the old proof — `chargeGoalDebt`
                // downgrades it to `human`, since this branch runs on genuinely new text.
                const owed = goalDebtOf(a.goal) ?? a.goalDebt;
                const debt = verify === null && owed ? stripVerify(owed) : owed;
                const { goalDebt: _spent, ...restOfAgent } = a;
                const charged = chargeGoalDebt(fresh, debt);
                return { ...restOfAgent, goal: charged };
              }
              const { goalDebt: _released, ...human } = a;
              return { ...human, goal: fresh };
            }),
          ),
        })),

      setAgentGoalMet: (projectId, agentId, met) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => {
              if (!a.goal) return a;
              if (met) return { ...a, goal: markGoalMet(a.goal, Date.now()) };
              // Un-marking is a correction ("it isn't actually done"). It clears the CONSECUTIVE
              // streak only — `clearGoalMet`, not `resetGoalRetries`.
              //
              // This surface is how an AGENT declares itself done, so the actor holding the lever
              // is exactly the one `MAX_CONTINUES_TOTAL` defends the fleet against (roborev 55254).
              // Running the full reset here let an agent mark itself met and immediately un-mark
              // itself to refill its entire twenty-restart budget — repeatable every twenty
              // restarts, forever — and un-latched `escalatedAt`, quietly taking back a goal a
              // human had already been handed and returning it to the auto-continue pool.
              // `clearGoalMet` is a no-op on a goal that was never met, so it cannot be used as a
              // budget reset either.
              return { ...a, goal: clearGoalMet(a.goal) };
            }),
          ),
        })),

      noteAgentGoalContinue: (projectId, agentId, mark) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => (a.goal ? { ...a, goal: noteContinue(a.goal, mark) } : a)),
          ),
        })),

      escalateAgentGoal: (projectId, agentId, reason) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) =>
              a.goal ? { ...a, goal: escalateGoal(a.goal, Date.now(), reason) } : a,
            ),
          ),
        })),

      resetAgentGoalRetries: (projectId, agentId) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, releaseGoalDebt),
          ),
        })),

      setAgentEpicId: (projectId, agentId, epicId) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => ({
            ...p,
            agents: p.agents.map((a) => (a.id === agentId ? { ...a, epicId } : a)),
          })),
        })),

      removeAgent: (projectId, agentId) => {
        // Close waterfall: from this removal to the pane's unmount cleanup (ended in AgentPane's
        // unmount, keyed "close:<id>") — captures the cost the user feels when closing an agent.
        perfStart(`close:${agentId}`, "close");
        set((s) => {
          // Closing a build agent also closes its workers (they belong to it). Their worktrees are
          // cleaned up separately by the caller for each removed id.
          const doomed = (s.projects.find((p) => p.id === projectId)?.agents ?? [])
            .filter((a) => a.id === agentId || a.parentId === agentId)
            .map((a) => a.id);
          // ...and it must be TOMBSTONED, so a concurrent writer's stale snapshot (or the disk
          // reconcile) that still carries it can't re-add the row before this removal propagates
          // (sparkle-close-resurrect — "× closes the terminal but the row comes back").
          registerLocalRemovals(doomed);
          // Account pins outlive the session (persisted for sparkle-gms0), so a closed agent's pin
          // would otherwise linger forever — and could keep naming a since-removed account. Uses
          // the same `doomed` list, so a closed build agent's workers are cleared with it.
          doomed.forEach((id) => clearPin(id));
          // An UNLAUNCHED opening brief dies with its agent, and it has to be told so. Nothing else
          // settles it: the pane's unmount is not a close (a tab switch unmounts too, and that brief
          // is still deliverable), so without this the concierge's `awaitBriefDelivery` sits out its
          // whole bound and reports "unconfirmed" for an agent that is simply gone — and the held
          // entry outlives the row, so `hasUndeliveredBrief` keeps answering true for a dead id.
          // Uses the same `doomed` list, so a closed build agent's workers are covered too.
          doomed.forEach((id) => clearBrief(id, "agent closed"));
          return {
          // The tombstone is also PERSISTED (sparkle-pckz): the union merge never infers deletion
          // from absence, so this is the only thing that carries the close to other windows.
          removedIds: withTombstones(s.removedIds, doomed),
          projects: mapProject(s.projects, projectId, (p) => {
            const agents = p.agents.filter(
              (a) => a.id !== agentId && a.parentId !== agentId,
            );
            const selectedAgentId =
              agents.some((a) => a.id === p.selectedAgentId)
                ? p.selectedAgentId
                : (agents[0]?.id ?? null);
            // Drop the fresh-agent boost if the fresh agent was the one closed (or was a worker
            // of a closed build agent) — a removed id must not keep phantom-boosting the sort.
            const freshBuildAgentId = agents.some((a) => a.id === p.freshBuildAgentId)
              ? p.freshBuildAgentId
              : null;
            return { ...p, agents, selectedAgentId, freshBuildAgentId };
          }),
          };
        });
      },

      renameAgent: (projectId, agentId, name) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            // A manual rename freezes the name: from here on it won't auto-change. Clear the
            // auto-name variants too — frozen means "`name` only" (see types.ts), and the
            // sidebar prefers variants over `name`, so leaving them would keep showing the
            // stale auto-name instead of the user's chosen one.
            mapAgent(p, agentId, (a) => ({
              ...a,
              name: name.trim() || a.name,
              namePinned: true,
              autoNameVariants: null,
            })),
          ),
        })),

      selfNameAgent: (projectId, agentId, name) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) =>
              // A human pin (namePinned) is the user's deliberate choice and always wins — a self-name
              // over it is a no-op. Otherwise adopt the agent's chosen name: mark it authoritative via
              // `selfNamed` (freezes the auto-namer, skips paid Haiku, survives rehydrate) but do NOT
              // set namePinned/pinnedIndex, so the row shows no pin chip and stays reorderable. Clear
              // autoNameVariants so the chosen label shows verbatim (the sidebar prefers variants over
              // `name`, so a stale variant would otherwise keep winning) — mirrors renameAgent.
              a.namePinned || !name.trim()
                ? a
                : { ...a, name: name.trim(), selfNamed: true, autoNameVariants: null },
            ),
          ),
        })),

      autoRenameAgent: (projectId, agentId, name, basis, autoName, seenAiTitle) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) =>
              // Respect a pinned name (manual) and a self-chosen name (sparkle-control rename_agent).
              //
              // The aiTitle rule is narrower than "a title always wins". It exists to close ONE race:
              // a Haiku call that started before any title existed, resolving AFTER the title poll
              // applied one — there the stale guess must not clobber the fresh title. But an agent
              // whose work has moved on from a first-turn title has legitimately earned a re-name
              // (agentNaming rung 1), and a blanket guard silently swallowed it.
              //
              // Both cases are told apart by whether the title CHANGED under the caller: compare the
              // title the decision was made against with the one on the agent now. Equal (including
              // both absent) → the caller knew the current state, apply. Different → a title landed
              // or changed mid-flight, so this name is stale, bail. Callers that pass nothing keep
              // the old strict behavior: any existing title blocks them.
              a.namePinned || a.selfNamed || !name.trim() || (a.aiTitle ?? null) !== (seenAiTitle ?? null)
                ? a
                : {
                    ...a,
                    // Model-authored (the Haiku namer), so decode entities on the way in — see
                    // engine/decodeEntities for why this is an ingest fix, not a render fix.
                    name: normalizeAgentName(name.trim()),
                    autoNameBasis: basis,
                    // The hover description is model-authored too, and shows the same leak.
                    autoNameVariants: autoName
                      ? {
                          title: normalizeAgentName(autoName.title),
                          description: normalizeAgentName(autoName.description),
                        }
                      : null,
                  },
            ),
          ),
        })),

      applyAiTitle: (projectId, agentId, title) =>
        set((s) => {
          // Claude Code's session title is model-authored, so it carries the same entity leak as a
          // self-name. Decode BEFORE the `aiTitle === t` comparison below, so the stored title and
          // the race-anchor stay the same string and the no-op check keeps working.
          const t = normalizeAgentName(title.trim());
          if (!t) return s; // no title yet — leave the name as-is
          // Bail BEFORE touching state when there's nothing to change — a manual rename owns the
          // name, or this exact title is already applied. Returning `s` keeps the projects/agents
          // array references stable, so whole-`projects` subscribers don't re-render. This is the
          // common case: the 30s poll fires for every agent but titles rarely change once set.
          const agent = s.projects
            .find((p) => p.id === projectId)
            ?.agents.find((a) => a.id === agentId);
          if (!agent || agent.namePinned || agent.selfNamed || agent.aiTitle === t) return s;
          return {
            projects: mapProject(s.projects, projectId, (p) =>
              mapAgent(p, agentId, (a) => ({
                ...a,
                name: t,
                aiTitle: t,
                autoNameVariants: nameFromTitle(t),
              })),
            ),
          };
        }),

      resetAutoName: (projectId, agentId) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) =>
              // A manual rename is the user's choice — never auto-reset it on a fresh start. A
              // self-name, by contrast, is agent-generated identity for the PRIOR occupant, so a
              // reused slot must clear it like any other auto-name. Also bail (return the SAME
              // reference) when there's no auto-name to clear — the common first-launch case — so
              // subscribers don't re-render for a no-op.
              a.namePinned ||
              (!a.selfNamed &&
                a.autoNameBasis === null &&
                a.autoNameVariants === null &&
                a.aiTitle === undefined)
                ? a
                : {
                    ...a,
                    selfNamed: false,
                    // Recompute the kind default against the OTHER agents so a lone "Build" slot
                    // reverts to "Build 1" (not "Build 2" — defaultAgentName counts inclusively).
                    // The number is positional-best-effort and not guaranteed unique with multiple
                    // same-kind agents — intentionally the SAME semantics as creation
                    // (defaultAgentName at addAgent), so we don't special-case dedup here.
                    name: defaultAgentName(
                      { ...p, agents: p.agents.filter((x) => x.id !== agentId) },
                      a.kind,
                    ),
                    autoNameBasis: null,
                    autoNameVariants: null,
                    aiTitle: undefined,
                  },
            ),
          ),
        })),

      reorderAgent: (projectId, agentId, beforeAgentId) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => {
            const from = p.agents.findIndex((a) => a.id === agentId);
            // Unknown agent, or a drop on itself — nothing to do. Returning `p` UNCHANGED (not a
            // fresh object) matters: mapProject hands the identical reference back, so a no-op drag
            // doesn't hand every projects consumer a new array and re-render the column.
            if (from < 0 || agentId === beforeAgentId) return p;
            const moved = p.agents[from] as AgentTab;
            const targetAt = beforeAgentId == null ? -1 : p.agents.findIndex((a) => a.id === beforeAgentId);
            const rest = p.agents.filter((a) => a.id !== agentId);
            // Resolve the anchor AFTER removing the dragged row, so the index is correct whether the
            // row moved up or down (computing it against the original array is the classic
            // off-by-one that lands a downward drag one slot short).
            const to = beforeAgentId == null ? rest.length : rest.findIndex((a) => a.id === beforeAgentId);
            // A missing anchor (target closed mid-drag) appends rather than throwing away the move.
            let at = to < 0 ? rest.length : to;
            // DIRECTION MATTERS. Dropping onto a row means "take that row's slot", so a row dragged
            // DOWNWARD lands AFTER the target, not before it. Inserting before unconditionally made
            // a downward drag onto the ADJACENT row a complete no-op — [a, b], drag a onto b, and
            // `a` is removed then re-inserted at index 0, i.e. exactly where it started. The user
            // drags, nothing moves, and the control reads as broken (roborev 53371).
            if (targetAt >= 0 && from < targetAt) at = Math.min(at + 1, rest.length);
            const agents = [...rest.slice(0, at), moved, ...rest.slice(at)];
            // Deliberately does NOT touch namePinned or autoNameVariants: this is a pure reorder and
            // the NAME is not changing. The old drag-pin froze the name as a side effect, which
            // silently disabled auto-naming for any row the user ever dragged — and clearing the
            // variants would drop the width-fitted label back to the stale `name`, visibly changing
            // it on a drag (roborev 12870).
            return { ...p, agents };
          }),
        })),

      reorderProject: (projectId, beforeProjectId) =>
        set((s) => {
          const from = s.projects.findIndex((p) => p.id === projectId);
          // Unknown project, or a tab dropped on itself. Returning an EMPTY partial leaves the
          // `projects` reference identical, so a no-op drag doesn't hand every consumer a fresh
          // array and re-render the shell (the same reason reorderAgent returns `p` unchanged).
          if (from < 0 || projectId === beforeProjectId) return {};
          const moved = s.projects[from] as Project;
          const rest = s.projects.filter((p) => p.id !== projectId);
          // Resolve the anchor AFTER removing the dragged project, so the index is right whether it
          // moved left or right — computing it against the original array is the classic off-by-one.
          const to =
            beforeProjectId == null ? rest.length : rest.findIndex((p) => p.id === beforeProjectId);
          // A missing anchor (the target tab was closed mid-drag) appends rather than discarding
          // the move.
          const at = to < 0 ? rest.length : to;
          const next = [...rest.slice(0, at), moved, ...rest.slice(at)];
          // NO DIRECTION BUMP HERE — and that is the difference from reorderAgent, so don't "fix"
          // it by copying that function's `from < targetAt → at + 1` line back in.
          //
          // The two have callers with INCOMPATIBLE anchor semantics. reorderAgent's caller
          // (AgentSidebar's onDropAgent) passes the row the pointer was dropped ONTO, so "take that
          // row's slot" needs the bump. The tab strip's caller passes tabDrag.ts's `beforeId`, which
          // is already a MIDPOINT-derived insertion gap — "the tab to insert before", with direction
          // baked in by the Chrome rule that you displace a tab only once you pass its centre.
          // Applying the bump on top double-counts direction: with tabs a,b,c,d, the pointer range
          // that means "hasn't passed b's centre yet, don't move" instead produced [b,a,c,d], so the
          // strip swapped a full half-tab early and every rightward drop landed one slot too far
          // right. Leftward drags were unaffected, which made it read as an asymmetric glitch.
          //
          // Insert-before is now the whole contract; tabDrag.ts owns direction.
          //
          // THE NO-OP TEST IS STRIP-RELATIVE, NOT ARRAY-RELATIVE. `at === from` looks like the
          // obvious guard and is WRONG, because the drag's anchor is an OPEN tab id while this
          // splices the FULL array. With projects [b, hidden, c] and strip [b, c], dropping `b`
          // before `c` — the ordinary "left my own midpoint, haven't reached c's" pointer range —
          // gives at=1, from=0, so an array-relative guard lets it through: the strip is visibly
          // unchanged, yet `projects` becomes [hidden, b, c]. Two things break. The reference
          // changes, so a drag that did nothing re-renders the shell — the exact cost the guard
          // exists to avoid, on the exact case that motivated it. Worse, `hidden` is silently
          // reordered across `b`, and closed-project order is user-visible later: closedProjectsOf
          // feeds the "+" reopen list, so reopening `hidden` puts its tab on the other side of `b`.
          // A drag the user reads as "nothing happened" must not permanently reshuffle projects
          // they cannot see.
          //
          // So: compare the STRIPS. If the visible order is unchanged, change nothing at all.
          // openProjectIds is read here rather than passed in (the useUiStore.getState() idiom this
          // file already uses for pinnedProjectId) so no caller can forget it. A `null` set means
          // "never seeded, everything is open", where the strip IS the full array and this reduces
          // to the array-relative comparison.
          const openIds = useUiStore.getState().openProjectIds;
          const before = openProjectsOf(s.projects, openIds);
          const after = openProjectsOf(next, openIds);
          if (before.every((p, i) => p.id === after[i]?.id)) return {};
          return { projects: next };
        }),

      advanceAlerts: (projectId, statusMap) => {
        // Compute FIRST and bail without set() when nothing changed. Called on every overlaid-status
        // change (potentially per tick), and a bare `set` would hand every projects consumer a new
        // array reference each time even with identical contents — so the no-change fast path here is
        // what keeps this from churning the sidebar. Only a real red-tier transition falls through.
        const project = get().projects.find((p) => p.id === projectId);
        if (!project) return;
        let changed = false;
        const agents = project.agents.map((a) => {
          const next = advanceAlertRecord(a.alert, statusMap[a.id]);
          // advanceAlertRecord returns the SAME ref when the red signature didn't change, and the
          // shared EMPTY_ALERT sentinel for a never-alerted, still-non-red agent — skip both so a
          // non-red agent never gets an empty record persisted onto it.
          if (next === a.alert || next === EMPTY_ALERT) return a;
          changed = true;
          return { ...a, alert: next };
        });
        if (!changed) return;
        set((s) => ({
          projects: s.projects.map((p) => (p.id === projectId ? { ...p, agents } : p)),
        }));
      },

      dismissAlert: (projectId, agentId, status) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            // Record the current episode FIRST (advanceAlertRecord is a no-op when it's already
            // recorded), then dismiss it — so a dismiss that lands before advanceAlerts has seen this
            // red status still seeds seq/lastRed and survives the next advance instead of re-alerting.
            mapAgent(p, agentId, (a) => ({
              ...a,
              alert: dismissedRecord(advanceAlertRecord(a.alert, status)),
            })),
          ),
        })),

      reenableAlert: (projectId, agentId) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => ({ ...a, alert: reenabledRecord(a.alert) })),
          ),
        })),

      selectAgent: (projectId, agentId) => {
        // Re-selecting the agent that's already selected is a semantic no-op — bail before any work.
        // Automated re-selection (attention reveal, cross-window reconcile, send-relay to background
        // agents) calls this constantly with the id already shown; in the field ~18% of selections
        // were redundant. Each one otherwise fired a phantom "switch" waterfall (inflating the metric)
        // AND churned a fresh projects array — re-rendering every pane subscriber and re-running the
        // Terminal become-active reveal (WebGL attach + full 8000-line repaint, ~369ms median). Piled
        // up, those crossed the 1s jank threshold. Overlay dismissal is a separate action, so this
        // never suppresses a real reveal.
        if (get().projects.find((p) => p.id === projectId)?.selectedAgentId === agentId) return;
        // Switch waterfall: from this selection to the target pane actually painting (ended in
        // AgentPane's visibility effect, keyed "switch:<id>"). Only real selections, not deselects.
        if (agentId) perfStart(`switch:${agentId}`, "switch");
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => ({
            ...p,
            selectedAgentId: agentId,
          })),
        }));
      },

      setAgentWorktree: (projectId, agentId, path, branch) => {
        // REGISTER THE WORKTREE FOR TRANSCRIPT READS, at the one place that learns it.
        //
        // This is writer (2) of the transcript registry (services/conciergeTools/terminal), and it
        // inherits that writer's stated safety property verbatim: the worktree is one the APP itself
        // created — `worktree_path()` mints `<app_data>/worktrees/<project_id>/<agent_id>` from
        // validated ids — so there is no id-to-path guessing and nothing a model said.
        //
        // Registered for EVERY build agent, where before only the app-owned Improve Sparkle agent did
        // it. That also repairs `readAgentTerminal`'s transcript fallback, which until now could only
        // serve agents that had fired a Stop event in THIS app session (the exact-path registry is
        // in-memory and is never repopulated across a relaunch).
        noteAgentTranscriptWorktree(agentId, path);
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => ({ ...a, worktreePath: path, branch })),
          ),
        }));
      },

      adoptWorker: (projectId, worker) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => {
            // Idempotent: an existing record wins — never clobber live in-memory state (e.g. a
            // name the user already saw) with the disk snapshot.
            if (p.agents.some((a) => a.id === worker.id)) return p;
            // Never re-adopt a worker the user just closed: its manifest lingers on disk until the
            // worktree teardown finishes, and a reconcile in that window would otherwise resurrect
            // the row the × removed (sparkle-close-resurrect). The tombstone is dropped only when the
            // id is deliberately re-created (addAgent), so a stale reconcile can't defeat it.
            if (pendingLocalRemovals.has(worker.id)) return p;
            const agent: AgentTab = {
              id: worker.id,
              name: defaultAgentName(p, "worker"),
              kind: "worker",
              parentId: worker.parentId,
              runtime: "local",
              worktreePath: worker.worktreePath,
              branch: worker.branch,
              baseBranch: p.defaultBranch,
              lastPrompt: "",
              promptHistory: [],
              task: worker.task,
              parentBranch: worker.parentBranch,
              beadId: worker.beadId,
              namePinned: false,
              autoNameBasis: null,
              autoNameVariants: null,
              shellCommand: null,
              model: undefined,
              // NO `createdAt` HERE, deliberately. This is the disk-reconcile self-heal, not a
              // spawn: the worker's PROCESS is already running, possibly for hours and possibly from
              // before a restart. Minting a fresh stamp would tell engine/newAgentAttention this
              // agent is seconds old and hand a genuinely errored worker a brand-new 5-minute
              // suppression window — and since the manifest's `task` is optional, a task-less
              // re-adopted worker would also read as briefless and have its `blocked` permanently
              // rewritten to `new`. That is exactly the "no red is retroactively calmed across a
              // restart" guarantee the design rests on. Leaving it undefined makes the age UNKNOWN,
              // and unknown is deliberately treated as OLD. (roborev 54696)
            };
            // Same side as `addAgent`, WITHOUT changing selectedAgentId — the self-heal must be
            // invisible to the user, and "invisible" is about the selection, not about where the row
            // lands. This is the second row-creation path, so appending here made "newest first"
            // true of spawned rows and false of re-adopted ones: after a restart a self-healed
            // worker sank below every sibling spawned since, an order that is neither newest-first
            // nor seed order.
            return { ...p, agents: [agent, ...p.agents] };
          }),
        })),

      noteTerminalBrief: (projectId, agentId) => {
        // WRITE-ONCE FOR THE STAMP. This fires per submitted line, and the persisted record must not
        // churn on every Enter — the value is "was this ever briefed by hand", not "when last".
        // Returning the same agent object when there is nothing to do also keeps the store from
        // notifying subscribers, so a hand-driven session does not re-render the fleet per line.
        //
        // BUT THE GOAL-DEBT RELEASE IS *NOT* WRITE-ONCE, and conflating the two was the bug waiting
        // here (roborev 55525): a human typing into the terminal to unstick an ESCALATED agent has
        // almost certainly briefed it before, so an early return on the stamp alone would skip the
        // release on exactly the keystroke that was meant to perform it. So the bail-out asks about
        // both facts. `releaseGoalDebt` returns the same object when nothing is owed, so the common
        // path stays as cheap as it was.
        const a0 = get()
          .projects.find((p) => p.id === projectId)
          ?.agents.find((a) => a.id === agentId);
        const stamped = a0?.terminalBriefedAt !== undefined;
        const owesNothing = a0 !== undefined && releaseGoalDebt(a0) === a0;
        if (stamped && owesNothing) return;
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => {
              const released = releaseGoalDebt(a);
              return a.terminalBriefedAt === undefined
                ? { ...released, terminalBriefedAt: Date.now() }
                : released;
            }),
          ),
        }));
      },
      appendPrompt: (projectId, agentId, text, source = "composer", humanAuthored = true) => {
        const id = uuid();
        // A picker answer is recorded ONLY to advance promptCount for the naming ladder; it must not
        // become the pinned banner's "last prompt" (that surface, like the breadcrumb, is for real
        // user messages). So only a composer send moves `lastPrompt`; a picker send leaves it.
        const isPicker = source === "picker";
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => ({
              // A HUMAN TYPING IS THE RELEASE (roborev 55525), but ONLY a human (roborev 55588).
              // `resetGoalRetries` has always documented "they typed to the agent" as its trigger and
              // simply had no caller, which left an escalated agent permanently un-continuable. The
              // flag is what keeps machine-authored prose out: this action is also reached by the
              // concierge's own tool layer, whose text an LLM wrote.
              ...(humanAuthored ? releaseGoalDebt(a) : a),
              lastPrompt: isPicker ? a.lastPrompt : text,
              // Append newest-last, then cap PER SOURCE so the persisted record stays bounded without
              // letting picker volume evict real composer prompts (capPromptHistory). Dropdown reverses.
              promptHistory: capPromptHistory([
                ...(a.promptHistory ?? []),
                { id, text, at: Date.now(), source },
              ]),
            })),
          ),
        }));
        return id;
      },
    }),
    {
      name: PROJECTS_PERSIST_KEY,
      // Debounced localStorage (sparkle-pngb) so a burst of prompt appends / tab switches coalesces
      // into ONE main-thread JSON.stringify + setItem instead of one per mutation.
      storage: createJSONStorage(() => debouncedProjectsStorage),
      // Bumped when the persisted shape gains fields. v1 backfills the main-first-defaults
      // fields so legacy records rehydrate with `null` (matching fresh records) rather than
      // `undefined` — an undefined baseBranch would otherwise send "" to the git commands.
      // v2 backfills the auto-naming fields (namePinned/autoNameBasis). v3 backfills the
      // Think/Build kind + parentId (separate step so records already at v2 still get them).
      // v4 backfills autoNameVariants (width-fitted names) to null. v5 backfills promptHistory
      // (the pinned-header dropdown) as an empty array. v6 backfills shellCommand: null for the
      // Run-as-cmd "shell" agent kind (folded in from PR #62). v7 remaps the legacy
      // "brainstorm" agent kind to "think" (the Think rename). v8 backfills      // (manual reorder anchor) without touching namePinned. v9 heals the sparkle-pel7 residue:
      // build/worker rows frozen (namePinned:true, pinnedIndex null) by the OLD self-name path get
      // unpinned + marked selfNamed so the erroneous pin chip clears while the name is preserved.
      // v10 backfills promptHistory[].source: "composer" (picker-tagging, Task 2.3).
      // v11 backfills removedIds: {} — the shared removal tombstones the union merge needs
      // (sparkle-pckz). An older blob simply has no recorded deletions, which is the safe default:
      // the union keeps everything, and the first close in the new build starts the map.
      // v13 decodes HTML entities out of already-persisted agent names / aiTitle / autoNameVariants
      // ("Pane Mounting &amp; Resize Perf"). THE BUMP IS THE WHOLE FIX: zustand only calls `migrate`
      // when the stored version differs from this number, so leaving it at 12 would have made the
      // heal dead code on every existing install — which is exactly the population that has the
      // escaped names. A test that calls `migratePersisted` directly passes either way, so it
      // proves the function works, not that it ever runs.
      version: 13,
      migrate: (persisted, version) =>
        perfSpan("persist.migrate", () => migratePersisted(persisted, version), { version }) as ProjectState,
      // sparkle-pckz: a UNION merge, so no rehydrate (startup or cross-window) can evict a record
      // just because the writing window hadn't seen it yet. Only an explicit tombstone deletes —
      // `removedIds` from the blob, plus this window's not-yet-persisted local removals.
      merge: (persisted, current) => {
        return perfSpan("persist.merge", () =>
          // THE one caller that performs the merge's per-agent teardown. A row tombstoned in another
          // window is destroyed here, so its undelivered brief must be settled — otherwise a
          // `spawnBuildAgent` waiting on delivery sits out its whole bound and answers "unconfirmed"
          // about an agent that exists in no window (roborev 55876). Passed in rather than done
          // inside the merge so the merge itself stays pure for every other caller (roborev 55888).
          mergePreservingLiveWorkers(persisted, current, pendingLocalRemovals, (ids) => {
            for (const id of ids) clearBrief(id, "agent closed in another window");
          }),
        );
      },
    },
  ),
);
