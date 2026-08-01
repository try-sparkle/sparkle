// The copy-then-cut state machine for local→cloud promotion (plan contract D; spec Decisions 4+5).
//
// Promotion is NOT a move. It is a copy followed by a cut, and the cut happens exactly once, last,
// after the cloud side has been OBSERVED live. Every step before it is ordered so that its failure
// leaves the local agent running and untouched — which is the entire safety argument of this
// feature, and the reason this file is a state machine over injected deps rather than a function
// that calls things:
//
//   preflight → commit (only if policy is "commit" AND the tree is dirty) → push → read transcript
//   → POST /sessions/start → AWAIT FIRST OUTPUT FRAME → RE-READ THE WORKTREE → kill the local PTY
//   → flip runtime to cloud → send the handoff nudge
//
// Five invariants, each with a test that fails if it is broken:
//
//   1. `killLocalPty` runs strictly AFTER `awaitFirstFrame` resolves, and NEVER on any failure path.
//      Asserting only that the happy path kills it would be vacuous — a machine that killed first
//      would pass that. The tests assert the ORDER (call-log indices) and non-invocation per branch.
//   2. The worktree is re-read between the first frame and the cut, and a tree that MOVED since the
//      push refuses the cut. The local agent runs and writes throughout the copy window (up to two
//      minutes), so without this the cut destroys anything it wrote after the push while the
//      sandbox resumes from a stale ref — the same silent work loss this feature exists to prevent,
//      merely relocated to the last step.
//   3. A failure or timeout in `await_live` DELETEs the started session, so a session that came up
//      after we stopped waiting does not sit there running and billing. When that delete ALSO fails
//      the result carries `orphanedSessionId` — the same contract `cloudAgents/create.ts` follows.
//   4. `setRuntimeCloud` runs exactly once, after the kill.
//   5. NOTHING after the cut may turn the promotion into a failure. Every failure message here ends
//      with "your agent is still running locally", and past the cut that is false — so a store flip
//      or a nudge that throws is reported as a promotion that HAPPENED and needs reconciling.
//
// `awaitFirstFrame` is a DEP, not something implemented here: the real one attaches a
// CloudTransport and waits for the first `agent_output` frame (see live.ts). Keeping it behind the
// seam is what lets every case below be tested with no Tauri, no network and no relay.

import type { StartSessionInput } from "../cloudAgents/api";
import { classifyStartError } from "../cloudAgents/startError";
import { handoffNudge, WIP_COMMIT_MESSAGE, type DirtyPolicy } from "./plan";
import type { PromotionPreflight, PromotionTranscript, PushOutcome } from "./rust";

export type PromotionStep =
  | "preflight"
  | "commit"
  | "push"
  | "transcript"
  | "start"
  | "await_live"
  | "cutover";

/**
 * How long to wait for the cloud session's first output frame before giving up and deleting it.
 * Generous on purpose: the server has to allocate a sandbox, clone the repo and start Claude, and
 * the cost of waiting too long is a spinner, while the cost of giving up too early is a deleted
 * session the user has to promote all over again.
 */
export const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 120_000;

export interface PromoteInput {
  /** The desktop tab id. It becomes the SERVER session id — one id, one agent (spec Decision 3). */
  agentId: string;
  /** The DESKTOP project id (used for the store flip). */
  projectId: string;
  /** The ORCHESTRATION-side project id (`/sessions/start` 404s on one the caller doesn't own). */
  cloudProjectId: string;
  /** Repo root — the push runs from here. */
  root: string;
  /** The agent's worktree — the WIP commit and the transcript read happen here. */
  worktree: string;
  /** The branch as the confirm dialog resolved it (the live preflight below wins if it differs). */
  branch: string;
  baseBranch: string;
  repoUrl: string;
  /** The agent's display name, for the handoff nudge. */
  agentName: string;
  /** The agent's goal text, if it has one. */
  goal?: string;
  /** What the user chose for uncommitted files. Never inferred — the dialog always asks. */
  dirtyPolicy: DirtyPolicy;
  awaitFirstFrameMs?: number;
}

export interface PromoteDeps {
  preflight(a: {
    root: string;
    agentId: string;
    worktree: string;
    baseBranch: string;
  }): Promise<PromotionPreflight>;
  commitDirty(a: { worktree: string; message: string }): Promise<number>;
  /** Resolves the {@link PushOutcome}; rejects with the git error verbatim (and on an
   *  unrecognized result, so an unpushed branch can never be mistaken for a pushed one). */
  pushBranch(a: { root: string; branch: string }): Promise<PushOutcome>;
  readTranscript(a: { worktree: string }): Promise<PromotionTranscript | null>;
  startSession(input: StartSessionInput): Promise<{ sessionId: string }>;
  /** Resolves on the first `agent_output` frame for the session; rejects on deadline or error. */
  awaitFirstFrame(a: { sessionId: string; timeoutMs: number }): Promise<void>;
  /** `DELETE /sessions/:id` — used only to clean up a session we are abandoning. */
  deleteSession(sessionId: string): Promise<void>;
  /** THE CUT. Ends the local PTY. Called once, last, and never on a failure path. */
  killLocalPty(agentId: string): Promise<void>;
  /** `projectStore.setAgentRuntime(projectId, agentId, "cloud")` — mutates the tab in place. */
  setRuntimeCloud(a: { projectId: string; agentId: string }): void;
  /**
   * Fires as each step BEGINS, so a caller can name the step it is on while the machine runs.
   * Optional and purely observational — the machine's behaviour must not depend on it, and a
   * throwing observer must not be able to abort a promotion, so every call is guarded.
   *
   * It matters more than a progress spinner usually would: the whole safety story is an ORDER
   * (spec Decision 5), and the step a failure names is what tells the user whether their branch was
   * touched. Without this the dialog can only say "it failed".
   */
  onStep?(step: PromotionStep): void;
  /** Write the handoff nudge into the now-live cloud session. */
  sendHandoff(a: { sessionId: string; text: string }): void | Promise<void>;
}

export type PromoteResult =
  | {
      ok: true;
      sessionId: string;
      transcriptMoved: boolean;
      /** The transferred transcript lost its oldest turns to the byte cap. Surfaced so the UI can
       *  say so — `rust.ts` documents truncation as "reported, not hidden". */
      transcriptTruncated: boolean;
      committed: number;
      /** The cut SUCCEEDED but the store flip did not: the agent is in the cloud while its tab
       *  still reads `runtime: "local"`. The promotion happened — the UI must reconcile the tab,
       *  not offer a retry that would start a second session. */
      runtimeFlipFailed?: true;
    }
  | {
      ok: false;
      step: PromotionStep;
      message: string;
      /** Set when a session is RUNNING server-side that we could not clean up. Not retry-safe:
       *  promoting again would start (and bill) a second one. Mirrors `createCloudAgent`. */
      orphanedSessionId?: string;
    };

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** The one sentence that tells a user their WIP commit is safe. A push failure leaves a local,
 *  non-destructive commit behind, and a user who isn't told that will assume their work vanished. */
function committedNote(committed: number): string {
  if (committed <= 0) return "";
  return ` Your ${committed === 1 ? "change was" : "changes were"} committed locally as "${WIP_COMMIT_MESSAGE}" — nothing is lost, and \`git reset --soft HEAD~1\` puts it back if you want it uncommitted.`;
}

/** The tail every failure message carries: the point of the ordering is that this is always true. */
const STILL_LOCAL = " Your agent is still running locally.";

/**
 * Abandon a session we started but cannot hand over. Deletes it so it stops billing; if the delete
 * also fails the session id goes into the visible record and the result is marked non-retry-safe.
 */
async function abandon(
  deps: PromoteDeps,
  sessionId: string,
  step: PromotionStep,
  message: string,
): Promise<PromoteResult> {
  try {
    await deps.deleteSession(sessionId);
    return { ok: false, step, message };
  } catch (e) {
    console.warn("[promotion] started session could not be deleted", {
      sessionId,
      step,
      reason: errText(e),
    });
    return {
      ok: false,
      step,
      message: `${message} A cloud session (${sessionId}) may still be running — don't promote again until it's stopped.`,
      orphanedSessionId: sessionId,
    };
  }
}

/** Fire the step observer without letting it break the machine. */
function note(deps: PromoteDeps, step: PromotionStep): void {
  try {
    deps.onStep?.(step);
  } catch (e) {
    console.warn("[promotion] step observer threw", { step, reason: errText(e) });
  }
}

/**
 * Promote a running LOCAL agent into the cloud. Resolves a result rather than throwing: every
 * failure is a value carrying the step that failed and a sentence the user can act on, and in every
 * one of them the local agent is still running.
 */
export async function promoteAgentToCloud(
  input: PromoteInput,
  deps: PromoteDeps,
): Promise<PromoteResult> {
  // ── preflight ────────────────────────────────────────────────────────────────────────────────
  // Re-read the worktree HERE rather than trusting the dialog's reading: the user may have saved a
  // file (or switched branches) between opening the dialog and confirming, and "commit only if the
  // tree is dirty" has to be decided against what is on disk NOW.
  note(deps, "preflight");
  let pf: PromotionPreflight;
  try {
    pf = await deps.preflight({
      root: input.root,
      agentId: input.agentId,
      worktree: input.worktree,
      baseBranch: input.baseBranch,
    });
  } catch (e) {
    return { ok: false, step: "preflight", message: `Couldn't read the worktree: ${errText(e)}.${STILL_LOCAL}` };
  }

  if (pf.detached) {
    return {
      ok: false,
      step: "preflight",
      message: `This worktree is on a detached HEAD, so there's no branch for the sandbox to check out.${STILL_LOCAL}`,
    };
  }
  if (!pf.hasRemote) {
    return {
      ok: false,
      step: "preflight",
      message: `This project has no \`origin\` remote, so there's nothing for a sandbox to clone.${STILL_LOCAL}`,
    };
  }
  // The freshly-resolved branch wins over the dialog's: the sandbox must check out what the
  // worktree is actually on, not what it was on when the dialog opened.
  const branch = pf.branch || input.branch;
  if (!branch) {
    return {
      ok: false,
      step: "preflight",
      message: `This agent has no branch to push.${STILL_LOCAL}`,
    };
  }

  // ── commit ───────────────────────────────────────────────────────────────────────────────────
  // Only when the user chose "commit" AND there is something to commit. Runs in the WORKTREE and
  // BEFORE the push, so the push carries it.
  note(deps, "commit");
  let committed = 0;
  if (input.dirtyPolicy === "commit" && pf.dirtyCount > 0) {
    try {
      committed = await deps.commitDirty({ worktree: input.worktree, message: WIP_COMMIT_MESSAGE });
    } catch (e) {
      return {
        ok: false,
        step: "commit",
        message: `Couldn't commit your uncommitted changes: ${errText(e)}. Nothing was changed.${STILL_LOCAL}`,
      };
    }
  }

  // ── push ─────────────────────────────────────────────────────────────────────────────────────
  note(deps, "push");
  try {
    const outcome = await deps.pushBranch({ root: input.root, branch });
    if (outcome === "no-remote") {
      return {
        ok: false,
        step: "push",
        message: `Couldn't push ${branch}: this project has no \`origin\` remote.${committedNote(committed)}${STILL_LOCAL}`,
      };
    }
  } catch (e) {
    return {
      ok: false,
      step: "push",
      message: `Couldn't push ${branch} to origin: ${errText(e)}.${committedNote(committed)}${STILL_LOCAL}`,
    };
  }

  // ── transcript ───────────────────────────────────────────────────────────────────────────────
  // NEVER fatal (spec Decision 2). A transcript that cannot be read means the cloud agent starts
  // without its memory and the handoff nudge says so — it does not mean the promotion fails.
  note(deps, "transcript");
  let transcript: PromotionTranscript | null = null;
  try {
    transcript = await deps.readTranscript({ worktree: input.worktree });
  } catch (e) {
    console.warn("[promotion] transcript unreadable; promoting without the conversation", {
      agentId: input.agentId,
      reason: errText(e),
    });
    transcript = null;
  }
  const transcriptMoved = transcript !== null;

  // ── start ────────────────────────────────────────────────────────────────────────────────────
  // `goal` is required and non-empty server-side, but the runner deliberately does NOT write it to
  // a promoted session's stdin (contract B) — the session comes up idle, which is what closes the
  // two-Claudes window. So this is a recorded label, not an instruction.
  note(deps, "start");
  const goal = input.goal?.trim() || `Continue the work in progress on ${branch}.`;
  let sessionId: string;
  try {
    ({ sessionId } = await deps.startSession({
      projectId: input.cloudProjectId,
      goal,
      repoUrl: input.repoUrl,
      name: input.agentName,
      promotion: {
        sessionId: input.agentId,
        branch,
        ...(transcript
          ? { transcript: { sessionId: transcript.sessionId, jsonl: transcript.jsonl } }
          : {}),
      },
    }));
  } catch (e) {
    return { ok: false, step: "start", message: `${classifyStartError(e).message}${STILL_LOCAL}` };
  }

  // The server is supposed to ECHO the id we supplied (spec Decision 3). If it minted a different
  // one we have a split identity — two keys for one agent — which is worse than a refusal. Abandon
  // the session we can't adopt rather than silently carrying a second id on the tab.
  if (sessionId !== input.agentId) {
    return abandon(
      deps,
      sessionId,
      "start",
      `The server started a different session (${sessionId}) than this agent's id, so it can't be adopted.${STILL_LOCAL}`,
    );
  }

  // ── await_live ───────────────────────────────────────────────────────────────────────────────
  // The literal definition of "the cloud side is up": a first `agent_output` frame. Nothing below
  // this line may run until it arrives, and the local PTY is still serving the user throughout.
  note(deps, "await_live");
  try {
    await deps.awaitFirstFrame({
      sessionId,
      timeoutMs: input.awaitFirstFrameMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS,
    });
  } catch (e) {
    return abandon(
      deps,
      sessionId,
      "await_live",
      `The cloud agent didn't come up: ${errText(e)}.${STILL_LOCAL}`,
    );
  }

  // ── cutover ──────────────────────────────────────────────────────────────────────────────────
  // VERIFY, THEN CUT. The local agent has been running and writing this whole time — through the
  // commit, the push, the start, and up to two minutes of waiting for the sandbox. Anything it
  // wrote or committed AFTER the push is not on `origin`, so killing it now would destroy work
  // while the sandbox resumes from a stale ref whose transferred transcript describes changes the
  // clone does not contain. That is the exact silent loss this feature exists to prevent, merely
  // relocated to the last step, so the tree is re-read here and a race REFUSES the cut.
  //
  // The discriminators are chosen so each is unambiguous:
  //   • `unpushed > 0` — a successful push leaves zero, whatever the dirty policy. A new local
  //     commit during the window is the clearest possible signal.
  //   • `dirtyCount > 0`, but ONLY under the "commit" policy: `git add -A` left the tree clean, so
  //     anything dirty now is new. Under "leave" the pre-existing dirty files are still there by
  //     the user's own choice, and are indistinguishable from new writes — nothing to assert.
  //   • the branch moved out from under us.
  // Refusing costs the user a retry; not refusing costs them their work.
  note(deps, "cutover");
  let post: PromotionPreflight;
  try {
    post = await deps.preflight({
      root: input.root,
      agentId: input.agentId,
      worktree: input.worktree,
      baseBranch: input.baseBranch,
    });
  } catch (e) {
    // We cannot prove nothing changed, so we must not cut. Fail closed.
    return abandon(
      deps,
      sessionId,
      "cutover",
      `Couldn't re-check the worktree before stopping the local agent: ${errText(e)}.${STILL_LOCAL}`,
    );
  }
  //
  // POSITIVE PROOF, not absence of evidence. Every numeric/boolean field here degrades to
  // `0`/`false`/`""` when the payload is missing or malformed (see `normalizePreflight`), which is
  // conservative for the FIRST preflight — it refuses — and the exact opposite for this one: a
  // renamed or dropped field on the parallel-branch Rust side would make every discriminator read
  // "nothing changed" and wave the cut through. So the branch identity must be affirmatively
  // confirmed before any counter is trusted, and an unresolved branch (which is also what a
  // mid-rebase detached HEAD looks like) is a refusal rather than a pass.
  if (post.detached || !post.branchExists || post.branch !== branch) {
    // Three different triggers had one sentence between them, and it asserted the one thing that
    // need not be true: a worktree that SWITCHED branches has no unpushed changes on the old one.
    // Same defect this module just fixed in `handoffNudge` — copy describing an edge the machine
    // didn't take.
    const message =
      !post.detached && post.branchExists && post.branch !== ""
        ? `The worktree is now on ${post.branch}, not ${branch}, so the branch that was pushed is no longer the one your agent is working on. Nothing was moved and nothing was lost — promote again.${STILL_LOCAL}`
        : `Couldn't confirm the worktree is still on ${branch} before stopping the local agent. Nothing was moved and nothing was lost — promote again.${STILL_LOCAL}`;
    return abandon(deps, sessionId, "cutover", message);
  }
  if (post.unpushed > 0 || (input.dirtyPolicy === "commit" && post.dirtyCount > 0)) {
    return abandon(
      deps,
      sessionId,
      "cutover",
      `Your agent kept working while the cloud sandbox was starting, so there are changes on ${branch} that were never pushed. Nothing was moved and nothing was lost — promote again to bring them along.${STILL_LOCAL}`,
    );
  }

  // THE CUT. Everything above is proven; this is the only irreversible step, and it is last.
  try {
    await deps.killLocalPty(input.agentId);
  } catch (e) {
    // The cut itself failed, so BOTH sides would be alive on one branch. Stand the cloud session
    // down and leave the user exactly where they started rather than in that state.
    return abandon(
      deps,
      sessionId,
      "cutover",
      `Couldn't stop the local agent: ${errText(e)}.${STILL_LOCAL}`,
    );
  }

  // PAST THE POINT OF NO RETURN. The local PTY is dead and the cloud session is live, so nothing
  // below may turn this into a failure: every failure message in this file ends with "your agent is
  // still running locally", and from here that sentence is false. A flip that throws (or a tab
  // removed during the wait) is reported as a successful promotion the UI must RECONCILE, not as a
  // promotion that didn't happen.
  let runtimeFlipped = true;
  try {
    deps.setRuntimeCloud({ projectId: input.projectId, agentId: input.agentId });
  } catch (e) {
    runtimeFlipped = false;
    console.warn("[promotion] runtime flip failed after the cut — tab still reads local", {
      agentId: input.agentId,
      sessionId,
      reason: errText(e),
    });
  }

  // The nudge is LAST, after the flip — a promoted session comes up idle precisely so that nothing
  // instructs the cloud Claude until the local one is gone. A nudge that fails to send is not a
  // failed promotion: the cutover already happened and the user can simply type to the agent.
  try {
    await deps.sendHandoff({
      sessionId,
      text: handoffNudge({
        name: input.agentName,
        branch,
        hadTranscript: transcriptMoved,
        transcriptTruncated: transcript?.truncated ?? false,
        // Under "leave" the dirty files stayed on the Mac. The preflight count read at execution
        // time is what is actually missing from the clone.
        leftBehind: input.dirtyPolicy === "leave" ? pf.dirtyCount : 0,
        goal: input.goal,
      }),
    });
  } catch (e) {
    console.warn("[promotion] handoff nudge not delivered", {
      sessionId,
      reason: errText(e),
    });
  }

  return {
    ok: true,
    sessionId,
    transcriptMoved,
    transcriptTruncated: transcript?.truncated ?? false,
    committed,
    ...(runtimeFlipped ? {} : { runtimeFlipFailed: true as const }),
  };
}
