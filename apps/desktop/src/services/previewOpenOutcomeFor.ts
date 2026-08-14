// "May this preview open a PANE on its own?" — the gate on the one thing this feature may never
// get wrong.
//
// ══ WHY THIS IS A MODULE AND NOT AN `if` AT THE CALL SITE ═══════════════════════════════════════
//
// Design doc §10 names the failure mode before it names the rule: "twenty agents finishing a build
// within a minute of each other, twenty panes stealing the screen, several of them showing a broken
// build. That is strictly worse than no feature." The codebase already refuses that shape once —
// `projectStore.ts:99-101` passes `false` for a machine-created agent, "because yanking the user's
// terminal to an agent they never asked for is disruptive on its own."
//
// So the split is the same one `agentReveal.revealOutcomeFor` uses, for the same reason: PREDICT,
// THEN ACT. This half reads the stores and writes NOTHING, which makes every clause of the
// conjunction testable from a seeded state, and makes the decline REPORTABLE — §10's last
// instruction is "log the decline reason so the behaviour is debuggable instead of mysterious",
// and a boolean cannot carry a reason.
//
// ══ WHAT APPEARS UNASKED IS A PILL, NOT A PANE ═════════════════════════════════════════════════
//
// Nothing here governs the row pill (`row-preview` in AgentRow). The pill is passive, in flow, and
// steals nothing, so it shows whenever a server is live — including under `auto_open = "never"`.
// This module is only ever asked about the PANE, which is the thing that can take the screen.
import { sideOf } from "../engine/pairs";
import { isProjectOpen } from "../engine/openProjects";
import { usePreviewStore } from "../stores/previewStore";
import { useProjectStore } from "../stores/projectStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useUiStore } from "../stores/uiStore";

/**
 * How fresh a "this preview just became worth seeing" moment has to be for a pane to open on it.
 *
 * FIVE SECONDS, MATCHING `REVEAL_REQUEST_TTL_MS`, and the number is borrowed on purpose rather
 * than picked: uiStore states the argument for it at 135-146 — "without a deadline the id simply
 * sits there … and the column yanks to a row nobody asked to see." The same sentence describes
 * this. A preview that finished compiling while the founder was reading something else is not a
 * request to interrupt him three minutes later; it is history, and the row pill is where history
 * belongs.
 */
export const AUTO_OPEN_REQUEST_TTL_MS = 5_000;

/**
 * `"opened"` — every clause holds; the caller SHOULD open the pane (and only the caller writes).
 * `"already-showing"` — that pair is already previewing this very agent. Nothing to do, and this
 *   is deliberately NOT a decline: it is the success state arrived at earlier, and logging it as a
 *   refusal would fill the log with the healthy case.
 * `` `declined-${string}` `` — one clause failed, and the string names WHICH.
 */
export type PreviewOpenOutcome = "opened" | "already-showing" | `declined-${string}`;

/**
 * PREDICT whether a preview pane may open itself, without opening it.
 *
 * Pure: reads `settingsStore`, `previewStore`, `projectStore` and `uiStore`, and writes nothing —
 * so calling it is free and repeatable, and a caller that must LOG what happened can ask before
 * the writes have collapsed the difference between "it was already like that" and "I just made it
 * so".
 *
 * ══ THE ORDER OF THE CLAUSES IS PART OF THE CONTRACT ═══════════════════════════════════════════
 *
 * The returned reason is a diagnostic, so it must not depend on which failing clause happened to
 * be tested first among several. Read top to bottom:
 *
 *   0. the agent still exists                    → `declined-gone`
 *   1. `auto_open` is not `"never"`              → `declined-auto-open-disabled`
 *   —— "would this pane land somewhere that makes sense": these hold under `"always"` TOO ——
 *   2. no app-global overlay covers that pane    → `declined-overlay`
 *   3. no preview is already open in that pair   → `declined-already-open` / `"already-showing"`
 *   4. that agent is what its pair is showing    → `declined-not-selected`
 *   5. that pair is on Build, never Plan         → `declined-not-build-mode`
 *   —— "is this a returning previewer": the ONLY clauses `"always"` skips ——
 *   6. the user opened a preview here already    → `declined-not-opened-this-session`
 *   7. the moment is fresher than the TTL        → `declined-stale`
 *
 * `previewOpenOutcomeFor.test.ts` guards this the way `agentReveal.outcome.test.ts` guards its
 * twin: a row per clause, each breaking exactly one from a fully-eligible seed, plus a mirror test
 * that drives the REAL trigger (`applyPreviewStatus`, the fold every `preview:state` event goes
 * through) and asserts the pane opened — the per-clause rows would all stay green if the ACT half
 * stopped honouring the prediction, and the mirror is what actually fails.
 */
export function previewOpenOutcomeFor(projectId: string, agentId: string): PreviewOpenOutcome {
  const ps = useProjectStore.getState();
  const project = ps.projects.find((p) => p.id === projectId);
  const agent = project?.agents.find((a) => a.id === agentId);
  if (!project || !agent) return "declined-gone";

  // ── 1. THE MASTER SWITCH, first and unconditionally ──────────────────────────────────────────
  // Checked before everything else so the reason is stable: a user who has set `"never"` and asks
  // why nothing opened must be told about the setting, not about whichever other clause the state
  // happened to also fail.
  const autoOpen = useSettingsStore.getState().previewAutoOpen;
  if (autoOpen === "never") return "declined-auto-open-disabled";

  const ui = useUiStore.getState();
  // THE AGENT'S OWN SIDE. `agentReveal.ts:143-146` establishes that a reveal has no business
  // moving the other pair, and this inherits that outright — an auto-open is a reveal nobody asked
  // for, so it is the last thing that should be allowed to reach across the cockpit.
  const side = sideOf(ui.pairAssignment, projectId);

  // ── 2. AN APP-GLOBAL OVERLAY IS SOMETHING THE USER IS LOOKING AT ─────────────────────────────
  // `uiStore.openPreview` clears `activeSpecial` for the Sparkle-pane side. So firing under an
  // overlay would DISMISS a surface the user opened by hand — the loudest theft available, from
  // the one path whose entire premise is that it steals nothing. Held under `"always"` for that
  // reason: `"always"` widens *when we may open*, it does not license taking the screen away.
  if (ui.activeSpecial !== null) return "declined-overlay";

  // ── 3. NO PREVIEW ALREADY OPEN IN THAT PAIR ──────────────────────────────────────────────────
  // Two different answers, because they are two different facts. If that pair is previewing THIS
  // agent, the thing we would do has already happened — `"already-showing"`, the same non-event
  // `revealOutcomeFor` reports. If it is previewing something else, opening would swap the pane
  // out from under whatever is in it.
  if (ui.workModeBySide[side] === "preview") {
    return isThisPairShowing(projectId, agentId, side) ? "already-showing" : "declined-already-open";
  }

  // ── 4. THAT AGENT IS ALREADY THE SELECTED AGENT IN ITS PAIR ──────────────────────────────────
  // Read PER SIDE, never from `selectedProjectId` alone: that value is the RIGHT pair's selection,
  // so comparing a left-assigned project against it answers about a pair that does not hold it.
  // This is the same trap `selectProjectOnItsSide` exists for (roborev 55149/55158).
  //
  // ABOVE THE `"always"` SHORT-CIRCUIT, and this is a correction — it used to sit below, which was
  // a live defect (roborev 63998). `autoOpenPreviewIfWarranted` performs exactly ONE write,
  // `openPreview(side)`, which flips that column's mode and nothing else; it deliberately does not
  // select the project, open its tab or select the agent, because all of that together is a full
  // REVEAL and a much larger interruption than §10 authorises. But `PreviewSlot` then renders
  // `project.selectedAgentId` of whichever project that side is ALREADY showing (`Workspace.tsx`
  // hands it `leftProject`/`project`). So flipping the mode for an agent that is not what its pair
  // is showing does not reveal that agent's preview — it covers the terminal the user was watching
  // with someone else's pane, usually the empty "no server" state. That is strictly worse than not
  // firing, which makes this a precondition for the write to MEAN anything rather than a
  // returning-previewer question, and `"always"` does not get to skip it.
  if (!isThisPairShowing(projectId, agentId, side)) return "declined-not-selected";

  // ── 5. THAT PAIR IS IN BUILD MODE — NEVER INTERRUPT PLAN ─────────────────────────────────────
  // Per side again. The right column being on Plan says nothing about a left-assigned project.
  //
  // Also above the short-circuit, for a plainer reason: §10 states "never interrupt Plan" flatly,
  // as a rule rather than as one of the tunable conjunction clauses. It is the same class as the
  // overlay guard — a surface the user chose, which an unasked pane may not take.
  if (ui.workModeBySide[side] !== "build") return "declined-not-build-mode";

  // ── `"always"` — the founder's escape hatch ──────────────────────────────────────────────────
  // What remains below is the only thing `"always"` is entitled to skip: the two clauses asking
  // *is this user someone who wants previews here, right now*. Everything above asks *would this
  // pane land somewhere that makes sense*, and no setting turns that off.
  if (autoOpen === "always") return "opened";

  // ── 6. THE USER HAS OPENED A PREVIEW FOR THIS PROJECT AT LEAST ONCE THIS SESSION ─────────────
  // Per project, and per session — see `openedProjects` in previewStore for why it is neither
  // global nor persisted.
  if (!usePreviewStore.getState().openedProjects[projectId]) {
    return "declined-not-opened-this-session";
  }

  // ── 7. FRESHER THAN THE TTL ──────────────────────────────────────────────────────────────────
  // An agent with no entry, or one that never reached `ready`/`serving`, has no moment to be fresh
  // about — that is a decline, not an exemption. EXCLUSIVE at the boundary, matching every other
  // deadline in the app: exactly-TTL-old is expired.
  const surfacedAt = usePreviewStore.getState().byAgent[agentId]?.surfacedAt ?? null;
  if (surfacedAt === null || Date.now() - surfacedAt >= AUTO_OPEN_REQUEST_TTL_MS) {
    return "declined-stale";
  }

  return "opened";
}

/** Is `agentId` what that pair is showing right now — tab open, project selected ON ITS OWN SIDE,
 *  and that agent the project's selected one? Shared by clauses 3 and 4 so the two cannot drift:
 *  "already previewing this agent" and "this agent is the selected one" must mean the same thing,
 *  or `"already-showing"` and `declined-not-selected` can both be wrong at once. */
function isThisPairShowing(projectId: string, agentId: string, side: "left" | "right"): boolean {
  const ui = useUiStore.getState();
  const ps = useProjectStore.getState();
  const project = ps.projects.find((p) => p.id === projectId);
  return (
    isProjectOpen(projectId, ui.openProjectIds) &&
    (side === "left" ? ui.leftProjectId === projectId : ps.selectedProjectId === projectId) &&
    project?.selectedAgentId === agentId
  );
}

/**
 * ACT on the prediction — the other half, and the ONLY place that writes.
 *
 * Same shape as every `revealOutcomeFor` caller (`Concierge/AgentPill`, `ConciergeHost`): ask
 * first, then write on exactly one answer and do nothing on the rest. Returns the outcome so a
 * caller (and the tests) can see which branch was taken.
 *
 * The log line is §10's explicit requirement rather than debug leftovers: an auto-open that
 * silently does not fire is indistinguishable from one that is broken, and the reason is the
 * difference. `already-showing` is not logged — it is the healthy steady state, and logging it
 * would bury the reasons under it.
 */
export function autoOpenPreviewIfWarranted(
  projectId: string,
  agentId: string,
): PreviewOpenOutcome {
  const outcome = previewOpenOutcomeFor(projectId, agentId);
  if (outcome === "opened") {
    // ITS OWN SIDE, resolved the same way the prediction resolved it.
    useUiStore.getState().openPreview(sideOf(useUiStore.getState().pairAssignment, projectId));
  } else if (outcome !== "already-showing") {
    console.debug(`[preview] auto-open ${outcome} project=${projectId} agent=${agentId}`);
  }
  return outcome;
}
