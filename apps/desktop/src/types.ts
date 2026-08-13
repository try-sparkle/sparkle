// Desktop workspace domain types (spec §4). Projects hold agent tabs; agent tabs are
// rendered one-per-tab with a real `claude` PTY underneath. Live runtime state (status,
// PTY handles) is NOT stored here — see stores/runtimeStore.ts.
import type { AgentTabStatus } from "@sparkle/ui";
import type { AgentGoal, GoalDebt } from "./engine/agentGoal";

export type { AgentGoal, GoalDebt };

export type Runtime = "local" | "cloud";

// What kind of agent this is. A "build" agent is a master orchestrator you talk to (a Claude
// terminal) that spawns "worker" sub-agents — each a terminal agent in its own worktree, shown
// indented under its build parent in the sidebar. A "shell" agent runs a raw command (Run-as-cmd).
export type AgentKind = "build" | "worker" | "shell";

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
// spec: docs/superpowers/specs/2026-07-09-dismiss-alert-design.md). A row is RED because its status
// is waiting|approval|errored|blocked; dismissing acknowledges that red WITHOUT resolving it. A plain
// boolean can't distinguish "the alert I dismissed" from "a fresh problem", so we track episodes:
// `seq` counts red episodes entered, `lastRed` is the last red signature (seeds restart), and
// `dismissedSeq` is the episode the user acknowledged. Suppressed iff red now AND dismissedSeq===seq;
// any new episode bumps seq past dismissedSeq → re-alert. Optional so legacy records need no migration.
//
// `blocked` joined the union on 2026-07-26 (see engine/alertDismissal.RedStatus). Widening it is
// backward-compatible in both directions: a persisted record from an older build simply never carries
// the new value, and a record carrying it read by an older build lands in the `lastRed !== status`
// branch, which starts a fresh episode rather than crashing.
export interface AgentAlertRecord {
  seq: number;
  // The last ALERTING status this row presented, not strictly the last RED one: `lapsed` (amber,
  // "Auto-continue stopped") is acknowledgeable the same way even though it is not red, so it can
  // be the episode's signature. Widening a persisted union needs no migration — an older record
  // simply never carries the new value. See engine/alertDismissal.AlertingStatus.
  lastRed: "waiting" | "approval" | "errored" | "blocked" | "lapsed" | null;
  dismissedSeq: number | null;
}

export interface AgentTab {
  id: string;
  name: string;
  kind: AgentKind; // build | worker | shell (legacy think agents migrate to "build")
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
  // What this agent is trying to ACHIEVE, and whether it has (engine/agentGoal.AgentGoal).
  //
  // Distinct from `activity` in the way that matters: `activity` is what the agent is doing right
  // now and is expected to change constantly; a goal is the standing objective, carries a TTL, and
  // has a met/unmet answer. That answer is the only thing that makes an idle agent legitimately
  // "done" — a turn ending does not set it — which is what lets engine/agentStall tell
  // idle-and-finished from idle-and-stalled, and what licenses engine/goalContinuation to restart
  // a turn that ended with work remaining.
  //
  // Persisted deliberately: a relaunch is itself one of the most common ways a turn gets ended
  // mid-task (an app restart ended fourteen build agents' turns at once on 2026-07-29), so the
  // goal has to survive the very event it exists to recover from. Optional, so legacy records need
  // no migration and read as "no goal" — which disables auto-continue for them, the safe default.
  goal?: AgentGoal;
  // What the agent still OWES after clearing its own goal — see engine/agentGoal.GoalDebt for the
  // two-call reset this exists to block. Written only when an AGENT clears a goal that had spent
  // budget or been escalated; consumed by the next agent-set goal; dropped by either human lever
  // (setAgentGoal by a human, resetAgentGoalRetries). Absent on the common path, so it adds nothing
  // to the persisted blob for the fleet's ordinary agents.
  goalDebt?: GoalDebt;
  // Requested at spawn: "plan" launches the agent with `--permission-mode plan` so it researches
  // and proposes before editing. Only ever "plan" — ordinary mode is the ABSENCE of this, so we
  // never override a user who configured a different default in their own Claude Code settings.
  //
  // Read ONLY on a fresh launch (see claudeSpawn.buildClaudeExec): the human leaves plan mode with
  // shift+tab inside the session, which this layer cannot observe, so re-applying it on every
  // relaunch would drag them back into plan mode after they had left it. Optional, so existing
  // persisted records need no migration.
  permissionMode?: "plan";
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
  // NOTE: `pinnedIndex` was REMOVED on 2026-07-26. It anchored a top-level row against the
  // attention sort; that sort is gone (rows group by workflow stage, then render in
  // `project.agents` order), so there is nothing left to anchor against and reordering just
  // permutes the array. `namePinned` survives and now means ONLY "the human named this, don't
  // auto-rename it". See engine/buildSections.ts and projectStore.reorderAgent.
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
  // Epoch ms of the first line the user SUBMITTED straight into this agent's terminal. Persisted,
  // and that is the whole point: it is the durable twin of `interactionStore.lastAt`, which is
  // in-memory only. An agent driven entirely by hand has empty `lastPrompt`/`promptHistory`, so
  // without this its brief evaporated on relaunch and engine/newAgentAttention would call it
  // "spawned, never briefed" again — rendering a genuinely wedged agent calm gray instead of red,
  // indefinitely, because that mapping is deliberately not time-limited. `createdAt` above survives
  // a restart, so the evidence that answers it has to survive one too (roborev 54771).
  // Optional: legacy rows read as undefined and keep their exact prior behaviour.
  terminalBriefedAt?: number;
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
  /** The ORCHESTRATION-side project row this local project maps to (Service B / cloud agents).
   *  A cloud session is started and listed against a server `sparkle_projects.id` (a uuid the
   *  server owns), which is NOT this record's locally-minted `id` — so the first cloud action
   *  resolves/creates that row and caches its id here (see services/cloudAgents/projectLink.ts).
   *  Absent for every project that has never run a cloud agent, i.e. all of them until the
   *  feature is switched on for the account. */
  cloudProjectId?: string | null;
  /** The CHIEF projects this Sparkle project is bound to (bead `sparkle-8rr0c`). An agent running
   *  here reaches these and nothing else; the concierge reaches every project the token can see,
   *  regardless of this field. One-to-MANY was the founder's call — "each build agent can access
   *  specific projects" — so a strict 1:1 is just the case where this holds one id.
   *  Absent/empty means UNBOUND, which is a refusal rather than an open door: with 348 reachable
   *  projects, defaulting an unbound agent to any of them is the failure this feature exists to
   *  prevent (see services/chiefScope.ts). Optional, so every pre-existing persisted project reads
   *  as unbound without a store migration — same shape as `cloudProjectId` above. */
  chiefProjectIds?: string[];
  /** The member of `chiefProjectIds` used when an agent names no project. `null`/absent means "no
   *  default — ask". Kept separate from the array's order so re-ordering the binding in the UI
   *  can't silently change which project agents read. */
  chiefPrimaryId?: string | null;
  /** The REPOSITORY this project's folder belongs to — the canonical `.git` common dir, resolved
   *  once by `services/repoKey` (Rust `project_repo_key`). It is what makes "already open" mean the
   *  same repo rather than the same folder: a linked git worktree has its OWN `rootPath` but shares
   *  this, which is how `~/Projects/sparkle` and `~/Projects/sparkle-desktop` ended up on screen as
   *  two projects (engine/projectIdentity).
   *
   *  Absent until a repository is actually found — a folder we could not resolve one for (not a
   *  repo, missing, unmounted, git failed) is left ABSENT rather than recorded as `null`, so a
   *  later sweep still gets to ask (projectStore.setProjectRepoKey). Absent falls back to path
   *  identity, which is exactly the dedupe the app already had. */
  repoKey?: string | null;
}

export type { AgentTabStatus };

/** A closed agent's final KNOWN status + when it was captured (epoch ms). Written by
 *  runtimeStore.close() from the `status` entry it is about to delete, and PERSISTED, so a surface
 *  can tell "this agent RAN and its pane was closed" from "this agent NEVER started". Those two were
 *  indistinguishable while the live-only `status` map was the only signal — close() dropped the
 *  entry, a closed worker read as statusless, and the unstarted-worker overlay synthesized a phantom
 *  red "Approve?" under a still-open orchestrator (sparkle-w340).
 *
 *  A RED-TIER status (waiting/approval/blocked/errored) is DEMOTED to `stopped` on capture: a
 *  question or approval prompt lives only as long as its PTY, so a closed pane must never read back
 *  as still asking. The `at` timestamp is retained for future "stopped N ago" affordances. */
export interface LastObserved {
  status: AgentTabStatus;
  at: number;
}
