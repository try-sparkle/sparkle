// Auto-naming from Claude Code's own session title. Claude Code writes an `ai-title` into each
// agent's transcript, derived from the FULL conversation (prompts, responses, attached images) —
// a far better name than our prompt-only Haiku summary, and free (already on disk). This bridge
// reads that title (Rust `agent_session_title`, which tails the worktree's newest transcript) and
// applies it as the authoritative auto-name. The same transcript is the substrate the prompt/
// response SEARCH feature will index, so this reader is the shared, reusable primitive for both.
//
// Best-effort throughout: no worktree, no title yet (the first turn hasn't summarized), or any
// backend error simply leaves the current name untouched — the store action respects a pinned
// (manually-renamed) name and de-dupes an unchanged title.
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../stores/projectStore";
import { reportNamingOutcome } from "./selfReportObservability";
import type { AgentKind } from "../types";

/**
 * Read the agent's Claude Code session title and apply it (no-op until a title exists).
 *
 * `opts.backfill` marks a Tier-1 name-from-work poll: an agent whose pane is CLOSED and that still
 * holds its unpinned "Build N"/"Worker N" default (see agentNaming.isNameFromWorkCandidate). When such
 * an agent finally has a title, applying it is a FREE win we tally distinctly (`named_from_session_
 * title_backfill`) so we can measure how often Tier 1 rescues a stuck default before the paid Tier-2
 * backstop ever runs. `opts.kind` is only used to label that telemetry.
 */
export async function refreshAgentTitle(
  projectId: string,
  agentId: string,
  worktreePath: string | null,
  opts?: { backfill?: boolean; kind?: AgentKind },
): Promise<void> {
  if (!worktreePath) return; // worktree not created yet → no transcript to read
  try {
    const title = await invoke<string | null>("agent_session_title", { worktreePath });
    if (title && title.trim()) {
      useProjectStore.getState().applyAiTitle(projectId, agentId, title);
      // Record the Tier-1 free win ONLY when the apply actually landed. applyAiTitle no-ops if the
      // agent became pinned/self-named between the sidebar's candidate check and this async resolution
      // (~one poll interval), so re-read the store and confirm the title stuck before tallying — a
      // backfill candidate starts with no aiTitle, so `aiTitle === trimmed` proves it applied here.
      if (opts?.backfill && opts.kind) {
        const applied = useProjectStore
          .getState()
          .projects.find((p) => p.id === projectId)
          ?.agents.find((a) => a.id === agentId)?.aiTitle;
        if (applied === title.trim()) {
          reportNamingOutcome("named_from_session_title_backfill", opts.kind);
        }
      }
    }
  } catch (e) {
    // A transient FS/IPC error must not break the sidebar; the next poll retries.
    console.debug("session-title refresh skipped:", e);
  }
}
