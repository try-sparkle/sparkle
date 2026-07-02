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
 * Terminate a submission with CR — the byte a physical Enter key sends. Raw-mode TUIs (Claude
 * Code's Ink pickers/composer) only treat `\r` as Enter; LF is NOT Enter there, which is why
 * phone-typed answers to a numbered picker used to vanish. Canonical-mode (line-buffered) prompts
 * still submit fine: termios ICRNL translates the CR to NL on input. A trailing LF (older phone
 * clients frame with `\n`) is converted rather than doubled.
 */
function terminateSubmit(value: string): string {
  // Strip the ENTIRE existing terminator (LF, CR, or CRLF) before appending exactly one CR — a
  // CRLF-framed value must not become "\r\r" (two Enters: answer the picker, then blindly
  // confirm whatever renders next).
  return `${value.replace(/\r?\n$|\r$/, "")}\r`;
}

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
  // The phone frames replies with a trailing LF; submit means "press Enter", so normalize to CR
  // either way (see terminateSubmit) — a reply that already carries its newline still gets fixed.
  const text = d.submit || d.reply.endsWith("\n") ? terminateSubmit(d.reply) : d.reply;
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
  return { agentId: i.agent_id, text: terminateSubmit(i.text) };
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

/** Frame a value for SUBMISSION into the PTY: ensure exactly one trailing CR (Enter) so the
 *  prompt is actually entered. Values authored with `\n` (e.g. heuristic buttons' "2\n") are
 *  normalized, not doubled. */
export function frameSubmit(value: string): string {
  return terminateSubmit(value);
}
