// The copy-then-cut state machine for cloud→local demotion (plan W3; spec Decisions 2 + 6).
//
// Demotion is promotion with the roles swapped, and it is deliberately written to read that way.
// It is NOT a move. It is a copy followed by a cut, the cut happens exactly once and last, and
// every step before it is ordered so that its failure leaves the CLOUD agent running and untouched:
//
//   preflight → handoff (the sandbox commits, pushes, hands back its transcript) → land the branch
//   locally → write the transcript → spawn the local agent → AWAIT ITS FIRST FRAME → CUT GUARD
//   (sandbox HEAD vs the pushed sha) → DELETE /sessions/:id → flip the runtime → brief, if the
//   conversation didn't travel
//
// Six invariants, each with a test that fails if it is broken:
//
//   1. `deleteSession` runs strictly AFTER `awaitLocalFirstFrame` resolves, and NEVER on any
//      failure path. Asserting only that the happy path deletes would be vacuous — a machine that
//      deleted first would pass it — so the tests assert the ORDER (call-log indices) and
//      non-invocation per failure branch.
//   2. THE CUT GUARD compares the sandbox's LIVE head to the HANDOFF'S `pushedSha`, never to a head
//      read taken earlier. The sandbox's own WIP commit moves HEAD during the handoff, so a
//      HEAD-vs-HEAD comparison bakes that commit into the baseline and — worse — waves through a
//      commit made INSIDE the copy window, which is the exact loss the guard exists to catch (spec
//      Decision 2 makes this correction explicitly, because the promotion spec had to make it once
//      already). `sandboxHead` is therefore called exactly once, at cutover, and the test asserts
//      the count as well as the verdict.
//   3. EXACTLY ONE LOCAL PTY EXISTS AT THE END — one on success, ZERO on every failure. See
//      `standDownLocal` below: once the local agent is up, two Claudes are live on one branch, so
//      every failure path from there on tears the local one back down before it reports. This is
//      the precise mirror of promotion's `abandon()` (which DELETEs the cloud session it started).
//   4. A `land` refusal of `dirty` or `diverged` surfaces its FILE LIST, not a flattened git error
//      (see rust.ts `landRefusalMessage`).
//   5. A transcript that does not travel is NOT fatal: the demotion continues with
//      `transcriptMoved: false` and the local agent gets `demotionBriefing` after cutover.
//   6. `setRuntimeLocal` runs exactly once, after the delete SUCCEEDS. A delete that fails once the
//      local agent is live returns `orphanedSessionId` — a billing sandbox with no tab — following
//      `createCloudAgent`'s existing contract.
//
// Everything IO is an injected dep so all six are testable with no Tauri, no network and no store.

import type { SessionHandoff } from "../cloudAgents/api";
import { demotionBriefing } from "./plan";
import { landRefusalMessage, parseLandRefusal, type DemotionLanding } from "./rust";

export type DemotionStep =
  | "preflight"
  | "handoff"
  | "land"
  | "transcript"
  | "spawn"
  | "await_live"
  | "cutover";

/**
 * How long to wait for the local agent's first output frame before giving up.
 *
 * Shorter than promotion's 120s: a local spawn has no sandbox to allocate and no repo to clone, so
 * the work is a worktree that already exists plus `claude --resume`. The cost of waiting too long
 * here is a cloud sandbox billing while a spinner turns.
 */
export const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 60_000;

export interface DemoteInput {
  /** The desktop tab id. For a cloud agent this is ALSO the server session id (spec Decision 5). */
  agentId: string;
  /** The DESKTOP project id (used for the store flip). */
  projectId: string;
  /** Repo root — the fetch and the worktree cut happen from here. */
  root: string;
  /**
   * The server session id, when it is not the tab id. Defaults to `agentId`, which is the case for
   * every agent the app can create today (a born-in-the-cloud tab takes the server's id; a promoted
   * one had its id adopted). Explicit so a future divergence is a parameter, not a silent bug.
   */
  sessionId?: string;
  /** An EXISTING worktree to fast-forward, or null to cut a fresh one. A previously promoted agent
   *  has one (promotion deliberately does not delete it); a born-in-the-cloud agent does not. */
  existingWorktree?: string | null;
  /** The agent's display name, for the briefing. */
  agentName: string;
  /** The agent's goal text, if it has one. */
  goal?: string;
  awaitFirstFrameMs?: number;
}

export interface DemoteDeps {
  /** `POST /sessions/:id/handoff` — the sandbox commits, pushes and hands back its transcript. */
  sessionHandoff(sessionId: string): Promise<SessionHandoff>;
  /** `demotion_land_branch`. Rejects with a STABLE-PREFIXED refusal string (see rust.ts). */
  landBranch(a: {
    root: string;
    agentId: string;
    existingWorktree: string | null;
    branch: string;
    expectedSha: string;
  }): Promise<DemotionLanding>;
  /** `demotion_write_transcript`. Rejecting is survivable — this step is never fatal. */
  writeTranscript(a: {
    worktree: string;
    sessionId: string;
    jsonl: string;
  }): Promise<number>;
  /** Bring the LOCAL agent up in the landed worktree. Resolves once it has been asked to start;
   *  `awaitLocalFirstFrame` is what proves it actually did. */
  spawnLocalAgent(a: { agentId: string; worktree: string; branch: string }): Promise<void>;
  /**
   * Resolves on the local PTY's first output frame; rejects on deadline or an early exit.
   *
   * CALLED BEFORE `spawnLocalAgent`, and the returned promise is awaited after it. That is not a
   * style choice: the local transport registers its output/exit listeners ASYNCHRONOUSLY
   * (`agentTransport.ts` LocalTransport — `spawn()` awaits a readiness promise for exactly this
   * reason), so subscribing after the spawn can miss the first frame of an agent that prints a
   * banner and then idles at a prompt. Missing it costs the full deadline, a killed-but-healthy
   * PTY, and a refusal that blames the timeout.
   */
  awaitLocalFirstFrame(a: { agentId: string; timeoutMs: number }): Promise<void>;
  /** Stand the local agent back down. Called ONLY on failure paths after the spawn — never on
   *  success — so a refusal never leaves two Claudes live on one branch. */
  killLocalAgent(agentId: string): Promise<void>;
  /** `GET /sessions/:id/head` — the sandbox's live HEAD. THE CUT GUARD'S ONLY READING. */
  sandboxHead(sessionId: string): Promise<string>;
  /** THE CUT. `DELETE /sessions/:id`. Called once, last, and never on a failure path. */
  deleteSession(sessionId: string): Promise<void>;
  /** `projectStore.setAgentRuntime(projectId, agentId, "local")` — mutates the tab in place. */
  setRuntimeLocal(a: { projectId: string; agentId: string }): void;
  /** Write the handoff briefing into the now-live local agent. */
  sendBriefing(a: { agentId: string; text: string }): void | Promise<void>;
  /**
   * Fires as each step BEGINS. Optional and purely observational — the machine's behaviour must not
   * depend on it and a throwing observer must not be able to abort a demotion, so every call is
   * guarded. It matters more than a spinner would: the whole safety story is an ORDER, and the step
   * a failure names is what tells the user whether their sandbox was touched.
   */
  onStep?(step: DemotionStep): void;
}

export type DemoteResult =
  | {
      ok: true;
      /** Where the branch landed — the worktree the local agent is now running in. */
      worktree: string;
      transcriptMoved: boolean;
      /** true = a worktree was cut fresh; false = an existing one was fast-forwarded. */
      createdWorktree: boolean;
      /** The transferred transcript lost its OLDEST turns to the server's byte cap. Reported so
       *  the UI can say so rather than letting the agent discover it mid-thought. */
      transcriptTruncated: boolean;
      /** The cut SUCCEEDED but the store flip did not: the sandbox is gone while the tab still
       *  reads `runtime: "cloud"`. The demotion HAPPENED — the UI must reconcile the tab, not
       *  offer a retry that would hand off against a session that no longer exists. */
      runtimeFlipFailed?: true;
    }
  | {
      ok: false;
      step: DemotionStep;
      message: string;
      /** Set when a cloud session is RUNNING server-side that we could not delete. Not retry-safe
       *  in the billing sense: the sandbox keeps costing money until it is stopped from the cloud
       *  roster. Mirrors `createCloudAgent`. */
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

/** The tail every failure message carries: the point of the ordering is that this is always true. */
const STILL_CLOUD = " Your agent is still running in the cloud.";

/** Fire the step observer without letting it break the machine. */
function note(deps: DemoteDeps, step: DemotionStep): void {
  try {
    deps.onStep?.(step);
  } catch (e) {
    console.warn("[demotion] step observer threw", { step, reason: errText(e) });
  }
}

/**
 * Demote a running CLOUD agent onto this Mac. Resolves a result rather than throwing: every failure
 * is a value carrying the step that failed and a sentence the user can act on, and in every one of
 * them the cloud agent is still running and the local side has been stood back down.
 */
export async function demoteAgentToLocal(
  input: DemoteInput,
  deps: DemoteDeps,
): Promise<DemoteResult> {
  const sessionId = input.sessionId || input.agentId;

  /**
   * Tear the local agent back down. Called on EVERY failure path once the spawn has happened, and
   * on none before it.
   *
   * Without this a refusal leaves the local PTY running alongside a cloud agent that is still live
   * on the same branch — two Claudes, one branch, which is the state promotion's ordering is built
   * to avoid and which demotion would otherwise reintroduce from the other side. A kill that itself
   * fails is logged, never surfaced: the user's problem is the step that failed, and a second
   * sentence about cleanup would bury it.
   */
  const standDownLocal = async (): Promise<void> => {
    try {
      await deps.killLocalAgent(input.agentId);
    } catch (e) {
      console.warn("[demotion] local agent could not be stood back down", {
        agentId: input.agentId,
        reason: errText(e),
      });
    }
  };

  // ── preflight ────────────────────────────────────────────────────────────────────────────────
  // Cheap, local, and BEFORE anything writes: the handoff below commits and pushes inside the
  // user's repository, so a missing root must refuse here rather than after that has happened.
  note(deps, "preflight");
  if (!input.root) {
    return {
      ok: false,
      step: "preflight",
      message: `This agent's project has no folder on this Mac, so there's nowhere to land its branch.${STILL_CLOUD}`,
    };
  }

  // ── handoff ──────────────────────────────────────────────────────────────────────────────────
  // The first step that WRITES, and it writes to the user's GitHub repo. Its failure message says
  // so: the push may already have happened, which is not destructive but is a fact the user is
  // entitled to (spec Decision 6).
  note(deps, "handoff");
  let handoff: SessionHandoff;
  try {
    handoff = await deps.sessionHandoff(sessionId);
  } catch (e) {
    return {
      ok: false,
      step: "handoff",
      message:
        `Couldn't prepare the cloud agent's work for the move: ${errText(e)}. ` +
        `Its branch may already have been committed and pushed to origin, which is safe — nothing was deleted.${STILL_CLOUD}`,
    };
  }
  const branch = handoff.branch;
  const pushedSha = handoff.pushedSha;

  // ── land ─────────────────────────────────────────────────────────────────────────────────────
  // Fetch and fast-forward (or cut a worktree). Refuses rather than merging, resetting or stashing
  // on `dirty`/`diverged`: both mean the LOCAL copy holds content the cloud does not, and
  // destroying it is the one failure this whole feature exists to prevent.
  note(deps, "land");
  let landing: DemotionLanding;
  try {
    landing = await deps.landBranch({
      root: input.root,
      agentId: input.agentId,
      existingWorktree: input.existingWorktree ?? null,
      branch,
      expectedSha: pushedSha,
    });
  } catch (e) {
    // The stable prefix is CLASSIFIED, not printed. `dirty`/`diverged` carry the file list into the
    // sentence; everything else gets a sentence naming what actually failed.
    return {
      ok: false,
      step: "land",
      message: `${landRefusalMessage(parseLandRefusal(e), branch)}${STILL_CLOUD}`,
    };
  }

  // ── transcript ───────────────────────────────────────────────────────────────────────────────
  // NEVER fatal (spec Decision 4). A conversation that cannot be written means the local agent
  // starts from a briefing — it does not mean the user's WORK stays in a sandbox we are about to
  // destroy. Both halves of "did not travel" land here: the server could not read it (transcript
  // null + transcriptError), or we could not write it.
  note(deps, "transcript");
  let transcriptMoved = false;
  if (handoff.transcript) {
    try {
      await deps.writeTranscript({
        worktree: landing.worktree,
        sessionId: handoff.transcript.sessionId,
        jsonl: handoff.transcript.jsonl,
      });
      transcriptMoved = true;
    } catch (e) {
      console.warn("[demotion] transcript could not be written; demoting without the conversation", {
        agentId: input.agentId,
        reason: errText(e),
      });
    }
  } else if (handoff.transcriptError) {
    console.warn("[demotion] the sandbox's transcript did not travel", {
      agentId: input.agentId,
      reason: handoff.transcriptError,
    });
  }

  // ── spawn ────────────────────────────────────────────────────────────────────────────────────
  // From here on a LOCAL agent exists, so every failure below must stand it back down (invariant 3).
  // Nothing is stood down for a failure HERE: the spawn never succeeded, so there is nothing to
  // kill, and calling the killer anyway would make the "kill exactly once, only after a successful
  // spawn" invariant untestable.
  note(deps, "spawn");
  // LISTEN FIRST, THEN SPAWN. The local transport registers its output/exit listeners
  // asynchronously, so subscribing after the spawn races the agent's first bytes — and an agent
  // that prints a banner and then sits at a prompt emits nothing else, so losing that one frame
  // costs the full deadline, kills a perfectly healthy PTY, and reports a timeout as the cause.
  // Both orders look identical on the happy path of a synchronous fake, which is why the test for
  // this asserts the ATTACH happens before the spawn rather than asserting the result.
  const firstFrame = deps.awaitLocalFirstFrame({
    agentId: input.agentId,
    timeoutMs: input.awaitFirstFrameMs ?? DEFAULT_FIRST_FRAME_TIMEOUT_MS,
  });
  // Claimed immediately: if the spawn below fails we never await this, and an unobserved rejection
  // (the deadline, later) would surface as an unhandled promise rejection with no owner.
  firstFrame.catch(() => {});
  try {
    await deps.spawnLocalAgent({ agentId: input.agentId, worktree: landing.worktree, branch });
  } catch (e) {
    return {
      ok: false,
      step: "spawn",
      message:
        `Couldn't start the agent on this Mac: ${errText(e)}. ` +
        `${branch} is already checked out at ${landing.worktree}, so nothing was lost.${STILL_CLOUD}`,
    };
  }

  // ── await_live ───────────────────────────────────────────────────────────────────────────────
  // The literal definition of "the local side is up": a first output frame. Nothing below this line
  // may run until it arrives, and the cloud agent is still serving the user throughout.
  note(deps, "await_live");
  try {
    await firstFrame;
  } catch (e) {
    await standDownLocal();
    return {
      ok: false,
      step: "await_live",
      message:
        `The local agent didn't come up: ${errText(e)}. ` +
        `${branch} is checked out at ${landing.worktree} and nothing was lost.${STILL_CLOUD}`,
    };
  }

  // ── cutover ──────────────────────────────────────────────────────────────────────────────────
  // VERIFY, THEN CUT. The cloud Claude has been running and committing this whole time — through
  // the land, the transcript write, the spawn and the wait. Anything it committed AFTER the handoff
  // pushed is in a sandbox we are one call away from destroying, so the sandbox's head is re-read
  // here and any difference REFUSES the cut.
  //
  // THE BASELINE IS `pushedSha` — what the handoff PUSHED — and not a head read taken earlier. The
  // handoff's own WIP commit moves the sandbox's HEAD, so a HEAD-vs-HEAD comparison would refuse
  // every ordinary demotion; worse, a "read HEAD at the start" baseline would MATCH a commit made
  // inside the copy window and wave through exactly the loss this guard exists to catch.
  note(deps, "cutover");
  let head: string;
  try {
    head = await deps.sandboxHead(sessionId);
  } catch (e) {
    // We cannot prove the sandbox didn't move, so we must not cut. Fail closed.
    await standDownLocal();
    return {
      ok: false,
      step: "cutover",
      message:
        `Couldn't re-check the cloud sandbox before ending it: ${errText(e)}. ` +
        `Nothing was deleted — try again.${STILL_CLOUD}`,
    };
  }
  if (head !== pushedSha) {
    await standDownLocal();
    return {
      ok: false,
      step: "cutover",
      // REMEDY SAFETY (bead ccgz8): the guard refused BECAUSE the cloud agent is still committing,
      // so a bare "demote again" can lose the same race on the next pass — this Mac catches up, the
      // agent commits once more, and the head diverges again. There is no quiesce/pause dep to stop
      // the sandbox agent (that is a server capability this contract does not have), so the honest,
      // safe remedy under the SAME condition that triggered the refusal is: wait for the agent to go
      // idle first, then demote. Nothing here is destructive, and it does not send the user back
      // into the loop the guard just caught.
      message:
        `Your cloud agent committed again while this Mac was catching up, so the sandbox now holds newer work than the push carried. ` +
        `That commit is safe in the sandbox and nothing was deleted. Once the cloud agent is idle, demote again to bring it down — while it's still working, another attempt can race the same way.${STILL_CLOUD}`,
    };
  }

  // THE CUT. Everything above is proven; this is the only irreversible step, and it is last.
  try {
    await deps.deleteSession(sessionId);
  } catch (e) {
    // The sandbox is still alive and billing, and a local agent is live on the same branch. Stand
    // the local one down so the user is left with exactly what they started with — one agent, in
    // the cloud — and name the session so they can stop it from the roster.
    await standDownLocal();
    console.warn("[demotion] the cloud session could not be deleted", {
      sessionId,
      reason: errText(e),
    });
    return {
      ok: false,
      step: "cutover",
      message:
        `Your work is on this Mac (${branch} is checked out at ${landing.worktree}), but the cloud sandbox couldn't be stopped: ${errText(e)}. ` +
        `It's still running and still billing — stop session ${sessionId} from the cloud roster, then demote again.`,
      orphanedSessionId: sessionId,
    };
  }

  // PAST THE POINT OF NO RETURN. The sandbox is gone, so nothing below may turn this into a
  // failure: every failure message in this file ends with "your agent is still running in the
  // cloud", and from here that sentence is false.
  let runtimeFlipped = true;
  try {
    deps.setRuntimeLocal({ projectId: input.projectId, agentId: input.agentId });
  } catch (e) {
    runtimeFlipped = false;
    console.warn("[demotion] runtime flip failed after the cut — tab still reads cloud", {
      agentId: input.agentId,
      sessionId,
      reason: errText(e),
    });
  }

  // The briefing is LAST, and ONLY when the conversation didn't travel: an agent that resumed its
  // real transcript needs no prompt, and sending one would make it re-introduce itself mid-thought.
  // A briefing that fails to send is not a failed demotion — the cutover already happened and the
  // user can simply type to the agent.
  if (!transcriptMoved) {
    try {
      await deps.sendBriefing({
        agentId: input.agentId,
        text: demotionBriefing({ name: input.agentName, branch, goal: input.goal }),
      });
    } catch (e) {
      console.warn("[demotion] briefing not delivered", {
        agentId: input.agentId,
        reason: errText(e),
      });
    }
  }

  return {
    ok: true,
    worktree: landing.worktree,
    transcriptMoved,
    createdWorktree: landing.created,
    transcriptTruncated: handoff.transcript?.truncated ?? false,
    ...(runtimeFlipped ? {} : { runtimeFlipFailed: true as const }),
  };
}
