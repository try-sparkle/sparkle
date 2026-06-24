// projectStore — the persisted structure (spec §4): projects, their agent tabs, names,
// last prompts. Persisted to localStorage (durable in the Tauri webview) so quit/relaunch
// restores everything. Live process/status state is NOT here (see runtimeStore).
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AgentTab, Project } from "../types";

function uuid(): string {
  return crypto.randomUUID();
}

interface ProjectState {
  projects: Project[];
  selectedProjectId: string | null;

  addProject: (name: string, rootPath: string) => string;
  removeProject: (id: string) => void;
  selectProject: (id: string) => void;
  /** Update name + folder location together (after the on-disk move succeeds). Recomputes
   * each agent's worktree path under the new root. */
  relocateProject: (id: string, newName: string, newRootPath: string) => void;

  addAgent: (projectId: string, name?: string) => string;
  removeAgent: (projectId: string, agentId: string) => void;
  renameAgent: (projectId: string, agentId: string, name: string) => void;
  selectAgent: (projectId: string, agentId: string) => void;
  setAgentWorktree: (projectId: string, agentId: string, path: string, branch: string) => void;
  setLastPrompt: (projectId: string, agentId: string, prompt: string) => void;
}

function mapProject(
  projects: Project[],
  id: string,
  fn: (p: Project) => Project,
): Project[] {
  return projects.map((p) => (p.id === id ? fn(p) : p));
}

function mapAgent(p: Project, agentId: string, fn: (a: AgentTab) => AgentTab): Project {
  return { ...p, agents: p.agents.map((a) => (a.id === agentId ? fn(a) : a)) };
}

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

      relocateProject: (id, newName, newRootPath) =>
        set((s) => ({
          projects: mapProject(s.projects, id, (p) => ({
            ...p,
            name: newName.trim() || p.name,
            rootPath: newRootPath,
            agents: p.agents.map((a) => ({
              ...a,
              // Worktrees live at <root>/.sparkle/worktrees/<id> — recompute under the
              // new root (branch is unchanged).
              worktreePath: a.worktreePath
                ? `${newRootPath}/.sparkle/worktrees/${a.id}`
                : a.worktreePath,
            })),
          })),
        })),

      addAgent: (projectId, name) => {
        const id = uuid();
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => {
            const agent: AgentTab = {
              id,
              name: name ?? `Agent ${p.agents.length + 1}`,
              runtime: "local",
              worktreePath: null,
              branch: null,
              lastPrompt: "",
            };
            return { ...p, agents: [...p.agents, agent], selectedAgentId: id };
          }),
        }));
        return id;
      },

      removeAgent: (projectId, agentId) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) => {
            const agents = p.agents.filter((a) => a.id !== agentId);
            const selectedAgentId =
              p.selectedAgentId === agentId ? (agents[0]?.id ?? null) : p.selectedAgentId;
            return { ...p, agents, selectedAgentId };
          }),
        })),

      renameAgent: (projectId, agentId, name) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => ({ ...a, name: name.trim() || a.name })),
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

      setLastPrompt: (projectId, agentId, prompt) =>
        set((s) => ({
          projects: mapProject(s.projects, projectId, (p) =>
            mapAgent(p, agentId, (a) => ({ ...a, lastPrompt: prompt })),
          ),
        })),
    }),
    {
      name: "sparkle-projects",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
