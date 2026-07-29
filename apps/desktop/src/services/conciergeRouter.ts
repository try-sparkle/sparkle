// Where does this message go? — the decision the compose box's target toggle used to make for us.
//
// See PRD/sparkle/concierge-auto-routing.md §2. The box is now empty and the user never picks a
// destination, so every send lands here first. Two tiers:
//
//   1. HEURISTIC — deterministic, zero latency, zero cost. Covers the overwhelming majority of
//      sends: nothing to prompt, an answer to a question the agent is visibly asking, or a
//      question about the fleet that only Sparkle can answer.
//   2. CLASSIFIED — one cheap Haiku call for the genuinely ambiguous middle.
//
// …and a FALLBACK that is a design decision, not an accident: any failure of tier 2 resolves to
// `sparkle`. The two error directions are not symmetric. A wrong chat answer costs the user one
// click on the receipt's redirect. A paragraph wrongly typed into a live PTY cannot be pulled back
// — it may already have set an agent off doing the wrong thing. So when the router doesn't know,
// it picks the reversible side. NEVER change this fallback to "agent".
//
// PURE-ish BY CONSTRUCTION: this module reads no stores. The caller builds `RouteContext` and
// passes it in, which is what keeps tier 1 unit-testable without a live app. The single impure
// thing is the tier-2 invoke, injectable via `deps` for tests.
import { invoke } from "@tauri-apps/api/core";
import { noteAiProviderFailure, noteAiProviderHealthy } from "./anthropic";
import type { AgentTabStatus } from "../types";
import { log } from "../logger";
import { isTerseAnswer, liveOptionsFor } from "./conciergeDispatch";
import type { SuggestionButton } from "./suggestions/types";

export type RouteTarget = "sparkle" | "agent";
export type RouteSource = "heuristic" | "classified" | "fallback";

/** How long tier 2 gets before we stop waiting on it. The Rust side's own bound is
 *  CONNECT_TIMEOUT + CLASSIFY_READ_TIMEOUT (~40s) — far too long to hold a send with the user's
 *  text in limbo. A classify that hasn't answered in this long is treated exactly like an error:
 *  route to `sparkle`, the recoverable direction.
 *
 *  4s, not the 2.5s first tried: this has to cover TLS connect + the proxy hop + a Haiku round
 *  trip, and on a cold connection 2.5s would time out a large share of classifies. That failure is
 *  expensive in a way the others are not — the losing promise is ABANDONED, not cancelled, so the
 *  server still bills the credit while the answer is discarded. Timeouts therefore log distinctly
 *  (see the `deadline` branch), so systematic ones are detectable rather than reading as ordinary
 *  fallbacks in a ledger full of identical "Routing a message" charges. */
export const ROUTE_DEADLINE_MS = 4000;

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

/** Injectable seams so tier 1 can be tested with no Tauri and tier 2 with no network. */
export interface RouteDeps {
  /** The prompt options currently on the agent's screen (defaults to the real terminal read). */
  liveOptions?: (agentId: string) => SuggestionButton[];
  /** The Haiku classify call (defaults to the Tauri command). */
  classify?: (text: string, context: string) => Promise<string>;
  /** Override the tier-2 deadline (defaults to ROUTE_DEADLINE_MS). */
  deadlineMs?: number;
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

/** How many on-screen options, and how much of each, reach the classifier. A screenful of long
 *  labels would otherwise bill unbounded metered INPUT tokens on every ambiguous send. */
const MAX_OPTIONS = 6;
const MAX_LABEL_CHARS = 80;

/** The compact "what is this agent doing" line handed to the classifier. Bounded (see above) and
 *  built to be treated as DATA — the agent name and option labels are terminal output, which is
 *  untrusted content the classifier must not read as instructions (see route_classify.rs). */
export function contextLine(agent: RouteAgent, options: SuggestionButton[]): string {
  const labels = options
    .slice(0, MAX_OPTIONS)
    .map((o) => o.label.slice(0, MAX_LABEL_CHARS))
    .join(" / ");
  const asking = labels ? ` It is on screen asking: ${labels}.` : "";
  const name = agent.name.slice(0, MAX_LABEL_CHARS);
  return `The user is looking at a coding agent named "${name}" (status: ${agent.status ?? "unknown"}).${asking}`;
}

/** Read the model's verdict. Tolerant of a chatty reply (same habit as naming.rs's parser), but
 *  it must be UNAMBIGUOUS — a reply mentioning both destinations is treated as no answer, so it
 *  falls through to the safe default rather than being decided by regex ordering. */
export function parseVerdict(raw: string): RouteTarget | null {
  const t = raw.toLowerCase();
  const agent = /\bagent\b/.test(t);
  // Both alternatives need the trailing boundary. `/\bsparkle|\bchat\b/` groups as
  // `(\bsparkle)|(\bchat\b)`, so "sparkles"/"sparkled" matched — a real bug, not a style nit.
  const sparkle = /\b(?:sparkle|chat)\b/.test(t);
  if (agent === sparkle) return null; // both or neither → not a usable answer
  return agent ? "agent" : "sparkle";
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

  // ── Tier 2 ──────────────────────────────────────────────────────────────────────────────────
  const classify = deps.classify ?? invokeClassify;
  // Captured once: the log below must report the deadline that ACTUALLY fired, not the default.
  // Logging a constant while an override was in force defeats the whole point of the branch, which
  // is making systematic deadline problems measurable.
  const deadlineMs = deps.deadlineMs ?? ROUTE_DEADLINE_MS;
  try {
    // Raced against a deadline: the Rust bound is ~40s, which would hold the user's send hostage.
    const reply = await withDeadline(
      Promise.resolve().then(() => classify(text, contextLine(agent, options))),
      deadlineMs,
    );
    const verdict = parseVerdict(reply);
    if (verdict) {
      return {
        target: verdict,
        reason: verdict === "agent" ? "reads as work for the agent" : "reads as a question for me",
        source: "classified",
      };
    }
    log.warn("router", "unusable verdict, defaulting to Sparkle", { reply });
    return { target: "sparkle", reason: "the router gave no clear answer", source: "fallback" };
  } catch (e) {
    // NOT silent. A swallowed failure here is invisible twice over: the user gets a chat answer
    // with no hint that routing failed, and an out-of-credits account (the proxy's typed
    // `insufficient_credits:<bal>`) looks identical to being offline.
    const message = e instanceof Error ? e.message : String(e);
    // A timeout is logged as its own event, not folded in with the rest: it is the failure that
    // still SPENT a credit (the abandoned call completes server-side), so a systematic deadline
    // problem has to be greppable rather than hidden among ordinary fallbacks.
    if (message.includes("deadline")) {
      log.warn("router", `classify exceeded ${deadlineMs}ms — billed but discarded`, { deadlineMs });
    } else {
      log.warn("router", "classify failed, defaulting to Sparkle", { message });
    }
    return { target: "sparkle", reason: failureReason(message), source: "fallback" };
  }
}

/** The default tier-2 seam: the Tauri command. Extracted so a test can assert the command name and
 *  payload shape — a rename on either side of the IPC boundary otherwise fails silently at runtime
 *  and routes to `sparkle` forever, which looks exactly like the intended fallback. */
export function invokeClassify(text: string, context: string): Promise<string> {
  // Every proxied AI wrapper reports what it learned about Sparkle's provider account — there is
  // no single JS chokepoint (each command has its own wrapper), so a wrapper that skips this both
  // hides a live outage and, worse, leaves a false one on screen after recovery (roborev 54761).
  return invoke<string>("route_classify", { text, context }).then(
    (out) => {
      noteAiProviderHealthy();
      return out;
    },
    (err: unknown) => {
      noteAiProviderFailure(err);
      throw err;
    },
  );
}

/** Reject with `deadline` once `ms` have passed. The losing promise is left to settle unobserved;
 *  it has no side effects beyond a metered call already made. */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("deadline")), ms);
    }),
  ]);
}

/** Turn a failure into a short debuggable reason. The classes come from the proxy
 *  (`services/anthropic.ts` maps the same strings), so a misroute leaves a trace of WHY. */
export function failureReason(message: string): string {
  // `includes`, not `startsWith`: the IPC layer wraps errors ("invoke failed: insufficient_credits:0"),
  // so an anchored match quietly fell through to the generic reason — losing exactly the class this
  // function exists to name.
  if (message.includes("insufficient_credits")) return "out of credits — answering here instead";
  if (message.includes("deadline")) return "the router took too long — answering here is undoable";
  // Signed-out is its OWN class. Folding it into "offline" mislabels a persistent, user-fixable
  // state as a transient network blip — and this string is what a future debugger reads.
  if (message.includes("not signed in")) return "not signed in — answering here instead";
  if (message.includes("ai_unreachable")) {
    return "couldn't reach the router (offline) — answering here is undoable";
  }
  if (message.includes("ai_unconfigured")) return "routing isn't configured — answering here instead";
  return "couldn't tell — answering here is undoable";
}
