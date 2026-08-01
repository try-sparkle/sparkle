// The PURE half of local→cloud promotion (plan contract D; spec
// docs/superpowers/specs/2026-07-31-agent-promotion-design.md). No IO, no store, no Tauri: it takes
// the agent record, a preflight reading, the cloud gate's verdict and the live worker count, and
// answers two questions —
//
//   1. May this agent be promoted at all, and if not, WHY (in words the user can act on)?
//   2. If it may, what must the user READ before they are allowed to confirm?
//
// (2) is the load-bearing half. Promotion moves work between machines, and the things it does NOT
// carry (.gitignore'd files, stashes, live workers) are exactly the things a user assumes travel.
// The dialog renders `warnings[]` verbatim before enabling its confirm button, so a warning missing
// here is a silent data loss there — which is why they live in a pure, exhaustively-tested function
// rather than in JSX.

import type { CloudGate } from "../cloudAgents/gating";
import type { CategoryId } from "../../stores/uiStore";
import type { PromotionPreflight } from "./rust";

/** What to do with uncommitted files. Defaulted to `commit` by the dialog — a commit loses nothing,
 *  and losing work is the failure mode this whole feature is designed against (spec Decision 1). */
export type DirtyPolicy = "commit" | "leave";

export type PromotionRefusal =
  /** Already cloud, or a shell agent (no conversation and no branch — nothing to move). */
  | "not_local"
  | "no_worktree"
  | "no_branch"
  | "no_remote"
  /** Local `origin` is not the repo the sandbox will clone. */
  | "remote_mismatch"
  | "detached_head"
  /** `evaluateCloudGate` said no — carries the gate's OWN message and deep link, not new copy. */
  | "cloud_gate";

/** The agent fields promotion planning reads. A full `AgentTab` satisfies this structurally. */
export interface PromotionAgent {
  id: string;
  /**
   * OPTIONAL and tested against `"cloud"`, never against `"local"` — this repo's convention is that
   * an unknown runtime is NOT a claim of remoteness (`conciergeDispatch`: "`runtime: 'unknown'` …
   * says 'no record names the runtime', not 'it is remote'"; `registry` normalizes with
   * `a.runtime ?? "local"`; `addAgent` defaults the same way). A rehydrated record with no runtime,
   * or a caller passing `"unknown"`, would otherwise be refused with the factually false sentence
   * "This agent is already running in the cloud."
   */
  runtime?: string;
  kind: string;
  worktreePath: string | null;
  branch: string | null;
  goal?: { text?: string } | null;
  name: string;
}

export interface PromotionPlanInput {
  agent: PromotionAgent;
  /** `null` when the preflight could not be read at all (the Tauri call failed / never ran). */
  preflight: PromotionPreflight | null;
  gate: CloudGate;
  /** Live workers owned by this agent. They stay LOCAL; the user must be told (spec §Not in scope). */
  workerCount: number;
  /**
   * The repo the SANDBOX will clone — the exact URL the caller will pass to `/sessions/start`.
   *
   * This module is pure, so the caller resolves it (`services/cloudAgents/repoUrl`, i.e. what
   * `gh repo view` reports) and passes it in. It MUST be the same value that is later sent as
   * `repoUrl`: resolving it twice independently would let this guard pass while a different repo is
   * cloned, which is the single failure the guard exists to prevent.
   *
   * `null` means "we could not determine it", which is UNKNOWN, not "it matches".
   */
  projectRepoUrl: string | null;
}

export type PromotionPlan =
  | {
      ok: false;
      refusal: PromotionRefusal;
      message: string;
      deepLink?: CategoryId;
      /** Carried through from the gate. The `signed_out` block is exactly the one with NO deep
       *  link — its fix is a sign-in hand-off — so dropping this would leave the dialog telling the
       *  user to sign in with no route to doing so. */
      needsSignIn?: boolean;
    }
  | {
      ok: true;
      branch: string;
      dirtyCount: number;
      dirtyFiles: string[];
      unpushed: number;
      /** Warnings the confirm dialog MUST render before the user can proceed. */
      warnings: string[];
      workerCount: number;
    };

/** The WIP commit message. Exported so the dialog can show it verbatim — the user is told exactly
 *  what will land in their history, and `git reset --soft HEAD~1` puts it right back. */
export const WIP_COMMIT_MESSAGE = "Sparkle: WIP before cloud promotion";

/** How many dirty paths a warning line names before it says "+N more". The full list is rendered
 *  separately by the dialog; this keeps the warning readable. */
const DIRTY_SAMPLE = 10;

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function sampleFiles(files: string[], total: number): string {
  const shown = files.slice(0, DIRTY_SAMPLE);
  // `total` is the TRUE count and `files` is capped Rust-side, so the remainder is measured against
  // the total — otherwise a 200-file tree with a 50-file list would claim only "+40 more".
  const rest = total - shown.length;
  const list = shown.join(", ");
  return rest > 0 ? `${list} (+${rest} more)` : list;
}

/**
 * Decide refusal-vs-proceed, and on proceed produce the warnings the dialog must render.
 *
 * Refusal ORDER is deliberate and reads outside-in: what kind of agent is this (not_local) → may
 * this account use the cloud at all (cloud_gate) → is there a workspace to read (no_worktree) → is
 * that workspace in a promotable git state (detached_head → no_branch → no_remote). Each check is
 * only meaningful once the previous one passed, so surfacing them in this order always names the
 * thing the user has to fix FIRST rather than a downstream symptom of it.
 */
/**
 * Canonical form for comparing a git remote to a clone URL: lowercase host, no trailing slash, no
 * `.git` suffix, and `git@host:owner/repo` folded into `https://host/owner/repo`.
 *
 * Exported and separately tested, because "equal" has to mean the same thing to the rule and to its
 * test. Anything it cannot parse is returned trimmed and lowercased rather than thrown away — an
 * unparseable URL that differs textually should still refuse.
 */
export function normalizeRepoUrl(url: string): string {
  const trimmed = url.trim();
  // scp-style SSH (`git@github.com:owner/repo.git`) has no scheme for URL() to work with.
  const scp = /^[\w.-]+@([^:]+):(.+)$/.exec(trimmed);
  const withScheme = scp ? `https://${scp[1]}/${scp[2]}` : trimmed;
  let host = "";
  let path = withScheme;
  try {
    const u = new URL(withScheme.replace(/^ssh:\/\//, "https://"));
    host = u.host.toLowerCase();
    path = u.pathname;
  } catch {
    return trimmed.toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
  }
  path = path.replace(/\.git$/, "").replace(/\/+$/, "");
  return `${host}${path}`.toLowerCase();
}

export function planPromotion(input: PromotionPlanInput): PromotionPlan {
  const { agent, preflight, gate, workerCount, projectRepoUrl } = input;

  // `=== "cloud"`, not `!== "local"` — see PromotionAgent.runtime. Only a POSITIVE claim of
  // remoteness refuses; absent/unknown reads as local, which is what the rest of the app assumes.
  if (agent.runtime === "cloud") {
    return {
      ok: false,
      refusal: "not_local",
      message: "This agent is already running in the cloud.",
    };
  }
  if (agent.kind === "shell") {
    return {
      ok: false,
      refusal: "not_local",
      message:
        "Shell agents can't be promoted — they have no conversation and no branch, so there's nothing to move.",
    };
  }
  if (!gate.ok) {
    // The gate's own message + deep link, carried through unchanged. A second copy of this copy is
    // how the two surfaces drift apart about what the user must fix.
    return {
      ok: false,
      refusal: "cloud_gate",
      message: gate.message,
      ...(gate.deepLink ? { deepLink: gate.deepLink } : {}),
      ...(gate.needsSignIn ? { needsSignIn: true } : {}),
    };
  }
  if (!agent.worktreePath) {
    return {
      ok: false,
      refusal: "no_worktree",
      message: "This agent has no worktree, so there's nothing to push or clone.",
    };
  }
  if (!preflight) {
    // The preflight command failed or never ran. We know nothing about the git state, and every
    // check below would be a guess — refuse under the same "no readable workspace" heading rather
    // than inventing a more specific reason we cannot support.
    return {
      ok: false,
      refusal: "no_worktree",
      message: "Couldn't read this agent's worktree — promotion needs its git state to continue.",
    };
  }
  if (preflight.detached) {
    return {
      ok: false,
      refusal: "detached_head",
      message:
        "This worktree is on a detached HEAD. Promotion needs a branch the sandbox can check out.",
    };
  }
  const branch = preflight.branch || agent.branch || "";
  if (!preflight.branchExists || !branch) {
    return {
      ok: false,
      refusal: "no_branch",
      message: "This agent has no branch yet, so there's nothing for the sandbox to check out.",
    };
  }
  if (!preflight.hasRemote) {
    return {
      ok: false,
      refusal: "no_remote",
      message:
        "This project has no `origin` remote. A cloud sandbox clones from a remote, so there's nothing for it to clone.",
    };
  }

  // We push to the LOCAL `origin`; the sandbox clones the URL the start request carries (what `gh
  // repo view` reported for this checkout). They can differ — a fork whose `origin` is your copy
  // while `gh` names upstream, or an SSH remote for another repo — and then `git clone --branch`
  // finds no such branch in the sandbox. Because `startSession` is fire-and-forget, that surfaces
  // only as an await-live timeout, long AFTER the WIP commit and the push. So it is refused here,
  // before anything is written. Either side unknown is a refusal, not a match.
  if (!projectRepoUrl || !preflight.originUrl) {
    return {
      ok: false,
      refusal: "remote_mismatch",
      message:
        "Couldn't confirm this project's GitHub repo matches its `origin` remote, so the cloud sandbox might clone the wrong thing.",
    };
  }
  if (normalizeRepoUrl(preflight.originUrl) !== normalizeRepoUrl(projectRepoUrl)) {
    return {
      ok: false,
      refusal: "remote_mismatch",
      message:
        "This project's `origin` remote isn't the repo the cloud sandbox would clone, so your branch wouldn't be there. Point `origin` at the same repo and try again.",
    };
  }

  const { dirtyCount, dirtyFiles, unpushed } = preflight;
  const warnings: string[] = [];

  if (dirtyCount > 0) {
    warnings.push(
      `Uncommitted changes — ${plural(dirtyCount, "file")}: ${sampleFiles(dirtyFiles, dirtyCount)}. ` +
        `With "Commit them" (the default) they're committed to ${branch} as "${WIP_COMMIT_MESSAGE}" and travel with the agent.`,
    );
    warnings.push(
      `With "Leave them behind", those ${plural(dirtyCount, "file")} stay in the worktree on this Mac and do NOT travel to the cloud. ` +
        `Promotion doesn't delete the worktree, so they stay on disk here.`,
    );
  }

  // Always. These never travel whether the tree is dirty or clean, and a user who assumes their
  // .env.local came along will spend the next hour debugging the sandbox instead of their code.
  warnings.push(
    "Files ignored by .gitignore (.env.local, build caches) and any `git stash` entries do NOT travel. " +
      "They're local-machine state, and carrying them would ship secrets into a sandbox.",
  );

  if (workerCount > 0) {
    warnings.push(
      `This agent has ${plural(workerCount, "live worker")}. Workers stay LOCAL — they're separate agents in their own worktrees and are not promoted.`,
    );
  }

  if (unpushed > 0) {
    warnings.push(
      `${plural(unpushed, "commit")} on ${branch} ${unpushed === 1 ? "is" : "are"} not on origin yet and will be pushed to origin.`,
    );
  }

  return { ok: true, branch, dirtyCount, dirtyFiles, unpushed, warnings, workerCount };
}

/**
 * The prompt sent into the cloud session AFTER cutover (spec Decision 4 — the nudge is the LAST
 * step, so the sandbox Claude has nothing to do until the local PTY is already dead).
 *
 * It must read as CONTINUITY, not as a new brief, and it must tell the agent the truth about
 * whether its conversation came with it: a resumed agent should pick up mid-thought, while an
 * amnesiac one has to re-orient from git before it touches anything — and must say it doesn't
 * remember rather than confabulate a history it never had.
 */
export function handoffNudge(a: {
  name: string;
  branch: string;
  hadTranscript: boolean;
  /** The transferred transcript lost its OLDEST turns to the byte cap. Must be said out loud: an
   *  agent told "the history above is your own" will otherwise reference decisions that were
   *  silently cut, and confabulate rather than admit it can't see them. */
  transcriptTruncated?: boolean;
  /** Uncommitted files the user deliberately left on the Mac (`dirtyPolicy: "leave"`). They are NOT
   *  in this clone, and an agent told otherwise will act on a working copy missing its own edits. */
  leftBehind?: number;
  goal?: string;
}): string {
  const goal = a.goal?.trim();
  const goalLine = goal ? `\n\nYour goal, unchanged: ${goal}` : "";
  const localOnly =
    "Local-only state did not travel: files ignored by .gitignore (.env.local, build caches) and any `git stash` entries.";

  // The dirty policy is a first-class, dialog-offered choice, so the sentence describing it has to
  // branch with it. Claiming "any uncommitted work was committed" under "leave" is simply false.
  const left = a.leftBehind ?? 0;
  const workState =
    left > 0
      ? `${plural(left, "uncommitted file")} ${left === 1 ? "was" : "were"} deliberately left on the user's Mac and ${left === 1 ? "is" : "are"} NOT in this clone — do not assume edits you were part-way through are here.`
      : "Any uncommitted work was committed before the move, so `git log -1` shows where you actually are.";

  if (a.hadTranscript) {
    const truncationLine = a.transcriptTruncated
      ? `Your conversation was TRUNCATED to fit: the oldest turns were dropped. If something you need predates what you can see, say so rather than guessing — \`git log\` and this branch's PRD/ doc are the authority for anything earlier.\n\n`
      : "";
    return [
      `You've just been moved from a worktree on the user's Mac into a cloud sandbox. You are the same agent — same name (${a.name}), same branch (${a.branch}), same work. Nothing about the task changed; only where you run.`,
      `Your conversation came with you: the history above this line is your own. Read back through it rather than starting over.`,
      `${truncationLine}Your working copy is a fresh clone of ${a.branch} at the commit you were on. ${workState} ${localOnly}`,
      `Pick up exactly where you left off. Don't re-plan from scratch and don't re-introduce yourself.${goalLine}`,
    ].join("\n\n");
  }

  return [
    `You've just been moved from a worktree on the user's Mac into a cloud sandbox, and your conversation did NOT come with you — this session has no memory of what you and the user discussed. Be straight with them about that; don't reconstruct a history you don't have.`,
    `What you do know: you are ${a.name}, working on branch ${a.branch}, which is checked out here. ${workState} ${localOnly}`,
    `Re-orient before you change anything: read \`git log --oneline -20\`, the diff against the base branch, and this branch's progress doc under PRD/. Then continue the work.${goalLine}`,
  ].join("\n\n");
}
