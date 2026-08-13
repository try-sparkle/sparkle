// deadSessionAttention — A SESSION THE APP IS ABOUT TO RESTART IS AMBER, NEVER RED.
//
// ── THE FOUNDER'S OBJECTION, VERBATIM ─────────────────────────────────────────────────────────
// *"there's nothing I can do to resolve this. So why am I seeing this?"* — on a row of workers that
// had sat dead for 45+ minutes showing him `Resume this session with: claude --resume <uuid>`. He
// cannot type into a terminal that is not running. Raising a dead session to a human is asking a
// person to solve something only the app can solve.
//
// ── THE RULE THIS IMPLEMENTS ──────────────────────────────────────────────────────────────────
// `engine/redAttentionTaxonomy.test.ts` pins it in capitals:
//
//     RED = THE FOUNDER IS THE ONLY ACTOR WHO CAN UNBLOCK THIS.
//
// A dead session whose cause is RESURRECTABLE is blocked on a restart, not on a person — the
// resurrection sweep is already going to bring it back — so it fails that test and must render the
// amber `lapsed` tier: no badge, no `needs_you` band, no notification, and no red.
//
// ── AMBER, NOT CALM, AND THAT HALF IS NOT OPTIONAL ────────────────────────────────────────────
// The taxonomy file makes this exact argument about its own narrowing: the row *"does not go quiet…
// If a future change ever lets this row fall through to gray, THAT is the regression — the amber is
// the whole justification"*. A silently abandoned agent is a worse bug than a falsely red one,
// because nothing ever comes back to it. So `lapsed` and never `idle`.
//
// ── WHAT IT DELIBERATELY CANNOT REACH ─────────────────────────────────────────────────────────
// The gate is `deathTypes.isResurrectable`, imported rather than restated, so the two can never
// disagree about which deaths recover:
//   • `blocked-on-human` — a genuine ask. STAYS RED. Not resurrectable, so it never enters here.
//   • `human-stopped`    — the user killed it. Nothing is coming, and nothing is owed either.
//   • `clean-goal-met`   — finished; already calm.
// That coupling is the design, not a coincidence: the row goes quiet *because* something else is
// going to act on it, so the predicate that says "something is coming" is the only honest gate.
//
// PURE. Data in, data out; no clock, no registry read, no I/O.
import type { AgentTab, AgentTabStatus } from "../types";
import type { StatusMap } from "./attention";
import { type DeathCause, isResurrectable } from "./deathTypes";

/**
 * Is this agent's session dead in a way the app itself will recover from?
 *
 * `undefined` — no reading — answers FALSE, and that direction is deliberate. A window with no
 * death record for an agent has not observed it dying; manufacturing an amber row from an absence
 * would demote a genuinely red agent that this window simply has no ledger entry for.
 */
export function isRecoverableDeadSession(cause: DeathCause | undefined): boolean {
  return cause !== undefined && isResurrectable(cause);
}

/**
 * The status a recovering dead session renders. Named rather than inlined so the taxonomy test and
 * the overlay assert the SAME value — a de-redding that quietly picked `idle` would be the silent
 * abandonment this module's header rules out.
 */
export const RECOVERING_DEAD_STATUS: AgentTabStatus = "lapsed";

/**
 * Overlay `lapsed` onto every agent whose session has ended with a resurrectable cause.
 *
 * ── IT RUNS ON THE RAW MAP, BEFORE THE WORKER BUBBLES ─────────────────────────────────────────
 * Same placement and the same reason as `withNewAgentCalm`: a bubbled red is indistinguishable from
 * a parent's own once it lands, so a dead worker's false red has to be corrected BEFORE it can
 * spread to the orchestrator. Correcting it afterwards would leave the head red for a worker the
 * app is about to restart — which is the founder's complaint one level up.
 *
 * ── `working` IS LEFT ALONE, AND THAT IS THE FAIL-SAFE DIRECTION ──────────────────────────────
 * A live PTY producing classified output is positive, present-tense evidence that the session is
 * running, and it outranks a registry entry which is at best a past-tense one. The registry is
 * cleared on every pane mount (`deadSessionRegistry.forgetAgentDeath`, wired to the same
 * `openDeathRecord` call the durable ledger uses), so this should never fire — but "never paint a
 * working agent as dead" is the one error this module must not make, and a guard is cheaper than
 * the argument that it cannot happen.
 *
 * Returns a NEW map only when something changed; otherwise the SAME reference, so a no-op cannot
 * churn renders. Mirrors every other overlay in this pipeline.
 */
export function withDeadSessionCalm(
  agents: readonly AgentTab[],
  statusMap: StatusMap,
  deathCauseOf: (id: string) => DeathCause | undefined,
): StatusMap {
  let out: StatusMap | null = null;
  for (const a of agents) {
    if (!isRecoverableDeadSession(deathCauseOf(a.id))) continue;
    const current = statusMap[a.id];
    // See the header: present-tense liveness beats a past-tense record.
    if (current === "working") continue;
    if (current === RECOVERING_DEAD_STATUS) continue;
    out ??= { ...statusMap };
    out[a.id] = RECOVERING_DEAD_STATUS;
  }
  return out ?? statusMap;
}
