// projectStore — the persisted structure (spec §4): projects, their agent tabs, names,
// last prompts. Persisted to localStorage (durable in the Tauri webview) so quit/relaunch
// restores everything. Live process/status state is NOT here (see runtimeStore).
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AgentKind, AgentName, AgentTab, Project } from "../types";
import { isDefaultModel } from "../services/models";
import { usageTelemetry } from "../services/usageTelemetry";

// Cap on how many prompts we keep per agent so the persisted localStorage record stays bounded.
// The oldest entries fall off; the most recent PROMPT_HISTORY_LIMIT are kept.
export const PROMPT_HISTORY_LIMIT = 100;

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

interface ProjectState {
  projects: Project[];
  selectedProjectId: string | null;

  addProject: (name: string, rootPath: string) => string;
  removeProject: (id: string) => void;
  selectProject: (id: string) => void;
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
  /** Bind the epic an orchestrator is building (set at sendToBuild handoff — drives the sidebar
   *  epic pill immediately, before any of its workers bind to a bead). */
  setAgentEpicId: (projectId: string, agentId: string, epicId: string) => void;
  removeAgent: (projectId: string, agentId: string) => void;
  /** Manual rename: sets the name AND pins it (freezes auto-naming, shows the pin icon). When
   *  the caller passes `pinnedIndex` (the agent's current displayed slot), also anchor the row
   *  there — the unified pin (manual-agent-reorder-pin). */
  renameAgent: (projectId: string, agentId: string, name: string, pinnedIndex?: number) => void;
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
  /** Select an agent, or pass `null` to clear selection (routes the main pane to the blank state). */
  selectAgent: (projectId: string, agentId: string | null) => void;
  setAgentWorktree: (projectId: string, agentId: string, path: string, branch: string) => void;
  /** Record a submitted prompt: updates `lastPrompt` (pinned header) AND appends to
   *  `promptHistory` (capped). Returns the new entry's id so the caller can register the matching
   *  terminal scroll marker under the same key. */
  appendPrompt: (projectId: string, agentId: string, text: string) => string;
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

export const useProjectStore = create<ProjectState>()(
  persist(
    (set) => ({
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
        };
        set((s) => ({ projects: [...s.projects, project], selectedProjectId: id }));
        return id;
      },

      removeProject: (id) =>
        set((s) => {
          const projects = s.projects.filter((p) => p.id !== id);
          const selectedProjectId =
            s.selectedProjectId === id ? (projects[0]?.id ?? null) : s.selectedProjectId;
          return { projects, selectedProjectId };
        }),

      selectProject: (id) =>
        set((s) => ({
          selectedProjectId: id,
          projects: mapProject(s.projects, id, (p) => ({
            ...p,
            lastOpenedAt: new Date().toISOString(),
          })),
        })),

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
            return { ...p, agents: [...p.agents, agent], selectedAgentId: id };
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

      setAgentEpicId: (projectId, agentId, epicId) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => ({
            ...p,
            agents: p.agents.map((a) => (a.id === agentId ? { ...a, epicId } : a)),
          })),
        })),

      removeAgent: (projectId, agentId) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => {
            // Closing a build agent also closes its workers (they belong to it). Their
            // worktrees are cleaned up separately by the caller for each removed id.
            const agents = p.agents.filter(
              (a) => a.id !== agentId && a.parentId !== agentId,
            );
            const selectedAgentId =
              agents.some((a) => a.id === p.selectedAgentId)
                ? p.selectedAgentId
                : (agents[0]?.id ?? null);
            return { ...p, agents, selectedAgentId };
          }),
        })),

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

      autoRenameAgent: (projectId, agentId, name, basis, autoName) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) =>
              // Respect a pinned name (manual) AND a Claude Code session title (authoritative).
              // The aiTitle check makes the STORE the single arbiter of precedence, closing the
              // race where an in-flight Haiku call (started before a title existed) resolves AFTER
              // the title poll applied one — without it, the stale guess would clobber the title.
              a.namePinned || a.aiTitle || !name.trim()
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
          if (!agent || agent.namePinned || agent.aiTitle === t) return s;
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
              // A manual rename is the user's choice — never auto-reset it on a fresh start. Also
              // bail (return the SAME reference) when there's no auto-name to clear — the common
              // first-launch case — so subscribers don't re-render for a no-op.
              a.namePinned ||
              (a.autoNameBasis === null && a.autoNameVariants === null && a.aiTitle === undefined)
                ? a
                : {
                    ...a,
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

      selectAgent: (projectId, agentId) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => ({
            ...p,
            selectedAgentId: agentId,
          })),
        })),

      setAgentWorktree: (projectId, agentId, path, branch) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => ({ ...a, worktreePath: path, branch })),
          ),
        })),

      appendPrompt: (projectId, agentId, text) => {
        const id = uuid();
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => ({
              ...a,
              lastPrompt: text,
              // Append newest-last, then keep only the most recent entries so the persisted
              // record can't grow without bound. The dropdown reverses this for display.
              promptHistory: [...(a.promptHistory ?? []), { id, text, at: Date.now() }].slice(
                -PROMPT_HISTORY_LIMIT,
              ),
            })),
          ),
        }));
        return id;
      },
    }),
    {
      name: PROJECTS_PERSIST_KEY,
      storage: createJSONStorage(() => localStorage),
      // Bumped when the persisted shape gains fields. v1 backfills the main-first-defaults
      // fields so legacy records rehydrate with `null` (matching fresh records) rather than
      // `undefined` — an undefined baseBranch would otherwise send "" to the git commands.
      // v2 backfills the auto-naming fields (namePinned/autoNameBasis). v3 backfills the
      // Think/Build kind + parentId (separate step so records already at v2 still get them).
      // v4 backfills autoNameVariants (width-fitted names) to null. v5 backfills promptHistory
      // (the pinned-header dropdown) as an empty array. v6 backfills shellCommand: null for the
      // Run-as-cmd "shell" agent kind (folded in from PR #62). v7 remaps the legacy
      // "brainstorm" agent kind to "think" (the Think rename). v8 backfills pinnedIndex: null
      // (manual reorder anchor) without touching namePinned.
      version: 8,
      migrate: (persisted, version) => migratePersisted(persisted, version) as ProjectState,
    },
  ),
);
