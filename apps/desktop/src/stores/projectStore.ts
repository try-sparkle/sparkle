// projectStore — the persisted structure (spec §4): projects, their agent tabs, names,
// last prompts. Persisted to localStorage (durable in the Tauri webview) so quit/relaunch
// restores everything. Live process/status state is NOT here (see runtimeStore).
import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import type {
  AgentKind,
  AgentName,
  AgentTab,
  AgentTabStatus,
  Project,
  PromptHistoryEntry,
  PromptSource,
} from "../types";
import {
  advanceAlertRecord,
  dismissedRecord,
  reenabledRecord,
  EMPTY_ALERT,
} from "../engine/alertDismissal";
import { isDefaultModel } from "../services/models";
import { usageTelemetry } from "../services/usageTelemetry";
import { perfSpan, perfStart } from "../perfTrace";

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
}

// Default display name for a freshly created agent, numbered within its kind so you get
// "Build 1", "Worker 2", etc. Think agents are singular per project by convention.
function defaultAgentName(p: Project, kind: AgentKind): string {
  if (kind === "think") return "Think";
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

  addAgent: (projectId: string, opts?: AddAgentOpts) => string;
  /** Attach a bead id to an existing agent (e.g. after async bead creation on build-agent spawn). */
  setAgentBeadId: (projectId: string, agentId: string, beadId: string) => void;
  /** Set the agent's Claude model (a models.ts id, or "default"/undefined to inherit the user's
   *  Claude Code default). Persisted only — delivering the change to a live PTY is the caller's
   *  job (services/agentModel.ts). */
  setAgentModel: (projectId: string, agentId: string, model: string | undefined) => void;
  /** Set the agent's live "what I'm building now" activity narration (sparkle-control MCP
   *  set_agent_activity). Free-text; empty string clears the line. Persisted like the name. */
  setAgentActivity: (projectId: string, agentId: string, activity: string) => void;
  /** Bind the epic an orchestrator is building (set at sendToBuild handoff — drives the sidebar
   *  epic pill immediately, before any of its workers bind to a bead). */
  setAgentEpicId: (projectId: string, agentId: string, epicId: string) => void;
  removeAgent: (projectId: string, agentId: string) => void;
  /** Manual rename: sets the name AND pins it (freezes auto-naming, shows the pin icon). When
   *  the caller passes `pinnedIndex` (the agent's current displayed slot), also anchor the row
   *  there — the unified pin (manual-agent-reorder-pin). */
  renameAgent: (projectId: string, agentId: string, name: string, pinnedIndex?: number) => void;
  /** Self-name: the AGENT names ITSELF via the sparkle-control `rename_agent` op. Sets the name and
   *  marks it authoritative (`selfNamed` — freezes auto-naming, skips paid Haiku, survives rehydrate)
   *  WITHOUT pinning the row: no pin chip, no `pinnedIndex` anchor, so the human can still reorder and
   *  there is nothing to "unpin". A human pin (`namePinned`) still wins — a self-name is a no-op over it. */
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
  /** Drag-pin a top-level agent at `index`: freeze the name AND anchor the row there. */
  pinAgentAt: (projectId: string, agentId: string, index: number) => void;
  /** Release a pin: clear the name freeze AND the row anchor (re-enables auto-naming + sort). */
  unpinAgent: (projectId: string, agentId: string) => void;
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
  appendPrompt: (projectId: string, agentId: string, text: string, source?: PromptSource) => string;
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
    // "Think" rename: the agent kind formerly persisted as "brainstorm" is now "think". Remap the
    // old literal so legacy records route to the Think panel instead of falling through to a build
    // terminal. The old value is matched as a raw string since it's no longer part of AgentKind.
    state.projects = state.projects.map((p) => ({
      ...p,
      agents: (p.agents ?? []).map((a) =>
        (a.kind as string) === "brainstorm" ? { ...a, kind: "think" } : a,
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
          (a as AgentTab).pinnedIndex == null &&
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
  // Version-collision safety net. PR #62 shipped shellCommand as v4 on its own branch while main
  // independently used v4=autoNameVariants and v5=promptHistory. A store persisted under #62's v4
  // would report version===4, so the version-gated `< 4` block above (now autoNameVariants) is
  // skipped and that agent rehydrates with autoNameVariants `undefined` — violating its
  // non-optional type. Normalize all three fields unconditionally (idempotent `??` no-ops on
  // records that already have them) so every agent satisfies its type regardless of which branch's
  // version number it was saved under.
  state.projects = state.projects.map((p) => ({
    ...p,
    agents: (p.agents ?? []).map((a) => ({
      ...a,
      autoNameVariants: a.autoNameVariants ?? null,
      promptHistory: a.promptHistory ?? [],
      shellCommand: (a as AgentTab).shellCommand ?? null,
      // v8 (manual-agent-reorder-pin): the manual reorder anchor. Default null so existing
      // agents keep attention-sorting; do NOT touch namePinned — nothing freezes on upgrade.
      pinnedIndex: (a as AgentTab).pinnedIndex ?? null,
    })),
  }));
  return state;
}

function mapAgent(p: Project, agentId: string, fn: (a: AgentTab) => AgentTab): Project {
  return { ...p, agents: p.agents.map((a) => (a.id === agentId ? fn(a) : a)) };
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

const { storage: debouncedProjectsStorage, flush: flushProjectsPersistImpl } =
  debouncedLocalStorage(PROJECTS_PERSIST_DEBOUNCE_MS);

/** Synchronously flush any pending debounced projects write to localStorage. Called by the
 *  cross-window sync layer BEFORE it broadcasts a structural change (sparkle-pngb), so a receiving
 *  window rehydrates the fresh blob rather than a stale one still sitting in the debounce buffer. */
export function flushProjectsPersist(): void {
  flushProjectsPersistImpl();
}

/** Ids of agents added locally in THIS window but not yet confirmed present in a persisted snapshot.
 *  A concurrent writer's last-writer-wins rehydrate (another window, or a broadcast that predates the
 *  add) can carry a snapshot that lacks a just-clicked agent; while its id lives here the merge
 *  protects it from the whole-array replace. Ids are cleared the instant a snapshot carrying them
 *  arrives (acknowledged = propagated) and on local removal — so this never resurrects a deliberately
 *  removed agent, only shields the brief not-yet-propagated window. Module-scoped: one set per window. */
const pendingLocalAdds = new Set<string>();
const EMPTY_PENDING_ADDS: ReadonlySet<string> = new Set<string>();

/** Drop ids from the pending-add set once they no longer need protection — because a persisted
 *  snapshot now carries them (propagated) or they were removed locally. Exported for tests. */
export function acknowledgePendingAdds(ids: Iterable<string>): void {
  for (const id of ids) pendingLocalAdds.delete(id);
}

/** Ids of PROJECTS added locally in THIS window but not yet confirmed present in a persisted
 *  snapshot — the project-level analog of pendingLocalAdds (which shields brand-new AGENTS). The
 *  cross-window merge maps over the INCOMING snapshot's projects, so a just-created project that a
 *  concurrent window's last-writer-wins blob predates would be dropped entirely ("created a new
 *  project but it shows nothing / disappears" — the hazel-eco report). While an id lives here the
 *  merge re-attaches its project. Cleared the instant a snapshot carrying it arrives (propagated) and
 *  on local removeProject — so a deliberately-removed project is never resurrected. One set per window. */
const pendingLocalProjectAdds = new Set<string>();

/** Drop project ids from the pending-add set once a persisted snapshot carries them (propagated) or
 *  they were removed locally. Exported for tests. */
export function acknowledgePendingProjectAdds(ids: Iterable<string>): void {
  for (const id of ids) pendingLocalProjectAdds.delete(id);
}

/** Ids of agents REMOVED locally in THIS window but whose removal may not have propagated to the
 *  shared persisted blob yet. The exact mirror of pendingLocalAdds: while an id lives here the merge
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

/** Register ids as locally removed so the merge/adopt paths suppress them. Unlike pendingLocalAdds,
 *  a removal tombstone is NOT cleared when a fresh snapshot arrives: doing so would reopen the race
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
 *  for direct unit testing. */
export function mergePreservingLiveWorkers(
  persistedState: unknown,
  currentState: ProjectState,
  pendingAdds: ReadonlySet<string> = EMPTY_PENDING_ADDS,
  pendingRemovals: ReadonlySet<string> = EMPTY_PENDING_ADDS,
  pendingProjectAdds: ReadonlySet<string> = EMPTY_PENDING_ADDS,
): ProjectState {
  const persisted = (persistedState ?? undefined) as Partial<ProjectState> | undefined;
  const merged = { ...currentState, ...(persisted ?? {}) } as ProjectState;
  const currentProjects = currentState.projects ?? [];
  const incoming = persisted?.projects ?? currentProjects;
  merged.projects = incoming.map((pp) => {
    const cur = currentProjects.find((c) => c.id === pp.id);
    // Removal tombstone (sparkle-close-resurrect): an agent closed locally in THIS window but still
    // carried by a concurrent writer's stale snapshot must NOT be re-added by the whole-array
    // replace ("× closes the terminal but the row comes back"). Filter tombstoned ids out of the
    // incoming snapshot BEFORE anything else — symmetric to pendingLocalAdds, which shields the
    // opposite direction. The tombstone persists until the id is re-created (registerLocalRemovals),
    // so a still-stale window re-broadcasting the closed agent stays suppressed.
    const ppAgents =
      pendingRemovals.size > 0
        ? pp.agents.filter((a) => !pendingRemovals.has(a.id))
        : pp.agents;
    pp = ppAgents === pp.agents ? pp : { ...pp, agents: ppAgents };
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
    const survivors = cur.agents.filter((a) => {
      if (present.has(a.id)) return false; // already in the snapshot — nothing to re-attach
      // (1) A live worker with a cut worktree whose parent still exists (sparkle-3tqv): a snapshot
      //     that predates the spawn must not evict it — its worktree + manifest are live on disk.
      if (a.kind === "worker" && !!a.worktreePath && pp.agents.some((x) => x.id === a.parentId)) {
        return true;
      }
      // (2) A just-created local agent (any kind) not yet flushed + propagated: a concurrent writer's
      //     last-writer-wins snapshot predates it, so the whole-array replace would drop the brand-new
      //     row ("New Build Agent doesn't create a row"). Protect exactly the not-yet-acknowledged
      //     window — pendingAdds is cleared the moment a snapshot carrying the id arrives — so a
      //     genuinely-removed agent (never pending, or already acknowledged) is NOT resurrected.
      if (pendingAdds.has(a.id)) return true;
      return false;
    });
    const mergedAgents = survivors.length > 0 ? [...baseAgents, ...survivors] : baseAgents;
    // Nav-bug fix (Unit A): `selectedAgentId` is LIVE per-window navigation state, not something a
    // concurrent writer's snapshot should reset. A cross-window rehydrate that predates a just-added
    // agent carries a stale `pp.selectedAgentId` (the previously-selected row); taking it verbatim
    // reverts the user's selection right after they clicked "New Build Agent" — whose row survives
    // via the pendingAdds/survivors clause above but is unknown to `pp`, so `pp` still selects the
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
    if (
      mergedAgents === pp.agents &&
      selectedAgentId === pp.selectedAgentId &&
      freshBuildAgentId === (pp.freshBuildAgentId ?? null)
    )
      return pp;
    return { ...pp, agents: mergedAgents, selectedAgentId, freshBuildAgentId };
  });
  // Project-level shield (symmetric to pendingLocalAdds for agents): the map above iterates the
  // INCOMING snapshot's projects, so a project created locally in THIS window but absent from a
  // concurrent writer's stale blob is dropped. Re-attach any just-added project the snapshot doesn't
  // yet carry, and keep the user on it when it was the live selection — a stale snapshot must not
  // yank the window off the project the user just created. Cleared once the snapshot propagates the
  // project (see the merge caller's acknowledgePendingProjectAdds), so a genuinely-removed project is
  // never resurrected.
  if (pendingProjectAdds.size > 0) {
    const mergedIds = new Set(merged.projects.map((p) => p.id));
    const projectSurvivors = currentProjects.filter(
      (p) => pendingProjectAdds.has(p.id) && !mergedIds.has(p.id),
    );
    if (projectSurvivors.length > 0) {
      merged.projects = [...merged.projects, ...projectSurvivors];
      const liveSel = currentState.selectedProjectId;
      if (liveSel != null && projectSurvivors.some((p) => p.id === liveSel)) {
        merged.selectedProjectId = liveSel;
      }
    }
  }
  return merged;
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
        // Shield this brand-new project from a concurrent window's stale rehydrate until the add
        // propagates to the shared blob (mirrors pendingLocalAdds for agents). Cleared on
        // acknowledge (a snapshot carries it) or removeProject.
        pendingLocalProjectAdds.add(id);
        return id;
      },

      removeProject: (id) => {
        // Deliberate removal — stop shielding it so a stale cross-window snapshot can't resurrect
        // the project via the survivor clause above.
        pendingLocalProjectAdds.delete(id);
        set((s) => {
          const projects = s.projects.filter((p) => p.id !== id);
          const selectedProjectId =
            s.selectedProjectId === id ? (projects[0]?.id ?? null) : s.selectedProjectId;
          return { projects, selectedProjectId };
        });
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

      addAgent: (projectId, opts) => {
        const id = uuid();
        const kind: AgentKind = opts?.kind ?? "build";
        const parentId = opts?.parentId ?? null;
        // Shield this brand-new agent from a concurrent writer's last-writer-wins rehydrate until a
        // persisted snapshot carrying it comes back (see pendingLocalAdds / mergePreservingLiveWorkers).
        pendingLocalAdds.add(id);
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
              runtime: "local",
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
              pinnedIndex: null,
            };
            // A freshly-opened BUILD agent floats to the top of the non-alerting sidebar rows
            // until a newer build agent is opened ("until you open a newer one" — the fresh slot
            // is single-occupancy). Only build agents claim it; opening a worker/think agent must
            // not steal the top build slot, so leave freshBuildAgentId untouched for those.
            const freshBuildAgentId = kind === "build" ? id : p.freshBuildAgentId;
            return { ...p, agents: [...p.agents, agent], selectedAgentId: id, freshBuildAgentId };
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
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => {
            // Closing a build agent also closes its workers (they belong to it). Their
            // worktrees are cleaned up separately by the caller for each removed id.
            const removed = p.agents.filter((a) => a.id === agentId || a.parentId === agentId);
            // A locally-removed agent must stop being protected as a pending add, or a rehydrate
            // could resurrect the row the user just closed.
            acknowledgePendingAdds(removed.map((a) => a.id));
            // ...and it must be TOMBSTONED, so a concurrent writer's stale snapshot (or the disk
            // reconcile) that still carries it can't re-add the row before this removal propagates
            // (sparkle-close-resurrect — "× closes the terminal but the row comes back").
            registerLocalRemovals(removed.map((a) => a.id));
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
        }));
      },

      renameAgent: (projectId, agentId, name, pinnedIndex) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            // A manual rename pins the name: from here on it won't auto-change. Clear the
            // auto-name variants too — pinned means "`name` only" (see types.ts), and the
            // sidebar prefers variants over `name`, so leaving them would keep showing the
            // stale auto-name instead of the user's chosen one. When the sidebar passes the
            // agent's current displayed index, anchor the row there too (the unified pin).
            mapAgent(p, agentId, (a) => ({
              ...a,
              name: name.trim() || a.name,
              namePinned: true,
              autoNameVariants: null,
              ...(pinnedIndex != null ? { pinnedIndex } : {}),
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

      autoRenameAgent: (projectId, agentId, name, basis, autoName) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) =>
              // Respect a pinned name (manual), a self-chosen name (sparkle-control rename_agent), AND
              // a Claude Code session title (authoritative). The aiTitle check makes the STORE the
              // single arbiter of precedence, closing the race where an in-flight Haiku call (started
              // before a title existed) resolves AFTER the title poll applied one — without it, the
              // stale guess would clobber the title.
              a.namePinned || a.selfNamed || a.aiTitle || !name.trim()
                ? a
                : { ...a, name: name.trim(), autoNameBasis: basis, autoNameVariants: autoName ?? null },
            ),
          ),
        })),

      applyAiTitle: (projectId, agentId, title) =>
        set((s) => {
          const t = title.trim();
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

      pinAgentAt: (projectId, agentId, index) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            // Drag-pin: freeze the name AND anchor the row. Unlike renameAgent, the NAME is not
            // changing here — a pure reorder — so keep autoNameVariants intact. Clearing them
            // would drop the width-fitted display back to the stale `name`, visibly changing the
            // label on a drag (roborev 12870).
            mapAgent(p, agentId, (a) => ({
              ...a,
              namePinned: true,
              pinnedIndex: index,
            })),
          ),
        })),

      unpinAgent: (projectId, agentId) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            // Release both: name auto-renames again and the row rejoins the attention sort.
            mapAgent(p, agentId, (a) => ({ ...a, namePinned: false, pinnedIndex: null })),
          ),
        })),

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

      setAgentWorktree: (projectId, agentId, path, branch) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => ({ ...a, worktreePath: path, branch })),
          ),
        })),

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
              pinnedIndex: null,
            };
            // Append WITHOUT changing selectedAgentId — the self-heal must be invisible to the user.
            return { ...p, agents: [...p.agents, agent] };
          }),
        })),

      appendPrompt: (projectId, agentId, text, source = "composer") => {
        const id = uuid();
        // A picker answer is recorded ONLY to advance promptCount for the naming ladder; it must not
        // become the pinned banner's "last prompt" (that surface, like the breadcrumb, is for real
        // user messages). So only a composer send moves `lastPrompt`; a picker send leaves it.
        const isPicker = source === "picker";
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => ({
              ...a,
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
      // "brainstorm" agent kind to "think" (the Think rename). v8 backfills pinnedIndex: null
      // (manual reorder anchor) without touching namePinned. v9 heals the sparkle-pel7 residue:
      // build/worker rows frozen (namePinned:true, pinnedIndex null) by the OLD self-name path get
      // unpinned + marked selfNamed so the erroneous pin chip clears while the name is preserved.
      // v10 backfills promptHistory[].source: "composer" (picker-tagging, Task 2.3).
      version: 10,
      migrate: (persisted, version) =>
        perfSpan("persist.migrate", () => migratePersisted(persisted, version), { version }) as ProjectState,
      // sparkle-3tqv: a protective merge so no rehydrate (startup or cross-window) can evict a
      // worker whose worktree is live on disk — extended to also shield a just-added agent from a
      // concurrent writer's stale snapshot (pendingLocalAdds) so "New Build Agent" never loses its row.
      merge: (persisted, current) => {
        // Any pending add the incoming snapshot now carries has propagated — stop protecting it, so a
        // later genuine removal isn't overridden. Done before the merge (which re-reads the set).
        const persistedProjects =
          (persisted as Partial<ProjectState> | undefined)?.projects ?? [];
        acknowledgePendingAdds(persistedProjects.flatMap((p) => p.agents.map((a) => a.id)));
        // Same for projects: any pending project-add the snapshot now carries has propagated — stop
        // shielding it so a later genuine removal isn't overridden by the survivor clause.
        acknowledgePendingProjectAdds(persistedProjects.map((p) => p.id));
        return perfSpan("persist.merge", () =>
          mergePreservingLiveWorkers(
            persisted,
            current,
            pendingLocalAdds,
            pendingLocalRemovals,
            pendingLocalProjectAdds,
          ),
        );
      },
    },
  ),
);
