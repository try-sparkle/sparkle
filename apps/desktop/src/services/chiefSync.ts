// chiefSync — push the current markdown state from a project's worktree into the matching
// Chief project's library, so the Think agent stays current. The Rust `markdown_changed_since`
// command (invoked with an empty sinceSha) returns the full current tree; this uploads each path
// as a named asset (keyed by path, not commit sha), replacing content only when it changes.
//
// `syncProjectMarkdown` is pure glue over invoke + the chief client (unit-tested). The
// store-reading wrapper that fires it from the branch-status poll lives in runtimeStore.
import { invoke } from "@tauri-apps/api/core";
import {
  ensureChiefProject,
  uploadAsset,
  deleteAsset,
  listAllAssets,
  assetLooksStuck,
  STUCK_RESERVATION_MIN_AGE_MS,
} from "./chief";
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

  // Library health check: a ledger hash match normally skips a path, but that trusts that the
  // recorded asset actually holds bytes. A failed run can leave a 1-byte reservation whose md5
  // the server then "dedups" against forever (see assetLooksStuck) — the ledger says synced while
  // Chief has nothing. So verify against the live library and re-upload paths whose asset is
  // stuck. Listing is best-effort: when it fails, fall back to hash-only skipping.
  let stuckIds: Set<string> | null = null;
  let sweepableIds: string[] = [];
  try {
    const assets = await listAllAssets(pat, pid);
    const stuck = assets.filter(assetLooksStuck);
    stuckIds = new Set(stuck.map((a) => a.asset_id));
    const cutoff = Date.now() - STUCK_RESERVATION_MIN_AGE_MS;
    sweepableIds = stuck
      .filter((a) => a.created_at && Date.parse(a.created_at) < cutoff)
      .map((a) => a.asset_id);
  } catch {
    stuckIds = null;
  }

  const next: Record<string, ChiefDocState> = {};
  const uploaded: string[] = [];
  const deletedAssetIds: string[] = [];
  const currentPaths = new Set<string>();

  for (const f of change.files) {
    currentPaths.add(f.path);
    const hash = hashContent(f.content);
    const prev = docState[f.path];
    const prevStuck = prev?.assetId ? stuckIds?.has(prev.assetId) === true : false;
    if (prev && prev.hash === hash && !prevStuck) {
      next[f.path] = prev; // unchanged and verifiably (or presumably) live — keep the asset
      continue;
    }
    // Upload first so retrieval always has a live copy, THEN delete the superseded asset.
    const { assetId } = await uploadAsset(pat, pid, f.path, f.content);
    if (prev && prev.assetId && prev.assetId !== assetId) {
      try {
        await deleteAsset(pat, pid, prev.assetId);
        deletedAssetIds.push(prev.assetId);
      } catch {
        // Best-effort: upload recovery may already have deleted it (a stuck md5 match), or
        // another agent got there first. Leftovers are caught by the sweep below on a later run.
      }
    }
    next[f.path] = { hash, assetId };
    uploaded.push(f.path);
  }

  // Docs that vanished from the tree: drop their assets so Chief reflects current state.
  // Best-effort — the asset may already be gone (another agent's sweep, or a prior run that
  // crashed between the DELETE landing and docState persisting). Throwing would wedge the
  // sync forever on the same 404: the entry is dropped from `next` either way, so a live
  // leftover is caught by a later sweep once it looks stuck, or lingers harmlessly if real.
  for (const [path, st] of Object.entries(docState)) {
    if (!currentPaths.has(path) && st.assetId) {
      try {
        await deleteAsset(pat, pid, st.assetId);
        deletedAssetIds.push(st.assetId);
      } catch {
        // already deleted or contested — never re-throw on a doc we're dropping anyway
      }
    }
  }

  // Sweep junk reservations left by earlier failed runs (each failed upload strands one per
  // content version). Skip anything the fresh ledger references and anything already deleted.
  const referenced = new Set(Object.values(next).map((st) => st.assetId));
  for (const assetId of sweepableIds) {
    if (referenced.has(assetId) || deletedAssetIds.includes(assetId)) continue;
    try {
      await deleteAsset(pat, pid, assetId);
      deletedAssetIds.push(assetId);
    } catch {
      // Best-effort: an already-deleted or contested asset shouldn't fail the sync.
    }
  }

  return { chiefProjectId: pid, docState: next, uploaded, deletedAssetIds };
}
