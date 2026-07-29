// agentThrash — "it is issuing commands but getting nowhere", and "it is running out of context".
//
// THE THIRD STATE. engine/agentStall answers idle-and-finished vs idle-and-stalled. Both of those
// are about an agent that STOPPED. This module is about the opposite failure: an agent that never
// stops and never advances.
//
// THE LIVE CASE, agent a0d5dc98 ("Kill BYOK Anthropic Key"), 2026-07-29. Its terminal tail:
//
//     > /compact
//       (Compacted)
//     > /compact
//     > /compact
//       (Not enough messages to compact.)
//
// Three compactions in a row, the last one failing outright. `get_agent_status` reported it idle
// and the build column showed it fine. The founder found it by reading the terminal himself, which
// is exactly the work this app exists to remove.
//
// WHY NOTHING CAUGHT IT. Every status signal today is a SURFACE signal — `spinner-seen`,
// `quiet-settle`, `output-flowing`, `prompt-detected-midstream`. Not one of them can tell working
// apart from repeating a failing command, because a looping agent produces output, and output is
// the whole of the evidence. The concierge could not catch it either: `read_agent_terminal`
// returns only the tail, so an agent looks fine on its last ten lines while being stuck for many
// turns above.
//
// SO THIS READS THE HOOK STREAM, NOT THE SCREEN. Claude Code's own lifecycle events are structured
// and trustworthy where the rendered TUI is a guess (engine/hookEvents makes the same argument for
// status). Three facts come from it that no amount of screen-watching can supply:
//
//   • `UserPromptSubmit.prompt` — the actual command text, so REPETITION is observable.
//   • `PreToolUse.tool`         — whether a turn did any real work, so a turn that burned tokens
//                                 and touched nothing is observable.
//   • `PreCompact`              — a compaction happening, so CONTEXT PRESSURE is observable
//                                 BEFORE it degenerates into the loop above.
//
// `PreCompact` was not registered in the emitter before this change (src-tauri/src/hooks.rs
// PLAIN_EVENTS listed six events and not that one), and `hookEventToStatus` explicitly discarded
// it — so the single clearest signal that an agent is running out of usable context was being
// thrown away twice over. Registering it is half of this fix.
//
// PURE REDUCER. `reduceThrash` is data-in-data-out over one event; the clock arrives on the event
// (`ts`) or as a parameter. No timers, no I/O — so a four-compaction spiral is tested as arithmetic.
import type { HookEvent } from "./hookEvents";

/** Identical consecutive commands before we call it repetition.
 *
 *  Three, matching the observed case exactly: `/compact`, `/compact`, `/compact`. Two is not yet
 *  evidence — retrying a command once is ordinary and often correct (a flaky test, a transient
 *  network failure). Three identical submissions in a row is a loop. */
export const REPEAT_LIMIT = 3;

/** Consecutive CLOSED turns firing zero tools before we call it no-progress.
 *
 *  A turn with no tool call is not by itself a problem — an agent answering a question, or
 *  thinking out loud, legitimately runs no tools. Three in a row while a goal is outstanding is an
 *  agent talking instead of working, which is the "produces output, reads as healthy" failure. */
export const NO_TOOL_TURN_LIMIT = 3;

/** Compactions inside {@link COMPACT_WINDOW_MS} before we call it context pressure.
 *
 *  TWO, not three — deliberately lower than {@link REPEAT_LIMIT}, because this is the signal the
 *  brief asks to surface BEFORE the thrash rather than after it. One compaction is healthy
 *  housekeeping and happens in every long session. A second inside the window means the first did
 *  not buy meaningful room, and the agent is close to useless. */
export const COMPACT_PRESSURE_LIMIT = 2;

/** How recent compactions have to be to count as pressure. Compactions an hour apart are a long,
 *  healthy session; two in ten minutes is a spiral. */
export const COMPACT_WINDOW_MS = 10 * 60_000;

/** Per-agent accumulator over the hook stream. Serializable by construction (plain data, bounded
 *  size) so it could be persisted later without a redesign; today it is window-local. */
export interface ThrashState {
  /** The last command submitted, for repetition detection. */
  lastCommand?: string;
  /** How many times in a row {@link lastCommand} has been submitted (1 on first sight). */
  repeatCount: number;
  /** Consecutive CLOSED turns that fired no tool. */
  turnsWithoutTool: number;
  /** Has a tool fired inside the turn that is currently open? */
  toolInCurrentTurn: boolean;
  /** Is a turn open right now? Guards against counting a no-tool turn twice on a doubled Stop. */
  turnOpen: boolean;
  /** Did the most recently CLOSED turn run any tool? This is what stops a repeated prompt that
   *  sandwiches real work from reading as a loop — see {@link repeatOf}. */
  lastTurnRanTool: boolean;
  /** Timestamps of recent compactions, pruned to {@link COMPACT_WINDOW_MS}. */
  compactions: number[];
}

export function initialThrashState(): ThrashState {
  return {
    repeatCount: 0,
    turnsWithoutTool: 0,
    toolInCurrentTurn: false,
    turnOpen: false,
    lastTurnRanTool: false,
    compactions: [],
  };
}

/** What is wrong, if anything. A single headline so a row can render one badge, with the full
 *  evidence alongside it in {@link ThrashReport}. */
export type ThrashVerdict = "healthy" | "repeating-command" | "no-progress" | "context-pressure";

export interface ThrashReport {
  verdict: ThrashVerdict;
  /** True for any non-healthy verdict — the one predicate a caller needs to decide whether to
   *  paint the row differently. */
  thrashing: boolean;
  /** The repeated command and its run length, when that is the finding. */
  repeatedCommand?: { text: string; count: number };
  /** Consecutive no-tool turns, whether or not it reached the limit. */
  turnsWithoutTool: number;
  /** Compactions inside the window, whether or not it reached the limit. Surfaced even when
   *  healthy, so a row can show pressure BUILDING rather than only pressure arrived. */
  recentCompactions: number;
  detail: string;
}

/**
 * Fold one hook event into the state.
 *
 * TURN BOOKKEEPING mirrors engine/hookEvents' TURN_OPENERS/TURN_CLOSERS rather than inventing a
 * second notion of a turn — two modules disagreeing about when a turn ended is how one of them
 * silently stops counting. A tool event only counts toward the OPEN turn; `turnOpen` is what stops
 * a doubled `Stop` (which does happen) from charging the agent two no-tool turns for one turn.
 *
 * SUBAGENT TOOL CALLS COUNT AS WORK. A `PreToolUse` from a subagent still means the agent is doing
 * something — delegation is work, and treating it as idleness would flag every orchestrator as
 * no-progress, which is precisely the fleet's most valuable agent.
 */
export function reduceThrash(state: ThrashState, ev: HookEvent, now?: number): ThrashState {
  const at = ev.ts ?? now ?? 0;
  switch (ev.event) {
    case "UserPromptSubmit": {
      const text = (ev.prompt ?? "").trim();
      // A repeat is only a repeat if we can SEE the text. An event with no prompt (older logs,
      // a redacted payload) must not silently extend or reset a run — leaving both alone is the
      // honest handling of "we didn't observe this one".
      const repeat = text === "" ? state : repeatOf(state, text);
      // `lastTurnRanTool` is cleared HERE as well as at Stop, so the flag means "did anything run
      // SINCE THE LAST SUBMISSION" rather than "did the last turn that happened to close run
      // something" (roborev 55296). Without this it goes stale whenever a turn does not close, and
      // the observed incident is exactly that shape: a built-in slash command like `/compact`
      // produces no assistant turn and therefore no Stop, so three `/compact`s in a row each read
      // the previous WORKING turn's `true`, reset the run, and the loop was never flagged.
      return { ...repeat, turnOpen: true, toolInCurrentTurn: false, lastTurnRanTool: false };
    }
    // A NEW SESSION WIPES THE SLATE — BUT ONLY A GENUINELY NEW ONE.
    //
    // SessionStart is not just a human restart: Claude Code fires it after a COMPACTION too. Its
    // matcher vocabulary is `startup|resume|clear|compact` (the official plugin hooks register
    // exactly that string), and Sparkle registers the event bare, so it receives every source.
    // A blanket wipe therefore ran immediately after every `PreCompact` and deleted the timestamp
    // just recorded — `recentCompactions` could never reach COMPACT_PRESSURE_LIMIT, and
    // `context-pressure` (the module's headline signal, and the entire reason `PreCompact` is
    // registered at all) was dead in production while the suite stayed green, because both fixtures
    // hand-built a stream with no SessionStart between the compactions. That is not the stream
    // production produces (roborev 55296).
    //
    // So: a compaction resets only the TURN bookkeeping and KEEPS the pressure history — a
    // compaction is evidence FOR pressure, not the human applying the remedy. An unknown/absent
    // source is treated the same way, deliberately: destroying evidence on a guess is the failure
    // that hid this bug, and the genuine-restart case is already covered from the other side by
    // `forgetThrash` in AgentPane's watcher teardown.
    case "SessionStart": {
      const fresh = ev.source === "startup" || ev.source === "clear";
      if (fresh) return { ...initialThrashState(), turnOpen: true };
      return {
        ...state,
        turnOpen: true,
        toolInCurrentTurn: false,
        turnsWithoutTool: 0,
        lastTurnRanTool: false,
      };
    }
    case "PreToolUse":
    case "PostToolUse":
      return { ...state, toolInCurrentTurn: true };
    case "Stop":
    case "SessionEnd": {
      if (!state.turnOpen) return state;
      return {
        ...state,
        turnOpen: false,
        // A turn that ran a tool RESETS the streak — that is the progress signal. A turn that ran
        // none extends it.
        turnsWithoutTool: state.toolInCurrentTurn ? 0 : state.turnsWithoutTool + 1,
        lastTurnRanTool: state.toolInCurrentTurn,
        toolInCurrentTurn: false,
      };
    }
    case "PreCompact":
      return { ...state, compactions: prune([...state.compactions, at], at) };
    default:
      return state;
  }
}

/**
 * Extend or restart the identical-command run.
 *
 * A REPEAT ONLY COUNTS IF THE TURN BETWEEN THE TWO SUBMISSIONS DID NO WORK, and getting this wrong
 * would have made the module condemn its own sibling feature (roborev 55259). `goalContinuation.
 * continuePrompt` is a pure function of `goal.text`, so every auto-continue for one goal submits a
 * BYTE-IDENTICAL string, and `MAX_CONTINUES_TOTAL` permits twenty of them. An agent that was
 * auto-continued three times and edited files, ran tests and committed in each of those turns would
 * have been reported `repeating-command` — "It is looping, not working" — which is the precise
 * inverse of the judgement this module exists to make, fired on the healthy path. A human typing
 * "continue" three times hit the same thing.
 *
 * The evidence to separate the two was already in the state and simply unused: the `/compact` case
 * ran NO tools in each repeated turn. So identical text plus real work is a retry loop that is
 * getting somewhere (fine); identical text plus nothing is a loop (not fine).
 */
function repeatOf(state: ThrashState, text: string): ThrashState {
  if (state.lastCommand === text && !state.lastTurnRanTool) {
    return { ...state, repeatCount: state.repeatCount + 1 };
  }
  return { ...state, lastCommand: text, repeatCount: 1 };
}

/** Drop compactions that have aged out of the window, so the counter measures a RATE rather than
 *  a lifetime total — a twelve-hour session should not read as pressure for its last six hours. */
function prune(ts: number[], now: number): number[] {
  return ts.filter((t) => now - t < COMPACT_WINDOW_MS);
}

/**
 * Read the accumulated state.
 *
 * PRIORITY, and it is not severity order. `context-pressure` is reported FIRST because it is the
 * CAUSE and the others are symptoms: an agent thrashing on `/compact` is repeating a command
 * *because* it is out of room, and telling the human "it is repeating a command" sends them to
 * debug the loop instead of the exhaustion. Naming the cause is what makes the alert actionable —
 * and it is the brief's actual requirement, that pressure be surfaced *before* it causes a loop.
 */
export interface ThrashContext {
  /**
   * Does this agent have outstanding goal work right now (`agentGoal.hasUnmetGoal`)?
   *
   * ONLY the `no-progress` rule reads it, and only to decide whether the streak is an ALARM. The
   * rule's premise was always "three tool-less turns *while a goal is outstanding*", but the
   * implementation consulted no goal and fired on any three consecutive prose turns — so the
   * founder or the concierge asking an agent three questions in a row, and it answering each in
   * prose, reported "it is producing output without doing anything" (roborev 55259). A detector
   * whose false positives land on ordinary conversation gets ignored, which is the failure mode
   * this whole feature exists to end.
   *
   * Left `undefined` (the caller does not know), the streak is still REPORTED but never raises the
   * alarm — the same evidence-not-inference default the rest of this surface uses.
   */
  goalOutstanding?: boolean;
}

/** `ctx` is REQUIRED, not defaulted — the same call `HookEventHandlerDeps` makes about
 *  `noteTranscript`/`noteThrash` and for the same reason. `no-progress` only alarms when
 *  `goalOutstanding === true`, so a default of `{}` would let a caller silently disable the rule
 *  with no compile error and no failing test (roborev 55296). `{}` stays expressible for "I do not
 *  know"; what is no longer expressible is forgetting to say. */
export function thrashReport(state: ThrashState, now: number, ctx: ThrashContext): ThrashReport {
  const recentCompactions = prune(state.compactions, now).length;
  const repeated =
    state.lastCommand !== undefined && state.repeatCount >= REPEAT_LIMIT
      ? { text: state.lastCommand, count: state.repeatCount }
      : undefined;

  const base = {
    turnsWithoutTool: state.turnsWithoutTool,
    recentCompactions,
    ...(repeated ? { repeatedCommand: repeated } : {}),
  };

  if (recentCompactions >= COMPACT_PRESSURE_LIMIT) {
    return {
      ...base,
      verdict: "context-pressure",
      thrashing: true,
      detail:
        `Compacted ${recentCompactions} times in the last ${Math.round(COMPACT_WINDOW_MS / 60_000)} ` +
        `minutes — it is running out of usable context` +
        (repeated ? ` and is now repeating "${repeated.text}"` : "") +
        `. Compaction is not buying it room; it needs a fresh session or a narrower task.`,
    };
  }
  if (repeated) {
    return {
      ...base,
      verdict: "repeating-command",
      thrashing: true,
      detail:
        `Submitted "${repeated.text}" ${repeated.count} times in a row. It is looping, not working.`,
    };
  }
  // Only an alarm when there is goal work outstanding — otherwise three tool-less turns is just a
  // conversation. See ThrashContext.goalOutstanding.
  if (state.turnsWithoutTool >= NO_TOOL_TURN_LIMIT && ctx.goalOutstanding === true) {
    return {
      ...base,
      verdict: "no-progress",
      thrashing: true,
      detail:
        `${state.turnsWithoutTool} turns in a row ran no tools at all while its goal is still ` +
        `unmet — it is producing output without doing anything. Output is not progress.`,
    };
  }
  return {
    ...base,
    verdict: "healthy",
    thrashing: false,
    detail:
      recentCompactions > 0
        ? `Working. One compaction in the last ${Math.round(COMPACT_WINDOW_MS / 60_000)} minutes — ` +
          `normal housekeeping, but worth watching.`
        : "Working — tools are running and commands are not repeating.",
  };
}

// ── Per-agent registry ────────────────────────────────────────────────────────────────────────
// Window-local and non-reactive, exactly like engine/turnEndAuthority and for the same reason: it
// is written from the pane that owns the agent's hook watcher and read imperatively by the status
// surfaces. An agent with NO entry is one this window is not driving, and callers must read that
// as "not observed" rather than "healthy" — see `thrashReportFor`.

const byAgent = new Map<string, ThrashState>();

/** Fold one event into an agent's accumulator. Called from the hook event handler. */
export function noteThrashEvent(agentId: string, ev: HookEvent, now?: number): void {
  byAgent.set(agentId, reduceThrash(byAgent.get(agentId) ?? initialThrashState(), ev, now));
}

/** This agent's report, or `undefined` when this window has never seen a hook event for it.
 *
 *  `undefined` rather than a healthy-looking default, deliberately: a caller that reads "healthy"
 *  from an agent nobody is watching would report calm on no evidence — the exact false negative
 *  `rollupDot`'s null arm and `getAgentStatus`'s `observed` flag both exist to prevent. */
export function thrashReportFor(
  agentId: string,
  now: number,
  ctx: ThrashContext,
): ThrashReport | undefined {
  const state = byAgent.get(agentId);
  return state === undefined ? undefined : thrashReport(state, now, ctx);
}

/** Drop an agent's accumulator (its pane unmounted, or it was closed). */
export function forgetThrash(agentId: string): void {
  byAgent.delete(agentId);
}

/** Test seam only: wipe every accumulator. */
export function resetThrashTracking(): void {
  byAgent.clear();
}
