// chiefSync — push the markdown a Build agent commits into the matching Chief project's
// library, so the Brainstorm agent (which chats over that library) stays current with what
// the Build agents produce. The Rust `markdown_changed_since` command finds the files; this
// uploads each as a per-commit asset (named with the commit short-sha) via the Chief client.
//
// `syncAgentMarkdown` is pure glue over invoke + the chief client (unit-tested). The
// store-reading wrapper that fires it from the branch-status poll lives in runtimeStore.
import { invoke } from "@tauri-apps/api/core";
import { ensureChiefProject, uploadAsset } from "./chief";

/** Directory pathspecs synced to Chief. Scoped (not "all markdown") to avoid uploading
 *  READMEs/vendored docs; the Rust side filters these dirs down to `.md` files. */
export const MARKDOWN_DIRS = ["PRD", "docs/superpowers/specs"];

interface MarkdownChange {
  path: string;
  content: string;
}
interface MarkdownSince {
  headSha: string;
  files: MarkdownChange[];
}

export interface SyncResult {
  /** The worktree HEAD just synced — store this as the agent's next sync marker. */
  headSha: string;
  /** Asset names uploaded this run (empty when nothing changed). */
  uploaded: string[];
  /** The Chief project the assets landed in (created here if it didn't exist). */
  chiefProjectId: string;
}

export interface SyncParams {
  pat: string;
  projectId: string;
  projectName: string;
  agentId: string;
  /** Chief project already linked to this Sparkle project, if any. */
  chiefProjectId?: string;
  /** Last commit synced for this agent, if any. */
  sinceSha?: string;
}

/**
 * Sync one agent's newly-committed markdown to its Chief project. Returns the advanced marker
 * and what was uploaded, or `null` when there's no PAT (nothing to do). Best-effort by design:
 * callers swallow throws and retry on the next poll, leaving the marker un-advanced so the same
 * range is reattempted.
 */
export async function syncAgentMarkdown(params: SyncParams): Promise<SyncResult | null> {
  const { pat, projectId, projectName, agentId, chiefProjectId, sinceSha } = params;
  if (!pat) return null;

  const change = await invoke<MarkdownSince>("markdown_changed_since", {
    projectId,
    agentId,
    sinceSha: sinceSha ?? "",
    dirs: MARKDOWN_DIRS,
  });

  // Nothing changed: advance the marker to HEAD (so we don't re-diff this range) without
  // creating a Chief project for an agent that hasn't produced any docs yet.
  if (change.files.length === 0) {
    return { headSha: change.headSha, uploaded: [], chiefProjectId: chiefProjectId ?? "" };
  }

  // There ARE docs to upload — ensure the project exists (creating it if a Build agent
  // committed before the Brainstorm panel was ever opened).
  const pid = await ensureChiefProject(pat, projectName, chiefProjectId);
  const short = change.headSha.slice(0, 7);
  const uploaded: string[] = [];
  for (const f of change.files) {
    const name = `${f.path} @ ${short}`;
    await uploadAsset(pat, pid, name, f.content);
    uploaded.push(name);
  }
  return { headSha: change.headSha, uploaded, chiefProjectId: pid };
}
