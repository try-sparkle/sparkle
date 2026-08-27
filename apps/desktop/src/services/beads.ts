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
  /**
   * How many comments bd has recorded on this bead. `0` when bd does not say.
   *
   * Also always on the wire and simply dropped: `bd list --all --limit 0 --json` — the ONE bulk
   * call the board already makes every poll — emits `comment_count` per row, and the Rust side
   * already parses it (`beads_cmd.rs` `BeadSummary::comment_count`). Carrying it costs nothing:
   * a per-bead `bd show` is ~0.9s and a cold `bd list` can be 45s under fleet load, so anything
   * that wants "did this bead gain a comment" as a cheap trigger has to read it from here.
   *
   * OPTIONAL, and that is a deliberate reversal of the first cut. Making it required is the more
   * precise model — a comment count has a meaningful zero, so "bd omitted it" and "no comments" are
   * the same fact — but `Bead` is CONSTRUCTED BY HAND in dozens of test fixtures across the tree,
   * and a required field forces every one of them to be edited. That cost is not one-time: it lands
   * on every branch in flight and every branch opened afterwards. It was measured within hours —
   * ~30 fixtures touched, a shared-file overlap against five unrelated open PRs, and then a CI
   * typecheck failure caused entirely by four NEW fixtures that landed on the default branch while
   * this work was in review, none of which had any reason to know about this field.
   *
   * `normalizeBead` always populates it, so every bead that came from `bd` carries a real number;
   * only hand-built fixtures can omit it, and for them `0` is the correct reading. Readers use
   * `?? 0` — one line at the single consumer, against an edit in every fixture forever.
   */
  commentCount?: number;
}

// bd's JSON is loosely typed and the key names vary by version (status vs state,
// issue_type vs type, etc.), so we read from an index signature and pick whichever
// key is present rather than trusting one schema.
type RawBead = Record<string, unknown>;

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
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

/** Normalize one loosely-typed bd row into a Bead. Tolerant of missing/renamed keys.
 *
 *  Exported for `scripts/bench/board-perf.mts`, which replays the board's real resolution cost over
 *  a real `bd list --json` dump. The point of that bench is that it measures THIS file rather than a
 *  re-implementation of it, so it has to normalize rows the way the app does — a hand-rolled
 *  equivalent in the script would drift and quietly stop measuring the shipped path. */
export function normalizeBead(raw: RawBead): Bead {
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
    // Both key spellings for the same reason as the timestamps above. `0` for missing OR
    // non-numeric: bd's own value is an integer, and a string "3" from some other producer is a
    // shape we did not agree to read, not a number to coerce.
    commentCount: asNumber(raw.comment_count) ?? asNumber(raw.commentCount) ?? 0,
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
 *  apart from human-filed backlog.
 *
 *  `priority` (bd's 0-4, 0 = highest) is OPTIONAL, so every existing caller is unaffected. It exists
 *  because priority could not be set at FILING time from anywhere in the app — a triage rubric had
 *  nothing to write through, and every bead the app files landed at bd's default.
 *
 *  Typed `number | null | undefined` rather than `number?`: the Rust side takes an `Option<i64>`,
 *  and a Rust `Option` crosses this wire as an explicit `null`, never as an absent key. A signature
 *  that admits only `undefined` describes a shape the bridge does not produce — which is how an
 *  all-or-nothing parser ends up discarding a whole payload silently.
 *
 *  NOTE the id this returns can be an EXISTING bead's. The Rust create path folds a create it is
 *  confident duplicates an open bead (see `src-tauri/src/bead_dup.rs`) and hands back that bead's
 *  row, which is the same JSON shape `bd create` emits. Callers that bind the id to something — an
 *  agent, a plan child — are exactly the ones the fold's skip list refuses to touch. */
export async function createBead(
  projectPath: string,
  title: string,
  body: string,
  labels?: string,
  priority?: number | null,
): Promise<string | null> {
  const raw = await invoke<string>("create_bead", {
    projectPath,
    title,
    body,
    labels,
    priority: priority ?? null,
  });
  return parseCreatedBeadId(raw);
}

/** `bd update <id> -p <0-4>` — set a bead's priority (0 = highest). The other half of the priority
 *  seam: filing can set one now, and this changes it afterwards. Rejected on the Rust side when out
 *  of range, so an invalid value is an error rather than an opaque bd exit. */
export async function setBeadPriority(
  projectPath: string,
  id: string,
  priority: number,
): Promise<void> {
  await invoke("bead_priority", { projectPath, id, priority });
}

/** `bd update <id> --claim` — mark a bead in_progress (also assigns it). */
export async function claimBead(projectPath: string, id: string): Promise<void> {
  await invoke("bead_claim", { projectPath, id });
}

/** `bd update <id> -s open -a ""` — release a claim: move in_progress back to open AND clear the
 *  assignee.
 *
 *  ══ BOTH FIELDS, AND IT CLEARS RATHER THAN RESTORES ══════════════════════════════════════════
 *  {@link claimBead} is `--claim`, which bd documents as "sets assignee to you, status to
 *  in_progress" — TWO writes — so undoing it means undoing both. A release that moved only the
 *  status left the bead back in the backlog still holding an advisory lease against an orchestrator
 *  that was never created, which bd will refuse a competing claim against.
 *
 *  But this CLEARS the assignee; it does not restore a previous one, because it has no memory of
 *  one. A bead a human had assigned to themselves before Build It was pressed comes back with an
 *  EMPTY assignee, not their name. That is right for the path this exists for — the claim being
 *  undone is the one this app just wrote, moments earlier — and it is why this is named for
 *  releasing a CLAIM rather than for setting a status. **If you only want to walk a bead's status
 *  back without touching ownership, do not call this.** bd's `Owner` (creator) field is untouched.
 *
 *  THE MISSING EDGE. Every other status mutator in this file moves work FORWARD — {@link claimBead}
 *  open → in_progress, {@link closeBead} and {@link markBeadDelivered} → closed, {@link deleteBead}
 *  → gone. There was no path back, so a claim outlived whatever it was claimed for: an agent that is
 *  killed, crashes, or is refused at dispatch left its bead marked in progress permanently, with
 *  nothing building it and nothing able to say so.
 *
 *  The concrete hole this closes is the board handoff. It claims the epic and THEN calls
 *  `sendToBuild`, and `sendToBuildBlockedReason`'s own doc already spells the consequence out
 *  verbatim — "the epic would be left marked in progress with no orchestrator bound, and nothing
 *  un-claims it". That preflight covers capacity only, and a preflight cannot cover a throw that
 *  happens after it (an unknown project, a capacity race). Something has to un-claim it. This is it.
 *
 *  Idempotent on the Rust side — setting an already-open bead to `open` is a no-op — so a
 *  best-effort caller may fire it without first reading the status. It is deliberately NOT wired to
 *  any sweep or timer: it runs on the dispatch-failed path only, undoing a write this app just made.
 */
export async function unclaimBead(projectPath: string, id: string): Promise<void> {
  await invoke("bead_unclaim", { projectPath, id });
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

/** `bd comment <id> -- <text>` — append a note to a bead (positional text; bd has no `-m`).
 *
 *  The DURABLE audit channel for a machine-driven action. A `log.warn` dies with the app session and
 *  a label can only carry a timestamp, so neither answers "why did it do that, three days ago?".
 *  The beads store is shared by every worktree and polled by the board, so a note written here is
 *  readable wherever the founder looks next.
 *
 *  Blank text is refused on the Rust side rather than silently opening `$EDITOR` — see
 *  `notes.rs::bead_comment_inner`. */
export async function commentBead(projectPath: string, id: string, text: string): Promise<void> {
  await invoke("bead_comment", { projectPath, id, text });
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

/** Label prefix carrying a bead's SEVERITY — the weighted relevance score (human comments = 3,
 *  machine = 1, decayed over a window), materialized as `sev-<N>` by the scoring pipeline. Stored as
 *  a label for the same reason `merged-sha:` is: bd has no custom sortable field, and labels
 *  round-trip through `list_beads`, so the board reads the score with no extra per-bead query.
 *
 *  SEVERITY IS NOT PRIORITY. Priority is the manual, dominant ordering (P0-P4); severity ranks WITHIN
 *  a priority band and is written by automation. The two are deliberately separate axes — see the
 *  design in `docs/superpowers/specs/2026-08-09-bead-comments-severity-design.md`. */
export const SEVERITY_LABEL_PREFIX = "sev-";

/** The severity score a bead carries (see {@link SEVERITY_LABEL_PREFIX}), or null when it has none —
 *  which is the common case today (the score is materialized lazily and most beads have no comments),
 *  and renders as NO badge rather than a zero. Pure.
 *
 *  Standardizes on the MAX of any `sev-<N>` labels present: a decaying score writes in both
 *  directions, so a stale duplicate label is likelier than for a monotone counter, and max is the
 *  one rule both score readers must share (per the design's "two readers, one rule"). A non-numeric
 *  or negative suffix is ignored rather than read as 0. */
export function severityOf(bead: Bead): number | null {
  let max: number | null = null;
  for (const label of bead.labels) {
    if (!label.startsWith(SEVERITY_LABEL_PREFIX)) continue;
    const n = Number(label.slice(SEVERITY_LABEL_PREFIX.length));
    if (!Number.isFinite(n) || n < 0) continue;
    if (max === null || n > max) max = n;
  }
  return max;
}

export type BoardColumn = "backlog" | "blocked" | "inProgress" | "done" | "delivered" | "archived";

/** A closed bead carrying this label lands in "delivered" instead of "done". */
export const DELIVERED_LABEL = "delivered";

/**
 * A closed bead carrying this label lands in "archived" instead of "done".
 *
 * ══ WHY A LABEL RATHER THAN "closed == archived" ═══════════════════════════════════════════════
 * `bd` has exactly one closed state, and the board already spends the `delivered` label to split
 * genuinely-shipped work off it (→ "Shipped"). Everything else closed is "Done". The founder runs a
 * background sweep that CLOSES ~1,800 low-signal beads, and those must not flood "Done" — but they
 * are indistinguishable from real completed work by status alone (both are just `closed`), and the
 * "Done" column carries a whole definable-stage criteria system (see `nextStageOf` / `CardCriteria`)
 * that a status-only reinterpretation would break.
 *
 * So archiving is marked the same way shipping is: a label. The sweep that closes a low-signal bead
 * also adds `archived` (mirroring how `markBeadDelivered` adds `delivered`), and the board routes it
 * to the far-right "Archived" column — additive, leaving "Done" and its stage machinery untouched.
 * `delivered` OUTRANKS `archived` (a shipped bead is Shipped even if also archived); see `columnFor`.
 */
export const ARCHIVED_LABEL = "archived";

/** Stamped on every bead the APP creates for a Build agent, as opposed to one a human filed.
 *
 *  These are agent telemetry, not backlog: an un-renamed agent yields a bead titled "Build 7" with
 *  no description, and one is created per spawn AND per first-dirty-file. By 2026-07-29 they were
 *  299 of the 873 beads in this repo's DB (34%) and 74 of the 86 cards in "Being built" — the board
 *  was measuring app sessions rather than work. The back-fill labeled all 299 with this exact
 *  string, so the value is load-bearing for the board filter; do not rename it casually. */
export const AUTO_LABEL = "sparkle-auto";

/**
 * An OPEN bead carrying this label lands in "blocked" — the epic sweep's give-up mark.
 *
 * ══ WHY A LABEL, AND WHY THE BLOCKED LANE ══════════════════════════════════════════════════════
 * `services/epicSweepRunner` restarts a stalled epic once; if that buys nothing it stops retrying
 * and needs somewhere to PUT the epic so the founder sees it. His instruction was "we can move
 * anything into blocked that has this kind of issue" — Blocked is the lane he already scans for
 * "this needs me", so a stuck epic belongs there rather than in a lane of its own.
 *
 * bd has no writable blocked state: `columnFor`'s other source is `bd blocked`, which is DERIVED
 * from dependency edges and cannot be set directly. So this follows the exact precedent
 * {@link DELIVERED_LABEL} and {@link ARCHIVED_LABEL} already set in this file — when bd has no
 * field, the board spends a label — rather than inventing a fake dependency to fake a blocked
 * state.
 *
 * IT IS REVERSIBLE BY BOTH SIDES, which is what makes it safe to write automatically: the sweep
 * itself removes it the moment the epic moves again or somebody picks it up (`decideEpicSweep`'s
 * `clear`), and the founder can take it off from the board like any other label.
 */
export const STALLED_LABEL = "stalled";

/**
 * Label prefix carrying the epoch-ms at which the EPIC SWEEP last restarted this epic.
 *
 * ══ WHY THIS EXISTS AT ALL — THE BOUND IT RESTORES ═════════════════════════════════════════════
 * `services/epicSweepRunner` promises "restart a stalled epic once, then escalate". The first
 * version derived "we already tried" from the creation time of the newest build agent bound to the
 * epic — which is WRONG, because `sendToBuild` REUSES the agent already bound to that epic rather
 * than creating a new one. Reuse leaves `createdAt` untouched, so the timestamp never advanced, the
 * escalate branch was unreachable, and the sweep would have restarted the same dead epic every ten
 * minutes forever while telling the founder it would stop. Caught in review, not by the suite —
 * every test injected its own restart function, so the production seam was never driven.
 *
 * ══ WHY A LABEL RATHER THAN A FIELD ON THE AGENT ═══════════════════════════════════════════════
 * The fact being recorded is about the EPIC, not about any agent: "this work has already been
 * automatically restarted once since it last moved". An agent tab can be closed, and closing it
 * would silently re-grant the restart. The bead outlives every agent that touches it, so the marker
 * belongs there. This follows {@link MERGED_SHA_PREFIX}'s precedent exactly — bd has no field, so
 * the value rides in a label and round-trips through `list_beads` for free.
 *
 * ══ IT ALSO SEPARATES A SWEEP RESTART FROM A HUMAN HANDOFF ═════════════════════════════════════
 * Which the agent timestamp could not do. Without it, a founder who promotes an already-planned
 * epic and whose orchestrator dies would be told, on the very first sweep, "I restarted it once and
 * it still has not moved" — a restart that was never spent, and the epic denied the one it was
 * owed. Only the sweep writes this, so only the sweep's own attempts can exhaust the sweep's budget.
 *
 * Exactly ONE of these is kept per epic: a restart removes any older one before adding its own, so
 * the marker holds the LATEST attempt and cannot accumulate.
 */
export const SWEEP_RESTART_PREFIX = "sweep-restarted:";

/**
 * Marks a {@link STALLED_LABEL} that the sweep wrote WITHOUT ever handing the epic back.
 *
 * ══ WHY A SECOND LABEL RATHER THAN REUSING THE FIRST ═══════════════════════════════════════════
 * While `epicSweepRunner.RESTART_ENABLED` is false, a `restart` decision is escalated instead —
 * so the founder still learns the epic stopped. But the engine reads `STALLED_LABEL` as
 * `alreadyEscalated`, which it treats as "we already spent this epic's one restart and it bought
 * nothing; wait for the human". There is no path back from that except the epic becoming fresh,
 * done, or picked up.
 *
 * So without this second marker, every epic that stalls while the restart is switched off would
 * PERMANENTLY burn the restart it was owed: flipping the constant on later could never hand any of
 * them back, for precisely the population the restart half exists to serve. Caught in review.
 *
 * The division of labour: `STALLED_LABEL` is what the BOARD reads (it routes the epic to Blocked,
 * which is the whole visible point), and this is what the ENGINE reads to know the escalation was a
 * stand-in rather than a spent budget. Removing it is all that enabling the restart half requires.
 */
export const SWEEP_NO_AUTO_LABEL = "stalled-no-auto-restart";

/**
 * This epic was handed to a build agent at least once — the epic sweep's WATCH GATE.
 *
 * ══ WHY A LABEL, WHEN THE WATCH GATE ALREADY HAD AN ANSWER ═════════════════════════════════════
 *
 * It had one, and the answer was unreachable. `epicSweepRunner.candidateFor` derived `promoted`
 * from the AGENT ROSTER — a live `AgentTab` with `kind === "build"` and a matching `epicId`. That
 * is a statement about a TAB, and the fact it is standing in for is about the WORK, so it decayed
 * in three ordinary ways at once: closing the orchestrator, retiring it, or simply relaunching the
 * app all emptied the watch set, silently and permanently.
 *
 * Measured against the live store on 2026-08-18, before this landed: 39 epics, 28 persisted build
 * agents, and **not one agent row carrying an `epicId`** — while 25 of those same rows carried a
 * `beadId`. `sendToBuild` sets both, on adjacent lines, from the same value; the ordinary
 * start-a-bead path sets only the second. So `promoted` was false for every epic in the install,
 * `decideEpicSweep` answered `skip: not-watched` on its FIRST check every tick, and the sweep had
 * been structurally incapable of acting since it shipped in v0.114.0 — nine epics sat past the
 * stall line with zero `sweep-restarted:` markers and zero `stalled` labels to show for it.
 *
 * This is the same argument {@link SWEEP_RESTART_PREFIX} already makes one paragraph up ("it lives
 * on the BEAD rather than on an agent because the fact is about the work: an agent tab can be
 * closed, and closing one must not silently re-grant a restart"). It simply was not applied to the
 * gate that decides whether the epic is looked at in the first place.
 *
 * ══ THE OPT-OUT MOVES, AND THAT IS THE POINT ═══════════════════════════════════════════════════
 *
 * Closing the orchestrator USED to be the de-facto opt-out, and `restartMessage` names it as such.
 * A durable marker deliberately takes that away: closing a tab is something a human does for a
 * dozen unrelated reasons, so reading it as "stop driving this epic" silently retired the whole
 * feature. The opt-out is now {@link NO_AUTO_RESTART_LABEL}, which says what it means. Any copy that
 * still promises the old one is wrong — user-facing remedy strings are audited like branches here.
 *
 * NOT {@link SWEEP_NO_AUTO_LABEL} — this header said so for one commit, which is precisely the
 * confusion {@link NO_AUTO_RESTART_LABEL}'s own doc warns about thirty lines below. That label is
 * the sweep's own stand-in bookkeeping; pointing the authoritative "how does he switch this off"
 * explanation at it sends a maintainer to wire the veto onto the marker the sweep writes itself.
 */
export const PROMOTED_LABEL = "promoted-to-build";

/** Is this epic in the sweep's watch set? See {@link PROMOTED_LABEL}. */
export function isPromotedToBuild(bead: Pick<Bead, "labels">): boolean {
  return bead.labels.includes(PROMOTED_LABEL);
}

/**
 * "Never restart this epic automatically" — the founder's explicit opt-out.
 *
 * ══ THIS EXISTS BECAUSE {@link PROMOTED_LABEL} TOOK THE OLD ONE AWAY ═══════════════════════════
 *
 * While the watch gate read the agent roster, closing the orchestrator WAS the opt-out, and
 * `epicSweepRunner.restartMessage` told the founder so in as many words. Making the gate durable
 * deliberately breaks that — a tab gets closed for a dozen unrelated reasons, and reading it as
 * "stop driving this epic" is what silently retired the whole feature — but removing an opt-out
 * without replacing it leaves him no way to say no at all. So the capability moves here, where it
 * says what it means, instead of disappearing.
 *
 * NOT {@link SWEEP_NO_AUTO_LABEL}, which is a different fact and is easy to mistake for this one:
 * that marks a `stalled` label the sweep wrote as a STAND-IN for a restart it could not perform, so
 * the engine can tell a spent budget from a deferred one. It is written BY the sweep and read by
 * the engine. This is written by a HUMAN and read as a veto. Wiring the opt-out onto that label
 * would make the sweep's own bookkeeping silently cancel the epic.
 */
export const NO_AUTO_RESTART_LABEL = "no-auto-restart";

/** Has the founder vetoed automatic restarts for this epic? See {@link NO_AUTO_RESTART_LABEL}. */
export function isAutoRestartOptedOut(bead: Pick<Bead, "labels">): boolean {
  return bead.labels.includes(NO_AUTO_RESTART_LABEL);
}

/** When the epic sweep last restarted this bead, or null if it never has.
 *
 *  Takes the MAX over every matching label rather than the first: a torn-down write could in
 *  principle leave two behind, and the newest attempt is the one that bounds the budget. An
 *  unparseable value is ignored rather than treated as 0 — a corrupt marker must not read as "we
 *  restarted this at the dawn of time", which would make every stall escalate immediately. */
export function sweepRestartedAt(bead: Pick<Bead, "labels">): number | null {
  let newest: number | null = null;
  for (const label of bead.labels) {
    if (!label.startsWith(SWEEP_RESTART_PREFIX)) continue;
    const t = Number(label.slice(SWEEP_RESTART_PREFIX.length));
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

/** Which board column a bead belongs in:
 *  open+blocked -> blocked; open -> backlog; in_progress -> inProgress;
 *  closed+delivered-label -> delivered; closed+archived-label -> archived; closed (neither) -> done.
 *
 *  BLOCKED OUTRANKS BACKLOG, and only for OPEN beads. A bead someone is actively working
 *  (in_progress) is not waiting on anything the user needs to see in a Blocked lane, and a closed
 *  bead cannot be blocked at all — so the check is deliberately not "is it in the set".
 *
 *  BLOCKED HAS TWO SOURCES, and they answer different questions rather than duplicating one.
 *  `blocked` is bd's own answer — "waiting on a dependency" — and cannot be written to. The
 *  {@link STALLED_LABEL} is the epic sweep's — "this stopped moving and a restart did not help" —
 *  and cannot be expressed as a dependency. They share a LANE because they share a meaning to the
 *  reader (this one needs you), not because either derives from the other.
 *
 *  DELIVERED OUTRANKS ARCHIVED for a closed bead carrying both: "Shipped" is the more informative
 *  home (it is out in the world), and a low-signal sweep should never hide a bead that actually
 *  shipped. See {@link ARCHIVED_LABEL}. */
export function columnFor(bead: Bead, blocked?: ReadonlySet<string>): BoardColumn {
  if (bead.status === "open") {
    return blocked?.has(bead.id) || bead.labels.includes(STALLED_LABEL) ? "blocked" : "backlog";
  }
  if (bead.status === "in_progress") return "inProgress";
  // closed
  if (bead.labels.includes(DELIVERED_LABEL)) return "delivered";
  if (bead.labels.includes(ARCHIVED_LABEL)) return "archived";
  return "done";
}

/** The board, one bead list per column.
 *
 *  DERIVED FROM {@link BoardColumn} rather than re-listing the columns, so `keyof Board` and
 *  `BoardColumn` cannot drift apart. That mattered: everything that walks the board indexes this
 *  struct, so a column declared HERE and not there (or the reverse) is a lane the walkers cannot
 *  see. There is now exactly ONE place a column is declared — {@link BoardColumn} — and this type,
 *  {@link BOARD_COLUMNS} and {@link allBoardBeads} all follow it. */
export type Board = Record<BoardColumn, Bead[]>;

/**
 * EVERY board column, exhaustively — DERIVED FROM THE TYPE, never hand-listed.
 *
 * The `satisfies Record<keyof Board, true>` literal is the tie: adding a column to
 * {@link BoardColumn} — which is what grows {@link Board} — fails to COMPILE here rather than
 * silently dropping out of everything that walks the board. Keyed off `keyof Board` on purpose,
 * because this list exists to be INDEXED INTO a board; checking it against the union alone would
 * still pass for a struct that had drifted from the union. Order is the order written below, and
 * callers may rely on it.
 */
export const BOARD_COLUMNS = Object.keys({
  backlog: true,
  blocked: true,
  inProgress: true,
  done: true,
  delivered: true,
  archived: true,
} satisfies Record<keyof Board, true>) as readonly BoardColumn[];

/**
 * THE ONE FLATTEN: every column of a {@link Board} back into a single bead list.
 *
 * ══ WHY THIS LIVES BESIDE THE TYPE INSTEAD OF IN EACH CONSUMER ═════════════════════════════════
 * `epicDecompose` kept its own copy and it spread FOUR of the six columns — `blocked` and
 * `archived` were missing (bead sparkle-m3340n). The result type is `Bead[]` either way, so the
 * type system could not see the omission, and that list was the SOLE input to that module's
 * membership and candidate queries: the beads in the two forgotten columns provably did not exist
 * as far as the whole module was concerned. The two directions are asymmetric, and only one is
 * inert — an unreachable candidate merely does nothing, while a parent whose children all sit in a
 * forgotten column reads as CHILDLESS and becomes eligible for a duplicate PAID rebuild.
 *
 * A hand-written spread over a struct with N fields goes stale the moment an N+1th field is added,
 * silently and with nothing to catch it. Walking {@link BOARD_COLUMNS} makes that impossible: a new
 * column has to be declared there (or the `satisfies` fails), and every caller of this function
 * picks it up with no edit.
 */
export function allBoardBeads(board: Board): Bead[] {
  const out: Bead[] = [];
  for (const column of BOARD_COLUMNS) out.push(...board[column]);
  return out;
}

/** Group beads into board columns, preserving input order within each column.
 *
 *  Beads labeled {@link AUTO_LABEL} are DROPPED — they are app telemetry (one per Build-agent spawn
 *  and one per first-dirty-file, titled from the agent's throwaway display name), not work anyone
 *  filed. Filtered HERE rather than in the query so the underlying `listBeads` payload stays
 *  complete: the Beads list view and `childrenOf` still see them, only the BOARD hides them. */
export function bucketBeads(beads: Bead[], blocked?: ReadonlySet<string>): Board {
  const board: Board = {
    backlog: [],
    blocked: [],
    inProgress: [],
    done: [],
    delivered: [],
    archived: [],
  };
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
      case "archived":
        board.archived.push(bead);
        break;
    }
  }
  return board;
}

// ── Epic membership: ONE resolver, and it lives here ──────────────────────────────────────────
//
// THE PARENT-CHILD EDGE IS THE SINGLE REPRESENTATION OF EPIC MEMBERSHIP. Everything below reads
// that edge and nothing else, and every surface — the board, the plans domain, the roll-up, the
// Build-It controls — resolves membership by calling into this section rather than testing its own
// condition. `scripts/lib/epic-membership-guard.sh` fails CI if a second condition appears.
//
// WHY THAT RULE EXISTS. This codebase grew THREE incompatible ways to say "this is an epic", none
// of them chosen — each was locally reasonable and the drift was silent:
//   1. `issue_type = 'epic'`      — 27 beads, 12 of them with no children at all.
//   2. a parent-child EDGE        — 166 beads across 23 parents. The dotted id (`sparkle-131ms.2`)
//                                   is bd's DISPLAY form of this edge, not a separate mechanism.
//   3. an `epic:<name>` LABEL     — 4,348 beads carry `epic:improve-sparkle`, written by  // epic-guard-ok
//                                   scripts/lib/retro-beads.sh. NOT ONE of them has a parent edge
//                                   or a dotted id, so the app cannot see any of them.
// The cost was concrete: eight real parents typed `feature`/`bug`/`task`, carrying 2 to 19 children
// apiece, were invisible as plans while their children rendered as loose tasks — because `isEpic`
// tested `type` in the plans domain, `childrenOf` tested `parent` here, and BoardView tested `type`
// again. Three call sites, three conditions. That is HOW the drift happened, so the fix is not
// "pick one" but "have one place that can be picked".

// ── THE FOUR LEGACY SIGNATURES ARE INDEX-BACKED — the cache that makes that free ───────────────
//
// `childrenOf` used to be a full `Array.prototype.filter` with a string `===` and a `startsWith`
// per bead, and `isEpic` / `openChildCount` / `parentEpicOf` all built on it — `parentEpicOf`
// calling `isEpic` INSIDE a loop, over a `beads.find` that is itself a scan. At 7,364 beads /
// 11.6 MB that is quadratic on the render path, and it was measured as such against the founder's
// real store: `beads.filter((b) => isEpic(beads, b))` took 3.4-4.0 SECONDS and 53.7M comparisons to
// find 43 epics, and a renderer hang dump put the WebContent main thread at 450/451 samples inside
// ONE microtask checkpoint with `JSC::stringProtoFuncStartsWith` and `operationCompareStringEq` as
// its heaviest named leaves — literally these two operations.
//
// The docstring on {@link EpicIndex} used to say "every call site was bounded by a render cap".
// That premise is FALSE: ~10 call sites ask these questions of the WHOLE store
// (`epicSweepRunner`, `conciergeTools/plans`, `conciergeTools/board`, `planView`, `epicFocus`,
// `epicDecompose`), and BoardView asks six of them per card across 6,644 cards.
//
// So the four keep their EXACT exported signatures and resolve an {@link EpicIndex} internally,
// keyed on the ARRAY IDENTITY. Every call site above is fixed with zero edits to any of them.
//
// ── STALENESS: WHAT THIS GUARD CATCHES AND WHAT IT DOES NOT ────────────────────────────────────
// A `WeakMap` keyed on identity goes stale if an array is MUTATED IN PLACE, because a `push` keeps
// the same identity. Storing the array's `length` alongside the index catches every mutation that
// CHANGES THE LENGTH (push/pop/splice, the realistic accidents) and rebuilds.
//
// It does NOT catch an in-place field edit at constant length — `beads[3].parent = "x"`, or a
// `splice` that removes one bead and inserts another. Nothing cheap can: detecting that needs a
// per-element scan, which is the cost this whole cache exists to remove. The CONTRACT is therefore
// that callers pass a FRESH ARRAY PER SNAPSHOT. `beadsStore` does — it maps a new array on each
// poll — and every other caller here builds its array from a fresh `listBeads`. Do not start
// mutating a bead in place inside an array you also hand to these functions.
const NO_CHILDREN: readonly Bead[] = Object.freeze([]);

interface CachedEpicIndex {
  index: EpicIndex;
  /** The `beads.length` the index was built from — see the staleness note above. */
  length: number;
}

const epicIndexCache = new WeakMap<readonly Bead[], CachedEpicIndex>();

/**
 * The {@link EpicIndex} for this exact array, built once and reused.
 *
 * EXPORTED as {@link epicIndexOf} because callers OUTSIDE this file hold the same `allBeads` array
 * the per-card resolvers key on, and a direct `buildEpicIndex(allBeads)` there bypasses this cache
 * and pays a second full O(n) walk of a store the cache already holds — 6-13 ms on the founder's
 * 7,364-bead store, on exactly the render path this index exists to make cheap (roborev 65596).
 * `buildEpicIndex` stays public and UNCACHED for callers that genuinely want a fresh build.
 */
function epicIndexFor(beads: readonly Bead[]): EpicIndex {
  const cached = epicIndexCache.get(beads);
  if (cached !== undefined && cached.length === beads.length) return cached.index;
  const index = buildEpicIndex(beads);
  epicIndexCache.set(beads, { index, length: beads.length });
  return index;
}

/**
 * The CACHED {@link EpicIndex} for `beads` — the same one {@link childrenOf} and {@link isEpic}
 * resolve through, so a caller that already triggered one of those pays nothing here.
 *
 * Prefer this over {@link buildEpicIndex} whenever you are handed an array someone else also reads.
 * The cache is keyed on ARRAY IDENTITY with a length guard, so the contract is the one documented
 * at the cache: pass the snapshot array, do not mutate it in place at constant length.
 */
export function epicIndexOf(beads: readonly Bead[]): EpicIndex {
  return epicIndexFor(beads);
}

/** Filter to an epic's children — either an explicit parent link or an id prefixed by
 *  the epic id (bd's hierarchical id convention, e.g. "sparkle-hiju.4"). The epic itself
 *  is excluded.
 *
 *  Both forms are the SAME edge: bd derives the dotted id from the parent it was given, so a bead
 *  reparented later (`bd update <id> --parent <epic>`) keeps its flat id and is matched by the
 *  `parent` half. Membership therefore does not depend on how the child was named. */
export function childrenOf(beads: readonly Bead[], epicId: string): Bead[] {
  // A COPY, not the index's own bucket. The published return type is a mutable `Bead[]` and has
  // been since this function was a `filter`, so a caller is entitled to sort or splice it; handing
  // out the bucket would let one caller corrupt every later reader of the same snapshot. Auditing
  // the eleven call sites today (BoardView x2, EpicsColumn, epicFocus, epicSweepRunner x2,
  // planView x2, epicDecompose, conciergeTools/plans, conciergeTools/board) finds none that mutate
  // — but that is a fact about today's callers, not a property of the signature, so the copy stays.
  // It is O(children), not O(store), which is the entire win: a leaf bead copies nothing.
  const kids = epicIndexFor(beads).childrenByParent.get(epicId);
  return kids === undefined ? [] : kids.slice();
}

/**
 * Every bead in this epic's SUBTREE, the epic included — the transitive closure {@link childrenOf}
 * deliberately is not.
 *
 * PICK THIS ONE when the question is "does this work belong to that epic" (membership, filtering,
 * roll-up across a whole tree). Pick {@link childrenOf} when the question is "what hangs DIRECTLY
 * off this bead" — the ladder's `open/total` count and `isEpic`'s has-children test both mean the
 * direct edge and would change meaning under a closure.
 *
 * WHY THE CLOSURE IS NEEDED, and it is not a refinement — it is a bug fix (bead sparkle-tyruz4).
 * `childrenOf` matches two forms, and only ONE of them is any-depth:
 *
 *   • the DOTTED id (`epic.2.a`) is matched at any depth by one `startsWith` — fine;
 *   • the `parent` edge is matched at ONE level only.
 *
 * The docstring above claims those two forms are interchangeable. For the reparented bead itself
 * they are; for ITS children they are not. A bead moved onto an epic with `bd update <id> --parent
 * <epic>` KEEPS ITS FLAT ID, so nothing beneath it carries the epic's dotted prefix and the
 * `parent` half stops one link short — the whole subtree under that bead is silently dropped from
 * the epic. Walking the edge to fixpoint is what closes that.
 *
 * Cycle-safe: `bd` does not forbid a parent loop, and this runs inside a render memo, so a cycle
 * has to terminate rather than hang the window. The `members` guard is what does it.
 *
 * Returns beads in INPUT ORDER, each exactly once, even when a bead matches both edge forms.
 */
export function descendantsOf(beads: readonly Bead[], epicId: string): Bead[] {
  const prefix = `${epicId}.`;
  // One index of the parent edge, then a walk — not a rescan per level, which would be O(n·depth).
  const byParent = new Map<string, Bead[]>();
  for (const b of beads) {
    // Truthiness, not `=== null`: the field is `string | null | undefined`, so an === null guard
    // lets `undefined` through and the Map key goes untyped. An empty-string parent is not an edge
    // either, so one test covers both absent shapes.
    if (!b.parent) continue;
    const sibs = byParent.get(b.parent);
    if (sibs) sibs.push(b);
    else byParent.set(b.parent, [b]);
  }
  const members = new Set<string>([epicId]);
  const queue: string[] = [epicId];
  // Seed with the dotted form too: `epic.2.a` is a member even if no `parent` edge was ever written
  // for it, which is the case for every bead bd named at creation time.
  for (const b of beads) {
    if (!b.id.startsWith(prefix) || members.has(b.id)) continue;
    members.add(b.id);
    queue.push(b.id);
  }
  while (queue.length > 0) {
    for (const child of byParent.get(queue.pop()!) ?? []) {
      if (members.has(child.id)) continue;
      members.add(child.id);
      queue.push(child.id);
    }
  }
  return beads.filter((b) => members.has(b.id));
}

/**
 * Is this bead an epic? THE one predicate — every surface calls this.
 *
 * A bead is an epic when it HAS CHILDREN, whatever its `issue_type` says, OR when it is explicitly
 * typed `epic`. Structure first: the type field is a label someone did or did not remember to set,
 * while a parent edge is a fact another bead asserted.
 *
 * THE SECOND HALF IS A UNION, NOT A LEFTOVER — dropping it would break the create→decompose→promote
 * workflow at its first step. `createPlan` files a typed epic that has NO children yet and only
 * then decomposes it; if children were REQUIRED, that fresh plan would fail this predicate the
 * instant it was created — invisible to `list_plans`, refused as `not-a-plan` by `get_plan` and
 * `promote_plan_to_build`. So a childless typed epic stays an epic: it is a plan that has not been
 * broken down yet, which is a stage of an epic's life, not a different kind of thing.
 *
 * Takes the full bead list because children are a property of the SET, not of the bead — a bead
 * cannot tell you whether anything points at it. `readonly` so the board's frozen `allBeads` and a
 * plain array are both callable without either side copying.
 */
export function isEpic(beads: readonly Bead[], bead: Pick<Bead, "id" | "type">): boolean {
  // Reads `childrenByParent` directly rather than going through `childrenOf`, which would allocate
  // a copy per call purely to ask whether it is empty — and this is the predicate the whole-store
  // sweeps run per bead.
  return isTypedEpic(bead) || epicIndexFor(beads).childrenByParent.has(bead.id);
}

/**
 * The title to DISPLAY for a bead, with a redundant trailing "epic" marker removed.
 *
 * Several existing epics carry the word in their own title — "Concierge full control surface
 * (epic)" is a live example — and once the card wears an EPIC pill that repetition reads as a bug.
 * This is the display-side fix for that, and DISPLAY-SIDE IS THE WHOLE POINT: the founder ruled a
 * bulk title rewrite out explicitly, and he is right to. `.beads/` is a single embedded Dolt DB
 * shared by every worktree, ignored by git, with no diff and no revert — a bulk `bd update --title`
 * is an irreversible write to live data to fix a rendering concern. So nothing here touches the
 * store; the stored title stays exactly as filed and only the pixels change.
 *
 * ── THE PATTERN IS DELIBERATELY CONSERVATIVE, AND ANCHORED ───────────────────────────────────────
 * It matches a TRAILING "(epic)" or a TRAILING whole word "epic" (case-insensitively), and nothing
 * else. Matching the word anywhere in the string is the obvious implementation and it MANGLES real
 * titles: "Epic membership guard" is a bead that exists, and a naive replace turns it into
 * "membership guard". The `$` anchor plus the `\s` before the bare-word form is what separates the
 * two, and both cases are pinned in beads.epicTitle.test.ts.
 *
 * "epics" is not matched either — the bare-word arm requires the word to END the string, so a
 * plural, a possessive, or "epic loader" all fall through untouched.
 *
 * A title that is ONLY the marker ("epic", "(epic)") is returned UNCHANGED rather than blanked: an
 * empty card title is strictly worse than a redundant one, and a bead named nothing else is telling
 * you something. Same for a title that would be left empty after the strip.
 */
export function epicDisplayTitle(title: string): string {
  const stripped = title.replace(/\s*(?:\(\s*epic\s*\)|\sepic)\s*$/i, "").trim();
  return stripped.length > 0 ? stripped : title.trim();
}

/**
 * How many of an epic's children are still OPEN — the "Contains N tasks" count on an epic card.
 *
 * The founder asked for "the number of open beads that are attached to that epic", so a CLOSED
 * child is not counted: the number is meant to read as remaining work, and an epic whose ten tasks
 * all shipped should say it contains none rather than ten. `in_progress` counts as open, because
 * bd's only terminal state is `closed` (see BeadStatus) and work in flight is plainly not done.
 *
 * Built on {@link childrenOf} rather than restating the membership edge — that edge is allowed to
 * be expressed in exactly one place (scripts/lib/epic-membership-guard.sh), and a second copy here
 * would be the fourth competing definition of what an epic contains.
 */
export function openChildCount(beads: readonly Bead[], epicId: string): number {
  return openChildCountIndexed(epicIndexFor(beads), epicId);
}

/**
 * The epic a bead BELONGS TO, or null when it belongs to none — for the "Part of Epic: …" line.
 *
 * Membership is the same two-form edge {@link childrenOf} reads from the other direction: an
 * explicit `parent`, or a dotted id whose prefix names an ancestor. Read from the child side it has
 * to be resolved rather than filtered, so the candidates are tried NEAREST FIRST — for `a.b.c` that
 * is `a.b` before `a` — because a bead is a child of EVERY prefix of its id and the immediate
 * parent is the one worth naming on a card. An explicit `parent` field outranks the id shape: it is
 * what a reparent writes, and a reparented bead keeps its original dotted id.
 *
 * Returns the epic BEAD, not its id, so a caller can show the name; a candidate that is present but
 * does not itself resolve as an epic is skipped rather than returned, so this can never label a
 * card as part of something that is not an epic.
 */
export function parentEpicOf(beads: readonly Bead[], bead: Pick<Bead, "id" | "parent">): Bead | null {
  return parentEpicOfIndexed(epicIndexFor(beads), bead);
}

/**
 * The same two questions {@link childrenOf} and {@link isEpic} answer, precomputed for a WHOLE-STORE
 * pass — does this bead have children, and what are its children's statuses.
 *
 * ── WHY THIS LIVES HERE AND NOT AT THE CALL SITE ──────────────────────────────────────────────
 * It restates the membership edge, and the edge is allowed to be stated in exactly one file (see
 * `scripts/lib/epic-membership-guard.sh`, and the founder's "I do want it to just be done one way").
 * A fast copy of a rule is still a copy: put it next to the caller and this file stops being the
 * single answer to "what is an epic", which is the whole property the guard exists to hold.
 *
 * ── WHY IT EXISTS AT ALL ──────────────────────────────────────────────────────────────────────
 * `isEpic` USED to be O(store) because `childrenOf` scanned. The claim this docstring used to make
 * — "every call site was bounded by a render cap" — was FALSE by the time the store reached 7,364
 * beads: ~10 call sites ask these questions of the whole store, and BoardView asks six of them per
 * card across 6,644 cards. `beads.filter((b) => isEpic(beads, b))` measured at 3.4-4.0 SECONDS.
 *
 * That is fixed at the source now: {@link childrenOf}, {@link isEpic}, {@link openChildCount} and
 * {@link parentEpicOf} are themselves index-backed (see the cache note above them), so this index
 * is no longer an opt-in fast path a caller has to remember — it is what all of them run on. The
 * `*Indexed` entry points below stay for callers that already hold an index and want to skip even
 * the WeakMap lookup, and for the Plan board's Epics mode, which was the first whole-store caller.
 *
 * ── THE PART THAT LOOKS WRONG AND IS NOT ──────────────────────────────────────────────────────
 * `childrenOf` matches the `parent` field OR the dotted-id prefix, and the dotted half is not just
 * the immediate parent: `a.b.c` is matched by `childrenOf(…, "a")` AND by `childrenOf(…, "a.b")`,
 * so a bead is a child of EVERY prefix of its id. This inserts into all of them, or a grandparent
 * would lose its deeper descendants and could roll up to "nothing started" with a grandchild in
 * flight. `seen` dedupes the case where the parent field and a dotted prefix name the same id,
 * because `childrenOf` is a filter and counts each bead once.
 *
 * ── THE EXISTENCE FILTER APPLIES TO TWO OF THE FOUR FIELDS, DELIBERATELY ─────────────────────
 * `hasChildren` and `statusesByParent` record only a parent id that EXISTS as a bead
 * (`byId.has(...)`). `childrenOf` has no such requirement — it matches a dotted prefix whether or
 * not a bead with that id exists — so the two rules are NOT the same rule, and collapsing them
 * either way would change an answer somewhere.
 *
 * Resolution: `childrenByParent` is UNFILTERED, so `childrenOfIndexed` is byte-for-byte the old
 * `childrenOf` for EVERY id, including one that is not a bead (`childrenOfIndexed(idx, "orphan")`
 * still returns `orphan.7`). `hasChildren` / `statusesByParent` keep the filter they shipped with,
 * because `epicBoard.ts` and {@link isEpicIndexed} only ever ask them about a bead's OWN id.
 *
 * The two halves therefore agree exactly on every id that IS a bead, and differ only on ids that
 * are not — where only the unfiltered half is ever consulted. That is a provable equivalence, not
 * an assumption: for an existing `p`, `childrenOf(beads, p)` is non-empty iff some `b` has
 * `b.parent === p` (with `b.id !== p`, which is the same test as `b.parent !== b.id`) or `b.id`
 * starts with `p + "."` (which holds iff some dot-boundary prefix of `b.id` equals `p`) — exactly
 * the two conditions under which `link` fires. `beads.test.ts` pins it against the ORIGINAL naive
 * bodies over a few-thousand-bead differential fixture, including the non-existent-prefix case.
 *
 * `beads.test.ts` cross-checks this against `childrenOf`/`isEpic` bead-by-bead rather than
 * restating the rules, so the two cannot drift into disagreeing.
 */
/**
 * READ-ONLY THROUGHOUT, and that is a safety property rather than a style preference.
 *
 * This object is held in a module-level WeakMap keyed on the snapshot array, so it is SHARED by
 * every reader of that snapshot for as long as the array lives. `childrenOfIndexed` hands back a
 * bucket by reference (the zero-copy read that makes it O(1)), so a single `sort()` or `push()` on
 * a returned array would not merely affect that caller — it would permanently corrupt child order
 * and counts for the entire render tree until the array identity changed.
 *
 * The old `childrenOf` bounded that blast radius with a defensive `.slice()` per call. The index
 * cannot afford the copy, so the guarantee moves into the TYPE: with `ReadonlyMap`/`readonly`,
 * `index.childrenByParent.get(id)!.push(x)` no longer compiles. `buildEpicIndex` builds into local
 * mutable maps and widens only at the `return`, so the construction stays ordinary code
 * (roborev 65662).
 */
export interface EpicIndex {
  /** Ids that at least one other bead points at — the structural half of {@link isEpic}.
   *  EXISTENCE-FILTERED: only ids that are themselves beads. See the note above. */
  hasChildren: ReadonlySet<string>;
  /** Each id's children's statuses, in input order, ready for a roll-up. EXISTENCE-FILTERED. */
  statusesByParent: ReadonlyMap<string, readonly BeadStatus[]>;
  /** Each id's children, SAME membership edge and SAME order as {@link childrenOf}. NOT existence
   *  filtered — an id that is not a bead can still have dotted children, and `childrenOf` returns
   *  them. Buckets are never empty: one is created only when a child is pushed into it. */
  childrenByParent: ReadonlyMap<string, readonly Bead[]>;
  /** id -> bead, FIRST occurrence wins — matching the `beads.find` that {@link parentEpicOf}
   *  replaced, which returns the first match when a snapshot carries a duplicate id. */
  byId: ReadonlyMap<string, Bead>;
}

export function buildEpicIndex(beads: readonly Bead[]): EpicIndex {
  const hasChildren = new Set<string>();
  const statusesByParent = new Map<string, BeadStatus[]>();
  const childrenByParent = new Map<string, Bead[]>();
  const byId = new Map<string, Bead>();
  // First occurrence wins, so `byId` answers exactly what `beads.find((b) => b.id === id)` did.
  // It doubles as the existence set the `link` half filters on.
  for (const b of beads) if (!byId.has(b.id)) byId.set(b.id, b);

  /** The EXISTENCE-FILTERED half — `hasChildren` + `statusesByParent`. */
  const link = (parentId: string, child: Bead) => {
    hasChildren.add(parentId);
    const bucket = statusesByParent.get(parentId);
    if (bucket) bucket.push(child.status);
    else statusesByParent.set(parentId, [child.status]);
  };

  /** The UNFILTERED half — `childrenByParent`, which must equal `childrenOf` for every id. */
  const linkChild = (parentId: string, child: Bead) => {
    const bucket = childrenByParent.get(parentId);
    if (bucket) bucket.push(child);
    else childrenByParent.set(parentId, [child]);
  };

  for (const b of beads) {
    // `!= null` rather than truthy, because `childrenOf(beads, "")` DOES match a bead whose parent
    // is the empty string (`b.parent === epicId`).
    const parent = b.parent;
    // `b.parent !== b.id` is `childrenOf`'s `b.id !== epicId` seen from this side: when
    // `b.parent === epicId`, the two tests are the same test.
    const parentEdge = parent != null && parent !== b.id;
    if (parentEdge) linkChild(parent, b);

    const seen = new Set<string>();
    // BOTH HALVES USE THE SAME `parentEdge` TEST, and the only difference between them is the
    // EXISTENCE filter (`byId.has`). This half used to test `b.parent` for TRUTHINESS while the
    // half above tested `!= null`, and that one-word difference was a real divergence rather than a
    // stylistic one (roborev 65596): `normalizeBead` yields `id: ""` for a row with a missing or
    // empty id and preserves `parent: ""`, so a store holding an empty-id bead plus any bead
    // parented to `""` gave `childrenByParent.has("") === true` and `hasChildren.has("") === false`.
    // That is observable through an EXPORTED function: `parentEpicOf` resolves epic-ness through
    // `hasChildren` now where it used to go through the unfiltered `childrenOf`, so for a bead whose
    // id begins with `.` (its candidate prefix is `""`) it would return null where it once returned
    // the `""` bead — a behaviour change in a commit that claims none. Sharing the test makes the
    // "these two agree on every id that IS a bead" equivalence actually total, which is what
    // `parentEpicOfIndexed` is justified by.
    if (parentEdge && byId.has(parent)) {
      link(parent, b);
      seen.add(parent);
    }
    for (let dot = b.id.indexOf("."); dot !== -1; dot = b.id.indexOf(".", dot + 1)) {
      const prefix = b.id.slice(0, dot);
      // Prefixes are strictly increasing in length, so they cannot collide with each other; the
      // only double-link `childrenOf` (a filter, one row per bead) would disagree with is the
      // parent edge naming the same id.
      if (!(parentEdge && prefix === parent)) linkChild(prefix, b);
      if (!seen.has(prefix) && byId.has(prefix)) {
        link(prefix, b);
        seen.add(prefix);
      }
    }
  }
  return { hasChildren, statusesByParent, childrenByParent, byId };
}

/**
 * {@link childrenOf}'s answer, read from an {@link EpicIndex} instead of re-scanning — same
 * membership edge, same order, same answer for an id that is not a bead.
 *
 * Returns a SHARED FROZEN empty array for an id with no children rather than allocating one per
 * call: this is asked once per rendered card and most beads are leaves. `readonly` in the return
 * type is what makes that safe — unlike {@link childrenOf}, a caller may not mutate this.
 */
export function childrenOfIndexed(index: EpicIndex, epicId: string): readonly Bead[] {
  return index.childrenByParent.get(epicId) ?? NO_CHILDREN;
}

/** {@link openChildCount}'s answer, read from an {@link EpicIndex}. Counts rather than filtering,
 *  so nothing is allocated. */
export function openChildCountIndexed(index: EpicIndex, epicId: string): number {
  const kids = index.childrenByParent.get(epicId);
  if (kids === undefined) return 0;
  let open = 0;
  for (const k of kids) if (k.status !== "closed") open += 1;
  return open;
}

/**
 * {@link parentEpicOf}'s answer, read from an {@link EpicIndex}.
 *
 * Identical resolution order — explicit `parent` first, then id prefixes NEAREST FIRST — with the
 * `beads.find` replaced by {@link EpicIndex.byId} and the inner `isEpic` by {@link isEpicIndexed}.
 * That substitution is exact and not merely close: `byId` resolves only ids that ARE beads, and on
 * a bead's own id `hasChildren` and `childrenByParent` agree by construction (see the note on
 * {@link EpicIndex}), so the existence filter can never make a candidate that the old code accepted
 * be skipped here.
 */
export function parentEpicOfIndexed(
  index: EpicIndex,
  bead: Pick<Bead, "id" | "parent">,
): Bead | null {
  const candidates: string[] = [];
  if (bead.parent) candidates.push(bead.parent);
  const parts = bead.id.split(".");
  for (let i = parts.length - 1; i > 0; i--) candidates.push(parts.slice(0, i).join("."));
  for (const id of candidates) {
    if (id === bead.id) continue;
    const found = index.byId.get(id);
    if (found && isEpicIndexed(index, found)) return found;
  }
  return null;
}

/** {@link isEpic}'s answer, read from an {@link EpicIndex} instead of re-scanning. Same union, same
 *  order: structure first, then the declared type. */
export function isEpicIndexed(index: EpicIndex, bead: Pick<Bead, "id" | "type">): boolean {
  return isTypedEpic(bead) || index.hasChildren.has(bead.id);
}

/**
 * Was this bead DECLARED an epic (`issue_type = 'epic'`), regardless of whether anything points at
 * it yet? Deliberately NOT a membership test — use {@link isEpic} for "should this render as a
 * plan".
 *
 * It exists for exactly one caller shape: the decompose pipeline, which looks for a bead that was
 * declared an epic and has NO children yet, in order to give it some. Asking `isEpic` there would
 * be a contradiction — a structural epic has children by definition, so it can never be a
 * decomposition candidate — and inlining `type === "epic"` there would be the fourth condition this
 * section exists to prevent.
 *
 * bd's type field is tolerant and loosely cased; `normalizeBead` already lowercases what it can, so
 * this lowercases again rather than trusting it.
 */
export function isTypedEpic(bead: Pick<Bead, "type">): boolean {
  return (bead.type ?? "").toLowerCase() === "epic";
}
