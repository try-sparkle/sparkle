// Thin typed wrappers over the Rust `history_*` Tauri commands (see src-tauri/src/history.rs).
// The frontend owns identity + time: every entry carries a `crypto.randomUUID()` id and a
// `Date.now()` (epoch ms, UTC) createdAt, so Rust needs no uuid/time crate. Command names are
// snake_case matching the Rust fns; args are camelCase (serde renames on the Rust side).
import { invoke } from "@tauri-apps/api/core";

export type HistoryKind = "prompt" | "response";
/**
 * Which conversation an entry came from.
 *
 * ── WHY `concierge` IS HERE (bead sparkle-yd1ud) ────────────────────────────────────────────────
 * For most of this type's life it was `brainstorm | build`, and the only caller of `recordHistory`
 * was `AgentPane`'s hook-driven capture. So `search_history` — the tool the concierge reaches for
 * when the founder asks "what happened to X" — could only ever answer *did an agent ever ACT on
 * this*, never *did he ever ASK for it*. When he asked about four previously-requested things on
 * 2026-08-09, two of them had no agent and therefore no trace, and the concierge had no way to look
 * up its own conversation to find out whether the request had ever been made.
 *
 * Nothing in the storage layer resisted this: `src-tauri/src/history.rs` takes `source` as a plain
 * `TEXT` column supplied by the frontend and never interprets it, so the store was source-agnostic
 * the whole time and only this union and the capture call sites were narrow.
 */
export type HistorySource = "brainstorm" | "build" | "concierge";
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
