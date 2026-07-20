// engineRegistry (Bug B wiring): a tiny agentId → StatusEngine map so the user-input submit paths
// (Composer / requery, which call submitPrompt directly) can reach the StatusEngine that Terminal
// owns — they're sibling components, so there's no prop chain between them, and this mirrors how the
// rest of the app reaches an agent by id (the zustand stores). It's an EXPLICIT, typed bridge (not a
// window/global reach-in): Terminal registers its engine when it mounts the PTY and unregisters on
// teardown; submitPrompt looks the engine up by id and forwards the submitted text to noteUserInput.
import type { StatusEngine } from "./statusEngine";

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

/** Tell an agent's StatusEngine the user just submitted `text` (a new turn / recovery signal). A
 *  no-op when no engine is registered (e.g. a Think agent, or before the terminal mounts). */
export function noteUserInputForAgent(agentId: string, text: string): void {
  engines.get(agentId)?.noteUserInput(text);
}
