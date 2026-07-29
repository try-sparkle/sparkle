// The DIFF domain — "what did this agent actually CHANGE?" (concierge PRD section J).
//
// The concierge could already see that a branch was ahead by N commits and could read the agent's
// terminal. Neither answers the question. `agent_branch_status` gives a COUNT, which says nothing
// about content; the terminal narrates INTENT — what the agent said it did — and intent and diff
// diverge exactly when it matters most (the agent that reports "fixed the auth bug" and touched
// eleven unrelated files, the one that says "small change" and rewrote a migration). The diff is the
// only account of the work that cannot be wrong about itself.
//
// ENTIRELY READ-ONLY, AND THAT IS STRUCTURAL. Every op maps to a git plumbing READ — `diff
// --numstat`, `diff -- <path>`, `log`. Nothing here writes a ref, stages, stashes, checks out, or
// touches the index. That is what lets the whole domain sit in the `read-only` tier and answer
// without an approval round-trip, and it is asserted from the test side rather than left as a
// property of the current implementation.
//
// THREE OPS, IN THE ORDER A HUMAN ACTUALLY ASKS:
//
//   list_changed_files — the shape of the change. Nearly always the whole answer: "it touched
//                        pty.rs and its test" is what someone wants, not 600 lines of patch.
//   read_file_diff     — one file's patch, when the shape is not enough.
//   list_commits       — the narrative the agent wrote for itself, newest first.
//
// WHY THREE-DOT AND NOT TWO-DOT. `base...head` diffs against the MERGE BASE, so it shows the
// agent's own work and excludes everything that landed on the base since it branched. Two-dot would
// attribute other people's commits to this agent the moment its branch went stale — and a branch
// being stale is the normal state, not an edge case (AGENTS.md is largely about that). Getting this
// backwards would make the tool actively misleading rather than merely incomplete.
//
// BUDGETS ARE THE MODULE'S, NOT THE CALLER'S. Everything here lands in an LLM context window. The
// Rust side caps files-per-call, lines-per-file and chars-per-file; a caller may ask for LESS but
// never for more, and a truncated result says so with amounts. Silent truncation is the specific
// failure to avoid: it lets the concierge say "that's the whole change" about a fragment.
import { invoke } from "@tauri-apps/api/core";

import { useProjectStore } from "../../stores/projectStore";
import { agentBranchName } from "./workflow";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

export const DIFF_OPS = ["list_changed_files", "read_file_diff", "list_commits"] as const;

export type DiffOp = (typeof DIFF_OPS)[number];

export type DiffRisk = "read-only" | "routine" | "disruptive" | "irreversible";

/**
 * EXHAUSTIVE by construction — a `Record<DiffOp, …>`, so an op added to `DIFF_OPS` without a
 * classification fails `tsc` rather than defaulting to something permissive.
 *
 * Every op is `read-only`, and that is a claim about the implementation rather than a convenience:
 * each one runs exactly one git READ. If a write ever appears in this domain it must change tier
 * here, and the policy layer derives its default decision from this map — so the classification is
 * load-bearing, not documentation.
 */
export const DIFF_RISK: Record<DiffOp, DiffRisk> = {
  list_changed_files: "read-only",
  read_file_diff: "read-only",
  list_commits: "read-only",
};

// ---------------------------------------------------------------------------------------------
// Results — the lifecycle/board/plans convention
// ---------------------------------------------------------------------------------------------

export interface DiffOk<T> {
  ok: true;
  op: DiffOp;
  risk: DiffRisk;
  data: T;
}

export interface DiffRefusal {
  ok: false;
  op: DiffOp;
  risk: DiffRisk;
  reason: string;
  message: string;
}

export type DiffResult<T> = DiffOk<T> | DiffRefusal;

function ok<T>(op: DiffOp, data: T): DiffOk<T> {
  return { ok: true, op, risk: DIFF_RISK[op], data };
}

function refuse(op: DiffOp, reason: string, message: string): DiffRefusal {
  return { ok: false, op, risk: DIFF_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// Wire shapes (mirrors of the Rust structs)
// ---------------------------------------------------------------------------------------------

export interface ChangedFile {
  path: string;
  /** Null for a BINARY file: git's numstat prints "-" there, and reporting 0 would read as
   *  "nothing changed" rather than "not countable". */
  added: number | null;
  removed: number | null;
  binary: boolean;
}

export interface ChangedFiles {
  base: string;
  head: string;
  files: ChangedFile[];
  /** The real count before the cap. Equal to `files.length` when nothing was dropped, larger when
   *  the cap bit — so "that's all of them" and "that's the first 200 of 900" stay distinguishable. */
  totalFiles: number;
  truncated: boolean;
}

export interface FileDiff {
  path: string;
  text: string;
  truncated: boolean;
  omittedLines: number | null;
  /** Bytes left out. The LINE count alone understates badly when one dropped line is a minified
   *  bundle or a source map: "1 line omitted" is true and useless about 200 KB. */
  omittedBytes: number | null;
}

export interface CommitRow {
  sha: string;
  subject: string;
  author: string;
  /** Unix SECONDS, not millis — git's `%at`. The caller formats; a pre-formatted date here would
   *  bake in a locale the caller may not want. */
  timestamp: number;
}

// ---------------------------------------------------------------------------------------------
// Resolving an agent to a (repo, base, head)
// ---------------------------------------------------------------------------------------------

/** What a diff read needs, resolved from the agent's own row rather than from caller-supplied refs.
 *  A concierge that could name arbitrary refs would be a general-purpose git reader; it only ever
 *  needs to answer "what did THIS agent change", so it names an agent and the app resolves the rest. */
interface DiffTarget {
  cwd: string;
  base: string;
  head: string;
}

/**
 * Locate an agent and derive its diff range.
 *
 * Reads the project ROOT rather than the agent's worktree: `base...head` is computed from refs, both
 * of which exist in the main repo, and the worktree may have been torn down while the branch (and
 * therefore the work) survives — which is precisely the state AGENTS.md warns about, where a killed
 * worker's branch is still evidence. Reading from the root means a spun-down agent's change is still
 * inspectable.
 *
 * A WORKER'S BASE IS ITS PARENT'S BRANCH, NOT THE PROJECT DEFAULT. The store records
 * `baseBranch: project.defaultBranch` for a worker even though `create_worktree_from_local` cuts its
 * branch from the PARENT's branch — `parentBranch` is the field that carries the truth, which is why
 * `resolveLandTarget` and the runtime store both read it. Using `baseBranch` here made the merge
 * base "where the ORCHESTRATOR branched from main", so a worker that touched one file reported the
 * orchestrator's forty commits and every sibling's merged work as its own, and `list_commits` listed
 * the orchestrator's subjects as the worker's. That is exactly the mis-attribution the three-dot
 * range exists to prevent, reintroduced through the wrong base (roborev 55193).
 */
function targetFor(agentId: string): DiffTarget | null {
  for (const project of useProjectStore.getState().projects) {
    const agent = project.agents?.find((a) => a.id === agentId);
    if (!agent) continue;
    if (!project.rootPath) return null;
    const base =
      agent.kind === "worker" && agent.parentId
        ? agent.parentBranch || agentBranchName(agent.parentId)
        : agent.baseBranch?.trim() || project.defaultBranch?.trim() || "main";
    return { cwd: project.rootPath, base, head: agentBranchName(agentId) };
  }
  return null;
}

/** The one refusal shared by every op: an id the app does not hold. Distinguished from "the agent
 *  exists but has no commits", which is a successful read of an empty change. */
function unknownAgent(op: DiffOp, agentId: string): DiffRefusal {
  return refuse(
    op,
    "unknown-agent",
    `I don't have an agent with id ${agentId}. Use the agent roster to get a current id — ` +
      `ids are not stable across app restarts for agents that were never persisted.`,
  );
}

async function attempt<T>(op: DiffOp, run: () => Promise<T>): Promise<DiffResult<T>> {
  try {
    return ok(op, await run());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // WHICH ref failed to resolve decides what we may claim. Both surface as git's one "ambiguous
    // argument" message, but the first is a statement about the AGENT and the second about the
    // REPO — and reporting a missing base as "it hasn't committed anything" tells the human an
    // agent did no work while its branch sits there with commits on it. The Rust side rev-parses
    // each ref and names which one, so this classifies on a fact rather than on a regex over a
    // message that cannot distinguish them (roborev 55193).
    if (message.startsWith("missing-head")) {
      return refuse(
        op,
        "no-branch",
        "That agent doesn't have a branch yet — it hasn't committed anything. There's nothing to " +
          "diff until it does.",
      );
    }
    if (message.startsWith("missing-base")) {
      const ref = message.slice("missing-base:".length).trim();
      return refuse(
        op,
        "missing-base",
        `I can't resolve ${ref || "the base branch"} in this repo, so I can't work out what's this ` +
          `agent's own work and what it inherited. The agent may well have commits — this is a ` +
          `problem with the base ref, not with the agent. Fetching, or correcting the project's ` +
          `default branch, should fix it.`,
      );
    }
    return refuse(op, "git-failed", message);
  }
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

/**
 * The files an agent changed, with per-file line counts.
 *
 * This is the op that answers the question most of the time. "It touched pty.rs and its test" is
 * what someone wants when they ask what an agent did; the patch text is a follow-up, not the answer.
 */
export async function listChangedFiles(
  agentId: string,
  limit?: number,
): Promise<DiffResult<ChangedFiles>> {
  const target = targetFor(agentId);
  if (!target) return unknownAgent("list_changed_files", agentId);
  return attempt("list_changed_files", () =>
    invoke<ChangedFiles>("diff_files", { ...target, limit: limit ?? null }),
  );
}

/**
 * One file's patch text.
 *
 * Capped by lines AND chars on the Rust side; `truncated` and `omittedLines` are part of the answer
 * rather than diagnostics, because a caller that cannot tell a whole file from its first 400 lines
 * will describe a fragment as the change.
 */
export async function readFileDiff(
  agentId: string,
  path: string,
  maxLines?: number,
): Promise<DiffResult<FileDiff>> {
  const target = targetFor(agentId);
  if (!target) return unknownAgent("read_file_diff", agentId);
  if (!path?.trim()) {
    return refuse(
      "read_file_diff",
      "bad-args",
      "Which file? Call list_changed_files first and name one of the paths it returns.",
    );
  }
  return attempt("read_file_diff", () =>
    invoke<FileDiff>("diff_file_text", { ...target, path, maxLines: maxLines ?? null }),
  );
}

/** The commits on the agent's branch that are not on its base — its own work, newest first. */
export async function listCommits(
  agentId: string,
  limit?: number,
): Promise<DiffResult<CommitRow[]>> {
  const target = targetFor(agentId);
  if (!target) return unknownAgent("list_commits", agentId);
  return attempt("list_commits", () =>
    invoke<CommitRow[]>("diff_commits", { ...target, limit: limit ?? null }),
  );
}

// NO DESCRIPTOR ARRAY HERE, DELIBERATELY.
//
// The terminal domain publishes `CONCIERGE_TERMINAL_TOOLS` because the registry READS it — that
// domain's op list and write flags are derived from the descriptors. This domain's are derived from
// `DIFF_OPS` and `DIFF_RISK`, so a descriptor array here would have no consumer, and the text a
// model actually reads before calling is the `sparkle_diff` description in mcp-control's server.ts.
// Keeping an unread copy would invite exactly the drift the last four reviews were spent on: a test
// pinning the local string would go green while the string the model reads said something else
// entirely (roborev 55193). The assertions live in `mcp-control/src/server.test.ts`, on the copy
// that is actually read.
