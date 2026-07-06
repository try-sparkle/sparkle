// apps/desktop/src/services/beads.ts
// Frontend read path for beads (bd) issues. Wraps the Rust `list_beads` / `bead_show`
// commands (which shell out to `bd list/show --json`), normalizes the tolerant/varying
// bd JSON shape into a stable `Bead`, and buckets issues into the board's four columns.
import { invoke } from "@tauri-apps/api/core";

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

/** Create a bead for a deliverable agent and return its new id, or null if bd failed. */
export async function createBead(
  projectPath: string,
  title: string,
  body: string,
): Promise<string | null> {
  const raw = await invoke<string>("create_bead", { projectPath, title, body });
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

export type BoardColumn = "backlog" | "inProgress" | "done" | "delivered";

/** A closed bead carrying this label lands in "delivered" instead of "done". */
export const DELIVERED_LABEL = "delivered";

/** Which board column a bead belongs in:
 *  open -> backlog; in_progress -> inProgress; closed+delivered-label -> delivered;
 *  closed (no label) -> done. */
export function columnFor(bead: Bead): BoardColumn {
  if (bead.status === "open") return "backlog";
  if (bead.status === "in_progress") return "inProgress";
  // closed
  return bead.labels.includes(DELIVERED_LABEL) ? "delivered" : "done";
}

export interface Board {
  backlog: Bead[];
  inProgress: Bead[];
  done: Bead[];
  delivered: Bead[];
}

/** Group beads into board columns, preserving input order within each column. */
export function bucketBeads(beads: Bead[]): Board {
  const board: Board = { backlog: [], inProgress: [], done: [], delivered: [] };
  for (const bead of beads) {
    switch (columnFor(bead)) {
      case "backlog":
        board.backlog.push(bead);
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
