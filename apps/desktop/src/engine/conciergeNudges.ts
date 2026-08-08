// TURNING AN AGENT INTO A NUDGE CARD — the card's text and the buttons on it.
//
// Moved verbatim out of components/ConciergeHost.
//
// NOT `engine/nudges.ts`, deliberately, despite the name: that module is the BRANCH-STALENESS
// thresholds (`STALE_WARN`, `growNudge`) and shares nothing with this but the English word. Folding
// concierge card construction into it would make one file mean two things, which is the failure this
// whole decomposition is against.
import type { ConciergeAgent } from "../services/conciergeFeed";
import type { ConciergeNudge, ConciergeNudgeAction } from "../components/Concierge";
import { findKnownAgent } from "../services/knownAgents";

/** The LABELLED buttons a card carries — things the AGENT can be told to do, which today is Approve
 *  and only Approve.
 *
 *  "SHOW ME" AND "MUTE" ARE BOTH GONE FROM THIS LIST, for different reasons, and neither is a
 *  deletion (see the header of Concierge/NudgeCard):
 *   • Show me was removed outright. The card now renders the agent as a real `AgentPill` that
 *     navigates, and the whole card remains a click target, so a third copy of the same affordance
 *     was pure width in a column whose scarcest resource is width.
 *   • Mute moved to a CONTROL on the card rather than an action in this list, alongside the new [x].
 *     Both are properties of the ALARM — every card has them regardless of what its agent is doing —
 *     whereas an entry here is a property of the agent's current work. `NudgeCard` fires them
 *     through the same `onNudgeAction` channel under `NUDGE_MUTE_ACTION` / `NUDGE_DISMISS_ACTION`,
 *     so nothing about the wiring changed, only where they are drawn.
 *
 *  Approve stays a labelled button on purpose: it is a one-tap relay into a live terminal, there is
 *  no other place in the app to do it from, and an icon would make an irreversible action ambiguous. */
/** The action id that reveals the agent's own pane instead of relaying anything into it. */
export const NUDGE_OPEN_ACTION = "open";

export function actionsFor(a: ConciergeAgent): ConciergeNudgeAction[] {
  if (a.status !== "approval") return [];
  // A CLOUD AGENT GETS "Open", NOT "Approve". Approve relays the word into that agent's terminal,
  // and `conciergeDispatch.deliverCloudPrompt` refuses every approval gesture aimed at a cloud agent
  // by design — an approval presses a button on the agent's own screen, which the concierge cannot
  // see well enough to press correctly. So the old card offered a button whose only possible outcome
  // was a refusal, discoverable only by pressing it. "Open" is the action the refusal copy already
  // told the user to take. It is a SWAP, never a removal: a control that vanishes on scope reads as
  // a deleted feature (sparkle-lcx8y).
  //
  // Resolved off `knownAgents` rather than by importing `conciergeDispatch.isCloudAgent`, which
  // evaluates this identical expression: 19 suites hand-list a partial mock of that module, and
  // vitest throws on any export a factory omits, so one more import from it turns 143 unrelated
  // tests red. Same record, same polarity — TRUE only on positive evidence, so `runtime: "unknown"`
  // keeps the Approve relay and lets the write attempt report honestly.
  const cloud = findKnownAgent(a.id)?.runtime === "cloud";
  return [
    {
      id: cloud ? NUDGE_OPEN_ACTION : "approve",
      label: cloud ? "Open" : "Approve",
      kind: "primary",
    },
  ];
}

export function agentToNudge(a: ConciergeAgent): ConciergeNudge {
  return {
    id: a.id, // the source agent id — resolved back via the feed on click/action
    kind: "nudge",
    band: a.band,
    projectName: a.projectName,
    agentName: a.name,
    text: `${a.statusLabel} — ${a.name} in ${a.projectName}.`,
    actions: actionsFor(a),
  };
}
