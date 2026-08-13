// conciergeDelegation — "the concierge is grinding through serial reads instead of delegating".
//
// THE FAILURE THIS CATCHES. Not a stall. `nudge_ladder.rs` (build agents) watches for an agent that
// STOPPED producing output; `engine/agentThrash` watches for one that never stops and never
// advances. This is a third shape again, and the hardest to see: the concierge is busy the entire
// time, producing output the whole way, and doing the wrong SHAPE of work. It reads a file, greps,
// reads a terminal, checks a PR, reads another file — one call at a time — while the founder's
// messages stack up behind the turn.
//
// THE LIVE CASE, 2026-08-13. The founder, verbatim:
//
//     "You are again not using concierge agents? I have eight queued props that you're not
//      responding to. Because you're not using concierge agents but should be. Make absolutely
//      sure that in a future release, we will fix this. And have the watcher and the pusher
//      pushing you watching and pushing you. To make sure that you use this tool that we've made
//      available, but you keep forgetting to use."
//
// A screenshot showed his messages sitting "4th in line" through "8th in line" while the concierge
// worked serially. Bead `sparkle-6vool`.
//
// WHY PROMPTING ALONE PROVABLY DOES NOT FIX IT. The instruction already exists, and has since
// 2026-07-29 — in `concierge-guidelines.md` (the app-data file `concierge_guidelines.rs` injects
// every turn). It was added a SECOND time on 2026-08-11 after the behavior did not change. Two
// reasons it was inert, both worth keeping in view:
//
//   1. It pointed at the wrong tool. It said "fan out parallel subagents via your own Agent tool",
//      but `Task`/`Agent` is NOT in `CONCIERGE_ALLOWED_TOOLS` (concierge.rs:70) — deliberately, as
//      "the concierge acts through the sparkle-control MCP surface". The concierge was being told
//      to reach for something it does not have. Its real delegation surface is
//      `sparkle_research.dispatch` and `sparkle_lifecycle.spawn_build_agent`.
//   2. `concierge_guidelines.rs:79` documents that file as governing STYLE, NOT PERMISSION — the
//      one channel the codebase itself declares advisory.
//
// So a third sentence of prompt is the option already measured as not working. This module is the
// mechanical backstop the founder asked for; the prompt fix (pointed at the RIGHT tool) is the
// root-cause half and lands beside it.
//
// WHAT IT READS. `concierge:tool` / `ConciergeToolEvent` (services/concierge.ts) — emitted by Rust
// from the same drain loop as `concierge:delta`, one event per `tool_use` block, THE MOMENT IT IS
// PARSED. That "while the turn is still running" property is the whole reason this can exist: the
// sibling `ConciergeDoneEvent.toolCalls` carries the same facts but only at turn end, by which
// point the founder has already done the waiting this is meant to prevent.
//
// PURE ON PURPOSE. No Tauri, no store, no clock. The caller owns delivery and the badge; this file
// only decides. Same split as `nudge_ladder.rs` (decision) vs `nudger.rs` (the write).

/** Consecutive investigative calls tolerated before the first nudge, when nobody is waiting. */
export const SERIAL_THRESHOLD = 6;

/**
 * The same count when the founder HAS messages queued behind this turn. Much lower on purpose: the
 * harm this feature exists to prevent is the founder waiting, so queue depth is what makes it
 * hair-trigger. Founder's call, 2026-08-12 interview ("Count + queue-aware").
 */
export const QUEUED_THRESHOLD = 2;

/**
 * Rung 3 is the last one that fires. Past it we keep the state but stop nudging — the same shape as
 * `nudge_ladder.rs`'s `GIVE_UP_AFTER`, and for the same reason: a ladder that never gives up turns
 * into noise that trains the reader to ignore it. Escalation at rung 3 has already made it visible.
 */
export const MAX_RUNG = 3;

/**
 * Built-in tools that count as "investigating rather than delegating".
 *
 * Deliberately an ALLOWLIST, not "everything that isn't a delegation". Bookkeeping calls
 * (`TodoWrite`, `ToolSearch`) and the concierge's own narration must never inflate the grind count,
 * or the ladder fires on a turn that did nothing wrong.
 */
export const INVESTIGATIVE_BUILTINS: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
];

/**
 * MCP control tools whose reads are investigation. This is the half the founder actually described
 * — "reading terminals, checking PR status one at a time" are `sparkle_terminal` and
 * `sparkle_workflow` calls, not `Read`s. Leaving them out would miss the reported behavior.
 *
 * `sparkle_research` appears here too, for its `list`/`get` ops: polling a dispatched task is
 * investigation, not delegation. The tool's own description warns "NEVER poll get in a loop", so a
 * run of those is exactly the grind we want counted. Its `dispatch` op is classified as delegation
 * before this list is consulted — see {@link classifyTool}.
 */
export const INVESTIGATIVE_MCP: readonly string[] = [
  "sparkle_terminal",
  "sparkle_workflow",
  "sparkle_board",
  "sparkle_diff",
  "sparkle_review",
  "sparkle_workspace",
  "sparkle_events",
  "sparkle_plans",
  "sparkle_attachments",
  "sparkle_research",
  "get_state",
];

/** The ops that ARE delegation — the thing the nudge is asking for. Founder's call, 2026-08-12. */
export const DELEGATION_OPS: readonly string[] = [
  "dispatch",
  "spawn_build_agent",
  "spawn_cloud_build_agent",
];

/** Tools that can carry a delegating op. */
const DELEGATION_TOOLS: readonly string[] = ["sparkle_research", "sparkle_lifecycle"];

const MCP_PREFIX = "mcp__sparkle-control__";

export type ToolKind = "investigative" | "delegation" | "other";

/** One live tool call, as `ConciergeToolEvent` delivers it. */
export interface ToolCallInput {
  name: string;
  /**
   * The call's arguments. MAY BE TRUNCATED AND THEREFORE NOT VALID JSON — Rust clamps the live
   * event's input to `MAX_LIVE_TOOL_INPUT_CHARS` (512). Every read of this field must survive that;
   * see {@link readOp}.
   */
  input?: string;
}

/**
 * Pull the `op` out of an MCP call's arguments.
 *
 * TWO STRATEGIES, AND THE SECOND IS LOAD-BEARING. A guarded `JSON.parse` is tried first because it
 * is exact. It fails outright on a truncated payload, which is not an edge case — it is the normal
 * appearance of any call with a large `args`. So the fallback scans for the `"op"` key textually.
 * `op` is serialized before `args` in every call shape we emit, so it survives truncation that
 * destroys the rest of the object. Returning `null` here means "we could not tell", and every
 * caller treats that as NOT a delegation — fail-closed, so an unreadable payload can never silence
 * the ladder.
 */
export function readOp(input: string | undefined): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const op = (parsed as Record<string, unknown>).op;
      if (typeof op === "string" && op.length > 0) return op;
    }
  } catch {
    // Truncated, and therefore expected. Fall through to the textual scan.
  }
  // `?? null` rather than `m[1]`: under `noUncheckedIndexedAccess` a captured group is
  // `string | undefined`, and this function's contract is "a string, or null for could-not-tell".
  const m = /"op"\s*:\s*"([^"]+)"/.exec(input);
  return m?.[1] ?? null;
}

/** Strip the MCP prefix, leaving the bare tool name. Non-MCP names pass through unchanged. */
function bareName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
}

/**
 * What kind of call is this?
 *
 * ORDER MATTERS: delegation is decided BEFORE the investigative lists are consulted, because
 * `sparkle_research` appears on both sides — `dispatch` is the delegation we want, `list`/`get` are
 * polling. Checking investigation first would classify a dispatch as a grind and never reset the
 * ladder, which is the one bug that would make this feature actively harmful.
 */
export function classifyTool(call: ToolCallInput): ToolKind {
  const name = typeof call?.name === "string" ? call.name : "";
  if (name.length === 0) return "other";
  const bare = bareName(name);

  if (DELEGATION_TOOLS.includes(bare)) {
    const op = readOp(call.input);
    if (op !== null && DELEGATION_OPS.includes(op)) return "delegation";
  }

  if (INVESTIGATIVE_BUILTINS.includes(name)) return "investigative";
  if (INVESTIGATIVE_MCP.includes(bare)) return "investigative";
  return "other";
}

/** Per-turn ladder state. Purely in memory, exactly like `nudge_ladder.rs`'s `AgentState`. */
export interface DelegationState {
  /** The turn these counts belong to. A new turn id resets everything. */
  turnId: string | null;
  /** Investigative calls since the last delegation — the number the nudge text quotes. */
  serial: number;
  /** Investigative calls since the last nudge fired. Drives the NEXT rung. */
  sinceNudge: number;
  /** Highest rung reached this turn. 0 = none fired yet. */
  rung: number;
  /** Delegating calls seen this turn, so the nudge can say "0 agents" truthfully. */
  delegations: number;
}

export function initialState(): DelegationState {
  return { turnId: null, serial: 0, sinceNudge: 0, rung: 0, delegations: 0 };
}

export interface Nudge {
  rung: number;
  /** What to inject into the concierge's context. */
  text: string;
  /** Rung 3 only: also surface "the concierge is grinding" to the founder. */
  escalate: boolean;
  /** How many serial investigative calls provoked this. Quoted in the text and the badge. */
  serial: number;
  /**
   * How many delegations this episode has seen — usually 0, and NOT always.
   *
   * Carried on the decision rather than left for the caller to look up, so the badge and the log
   * quote the same number the text does. The text used to hard-code a zero here; see
   * {@link nudgeText}.
   */
  delegations: number;
}

export type Decision = { action: "none" } | { action: "nudge"; nudge: Nudge };

const NONE: Decision = { action: "none" };

/**
 * The rung's words.
 *
 * Rungs 1 and 2 are addressed to the concierge and never to the founder. Rung 3 is the same
 * escalation target the build-agent ladder uses — it stops arguing with the agent and tells the
 * human. The founder chose the badge to tick on EVERY rung (2026-08-12, overriding a
 * silent-until-ignored recommendation) so he can calibrate the thresholds against real behavior;
 * that is the caller's job, not this function's.
 *
 * The text names the RIGHT tool. The guideline this replaces named `Agent`, which the concierge
 * cannot call — see this file's header.
 */
export function nudgeText(rung: number, serial: number, delegations = 0): string {
  // ══ THE DELEGATION COUNT IS READ, NOT ASSUMED ZERO ══════════════════════════════════════════════
  // This said a literal `0 delegations`, and the literal was reachable-and-wrong rather than merely
  // redundant: a dispatch resets `serial` and `rung` but NOT `delegations`, so a concierge that
  // delegated once and then ground through six more reads got told it was "6 investigative tool
  // calls and 0 delegations into this turn" — a false statement, in the one channel whose whole job
  // is to be believed about this. A model that can see its own transcript reads a message that
  // contradicts it and has every reason to discount the next one.
  //
  // It also mattered for the founder's complaint: "concierge agents stuck at zero" was a claim the
  // app was making in two places at once, and exactly one of them (the sidebar row) was true.
  const count =
    `${serial} investigative tool call${serial === 1 ? "" : "s"} and ` +
    `${delegations} delegation${delegations === 1 ? "" : "s"}`;
  if (rung <= 1) {
    return (
      `[sparkle-delegation #1] You are ${count} into this turn. ` +
      `Dispatch this with sparkle_research (op: "dispatch") and keep talking, ` +
      `rather than reading it yourself while they wait.`
    );
  }
  if (rung === 2) {
    return (
      `[sparkle-delegation #2] STOP READING. ${count} in one turn. ` +
      `Dispatch sparkle_research now, or spawn a build agent if this needs writes. ` +
      `Do not send another Read/Grep/terminal call until you have.`
    );
  }
  // ══ RUNG 3 NO LONGER CLAIMS SOMETHING NOTHING DOES ═════════════════════════════════════════════
  // This said "This has now been raised to the founder." Nothing raised it: `Nudge.escalate` had no
  // production reader anywhere, so the sentence was false every time it was sent — and it is exactly
  // the class AGENTS.md names, a remedy string that describes a path the code does not take. A model
  // that acts on it reasonably concludes the human is already looking and stops trying to fix it.
  //
  // What IS true at rung 3 is stated instead, and it is stronger than the escalation would have
  // been: past this rung the ladder stops nudging (`MAX_RUNG`), and `engine/conciergeAutoDispatch`
  // has begun dispatching the queued messages itself. Naming that is also the honest warning — the
  // work is being taken over, which is what the founder asked for when asking stopped working.
  return (
    `[sparkle-delegation #3] ${count}. This is the last nudge — Sparkle is now dispatching your ` +
    `queued messages to research agents itself. Delegate the remaining work immediately and ` +
    `answer with what you already have.`
  );
}

/**
 * Fold one live tool call into the ladder.
 *
 * Returns the NEW state and what to do. Pure: the caller performs the injection and ticks the
 * badge. Never mutates its argument, so a caller holding the previous state for comparison keeps a
 * usable value.
 *
 * @param queuedCount messages waiting behind this turn (`waitingCount` from the turn queue). Any
 *        value above zero switches the threshold to {@link QUEUED_THRESHOLD}.
 */
export function noteToolCall(
  prev: DelegationState,
  call: ToolCallInput,
  opts: { turnId: string; queuedCount?: number },
): { state: DelegationState; decision: Decision } {
  // A new turn wipes the episode. Counting across turns would let two innocent turns add up to a
  // nudge neither of them earned.
  const carried: DelegationState =
    prev.turnId === opts.turnId ? prev : { ...initialState(), turnId: opts.turnId };

  const kind = classifyTool(call);

  if (kind === "delegation") {
    // THE RESET. It clears the rung as well as the counters: the concierge did the thing we asked,
    // so the next grind starts its own episode at rung 1 rather than resuming mid-ladder.
    return {
      state: {
        turnId: opts.turnId,
        serial: 0,
        sinceNudge: 0,
        rung: 0,
        delegations: carried.delegations + 1,
      },
      decision: NONE,
    };
  }

  if (kind !== "investigative") {
    return { state: carried, decision: NONE };
  }

  const serial = carried.serial + 1;
  const sinceNudge = carried.sinceNudge + 1;
  const threshold = (opts.queuedCount ?? 0) > 0 ? QUEUED_THRESHOLD : SERIAL_THRESHOLD;

  if (sinceNudge < threshold || carried.rung >= MAX_RUNG) {
    return {
      state: { ...carried, serial, sinceNudge },
      decision: NONE,
    };
  }

  const rung = carried.rung + 1;
  return {
    state: { ...carried, serial, sinceNudge: 0, rung },
    decision: {
      action: "nudge",
      nudge: {
        rung,
        // `carried.delegations` — the count this episode has actually seen. Passing it is the whole
        // fix; the default parameter exists only so the pure function stays callable in isolation.
        text: nudgeText(rung, serial, carried.delegations),
        escalate: rung >= MAX_RUNG,
        serial,
        delegations: carried.delegations,
      },
    },
  };
}
