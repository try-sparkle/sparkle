// ONE structured log line per agent status transition — the record that did not exist.
//
// Why this module exists: grepping a full day of app logs for `blocked`, `needs_you` or
// `attention_screen` returned ZERO matches. When a user reported an agent flapping
// working↔blocked, "why did it flip?" was unanswerable — the state machine kept its reasoning
// entirely in memory and published only the RESULT (`onStatus`). Several agents were then spawned
// to chase status bugs blind. A status bug is diagnosable only if the transition that caused it
// left a trace, so statusEngine now emits one line through this module on every transition.
//
// The line is deliberately flat text, not JSON: it rides the same `frontend_log` → `tracing` →
// `sparkle.log` pipe as everything else (see ../logger and src-tauri/src/logging.rs), and a human
// reconstructs one agent's whole history with ONE grep:
//
//   grep "agent-status agent=<id>" ~/Library/Logs/ai.sparkle.desktop/sparkle.log*
//
// Two hard rules, both load-bearing:
//
//  1. NEVER log terminal content. The screen snapshot is user data and can be enormous; only the
//     boolean VERDICT that `screenAwaitsInput` returned is recorded. `screen=awaiting` tells you
//     the classifier saw a prompt — the text that convinced it stays out of the log file forever.
//  2. Nothing here may run on the unchanged path. statusEngine calls in only AFTER it has
//     established that the status actually changed (see `StatusEngine.set`), so the per-PTY-chunk
//     hot path — which runs for every agent on every chunk — builds no strings at all.
import type { AgentTabStatus } from "@sparkle/ui";
import { log } from "../logger";
import { recordConciergeEvent } from "../stores/conciergeEventLog";

/** The literal token every transition line starts with. The grep handle: it is a fixed string that
 *  appears nowhere else, so `grep "agent-status agent=<id>"` yields exactly one agent's history in
 *  chronological order and nothing else. Exported so the tests assert the SAME string a human
 *  greps, rather than a copy that can drift away from it. */
export const STATUS_TRANSITION_MARKER = "agent-status";

/** Scope tag on the log record (`[status]` in devtools, `scope="status"` in sparkle.log). */
export const STATUS_TRANSITION_SCOPE = "status";

/**
 * WHY a transition happened, as a discrete enum rather than prose — the whole point is that these
 * are countable and greppable (`grep -c "trigger=quiet-settle"`), which prose never is.
 *
 * This is the complete set of paths that reach `StatusEngine.set`, enumerated from the engine
 * itself. Keep it that way: adding a transition to the engine without a trigger here is a TYPE
 * ERROR, which is the mechanism that stops a future path from quietly escaping the log.
 *
 *   spawn                     the initial status the engine publishes at construction. Not a
 *                             transition, but without it a history starts mid-story.
 *   spinner-seen              Claude's live status line was in this chunk → working.
 *   spinner-gone-settle       the spinner stopped re-drawing for SPINNER_GRACE_MS → screen check.
 *   quiet-settle              legacy fallback (spinner never observed): IDLE_MS of quiet → screen check.
 *   prompt-detected-midstream a real interactive prompt streamed past → waiting/approval, without
 *                             waiting for settle.
 *   stream-failure            the sticky mid-stream wedge (API-error banner / self-prompt churn)
 *                             overrode the spinner → errored.
 *   output-flowing            legacy fallback: output is moving, so the agent is working.
 *   quiet-blocked             legacy fallback: BLOCKED_MS of quiet → blocked.
 *   screen-recheck            the late second read of the rendered screen (SCREEN_RECHECK_MS).
 *   process-exit              the PTY exited → done/errored.
 *
 * `screen-recheck` and `quiet-blocked` are the two ends of a change landing on a sibling branch,
 * which replaces the quiet→blocked fallback with a screen re-check. BOTH are listed on purpose so
 * this enum needs no edit when that lands: the branch's `recheckScreen()` calls `set()`, and the
 * only thing it must add is the `"screen-recheck"` argument the compiler will demand of it.
 */
export type StatusTransitionTrigger =
  | "spawn"
  | "spinner-seen"
  | "spinner-gone-settle"
  | "quiet-settle"
  | "prompt-detected-midstream"
  | "stream-failure"
  // An ACCOUNT limit (session window or spend cap) — distinct from `stream-failure` on purpose, so
  // "this agent is barred until 4pm" is greppable in the transition log rather than buried among
  // crashes and transient 5xx it has nothing in common with.
  | "quota-limit"
  | "output-flowing"
  | "quiet-blocked"
  | "screen-recheck"
  | "process-exit";

/** What `screenAwaitsInput` returned, for the triggers where a screen classification decided the
 *  outcome. The VERDICT only — never the screen text (see rule 1 above). */
/** What the screen classifier concluded, when it was consulted at all.
 *
 *  `"blank"` is NOT a third opinion — it means the classifier was handed nothing to judge (no
 *  `getScreen` wired, or `snapshotScreen` returned an empty viewport, both of which make
 *  `screenAwaitsInput` short-circuit `false` before it examines anything). Logging those as `calm`
 *  made "the classifier read a real screen and found no question" indistinguishable from "there was
 *  no screen" — and a blank snapshot is a leading suspect for the false-GRAY bug this line was added
 *  to diagnose, so the log was hiding its own subject (roborev 54741). */
// `working` = the LIVE STATUS LINE was still painted on the viewport when a settle fired. It is
// distinct from `calm` on purpose: both mean "no prompt on screen", but `calm` is a settled turn
// and `working` is a settle REFUSED because the agent is visibly still going. Telling them apart
// in the log is what makes a false-gray report answerable.
export type ScreenVerdict = "awaiting" | "calm" | "blank" | "working";

export interface StatusTransitionEvent {
  agentId: string;
  /** The status being left. `null` for the `spawn` event, which leaves nothing. */
  from: AgentTabStatus | null;
  to: AgentTabStatus;
  trigger: StatusTransitionTrigger;
  /** Present only when a screen classification was involved (settle, screen-recheck). */
  screen?: ScreenVerdict;
  /** Monotonic milliseconds since process start — see `monotonicNow`. */
  monotonicMs: number;
}

/**
 * A monotonic clock reading, in whole milliseconds.
 *
 * Monotonic, not wall-clock, because the question these lines answer is "how long between the
 * flips?" — and the log file's own wall-clock stamps can't answer it across an NTP correction or a
 * sleep/wake, which is exactly when a stall-timer bug shows up. `performance.now()` is present in
 * both the webview and the test runner; the guard is for a bare non-DOM context, where a missing
 * clock must degrade to 0 rather than throw and take the transition down with it.
 */
export function monotonicNow(): number {
  // `typeof performance !== "undefined"` FIRST, as a bare identifier (roborev 54741). The previous
  // `typeof performance?.now === "function"` still EVALUATES the `performance` binding, and optional
  // chaining only guards null/undefined VALUES — not an undeclared identifier. In the bare non-DOM
  // context this guard exists for, `performance` is undeclared, so that form threw ReferenceError
  // instead of returning false. Since logStatusTransition runs from the StatusEngine constructor,
  // the throw took engine construction down with it — precisely the outcome documented above as
  // prevented. Only `typeof <bare>` is safe on a possibly-undeclared global.
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? Math.round(performance.now())
    : 0;
}

/** Render one event as the single line that lands in sparkle.log. Pure and exported so the format
 *  is asserted directly, without a logger spy having to re-derive it. */
export function formatStatusTransition(ev: StatusTransitionEvent): string {
  const from = ev.from ?? "(new)";
  const screen = ev.screen ? ` screen=${ev.screen}` : "";
  return `${STATUS_TRANSITION_MARKER} agent=${ev.agentId} ${from}->${ev.to} trigger=${ev.trigger}${screen} mono=${ev.monotonicMs}`;
}

/**
 * Emit one transition.
 *
 * INFO, not DEBUG, and that is the entire point: debug forwarding is OFF in production builds
 * (see ../logger), so a debug line would be absent from precisely the log a user sends in — the
 * failure this work exists to end. The volume is bounded by transitions, not by chunks: a healthy
 * agent flips a handful of times per turn, and an agent that flips enough to matter is the bug.
 *
 * Best-effort by construction: `log.info` swallows a failed IPC, so a broken logger can never
 * break the state machine.
 */
export function logStatusTransition(ev: StatusTransitionEvent): void {
  log.info(STATUS_TRANSITION_SCOPE, formatStatusTransition(ev));
  recordStatusEvents(ev);
}

/**
 * The same transition, ALSO recorded in the concierge's drainable event log.
 *
 * WHY HERE. This function is the single choke point every `StatusEngine.set` funnels through — the
 * engine's own comment says a path added later cannot escape it — which makes it the one place an
 * event source can be attached without the engine growing a second notion of what a transition is.
 * The log line and the event carry the SAME facts from the SAME call, so they can never disagree
 * about whether a flip happened.
 *
 * THREE KINDS OUT OF ONE INPUT, because the PRD asks about spawn and exit separately and the
 * engine already distinguishes them:
 *
 *   • `spawn` (the constructor's initial publish, `from: null`) is the agent's session STARTING. It
 *     is emitted as `agent_spawned` and NOT as `agent_status` — a "transition" out of nothing is not
 *     a status change, and reporting one would have the concierge announce a flip that never
 *     occurred.
 *   • `process-exit` emits `agent_exited` IN ADDITION to the status change, not instead of it. The
 *     status genuinely did change (to `done` or `errored`) and a reader watching `agent_status`
 *     must still see it; a reader watching only `agent_exited` gets the fact it subscribed to.
 *   • everything else is one `agent_status`.
 *
 * THE SCREEN VERDICT IS DELIBERATELY NOT CARRIED. Rule 1 at the top of this file keeps terminal
 * content out of the log file; the event log is handed to a MODEL, which may quote it back, so it
 * gets the stricter treatment — the classifier's verdict is diagnostic detail for a human grepping
 * `sparkle.log`, and it is not something the concierge needs in order to know an agent moved.
 *
 * Best-effort, exactly like the `log.info` above it: this must never be able to break a state
 * machine that is mid-transition. `recordConciergeEvent` cannot throw on these inputs, and the
 * try/catch is the standing guarantee rather than a response to a known failure.
 */
function recordStatusEvents(ev: StatusTransitionEvent): void {
  try {
    if (ev.trigger === "spawn") {
      recordConciergeEvent({ kind: "agent_spawned", agentId: ev.agentId, status: ev.to });
      return;
    }
    recordConciergeEvent({
      kind: "agent_status",
      agentId: ev.agentId,
      from: ev.from ?? "",
      to: ev.to,
      trigger: ev.trigger,
    });
    if (ev.trigger === "process-exit") {
      recordConciergeEvent({ kind: "agent_exited", agentId: ev.agentId, status: ev.to });
    }
  } catch {
    // Observing a transition may never cost the transition. Nothing to report to: `log.info` is the
    // channel this module owns and it has already carried the line.
  }
}
