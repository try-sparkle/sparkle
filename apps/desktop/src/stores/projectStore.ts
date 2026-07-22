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
import { clearPin } from "../services/accountStore";
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

const { storage: debouncedProjectsStorage, flush: flushProjectsPersistImpl } =
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
 *  for direct unit testing. */
export function mergePreservingLiveWorkers(
  persistedState: unknown,
  currentState: ProjectState,
  pendingRemovals: ReadonlySet<string> = EMPTY_PENDING_ADDS,
): ProjectState {
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
    .filter((id) => !isRemoved(id))
    .map((id) => {
      const ppMaybe = incomingById.get(id);
      const cur = currentProjects.find((c) => c.id === id);
      // Present only in memory (the snapshot's writer hadn't seen this project yet) — keep ours,
      // minus any agent that has since been tombstoned.
      if (!ppMaybe) return withoutRemovedAgents(cur as Project, isRemoved);
      return mergeProject(ppMaybe, cur, isRemoved);
    });

  // Keep the window on a live selection the incoming snapshot simply hadn't SEEN yet: a stale writer
  // must not yank the user off the project they just created (it carries its own older selection).
  // Deliberately narrow — when both sides know the project, the snapshot's selection still wins, as
  // before. Mirrors the per-agent selectedAgentId rule inside mergeProject.
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

/** Drop tombstoned agents from a project, returning the SAME object when nothing changed. */
function withoutRemovedAgents(p: Project, isRemoved: (id: string) => boolean): Project {
  const agents = p.agents.filter((a) => !isRemoved(a.id));
  return agents.length === p.agents.length ? p : { ...p, agents };
}

/** Merge one project that exists in BOTH the incoming snapshot and memory: union its agents by id,
 *  drop tombstoned ones, and preserve the live per-window state (authoritative names, selection,
 *  fresh-agent boost) that a stale snapshot would otherwise revert. */
function mergeProject(
  ppIn: Project,
  curIn: Project | undefined,
  isRemoved: (id: string) => boolean,
): Project {
  // Removal tombstone (sparkle-close-resurrect): an agent closed in ANY window but still carried by
  // a concurrent writer's stale snapshot must NOT be re-added ("× closes the terminal but the row
  // comes back"). Filter tombstoned ids out of the incoming snapshot before anything else.
  const pp = withoutRemovedAgents(ppIn, isRemoved);
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
    const mergedAgents = survivors.length > 0 ? [...baseAgents, ...survivors] : baseAgents;
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
    if (
      mergedAgents === pp.agents &&
      selectedAgentId === pp.selectedAgentId &&
      freshBuildAgentId === (pp.freshBuildAgentId ?? null)
    )
      return pp;
    return { ...pp, agents: mergedAgents, selectedAgentId, freshBuildAgentId };
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
          return { projects, selectedProjectId, removedIds: withTombstones(s.removedIds, doomed) };
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
      // v11 backfills removedIds: {} — the shared removal tombstones the union merge needs
      // (sparkle-pckz). An older blob simply has no recorded deletions, which is the safe default:
      // the union keeps everything, and the first close in the new build starts the map.
      version: 12,
      migrate: (persisted, version) =>
        perfSpan("persist.migrate", () => migratePersisted(persisted, version), { version }) as ProjectState,
      // sparkle-pckz: a UNION merge, so no rehydrate (startup or cross-window) can evict a record
      // just because the writing window hadn't seen it yet. Only an explicit tombstone deletes —
      // `removedIds` from the blob, plus this window's not-yet-persisted local removals.
      merge: (persisted, current) => {
        return perfSpan("persist.merge", () =>
          mergePreservingLiveWorkers(persisted, current, pendingLocalRemovals),
        );
      },
    },
  ),
);
