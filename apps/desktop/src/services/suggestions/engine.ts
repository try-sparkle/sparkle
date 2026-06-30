import { detectTerminalPrompts } from "./heuristics";
import { SEED_CATALOG } from "./catalog";
import { deriveContextTags } from "./contextTags";
import { useSuggestionStore } from "../../stores/suggestionStore";
import { chatOnce, extractJson } from "../anthropic";
import type { SuggestionButton, SuggestionSet } from "./types";

const MAX_BUTTONS = 3;
const SCROLLBACK_LINES = 300;

// callHaiku returns the RAW model reply text; the engine parses it (injectable for tests).
export type HaikuFn = (system: string, user: string) => Promise<string>;
export interface ComputeOpts {
  agentId: string;
  scrollback: string;
  aiEnabled: boolean;
  entitled: boolean;
  callHaiku?: HaikuFn;
}

export { deriveContextTags };

const SYSTEM = [
  "You suggest 1-3 next actions a developer would take, given recent terminal output.",
  "Only suggest actions the user plausibly does habitually in this exact situation.",
  "Reply with ONLY a JSON array of objects: {label, value}.",
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
  } catch {
    buttons = []; // fail closed on any error / parse failure
  }
  return { agentId, buttons };
}
