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

/** Read the agent's Claude Code session title and apply it (no-op until a title exists). */
export async function refreshAgentTitle(
  projectId: string,
  agentId: string,
  worktreePath: string | null,
): Promise<void> {
  if (!worktreePath) return; // worktree not created yet → no transcript to read
  try {
    const title = await invoke<string | null>("agent_session_title", { worktreePath });
    if (title && title.trim()) {
      useProjectStore.getState().applyAiTitle(projectId, agentId, title);
    }
  } catch (e) {
    // A transient FS/IPC error must not break the sidebar; the next poll retries.
    console.debug("session-title refresh skipped:", e);
  }
}
