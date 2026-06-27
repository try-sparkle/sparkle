// chiefSync — push the current markdown state from a project's worktree into the matching
// Chief project's library, so the Think agent stays current. The Rust `markdown_changed_since`
// command (invoked with an empty sinceSha) returns the full current tree; this uploads each path
// as a named asset (keyed by path, not commit sha), replacing content only when it changes.
//
// `syncProjectMarkdown` is pure glue over invoke + the chief client (unit-tested). The
// store-reading wrapper that fires it from the branch-status poll lives in runtimeStore.
import { invoke } from "@tauri-apps/api/core";
import { ensureChiefProject, uploadAsset, deleteAsset } from "./chief";
import type { ChiefDocState } from "../stores/settingsStore";

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

/** Fast, non-cryptographic content fingerprint (FNV-1a, 32-bit) for change detection. A hash
 *  collision would at worst skip one update; the next real change re-syncs. */
export function hashContent(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface ProjectSyncParams {
  pat: string;
  sparkleProjectId: string;
  projectName: string;
  /** An agent whose worktree we read the current markdown from. */
  agentId: string;
  chiefProjectId?: string;
  /** Current per-path ledger for this Chief project (path -> {hash, assetId}). */
  docState: Record<string, ChiefDocState>;
}

export interface ProjectSyncResult {
  chiefProjectId: string;
  /** The complete desired ledger after this run (current paths only) — persist it wholesale. */
  docState: Record<string, ChiefDocState>;
  uploaded: string[];
  deletedAssetIds: string[];
}

/**
 * Sync a project's CURRENT markdown into its Chief library: one asset per path, named by path,
 * replaced only when content changes, with stale/removed docs deleted. A partial failure throws and
 * leaves the ledger un-persisted; note that deletes are committed eagerly to Chief mid-loop, so a
 * failed run is NOT a clean rollback — the next run reconciles rather than retries from scratch.
 * Returns null with no PAT. Asset identity is keyed by (Chief project, path), so multiple agents
 * converge on one asset.
 */
export async function syncProjectMarkdown(params: ProjectSyncParams): Promise<ProjectSyncResult | null> {
  const { pat, sparkleProjectId, projectName, agentId, chiefProjectId, docState } = params;
  if (!pat) return null;

  const change = await invoke<MarkdownSince>("markdown_changed_since", {
    projectId: sparkleProjectId,
    agentId,
    sinceSha: "", // empty marker → full current tree under the synced dirs
    dirs: MARKDOWN_DIRS,
  });

  // Nothing to upload and nothing tracked to clean up: don't even ensure a project.
  if (change.files.length === 0 && Object.keys(docState).length === 0) {
    return { chiefProjectId: chiefProjectId ?? "", docState: {}, uploaded: [], deletedAssetIds: [] };
  }

  const pid = await ensureChiefProject(pat, projectName, chiefProjectId);
  const next: Record<string, ChiefDocState> = {};
  const uploaded: string[] = [];
  const deletedAssetIds: string[] = [];
  const currentPaths = new Set<string>();

  for (const f of change.files) {
    currentPaths.add(f.path);
    const hash = hashContent(f.content);
    const prev = docState[f.path];
    if (prev && prev.hash === hash) {
      next[f.path] = prev; // unchanged — keep the existing asset
      continue;
    }
    // Upload first so retrieval always has a live copy, THEN delete the superseded asset.
    const { assetId } = await uploadAsset(pat, pid, f.path, f.content);
    if (prev && prev.assetId && prev.assetId !== assetId) {
      await deleteAsset(pat, pid, prev.assetId);
      deletedAssetIds.push(prev.assetId);
    }
    next[f.path] = { hash, assetId };
    uploaded.push(f.path);
  }

  // Docs that vanished from the tree: drop their assets so Chief reflects current state.
  for (const [path, st] of Object.entries(docState)) {
    if (!currentPaths.has(path) && st.assetId) {
      await deleteAsset(pat, pid, st.assetId);
      deletedAssetIds.push(st.assetId);
    }
  }

  return { chiefProjectId: pid, docState: next, uploaded, deletedAssetIds };
}
