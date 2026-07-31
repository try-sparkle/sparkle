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
import { isSystemAuthoredPrompt } from "./agentOriginated";
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
  /**
   * Was the turn currently open opened by a SYSTEM-AUTHORED prompt (an auto-resume)?
   *
   * Exists so the `Stop` closing that turn cannot DESTROY the work evidence in `lastTurnRanTool`.
   * Excluding the resume at submission was not enough on its own: the resume's own turn closes one
   * event later and used to overwrite the flag with its (empty) `toolInCurrentTurn`, so a human
   * typing one command three times — WITH real tool work in every turn — accumulated to
   * `repeating-command` as soon as resumes fell between the submissions. That is the same false
   * positive this module keeps re-learning (roborev 55259, 55314), reached through the resume door.
   */
  resumeTurn: boolean;
  /**
   * Has this accumulator observed a tool event at all, since it was created?
   *
   * WHY IT GATES `no-progress`. That rule reads *absence* of `PreToolUse` as evidence the agent ran
   * nothing — but this registry is fed from AgentPane's watcher, so "the agent ran no tools" and "no
   * tool events reached us" render identically. Without some coverage check, the fix to
   * `repeating-command` merely RELABELLED the incident: agent 0bf08c64's row would have carried a
   * "No progress" chip instead ("it is producing output without doing anything") — the identical
   * unobserved claim one badge over, and just as relayable to the founder as fact.
   *
   * WHAT IT DOES *NOT* PROVE, stated precisely because the obvious reading is stronger than the
   * truth. It is a LIFETIME LATCH over one accumulator, so it means only "a tool event reached this
   * accumulator at some point". It does NOT mean the stream is delivering them *now*. Two
   * consequences, both real and both deliberately accepted here rather than papered over:
   *
   *   • MID-STREAM LOSS IS NOT COVERED. If tool events start being dropped after some have already
   *     arrived, the latch is already `true` and `no-progress` alarms exactly as it did before. If
   *     that — rather than a pane unmount — was the mechanism behind the motivating incident, this
   *     gate would not have caught it. `sawToolEver` covers exactly one shape: an accumulator that
   *     has never seen a tool.
   *   • THE RULE'S PRIMARY TARGET IS DISARMED. An agent that talks instead of working runs no tools
   *     BY DEFINITION, so it can never satisfy this and can never be flagged. That is not a corner:
   *     `forgetThrash` wipes the accumulator on pane unmount, a fresh `SessionStart` wipes it, and
   *     the watcher starts at EOF — so a freshly-mounted pane begins here every time.
   *
   * This is a deliberate trade, not an oversight: a false "No progress" on a hard-working agent
   * misinformed the founder twice, and a detector whose false positives land on working agents gets
   * ignored entirely. The durable fix is to corroborate from a channel that does not run through
   * this pane's watcher — `fleet.rs`'s windowed `PostToolUse` count (surfaced as `toolsRecent` in
   * fleetVerdict) is read from the hook log directly and can distinguish "ran nothing" from "nothing
   * reached this pane". That is not plumbed to this call site today; tracked as bead sparkle-98yth.
   * Both uncovered cases have named tests so the loss stays a recorded decision.
   */
  sawToolEver: boolean;
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
    resumeTurn: false,
    sawToolEver: false,
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
      // SPARKLE'S OWN AUTO-RESUME BANNER IS NOT AN AGENT ACTION, so it is excluded from repetition
      // ENTIRELY — it does not extend a run, does not start one, and does not reset one. The turn
      // bookkeeping below still proceeds, because a resume really does open a turn the agent works
      // in; it is only the "did the agent choose to submit this" tally that must not see it.
      //
      // WHY THIS AND NOT THE `workHappened` GUARD BELOW. `repeatOf` already declines to call
      // identical text a loop when a tool ran in between, and that guard was written for exactly
      // this prompt (see its docstring). It is not enough, and the second false positive proved it:
      // on 2026-07-30 agent 0bf08c64 was badged `repeating-command` — "Submitted [...] 3 times in a
      // row. It is looping, not working." — through 46 continuous minutes of writing tests and
      // running typecheck and vitest. The guard depends on OBSERVING the intervening work, and this
      // registry is fed from AgentPane's watcher (see fleetVerdict's note), so an unmounted pane, a
      // remount, or any dropped PreToolUse leaves three resumes looking adjacent. Inferring a loop
      // from evidence we merely failed to see is the same error as the badge itself.
      //
      // Excluding the banner at the source does not depend on seeing anything: the text is
      // system-authored, therefore it carries no information about the agent either way, therefore
      // it belongs in no tally. That holds under partial observation, which the guard never did.
      // The guard STAYS — it still covers a human typing the same thing repeatedly — but it is no
      // longer what stands between this feature and condemning its own sibling.
      if (isSystemAuthoredPrompt(text)) {
        // `lastTurnRanTool` is NOT cleared on this path, deliberately, and this is the one place the
        // resume differs from an unobserved prompt. Clearing it would destroy the work evidence
        // `repeatOf` reads, so a resume landing between two genuine human submissions would make a
        // WORKING agent more likely to read as looping — reintroducing the very false positive this
        // arm exists to remove, through the back door. `resumeTurn` carries that protection through
        // the `Stop` that closes this turn, which would otherwise undo it one event later.
        //
        // AND THE OPEN TURN'S WORK IS PROMOTED, NOT DISCARDED. `repeatOf` reads BOTH flags because a
        // turn can be interrupted and never close (roborev 55314) — the human presses ESC, or the
        // `Stop` is dropped. Protecting only `lastTurnRanTool` while still zeroing
        // `toolInCurrentTurn` destroyed the same evidence one event EARLIER instead of one later:
        // prompt → PreToolUse → (no Stop) → resume → Stop left `lastTurnRanTool` false, and an agent
        // that ran a tool in every single turn reached `repeating-command` after three such cycles.
        // That is the identical mistake the `SessionStart{compact}` arm below was already fixed for.
        //
        // The streak gets the same treatment for the same reason: observed work breaks it. Note this
        // is work being counted, never the resume itself — the resume's own turn still adds to the
        // streak when it closes having run nothing.
        return {
          ...state,
          turnOpen: true,
          resumeTurn: true,
          lastTurnRanTool: state.toolInCurrentTurn || state.lastTurnRanTool,
          turnsWithoutTool: state.toolInCurrentTurn ? 0 : state.turnsWithoutTool,
          toolInCurrentTurn: false,
        };
      }
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
      return {
        ...repeat,
        turnOpen: true,
        toolInCurrentTurn: false,
        lastTurnRanTool: false,
        resumeTurn: false,
      };
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
      // A COMPACTION INVALIDATES NOTHING THIS MODULE COUNTS, so it changes nothing (roborev 55314).
      // The first version of this arm reset the turn bookkeeping, which was still too much in two
      // directions:
      //   • `turnsWithoutTool: 0` — a post-compaction SessionStart arrives in the MIDDLE of the loop
      //     this module was built for (`/compact` → PreCompact → SessionStart{compact}), so zeroing
      //     the streak there meant `no-progress` could never reach its limit for a compacting agent
      //     at all. A compaction is not progress; it must not read as progress.
      //   • `toolInCurrentTurn: false` — an AUTO-compaction fires mid-turn, so clearing it erased the
      //     evidence that the open turn had already run tools, and the following Stop charged a
      //     working turn as tool-less.
      // Nor is the turn reopened: `turnOpen` is already true mid-turn, and a manual `/compact` is a
      // submission that opens one. Setting it here would let a doubled Stop bank a phantom turn.
      return state;
    }
    case "PreToolUse":
    case "PostToolUse":
      // `sawToolEver` LATCHES here and is never cleared except by a genuinely new session. It is not
      // a measure of recent activity, and it is deliberately NOT proof that the stream is still
      // delivering: it records only that AT LEAST ONE event arrived, which is just enough to rule
      // out an accumulator that has never observed a tool. Once armed it says nothing about a later
      // absence. See its field docstring for the two shapes that leaves uncovered.
      return { ...state, toolInCurrentTurn: true, sawToolEver: true };
    case "Stop":
    case "SessionEnd": {
      if (!state.turnOpen) return state;
      return {
        ...state,
        turnOpen: false,
        // A turn that ran a tool RESETS the streak — that is the progress signal. A turn that ran
        // none extends it. This counts resume-opened turns too, deliberately: a resume is not
        // progress, and an agent that keeps being restarted and keeps doing nothing IS going
        // nowhere. What protects the healthy path is that `no-progress` cannot ALARM until
        // `sawToolEver`, so an unobserved stream produces a streak nobody acts on.
        turnsWithoutTool: state.toolInCurrentTurn ? 0 : state.turnsWithoutTool + 1,
        // A RESUME-OPENED TURN MAY ONLY ADD WORK EVIDENCE, NEVER REMOVE IT. Closing such a turn with
        // no tool observed leaves the previous verdict standing rather than overwriting it with
        // `false` — the resume is not an agent action, so it cannot be the thing that proves the
        // agent stopped working. Without this, excluding the resume at SUBMISSION was undone one
        // event later and a working agent's repeated human command still reached
        // `repeating-command` (see `resumeTurn`).
        lastTurnRanTool:
          state.toolInCurrentTurn || (state.resumeTurn && state.lastTurnRanTool),
        toolInCurrentTurn: false,
        resumeTurn: false,
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
 * THE AUTO-CONTINUE PROMPT NO LONGER REACHES THIS FUNCTION AT ALL. It is excluded upstream, in the
 * `UserPromptSubmit` arm, because this guard was not sufficient for it: the guard needs to SEE the
 * intervening work, and under partial observation (an unmounted pane, a dropped `PreToolUse`) it
 * does not — which is how the false positive recurred on 2026-07-30 against an agent that had been
 * working continuously for 46 minutes. What remains here is the case the guard is genuinely right
 * for: a HUMAN typing the same thing repeatedly, which is a real action that really does carry
 * information, so it must be judged on evidence rather than suppressed.
 *
 * The evidence to separate the two was already in the state and simply unused: the `/compact` case
 * ran NO tools in each repeated turn. So identical text plus real work is a retry loop that is
 * getting somewhere (fine); identical text plus nothing is a loop (not fine).
 */
function repeatOf(state: ThrashState, text: string): ThrashState {
  // BOTH flags, because the claim is "did anything run SINCE THE LAST SUBMISSION" and the two cover
  // different halves of it: `lastTurnRanTool` is written at Stop and answers for turns that CLOSED,
  // `toolInCurrentTurn` answers for a turn still open. Reading only the first inverted the rule for
  // an interrupted working turn (roborev 55314): prompt → PreToolUse → the human presses ESC so no
  // Stop ever arrives → the same prompt again, three times, and the row reported "it is looping, not
  // working" about an agent that ran a tool on every one of those turns. That is the same false
  // positive this function's docstring says would condemn the sibling feature, reached through a
  // different door. The `/compact` case still trips, because there no tool ran in the open turn
  // either.
  const workHappened = state.lastTurnRanTool || state.toolInCurrentTurn;
  if (state.lastCommand === text && !workHappened) {
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
  //
  // AND only when this accumulator has observed at least one tool event. The streak is built from
  // the ABSENCE of `PreToolUse`, and absence has two causes that render identically here: the agent
  // ran nothing, or nothing reached us. `sawToolEver` separates them in exactly ONE shape — an
  // accumulator that has never seen a tool — and NOT once it is armed, where dropped events and an
  // idle agent are indistinguishable again. Read the field docstring before trusting this gate: it
  // is a partial guard, and bead sparkle-98yth is the durable separation (corroborating from
  // fleet.rs's hook-log tool count, which does not run through this pane's watcher).
  //
  // Even partial, it is what stops this rule inheriting the false positive `repeating-command` was
  // just fixed for — agent 0bf08c64 relabelled from "Looping" to "No progress", equally wrong and
  // equally confident. The streak is still REPORTED in `base`; what it may not do is assert.
  if (
    state.turnsWithoutTool >= NO_TOOL_TURN_LIMIT &&
    ctx.goalOutstanding === true &&
    state.sawToolEver
  ) {
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
