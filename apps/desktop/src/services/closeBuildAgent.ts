// One-click "Close Build Agent" (spin down a shipped build agent). Composes the existing teardown
// pieces: drop the agent + its workers from the stores, remove their worktrees, and — per the
// `delete_merged_branch` workflow setting — SAFELY delete each now-merged branch. The branch delete
// uses `git branch -d` (refuses an unmerged branch), so a mis-fire can never lose unmerged work.
//
// Used by the green "Close Build Agent" suggestion-row button, which only appears once an agent has
// actually shipped/landed (runtimeStore.workflowShipped), so closing is safe and one-click.
//
// ── THIS IS THE CHOKE POINT FOR EVERY *MACHINE* CLOSE (bead sparkle-0l9xk) ───────────────────────
// Four callers reach here, and NONE of them is the sidebar ×:
//   • conciergeTools/lifecycle.closeAgent  — the concierge, on its own judgement
//   • conciergeTools/lifecycle.shipAgent   — ship, which closes as a side effect
//   • relayClient                          — a tap on the PHONE, remotely
//   • suggestions/applySuggestion          — the one-click green button
// So a confirm wired only into `AgentSidebar.requestClose` would leak through all four, and the
// founder's instruction — *"the build agent shouldn't be removed from the build list until I, as
// the human, confirm that"* — would hold for the × and silently not for anything else. It is the
// concierge closing three agents unchallenged that produced the bead in the first place.
//
// Hence `confirmedByHuman`. It is REQUIRED, not defaulted: an optional flag would have let every
// existing call site keep compiling while quietly keeping the old behaviour, which is the shape of
// the bug rather than the fix. What the type system enforces is exactly that — every call site must
// DECIDE — and all four machine doors decide `false`, so each gets a typed refusal to hand back to
// its user. It is a `boolean`, so nothing stops a fifth caller from passing `true`; the gate is the
// four `false`s above plus this paragraph, not a compiler guarantee. Read it that way before adding
// a caller: if a machine door ever needs `true`, it needs a human confirm of its own first.
//
// ── `true` NOW HAS EXACTLY ONE PRODUCTION CALLER: `retire_agent` (2026-08-12) ────────────────────
// This header used to say `true` had none, and that the branch was "the reserved shape for the day
// one of them earns a human confirm of its own". That day came. `conciergeTools/lifecycle.retireAgent`
// passes `true`, and it is the ONLY caller that may — the other three machine doors above still pass
// `false` and still get their typed refusal.
//
// WHAT EARNED IT, precisely, because "the concierge asked nicely" is not it:
//
//   1. THE FOUNDER LIFTED THE RULE. On 2026-08-12, with ~78 of 81 agent slots held by agents that
//      had finished: *"no i absolutely do not want close_agent to be human only. let's fix that so
//      you can close agents that need to be closed"*. The gate below was his instruction; so is this.
//   2. THE PROTECTED POPULATION IS STILL PROTECTED. `engine/retirementPredicate.mayRetire` refuses a
//      dirty worktree, commits that never reached main, an unreadable reading of either, and an
//      agent still mid-exchange — each from a LIVE reading rather than a cache. It is a strictly
//      narrower door than the `false` path, not a wider one.
//   3. THE RECORD IS WRITTEN FIRST AND GATES THE TEARDOWN. That is the same policy `confirmRetire`
//      carries on the human side (knightwatch probe 4 — proceeding would destroy the row and the
//      record together), and it matters MORE here, because this path runs while nobody is watching.
//
// Note what did NOT change: this is still a plain `boolean`, so nothing stops a sixth caller from
// passing `true`. The gate is the four `false`s above plus this paragraph, not a compiler guarantee.
// Read it before adding a caller — if a new machine door needs `true`, it needs its own equivalent
// of (2) and (3), not merely a reference to this one.
//
// The human × still does not come through here at all: `AgentSidebar.confirmRetire` writes the
// override receipt and calls `teardownAgent` directly. The two doors do genuinely different work,
// and routing one through the other would give the founder's confirm the concierge's policy.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { terminateIfCloud } from "./cloudAgents/terminate";
import { spinDownAgentGit } from "./closeAgentActions";
import { closeDecision } from "../engine/closeAgent";
import { resolveStage } from "../engine/workflowStage";
import { teardownBeadWrites, beadTargetLevel, BEAD_LEVEL } from "../engine/beadLifecycle";
import { AUTO_LABEL, beadShow } from "./beads";

/** Deadline for the WHOLE teardown read phase, not per bead (roborev 83352): serial reads under a
 *  per-read bound made the worst case N × bound. Each read is a single `bd show <id> --json`
 *  (roborev 83346). A bead not read before the deadline is "could not read", which writes NOTHING. */
const TEARDOWN_BEAD_READ_PHASE_MS = 30_000;

async function readBeadNow(
  projectPath: string,
  id: string,
  budgetMs: number,
): Promise<{ status: string; labels: string[] } | undefined> {
  if (budgetMs <= 0) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bead = await Promise.race([
      beadShow(projectPath, id),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), budgetMs);
      }),
    ]);
    return bead && typeof bead.status === "string" ? { status: bead.status, labels: bead.labels ?? [] } : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
import { retroSettled } from "../engine/retroReceiptTypes";
import { cachedReceipt } from "./retroReceipts";

/** Why a close did not happen, for a caller that must explain itself. */
export type CloseBuildAgentOutcome =
  | { ok: true }
  /** The agent has landed and only a person may remove its row. */
  | { ok: false; reason: "needs-human-confirm"; message: string };

/**
 * Resolve the project + worker ids for a build agent, then tear it (and its workers) down.
 *
 * `confirmedByHuman` MUST be `true` for a landed build agent — see the header. Everything else
 * (nothing landed yet, a worker, an already-gone row) is unaffected and still closes as before.
 */
export async function closeBuildAgent(
  buildAgentId: string,
  confirmedByHuman: boolean,
): Promise<CloseBuildAgentOutcome> {
  const project = useProjectStore
    .getState()
    .projects.find((p) => p.agents.some((a) => a.id === buildAgentId));
  if (!project) return { ok: true }; // already gone

  if (!confirmedByHuman) {
    const agent = project.agents.find((a) => a.id === buildAgentId);
    const rt = useRuntimeStore.getState();
    const stage = resolveStage(rt.branchStatus[buildAgentId], rt.workflowStage[buildAgentId]);
    const decision = closeDecision(agent?.kind ?? "build", stage, rt.branchStatus[buildAgentId], {
      settled: retroSettled(cachedReceipt(project.id, buildAgentId)),
    });
    if (decision === "retirement-confirm") {
      return {
        ok: false,
        reason: "needs-human-confirm",
        // A sentence the concierge can say out loud, and one that names the ONE thing that clears
        // it. A refusal whose remedy is vague reads as a malfunction rather than a policy.
        message:
          `“${agent?.name || buildAgentId}” has landed its work, so only you can take it off the ` +
          `build list. Close it from its row and I’ll show you what it reported first.`,
      };
    }
  }

  const workerIds = project.agents.filter((a) => a.parentId === buildAgentId).map((a) => a.id);
  const ids = [buildAgentId, ...workerIds];

  // A CLOUD agent's deliberate close is a gesture that means "stop the sandbox" — the pane's unmount
  // only detaches (the session survives the pane by design), so without this the sandbox would keep
  // metering until idle-pause and re-attach would resurrect the tab on the next project open. Over
  // the whole subtree, and shared with the sidebar × / Discard so every close path terminates every
  // sandbox it drops (roborev 46339, 46881, 46918). CONCURRENT, not sequential: each DELETE
  // carries its own deadline, and N cloud rows awaited in series could stall the visible teardown
  // for N deadlines on a black-holed connection (roborev 47220).
  await Promise.all(ids.map((id) => terminateIfCloud(project.agents.find((a) => a.id === id))));

  // Collect the beads BEFORE removeAgent drops the rows that carry the ids, and read each agent's
  // stage BEFORE `close` below tears its runtime state down. Without this the beads are orphaned at
  // `in_progress` forever — nothing re-reaches them once the agent leaves the store.
  //
  // EACH BEAD IS JUDGED ON ITS OWN AGENT'S WORK (bead sparkle-aoqzzo). This used to close every
  // bead in the subtree, so a worker's child bead that never landed was closed alongside the
  // siblings that did — and a close reads exactly like a fix. See `teardownBeadWrites`.
  //
  // Status and labels come from a FRESH read per bead, never the cached board (roborev 83232): the
  // board is polled only while someone views it, and machine closes happen for projects nobody is
  // viewing. Stages are captured synchronously first, before any await lets the runtime move.
  const rtBefore = useRuntimeStore.getState();
  const staged = ids.flatMap((id) => {
    const beadId = project.agents.find((a) => a.id === id)?.beadId;
    return beadId
      ? [{ beadId, stage: resolveStage(rtBefore.branchStatus[id], rtBefore.workflowStage[id]) }]
      : [];
  });
  // Store teardown first: drop each from the open set (unmounts the pane → kills PTY + stops the
  // orchestration bridge). Keep this before the git teardown so nothing is mid-write on the worktree.
  // It also runs BEFORE the bead reads below (roborev 83352): the stages are already captured, and
  // the reads need only the root and the ids, so a busy store must never hold the visible close.
  const { close } = useRuntimeStore.getState();
  for (const id of ids) close(id);

  // ONE AT A TIME, not Promise.all: bd is a single-writer store, so N parallel reads queue on its
  // lock and the later ones expire for no reason but their position (roborev 83346). A LANDED bead
  // is not read at all — it closes whatever the store says — and the whole phase shares ONE
  // deadline, so the worst case is one bd timeout rather than one per bead (roborev 83352).
  const readDeadline = Date.now() + TEARDOWN_BEAD_READ_PHASE_MS;
  const bound = [];
  for (const s of staged) {
    if (beadTargetLevel(s.stage) >= BEAD_LEVEL.closed) {
      bound.push({ ...s, telemetry: undefined, status: undefined });
      continue;
    }
    const now = await readBeadNow(project.rootPath, s.beadId, readDeadline - Date.now());
    bound.push({
      ...s,
      telemetry: now ? now.labels.includes(AUTO_LABEL) : undefined,
      status: now?.status,
    });
  }
  const beadWrites = teardownBeadWrites(bound);

  await spinDownAgentGit({
    root: project.rootPath,
    projectId: project.id,
    ids,
    beadIds: beadWrites.close,
    releaseBeadIds: beadWrites.release,
    deleteBranch: useSettingsStore.getState().deleteMergedBranch,
  });

  // Finally drop the build agent (and, via cascade, its workers) from the sidebar.
  // NO PANE IS LEFT BY THIS POINT, and that is now handled rather than merely true: `close(id)` ran
  // above and `spinDownAgentGit` was awaited in between, so React committed the unmount long ago.
  // `removeAgent` opens its `close:` trace only while a pane is registered to end it
  // (services/agentPaneRegistry), so this no longer strands a permanent entry that
  // `openTraceKinds()` would name on every later jank stall (bead sparkle-bxidpw). Nothing is lost:
  // this site never produced a `close … (total)` waterfall anyway — the pane's `perfEnd` fired
  // against a trace that had not been started yet.
  useProjectStore.getState().removeAgent(project.id, buildAgentId);
  return { ok: true };
}
