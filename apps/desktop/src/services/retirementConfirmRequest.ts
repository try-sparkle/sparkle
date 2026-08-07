// ASK THE HUMAN — the one channel a machine close has for reaching the confirm dialog.
//
// `closeBuildAgent` refuses a landed build agent unless a person confirmed it (bead sparkle-0l9xk).
// That refusal is correct, and on its own it turns the green "Close Build Agent" button into a
// button that does nothing: the suggestion row only OFFERS that button once an agent has shipped,
// which is exactly the population the gate refuses. A control that silently no-ops is worse than
// the silent teardown it replaced — the founder clicks, the row stays, and nothing says why.
//
// So a refused machine close does not end there. It REQUESTS the dialog, and `AgentSidebar`
// (which owns `retireConfirmId`) opens it. The click still leads somewhere; what changed is that
// what it leads to is a person reading what the agent reported before the row goes.
//
// WHY AN EMITTER AND NOT A STORE: the request is an EVENT, not state. Two clicks on the same agent
// mean "open it" twice, and a store holding `retireConfirmId` here would duplicate the state the
// sidebar already owns — leaving two places that can disagree about whether the dialog is up. Same
// shape as services/dispatchIntent and services/claudeAuthSignal, for the same reason.
//
// FIRE-AND-FORGET, BY DESIGN. If no sidebar is mounted (a satellite window, a torn-out project),
// the request is dropped and the caller is told so. It must NOT fall back to closing the agent:
// "nobody is listening" is not consent.

/** A listener returns TRUE if it actually opened the dialog for this agent. */
type Listener = (agentId: string) => boolean;

const listeners = new Set<Listener>();

/**
 * Subscribe the surface that owns the retirement dialog. Returns the unsubscribe.
 *
 * The listener must return whether it opened the dialog — a mounted sidebar rendering a DIFFERENT
 * project cannot show a confirm for an agent it does not have, and answering `true` there would
 * report a dialog the human never saw.
 */
export function subscribeRetirementConfirmRequests(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Ask for the retirement confirm dialog for `agentId`.
 *
 * Returns TRUE when some surface opened it. FALSE means nothing is listening (or no listener owns
 * this agent) — the caller must then say so rather than assume the human was asked.
 */
export function requestRetirementConfirm(agentId: string): boolean {
  let opened = false;
  for (const l of listeners) {
    // Every listener runs even after one succeeds: `opened` is an OR, not a short-circuit. Two
    // windows can both hold the project, and skipping the rest would leave one of them stale.
    try {
      if (l(agentId)) opened = true;
    } catch {
      // A throwing listener must not stop the others, and must not be counted as having opened.
    }
  }
  return opened;
}

/**
 * A refused close could not reach ANY surface — no sidebar holds this agent (a satellite window, a
 * project not currently rendered in either column).
 *
 * THROWN rather than returned as a `false`, because `false` was already spoken for: in
 * `applySuggestion` it means "the host vetoed this", which every host answers by staying quiet —
 * the host already knows why. This is the opposite: nothing closed, no dialog opened, and the host
 * has no idea. Returning `false` here made the click a completely silent no-op on the one surface
 * whose contract is that every delivery path reports its outcome (roborev 59153, and the same shape
 * as the dead-PTY case in roborev 54397 that `PtyGoneError` exists for).
 */
export class RetirementConfirmUnreachableError extends Error {
  constructor(readonly agentId: string) {
    super(`no mounted surface can show the retirement confirm for ${agentId}`);
    this.name = "RetirementConfirmUnreachableError";
  }
}

/** TEST SEAM ONLY — drop every listener. */
export function __resetRetirementConfirmRequestsForTest(): void {
  listeners.clear();
}
