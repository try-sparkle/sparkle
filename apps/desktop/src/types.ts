// Desktop workspace domain types (spec §4). Projects hold agent tabs; agent tabs are
// rendered one-per-tab with a real `claude` PTY underneath. Live runtime state (status,
// PTY handles) is NOT stored here — see stores/runtimeStore.ts.
import type { AgentTabStatus } from "@sparkle/ui";

export type Runtime = "local" | "cloud";

// What kind of agent this is (spec: Brainstorm vs Build). A "brainstorm" agent chats with
// Chief over the project's knowledge (no worktree/PTY). A "build" agent is a master
// orchestrator you talk to (a Claude terminal) that spawns "worker" sub-agents — each a
// terminal agent in its own worktree, shown indented under its build parent in the sidebar.
export type AgentKind = "brainstorm" | "build" | "worker";

// Three length variants of an auto-generated name (spec: width-fitted agent names). The
// sidebar renders the longest variant that fits the column and reveals `long` on hover. Word
// budgets: short 2–4, medium 5–6, long 8–10. Produced together in one naming call.
export interface AgentNameVariants {
  short: string;
  medium: string;
  long: string;
}

export interface AgentTab {
  id: string;
  name: string;
  kind: AgentKind; // brainstorm | build | worker (legacy agents migrate to "build")
  parentId: string | null; // for workers: the build agent that owns them; else null
  runtime: Runtime; // v1: always "local"; cloud is shown-but-disabled
  worktreePath: string | null; // Sparkle-managed isolated dir (hidden from user)
  branch: string | null; // hidden git branch
  baseBranch: string | null; // logical integration branch this agent was cut from (e.g. "main")
  lastPrompt: string; // for the pinned header
  task?: string; // for workers: the one-shot task the build agent assigned; drives the worker persona
  parentBranch?: string; // for workers: the parent build agent's branch at spawn time (stable, not re-resolved)
  // Auto-naming (spec: agents summarize their own work). `namePinned` is set when the user
  // renames by hand — it freezes the name (pin icon) and stops auto-renaming. `autoNameBasis`
  // is the prompt the current auto-name was derived from, used to decide when the work has
  // shifted enough to re-name. Null until the first auto-name lands.
  namePinned: boolean;
  autoNameBasis: string | null;
  // The three length variants behind the current auto-name (spec: width-fitted names). Null
  // until the first auto-name lands, and for pinned/manually-named agents (which use `name`
  // only). `name` stays the canonical fallback — set to the medium variant when these exist.
  autoNameVariants: AgentNameVariants | null;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string; // user-chosen folder (existing or newly created)
  defaultBranch: string | null; // project's logical integration branch (auto-detected, editable)
  createdAt: string;
  lastOpenedAt?: string; // updated when selected — drives "Recent Projects" ordering
  agents: AgentTab[];
  selectedAgentId: string | null;
}

export type { AgentTabStatus };
