// set_agent_goal_parked — the control-op half of engine/agentGoal's `GoalPark` (epic sparkle-5i7e8x).
//
// Its own module rather than another handler inside controlListener, so the dispatch table there
// grows by one `case` and nothing else. It needs only the project store; the identity it acts on is
// the bridge-stamped caller, never the payload.
//
// SELF-ONLY FOR EVERY CALLER, the concierge included. A park on another agent's goal would stop it
// being resumed — the same false-quiet on a possibly-stalled agent `set_agent_goal_met` refuses a
// peer for. The concierge needs no such lever: it can already close any goal outright, and it has
// no agent row of its own to park.
import { useProjectStore } from "../stores/projectStore";
import type { GoalParkKind, ParkRequest } from "../engine/agentGoal";

const KINDS: readonly GoalParkKind[] = ["awaiting-human", "superseded", "waiting-on"];

export function handleSetGoalParked(
  req: { callerAgentId: string; payload: Record<string, unknown> },
  now: number = Date.now(),
): Record<string, unknown> {
  const own = (req.callerAgentId || "").trim();
  const asked = typeof req.payload.targetAgentId === "string" ? req.payload.targetAgentId.trim() : "";
  if (asked && asked !== own) {
    return {
      ok: false,
      code: "target_refused",
      error:
        `set_agent_goal_parked cannot park ${asked}: an agent may only park its OWN goal. Parking ` +
        "another agent's goal would stop it being resumed while it may still be stalled.",
    };
  }
  let projectId: string | undefined;
  for (const p of useProjectStore.getState().projects) {
    if (p.agents.some((a) => a.id === own)) {
      projectId = p.id;
      break;
    }
  }
  if (!own || projectId === undefined) {
    return {
      ok: false,
      code: "caller_unidentified",
      error:
        "set_agent_goal_parked parks the CALLER's own goal, and this connection resolves to no agent " +
        "row (an unstamped connection, or the concierge, which has none).",
    };
  }

  const kind = req.payload.kind;
  if (kind === "none") {
    const r = useProjectStore.getState().parkAgentGoal(projectId, own, null, now);
    return r.ok ? { ok: true, parked: null } : { ok: false, code: r.code, error: r.message };
  }
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      code: "bad_kind",
      error: `kind must be one of ${[...KINDS, "none"].map((k) => `"${k}"`).join(", ")}.`,
    };
  }
  const parkReq: ParkRequest = {
    kind: kind as GoalParkKind,
    reason: typeof req.payload.reason === "string" ? req.payload.reason : "",
    ...(typeof req.payload.ref === "string" ? { ref: req.payload.ref } : {}),
    ...(typeof req.payload.untilMs === "number" ? { untilMs: req.payload.untilMs } : {}),
  };
  const r = useProjectStore.getState().parkAgentGoal(projectId, own, parkReq, now);
  if (!r.ok) return { ok: false, code: r.code, error: r.message };
  return { ok: true, parked: r.goal.park };
}
