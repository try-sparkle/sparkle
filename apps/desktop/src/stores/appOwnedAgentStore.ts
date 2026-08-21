import { create } from "zustand";

/**
 * The app-owned Improve Sparkle agent's manually-set GOAL and ACTIVITY.
 *
 * WHY THIS EXISTS (bead sparkle-t41yw0, the write-path follow-up). The app-owned agent has no
 * `projectStore` roster row — `handleGetState` synthesizes its row into the wire reply only, on
 * purpose (reaping, roll-ups and sidebar ordering all iterate `projectStore`, and the destructive
 * lifecycle ops must refuse it). So `set_agent_goal` / `set_agent_activity` / `set_agent_goal_met`
 * had nowhere to write: they resolve the target, then `useProjectStore.setAgent*` finds no row and
 * the write is a silent no-op (or, before the caller fix, an `unknown agent` refusal). This tiny
 * store is that missing home, keyed by the agent id (canonical `__sparkle_self__` or a per-window
 * variant).
 *
 * DISPLAY-ONLY, DELIBERATELY. The app-owned agent's continuation is driven by the improvement
 * scheduler and the never-idle pusher, NOT the generic goal auto-continue, so this stores only the
 * facts a human/concierge reads off the roster — the goal text, whether it is met, and a precise
 * activity line — and NOT the verify/TTL/escalation/stall machinery that `projectStore` goals carry
 * to drive auto-continue. `selfIdentity` and the synthesized roster row read it back; a stored
 * activity is preferred over the computed `sparkleActivityLine`, and an empty string clears either
 * field.
 *
 * NOT PERSISTED. The goal/activity are live session state; a restart starts the agent fresh, the
 * same as its status. Nothing here survives an app restart on purpose.
 */
export interface AppOwnedGoal {
  /** The objective text as set via `set_agent_goal`. Never empty — an empty set clears the goal. */
  text: string;
  /** Whether `set_agent_goal_met` has marked it done. Maps to the roster goal `state`: met → "met",
   *  otherwise "unmet" (i.e. active/in-progress). */
  met: boolean;
}

interface AppOwnedAgentState {
  /** Goal by agent id. Absent = no goal set. */
  goalById: Record<string, AppOwnedGoal>;
  /** Manually-set activity line by agent id. Absent/empty = fall back to the computed line. */
  activityById: Record<string, string>;
  /** Set (or, with empty text, CLEAR) the goal. A fresh goal resets `met` to false. */
  setGoal: (agentId: string, text: string) => void;
  /** Mark the current goal met/unmet. A no-op if no goal is set — you cannot mark nothing done. */
  setGoalMet: (agentId: string, met: boolean) => void;
  /** Set (or, with empty text, CLEAR) the activity line. */
  setActivity: (agentId: string, activity: string) => void;
}

export const useAppOwnedAgentStore = create<AppOwnedAgentState>((set) => ({
  goalById: {},
  activityById: {},
  setGoal: (agentId, text) =>
    set((s) => {
      const next = { ...s.goalById };
      if (text) next[agentId] = { text, met: false };
      else delete next[agentId];
      return { goalById: next };
    }),
  setGoalMet: (agentId, met) =>
    set((s) => {
      const current = s.goalById[agentId];
      // NOTHING TO MARK is not a change — mirror projectStore.setAgentGoalMet, which early-returns
      // when there is no goal. Marking "met" on an agent with no goal would invent a finished goal.
      if (current === undefined) return s;
      return { goalById: { ...s.goalById, [agentId]: { ...current, met } } };
    }),
  setActivity: (agentId, activity) =>
    set((s) => {
      const next = { ...s.activityById };
      if (activity) next[agentId] = activity;
      else delete next[agentId];
      return { activityById: next };
    }),
}));
