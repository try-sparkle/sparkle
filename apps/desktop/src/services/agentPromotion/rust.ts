// Typed wrappers over the four `promotion_*` Tauri commands (plan contract C,
// `src-tauri/src/promotion.rs`). Everything else in this directory calls THESE, never `invoke`
// directly, for two reasons:
//
//   1. The state machine in promote.ts stays testable with no Tauri in the process at all — it takes
//      these as injected deps, and its tests pass plain fakes.
//   2. The Rust↔TS boundary is normalized in exactly one place. The pinned Rust structs are written
//      in snake_case, but most Tauri-returned structs in this repo carry
//      `#[serde(rename_all = "camelCase")]` (worktree.rs `BranchStatus`, `DiffFile`, `AgentStatusResult`,
//      …). Rather than bet the merge on which convention the Rust worker lands, the normalizers below
//      accept EITHER casing per field. That is not defensive noise: promotion.rs is being written in
//      parallel on another branch, and a silent `undefined` for `has_remote` would read as "no origin
//      remote" and refuse every promotion — a wrong answer that looks like a legitimate refusal.
//
// Argument direction needs no such tolerance: Tauri v2 maps camelCase JS arg keys onto snake_case
// Rust parameters itself (see pty.ts `createWorkerWorktree` → `create_worker_worktree`), so the
// call sites below pass camelCase.

import { invoke } from "@tauri-apps/api/core";

/** What `promotion_preflight` reports about a worktree, WITHOUT changing anything. */
export interface PromotionPreflight {
  /** The resolved branch (same conservative ladder `agent_branch_status` uses, so a renamed
   *  branch still resolves). Empty string when nothing resolved. */
  branch: string;
  /** A branch ref actually exists (false on a detached HEAD or an unborn branch). */
  branchExists: boolean;
  /** An `origin` remote exists. Without one there is nothing for a sandbox to clone. */
  hasRemote: boolean;
  /** `git remote get-url origin`, verbatim, or null when there is none. The plan compares it
   *  (normalised) against the URL the sandbox will be told to clone — see `remote_mismatch`. */
  originUrl: string | null;
  /** The worktree's HEAD at preflight. Reported for completeness; the cutover guard's baseline is
   *  the sha `promotion_push_branch` returns, NOT this (the WIP commit moves HEAD right after). */
  headSha: string;
  /** HEAD is detached — there is no branch to push or to check out in the sandbox. */
  detached: boolean;
  /** Porcelain paths, capped Rust-side (50). May be SHORTER than {@link dirtyCount}. */
  dirtyFiles: string[];
  /** The TRUE number of dirty paths, which may exceed `dirtyFiles.length`. */
  dirtyCount: number;
  /** Commits on the branch that are not on `origin/<branch>`. */
  unpushed: number;
}

/** The agent's Claude Code transcript, tail-capped on whole records with `cwd` already rewritten
 *  to the sandbox path. `null` from {@link promotionReadTranscript} when there is none/unreadable. */
export interface PromotionTranscript {
  /** The Claude Code session id — the sandbox resumes with `claude --resume <this>`. */
  sessionId: string;
  /** Whole JSONL records, newline-separated. Never a partial line. */
  jsonl: string;
  /** True when the OLDEST turns were dropped to fit the byte cap. Reported, not hidden. */
  truncated: boolean;
  bytes: number;
  records: number;
}

/** The narrow slice of Tauri's `invoke` these wrappers need, so tests drive them with a fake. */
export type Invoker = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const defaultInvoke: Invoker = <T,>(cmd: string, args?: Record<string, unknown>) =>
  invoke<T>(cmd, args);

/** Where the sandbox clones the repo (runner contract B). The transcript's `cwd` is rewritten to
 *  this, and its project slug (`-home-user-repo`) is derived from it server-side. */
export const SANDBOX_REPO_CWD = "/home/user/repo";

/**
 * Default transcript byte cap. The spec's "default 4 MB" is measured on RAW JSONL, but the route's
 * 8 MB `bodyLimit` applies to the JSON-ENCODED body — and the transcript is embedded there as a
 * JSON string, so every `"` becomes `\"`, every already-escaped quote inside a tool-input payload
 * becomes `\\\"`, and every newline becomes `\n`. Claude transcripts are dense with all three, so
 * the encoded size runs roughly 1.3–2× the raw size.
 *
 * Sized so that even the pessimistic factor fits: 3 MiB × 2 ≈ 6 MiB, leaving ~2 MB for the rest of
 * the start payload. At the old 4 MiB a long conversation could encode past 8 MB and 413.
 *
 * A 413 is now GRACEFUL — `promote.ts` re-issues the start exactly once with the transcript omitted
 * (bead `sparkle-nit44`), so it costs the conversation rather than the whole promotion. That is a
 * fallback, not a licence to raise this number: the margin is still what keeps the users with the
 * most conversation from silently losing all of it, and raising it is a separate decision with its
 * own measurement. Do not change this without changing `START_BODY_LIMIT_BYTES` with it.
 */
export const TRANSCRIPT_ENCODE_EXPANSION = 2;
export const DEFAULT_TRANSCRIPT_MAX_BYTES = 3 * 1024 * 1024;

/** `promotion_push_branch`'s two defined outcomes. Anything else is rejected, not guessed at. */
export type PushOutcome = "pushed" | "no-remote";

function field(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return undefined;
}

function asObject(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function asBool(v: unknown): boolean {
  return v === true;
}

/** A finite, non-negative integer or 0 — never NaN, and never a coerced object. */
function asCount(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

/**
 * Normalize a raw `promotion_preflight` payload. Accepts either serde casing per field (see the
 * header), and never trusts the shape: a missing/garbage field reads as its safe default rather
 * than as `undefined` leaking into the plan's booleans.
 */
export function normalizePreflight(raw: unknown): PromotionPreflight {
  const o = asObject(raw);
  const rawFiles = field(o, "dirtyFiles", "dirty_files");
  const dirtyFiles = Array.isArray(rawFiles)
    ? rawFiles.filter((f): f is string => typeof f === "string")
    : [];
  return {
    branch: typeof o.branch === "string" ? o.branch : "",
    branchExists: asBool(field(o, "branchExists", "branch_exists")),
    hasRemote: asBool(field(o, "hasRemote", "has_remote")),
    // A non-string (or absent) origin reads as null = UNKNOWN, which the plan refuses on. An empty
    // string must NOT survive: two unknowns would normalize equal and read as a match.
    originUrl: (() => {
      const u = field(o, "originUrl", "origin_url");
      return typeof u === "string" && u.trim().length > 0 ? u : null;
    })(),
    headSha: typeof field(o, "headSha", "head_sha") === "string" ? (field(o, "headSha", "head_sha") as string) : "",
    detached: asBool(o.detached),
    dirtyFiles,
    // The count is the TRUE total and the list is capped, so the count can legitimately exceed the
    // list — but never the other way round. Clamping up keeps "N files" from under-reporting what
    // the user can already see listed.
    dirtyCount: Math.max(asCount(field(o, "dirtyCount", "dirty_count")), dirtyFiles.length),
    unpushed: asCount(o.unpushed),
  };
}

/**
 * Normalize a raw `promotion_read_transcript` payload. `null` for anything unusable — an absent
 * response, a non-string `jsonl`, or a missing session id. A transcript we cannot key by session id
 * cannot be resumed, so it is the same as not having one (promotion then proceeds without it).
 */
export function normalizeTranscript(raw: unknown): PromotionTranscript | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const sessionId = field(o, "sessionId", "session_id");
  const jsonl = o.jsonl;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof jsonl !== "string" || jsonl.length === 0) return null;
  return {
    sessionId,
    jsonl,
    truncated: asBool(o.truncated),
    bytes: asCount(o.bytes),
    records: asCount(o.records),
  };
}

/** Read the worktree's git state. Changes nothing. Rejects with the Rust error string. */
export async function promotionPreflight(
  args: { root: string; agentId: string; worktree: string; baseBranch: string },
  invoker: Invoker = defaultInvoke,
): Promise<PromotionPreflight> {
  return normalizePreflight(
    await invoker<unknown>("promotion_preflight", {
      root: args.root,
      agentId: args.agentId,
      worktree: args.worktree,
      baseBranch: args.baseBranch,
    }),
  );
}

/** `git add -A && git commit` in the worktree. Resolves the number of files committed (0 = clean). */
export async function promotionCommitDirty(
  args: { worktree: string; message: string },
  invoker: Invoker = defaultInvoke,
): Promise<number> {
  const n = await invoker<unknown>("promotion_commit_dirty", {
    worktree: args.worktree,
    message: args.message,
  });
  return asCount(n);
}

/**
 * `git push -u origin <branch>`. Resolves the {@link PushOutcome}; rejects with the git error.
 *
 * An UNRECOGNIZED payload rejects rather than coercing to a string the caller will read as "not
 * no-remote, therefore fine". The three outcomes — pushed, did-not-push, unintelligible — must stay
 * distinguishable at the type level, because the failure of collapsing them is silent and late: the
 * state machine advances to `start` with an unpushed branch, the sandbox clones an absent or stale
 * ref, and the user finds out as an `await_live` timeout long after the WIP commit landed. A
 * rejection here surfaces at the `push` step instead, where the message already explains that the
 * commit is local and recoverable.
 */
export async function promotionPushBranch(
  args: { root: string; branch: string },
  invoker: Invoker = defaultInvoke,
): Promise<PushOutcome> {
  const r = await invoker<unknown>("promotion_push_branch", {
    root: args.root,
    branch: args.branch,
  });
  if (r === "pushed" || r === "no-remote") return r;
  throw new Error(`unexpected push result: ${JSON.stringify(r)}`);
}

/**
 * Newest transcript for the worktree, tail-capped on whole records with `cwd` rewritten to the
 * sandbox path. Resolves `null` when there is none or it is unreadable — which is NOT an error:
 * promotion proceeds without the conversation (spec Decision 2).
 */
export async function promotionReadTranscript(
  args: { worktree: string; sandboxCwd?: string; maxBytes?: number; configDir?: string | null },
  invoker: Invoker = defaultInvoke,
): Promise<PromotionTranscript | null> {
  return normalizeTranscript(
    await invoker<unknown>("promotion_read_transcript", {
      worktree: args.worktree,
      configDir: args.configDir ?? null,
      sandboxCwd: args.sandboxCwd ?? SANDBOX_REPO_CWD,
      maxBytes: args.maxBytes ?? DEFAULT_TRANSCRIPT_MAX_BYTES,
    }),
  );
}
