// engineRegistry (Bug B wiring): a tiny agentId → StatusEngine map so the user-input submit paths
// (Composer / requery, which call submitPrompt directly) can reach the StatusEngine that Terminal
// owns — they're sibling components, so there's no prop chain between them, and this mirrors how the
// rest of the app reaches an agent by id (the zustand stores). It's an EXPLICIT, typed bridge (not a
// window/global reach-in): Terminal registers its engine when it mounts the PTY and unregisters on
// teardown; submitPrompt looks the engine up by id and forwards the submitted text to noteUserInput.
import type { StatusEngine } from "./statusEngine";
import type { QuotaBlock } from "./quotaBlock";

const engines = new Map<string, StatusEngine>();

/** Bind an agent's StatusEngine so submit paths can find it. Called by Terminal on PTY spawn. */
export function registerStatusEngine(agentId: string, engine: StatusEngine): void {
  engines.set(agentId, engine);
}

/** Unbind on teardown. Guarded on identity so a remount that registered a NEWER engine for the same
 *  id isn't clobbered by the OLD terminal's cleanup racing in after it. */
export function unregisterStatusEngine(agentId: string, engine: StatusEngine): void {
  if (engines.get(agentId) === engine) engines.delete(agentId);
}

/** Tell an agent's StatusEngine that `text` was just submitted (a new turn / recovery signal). A
 *  no-op when no engine is registered (e.g. a Think agent, or before the terminal mounts).
 *
 *  `machine: true` means NOBODY TYPED THIS — an auto-resume, a retry ping, a relay. The text still
 *  has to be recorded (its echo must not read as a self-prompt wedge), but it does not carry the
 *  "a person is here and driving" authority that clears a quota wall. See StatusEngine.noteUserInput. */
export function noteUserInputForAgent(
  agentId: string,
  text: string,
  opts?: { machine?: boolean },
): void {
  engines.get(agentId)?.noteUserInput(text, opts);
}

/**
 * The account-limit wall this agent is under right now, or `undefined` for none.
 *
 * `undefined` COVERS TWO CASES ON PURPOSE — no wall, and no engine registered here (a Think agent, a
 * pane this window never mounted). Both read as "no wall", never as "blocked", which is the same
 * evidence-not-inference default `thrashReportFor` and `stallReport`'s `unknown` arm use: claiming an
 * agent is quota-blocked because we could not look would suppress a real resume and paint a false red
 * on a healthy agent. The failure direction here is deliberately the safe one — a missed wall costs
 * one wasted resume, an invented one strands a working agent until a human intervenes.
 */
export function quotaBlockForAgent(agentId: string, now: number): QuotaBlock | undefined {
  return engines.get(agentId)?.quotaBlockNow(now);
}
