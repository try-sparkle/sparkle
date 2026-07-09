import { detectTerminalPrompts } from "./heuristics";
import { SEED_CATALOG } from "./catalog";
import { deriveContextTags } from "./contextTags";
import { useSuggestionStore } from "../../stores/suggestionStore";
import { chatOnce, extractJson } from "../anthropic";
import { log } from "../../logger";
import type { SuggestionButton, SuggestionSet } from "./types";

// Surface up to THREE candidate actions, ordered most-likely-first. The composer shows only
// index [0] at rest; the caret popover discloses #2 and #3. Capping here (not in the UI) means
// both desktop and the phone relay receive the same short, ranked set.
const MAX_BUTTONS = 3;
const SCROLLBACK_LINES = 300;

// callHaiku returns the RAW model reply text; the engine parses it (injectable for tests).
export type HaikuFn = (system: string, user: string) => Promise<string>;
export interface ComputeOpts {
  agentId: string;
  scrollback: string;
  aiEnabled: boolean;
  entitled: boolean;
  // Whether the network is reachable. When explicitly false we skip the (guaranteed-to-fail)
  // learned Haiku call entirely and throw SuggestionOfflineError instead of DNS-erroring per attempt.
  // Optional/undefined is treated as online, so callers that don't know stay on the normal path.
  online?: boolean;
  callHaiku?: HaikuFn;
}

// Thrown when the learned (networked) tier is asked to run while the app knows it's offline. It's a
// RETRYABLE condition — distinct from a real API failure — so the hook can defer to reconnect
// instead of burning its bounded retry budget and logging a scary warning on a connectivity blip.
export class SuggestionOfflineError extends Error {
  constructor() {
    super("suggestions: offline, learned compute deferred");
    this.name = "SuggestionOfflineError";
  }
}

export { deriveContextTags };

const SYSTEM = [
  "You suggest the next actions a developer would most likely take, given recent terminal output.",
  "Only suggest actions the user plausibly does habitually in this exact situation.",
  "Reply with ONLY a JSON array of up to THREE objects: {label, value}, ordered MOST-LIKELY FIRST",
  "(index 0 = the single most-likely action). Fewer than three is fine; do not pad with weak guesses.",
  "label: <=40 chars button text. value: a natural-language instruction to send to the",
  "coding agent (e.g. 'Rebase main, open a PR, and merge'). NEVER raw shell commands or keystrokes.",
  "If nothing is clearly worth suggesting, reply []. Never suggest destructive actions.",
].join(" ");

function lastLines(s: string, n: number): string {
  return s.replace(/\r/g, "").split("\n").slice(-n).join("\n");
}

interface RawBtn {
  label?: unknown;
  value?: unknown;
}

function sanitize(raw: unknown): SuggestionButton[] {
  if (!Array.isArray(raw)) return [];
  const out: SuggestionButton[] = [];
  for (const r of raw as RawBtn[]) {
    if (typeof r?.label !== "string" || typeof r?.value !== "string") continue;
    // SECURITY: learned (AI-generated) buttons ALWAYS go to the agent as a natural-language
    // prompt — never raw PTY keystrokes. Scrollback is untrusted (a prompt-injection surface) and
    // the label is independent of the value, so a benign-looking label must not be able to carry a
    // hidden destructive keystroke straight to the terminal. Raw-keystroke ("terminal") buttons
    // come only from the local, trustworthy heuristic detector (y/n, menu digits).
    out.push({
      id: `learned:${out.length}:${r.label.slice(0, 24)}`,
      label: r.label.slice(0, 40),
      value: r.value.slice(0, 2000),
      kind: "prompt",
      source: "learned",
    });
    if (out.length >= MAX_BUTTONS) break;
  }
  return out;
}

export async function computeSuggestions(opts: ComputeOpts): Promise<SuggestionSet> {
  const { agentId, scrollback } = opts;

  // Tier 1: free heuristics. If present, return immediately — never spend a Haiku call.
  const heur = detectTerminalPrompts(scrollback);
  if (heur.length > 0) return { agentId, buttons: heur.slice(0, MAX_BUTTONS) };

  // Tier 2: learned actions — fail closed.
  if (!opts.aiEnabled || !opts.entitled) return { agentId, buttons: [] };

  // Offline: the Haiku call can only DNS-fail. Skip it and signal a retryable-on-reconnect state
  // rather than making (and logging) a doomed request. Heuristics above already returned if present.
  if (opts.online === false) throw new SuggestionOfflineError();

  const tags = deriveContextTags(scrollback);
  const history = useSuggestionStore.getState().topByContext(tags, 8);
  const call = opts.callHaiku ?? ((sys, user) => chatOnce(sys, user, 512));

  const user = [
    `Recent terminal output:\n${lastLines(scrollback, SCROLLBACK_LINES)}`,
    `\nContext tags: ${tags.join(", ") || "(none)"}`,
    `\nActions this user has taken in similar situations (most relevant first):`,
    history.length
      ? history.map((h) => `- ${h.label} => ${JSON.stringify(h.value)} (${h.kind})`).join("\n")
      : "(no history yet)",
    `\nGeneric actions you MAY draw on when they fit:`,
    SEED_CATALOG.map((c) => `- ${c.label} (${c.when})`).join("\n"),
  ].join("\n");

  let buttons: SuggestionButton[] = [];
  try {
    const reply = await call(SYSTEM, user);
    buttons = sanitize(JSON.parse(extractJson(reply)));
  } catch (err) {
    // A failed call or unusable (truncated/malformed) reply is RETRYABLE, not "nothing to
    // suggest" — rethrow so the hook's bounded failure budget owns it. Resolving [] here would
    // let the hook commit lastHash for this settled state, permanently suppressing its buttons
    // after one transient API error. Fail-closed-empty stays reserved for a genuine model "[]"
    // (and for the aiEnabled/entitled gates above). Known asymmetry, accepted: a reply that
    // parses to valid JSON of the wrong SHAPE sanitizes to [] and resolves (treated as "model
    // offered nothing usable"), while non-JSON rethrows — both outcomes are bounded and logged,
    // and distinguishing them would add a branch for a rare flavor of model misbehavior.
    // Log at DEBUG, not WARN: the rethrow below reaches the hook's own catch, which logs the SAME
    // error at WARN ("compute failed") with the retry-budget context. Warning here too would emit
    // two WARN lines per failure — during an AI backend hiccup/outage that doubles the noise and
    // buries real signal. Keep this line for the unique `tags` diagnostic it carries, at debug.
    log.debug("suggestions", "learned compute failed", {
      agentId,
      tags,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err instanceof Error ? err : new Error(String(err));
  }
  return { agentId, buttons };
}
