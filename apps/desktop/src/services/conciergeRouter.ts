// Where does this message go? — the decision the compose box's target toggle used to make for us.
//
// See PRD/sparkle/concierge-auto-routing.md §2. The box is now empty and the user never picks a
// destination, so every UNADDRESSED send lands here first.
//
// ══ THE RULE, AND IT IS ABSOLUTE ═════════════════════════════════════════════════════════════════
// `routeMessage` NEVER returns `target: "agent"`. Not on a fallback, not on a heuristic, not on any
// future tier. Everything that reaches here resolves to `sparkle`.
//
// The only things in this app that may aim a message at a live PTY are USER GESTURES, and there are
// exactly two. Both are resolved by `Concierge/composerRoute` and turned into a `{ target: "agent" }`
// decision by ConciergeHost BEFORE it ever calls this module:
//
//   1. NAMING THE AGENT — a leading `@Kraken Auth` in the text (Concierge/mentions).
//   2. MOUNTING TO IT — the cable patched into that build agent, which is the founder's rule that
//      while mounted, what you type goes to that agent's terminal. `@Sparkle` is the escape hatch.
//
// THE SECOND IS NOT A LOOSENING OF THIS RULE, and it is worth being precise about why, because it
// looks like one. What this file forbids is a DESTINATION INFERRED FROM THE TEXT — the deleted branch
// below read "the agent is asking something" plus "this reply looks terse" and concluded a terminal.
// A mount reads neither: the user clicked that row, the cable is drawn on screen, the column has
// swapped to that agent's own conversation, and the compose box is keyed to that agent's draft and
// set in that terminal's typeface. The sentence that governs this file — *"a heuristic verdict is not
// a user gesture"* — is exactly what separates the two. Nothing about the mount is a guess, and the
// user can see it without reading anything.
//
// What is still forbidden, unchanged: this module answering `agent`, on any tier, for any reason.
//
// This used to be weaker: the header said "NEVER change this FALLBACK to agent" while a heuristic
// one screen down did exactly that. The branch read "the agent on screen is in `waiting`/`approval`
// AND this text looks like an answer → type it into the terminal", and it caused real damage. The
// user was answering the CONCIERGE's own design questions in the concierge compose box while a
// build agent's pane happened to be on screen; their answers were typed into that agent's terminal.
// They only noticed because the concierge's replies stopped making sense.
//
// WHY THE BRANCH WAS WRONG, not merely mis-tuned. It inferred a DESTINATION from the shape of the
// text plus a status the user never mentioned. But the two facts it read are both about the AGENT
// ("it is asking something", "there is a picker on screen") and neither is about the USER, so the
// branch could not distinguish "answering the agent" from "answering the concierge in words that
// happen to be short". A heuristic verdict is not a user gesture. The founder's model of this
// column, verbatim: *"I'm just talking to you as the concierge, you're deciding when to send it to
// the agent."* Deciding to send is Sparkle's job downstream; picking a terminal is not this
// module's.
//
// The asymmetry that has always governed this file is the second reason, unchanged: a wrong chat
// answer costs the user one click on the receipt's redirect, while a paragraph wrongly typed into a
// live PTY cannot be pulled back — it may already have set an agent off doing the wrong thing. With
// AUTO-SEND armed it is worse still, because an inherited target plus a countdown means dictated
// speech reaches a terminal with no deliberate act at all. So this module only ever picks the
// reversible side, and now it has no branch that could pick the other one.
//
// What survives is the part that was never a guess about a terminal: which SPARKLE-side reason to
// record, so a surprising route is debuggable.
//
// There WAS a tier 2 here: one Haiku classify for the ambiguous middle. It was removed when the AI
// backend moved onto the user's own Claude Code subscription — a `claude -p` classify measures
// ~5.8s against the 4s deadline this path needs, so it would have become "always Sparkle" while
// still spending the user's quota. See the note at the end of `routeMessage` for the full reasoning.
//
// PURE BY CONSTRUCTION: this module reads no stores and makes no calls. The caller builds
// `RouteContext` and passes it in, which is what keeps the whole thing unit-testable without a live
// app — and with the terminal read gone there is no impure seam left to inject around, either.
import type { AgentTabStatus } from "../types";

/** `agent` is still a legal DECISION — ConciergeHost produces one for an @-addressed message — but
 *  it is no longer a legal verdict of {@link routeMessage}. See the header. */
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
  /** What the agent is doing right now — and DELIBERATELY READ BY NOTHING IN THE VERDICT.
   *
   *  It is carried because it is the field the removed branch keyed on. `waiting`/`approval` used to
   *  mean "this agent is asking, so a short message must be its answer", which is how the user's
   *  answers to the CONCIERGE ended up in a build agent's terminal (see the header). Keeping the
   *  field lets `conciergeRouter.test.ts` hand this module an agent in exactly that state and pin
   *  that the verdict is STILL `sparkle` — the regression is testable only because the input the old
   *  branch consumed still exists. Delete the field and the branch becomes reintroducible with fresh
   *  plumbing and no test standing in its way. */
  status: AgentTabStatus | undefined;
  /** Whether this agent can actually receive a message — `conciergeDispatch.agentCanAcceptInput`.
   *  FALSE for a cloud agent (which `dispatchConciergeAnswer` refuses outright) and for an agent
   *  the store no longer knows about.
   *
   *  It no longer gates a terminal write — nothing here can produce one — so what it decides now is
   *  only WHICH `reason` gets recorded, and it is required so that reason cannot silently become the
   *  wrong one. The gate it used to be still exists, one layer up and closer to the wire, where
   *  ConciergeHost re-checks `agentCanAcceptInput` at send time against the live store. */
  canAcceptInput: boolean;
}

export interface RouteContext {
  agent: RouteAgent | null;
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

export function looksLikeFleetTalk(text: string): boolean {
  const t = text.trim();
  return FLEET_TALK.some((re) => re.test(t));
}

// THERE IS NO `looksLikeAnswer` HERE ANY MORE, and it is not merely unused — it was deleted with the
// branch that consumed it, along with the `RouteDeps`/`liveOptions` seam that read the agent's
// screen for it. A predicate that answers "does this text look like a picker answer?" is a fine
// question for DELIVERY to ask (conciergeDispatch.isTerseAnswer still does, at the moment a message
// the user aimed at an agent is being written), and a category error for ROUTING: the shape of the
// words cannot tell you who they were addressed to. Do not reintroduce one here.

export async function routeMessage(text: string, ctx: RouteContext): Promise<RouteDecision> {
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

  // ══ WHERE THE "IT ANSWERS THE QUESTION ON SCREEN" BRANCH USED TO BE ═════════════════════════
  // It read the agent's live terminal for its on-screen options and, if `agent.status` was
  // `waiting`/`approval` and the text matched, returned `{ target: "agent" }`. That is the branch
  // that put the user's answers to the CONCIERGE into a build agent's terminal, and it is gone —
  // with its terminal read, its status set and its predicate. The header says why at length; the
  // short version is that an agent being mid-question is a fact about the AGENT, and it was being
  // used to decide something only the USER can say.
  //
  // An agent that really is asking still gets its answer, by the route that always required a
  // gesture: the user names it (`@Kraken Auth yes`), ConciergeHost builds the `agent` decision from
  // that mention, the send arms a cancellable intent, and only an expiry the user did not stop
  // reaches the PTY. Nothing about that path runs through this function.

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
