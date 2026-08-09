// The REAL IO behind demote.ts's injected seam: the live `awaitLocalFirstFrame`, and the one place
// that wires every dep to its production implementation (`makeDemoteDeps`). Kept out of demote.ts on
// purpose — the state machine's tests must never touch a socket, a Tauri command or the store, and
// the cheapest way to guarantee that is for the machine's module to import none of them.
//
// `awaitLocalFirstFrame` is the definition of "the local side is live" (spec Decision 2): the local
// transport's FIRST output frame for that agent id. Two things end the wait early, and both matter:
//
//   • a deadline, so a spawn that never produces anything doesn't hold a billing sandbox open;
//   • the PTY's own EXIT, so the commonest failure (claude isn't installed, the worktree vanished)
//     fails in milliseconds instead of waiting out the clock. Promotion's equivalent needs a status
//     poll for this because a sandbox is remote; a local PTY tells us directly.

import {
  getTransport,
  deleteCloudSession,
  LocalTransport,
  type AgentTransport,
} from "../agentTransport";
import { cloudApi, type CloudApi } from "../cloudAgents/api";
import { useProjectStore } from "../../stores/projectStore";
import { demotionLandBranch, demotionWriteTranscript } from "./rust";
import { DEFAULT_FIRST_FRAME_TIMEOUT_MS, type DemoteDeps } from "./demote";

export interface AwaitLocalFirstFrameOpts {
  agentId: string;
  timeoutMs: number;
  /** Injectable for tests. Defaults to the LOCAL transport for this agent. */
  transport?: Pick<AgentTransport, "onOutput" | "onExit">;
  /** Injectable timers so tests don't wall-clock. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

/**
 * Resolve when the LOCAL agent is observed streaming; reject on a deadline or an early exit. This
 * is the gate the cloud sandbox's life hangs on, so it rejects rather than resolving on anything it
 * cannot positively confirm.
 *
 * It only LISTENS — it never spawns and never kills. In particular it must not `detach()`: for a
 * LocalTransport detach IS kill, so tearing this listener down that way would end the very PTY it
 * just proved was alive.
 */
export function awaitLocalFirstFrameLive(opts: AwaitLocalFirstFrameOpts): Promise<void> {
  // An OBSERVER, explicitly (`observeAnyEpoch`) — not `getTransport`, which hands back a transport
  // that reports only the exit of a PTY IT spawned. This one spawns nothing, so under the default
  // epoch filter its exit path would be permanently inert: the early-exit rejection below would
  // never fire and the commonest demotion failure would present as a first-frame TIMEOUT blaming the
  // deadline, holding the cloud sandbox open for the whole wait. Any life of this agent exiting
  // before we saw a frame is the fact this wants, and it is exactly what an observer reports.
  const transport =
    opts.transport ?? new LocalTransport(opts.agentId, { observeAnyEpoch: true });
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unOutput: (() => void) | null = null;
    let unExit: (() => void) | null = null;
    let deadline: unknown = null;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      unOutput?.();
      unExit?.();
      if (deadline !== null) clearTimer(deadline);
      if (err) reject(err);
      else resolve();
    };

    unOutput = transport.onOutput(() => finish());
    // An exit BEFORE any output is a spawn that failed. An exit after output is impossible to see
    // here — the first frame already settled the promise and removed this listener.
    unExit = transport.onExit(() =>
      finish(new Error("the local agent exited before it produced any output")),
    );
    deadline = setTimer(
      () => finish(new Error(`no output from the local agent within ${opts.timeoutMs}ms`)),
      opts.timeoutMs,
    );
  });
}

/**
 * Message the `spawn` step refuses with until the pane-side half of demotion lands. Exported so the
 * follow-up that removes this refusal has one symbol to delete and one test to fail.
 */
export const LOCAL_SPAWN_UNSUPPORTED =
  "Sparkle can't start this agent on your Mac yet — bringing a cloud agent down needs a desktop update. " +
  "Nothing was changed and your cloud agent is untouched.";

/**
 * Bring the agent's LOCAL PTY up in the landed worktree.
 *
 * REFUSES, unconditionally and by design, and the refusal is POSITIVE — it is not a side effect of
 * some registry happening to be empty. Two facts make anything else wrong today:
 *
 *   • `AgentPane.prepare()` returns early for `runtime === "cloud"` (AgentPane.tsx:453) and its
 *     effect is keyed on `[agent.id]`. At this point in the order the tab still reads `cloud` — the
 *     runtime flip is correctly the LAST step — so the pane cannot build a `claude --resume` exec
 *     for it. Crucially the pane's re-spawn lever (`services/paneControl.restartPane`) IS
 *     registered for a mounted cloud pane, with no runtime condition, so calling it would return
 *     `true`, spawn nothing, re-run the cloud attach path as a side effect, and leave the machine
 *     waiting out a 60-second deadline before failing with a message blaming the deadline. A
 *     refusal that depends on the lever's ABSENCE is therefore a refusal that never fires.
 *   • That lever also carries no worktree. `demotion_land_branch` chooses the path for a
 *     born-in-the-cloud agent, and the transcript is written into THAT path; a pane that claimed a
 *     different one would start a Claude with nothing to resume — and, because `transcriptMoved` is
 *     true, with no briefing either. The pane-side half must accept the landed worktree, not
 *     re-derive one.
 *
 * So this refuses at the `spawn` step, which leaves the cloud agent running and deletes nothing,
 * rather than resolving into a wrong spawn or a mis-attributed timeout. `AgentPane.tsx` is outside
 * every worker's file ownership in this plan; the pane-side half is the follow-up that replaces
 * this body (see PRD/cloud-demotion-services.md).
 */
async function spawnLocalAgentLive(_a: {
  agentId: string;
  worktree: string;
  branch: string;
}): Promise<void> {
  throw new Error(LOCAL_SPAWN_UNSUPPORTED);
}

/**
 * Wire every {@link DemoteDeps} member to its production implementation. The confirm dialog calls
 * `demoteAgentToLocal(input, makeDemoteDeps())`; nothing else should be assembling these by hand,
 * so there is one place where the real transport, the real store and the real commands meet.
 */
export function makeDemoteDeps(
  overrides: Partial<DemoteDeps> = {},
  api: Pick<CloudApi, "sessionHandoff" | "sessionHead"> = cloudApi,
): DemoteDeps {
  return {
    sessionHandoff: (id) => api.sessionHandoff(id),
    sandboxHead: (id) => api.sessionHead(id),
    landBranch: (a) => demotionLandBranch(a),
    writeTranscript: (a) =>
      demotionWriteTranscript({
        worktree: a.worktree,
        sessionId: a.sessionId,
        jsonl: a.jsonl,
      }),
    spawnLocalAgent: (a) => spawnLocalAgentLive(a),
    awaitLocalFirstFrame: (a) => awaitLocalFirstFrameLive(a),
    // The LOCAL transport, explicitly: at this instant the tab still reads `runtime: "cloud"`, so
    // deriving the transport from the tab would kill the SANDBOX — the exact opposite of standing
    // the local agent down, and it would do it on a failure path that promises the cloud agent
    // survives.
    killLocalAgent: (agentId) => getTransport({ id: agentId, runtime: "local" }).kill(),
    deleteSession: (id) => deleteCloudSession(id),
    setRuntimeLocal: ({ projectId, agentId }) =>
      useProjectStore.getState().setAgentRuntime(projectId, agentId, "local"),
    sendBriefing: ({ agentId, text }) => {
      // Two writes, not one: the text and the submit ride separate frames so the PTY has ingested
      // the whole prompt before the carriage return arrives. A combined `text + "\r"` is how a
      // paste-then-submit loses its submit (bead sparkle-q1mxh).
      const t = getTransport({ id: agentId, runtime: "local" });
      t.write(text);
      t.write("\r");
    },
    ...overrides,
  };
}

export { DEFAULT_FIRST_FRAME_TIMEOUT_MS };
