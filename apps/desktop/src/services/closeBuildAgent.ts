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
// ── AND `true` HAS NO PRODUCTION CALLER AT ALL (roborev 59153) ───────────────────────────────────
// This header used to say "the sidebar passes `true` only from inside RetireAgentConfirm's
// callback". It does not, and never did: the human path is `AgentSidebar.confirmRetire`, which
// writes the override receipt and then calls `teardownAgent` directly — it does not come through
// here. `confirmedByHuman: true` is passed only by this module's own tests.
//
// That is deliberate and worth stating rather than "fixing" by routing the × through here: the two
// doors do genuinely different work. `confirmRetire` must AWAIT the receipt write and ABORT the
// teardown when it fails (knightwatch probe 4 — proceeding would destroy the row and the record
// together), which is a policy this choke point does not and should not carry. What this file is
// for is REFUSING the four machine doors, and the `true` branch is the reserved shape for the day
// one of them earns a human confirm of its own. Read it as reserved, not as exercised.
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";
import { terminateIfCloud } from "./cloudAgents/terminate";
import { spinDownAgentGit } from "./closeAgentActions";
import { closeDecision } from "../engine/closeAgent";
import { resolveStage } from "../engine/workflowStage";
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

  // Store teardown first: drop each from the open set (unmounts the pane → kills PTY + stops the
  // orchestration bridge). Keep this before the git teardown so nothing is mid-write on the worktree.
  const { close } = useRuntimeStore.getState();
  for (const id of ids) close(id);

  // Collect the beads BEFORE removeAgent drops the rows that carry the ids. Without this the beads
  // are orphaned at `in_progress` forever — nothing re-reaches them once the agent leaves the store.
  const beadIds = ids
    .map((id) => project.agents.find((a) => a.id === id)?.beadId)
    .filter((b): b is string => !!b);

  await spinDownAgentGit({
    root: project.rootPath,
    projectId: project.id,
    ids,
    beadIds,
    deleteBranch: useSettingsStore.getState().deleteMergedBranch,
  });

  // Finally drop the build agent (and, via cascade, its workers) from the sidebar.
  useProjectStore.getState().removeAgent(project.id, buildAgentId);
  return { ok: true };
}
