// brainstormBridge — a tiny imperative registry that lets non-React code (the connectivity
// re-query) deliver a prompt into a Brainstorm agent's chat. A Brainstorm agent's conversation
// state (chat id, messages) lives inside its mounted <BrainstormPanel>, so there's no store to
// call. Each mounted panel registers a handler keyed by its agent id; re-query looks it up.
// (bead )
type Handler = (text: string) => void;

const handlers = new Map<string, Handler>();

/** Register a panel's prompt handler. Returns an unregister fn (call on unmount). */
export function registerBrainstorm(agentId: string, handler: Handler): () => void {
  handlers.set(agentId, handler);
  return () => {
    // Only remove if we're still the active handler — a remount may have replaced us, and a
    // stale cleanup from the old mount must not drop the new panel's handler.
    if (handlers.get(agentId) === handler) handlers.delete(agentId);
  };
}

/** Deliver text to the agent's handler if one is mounted. Returns whether it was delivered. */
export function sendToBrainstorm(agentId: string, text: string): boolean {
  const handler = handlers.get(agentId);
  if (!handler) return false;
  handler(text);
  return true;
}
