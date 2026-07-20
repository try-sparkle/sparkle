import type { SuggestionButton } from "./types";

// Control buttons run an APP action instead of injecting into the PTY. The action id is encoded in
// the button's `value` with a "control:" prefix so it travels end-to-end (including over the relay,
// whose wire button is just {id,label,value}) and both the desktop click handler and the relay
// click-back can route it without a separate field.
const CONTROL_PREFIX = "control:";
export const CLOSE_AGENT_ACTION = "closeAgent";

export function controlValue(action: string): string {
  return `${CONTROL_PREFIX}${action}`;
}

/** Return the control action encoded in a button value, or null if it isn't a control value. */
export function parseControlAction(value: string): string | null {
  return value.startsWith(CONTROL_PREFIX) ? value.slice(CONTROL_PREFIX.length) : null;
}

/** The green "Close Build Agent" button shown once an agent has shipped/landed. */
export function closeBuildAgentButton(): SuggestionButton {
  return {
    id: "control:closeAgent",
    label: "Close Build Agent",
    value: controlValue(CLOSE_AGENT_ACTION),
    kind: "control",
    source: "control",
  };
}

/** The "Land to Main" CTA. A PROMPT, not a control action: it tells the agent to land, so the
 *  agent runs the project's contracts (tests, roborev triage, the progress doc) that a raw
 *  `git merge` from the app would bypass. The agent asked "Want me to land it?" — this answers it.
 *  `source: "control"` marks it as a stage-derived CTA (not a scrollback-computed suggestion), which
 *  is what SuggestionRow keys its filled-pill styling off. */
export function landToMainButton(): SuggestionButton {
  return {
    id: "cta:landToMain",
    label: "Land to Main",
    value: "Land this to main.",
    kind: "prompt",
    source: "control",
  };
}

/** The "Push to Origin Main" CTA, shown once work is on LOCAL main but not yet on origin. Also a
 *  prompt, for the same reason as landToMainButton. */
export function pushToOriginMainButton(): SuggestionButton {
  return {
    id: "cta:pushToOriginMain",
    label: "Push to Origin Main",
    value: "Push main to origin.",
    kind: "prompt",
    source: "control",
  };
}
