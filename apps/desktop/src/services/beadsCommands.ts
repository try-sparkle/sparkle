// apps/desktop/src/services/beadsCommands.ts
//
// Typed TS wrapper over the planning/beads command surface in `src-tauri/src/beads_cmd.rs`.
// This is the seam a programmatic caller (the concierge) uses to READ and CHANGE the plan.
//
// HOW THIS DIFFERS FROM `services/beads.ts`, and why both exist. `beads.ts` is the BOARD's path:
// it invokes `list_beads`/`bead_show`, which return bd's raw JSON, and normalizes it into `Bead`
// for rendering. It is unbounded by design — a React component wants every field, re-reads every
// 5s, and throws the previous result away. A programmatic caller needs the opposite guarantees:
//
//   * BOUNDED output. A tool result is never evicted from an agent's context, so one unbounded
//     read costs for the whole session. `bd list --all --limit 0 --json` over this repo's ~825
//     beads is ~2.9 MB. Every query here returns a `BeadPage` with an exact `omitted` count.
//   * TYPED errors. `beads.ts` substring-matches English ("no beads database found"). That is
//     workable for one call site and unworkable for a caller that must BRANCH on the outcome —
//     install bd, run `bd init`, retry, or give up are four different remedies. `BeadsError.kind`
//     is a closed union; `message` is for display only.
//
// Neither file reimplements bd: both shell out, and bd stays the source of truth for the work
// graph. Nothing here ranks, scores, or curates beads — that is a separate, later decision.
import { invoke } from "@tauri-apps/api/core";

// ── Errors ────────────────────────────────────────────────────────────────────────────────────

/** Why a beads call failed. Mirrors `BeadsErrorKind` in beads_cmd.rs — the Rust enum serializes to
 *  exactly these strings, and a Rust-side rename would silently break this union (there is a Rust
 *  test pinning each tag for that reason). */
export type BeadsErrorKind =
  | "binaryNotFound"
  | "noWorkspace"
  | "invalidInput"
  | "bdFailed"
  | "timeout"
  | "storeBusy"
  | "badOutput";

/** The rejection value every command in this module produces. */
export interface BeadsError {
  kind: BeadsErrorKind;
  message: string;
  exitCode: number | null;
}

const KINDS: readonly BeadsErrorKind[] = [
  "binaryNotFound",
  "noWorkspace",
  "invalidInput",
  "bdFailed",
  "timeout",
  "storeBusy",
  "badOutput",
];

/** True when `v` is the structured error the Rust side returns. */
export function isBeadsError(v: unknown): v is BeadsError {
  if (!v || typeof v !== "object") return false;
  const k = (v as { kind?: unknown }).kind;
  return typeof k === "string" && (KINDS as readonly string[]).includes(k);
}

/** Coerce ANY rejection into a `BeadsError`.
 *
 *  Tauri rejects with the serialized error VALUE, not an `Error`, so a caller that writes
 *  `catch (e) { e.message }` gets `undefined` — and a failure that never reaches Rust at all (the
 *  IPC bridge is down, the command is not registered) rejects with a plain string or `Error`
 *  instead. Funnelling every rejection through this means a caller can always read `.kind` and
 *  `.message`, and an unrecognized failure degrades to `bdFailed` rather than crashing the
 *  handler that was trying to report it. */
export function toBeadsError(e: unknown): BeadsError {
  if (isBeadsError(e)) {
    return { kind: e.kind, message: e.message ?? "", exitCode: e.exitCode ?? null };
  }
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : JSON.stringify(e);
  return { kind: "bdFailed", message: message || "unknown beads failure", exitCode: null };
}

/** True when the failure means "this project has no beads workspace yet" — the one error that is a
 *  normal state rather than a fault. Callers use it to offer `bd init` instead of showing an error;
 *  it is the typed replacement for `beads.ts`'s substring match. */
export function isNoWorkspace(e: unknown): boolean {
  return toBeadsError(e).kind === "noWorkspace";
}

/** True when bd is not installed. Distinct from `isNoWorkspace`: the remedy is to install beads,
 *  and no amount of retrying or `bd init` will help. */
export function isBdMissing(e: unknown): boolean {
  return toBeadsError(e).kind === "binaryNotFound";
}

/** True when the call lost a race for the store rather than being wrong — the failure whose remedy
 *  is to re-issue the SAME request in a moment.
 *
 *  Two kinds land here because they are one event seen from two sides: `timeout` is us giving up on
 *  a bd that was still waiting, `storeBusy` is bd giving up first and telling us so. The store is a
 *  single embedded database shared by every worktree, written by many agents at once and polled by
 *  this app every five seconds, so losing that race is the ORDINARY failure here — and it is the
 *  one that reads as a fault in the request when it is reported without a name. */
export function isStoreBusy(e: unknown): boolean {
  const { kind } = toBeadsError(e);
  return kind === "timeout" || kind === "storeBusy";
}

// ── Data ──────────────────────────────────────────────────────────────────────────────────────

/** One bead. `description` is an EXCERPT — see `descriptionTruncated`, and use `beadsDetail` for
 *  the full text. */
export interface BeadSummary {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  issueType: string | null;
  assignee: string | null;
  parent: string | null;
  labels: string[];
  description: string;
  /** True when `description` was cut, so an excerpt is never mistaken for the whole field. */
  descriptionTruncated: boolean;
  dependencyCount: number;
  dependentCount: number;
  commentCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
}

/** A bounded page of beads.
 *
 *  `total` and `omitted` are EXACT counts; `omittedIds` is a capped sample (20), not a second page.
 *  This mirrors the `omitted`/`omittedIds` contract already established in `controlListener.ts`:
 *  cap the id list, keep the count exact, so truncation is always visible to the caller. */
export interface BeadPage {
  beads: BeadSummary[];
  /** How many beads matched in total, BEFORE the cap. */
  total: number;
  /** Exactly how many matching beads are not in `beads`. 0 means the page is complete. */
  omitted: number;
  /** Ids of some omitted beads (capped). A sample for resolving one specific bead. */
  omittedIds: string[];
  /** The row limit actually applied, after clamping to the server-side ceiling of 500. */
  limit: number;
}

/** One edge in the work graph. */
export interface BeadLink {
  id: string;
  linkType: string;
}

/** A bead plus its immediate neighbourhood. */
export interface BeadDetail {
  bead: BeadSummary;
  /** The full, uncut description (`bead.description` stays excerpted). */
  fullDescription: string;
  /** Children of this bead, bounded like any other page. */
  children: BeadPage;
  /** What this bead depends on / is blocked by. */
  dependencies: BeadLink[];
  /** What depends on this bead. */
  dependents: BeadLink[];
  /** True when the link lists were cut at 100. */
  linksTruncated: boolean;
}

/** Query filters. All optional; `{}` lists open beads.
 *
 *  PRECEDENCE (enforced in Rust, restated here because it is easy to get wrong): an explicit
 *  `status` WINS — when it is set, `blocked` and `includeClosed` are ignored rather than widening
 *  the result behind the caller's back. `ready` is independent and always applies. */
export interface BeadQuery {
  /** bd's stored status; comma-separated is allowed ("open,in_progress"). */
  status?: string;
  /** "0".."4" or "P0".."P4" (0 = highest). */
  priority?: string;
  parent?: string;
  assignee?: string;
  issueType?: string;
  label?: string;
  titleContains?: string;
  /** Only beads with no active blockers. */
  ready?: boolean;
  /** Only blocked beads. Ignored when `status` is set. */
  blocked?: boolean;
  /** Include closed beads. Ignored when `status` is set. */
  includeClosed?: boolean;
  /** Rows to return. Defaults to 100, clamped to 500. */
  limit?: number;
}

/** Fields for a new bead. Only `title` is required. */
export interface NewBead {
  title: string;
  description?: string;
  /** bug | feature | task | epic | chore | decision … Defaults to "task". */
  issueType?: string;
  priority?: string;
  parent?: string;
  assignee?: string;
  /** Comma-separated. */
  labels?: string;
}

/** A partial update. Only the provided fields are written; an all-empty patch is rejected. */
export interface BeadPatch {
  status?: string;
  priority?: string;
  assignee?: string;
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────

/** Run `fn`, converting any rejection into a `BeadsError`. Every command goes through this so the
 *  rejection type is uniform regardless of where the failure came from. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toBeadsError(e);
  }
}

/** Query the work graph. Returns a BOUNDED page — always check `omitted` before treating the
 *  result as the complete answer. Rejects with a `BeadsError`. */
export async function beadsQuery(projectPath: string, query: BeadQuery = {}): Promise<BeadPage> {
  return call(() => invoke<BeadPage>("beads_query", { projectPath, query }));
}

/** Show one bead with its full description, children, and dependency edges. */
export async function beadsDetail(projectPath: string, id: string): Promise<BeadDetail> {
  return call(() => invoke<BeadDetail>("beads_detail", { projectPath, id }));
}

/** Create a bead and return it. */
export async function beadsCreate(projectPath: string, bead: NewBead): Promise<BeadSummary> {
  return call(() => invoke<BeadSummary>("beads_create", { projectPath, bead }));
}

/** Update status / priority / assignee. Only the provided fields are written. */
export async function beadsUpdate(
  projectPath: string,
  id: string,
  patch: BeadPatch,
): Promise<void> {
  await call(() => invoke<void>("beads_update", { projectPath, id, patch }));
}

/** Close a bead with a reason (bd's own close-reason field, not a comment). */
export async function beadsClose(
  projectPath: string,
  id: string,
  reason: string,
): Promise<void> {
  await call(() => invoke<void>("beads_close", { projectPath, id, reason }));
}

/** Add a comment to a bead. */
export async function beadsComment(
  projectPath: string,
  id: string,
  text: string,
): Promise<void> {
  await call(() => invoke<void>("beads_comment", { projectPath, id, text }));
}

/** A one-line, caller-facing summary of what a page left out.
 *
 *  Exists so the truncation is reported in WORDS, not just as a number a caller may not read. An
 *  agent handed `{beads: [...100], total: 825}` with no prose will describe the backlog as 100
 *  items; this is the sentence that stops that. Returns null when nothing was omitted. */
export function describeOmissions(page: BeadPage): string | null {
  if (page.omitted <= 0) return null;
  const sample = page.omittedIds.length > 0 ? ` (e.g. ${page.omittedIds.slice(0, 5).join(", ")})` : "";
  return `Showing ${page.beads.length} of ${page.total} matching beads; ${page.omitted} omitted${sample}. Narrow the query or raise \`limit\` (max 500) to see more.`;
}
