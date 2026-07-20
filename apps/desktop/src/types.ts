// Desktop workspace domain types (spec §4). Projects hold agent tabs; agent tabs are
// rendered one-per-tab with a real `claude` PTY underneath. Live runtime state (status,
// PTY handles) is NOT stored here — see stores/runtimeStore.ts.
import type { AgentTabStatus } from "@sparkle/ui";

export type Runtime = "local" | "cloud";

// What kind of agent this is (spec: Think vs Build). A "think" agent chats with
// Chief over the project's knowledge (no worktree/PTY). A "build" agent is a master
// orchestrator you talk to (a Claude terminal) that spawns "worker" sub-agents — each a
// terminal agent in its own worktree, shown indented under its build parent in the sidebar.
export type AgentKind = "think" | "build" | "worker" | "shell";

// An auto-generated agent name: a short `title` (3–5 words) for the sidebar plus a one-sentence
// `description` of the work, produced together in one naming call. The sidebar shows the title
// (truncated to fit the column) and reveals the title + description on hover. `description` may be
// empty (a plain-title fallback, or a Claude Code session title, which has no description).
export interface AgentName {
  title: string;
  description: string;
}

// Where a prompt-history entry came from. "composer" is a real user message (typed/voice send, or
// the build seed) — the only kind shown in the pinned-header breadcrumb / tray. "picker" is an
// answer to Claude Code's own in-terminal selection menu (AskUserQuestion), recorded ONLY so it
// advances promptCount for the naming ladder; it is filtered OUT of every display surface because a
// terse answer like "Unlisted — direct link only" would otherwise evict the real request from the
// breadcrumb (the whole point of which is to surface what you last asked without scrolling).
export type PromptSource = "composer" | "picker";

// One entry in an agent's prompt history (the dropdown under the pinned header). `id` is the
// key the Terminal stores its xterm marker under, so clicking an entry can scroll the terminal
// back to where that prompt was sent. `text` is the display text (same as the transcript line);
// `at` is the submit time (epoch ms) for the "2m ago" label.
export interface PromptHistoryEntry {
  id: string;
  text: string;
  at: number;
  // Absent on records written before the picker-tagging change (persist v10 backfills them to
  // "composer"); readers treat a missing value as "composer" so legacy entries always display.
  source?: PromptSource;
}

// Per-agent alert-episode record backing the "Dismiss Alert" affordance (engine/alertDismissal.ts,
// spec: docs/superpowers/specs/2026-07-09-dismiss-alert-design.md). A row is RED purely because its
// status is waiting|approval|errored; dismissing acknowledges that red WITHOUT resolving it. A plain
// boolean can't distinguish "the alert I dismissed" from "a fresh problem", so we track episodes:
// `seq` counts red episodes entered, `lastRed` is the last red signature (seeds restart), and
// `dismissedSeq` is the episode the user acknowledged. Suppressed iff red now AND dismissedSeq===seq;
// any new episode bumps seq past dismissedSeq → re-alert. Optional so legacy records need no migration.
export interface AgentAlertRecord {
  seq: number;
  lastRed: "waiting" | "approval" | "errored" | null;
  dismissedSeq: number | null;
}

export interface AgentTab {
  id: string;
  name: string;
  kind: AgentKind; // think | build | worker | shell (legacy agents migrate to "build")
  parentId: string | null; // for workers: the build agent that owns them; else null
  runtime: Runtime; // v1: always "local"; cloud is shown-but-disabled
  worktreePath: string | null; // Sparkle-managed isolated dir (hidden from user)
  branch: string | null; // hidden git branch
  baseBranch: string | null; // logical integration branch this agent was cut from (e.g. "main")
  lastPrompt: string; // for the pinned header (always the most recent prompt's text)
  // Every prompt submitted to this agent, oldest-first (the pinned-header dropdown reverses it
  // for newest-first display). Capped to the most recent entries. Persisted so the list survives
  // restarts; the scroll-to-conversation markers are session-only (see Terminal), so an entry from
  // a previous session still shows in the list but reports "scrolled out" when clicked.
  promptHistory: PromptHistoryEntry[];
  // The agent's live, first-person "what I'm building now" narration, set by the agent itself via
  // the sparkle-control MCP `set_agent_activity` op. A short free-text line shown muted + truncated
  // under the agent name (see AgentSidebar / FittedAgentName). Optional so legacy records need no
  // migration; undefined/empty renders nothing.
  activity?: string;
  task?: string; // for workers: the one-shot task the build agent assigned; drives the worker persona
  parentBranch?: string; // for workers: the parent build agent's branch at spawn time (stable, not re-resolved)
  beadId?: string; // for workers: the bead this worker implements, when spawned from a Plan epic (Think→Plan→Build linkage)
  epicId?: string; // for build agents: the epic handed to this orchestrator, set at sendToBuild time (drives the sidebar epic pill before any worker binds to a bead)
  // Auto-naming (spec: agents summarize their own work). `namePinned` is set when the user
  // renames by hand — it freezes the name (pin icon) and stops auto-renaming. `autoNameBasis`
  // is the prompt the current auto-name was derived from, used to decide when the work has
  // shifted enough to re-name. Null until the first auto-name lands.
  namePinned: boolean;
  // Set when the AGENT names ITSELF via the sparkle-control `rename_agent` MCP op (self-report
  // naming, PRs #376/#380/#390). Like `namePinned` it makes the chosen name authoritative — it
  // freezes the name against the background auto-namer, skips the paid Haiku fallback, and is
  // preserved across a rehydrate merge. But it is NOT a human pin: it does NOT show the pin chip
  // and does NOT anchor the sidebar row (that stays the exclusive job of `namePinned`/`pinnedIndex`),
  // so an agent naming itself never looks pinned and never blocks the human's reorder. Optional so
  // legacy records read as `undefined` (falsy = not self-named) with no migration step.
  selfNamed?: boolean;
  autoNameBasis: string | null;
  // The title + description behind the current auto-name. Null until the first auto-name lands,
  // and for pinned/manually-named agents (which use `name` only). `name` stays the canonical
  // fallback — set to the title when this exists. (Field name kept for persisted-state stability.)
  autoNameVariants: AgentName | null;
  // The last Claude Code session title (`ai-title`) applied to this agent. Claude Code derives it
  // from the FULL conversation (prompts + responses + images), so it's the authoritative auto-name
  // once present — it supersedes the prompt-derived Haiku name and suppresses further Haiku calls.
  // Undefined until the first title is read; cleared semantics follow `namePinned` (a manual rename
  // still wins). Tracked separately from `name` so we can detect when Claude Code's title changes.
  aiTitle?: string | null;
  // For "shell" agents (Run-as-cmd from the terminal selection popup): the command this tab
  // runs on spawn. Null for all other kinds.
  shellCommand: string | null;
  // The Claude model this agent runs (services/models.ts). A model id passed as `--model` at
  // spawn (and `/model` into a live PTY on change); undefined or the "default" sentinel means
  // inherit the user's own Claude Code default (no flag). Optional so legacy records need no
  // migration step.
  model?: string;
  // Manual reorder anchor (spec: manual-agent-reorder-pin). When non-null, this top-level
  // agent is pinned to this row index and does NOT attention-sort; unpinned agents flow
  // around it. Set together with `namePinned` on drag/rename; cleared together on unpin.
  pinnedIndex: number | null;
  // The alert-episode record backing "Dismiss Alert" (AgentAlertRecord above). Undefined until the
  // agent first enters a red status; advanced by projectStore.advanceAlerts on red transitions.
  alert?: AgentAlertRecord;
  // Epoch ms at which this agent row was created in THIS window (sparkle-pckz). Used solely by
  // mergePreservingLiveWorkers to tell a stale writer's ignorance apart from a deliberate removal:
  // an agent created AFTER an incoming snapshot was written (ProjectState.persistedAt) cannot have
  // been removed by that snapshot's writer, so its absence there must not evict the live row.
  // Optional — legacy persisted records read as undefined and keep the pre-existing behaviour
  // exactly (no migration step, no retroactive shielding).
  createdAt?: number;
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
  // The most-recently-opened BUILD agent, floated to the top of the non-alerting rows in the
  // attention-ordered sidebar until a newer build agent is opened (see engine/agentOrdering.ts,
  // FRESH_BUILD_RANK). It's live UI state (like selectedAgentId — the two are treated the same
  // way in mergePreservingLiveWorkers) but, like selectedAgentId, IS persisted (the store has no
  // partialize), so after a cold start the prior session's last-opened build agent stays boosted
  // until any new one is opened — harmless and self-correcting. Optional so pre-existing persisted
  // projects (missing the field) read as "no fresh agent".
  freshBuildAgentId?: string | null;
}

export type { AgentTabStatus };
