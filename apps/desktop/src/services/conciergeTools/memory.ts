// The MEMORY domain — the concierge's durable, queryable, cross-session knowledge store
// (PRD/sparkle/concierge-durable-memory-design.md, PR #1877; bead `sparkle-jce9`).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS: the concierge forgets, and cannot recover the truth once it has.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Everything the concierge knows today lives in an in-memory bridge plus a bounded, TRUNCATING
// `localStorage` thread (4000 chars/message, 16 proactive turns). Anything past that window — an
// account's identity, a project's shape, a standing instruction, "this agent owns this PR" — is
// simply gone, and it cannot be searched, only scrolled. The Improve-Sparkle agent is reliable for
// the opposite reason: every fact it learns is written to a durable store it can re-read on demand.
// This domain gives the concierge the SAME primitive the Improve agent already uses — beads'
// built-in `bd remember` / `bd memories` / `bd forget` — rather than inventing a second store.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE STORE, AND WHY IT IS THE CONCIERGE'S OWN.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The app runs `bd` in a FIXED directory — the concierge's own app-data dir (see
// `concierge_memory_remember` in src-tauri/src/notes.rs). That matters twice over:
//
//   • RECALL FINDS WHAT REMEMBER WROTE. A per-turn/per-project store would mean a fact learned about
//     project A is unreachable while the turn concerns project B. One stable root is what makes the
//     memory durable across restart, truncation and window eviction — the whole ask.
//   • IT DOES NOT POLLUTE A USER PROJECT'S BOARD. The concierge's memory is its own beads DB, so
//     `remember` never files a row onto the Tasks board of a repo the human is managing.
//
// Because the store is dedicated, everything in it IS concierge memory — so `list`/`recall` return
// the whole store, and no key-prefix namespacing is needed. (`bd memories --json` also carries a
// `schema_version` bookkeeping key, which is NOT a memory and is filtered out below.)
//
// The concierge CANNOT run `bd` itself — its tool allowlist has no Bash (concierge.rs). So this
// handler runs on the APP side, which can, exactly like every other concierge tool domain, and
// bounds every `bd` invocation Rust-side (see notes.rs) so a wedged Dolt store cannot hang a turn.
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

// NOTE ON OP NAMES: every concierge op name must be GLOBALLY unique across domains — the policy
// layer keys `RISK_BY_TOOL`/`DOMAIN_BY_TOOL` by the bare op name, so a second domain reusing a name
// would silently overwrite the first's classification. `research` already owns the generic `list`
// and `get`, so this domain uses `list_memories` rather than a bare `list`.
export const MEMORY_OPS = ["remember", "recall", "forget", "list_memories"] as const;

export type MemoryOp = (typeof MEMORY_OPS)[number];

/** Two words, from the SAME vocabulary `workspace` publishes, so policy.ts reuses that translation
 *  rather than declaring a table identical to it. `remember`/`forget` are `routine` (a durable
 *  write the human never has to approve — the point of the feature is that it accumulates context
 *  on its own); `recall`/`list` are `read-only`. */
export type MemoryRisk = "read-only" | "routine";

export const MEMORY_RISK: Record<MemoryOp, MemoryRisk> = {
  remember: "routine",
  recall: "read-only",
  forget: "routine",
  list_memories: "read-only",
};

// ---------------------------------------------------------------------------------------------
// Results — the board/research convention
// ---------------------------------------------------------------------------------------------

export interface MemoryOk<T> {
  ok: true;
  op: MemoryOp;
  risk: MemoryRisk;
  data: T;
}

export interface MemoryRefusal {
  ok: false;
  op: MemoryOp;
  risk: MemoryRisk;
  reason: string;
  message: string;
}

export type MemoryResult<T> = MemoryOk<T> | MemoryRefusal;

function ok<T>(op: MemoryOp, data: T): MemoryOk<T> {
  return { ok: true, op, risk: MEMORY_RISK[op], data };
}

function refuse(op: MemoryOp, reason: string, message: string): MemoryRefusal {
  return { ok: false, op, risk: MEMORY_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

/** One remembered fact: the key it is filed under and its content. */
export interface MemoryEntry {
  key: string;
  value: string;
}

/** What `recall`/`list` answer with. `total` is reported separately from `memories.length` because
 *  the list is CAPPED (see {@link MAX_RECALL_MEMORIES}) — a cap that is not disclosed reads as "that
 *  is all of them", the truncation trap AGENTS.md names. */
export interface MemoryListView {
  memories: MemoryEntry[];
  total: number;
  /**
   * The keys of the facts the cap held back — NAMES ONLY, no values.
   *
   * A count alone ("17 more") tells the concierge that something is missing but not what, so the
   * only recovery is to guess search terms. The keys are slugs (tens of bytes each) while the values
   * are the expensive part (~0.7–1.7 KB each), so listing every withheld key costs almost nothing and
   * turns a silent, unreachable truncation into a disclosed, addressable one: every hidden fact is
   * one `recall <key>` away. Deliberately UNCAPPED — a cap on this list would reintroduce the exact
   * silent-cut defect it exists to close (bead `sparkle-h2a492`), and {@link MAX_RECALL_MEMORIES}
   * already bounds the only part of the reply that is actually large.
   */
  hiddenKeys: string[];
}

/** What `remember` answers with — the key it landed under, so the concierge can `forget` it later
 *  and can tell the human what it filed the fact as. */
export interface MemoryStoredView {
  key: string;
}

/** What `forget` answers with. */
export interface MemoryForgottenView {
  key: string;
}

/** The cap on how many entries a single `recall`/`list` reply carries. A tool reply that dumps
 *  hundreds of memories into a turn's context spends the concierge's budget on answers nobody asked
 *  a second time; the whole store is still reachable by a narrower `recall` query. */
export const MAX_RECALL_MEMORIES = 25;

/** The bookkeeping key `bd memories --json` includes that is NOT a memory. Filtered everywhere the
 *  raw map is turned into entries, in ONE place, so the two read paths cannot disagree. */
export const SCHEMA_VERSION_KEY = "schema_version";

// ---------------------------------------------------------------------------------------------
// Ranking — WHICH facts survive the cap
// ---------------------------------------------------------------------------------------------
//
// ══ WHAT THE STORE ACTUALLY CARRIES (measured, not assumed) ═════════════════════════════════════
//
// `bd memories --json` answers with a bare key→value JSON map and NOTHING else: no created/updated
// timestamp, no priority column, no ordering guarantee worth reading (bd emits the map sorted by key,
// so even the insertion order is gone by the time it reaches us). `bd memories --help` offers no flag
// that would add one, and the Rust side (`memory_recall_argv` in src-tauri/src/notes.rs) is a
// pass-through of that stdout. So there is NO true recency signal on this wire — if one is wanted,
// it has to be added to `bd` or recorded app-side at `remember` time, and neither is this module's.
//
// ══ WHY THE OLD ORDER WAS A BUG, NOT A DEFAULT ═════════════════════════════════════════════════
//
// The cap used to be `sort by key` then `slice(0, 25)`, which made a fact's VISIBILITY a function of
// its key's first letter — permanently, and with nothing reporting it. Measured against the live
// store: 17 of 42 memories never reached the prompt, one of them naming a P0 release blocker
// (`sparkle-h2a492`, `sparkle-b0ip2v`). Alphabetical is a fine TIEBREAK; as the primary rank it is a
// silent lottery on an attribute that has no relationship to whether the fact matters.
//
// ══ THE BEST ORDER THE AVAILABLE DATA SUPPORTS ═════════════════════════════════════════════════
//
// Three bands, richest signal first, key ascending WITHIN a band so the result stays deterministic:
//
//   1. FLAGGED — the key or the value carries an explicit, shouted importance marker
//      ({@link IMPORTANCE_MARKER}: `P0`, `BLOCKER`, `URGENT`, `IMPORTANT`, or a `pinned-` key). This
//      is the escape hatch the bead's own example needed; it is the one signal a writer controls
//      directly, so it outranks every inference.
//   2. STANDING — the fact carries no date anywhere. Undated memories in this store are the timeless
//      ones: founder preferences, "never do X", tool invariants. They do not go stale, and they are
//      the last thing re-grounding should drop.
//   3. EPISODIC — the fact carries an ISO date (in its key or its prose: `handoff-2026-06-24`,
//      "OUTDATED as of 2026-07-28"), which is what a status-of-a-branch note looks like. These ARE
//      recency-ordered, newest first, because a stale one is actively misleading. Measured: 55% of
//      the live store's entries carry such a date, so this is a real signal, not a hypothetical.
//
// Bands 2 and 3 are inferences from the text, and inferences can be wrong — which is exactly why
// `hiddenKeys` exists. Nothing this ranking demotes becomes unreachable; it only becomes un-preloaded.

/** An explicit, writer-controlled "this one matters" marker. Deliberately UPPERCASE-only and
 *  word-bounded so ordinary prose ("this is important to remember") does not promote itself — the
 *  signal has to be a shout to count as one. */
export const IMPORTANCE_MARKER = /\b(?:P0|BLOCKER|URGENT|IMPORTANT)\b/;

/** A key namespaced as deliberately pinned, the other half of {@link IMPORTANCE_MARKER}. */
export const PINNED_KEY_PREFIX = "pinned-";

/** An ISO `YYYY-MM-DD`. Zero-padded and range-checked so a version string or an id (`2026-1-2`,
 *  `1234-56-78`) is not mistaken for a date. Global — an entry can carry several, and the NEWEST is
 *  the one that describes how current it is. */
const ISO_DATE = /\b20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g;

/** True when the entry shouts that it matters. Exported so the rule is testable on its own. */
export function isFlaggedMemory(entry: MemoryEntry): boolean {
  return (
    entry.key.startsWith(PINNED_KEY_PREFIX) ||
    IMPORTANCE_MARKER.test(entry.key) ||
    IMPORTANCE_MARKER.test(entry.value)
  );
}

/** The newest ISO date the entry carries in its key or value, or `null` when it carries none (which
 *  is what makes it a STANDING fact rather than an old one). Lexicographic max is chronological max
 *  for zero-padded ISO dates. */
export function memoryDateHint(entry: MemoryEntry): string | null {
  const found = [...`${entry.key} ${entry.value}`.matchAll(ISO_DATE)].map((m) => m[0]);
  return found.length === 0 ? null : found.reduce((a, b) => (a >= b ? a : b));
}

/** An entry with its band and date resolved ONCE. Both signals cost a regex sweep of the whole value
 *  (~0.7–1.7 KB each), and a comparator is called O(n log n) times, so they are computed per ENTRY
 *  rather than per comparison — decorate-sort-undecorate, so a store that keeps growing does not
 *  quietly turn a re-ground into a few hundred kilobytes of rescanning. */
interface RankedMemory {
  entry: MemoryEntry;
  /** 0 = flagged, 1 = standing (undated), 2 = episodic (dated). Lower sorts first. */
  band: number;
  date: string | null;
}

function rankMemory(entry: MemoryEntry): RankedMemory {
  const date = memoryDateHint(entry);
  const band = isFlaggedMemory(entry) ? 0 : date === null ? 1 : 2;
  return { entry, band, date };
}

/** The total order the cap is applied to: band, then newest-date-first among dated entries, then key
 *  ascending so two otherwise-equal facts never swap places between runs. */
function compareRanked(a: RankedMemory, b: RankedMemory): number {
  if (a.band !== b.band) return a.band - b.band;
  if (a.date && b.date && a.date !== b.date) return b.date.localeCompare(a.date); // newest first
  return a.entry.key.localeCompare(b.entry.key);
}


/** Turn the raw `bd memories --json` map into ranked, capped entries. Pure, so the shaping is
 *  testable without invoking bd, and the `schema_version` filter has exactly one home.
 *
 *  The cut is by {@link compareRanked} — never by key alone — and everything it holds back is
 *  named in {@link MemoryListView.hiddenKeys}, so a capped reply can be read as what it is. */
export function shapeMemories(raw: Record<string, string>): MemoryListView {
  const entries = Object.entries(raw)
    .filter(([key]) => key !== SCHEMA_VERSION_KEY)
    .map(([key, value]) => rankMemory({ key, value }))
    .sort(compareRanked)
    .map((r) => r.entry);
  const memories = entries.slice(0, MAX_RECALL_MEMORIES);
  const hiddenKeys = entries.slice(MAX_RECALL_MEMORIES).map((e) => e.key);
  return { memories, total: entries.length, hiddenKeys };
}

// ---------------------------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------------------------

/**
 * Everything this module reaches outside itself, as ONE injectable object — the same shape
 * `research.ts` uses, and for the reason AGENTS.md's "defaulted seam" warning gives: the production
 * wiring (`LIVE_MEMORY_DEPS`) is itself exercised by a test that drives these handlers with the
 * default deps and `@tauri-apps/api/core`'s `invoke` mocked, rather than replaced by every case.
 *
 * `recall` and `list` share ONE dependency — both are `bd memories [query] --json`, with `list`
 * passing a null query — so there is a single place the parse-and-shape rule lives.
 */
export interface MemoryDeps {
  /** `bd remember --key <key> -- <value>`. Resolves when the write is acknowledged. */
  remember: (key: string, value: string) => Promise<void>;
  /** `bd memories [query] --json`, parsed into the raw key→value map. `null` lists everything. */
  recall: (query: string | null) => Promise<Record<string, string>>;
  /** `bd forget <key>`. */
  forget: (key: string) => Promise<void>;
}

export const LIVE_MEMORY_DEPS: MemoryDeps = {
  remember: (key, value) => invoke("concierge_memory_remember", { key, value }),
  recall: async (query) => {
    const raw = await invoke<string>("concierge_memory_recall", { query });
    return parseMemoryJson(raw);
  },
  forget: (key) => invoke("concierge_memory_forget", { key }),
};

/** Parse `bd memories --json` stdout into a key→value map, degrading a non-JSON or empty body to an
 *  empty map rather than throwing. bd emits `{}`-shaped JSON on success; anything else (an error
 *  sentence, an empty store printing nothing) means "no memories to read", which is a valid answer,
 *  not a failure. */
export function parseMemoryJson(raw: string): Record<string, string> {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------------------------
// The ops
// ---------------------------------------------------------------------------------------------

/** Store a durable fact under `key`. An empty key or value is refused rather than written — a
 *  memory with no content is noise the concierge would recall forever. */
export async function rememberMemory(
  key: string,
  value: string,
  deps: MemoryDeps = LIVE_MEMORY_DEPS,
): Promise<MemoryResult<MemoryStoredView>> {
  const k = key.trim();
  const v = value.trim();
  if (!k) {
    return refuse("remember", "empty-key", "I can't remember something with no key — give it a short label.");
  }
  if (!v) {
    return refuse("remember", "empty-value", "I can't remember an empty fact — tell me what to store.");
  }
  try {
    await deps.remember(k, v);
  } catch (e) {
    return refuse("remember", "remember-failed", `I couldn't save that to memory: ${errText(e)}`);
  }
  return ok("remember", { key: k });
}

/** Search memory. An empty query is treated as `list` (everything) rather than refused — "recall
 *  with nothing" is a reasonable "what do you know?", and the shape it returns is identical. */
export async function recallMemory(
  query: string,
  deps: MemoryDeps = LIVE_MEMORY_DEPS,
): Promise<MemoryResult<MemoryListView>> {
  const q = query.trim();
  let raw: Record<string, string>;
  try {
    raw = await deps.recall(q || null);
  } catch (e) {
    return refuse("recall", "recall-failed", `I couldn't read my memory: ${errText(e)}`);
  }
  return ok("recall", shapeMemories(raw));
}

/** Every memory, ranked by {@link compareRanked} and capped — with every withheld key named in
 *  `hiddenKeys`, so "list" reports the whole store even when it can only carry part of it. The
 *  `recall` path with a null query. */
export async function listMemories(
  deps: MemoryDeps = LIVE_MEMORY_DEPS,
): Promise<MemoryResult<MemoryListView>> {
  let raw: Record<string, string>;
  try {
    raw = await deps.recall(null);
  } catch (e) {
    return refuse("list_memories", "list-failed", `I couldn't read my memory: ${errText(e)}`);
  }
  return ok("list_memories", shapeMemories(raw));
}

/** Drop one memory by key. */
export async function forgetMemory(
  key: string,
  deps: MemoryDeps = LIVE_MEMORY_DEPS,
): Promise<MemoryResult<MemoryForgottenView>> {
  const k = key.trim();
  if (!k) {
    return refuse("forget", "empty-key", "I can't forget without a key — tell me which memory to drop.");
  }
  try {
    await deps.forget(k);
  } catch (e) {
    return refuse("forget", "forget-failed", `I couldn't drop that memory: ${errText(e)}`);
  }
  return ok("forget", { key: k });
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
