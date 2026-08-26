// Deterministic, rules-first transcript -> intent classifier. Bead sparkle-uz87.5.
//
// NO MODEL CALL, ON PURPOSE. This runs on the hot path between "the user stopped talking" and "the
// swarm answers", and the two things that path cannot afford are latency and non-determinism. The
// concierge's own router learned this the expensive way: its tier-2 `claude -p` classify measured
// ~5.8s against a 4s deadline, so it was removed (see conciergeRouter.ts's header). A rules pass is
// instant, testable offline with no fixtures, and gives the same answer on every run — which is
// what lets the whole suite below assert real outputs instead of mocking a model.
//
// ══ PRECEDENCE ═══════════════════════════════════════════════════════════════════════════════════
// English overlaps. "remind me to search for the flaky test" contains a search verb AND a reminder
// verb; "open the search screen" contains a navigation verb AND a search verb. So a rules
// classifier is not a set of independent patterns — it is an ORDERED list, and the order is the
// interesting half of the design. RULES below is that order, highest first, first match wins:
//
//   1. remind    — an explicit reminder verb is a COMMITMENT. If we drop it the user loses
//                  something they asked us to hold; every other misread is merely a wrong answer
//                  they can repeat. So it outranks everything, including the verbs inside it.
//   2. dispatch  — starting or messaging an agent is the only genuinely SIDE-EFFECTING category
//                  here, and when an utterance asks for one alongside something passive
//                  ("start an agent and open its pane"), the side effect is the ask; the passive
//                  half is a click the user can still make by hand.
//   3. navigate  — an explicit "open X" names a DESTINATION, which is more specific than the
//                  content verbs below it. "Open the search screen" is navigation, not a search.
//   4. summarize — an explicit "summarize"/"recap" names the SHAPE OF THE OUTPUT, while the status
//                  words below name a TOPIC. When both appear ("summarize what the fleet is
//                  doing") the user has told us both, and the shape is the part only they can
//                  choose.
//   5. status    — the fleet question. Below summarize for the reason above, above search because
//                  "find out what the agents are up to" is a status question wearing a search verb.
//   6. search    — LAST before the fallback, because its verbs are the most promiscuous in
//                  English: find, look up, where is. Almost any request can be phrased with one,
//                  so it yields to every rule that matched something more specific.
//   7. chat      — the explicit fallback. Not a gap: `classifyTranscript` always returns an intent.
//
// `classify.test.ts` pins each of those adjacencies with a transcript that matches BOTH rules, so
// reordering RULES turns the suite red rather than silently changing behaviour.
//
// ══ CONFIDENCE ═══════════════════════════════════════════════════════════════════════════════════
// A rule can match its VERB and still have nothing to act on: "search" on its own is a matched
// search rule with an empty query. That is not a search — it is a person who trailed off. Each rule
// therefore reports whether its slots came out usable, and an unusable match is scored WEAK, below
// the router's floor, so it lands in `chat` instead of dispatching an empty action.
import type { GenieIntent, GenieNavTargetKind, GenieScope } from "./types";

/** A matched rule that filled its slots. */
export const GENIE_CONFIDENCE_STRONG = 0.9;
/** A matched rule whose slots came out empty — the verb without the object. */
export const GENIE_CONFIDENCE_WEAK = 0.35;
/** Nothing matched. */
export const GENIE_CONFIDENCE_CHAT = 0.2;

/**
 * The slot bag a rule fills. Every field is optional because each rule fills only its own; handlers
 * are what turn a bag into a typed {@link GenieAction}, and they own the defaults.
 */
export interface GenieSlots {
  query?: string;
  what?: string;
  whenText?: string;
  subject?: string;
  scope?: GenieScope;
  target?: string;
  targetKind?: GenieNavTargetKind;
  agent?: string;
  message?: string;
  brief?: string;
  mode?: "start" | "message";
}

export interface GenieClassification {
  intent: GenieIntent;
  confidence: number;
  slots: GenieSlots;
}

/**
 * Lower-case, de-punctuate, and drop a leading wake phrase ("hey sparkle, ..."). Every rule below
 * is written against THIS form, so the rules never carry their own case or filler handling.
 */
export function normalizeTranscript(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:hey |ok |okay |yo |hi )?sparkle\b[,!.]?\s*/, "")
    .replace(/[.!?,;]+$/, "")
    .trim();
}

/** Trim filler that survives a slot extraction: articles, stray prepositions, dangling commas. */
function tidySlot(value: string): string {
  return value
    .replace(/^(?:to|for|about|on|the|a|an|my|that|it)\b\s*/, "")
    .replace(/\s*\b(?:please|thanks|thank you)\b\s*$/, "")
    .replace(/[\s,;:.]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Text after the EARLIEST of `markers`, or "" when none appears. */
function after(text: string, markers: readonly string[]): string {
  let best = -1;
  let width = 0;
  for (const marker of markers) {
    const at = text.indexOf(marker);
    if (at >= 0 && (best < 0 || at < best)) {
      best = at;
      width = marker.length;
    }
  }
  if (best < 0) return "";
  return tidySlot(text.slice(best + width));
}

const WHEN_RE =
  /\b(tomorrow morning|tomorrow afternoon|tomorrow night|tomorrow|tonight|later today|this afternoon|this evening|next week|next month|in \d+ (?:minutes?|mins?|hours?|hrs?|days?|weeks?)|at \d{1,2}(?::\d{2})?\s*(?:am|pm)|at \d{1,2}(?::\d{2})|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|later)\b/;

const SCREEN_RE =
  /\b(screen|view|tab|page|board|settings|preferences|inbox|changelog|credits|dashboard|terminal|backlog)\b/;
/** Generic nouns that name the KIND of thing rather than the thing: "the settings SCREEN", "the
 *  sparkle PROJECT", "AGENT kraken". Stripped from a navigation target so `targetKind` carries the
 *  category and `target` carries only the name — otherwise the reply reads "the screen screen". */
const NAV_SUFFIX_RE = /\s*\b(?:screen|view|tab|page)\b\s*$/;
const NAV_PROJECT_SUFFIX_RE = /\s*\b(?:project|repo|repository|codebase)\b\s*$/;
const NAV_AGENT_PREFIX_RE = /^(?:agent|worker)\s+/;
const AGENT_RE = /\b(agent|agents|worker|workers|swarm|fleet)\b/;
const PROJECT_RE = /\b(project|repo|repository|branch|codebase)\b/;

const DISPATCH_MESSAGE_RE =
  /\b(?:tell|ask|message|ping)\s+(?:the\s+)?([a-z0-9@][\w@'-]*(?:\s+[a-z0-9][\w'-]*)?)\s+to\s+(.+)$/;
const DISPATCH_START_RE =
  /\b(?:start|spawn|launch|kick off|fire up|dispatch)\b[^.]*?\b(?:agent|worker|build|swarm)\b/;

const NAVIGATE_VERB_RE = /\b(?:open|go to|take me to|switch to|show me|jump to|navigate to)\b/;
const SUMMARIZE_VERB_RE =
  /\b(?:summar(?:y|ise|ize|ised|ized|ising|izing)|recap|tl;?dr|catch me up|brief me|digest)\b/;
const SEARCH_VERB_RE = /\b(?:search|find|look up|look for|where is|where's|grep|google)\b/;

const STATUS_RES: readonly RegExp[] = [
  /\bstatus\b/,
  /\bwhat(?:'s|s| is| are)\b.*\b(?:doing|up to|working on)\b/,
  /\bhow(?:'s| is| are)\b.*\bgoing\b/,
  /\b(?:fleet|swarm)\b/,
  /\bany (?:updates?|progress)\b/,
];

/** Which scope word, if any, the utterance carries. */
function scopeOf(text: string): GenieScope {
  if (AGENT_RE.test(text)) return /\b(?:fleet|swarm|agents|workers)\b/.test(text) ? "fleet" : "agent";
  if (PROJECT_RE.test(text)) return "project";
  return "unspecified";
}

/**
 * Words that sit next to "agent"/"worker" without being its NAME. Without this, "how is the auth
 * agent going" reported the agent as "going" and "what is agent kraken doing" reported it as "is" —
 * both from a bare adjacency match, and both a wrong name is worse than no name, because the
 * consumer would go looking for an agent that does not exist.
 */
const AGENT_NAME_STOPWORDS = new Set([
  "the", "a", "an", "my", "our", "that", "this", "each", "every", "any",
  "is", "are", "was", "were", "and", "to", "on", "of", "what", "how", "s",
  "doing", "going", "up", "working", "status", "running", "done", "build",
]);

/** The agent an utterance names, when it names one at all. "" means it named none. */
function namedAgent(text: string): string {
  const at = text.match(/@([\w-]+)/);
  if (at?.[1]) return at[1];
  // "the auth agent" — the name comes BEFORE the noun, which is the commoner English shape.
  const before = text.match(/\b([a-z0-9][\w'-]*)\s+(?:agent|worker)\b/);
  if (before?.[1] && !AGENT_NAME_STOPWORDS.has(before[1])) return before[1];
  // "agent kraken" — the name comes after.
  const behind = text.match(/\b(?:agent|worker)\s+([a-z0-9][\w'-]*)\b/);
  if (behind?.[1] && !AGENT_NAME_STOPWORDS.has(behind[1])) return behind[1];
  return "";
}

interface Rule {
  intent: GenieIntent;
  matches: (text: string) => boolean;
  slots: (text: string) => GenieSlots;
  /** Did the extraction produce something actionable? Drives STRONG vs WEAK. */
  usable: (slots: GenieSlots) => boolean;
}

/** ORDERED. See the precedence block at the top of this file — the order IS the behaviour. */
export const RULES: readonly Rule[] = [
  {
    intent: "remind",
    matches: (t) => /\bremind(?:er)?s?\b/.test(t),
    slots: (t) => {
      const when = t.match(WHEN_RE)?.[0] ?? "";
      const direct = t.match(/\bremind (?:me|us)?\s*(?:to|about|that)?\s*(.*)$/);
      const noun = t.match(/\breminder\s*(?:to|about|for)?\s*(.*)$/);
      let what = direct?.[1] ?? noun?.[1] ?? "";
      if (when) what = what.replace(when, " ");
      what = tidySlot(what);
      return { what, whenText: when || undefined };
    },
    usable: (s) => Boolean(s.what),
  },
  {
    intent: "dispatch",
    matches: (t) => DISPATCH_MESSAGE_RE.test(t) || DISPATCH_START_RE.test(t),
    slots: (t) => {
      const msg = t.match(DISPATCH_MESSAGE_RE);
      if (msg) {
        return {
          mode: "message",
          agent: tidySlot(msg[1] ?? ""),
          message: tidySlot(msg[2] ?? ""),
        };
      }
      return { mode: "start", brief: after(t, [" on ", " to ", " for ", " about "]) };
    },
    usable: (s) => (s.mode === "message" ? Boolean(s.agent && s.message) : Boolean(s.brief)),
  },
  {
    intent: "navigate",
    matches: (t) => NAVIGATE_VERB_RE.test(t),
    slots: (t) => {
      const m = t.match(
        /\b(?:open|go to|take me to|switch to|show me|jump to|navigate to)\s+(?:the\s+|my\s+|an?\s+)?(.+)$/,
      );
      const raw = (m?.[1] ?? "").trim();
      const targetKind: GenieNavTargetKind = SCREEN_RE.test(raw)
        ? "screen"
        : AGENT_RE.test(raw) || raw.startsWith("@")
          ? "agent"
          : "project";
      // Strip only the GENERIC kind-noun, and only where it sits: a trailing "screen"/"project",
      // a leading "agent". Replacing the first SCREEN_RE match anywhere ate the specific word
      // instead ("the settings screen" -> "screen"), which is what the probe caught.
      let name = raw;
      if (targetKind === "screen") name = name.replace(NAV_SUFFIX_RE, "");
      else if (targetKind === "project") name = name.replace(NAV_PROJECT_SUFFIX_RE, "");
      else name = name.replace(NAV_AGENT_PREFIX_RE, "").replace(/\s*\b(?:agent|worker)\b\s*$/, "");
      return { target: tidySlot(name), targetKind };
    },
    usable: (s) => Boolean(s.target),
  },
  {
    intent: "summarize",
    matches: (t) => SUMMARIZE_VERB_RE.test(t),
    slots: (t) => {
      const tail = t.replace(SUMMARIZE_VERB_RE, "|").split("|").slice(1).join("|");
      const scoped = after(t, [" of ", " about ", " up on "]);
      const subject = scoped || tidySlot(tail);
      return { subject, scope: scopeOf(t) };
    },
    usable: (s) => Boolean(s.subject),
  },
  {
    intent: "status",
    matches: (t) => STATUS_RES.some((re) => re.test(t)),
    slots: (t) => {
      const agent = namedAgent(t);
      return { scope: agent ? "agent" : scopeOf(t) === "project" ? "project" : "fleet", target: agent };
    },
    // A bare "status?" is a COMPLETE request — there is nothing else the user needs to say — so
    // this rule is strong whenever it matches at all, unlike search or remind.
    usable: () => true,
  },
  {
    intent: "search",
    matches: (t) => SEARCH_VERB_RE.test(t),
    slots: (t) => {
      const m = t.match(
        /\b(?:search|find|look up|look for|where is|where's|grep|google)\s*(?:for\s+|in\s+)?(.*)$/,
      );
      return { query: tidySlot(m?.[1] ?? "") };
    },
    usable: (s) => Boolean(s.query),
  },
];

/**
 * Transcript -> `{ intent, confidence, slots }`. Total: every input gets an intent, and an input
 * nothing matched gets `chat` rather than a null.
 */
export function classifyTranscript(transcript: string): GenieClassification {
  const text = normalizeTranscript(transcript);
  if (!text) return { intent: "chat", confidence: GENIE_CONFIDENCE_CHAT, slots: {} };
  for (const rule of RULES) {
    if (!rule.matches(text)) continue;
    const slots = rule.slots(text);
    return {
      intent: rule.intent,
      confidence: rule.usable(slots) ? GENIE_CONFIDENCE_STRONG : GENIE_CONFIDENCE_WEAK,
      slots,
    };
  }
  return { intent: "chat", confidence: GENIE_CONFIDENCE_CHAT, slots: {} };
}
