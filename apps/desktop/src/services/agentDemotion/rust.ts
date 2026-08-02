// Typed wrappers over the two `demotion_*` Tauri commands (plan W2, `src-tauri/src/demotion.rs`),
// and the parser for their STABLE REFUSAL PREFIXES. The mirror of agentPromotion/rust.ts, and for
// the same two reasons: the state machine in demote.ts takes these as injected deps so its tests
// need no Tauri at all, and the Rust↔TS casing boundary is normalized in exactly one place.
//
// `demotion.rs` is being written in parallel on another branch, so — exactly as promotion/rust.ts
// does — the normalizers accept EITHER serde casing per field. A silent `undefined` for `head_sha`
// would otherwise read as "the landing reported no sha", and the demotion would refuse every time.
//
// Argument direction needs no tolerance: Tauri v2 maps camelCase JS arg keys onto snake_case Rust
// parameters itself, so the call sites below pass camelCase.

import { invoke } from "@tauri-apps/api/core";

/** Where the sandbox clones the repo (runner contract B). Every transferred transcript record's
 *  `cwd` is this, and `demotion_write_transcript` rewrites it to the local worktree — the exact
 *  inverse of `promotion_read_transcript`'s rewrite. */
export const SANDBOX_REPO_CWD = "/home/user/repo";

/** What `demotion_land_branch` reports once the branch is on this machine. */
export interface DemotionLanding {
  /** The worktree the branch is checked out in — where the transcript is written and the local
   *  agent spawns. */
  worktree: string;
  /** The worktree's HEAD after landing. Equal to the handoff's `pushedSha` on success (a
   *  `sha-mismatch:` refusal is how a difference surfaces). */
  headSha: string;
  /** true = the worktree was cut fresh (a born-in-the-cloud agent had none); false = an existing
   *  worktree was fast-forwarded (a previously promoted agent). Reported so the UI can say which. */
  created: boolean;
}

/** The narrow slice of Tauri's `invoke` these wrappers need, so tests drive them with a fake. */
export type Invoker = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const defaultInvoke: Invoker = <T,>(cmd: string, args?: Record<string, unknown>) =>
  invoke<T>(cmd, args);

function field(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
  }
  return undefined;
}

/**
 * The classified reason a landing was refused.
 *
 * `unknown` is a real member, not a fallback nobody hits: `demotion.rs` can fail in ways with no
 * pinned prefix (a panic, an IO error), and collapsing those into one of the named kinds would put
 * a confident, wrong sentence in front of the user.
 */
export type LandRefusalKind =
  /** The local worktree has uncommitted changes. NAMES THEM — see {@link LandRefusal.files}. */
  | "dirty"
  /** Local has commits `origin/<branch>` does not; a fast-forward is impossible. */
  | "diverged"
  | "no-remote"
  /** Landed, but HEAD is not the sha the handoff pushed (the sandbox moved under us). */
  | "sha-mismatch"
  | "fetch-failed"
  | "worktree-failed"
  | "unknown";

export interface LandRefusal {
  kind: LandRefusalKind;
  /**
   * The paths the refusal named, in the order Rust reported them. Non-empty for `dirty`.
   *
   * `diverged`'s pinned prefix carries no payload today, but the parser accepts an optional
   * `diverged:<file>,…` payload anyway: spec Decision 3 says the refusal names the files, and a
   * parser that silently discarded a list the Rust side started sending is how a contract widens
   * on one side only and the user keeps reading the generic sentence.
   */
  files: string[];
  /** The actual HEAD, for `sha-mismatch`. Null for every other kind. */
  actualSha: string | null;
  /** The refusal string verbatim, for logs. NEVER shown to the user — the point of this parser is
   *  that the UI renders a sentence built from `kind` + `files`, not a flattened git error. */
  raw: string;
}

/** How many paths a refusal message names before it says "+N more". */
const REFUSAL_FILE_SAMPLE = 10;

function splitFiles(payload: string): string[] {
  return payload
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

/**
 * Classify a `demotion_land_branch` rejection by its stable prefix (plan W2).
 *
 * Prefix matching is done on the FULL string with `startsWith`, deliberately — not by searching for
 * the word anywhere in it. A git error that merely mentions "diverged" in its prose is not a
 * `diverged` refusal, and treating it as one would tell the user their local branch has commits the
 * cloud does not when the real failure was something else entirely.
 */
export function parseLandRefusal(raw: unknown): LandRefusal {
  const s = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : String(raw);
  const base: LandRefusal = { kind: "unknown", files: [], actualSha: null, raw: s };
  if (s.startsWith("dirty:")) {
    return { ...base, kind: "dirty", files: splitFiles(s.slice("dirty:".length)) };
  }
  if (s === "diverged" || s.startsWith("diverged:")) {
    return {
      ...base,
      kind: "diverged",
      files: s.startsWith("diverged:") ? splitFiles(s.slice("diverged:".length)) : [],
    };
  }
  if (s === "no-remote" || s.startsWith("no-remote:")) return { ...base, kind: "no-remote" };
  if (s.startsWith("sha-mismatch:")) {
    const actual = s.slice("sha-mismatch:".length).trim();
    return { ...base, kind: "sha-mismatch", actualSha: actual.length > 0 ? actual : null };
  }
  if (s.startsWith("fetch-failed:")) return { ...base, kind: "fetch-failed" };
  if (s.startsWith("worktree-failed:")) return { ...base, kind: "worktree-failed" };
  return base;
}

/** Render a refusal's file list for a user-facing sentence. Empty string when it named none. */
export function refusalFileList(files: string[]): string {
  if (files.length === 0) return "";
  const shown = files.slice(0, REFUSAL_FILE_SAMPLE);
  const rest = files.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} (+${rest} more)` : shown.join(", ");
}

/**
 * Turn a landing refusal into the sentence the user reads.
 *
 * `dirty` and `diverged` carry their file list rather than a flattened git error (plan W3 hard
 * rule): both mean the LOCAL copy holds content the cloud does not, so the only thing the user can
 * act on is knowing WHICH files — "the fast-forward failed" tells them nothing they can do.
 */
export function landRefusalMessage(r: LandRefusal, branch: string): string {
  switch (r.kind) {
    case "dirty": {
      const list = refusalFileList(r.files);
      return (
        `This agent's local worktree has uncommitted changes, so ${branch} can't be fast-forwarded onto it` +
        (list ? `: ${list}.` : ".") +
        " Commit or stash them and demote again — Sparkle won't overwrite local work it didn't put there."
      );
    }
    case "diverged": {
      const list = refusalFileList(r.files);
      return (
        `This agent's local worktree has commits that aren't on origin/${branch}, so it can't be fast-forwarded` +
        (list ? ` (${list}).` : ".") +
        " Push or rebase them and demote again — Sparkle won't reset a branch that holds work the cloud doesn't have."
      );
    }
    case "no-remote":
      return `This project has no \`origin\` remote, so there's nowhere to fetch ${branch} from.`;
    case "sha-mismatch":
      return (
        `${branch} landed at a different commit (${r.actualSha ?? "unknown"}) than the sandbox reported pushing, ` +
        "so the local copy can't be proven to match the cloud one. Demote again."
      );
    case "fetch-failed":
      return `Couldn't fetch ${branch} from origin: ${r.raw.slice("fetch-failed:".length).trim()}`;
    case "worktree-failed":
      return `Couldn't set up a local worktree for ${branch}: ${r.raw.slice("worktree-failed:".length).trim()}`;
    default:
      return `Couldn't bring ${branch} down to this machine: ${r.raw}`;
  }
}

/**
 * Normalize a raw `demotion_land_branch` payload. Accepts either serde casing per field; a missing
 * `worktree` or `headSha` REJECTS rather than defaulting, because both are load-bearing downstream
 * (the worktree is where the transcript is written and the agent spawns; the sha is the proof the
 * landing matched). A silent `""` for either would be acted on as if it were an answer.
 */
export function normalizeLanding(raw: unknown): DemotionLanding {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const worktree = field(o, "worktree");
  const headSha = field(o, "headSha", "head_sha");
  if (typeof worktree !== "string" || worktree.length === 0) {
    throw new Error(`demotion_land_branch returned no worktree: ${JSON.stringify(raw)}`);
  }
  if (typeof headSha !== "string" || headSha.length === 0) {
    throw new Error(`demotion_land_branch returned no head sha: ${JSON.stringify(raw)}`);
  }
  return { worktree, headSha, created: field(o, "created") === true };
}

/**
 * Bring `branch` down to a local worktree and land it at `expectedSha`.
 *
 * `existingWorktree` non-null ⇒ fetch + `merge --ff-only origin/<branch>` there; null ⇒ fetch, then
 * cut a worktree. Rejects with the Rust refusal string verbatim — {@link parseLandRefusal} is what
 * classifies it, and it is deliberately NOT done here so the raw string reaches the logs intact.
 */
export async function demotionLandBranch(
  args: {
    root: string;
    agentId: string;
    existingWorktree: string | null;
    branch: string;
    expectedSha: string;
  },
  invoker: Invoker = defaultInvoke,
): Promise<DemotionLanding> {
  return normalizeLanding(
    await invoker<unknown>("demotion_land_branch", {
      root: args.root,
      agentId: args.agentId,
      existingWorktree: args.existingWorktree,
      branch: args.branch,
      expectedSha: args.expectedSha,
    }),
  );
}

/**
 * Write a transferred sandbox transcript into the LOCAL Claude Code projects tree, rewriting every
 * record's `cwd` from the sandbox path to the worktree. Resolves the number of records written.
 *
 * Rejects on failure — and the CALLER (demote.ts) is what makes that non-fatal, not this wrapper.
 * Swallowing the error here would hide `transcriptError` from the record the user sees.
 */
export async function demotionWriteTranscript(
  args: {
    worktree: string;
    sessionId: string;
    jsonl: string;
    sandboxCwd?: string;
    configDir?: string | null;
  },
  invoker: Invoker = defaultInvoke,
): Promise<number> {
  const n = await invoker<unknown>("demotion_write_transcript", {
    worktree: args.worktree,
    configDir: args.configDir ?? null,
    sessionId: args.sessionId,
    jsonl: args.jsonl,
    sandboxCwd: args.sandboxCwd ?? SANDBOX_REPO_CWD,
  });
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
