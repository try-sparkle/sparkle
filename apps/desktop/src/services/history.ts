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
 *
 * ── AND `dispatch` IS A THIRD ASSET CLASS — THE DELEGATION LEDGER (bead sparkle-dispatch-memory) ──
 * On 2026-08-22 the founder asked the concierge about making preview cards inline. It answered as
 * if it had never heard of the work and dispatched fresh research — EIGHT MINUTES after it had
 * itself spawned an agent to do exactly that. The brief was already in this table (`prompt`/`build`,
 * carrying the agent id, the name and the time) and would have been returned by a single FTS query.
 * It was gone because `build` rows are AGE-pruned at 24h.
 *
 * So a delegation gets its own source rather than riding the build tier. Three properties follow,
 * and each one is the reason a `build` row could not do the job:
 *   • AGE-EXEMPT. "Did we ever do that work?" is a question about last month, not about today.
 *   • ONE ROW PER SPAWN, not one per prompt, so the ledger is countable and the count cap below is
 *     measured in years rather than days (`DISPATCH_HISTORY_MAX`, src-tauri/src/history.rs).
 *   • IMMUTABLE AND FACT-ONLY. The row holds what was true AT DISPATCH — the ask, the time, the
 *     agent id — and nothing that can change afterwards. Status, the agent's CURRENT name and
 *     whether it is still running are DERIVED at read time (services/dispatchRecall.ts). That is
 *     deliberate: the bug class this feature exists to fix is state stamped once and never
 *     re-derived, and a ledger that stamped a status would be a fresh instance of it. Three agents
 *     have been observed simultaneously named "Worker 13", so even the NAME is re-derived; the
 *     `agent_name` column here is the name at dispatch and is a historical fact, not a handle.
 */
export type HistorySource = "brainstorm" | "build" | "concierge" | "dispatch";
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
  /**
   * The WHOLE row text — present only when the caller passed `includeText`, `null` otherwise.
   *
   * `?: string | null`, not `?: string`: this is a Rust `Option<String>`, and serde emits the key
   * with an explicit `null` for `None` rather than omitting it (AGENTS.md, bead sparkle-16y6h). A
   * `?: string` here would describe a payload the wire cannot produce, and an all-or-nothing parser
   * on the far side would then discard the whole hit.
   *
   * Off by default because the ordinary `search_history` caller renders SNIPPETS, and shipping full
   * texts for 50 hits would move megabytes across the IPC boundary to draw one line each. The
   * dispatch ledger is the caller that needs it: a snippet is 12 tokens around the match, which
   * cannot be relied on to contain the ASK.
   */
  text?: string | null;
}

/**
 * What one {@link recordHistory} call actually did — the return value that makes a NON-LANDING
 * write observable instead of silent.
 *
 * ── WHY THIS EXISTS (silent data loss, measured) ─────────────────────────────────────────────────
 * `id` is minted HERE, in the frontend, and the Rust side is `INSERT OR IGNORE` on a TEXT PRIMARY
 * KEY. It used to return nothing, so a second message arriving under an id that was already taken
 * was discarded with no error, no log and no return value anyone could inspect. Measured against
 * the founder's live DB: **199 of 200** on-screen concierge messages carried the same id as an
 * existing row but DIFFERENT text. The id scheme is fixed separately; `collided` is what makes the
 * drop impossible to miss if it ever recurs.
 *
 * Exactly three states are reachable — see `RecordOutcome` in `src-tauri/src/history.rs`:
 * - `{ inserted: true,  collided: false }` — the row was written.
 * - `{ inserted: false, collided: false }` — the id exists with BYTE-IDENTICAL text. Benign
 *   idempotent re-capture (a re-render, a rehydrate, a double subscribe). NOT an alarm.
 * - `{ inserted: false, collided: true }` — the id exists with DIFFERENT text. **DATA LOSS.**
 *
 * Both fields are plain Rust `bool`s, never `Option`, so serde always emits both keys with a
 * true/false value — which is why these are `boolean` and not `boolean | null`. (Were either to
 * become an `Option`, it would cross the wire as an EXPLICIT `null`, never as an absent key, and
 * the type here would have to become `boolean | null` — `boolean | undefined` excludes `null` and
 * would describe a payload the wire cannot produce. AGENTS.md, bead sparkle-16y6h.)
 */
export type RecordOutcome = { inserted: boolean; collided: boolean };

/** Neither written nor lost — the verdict that asserts nothing. Every unreadable payload lands here. */
const NEUTRAL_OUTCOME: RecordOutcome = { inserted: false, collided: false };

/**
 * Read a `history_record` reply defensively.
 *
 * ── THE ASYMMETRY THIS ENCODES ───────────────────────────────────────────────────────────────────
 * `collided: true` is an ALARM meaning "we threw away something the founder said". A parser that
 * can raise it on a payload it merely failed to understand — an older backend that still returns
 * `null`, a shape nobody anticipated — spends the alarm's entire credibility on noise, and the one
 * signal that is supposed to mean data loss stops meaning anything. So every unreadable input
 * resolves to {@link NEUTRAL_OUTCOME}, and only an explicit `true` on a well-formed reply sets a
 * flag. It never throws: capture is fire-and-forget, and a parse error must not break a chat turn.
 *
 * Exported for the seam test (`history.recordOutcome.test.ts`), which parses the SAME fixture the
 * Rust suite does — `apps/desktop/shared/history-record-outcome.fixture.json`.
 */
export function parseRecordOutcome(raw: unknown): RecordOutcome {
  if (raw === null || raw === undefined || typeof raw !== "object") return { ...NEUTRAL_OUTCOME };
  const o = raw as Record<string, unknown>;
  // BOTH keys must be present AND actually boolean. Neither is an `Option` on the Rust side, so
  // serde emits both on every reply — a payload missing one, or carrying `null` / `"true"` / `1`
  // for one, is a shape this contract does not describe, and a verdict is not something to salvage
  // out of half a message. (`=== "boolean"` rather than truthiness is the same rule: `null` is what
  // an Option would put on the wire, and it is NOT `false`.)
  if (typeof o.inserted !== "boolean" || typeof o.collided !== "boolean") {
    return { ...NEUTRAL_OUTCOME };
  }
  // `inserted && collided` is UNREPRESENTABLE on the Rust side, so seeing it means the reply is not
  // one this contract describes either. Fall to the non-alarm verdict rather than reporting a loss
  // the backend never claimed.
  if (o.inserted && o.collided) return { ...NEUTRAL_OUTCOME };
  return { inserted: o.inserted, collided: o.collided };
}

/**
 * Persist one prompt/response entry. Idempotent on `id` — but the result now SAYS which kind of
 * idempotent it was, so a same-id/different-text discard is no longer silent. See
 * {@link RecordOutcome}.
 *
 * Rejects only if the invoke itself fails; a reply it cannot read yields the neutral outcome.
 */
export async function recordHistory(e: HistoryEntry): Promise<RecordOutcome> {
  return parseRecordOutcome(await invoke("history_record", { entry: e }));
}

/** Narrowings for {@link searchHistory}. Both are OPTIONAL and both default to today's behaviour,
 *  so every existing call site is unchanged. */
export interface HistorySearchOpts {
  /**
   * Restrict the search to these sources. Omitted (or empty) searches everything, as before.
   *
   * This is applied IN SQL, not after the fact, and that is the whole point: the `LIMIT` is applied
   * by SQLite before any result reaches the frontend, so a post-hoc `.filter(h => h.source === …)`
   * would silently return nothing whenever 50 louder rows of another source outranked the ones the
   * caller asked for. The dispatch ledger is exactly that case — a few thousand delegation rows
   * living alongside hundreds of thousands of build and concierge rows.
   */
  sources?: HistorySource[];
  /** Also return each hit's WHOLE text in {@link HistoryHit.text}. See that field for the cost. */
  includeText?: boolean;
}

/** Full-text search across live history. Blank query → []. Default limit 50 (Rust-side). */
export async function searchHistory(
  query: string,
  limit?: number,
  opts?: HistorySearchOpts,
): Promise<HistoryHit[]> {
  return await invoke<HistoryHit[]>("history_search", {
    query,
    limit,
    sources: opts?.sources,
    includeText: opts?.includeText,
  });
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
