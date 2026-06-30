// Pure authorization for what a phone may inject into a local agent's PTY. Kept separate from
// the socket plumbing so the security-critical gates are unit-testable. A phone (the user's
// remote) can drive a PTY only via these two paths; everything else is dropped.

export interface DecisionPayload {
  attention_id?: string;
  agent_id?: string;
  reply?: string;
  submit?: boolean;
}
export interface AgentInputPayload {
  agent_id?: string;
  text?: string;
}
export interface SuggestionClickPayload {
  agent_id?: string;
  button_id?: string;
}
export interface PtyWrite {
  agentId: string;
  text: string;
}

const MAX = 4000;

/**
 * Authorize a phone DECISION. A decision may ONLY drive an agent we actually raised an attention
 * for (looked up by its per-attention id), so a relay/phone can't inject into an arbitrary PTY.
 * Single-use: a valid decision CONSUMES the attention from `liveAttentions`, so a replay returns
 * null. Returns the target agent + framed PTY text, or null if unauthorized/invalid.
 */
export function authorizeDecision(
  liveAttentions: Map<string, string>,
  d: DecisionPayload,
): PtyWrite | null {
  if (!d || typeof d.attention_id !== "string") return null;
  const agentId = liveAttentions.get(d.attention_id);
  if (!agentId) return null; // not an attention we raised (or already consumed)
  if (typeof d.reply !== "string" || d.reply.length > MAX) return null;
  liveAttentions.delete(d.attention_id); // one decision per raised attention
  const text = d.submit && !d.reply.endsWith("\n") ? `${d.reply}\n` : d.reply;
  return { agentId, text };
}

/**
 * Authorize phone free-text AGENT_INPUT. Allowed ONLY for an agent the phone is currently
 * watching (drill-in) — never an unwatched/arbitrary agent. Submits (trailing newline) for
 * parity with the decision path. Returns the target agent + text, or null.
 */
export function authorizeAgentInput(
  watched: Set<string>,
  i: AgentInputPayload,
): PtyWrite | null {
  if (!i || typeof i.agent_id !== "string" || !watched.has(i.agent_id)) return null;
  if (typeof i.text !== "string" || i.text.length > MAX) return null;
  const text = i.text.endsWith("\n") ? i.text : `${i.text}\n`;
  return { agentId: i.agent_id, text };
}

/**
 * The single authorization gate for a phone suggestion click: allowed ONLY for a watched agent and
 * a button id the desktop actually pushed (resolved via `lookup`). Returns the target agent + the
 * RAW pushed value (un-framed), or null. Both the PTY-write path and the control-action path branch
 * off this one result, so the gate can never diverge.
 */
export function resolveSuggestionClick(
  watched: Set<string>,
  c: SuggestionClickPayload,
  lookup: (agentId: string, buttonId: string) => string | null,
): { agentId: string; value: string } | null {
  if (!c || typeof c.agent_id !== "string" || !watched.has(c.agent_id)) return null;
  if (typeof c.button_id !== "string") return null;
  const value = lookup(c.agent_id, c.button_id);
  if (value == null || value.length > MAX) return null;
  return { agentId: c.agent_id, value };
}

/** Frame a value for SUBMISSION into the PTY: ensure exactly one trailing newline so a prompt is
 *  actually entered (terminal keystroke values like "2\n" already have it). */
export function frameSubmit(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
