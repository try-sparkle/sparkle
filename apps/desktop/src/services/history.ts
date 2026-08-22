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
 *
 * ── IT IS A PERSISTED ENUM, AND `concierge` AGES DIFFERENTLY (bead sparkle-s7rfc) ────────────────
 * Not a free-floating union: rows written by a new build are read by an old one and vice versa, so
 * members are only ever ADDED (see PRD/sparkle/remove-think-tab.md for the hazard, using the
 * now-vestigial `brainstorm` as its worked example).
 *
 * And `concierge` is a different ASSET CLASS from the other two, not merely a different label: what
 * you said to your minder is small and irreplaceable, where a build log is large and regenerable. So
 * concierge rows are exempt from the AGE prune and bounded by COUNT instead — implemented in
 * `prune_in_with_max` (src-tauri/src/history.rs), whose two age statements both carry
 * `AND source <> 'concierge'` and which then applies `CONCIERGE_HISTORY_MAX` via
 * `prune_concierge_count_in`. Pinned by
 * `prune_keeps_concierge_and_deletes_a_build_row_of_the_same_age`.
 *
 * NOTE for anyone adding a member here: `source` has no CHECK constraint, so a typo'd literal does
 * not fail — it silently falls into the build-tier ageing above, and the row quietly disappears at
 * 24h. The SQL matches this exact string.
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

/** Retention prune. Returns rows hard-deleted.
 *
 *  `null` cutoff = indefinite, which skips the AGE bound — NOT the whole call. The concierge
 *  row-count cap always runs (`prune_in_with_max`, src-tauri/src/history.rs), so `null` can still
 *  return a non-zero count. It was a true no-op before concierge rows became age-exempt. */
export async function pruneHistory(cutoffMs: number | null): Promise<number> {
  return await invoke<number>("history_prune", { cutoffMs });
}

// ── THE THREAD SCRUBBER RAIL'S TWO TIME-INDEXED READS (bead `sparkle-7m719`) ──────────────────────
//
// The rail is a ZOOM over a time axis, not a filter over the visible thread, so it needs history by
// TIME rather than by relevance — `searchHistory` above cannot answer it at any scope. Both of these
// go through the `idx_entries_created` index that has existed since the store was built.
//
// EVERY FIELD BELOW IS NON-OPTIONAL, and that is a deliberate property of the seam rather than a
// happy accident. A Rust `Option` crosses the wire as an explicit `null` (serde's derive emits the
// key), which `field?: T` does not include — a hand-written TS type in that shape describes a
// payload the wire cannot produce, and an all-or-nothing parser then throws the WHOLE response away
// and the feature is silently inert forever. The Rust structs (`PromptMarker` / `RangeRow` in
// src-tauri/src/history.rs) carry no `Option` at all, so there is no null for the two halves to
// disagree about. Keep it that way: if one of these ever needs an absent value, write `T | null`
// here, never `?: T`.

/** One dot on the rail: a prompt, its instant, and enough text for the hover card. */
export interface PromptMarkerRow {
  /** The id the frontend minted for this row. For `source: "concierge"` it IS the concierge message
   *  id — `conciergeHistoryCapture` writes `m.id` straight through — which is what lets the rail
   *  hand an id back to the thread and have it scroll to that exact bubble. */
  id: string;
  createdAt: number; // epoch ms
  /** First 160 chars of the prompt, truncated in SQL. A 1y rail over the founder's measured volume
   *  would otherwise move tens of MB to draw tooltips nobody hovers. */
  textPrefix: string;
}

/** A full history row inside a window — what the thread pages IN behind the live 200-message cap. */
export interface HistoryRangeRow {
  id: string;
  kind: HistoryKind;
  createdAt: number;
  /** WHOLE text, unlike {@link PromptMarkerRow.textPrefix}: these become rendered bubbles, and a
   *  prefix would be a truncated message presented as the whole thing. */
  text: string;
}

/**
 * Dots for the rail: prompts of one source inside `[fromMs, toMs]`, OLDEST-FIRST.
 *
 * `limit` caps the dots (Rust default 4,000) and drops from the OLDEST end, never the newest — a
 * capped rail showing last January and nothing since would read as broken rather than as capped.
 */
export async function promptsInRange(
  fromMs: number,
  toMs: number,
  source: HistorySource,
  limit?: number,
): Promise<PromptMarkerRow[]> {
  return await invoke<PromptMarkerRow[]>("history_prompts_in_range", {
    fromMs,
    toMs,
    source,
    limit,
  });
}

/**
 * A backlog page: every live row of one source inside `[fromMs, toMs]`, OLDEST-FIRST, both kinds.
 *
 * Both kinds on purpose — a paged-in window showing only the questions would be half a
 * conversation. Same oldest-end capping as {@link promptsInRange} (Rust default 400, ~20x the live
 * thread's `CONCIERGE_THREAD_MAX`).
 */
export async function entriesInRange(
  fromMs: number,
  toMs: number,
  source: HistorySource,
  limit?: number,
): Promise<HistoryRangeRow[]> {
  return await invoke<HistoryRangeRow[]>("history_entries_in_range", {
    fromMs,
    toMs,
    source,
    limit,
  });
}

// ── THE RAIL'S TWO AGGREGATE READS (bead `sparkle-bjbhw6`, defects 3 and 7) ──────────────────────
//
// Both answer a question about the WHOLE store without moving the store's rows, which is the
// founder's own constraint on this feature: *"draw the rail from an aggregate query (counts
// bucketed by time), and page entries in as the viewport needs them. Do not load every row into the
// renderer to draw the rail — at the current rate this table reaches ~1 GB/year and he wants all of
// it kept."*
//
// `HistoryExtent` IS THE ONE PLACE IN THIS FILE WITH NULLS, and they are `T | null` rather than
// `?: T` for the reason AGENTS.md records (bead sparkle-16y6h): a Rust `Option` crosses the wire as
// an EXPLICIT `null`, never as an absent key, and TypeScript's `field?: T` means `T | undefined`,
// which EXCLUDES null. A hand-written type in that shape describes a payload the wire cannot
// produce. `historyExtentEmpty` in `shared/history-range-wire.json` is the fixture both suites parse
// so the two halves fail together rather than one of them silently going inert.

/** The true extent of stored prompts for one source. Both bounds are null iff `count` is 0. */
export interface HistoryExtent {
  /** `MIN(created_at)`, epoch ms — what the scope menu prints as "All — since Aug 12". */
  oldestMs: number | null;
  /** `MAX(created_at)`, epoch ms. Null under exactly the same condition as `oldestMs`. */
  newestMs: number | null;
  /** How many live prompt rows exist for the source. */
  count: number;
}

/**
 * One band of the rail, counted rather than fetched.
 *
 * `count` is the TRUE number of prompts in the band — no limit, no sampling — which is what lets the
 * rail vary its mark instead of lying by omission. Empty bands are NOT returned, so the array is
 * sparse and strictly ascending by `index`; the renderer places by `index`, and zero-filling a
 * 2,000-band year would pay for thousands of empty rows to draw nothing.
 */
export interface PromptBucket {
  /** Band ordinal on the axis. 0 is the OLDEST band. */
  index: number;
  /** Inclusive start of the band on the axis. */
  startMs: number;
  /** End of the band: exclusive, except the LAST band which ends on `toMs` itself. */
  endMs: number;
  /** How many live prompts fell in this band. Always >= 1. */
  count: number;
  /** `MIN(created_at)` of the band's rows — where the data actually starts inside the band. */
  firstAtMs: number;
  /** `MAX(created_at)` of the band's rows. */
  newestAtMs: number;
  /** The id of the row at `newestAtMs` — what a pick on this band commits. Ties on `createdAt`
   *  break toward the row inserted last; see `PromptBucket` in src-tauri/src/history.rs. */
  newestId: string;
  /** First 160 chars of that same row's text, truncated in SQL. */
  newestTextPrefix: string;
}

/** `MIN`/`MAX`/`COUNT` over one source's live prompts. One indexed scan; moves no text. */
export async function historyExtent(source: HistorySource): Promise<HistoryExtent> {
  return await invoke<HistoryExtent>("history_extent", { source });
}

/**
 * Prompts of one source bucketed into `buckets` equal bands across `[fromMs, toMs]`, oldest band
 * first, EMPTY BANDS OMITTED.
 *
 * `buckets` is clamped Rust-side to `[1, 4096]`, so 0 is one band rather than a division by zero.
 */
export async function promptDensity(
  fromMs: number,
  toMs: number,
  source: HistorySource,
  buckets: number,
): Promise<PromptBucket[]> {
  return await invoke<PromptBucket[]>("history_prompt_density", {
    fromMs,
    toMs,
    source,
    buckets,
  });
}
