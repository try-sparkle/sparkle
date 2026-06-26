// Thin typed wrappers over the Rust `history_*` Tauri commands (see src-tauri/src/history.rs).
// The frontend owns identity + time: every entry carries a `crypto.randomUUID()` id and a
// `Date.now()` (epoch ms, UTC) createdAt, so Rust needs no uuid/time crate. Command names are
// snake_case matching the Rust fns; args are camelCase (serde renames on the Rust side).
import { invoke } from "@tauri-apps/api/core";

export type HistoryKind = "prompt" | "response";
export type HistorySource = "brainstorm" | "build";
export type RetentionTier = "24h" | "7d" | "30d" | "90d" | "1y" | "indefinite";

export interface HistoryEntry {
  id: string; // crypto.randomUUID()
  kind: HistoryKind;
  source: HistorySource;
  projectId: string | null;
  agentId: string | null;
  projectName: string | null;
  agentName: string | null;
  text: string;
  createdAt: number; // Date.now(), epoch ms UTC
}

export interface HistoryHit {
  id: string;
  kind: HistoryKind;
  source: HistorySource;
  projectId: string | null;
  agentId: string | null;
  projectName: string | null;
  agentName: string | null;
  snippet: string; // FTS5 snippet() with <b>..</b> match markers
  createdAt: number;
}

/** Persist one prompt/response entry. Idempotent on `id` (INSERT OR IGNORE in Rust). */
export async function recordHistory(e: HistoryEntry): Promise<void> {
  await invoke("history_record", { entry: e });
}

/** Full-text search across all live history. Blank query → []. Default limit 50 (Rust-side). */
export async function searchHistory(query: string, limit?: number): Promise<HistoryHit[]> {
  return await invoke<HistoryHit[]>("history_search", { query, limit });
}

/** Retention prune. `null` cutoff = indefinite → no-op (returns 0). Returns rows hard-deleted. */
export async function pruneHistory(cutoffMs: number | null): Promise<number> {
  return await invoke<number>("history_prune", { cutoffMs });
}
