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

/** Turn the raw `bd memories --json` map into sorted, capped entries. Pure, so the shaping is
 *  testable without invoking bd, and the `schema_version` filter has exactly one home. */
export function shapeMemories(raw: Record<string, string>): MemoryListView {
  const entries = Object.entries(raw)
    .filter(([key]) => key !== SCHEMA_VERSION_KEY)
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { memories: entries.slice(0, MAX_RECALL_MEMORIES), total: entries.length };
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

/** Every memory, newest-key-first-agnostic (sorted by key). The `recall` path with a null query. */
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
