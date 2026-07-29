// Where does this message go? — the decision the compose box's target toggle used to make for us.
//
// See PRD/sparkle/concierge-auto-routing.md §2. The box is now empty and the user never picks a
// destination, so every send lands here first.
//
// HEURISTICS ONLY — deterministic, zero latency, zero cost. They cover the overwhelming majority of
// sends: nothing to prompt, an answer to a question the agent is visibly asking, or a question
// about the fleet that only Sparkle can answer.
//
// …and a FALLBACK that is a design decision, not an accident: anything the heuristics can't place
// resolves to `sparkle`. The two error directions are not symmetric. A wrong chat answer costs the
// user one click on the receipt's redirect. A paragraph wrongly typed into a live PTY cannot be
// pulled back — it may already have set an agent off doing the wrong thing. So when the router
// doesn't know, it picks the reversible side. NEVER change this fallback to "agent".
//
// There WAS a tier 2 here: one Haiku classify for the ambiguous middle. It was removed when the AI
// backend moved onto the user's own Claude Code subscription — a `claude -p` classify measures
// ~5.8s against the 4s deadline this path needs, so it would have become "always Sparkle" while
// still spending the user's quota. See the note at the end of `routeMessage` for the full reasoning.
//
// PURE BY CONSTRUCTION: this module reads no stores and makes no calls. The caller builds
// `RouteContext` and passes it in, which is what keeps the whole thing unit-testable without a live
// app — now with no impure seam left at all.
import type { AgentTabStatus } from "../types";
import { isTerseAnswer, liveOptionsFor } from "./conciergeDispatch";
import type { SuggestionButton } from "./suggestions/types";

export type RouteTarget = "sparkle" | "agent";
/** `classified` is retained in the union but no longer produced — see the tier-2 note above. It
 *  stays so persisted/telemetry rows written before the removal still typecheck. */
export type RouteSource = "heuristic" | "classified" | "fallback";

export interface RouteDecision {
  target: RouteTarget;
  /** Why, in a few words. Not user-facing copy — it exists so a misroute is debuggable. */
  reason: string;
  source: RouteSource;
}

/** The agent a message COULD reach: the actively-shown build agent, or null when none is in view. */
export interface RouteAgent {
  id: string;
  name: string;
  status: AgentTabStatus | undefined;
  /** Whether this agent can actually receive a message — `conciergeDispatch.agentCanAcceptInput`.
   *  FALSE for a cloud agent (which `dispatchConciergeAnswer` refuses outright) and for an agent
   *  the store no longer knows about.
   *
   *  REQUIRED, deliberately. As an optional field it was the one flag in this module whose absence
   *  recreated the exact bug it was added to fix: a caller that omitted it — or that passed
   *  `undefined` because its lookup failed — got a cloud agent treated as a legitimate PTY target.
   *  In a module whose whole design is "when in doubt, take the recoverable direction", a
   *  safety gate must not fail open. A caller that doesn't know cannot route to a terminal. */
  canAcceptInput: boolean;
}

/** Statuses where the agent is asking the user something RIGHT NOW.
 *
 *  Deliberately narrower than `needsAttention`, which also includes `errored`. An errored agent is
 *  STALLED, not asking — so a bare "ok" to it has nothing to answer, and routing it as free text
 *  into the PTY is exactly the irreversible direction this module exists to avoid. */
const LIVE_ASK: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["waiting", "approval"]);

export interface RouteContext {
  agent: RouteAgent | null;
}

/** Injectable seam so routing can be tested with no Tauri. */
export interface RouteDeps {
  /** The prompt options currently on the agent's screen (defaults to the real terminal read). */
  liveOptions?: (agentId: string) => SuggestionButton[];
}

/**
 * Talk ABOUT the fleet rather than an instruction TO a builder. Deliberately conservative: a false
 * `sparkle` here is cheap (one click to redirect), a false `agent` is not, so these patterns only
 * match unmistakable concierge-directed talk — status questions, "what should I do", and
 * second-person address to Sparkle itself. Anything merely *containing* one of these words still
 * falls through to the classifier.
 */
const FLEET_TALK: readonly RegExp[] = [
  // "what's going on", "what is happening", "what's the status"
  /^what(?:'s| is| are)?\b.*\b(going on|happening|status|up with|the state)\b/i,
  // "what should I do (next)", "what do I do", "where should I start"
  /^wh(?:at|ere)\b.*\bshould i\b/i,
  /^what do i (?:do|work on)\b/i,
  // Roll-call questions about the fleet.
  /^(?:which|how many|any)\b.*\b(agents?|projects?|builds?)\b/i,
  /^(?:anything|anyone|does anything)\b.*\b(need|waiting|blocked|stuck)\b/i,
  // Spend / cost. Anchored like every other entry: unanchored, "make the error message say how
  // much the retry will cost" — a plain agent instruction — short-circuited to Sparkle.
  /^how much\b.*\b(spent|cost|spend)\b/i,
  // Bare status words.
  /^(?:status|summary|recap|catch me up|sitrep)\b/i,
  // Explicit address to Sparkle ("hey sparkle", "sparkle, what…").
  /^(?:hey |ok |hi )?sparkle\b/i,
];

/** Bare affirmations/negations that only make sense as an answer to something on screen. */
const BARE_ANSWER = /^(?:y|n|yes|no|yep|yeah|nope|ok|okay|sure|go ahead|do it|approve|deny)$/i;

export function looksLikeFleetTalk(text: string): boolean {
  const t = text.trim();
  return FLEET_TALK.some((re) => re.test(t));
}

/**
 * Is this text an ANSWER to the question the agent is visibly asking? Reuses the dispatch layer's
 * own matcher (`isTerseAnswer` against the live on-screen options) rather than reimplementing it,
 * so the router's idea of "this answers the prompt" cannot drift from what delivery actually does
 * — a drift would show up as the router confidently sending a non-answer into a picker.
 */
export function looksLikeAnswer(text: string, options: SuggestionButton[]): boolean {
  const t = text.trim().replace(/[.!?]+$/, "").trim();
  if (BARE_ANSWER.test(t)) return true;
  return isTerseAnswer(text, options);
}

export async function routeMessage(
  text: string,
  ctx: RouteContext,
  deps: RouteDeps = {},
): Promise<RouteDecision> {
  const agent = ctx.agent;

  // ── Tier 1 ──────────────────────────────────────────────────────────────────────────────────
  // Nothing to prompt. Not a guess: there is literally no other destination.
  if (!agent) return { target: "sparkle", reason: "no build agent in view", source: "heuristic" };
  // An agent that cannot receive input is the same as no agent, and cheaper to discover here than
  // as a delivery failure the user reads as an error. Gated on the flag being TRUE, never on it
  // being explicitly false — see RouteAgent.canAcceptInput.
  if (!agent.canAcceptInput) {
    return { target: "sparkle", reason: "the agent in view can't take input", source: "heuristic" };
  }

  const readOptions = deps.liveOptions ?? liveOptionsFor;
  // A terminal read can throw (unmounted pane, dead PTY); an unreadable screen just means "no
  // options", never a failed send.
  let options: SuggestionButton[] = [];
  try {
    options = readOptions(agent.id);
  } catch {
    options = [];
  }

  // The agent is visibly ASKING and this reads as an answer → it belongs on the terminal.
  //
  // ONLY a LIVE_ASK status qualifies. `errored` was briefly re-admitted here on the theory that an
  // agent which crashed mid-prompt still has a real picker on screen — and it was taken back out,
  // deliberately, because the evidence doesn't support the write:
  //  • `errored` is SCREEN-DERIVED (statusRouter.fromScreen), so the process is often still
  //    running. For waiting/approval the status IS the liveness evidence; for errored nothing
  //    corroborates that the picker is still being asked.
  //  • the option detector scans a 50-line window, so an agent that ANSWERED a picker and then
  //    printed a short error trace still matches — and we would type "2" into whatever now owns
  //    the terminal, answering a prompt nobody is asking. That is the same staleness argument used
  //    two lines above to exclude idle/working; errored doesn't get an exemption from it.
  // The cost of leaving it out is one classify on a rare status, and a chat answer the user can
  // redirect in a click. The cost of getting it wrong is a keystroke that cannot be taken back.
  // When the two costs are that asymmetric, the module's own rule applies: take the reversible one.
  const liveAsk = agent.status !== undefined && LIVE_ASK.has(agent.status);
  if (liveAsk && looksLikeAnswer(text, options)) {
    return { target: "agent", reason: "answers the question on screen", source: "heuristic" };
  }

  // Talk about the fleet is Sparkle's job by definition.
  if (looksLikeFleetTalk(text)) {
    return { target: "sparkle", reason: "asks about the fleet", source: "heuristic" };
  }

  // ── No tier 2 ───────────────────────────────────────────────────────────────────────────────
  // The heuristics above didn't place this message, so it takes the reversible direction.
  //
  // There USED to be a model call here: one Haiku classify, raced against a 4s deadline. It was
  // removed when the AI backend moved onto the user's own Claude Code subscription, because the
  // numbers stopped working — and they do not work at any deadline:
  //
  //   • A `claude -p` classify measures 5.7-6.0s wall clock (three runs, warm), against a 4s
  //     deadline that exists because this sits on the critical path of pressing Enter. Every
  //     classify would have blown it, so tier 2 would have become "always Sparkle" while still
  //     paying for the call.
  //   • Raising the deadline to fit is not free either: it stalls the user's send by ~6s on exactly
  //     the ambiguous messages, which is a worse product than answering in chat with a redirect.
  //   • The deadline race ABANDONS the losing promise rather than cancelling it, so each timed-out
  //     classify would leave a `claude` process running to completion — burning the user's own
  //     subscription quota for an answer nobody reads.
  //
  // What is lost is bounded and recoverable by design: an unplaced message is answered by Sparkle,
  // and the receipt offers a one-click redirect to the agent. What is kept is the property this
  // module exists for — when the router doesn't know, it never types into a live PTY.
  return { target: "sparkle", reason: "couldn't place it — answering here is undoable", source: "fallback" };
}
