// Moves running agents from one Claude account to another WITHOUT losing work.
//
// The mechanism: an agent's account is just `CLAUDE_CONFIG_DIR` on its spawn, so switching means
// re-spawning with a different dir. Sparkle already resumes a re-spawned agent via
// `--resume <session-id>` (claudeSpawn), so the conversation survives the swap — the agent picks up
// its thread under the new login.
//
// The hard requirement is WHEN. Re-spawning an agent mid-turn loses whatever it was doing and can
// interrupt a tool call, which is exactly the "don't yank a running agent" concern Phase 1 cited
// when it declined to switch at all. So this module never switches a busy agent: it marks the agent
// PENDING and waits for it to reach a safe boundary of its own accord.
//
// "Safe" = any status other than `working`. `working` means Claude Code is actively producing
// output (mid-turn); every other status — idle, waiting, approval, blocked, errored, unmerged,
// done, stopped — means the turn is over and nothing is in flight. Switching then costs the agent
// nothing but a redraw.
//
// Consequence, and it's intentional: agents switch INDEPENDENTLY, each at its own boundary, rather
// than all at once. A fleet of ten agents will migrate over however long it takes each to finish
// its current turn. That's the behavior that loses the least work.

import type { AgentTabStatus } from "../types";
import { setPin } from "./accountStore";

/** Statuses at which an agent can be re-spawned without losing in-flight work. Everything except
 *  `working`; see the module note. */
export function isSafeToSwitch(status: AgentTabStatus | undefined): boolean {
  return status !== "working";
}

/** One agent's participation in a switch. */
export interface SwitchTarget {
  agentId: string;
  /** The account it should end up on. */
  toAccountId: string;
}

/** A switch the user accepted, in progress. Agents leave `pending` as they reach a safe boundary. */
export interface SwitchPlan {
  fromAccountId: string;
  toAccountId: string;
  /** Agents not yet moved. */
  pending: string[];
  /** Agents already re-pinned and re-spawned. */
  moved: string[];
}

/** Build the plan: every agent currently running on `fromAccountId` needs to move.
 *  `agentAccounts` maps agentId → the account it's running under. */
export function planSwitch(
  fromAccountId: string,
  toAccountId: string,
  agentAccounts: Record<string, string | undefined>,
): SwitchPlan {
  const pending = Object.entries(agentAccounts)
    .filter(([, acct]) => acct === fromAccountId)
    .map(([agentId]) => agentId);
  return { fromAccountId, toAccountId, pending, moved: [] };
}

/** Which pending agents are ready to move right now, given live statuses. PURE — the caller
 *  performs the effects. */
export function readyToMove(
  plan: SwitchPlan,
  statuses: Record<string, AgentTabStatus | undefined>,
): string[] {
  return plan.pending.filter((id) => isSafeToSwitch(statuses[id]));
}

/** Whether every agent in the plan has moved (so the plan can be retired). */
export function isSwitchComplete(plan: SwitchPlan): boolean {
  return plan.pending.length === 0;
}

/** Apply the move for one agent: pin it to the new account, then re-spawn so the pin takes effect.
 *
 *  Order matters — the pin must be persisted BEFORE the re-spawn, because the spawn path reads the
 *  pin (`chooseAccountForAgent` → `getPin`) while building the exec. Pinning after would re-spawn
 *  the agent onto the account it was already on and silently do nothing.
 *
 *  `restart` is injected (the pane registry's restart for that agent) so this stays testable and so
 *  a missing pane is a no-op rather than a throw. Returns whether the re-spawn was actually
 *  triggered; a pinned-but-not-restarted agent still picks up the new account on its next spawn. */
export function moveAgent(
  agentId: string,
  toAccountId: string,
  restart: (agentId: string) => boolean,
): boolean {
  setPin(agentId, toAccountId);
  return restart(agentId);
}

/** Advance a plan by moving every agent that's currently safe. Returns the updated plan (immutably)
 *  plus the ids moved on this pass. */
export function advanceSwitch(
  plan: SwitchPlan,
  statuses: Record<string, AgentTabStatus | undefined>,
  restart: (agentId: string) => boolean,
): { plan: SwitchPlan; movedNow: string[] } {
  const ready = readyToMove(plan, statuses);
  const movedNow: string[] = [];
  for (const agentId of ready) {
    moveAgent(agentId, plan.toAccountId, restart);
    movedNow.push(agentId);
  }
  if (movedNow.length === 0) return { plan, movedNow };
  const movedSet = new Set(movedNow);
  return {
    plan: {
      ...plan,
      pending: plan.pending.filter((id) => !movedSet.has(id)),
      moved: [...plan.moved, ...movedNow],
    },
    movedNow,
  };
}
