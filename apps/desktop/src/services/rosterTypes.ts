// Shared types for the cross-window agent roster. Mirrors the Rust RosterOut (roster.rs) and the
// mobile RosterAgent/STATUS_RANK so desktop and phone read the fleet identically.
import type { RollupDot } from "../engine/workerRollup";

export interface RosterRecentPrompt {
  id: string;
  text: string;
}
export interface RosterAgent {
  id: string;
  name: string;
  kind: string;
  status: string;
  status_color: string;
  status_label: string;
  /** The disc the row should paint once its folded-away workers are counted (engine/workerRollup's
   *  `RollupDot`). Optional because a roster slice published by an older window predates the field.
   *  `status` above remains the agent's OWN PTY state — an orchestrator delegating to nine busy
   *  workers is `status: "idle"`, `rollup_dot: "green"`.
   *
   *  `| null`, matching every neighbouring Option field below (roborev 54742). The Rust side is
   *  `#[serde(default)] Option<String>` with no `skip_serializing_if`, so a slice published by an
   *  older window serializes `"rollup_dot": null` — and a consumer narrowing with `!== undefined`,
   *  which the old type said was sound, passed `null` into `bandOfRollup`, whose switch has no
   *  default. That returned `undefined` and dropped the row from every status band. */
  rollup_dot?: RollupDot | null;
  /** `engine/agentGoal`'s `GoalState`. DO NOT RE-ENUMERATE IT HERE — see the warning below.
   *
   *  Published for the Rust nudger, which cannot see the goal store and needs to know a goal leaves
   *  the ladder NOTHING TO ASK, so `nudge_ladder` stops spending a full agent turn telling a
   *  finished agent to "resume your goal". Mirrored here because this file is the read side of the
   *  same wire shape, and a field present on one side only is exactly the drift these mirrors exist
   *  to prevent.
   *
   *  ⚠️ THIS COMMENT USED TO ENUMERATE THE UNION AND TO SAY "only the exact met means finished".
   *  Both went stale and the second became FACTUALLY WRONG: `discharged` (git PROVED the work
   *  landed) and `awaiting_close` (landed, awaiting a person's close) are also finished, and the
   *  Rust side treats all three as quiet. Nothing executes a doc comment, so neither claim could
   *  red anything — which is exactly why it drifted through two state additions unnoticed.
   *
   *  The authority is `engine/agentGoal.ts::GoalState`, and the classification is
   *  `nudger::goal_is_quiet` (`QUIET_GOAL_STATES` / `LIVE_GOAL_STATES`), pinned across the language
   *  boundary by `nudger::goal_state_vocabulary_matches_the_frontend`. Read those rather than
   *  trusting a list here; a list here is a fourth copy with no pin on it.
   *
   *  `| null` for the reason spelled out on `rollup_dot` above: the Rust side is `#[serde(default)]
   *  Option<String>` with no `skip_serializing_if`, so an older window serializes an explicit null.
   *  Both null and undefined, and any state the reader does not recognise, must read as a LIVE goal
   *  — the safe direction, because a false "finished" silences an agent that still needs help. */
  goal_state?: string | null;
  parent_id: string | null;
  workflow_stage?: string | null;
  last_activity_at?: number | null;
  recent_prompts?: RosterRecentPrompt[]; // most recent (~4) user prompts, oldest→newest; breadcrumb
}
export interface RosterProject { id: string; name: string; agents: RosterAgent[]; }
export interface Roster { projects: RosterProject[]; }
