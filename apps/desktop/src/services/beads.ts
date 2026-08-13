// apps/desktop/src/services/beads.ts
// Frontend read path for beads (bd) issues. Wraps the Rust `list_beads` / `bead_show`
// commands (which shell out to `bd list/show --json`), normalizes the tolerant/varying
// bd JSON shape into a stable `Bead`, and buckets issues into the board's four columns.
import { invoke } from "./ipc";

export type BeadStatus = "open" | "in_progress" | "closed";

export interface Bead {
  id: string;
  title: string;
  description: string;
  status: BeadStatus;
  type?: string;
  priority?: number;
  labels: string[];
  parent?: string | null;
  /**
   * ISO-8601 Z timestamps, straight from bd.
   *
   * These were always on the wire and were simply not read: `bd list --json` returns `created_at`,
   * `updated_at` and `started_at` on EVERY row, and the Rust side passes bd's stdout through
   * untouched (`notes.rs` `list_beads`) — `normalizeBead` below was the only thing dropping them.
   * The board's date-range filter is the first consumer.
   *
   * Optional because they are read tolerantly like every other field here: a bd version that
   * renames or omits them must degrade to "no date" rather than throw, and a filter that cannot
   * read a date must not silently hide the bead (see `withinDateRange`).
   */
  createdAt?: string;
  updatedAt?: string;
}

// bd's JSON is loosely typed and the key names vary by version (status vs state,
// issue_type vs type, etc.), so we read from an index signature and pick whichever
// key is present rather than trusting one schema.
type RawBead = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function normalizeStatus(v: unknown): BeadStatus {
  const s = asString(v)?.toLowerCase().trim();
  if (s === "in_progress" || s === "in-progress" || s === "inprogress") return "in_progress";
  if (s === "closed" || s === "done") return "closed";
  return "open";
}

function normalizeLabels(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** Normalize one loosely-typed bd row into a Bead. Tolerant of missing/renamed keys. */
function normalizeBead(raw: RawBead): Bead {
  const id = asString(raw.id) ?? asString(raw.issue_id) ?? "";
  const type = asString(raw.issue_type) ?? asString(raw.type);
  const priorityRaw = raw.priority;
  const priority = typeof priorityRaw === "number" ? priorityRaw : undefined;
  const parent = asString(raw.parent) ?? asString(raw.parent_id) ?? null;
  return {
    id,
    title: asString(raw.title) ?? "",
    description: asString(raw.description) ?? "",
    status: normalizeStatus(raw.status ?? raw.state),
    type,
    priority,
    labels: normalizeLabels(raw.labels),
    parent,
    // Both key spellings, same tolerance as every field above: bd emits snake_case today, and a
    // camelCase build must not silently produce a board where every date filter matches nothing.
    createdAt: asString(raw.created_at) ?? asString(raw.createdAt),
    updatedAt: asString(raw.updated_at) ?? asString(raw.updatedAt),
  };
}

function parseBeadArray(raw: string, command: string): Bead[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse ${command} JSON output: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${command} to return a JSON array, got: ${raw.slice(0, 200)}`);
  }
  return parsed.map((row) => normalizeBead((row ?? {}) as RawBead));
}

/** Run `bd list --json` for a project and return normalized beads. Throws on parse failure. */
export async function listBeads(projectPath: string): Promise<Bead[]> {
  const raw = await invoke<string>("list_beads", { projectPath });
  return parseBeadArray(raw, "list_beads");
}

/**
 * The ids of beads bd considers BLOCKED, or `null` when we could not ask.
 *
 * Blocked is DERIVED from dependency edges, not stored: `BeadStatus` is only
 * open | in_progress | closed, and this repo never writes a "blocked" status. The temptation is to
 * read it off `dependency_count`, which the list payload already carries — that is wrong in the
 * direction that matters, because a bead whose dependencies are all CLOSED has a non-zero count and
 * is perfectly ready. So the board asks bd the question bd can answer.
 *
 * ══ WHY A NULLABLE VARIANT EXISTS AT ALL ═══════════════════════════════════════════════════════
 * `blockedBeadIds` below collapses a failure to an empty set, which is the right default for a
 * one-shot read: a quiet Blocked lane beats a board that will not load. It is the WRONG default for
 * a CACHED reader — `beadsStore` now re-asks this question on a much slower cadence than the list
 * poll and reuses the previous answer in between, so it must be able to tell "bd says nothing is
 * blocked" from "we could not reach bd", or one transient failure would wipe a populated lane and
 * the board would keep showing it empty until the next slow-cadence window.
 *
 * NOTE the limit of this signal: the Rust side already degrades a missing/failing `bd blocked` to
 * an EMPTY LIST rather than an error, so `null` reports only the failures that reach us — the IPC
 * call rejecting, or output we cannot parse. It is a floor on detectable failure, not a complete
 * one. That is still strictly better than the collapse, and it is the only honest signal available
 * without changing the Rust command's contract.
 */
export async function blockedBeadIdsOrNull(projectPath: string): Promise<Set<string> | null> {
  try {
    const raw = await invoke<string>("blocked_beads", { projectPath });
    return new Set(parseBeadArray(raw, "blocked_beads").map((b) => b.id));
  } catch {
    return null;
  }
}

/**
 * The ids of beads bd considers BLOCKED — open, with at least one unmet blocker.
 *
 * Never throws: a failure degrades to an empty set (see `blockedBeadIdsOrNull` for the variant that
 * reports the failure, and for why the board needs it).
 */
export async function blockedBeadIds(projectPath: string): Promise<Set<string>> {
  return (await blockedBeadIdsOrNull(projectPath)) ?? new Set();
}

/** Ensure the project has a beads database, creating one (`bd init`) if none resolves yet.
 *  Idempotent and best-effort — the board calls this once, on the first read that fails with
 *  "no beads database found", so a brand-new project self-heals into an empty board instead of
 *  surfacing that raw error ("beads by default"). Returns the Rust status ("exists" |
 *  "initialized"); rejects only when `bd init` itself failed (e.g. `bd` not installed). */
export async function ensureBeadsDb(projectPath: string): Promise<string> {
  return invoke<string>("ensure_beads_db", { projectPath });
}

/** Run `bd show <id> --json` and return the single bead, or null if not found. */
export async function beadShow(projectPath: string, id: string): Promise<Bead | null> {
  const raw = await invoke<string>("bead_show", { projectPath, id });
  const beads = parseBeadArray(raw, "bead_show");
  return beads[0] ?? null;
}

// ── Programmatic write path ────────────────────────────────────────────────────────────────────
// Drive bead lifecycle from real app events (agent starts work / merges / ships / is discarded),
// replacing the LLM-advisory `bd` prose. Status uses bd's canonical verbs (claim/close/label);
// callers fire them best-effort (a bead write must never break the agent flow). All injection-safe.

/** True when a bd rejection is the EXPECTED "this project has no beads DB" case rather than a
 *  genuine failure. Beads are optional: a project that never ran `bd init` makes every bd write
 *  reject with "no beads database found", so callers use this to treat that as a normal, quiet
 *  state (skip/latch) instead of loud, recurring error noise. Match on the stable bd substring so
 *  real failures (bd crashed, bad output, permission errors) are NOT swallowed. Case-insensitive so
 *  a future casing tweak in bd's wording ("No beads database found") can't silently regress a
 *  caller back to noisy behavior — the substring itself is the documented stable contract. */
export function isBeadsUnavailable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.toLowerCase().includes("no beads database found");
}

/** Extract the created bead's id from `create_bead`'s raw bd `--json` (the issue object, or an
 *  `{"error":…}` blob). Returns null on a bd error or unparseable output. Pure (exported for tests). */
export function parseCreatedBeadId(raw: string): string | null {
  try {
    const obj = JSON.parse(raw) as RawBead;
    if (!obj || typeof obj !== "object" || "error" in obj) return null;
    return asString(obj.id) ?? asString(obj.issue_id) ?? null;
  } catch {
    return null;
  }
}

/** Create a bead for a deliverable agent and return its new id, or null if bd failed. `labels` is a
 *  comma-separated list; auto-created agent beads pass {@link AUTO_LABEL} so the board can tell them
 *  apart from human-filed backlog. */
export async function createBead(
  projectPath: string,
  title: string,
  body: string,
  labels?: string,
): Promise<string | null> {
  const raw = await invoke<string>("create_bead", { projectPath, title, body, labels });
  return parseCreatedBeadId(raw);
}

/** `bd update <id> --claim` — mark a bead in_progress (also assigns it). */
export async function claimBead(projectPath: string, id: string): Promise<void> {
  await invoke("bead_claim", { projectPath, id });
}

/** `bd close <id>` — mark a bead done. */
export async function closeBead(projectPath: string, id: string): Promise<void> {
  await invoke("bead_close", { projectPath, id });
}

/** `bd label add|remove <id> <label>` — e.g. the `delivered` label once shipped. */
export async function labelBead(
  projectPath: string,
  action: "add" | "remove",
  id: string,
  label: string,
): Promise<void> {
  await invoke("bead_label", { projectPath, action, id, label });
}

/** Mark a bead delivered: add the `delivered` label AND close it (so it lands in the delivered
 *  column — see columnFor). Both are ATTEMPTED independently (a closed bead must still get the
 *  label, and vice-versa); throws if either fails so a monotonic caller retries — both idempotent. */
export async function markBeadDelivered(projectPath: string, id: string): Promise<void> {
  const results = await Promise.allSettled([
    labelBead(projectPath, "add", id, DELIVERED_LABEL),
    closeBead(projectPath, id),
  ]);
  const failed = results.find((r) => r.status === "rejected");
  if (failed && failed.status === "rejected") throw failed.reason;
}

/** Permanently delete a bead — the close-agent Discard path. Wraps `bd delete --force`. */
export async function deleteBead(projectPath: string, id: string): Promise<void> {
  await invoke<string>("delete_bead", { projectPath, id });
}

/** Label prefix carrying the commit a bead's branch landed as (Task B). Stored as a label because
 *  bd has no first-class field for it, and labels round-trip through `list_beads` so the board can
 *  read the SHA back without an extra query. The value after the prefix is the full merge SHA. */
export const MERGED_SHA_PREFIX = "merged-sha:";

/** Record the commit a bead's branch landed as, so the delivery monitor can later test THAT exact
 *  commit for release containment. No-op when `sha` is blank (an older Rust build, or a land that
 *  couldn't resolve HEAD — honest: the bead simply stays not-yet-testable). Best-effort at the
 *  call site (like the other lifecycle writes); idempotent-enough (bd de-dupes identical labels). */
export async function recordBeadMergeSha(
  projectPath: string,
  id: string,
  sha: string | undefined | null,
): Promise<void> {
  const clean = sha?.trim();
  if (!clean) return;
  await labelBead(projectPath, "add", id, `${MERGED_SHA_PREFIX}${clean}`);
}

/** The merge commit recorded on a bead (see {@link recordBeadMergeSha}), or null when none is set —
 *  e.g. a bead shipped via PR (merged later on GitHub, uncapturable at ship time) or one landed by a
 *  Rust build predating the capture. Pure; reads the first `merged-sha:` label. */
export function mergeShaOf(bead: Bead): string | null {
  const label = bead.labels.find((l) => l.startsWith(MERGED_SHA_PREFIX));
  const sha = label?.slice(MERGED_SHA_PREFIX.length).trim();
  return sha && sha.length > 0 ? sha : null;
}

export type BoardColumn = "backlog" | "blocked" | "inProgress" | "done" | "delivered";

/** A closed bead carrying this label lands in "delivered" instead of "done". */
export const DELIVERED_LABEL = "delivered";

/** Stamped on every bead the APP creates for a Build agent, as opposed to one a human filed.
 *
 *  These are agent telemetry, not backlog: an un-renamed agent yields a bead titled "Build 7" with
 *  no description, and one is created per spawn AND per first-dirty-file. By 2026-07-29 they were
 *  299 of the 873 beads in this repo's DB (34%) and 74 of the 86 cards in "Being built" — the board
 *  was measuring app sessions rather than work. The back-fill labeled all 299 with this exact
 *  string, so the value is load-bearing for the board filter; do not rename it casually. */
export const AUTO_LABEL = "sparkle-auto";

/** Which board column a bead belongs in:
 *  open+blocked -> blocked; open -> backlog; in_progress -> inProgress;
 *  closed+delivered-label -> delivered; closed (no label) -> done.
 *
 *  BLOCKED OUTRANKS BACKLOG, and only for OPEN beads. A bead someone is actively working
 *  (in_progress) is not waiting on anything the user needs to see in a Blocked lane, and a closed
 *  bead cannot be blocked at all — so the check is deliberately not "is it in the set". */
export function columnFor(bead: Bead, blocked?: ReadonlySet<string>): BoardColumn {
  if (bead.status === "open") return blocked?.has(bead.id) ? "blocked" : "backlog";
  if (bead.status === "in_progress") return "inProgress";
  // closed
  return bead.labels.includes(DELIVERED_LABEL) ? "delivered" : "done";
}

export interface Board {
  backlog: Bead[];
  blocked: Bead[];
  inProgress: Bead[];
  done: Bead[];
  delivered: Bead[];
}

/** Group beads into board columns, preserving input order within each column.
 *
 *  Beads labeled {@link AUTO_LABEL} are DROPPED — they are app telemetry (one per Build-agent spawn
 *  and one per first-dirty-file, titled from the agent's throwaway display name), not work anyone
 *  filed. Filtered HERE rather than in the query so the underlying `listBeads` payload stays
 *  complete: the Beads list view and `childrenOf` still see them, only the BOARD hides them. */
export function bucketBeads(beads: Bead[], blocked?: ReadonlySet<string>): Board {
  const board: Board = { backlog: [], blocked: [], inProgress: [], done: [], delivered: [] };
  for (const bead of beads) {
    if (bead.labels.includes(AUTO_LABEL)) continue;
    switch (columnFor(bead, blocked)) {
      case "backlog":
        board.backlog.push(bead);
        break;
      case "blocked":
        board.blocked.push(bead);
        break;
      case "inProgress":
        board.inProgress.push(bead);
        break;
      case "done":
        board.done.push(bead);
        break;
      case "delivered":
        board.delivered.push(bead);
        break;
    }
  }
  return board;
}

/** Filter to an epic's children — either an explicit parent link or an id prefixed by
 *  the epic id (bd's hierarchical id convention, e.g. "sparkle-hiju.4"). The epic itself
 *  is excluded. */
export function childrenOf(beads: Bead[], epicId: string): Bead[] {
  const prefix = `${epicId}.`;
  return beads.filter((b) => b.id !== epicId && (b.parent === epicId || b.id.startsWith(prefix)));
}
