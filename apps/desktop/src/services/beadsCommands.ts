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

/** THE WALL-CLOCK BOUND ON THE WHOLE `create_plan` CHAIN, and the only budget that has to be right.
 *
 *  WHY A SINGLE TOTAL RATHER THAN A SUM OF STAGES. Two review rounds found the same defect in the
 *  same place: a guard that added up the bd budgets and passed while the real worst case blew the
 *  bridge ceiling. First it forgot the dedupe read this feature added (40s modelled, 70s real).
 *  Then, with the dedupe counted, it still forgot `READER_DRAIN_GRACE` — after a bd child exits,
 *  `run_cmd_timed` waits up to 5s on stdout and then up to another 5s on stderr, serially, skipped
 *  only on the kill path, so every COMPLETED invocation is `timeout + 2 x grace`, not `timeout`
 *  (65s real). Both times the guard read as pinning the ceiling while the chain could exceed it.
 *
 *  The lesson is not "count more carefully". It is that a model of another process's internals is
 *  wrong by default and gets wronger as that process changes — and nothing in the Rust crate fails
 *  when it drifts. So the chain now carries ONE deadline measured on the clock the bridge is
 *  actually watching, which is complete by construction: whatever bd, its drains, IPC or a future
 *  stage do, this fires first.
 *
 *  EXPIRING HERE IS STRICTLY BETTER THAN BEING KILLED BY THE BRIDGE, which is what makes the bound
 *  safe rather than a way of losing writes. Both outcomes are "we do not know whether the epic was
 *  filed" — but a bridge kill delivers that as a transport error the model cannot classify, while
 *  this delivers the domain's own `outcome-unknown` refusal, whose message names `list_plans` as
 *  the thing to do instead of retrying. Same fact, actionable instead of opaque. */
export const CREATE_PLAN_TOTAL_BUDGET_MS = 42_000;

/** What must remain between {@link CREATE_PLAN_TOTAL_BUDGET_MS} and the bridge's own ceiling.
 *
 *  The ceiling is a KILL point, and the budget above bounds only the awaited work — IPC, JSON
 *  serialization and the app's own scheduling sit on top of it. */
export const CREATE_PLAN_BRIDGE_HEADROOM_MS = 8_000;

/** Returned by {@link withDeadlineOrExpired} when the promise did not settle in time. A unique
 *  symbol, so it can never collide with a legitimate resolved value. */
export const DEADLINE_EXPIRED = Symbol("deadline-expired");

/** Like {@link withDeadline}, but for the case where a REJECTION and an EXPIRY must be told apart.
 *
 *  `withDeadline` collapses both to `null`, which is right for a fail-open read and wrong for a
 *  WRITE: a rejected create has to be classified (see `createFailureVerdict`), while an expired one
 *  is genuinely unknown. Rejections still reject; only the timeout resolves to the sentinel.
 *
 *  A rejection arriving AFTER expiry is still consumed by the handler below, so abandoning a call
 *  never leaves an unhandled rejection behind. */
export function withDeadlineOrExpired<T>(
  p: Promise<T>,
  ms: number,
): Promise<T | typeof DEADLINE_EXPIRED> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(DEADLINE_EXPIRED), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** How long `create_plan`'s PRE-WRITE DEDUPE READ may take before it is abandoned.
 *
 *  SUBORDINATE TO {@link CREATE_PLAN_TOTAL_BUDGET_MS}, which is what actually guarantees the chain
 *  fits. This one exists so the dedupe cannot eat the budget the CREATE needs: `create_plan` is
 *  three bd invocations in one bridge call, and on the full `BD_TIMEOUT` the read alone could spend
 *  30s of a 42s total, leaving the write to expire for the sake of a check that is only an
 *  optimisation. Capping it at 5s keeps at least 37s for the part that matters.
 *
 *  ABANDONING IT IS SAFE IN A WAY ABANDONING THE OTHER TWO WOULD NOT BE. This is a READ, it leaves
 *  nothing behind, and the dedupe already fails OPEN on any error — so an expiry costs at worst a
 *  duplicate epic the user can see and close, which is exactly the pre-existing behaviour. The bd
 *  child keeps running to its own bound after we stop waiting; that is one extra reader against a
 *  contended store, not a leak.
 *
 *  Deliberately NOT the thing the contract test sums — see {@link CREATE_PLAN_TOTAL_BUDGET_MS} for
 *  why summing stages was abandoned after it under-counted twice. */
export const CREATE_PLAN_DEDUPE_BUDGET_MS = 5_000;

/** Resolve `p`, or `null` if it has not settled within `ms` — and `null` on rejection too.
 *
 *  Deliberately never REJECTS: every caller of this is a fail-open read where "we could not find
 *  out" and "we found nothing" lead to the same next action, and a distinct rejection would only
 *  invite a caller to treat a slow store as an error. */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** The phrase `beads_cmd.rs::write_dropped` puts in its message, and the ONE bd failure that PROVES
 *  nothing was filed.
 *
 *  `beads_create` probes the store after every create, and this error is raised only when that probe
 *  RAN CLEANLY and the row was absent. Every other create failure — a timeout, a busy store, a
 *  non-zero bd exit — leaves the outcome genuinely UNKNOWN, and the difference decides whether a
 *  caller may safely retry. Substring-matched for the same reason `isBeadsUnavailable` is in
 *  `beads.ts`: the kind alone (`badOutput`) covers version skew and partial reads too, which are
 *  not proof of anything. A Rust test in `beads_cmd.rs` pins `write_dropped`'s wording against this
 *  constant's text, so the two cannot drift silently. */
export const WRITE_DROPPED_MARKER = "the write did not land";

/** True when the failure PROVES the create did not land — as opposed to merely failing to prove it
 *  did. See {@link WRITE_DROPPED_MARKER}: only a clean probe finding no row qualifies. */
export function isWriteDropped(e: unknown): boolean {
  const { kind, message } = toBeadsError(e);
  return kind === "badOutput" && message.includes(WRITE_DROPPED_MARKER);
}

/** True when the call lost a race for the store rather than being wrong — the failure whose remedy
 *  is to re-issue the SAME request in a moment.
 *
 *  Kinds land here because they are one event seen from several sides: `timeout` is us giving up on a
 *  bd that was still waiting; `storeBusy` is either bd giving up first (it ran and lost the store
 *  lock) OR bd never starting because the concurrency permit queue stayed saturated. Those two
 *  `storeBusy` halves differ in write-safety — the never-spawned half provably wrote nothing, while a
 *  create that lost the lock may have committed — but the kind does not yet distinguish them
 *  (sparkle-lncpoc will add a machine-readable marker). Treat `isStoreBusy` as "lost the race, not a
 *  bad request"; do not infer write-safety from the kind alone for a non-idempotent create. The store
 *  is a single embedded database shared by every worktree, written by many agents at once and polled
 *  by this app every five seconds, so losing that race is the ORDINARY failure here — the one that
 *  reads as a fault in the request when it is reported without a name. */
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

/** One comment on a bead — the READ half of the comment feature (the write is {@link beadsComment}).
 *
 *  `author` and `createdAt` are `T | null`, NOT `T?`: they are backed by a Rust `Option`, which serde
 *  emits as an explicit `null` value (never an absent key), and bd itself always includes the keys.
 *  A comment whose `author` is null is a real comment with no recorded author, not a missing field. */
export interface BeadComment {
  id: string;
  author: string | null;
  text: string;
  createdAt: string | null;
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
  /** The bead's comment thread, oldest-first. Populated only on this per-open detail read — the
   *  board's 5s list poll never carries comments (it would pull every bead's whole thread against a
   *  contended store on every tick). */
  comments: BeadComment[];
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
