// apiRecoveryRunner (sparkle-onzu) — the MOUNT for engine/apiRecovery: it owns the per-agent episode
// state, decides on a timer, and performs the one side effect (typing the retry into the PTY).
//
// engine/apiRecovery is pure and knows nothing about agents, stores or terminals. This module is the
// half that spends something, so everything it touches arrives as an injected dependency
// ({@link ReviveDeps}) and every rule stays testable without a real terminal — the same
// "PURE CORE, INJECTED EDGES" split services/conciergeProactive and engine/goalContinuation use.
//
// WHY IT WRITES DIRECTLY AND NOT THROUGH DispatchAuthority. The authority union exists to guard
// sends that carry CONTENT to a destination CHOSEN by something — a user gesture, or the concierge's
// tool layer under a policy decision. Its header records that there is deliberately no arm for a
// heuristic verdict ("no `router` arm … and must never be one"). This is not that shape: the payload
// is a CONSTANT this repo authored (engine/apiRecovery.revivePrompt), and the destination is not
// chosen at all — it is the one agent whose own status says it just failed. The established
// precedent for exactly this is services/suggestions/approvalsRuntime, which auto-answers permission
// prompts and auto-resumes sessions by writing straight to the PTY, gated on a settings toggle
// rather than on an authority. This follows it.
//
// It rides the `autoApprove` master toggle on purpose rather than inventing a key. That toggle is
// already documented as governing "nudging + auto-answering permission prompts", and off means "no
// nudging AND no auto-answering" — so it is already the switch that means "do not type on my
// behalf", which is precisely the permission a retry ping needs. `maybeAutoResume` set the precedent
// of a sibling behaviour riding it for the same reason. A dedicated key is a reasonable follow-up if
// finer control is wanted; shipping without ANY off switch would not have been.
import { useEffect } from "react";
import {
  classifyFromScrollback,
  decideRevive,
  nextRungDueAt,
  REVIVE_LADDER_MS,
  REVIVE_PROMPT_MARKER,
  BUDGET_SPENT_REASON,
  type ApiFailureClass,
  type ReviveDecision,
} from "../engine/apiRecovery";
import { processAliveOf } from "../engine/turnEndAuthority";
import { agentCanAcceptInput } from "./conciergeDispatch";
import { getAgentScrollback } from "./terminalScrollback";
import { aiFeatureVisibleNow } from "./aiGate";
import { useRuntimeStore } from "../stores/runtimeStore";
import { submitPrompt } from "../pty";
import { log } from "../logger";
import type { AgentTabStatus } from "../types";
import { routeSilence } from "@sparkle/core";
import { useProjectStore } from "../stores/projectStore";
import { agentDisplayName } from "../engine/agentDisplayName";
import { notifyConcierge } from "./conciergeNotifier";

/** How often the sweep runs. The ladder's own rungs decide WHEN a ping is due (the engine compares
 *  wall-clock instants), so this only bounds how late a due rung can fire — it is not the cadence.
 *  Two seconds keeps the tightest 5s rung honest while costing nothing: a sweep over zero episodes
 *  is a Map lookup, and episodes only exist while an agent is actually red on an API error. */
export const SWEEP_INTERVAL_MS = 2_000;

/** One agent's in-flight API-failure episode. Cleared the moment the agent leaves `errored`, which
 *  is what "it revived" looks like from here. */
export interface ReviveEpisode {
  /** Epoch ms the agent entered `errored`. Anchors the first rung. */
  erroredSince: number;
  /** Pings sent so far in this episode. */
  attempts: number;
  /** Epoch ms of the last ping, or undefined before the first. Anchors later rungs. */
  lastPingAt: number | undefined;
  /** What kind of failure this episode is, as classified from the scrollback at entry. */
  failure: ApiFailureClass | null;
  /** Whether we have already escalated (told the human) — so escalation fires once, not every sweep. */
  escalated: boolean;
}

/**
 * How many complete ladders one agent may EXHAUST inside {@link PING_BUDGET_WINDOW_MS} before we stop
 * retrying it and hand it to the human.
 *
 * NAMED FOR THE WINDOW, NOT AN OUTAGE (roborev 55612). A predecessor was called
 * `MAX_LADDERS_PER_OUTAGE`, which promised a per-outage bound that does not exist anywhere — nothing
 * here can tell one outage from the next.
 *
 * A BOUND IS REQUIRED, AND IT MUST NOT DEPEND ON EPISODE IDENTITY (roborev 55566). Restarting a
 * spent-but-ambiguous ladder at rung 0 gave the feature no terminating bound at all: on a sustained
 * outage it ran 11 pings → restart → 11 pings indefinitely, while this module's docs promise retries
 * stop after 1h27m. The "page once" meant to compensate is INERT in production — `liveDeps.onEscalate`
 * is a deliberate no-op, since the row is already red and the notification fires via the status path —
 * so a page was never going to bound anything.
 *
 * TWO LAYERS, and the reason for each (roborev 55863).
 *
 *   - THIS counter answers "is retrying still useful": it charges only ladders that ran ALL the way
 *     out, so a ladder that revived the agent costs nothing and cannot deny a later, unrelated outage
 *     its own retries. But it DEPENDS ON EPISODE IDENTITY - `attempts` advances only through a carry,
 *     so if every re-error lands outside `episodeCarryWindowMs` (a request that takes three minutes to
 *     529 out is enough), no ladder ever completes and this counter never charges anything.
 *   - {@link PING_BUDGET} is therefore kept underneath it as an UNCONDITIONAL CEILING. It counts raw
 *     pings, depends on nothing about episodes, and is what actually guarantees retrying terminates -
 *     including in exactly the rung-0-forever case above, which this counter alone cannot see.
 *
 * Neither is redundant: drop the ceiling and a sustained outage whose re-errors are slow pings
 * forever; drop the counter and two successful ladders deny the next outage its retries.
 */
export const MAX_LADDERS_PER_WINDOW = 2;

/** The most retry pings this bound can cost an agent per window — the arithmetic ceiling, useful for
 *  reasoning about worst-case pressure. Not itself the guard; see {@link exhaustedLadders}.
 *
 *  PINNED BY VALUE in a test (roborev 55612) for the reason `REVIVE_LADDER_MS` is pinned: an assertion
 *  written in terms of this constant, checking a log the same constant's guard writes, is tautological
 *  — it cannot notice the MAGNITUDE changing. Raising the multiplier from 2 to 3 is a 50% increase in
 *  retry pressure on a red agent and used to pass the whole file. */
export const PING_BUDGET = REVIVE_LADDER_MS.length * MAX_LADDERS_PER_WINDOW;

/** Rolling window the budget is measured over. Wider than two ladders (1h27m each) so a genuinely
 *  sustained outage exhausts it rather than skating under it, while an agent that had trouble hours
 *  ago starts clean. */
export const PING_BUDGET_WINDOW_MS = 4 * 60 * 60_000;

/**
 * When each EXHAUSTED ladder finished, per agent, oldest first.
 *
 * WHY EXHAUSTED LADDERS AND NOT PINGS (roborev 55612). Counting every ping charged an agent for
 * retries that WORKED: two ladders that each revived it — say ping 8, then ping 11 — still spent the
 * whole allowance, so a third, plainly transient 529 arriving ninety minutes later got ZERO retries
 * and a page asserting it "has been auto-retried as much as is useful and is still failing", which is
 * false about that failure. That is the same harm 55534 identified for the inherit-rung-11 path, just
 * moved to agent scope. A ladder that revived the agent cost nothing and should be charged nothing;
 * only a ladder that ran all the way out is evidence retrying is not working.
 */
const exhaustedLadders = new Map<string, number[]>();

/** Agents already told that retrying is over. Cleared the moment the budget is no longer spent, so
 *  it latches the PAGE to the COUNTER rather than to a clock of its own. */
const budgetPaged = new Set<string>();

/** Ladders this agent has exhausted inside the rolling window, pruning as it reads. */
function recentExhausted(agentId: string, now: number): number[] {
  const kept = (exhaustedLadders.get(agentId) ?? []).filter((t) => now - t <= PING_BUDGET_WINDOW_MS);
  if (kept.length === 0) exhaustedLadders.delete(agentId);
  else exhaustedLadders.set(agentId, kept);
  return kept;
}

/** Test/diagnostic read of the rolling exhausted-ladder count. */
export function apiRecoveryLadderCount(agentId: string, now: number): number {
  return recentExhausted(agentId, now).length;
}

/** Every retry ping sent to this agent inside the window - the UNCONDITIONAL ceiling's ledger. Keyed
 *  on nothing but the agent, so it holds when the ladder counter cannot (roborev 55863). */
const pingLog = new Map<string, number[]>();

/** Pings sent to this agent inside the rolling window, pruning as it reads. */
function recentPings(agentId: string, now: number): number[] {
  const kept = (pingLog.get(agentId) ?? []).filter((t) => now - t <= PING_BUDGET_WINDOW_MS);
  if (kept.length === 0) pingLog.delete(agentId);
  else pingLog.set(agentId, kept);
  return kept;
}

/** Test/diagnostic read of the rolling ping count. */
export function apiRecoveryPingCount(agentId: string, now: number): number {
  return recentPings(agentId, now).length;
}

// Live episodes, keyed by agent id. Module-level rather than in a zustand store on purpose: nothing
// RENDERS from this, so putting it in a store would re-render every subscriber on each ping for no
// visible benefit. The row's colour is already driven by `errored` via the status path.
const episodes = new Map<string, ReviveEpisode>();

/**
 * WHY A JUST-ENDED EPISODE IS REMEMBERED, and why the whole feature was broken without it
 * (roborev 55433, High).
 *
 * OUR OWN PING CLEARS `errored`. `submit` is `pty.submitPrompt`, which calls `noteUserInputForAgent`
 * → `StatusEngine.noteUserInput`, and that method calls `clearStreamFailure()` and resets
 * `sawRecentError` (statusEngine.ts:357-362) — deliberately, so a resuming agent goes green and its
 * own echo is not mistaken for a self-prompt wedge. The paste echo then drives `set("working", …)`.
 *
 * So every rung produced `errored → working`, which the subscriber read as RECOVERY and deleted the
 * episode. The next 529 opened a FRESH episode at `attempts: 0` and handed out rung 0 again. Net
 * effect during exactly the sustained outage this module exists for: a 5-second ping loop forever,
 * with the 15s…30m tail unreachable and the "outage is outlasting the ladder" escalation never
 * firing. That is the unbounded-retry failure this module's own docs claim to bound, and the ladder
 * test was green through all of it because it held `statusOf: () => "errored"` across all eleven
 * sweeps — a sequence production never produces.
 *
 * The fix is to distinguish OUR OWN status flip from real recovery. A re-entry into `errored` within
 * {@link EPISODE_CARRY_MS} of our last ping means the retry we just sent failed again, i.e. the same
 * outage never ended — so the rung count carries forward. A longer gap means the agent genuinely
 * worked in between, which is a new episode and rightly starts at rung 0.
 */
interface EndedEpisode {
  endedAt: number;
  attempts: number;
  lastPingAt: number | undefined;
  failure: ApiFailureClass | null;
  escalated: boolean;
}
const recentlyEnded = new Map<string, EndedEpisode>();

/**
 * FLOOR on how soon after OUR OWN ping a re-entry into `errored` still counts as the same episode.
 * The actual window is {@link episodeCarryWindowMs}, which scales — see why below.
 *
 * Measured from our last ping, not from episode start. A retry that is going to fail immediately
 * fails within seconds of being submitted — the request round-trips and the banner prints — so two
 * minutes comfortably covers the fast "we typed, it tried, it failed again" case.
 */
export const EPISODE_CARRY_MS = 2 * 60_000;

/**
 * How long after our rung-`attempts` ping a re-entry into `errored` still resumes the SAME episode.
 *
 * WHY THIS SCALES INSTEAD OF BEING A CONSTANT (roborev 55457, High). A fixed 2-minute window was
 * asymmetric with the thing it guards, in the wrong direction: the gap between rungs grows to 30
 * minutes, so the DEEPER into the ladder an episode got, the more likely its carry was missed. And a
 * missed carry is not a small error — it resets `attempts` AND `escalated` to zero, which drops the
 * episode back onto the 5-second rung and makes the "outage outlasted the ladder" escalation
 * unreachable. That is bug 55433 again with a longer period, and it is reachable without any real
 * progress: Claude Code retries internally with its own backoff, so a ping can be followed by
 * minutes of silent churn before the next banner prints.
 *
 * `lastRung * 2` is chosen so the window always exceeds the wait that preceded the ping — if we were
 * willing to sit quiet for 30 minutes before typing, a failure 5 minutes after typing is obviously
 * the same outage. The floor keeps the early rungs (5s, 15s) from having absurdly tight windows.
 *
 * IT COLLAPSES TO THE FLOOR ONCE THE PRIOR EPISODE HAS ESCALATED, so an episode we have already given
 * up on cannot silently absorb a later, unrelated failure: rung 11 pings, the outage clears, the agent
 * works 40 minutes, an unrelated 529 lands — inheriting `attempts: 11` AND `escalated: true` would
 * escalate on the first sweep with the page SUPPRESSED. Zero rungs, no notification, red until a human
 * looks (roborev 55517).
 *
 * WHAT THE WINDOW DECIDES — three outcomes. (An earlier list said "exactly TWO", which dropped a
 * REACHABLE case rather than the unreachable one it meant to remove — roborev 55854.)
 *   1. `attempts < length` and INSIDE the window → RESUME the ladder at the next rung. The everyday
 *      case, and what the whole carry mechanism exists for.
 *   2. `attempts < length` and OUTSIDE it → a NEW episode at rung 0. This is "the agent genuinely
 *      recovered, then failed again an hour later", and it is the case the `lastRung * 2` scaling
 *      above exists to get right — it must not be mistaken for our own ping failing.
 *   3. `attempts >= length` (or already escalated) → the window IS the floor, so only an immediate
 *      re-fail carries, which is plainly our own ping failing: it resumes at the spent count and
 *      `decideRevive` gives up. Anything slower falls into case 2.
 * An earlier revision argued that collapsing at exhaustion was wrong because it would "cycle 11 pings
 * → restart → 11 pings forever". The cycling is real and is answered by PING_BUDGET, NOT by this
 * window — do not reintroduce a timing-based fix for it. Note also that the budget bounds retry
 * PRESSURE (≤ PING_BUDGET per PING_BUDGET_WINDOW_MS); it does not make retrying stop forever, since
 * pings resume once the rolling window sheds an entry.
 *
 * The other way over-carrying bit is guarded at the call site: an ACCOUNT limit arriving mid-ladder
 * must not keep the inherited `retryable` verdict, so a carry re-scans for `terminal` and upgrades.
 * With those in place, an over-generous window costs at most a few extra rungs against an outage that
 * had briefly cleared — the cheap side of the asymmetry `engine/apiRecovery` documents.
 */
export function episodeCarryWindowMs(attempts: number, escalated = false): number {
  if (attempts <= 0 || escalated || attempts >= REVIVE_LADDER_MS.length) return EPISODE_CARRY_MS;
  // In range by construction: the guard above excludes <= 0 and >= length, so `attempts - 1` indexes a
  // real rung. A `Math.min` clamp and an `undefined` check used to sit here; the exhaustion arm made
  // both unreachable, and the test that named the clamp went vacuous with them (roborev 55612).
  return Math.max(EPISODE_CARRY_MS, REVIVE_LADDER_MS[attempts - 1]! * 2);
}

/** The widest window {@link episodeCarryWindowMs} can return — how long a just-ended episode is worth
 *  remembering at all, and therefore when a {@link recentlyEnded} entry becomes dead weight. Taken as
 *  the MAX over every rung rather than by indexing one, since the escalated arm returns the FLOOR and
 *  pruning against that would discard entries a live carry could still accept. */
const MAX_CARRY_WINDOW_MS = REVIVE_LADDER_MS.reduce(
  (max, _rung, i) => Math.max(max, episodeCarryWindowMs(i + 1)),
  EPISODE_CARRY_MS,
);

/** Read-only peek at an agent's episode — for the concierge to report "retried 5 times over 4
 *  minutes, still failing" instead of re-deriving it, and for tests. Undefined when not in one. */
export function apiRecoveryEpisode(agentId: string): Readonly<ReviveEpisode> | undefined {
  return episodes.get(agentId);
}

/** Every agent currently in an episode. */
export function apiRecoveryEpisodes(): ReadonlyMap<string, Readonly<ReviveEpisode>> {
  return episodes;
}

/** Test-only: drop all episode state between cases. */
export function __resetApiRecovery(): void {
  episodes.clear();
  recentlyEnded.clear();
  exhaustedLadders.clear();
  pingLog.clear();
  budgetPaged.clear();
}

/** Test-only: how many just-ended episodes are being remembered for a possible carry. Exported
 *  because the BOUNDS on that map (roborev 55457) have no other observable — unbounded memory growth
 *  cannot be asserted from behaviour. */
export function __apiRecoveryCarrySize(): number {
  return recentlyEnded.size;
}

/** Whitespace removed entirely, so a needle can be found across a HARD WRAP. See {@link sinceOurPing}
 *  for why nothing gentler works: xterm breaks a row at the column, mid-word and with no separator
 *  inserted, and the TUI may indent the continuation. Collapsing to a space (what
 *  `classifyFromScrollback`'s unwrap does) only survives breaks that land on a word boundary. */
const squashSpace = (s: string): string => s.replace(/\s+/g, "");
const MARKER_SQUASHED = squashSpace(REVIVE_PROMPT_MARKER);

/**
 * The part of a scrollback that arrived at or after our most recent retry prompt, located by that
 * prompt's own {@link REVIVE_PROMPT_MARKER}. Empty when the marker cannot be found.
 *
 * FAILS CLOSED, and that is the point: an empty string classifies as null, so a carry that cannot
 * PROVE the text it is judging came after our ping does not upgrade to `terminal`. Slicing at the
 * marker leaves our own prompt inside the region, which is safe only because the prompt cannot
 * classify as `terminal` — it says "an account limit" but never the line-initial "You've hit your …
 * limit" opener with a "· resets"/"raise it at" tail. A test guards that property directly, since it
 * is a fact about the prompt's WORDING and would silently break if someone reworded it.
 *
 * WRAP-TOLERANT ON PURPOSE (roborev 55534). This was a raw `lastIndexOf`, which is wrong on the input
 * this module actually receives: `terminalScrollback` builds the string as one entry per xterm BUFFER
 * ROW (`translateToString(true)` joined with \r\n), and `engine/apiRecovery` already records that a
 * ~62-char banner arrives split in two because Sparkle runs agents in narrow grid panes. The marker
 * sits mid-paragraph in a ~110-char prompt, so its offset within a row is arbitrary — whenever a row
 * boundary fell inside "This is automatic retry ", `lastIndexOf` returned -1 and the terminal upgrade
 * SILENTLY stopped working, re-opening the 55485 bug with the tests still green (they fed the prompt as
 * one unwrapped line, the single shape wrapping cannot break). Matching on whitespace-squashed rows
 * fixes both that and the mirror case, where a split latest marker let `lastIndexOf` anchor on an
 * OLDER ping and admit text predating the last one.
 */
function sinceOurPing(scrollback: string): string {
  const rows = scrollback.split(/[\r\n]/);
  const squashed = rows.map(squashSpace);
  for (let i = rows.length - 1; i >= 0; i--) {
    // Accumulate FORWARD from row i until enough characters exist for the marker to be present, rather
    // than joining a fixed number of rows. `classifyFromScrollback` looks at exactly two because a
    // banner's opener and tail are one wrap apart; this needle can be broken across MORE than two — a
    // blank row (the prompt has a paragraph break) or a very narrow pane both do it, and a two-row join
    // silently missed those, which is the same invisible-failure shape this fix exists to remove.
    let acc = "";
    const enough = squashed[i]!.length + MARKER_SQUASHED.length;
    for (let j = i; j < rows.length && acc.length < enough; j++) {
      acc += squashed[j];
      if (acc.includes(MARKER_SQUASHED)) return rows.slice(i).join("\n");
    }
  }
  return "";
}

/** What {@link noteAgentStatus} did, so the caller (and tests) can see the transition it observed. */
export type StatusNote = "started" | "resumed" | "recovered" | "none";

/**
 * Observe an agent's status, starting or ending an episode.
 *
 * ENTERING `errored` opens an episode and classifies the failure ONCE, from the scrollback as it
 * stands at that moment. Classifying at entry rather than on every sweep is deliberate: the retry we
 * type is itself scrollback, so re-reading later would eventually classify our own prompt's echo (it
 * contains the words "529 Overloaded") instead of the agent's banner.
 *
 * LEAVING `errored` closes it. That is the recovery signal and the only one this module needs — the
 * status path already clears the sticky stream-failure flag on real progress (a classified tool
 * event, a genuine prompt, or a strictly-higher spinner token count), so "no longer errored" IS
 * "made progress" as adjudicated by the engine that owns that question. No second opinion here.
 */
export function noteAgentStatus(
  agentId: string,
  status: AgentTabStatus,
  now: number,
  readScrollback: (id: string) => string = (id) => getAgentScrollback(id) ?? "",
): StatusNote {
  const open = episodes.get(agentId);
  if (status === "errored") {
    if (open) return "none"; // already tracking this episode
    // CARRY THE LADDER across the status flip our own ping caused — see `recentlyEnded`. Without
    // this the ladder resets to rung 0 on every retry and the tail is unreachable.
    const prior = recentlyEnded.get(agentId);
    const carry =
      prior !== undefined &&
      prior.lastPingAt !== undefined &&
      now - prior.lastPingAt <= episodeCarryWindowMs(prior.attempts, prior.escalated);
    recentlyEnded.delete(agentId);
    // Re-classify only for a genuinely NEW episode. On a carry we keep the original verdict, for the
    // reason we classify once at entry at all: by now our own retry prompt is in the scrollback, and
    // it contains the words "529 Overloaded".
    //
    // ONE EXCEPTION, and it only goes one way: a carry still re-scans for TERMINAL and upgrades
    // (roborev 55485). Inheriting `failure` on elapsed time alone meant a real "You've hit your session
    // limit · resets …" arriving ten minutes after a rung-8 ping stayed `retryable` — so the human got
    // "the outage is outlasting the ladder" instead of "blocked on an ACCOUNT limit", a wrong REASON on
    // top of the wasted pings.
    //
    // SCOPED TO WHAT ARRIVED AFTER OUR PING (roborev 55517). Re-scanning the whole 40-row tail was
    // broader than its own safety argument, which only ever covered our `revivePrompt` echo. Anything
    // else in that tail could flip the episode to `terminal` — which escalates at once and never pings
    // again — and two shapes do it wrongly: the agent QUOTING the banner (our prompt literally asks it
    // to "say so plainly" if blocked on an account limit), or an agent reading this very repo, where
    // `engine/apiRecovery.ts` carries a verbatim banner with its tail; and a re-entry that is not an
    // API failure at all (a wedge, a process exit), where the most recent classifying line is a STALE
    // limit banner from earlier in the session that the un-scoped carry ignored. Both land on the
    // EXPENSIVE side of this module's asymmetry: a false billing claim plus retries stopped on a live
    // 529. Slicing at our own marker encodes the property actually being claimed — "the limit banner
    // arrived after our ping" — and the backwards scan then does the rest: if the agent quoted a banner
    // and THEN 529'd, the 529 is more recent and wins, so no upgrade.
    const rescan = carry ? classifyFromScrollback(sinceOurPing(readScrollback(agentId))) : null;
    const failure = carry
      ? rescan === "terminal"
        ? "terminal"
        : prior.failure
      : classifyFromScrollback(readScrollback(agentId));
    // A CARRIED-BUT-SPENT LADDER only ever reaches here on an IMMEDIATE re-fail, because
    // `episodeCarryWindowMs` collapses to the floor at exhaustion. That is the case where the re-fail is
    // plainly our own ping failing, so resuming at the spent count is right: `decideRevive` then returns
    // its give-up escalation and no further rung is spent. Anything slower is not a carry at all — it is
    // a NEW episode with a fresh ladder, and the repeated-ladder pressure that implies is bounded by
    // PING_BUDGET rather than by anything in this function. (An earlier revision paged here and
    // restarted at rung 0; both that page and its rationale are gone — see PING_BUDGET, roborev 55612.)
    const resumed = carry;
    episodes.set(agentId, {
      erroredSince: now,
      attempts: resumed ? prior.attempts : 0,
      lastPingAt: resumed ? prior.lastPingAt : undefined,
      failure,
      // Carried too, so a resumed episode that already told the human does not tell them again.
      escalated: resumed ? prior.escalated : false,
    });
    log.info("apiRecovery", resumed ? "episode resumed" : "episode opened", {
      agentId,
      failure,
      attempts: resumed ? prior.attempts : 0,
    });
    return resumed ? "resumed" : "started";
  }
  if (!open) return "none";
  episodes.delete(agentId);
  // Remember it briefly rather than forgetting outright: if this exit was our own ping clearing
  // `errored` (the common case), the agent is about to re-enter it and must resume its rung.
  //
  // BOUNDED, two ways (roborev 55457, Medium — it used to grow without limit). An entry is only ever
  // removed by a re-entry into `errored`, `forgetAgent`, or a reset, so an agent that errors once and
  // then behaves leaves its entry behind forever; over a long orchestrator session that is one dead
  // entry per worker uuid that ever hiccuped.
  //  (1) An episode that never got a ping can never satisfy the carry test (it keys on `lastPingAt`),
  //      so storing it buys nothing. Don't.
  //  (2) Prune anything older than the widest window any carry could still accept.
  if (open.lastPingAt !== undefined) {
    for (const [id, ended] of recentlyEnded) {
      if (now - ended.endedAt > MAX_CARRY_WINDOW_MS) recentlyEnded.delete(id);
    }
    recentlyEnded.set(agentId, {
      endedAt: now,
      attempts: open.attempts,
      lastPingAt: open.lastPingAt,
      failure: open.failure,
      escalated: open.escalated,
    });
  }
  log.info("apiRecovery", "left errored", {
    agentId,
    attempts: open.attempts,
    afterMs: now - open.erroredSince,
  });
  return "recovered";
}

/** Drop an agent's state entirely — it is gone (pane closed, project unloaded), so neither a live
 *  episode nor a carry-forward memory should survive it. */
export function forgetAgent(agentId: string): void {
  episodes.delete(agentId);
  recentlyEnded.delete(agentId);
  // The budget goes with it: this id is gone (pane closed, project unloaded), and a REUSED id must not
  // inherit a stranger's spent budget and be refused its first retry.
  exhaustedLadders.delete(agentId);
  pingLog.delete(agentId);
  budgetPaged.delete(agentId);
}

/** The edges a sweep needs. Injected so the whole runner is testable without a PTY or a store. */
export interface ReviveDeps {
  now: number;
  /** Current status of an agent, or undefined if unknown. */
  statusOf: (agentId: string) => AgentTabStatus | undefined;
  canAcceptInput: (agentId: string) => boolean;
  /** `engine/turnEndAuthority.processAliveOf` semantics — ALIVE-side, matching the `processAlive`
   *  field it feeds: true = alive, false = the PTY is gone, undefined = nobody looked.
   *
   *  This was `hasExited` and inverted at the call site. Reading it in the consumer's polarity deletes
   *  the flip rather than documenting it: the two shapes are both `boolean | undefined`, so the
   *  obvious wiring type-checked while meaning the exact opposite — an exited PTY would report alive
   *  and be typed into (roborev 55338). */
  processAliveOf: (agentId: string) => boolean | undefined;
  /** Types the retry into the agent's terminal. Rejects if it did not land. */
  submit: (agentId: string, text: string) => Promise<void>;
  /** Called once per episode when the human has to take over. */
  /**
   * `retriesSpent` is the number of pings actually spent, when the caller knows it better than the
   * episode does — which on the BUDGET path it always does (roborev 57761). The budget is charged
   * across PRIOR ladders, and it is checked before `episode.attempts` is assigned, so the common
   * case there is a brand-new episode escalating with `attempts === 0` while `pingLog` holds the
   * real spend. Omitted elsewhere, where `episode.attempts` is the truth.
   */
  onEscalate: (
    agentId: string,
    reason: string,
    episode: Readonly<ReviveEpisode>,
    retriesSpent?: number,
  ) => void;
  /** Master gate — false means "do not type on my behalf" and no ping is sent. */
  enabled: () => boolean;
}

/** What a sweep did to one agent, returned so tests assert on the decision rather than on a spy. */
export interface SweepOutcome {
  agentId: string;
  decision: ReviveDecision;
}

/**
 * One pass over every live episode.
 *
 * The gate order matters: `enabled()` is checked before any decision is computed, so a user who
 * turned autonomous typing off pays nothing and — more importantly — cannot have a ping sent by a
 * race between the toggle and an in-flight sweep.
 *
 * NOTHING RUNS AHEAD OF THE TOGGLE, and roborev 55628's Medium asked for something that did — a
 * pre-pass paying a one-off "we spent a whole ladder" page, on the argument that the toggle bans
 * TYPING and not TELLING. That argument was right about this gate and wrong about which mechanism
 * needed it: main's `MAX_LADDERS_PER_WINDOW` counter (PR #861) replaced the flag it was rescuing.
 * The finding's harm was that the page was single-shot and stored on an object the next status
 * change deletes, so skipping it DESTROYED it. The ladder budget has neither property: it is derived on
 * every sweep from `exhaustedLadders`, module state on a 4h rolling window that outlives both the
 * episode and the toggle. So the budget page is DEFERRED while typing is off and delivered by the
 * first sweep after it comes back — no rescue needed, and `episodeCarryWindowMs`'s comment asks
 * directly that no timing-based fix be reintroduced here.
 */
export async function sweepApiRecovery(deps: ReviveDeps): Promise<SweepOutcome[]> {
  if (episodes.size === 0) return [];
  if (!deps.enabled()) return [];
  const out: SweepOutcome[] = [];
  // Snapshot the KEYS only, and re-read each episode inside the loop (roborev 55433). `submit` is
  // awaited below — two PTY writes plus SUBMIT_CR_DELAY_MS — and an outage errors several agents at
  // once, so a status event arriving during that await can close or restart agent B's episode while B
  // is still in the snapshot. Holding the episode OBJECT from the snapshot would then paste a retry
  // into an agent that has already recovered.
  for (const agentId of [...episodes.keys()]) {
    const episode = episodes.get(agentId);
    if (episode === undefined) continue; // closed while we were awaiting an earlier agent's write
    const status = deps.statusOf(agentId);
    if (status === undefined) {
      // Fails CLOSED on absent evidence. `runtimeStore.resetProgress` deletes the status key while
      // the pane stays mounted for a fresh run in the reused slot, and there `canAcceptInput` and
      // `processAlive` both still pass — so defaulting to `errored` here would paste "automatic retry
      // 1 of 11" into an agent that just started a brand-new session.
      out.push({ agentId, decision: { action: "none", reason: "status-unknown" } });
      continue;
    }
    // KEEPS THIS BRANCH'S ALIVE-SIDE READER over main's `hasExited`. Not a preference: the field it
    // feeds is `processAlive`, and both shapes are `boolean | undefined`, so the obvious wiring
    // type-checks while meaning the exact opposite — an exited PTY reporting alive and being typed
    // into. Main compensated with an inversion at this call site; this branch deleted the inversion
    // by reading the question in the consumer's polarity (roborev 55338). Merging main's line here
    // would restore the hazard AND break the un-inverted `processAlive: alive` below.
    const alive = deps.processAliveOf(agentId);
    const decision = decideRevive({
      status,
      failure: episode.failure,
      now: deps.now,
      erroredSince: episode.erroredSince,
      attempts: episode.attempts,
      lastPingAt: episode.lastPingAt,
      canAcceptInput: deps.canAcceptInput(agentId),
      // No inversion: the reader is already alive-side. `undefined` (nobody looked) passes straight
      // through so the engine gives its "liveness-unknown" refusal rather than the false
      // "process-gone" one — the two are different claims and only one of them blames the agent.
      processAlive: alive,
    });
    out.push({ agentId, decision });


    if (decision.action === "escalate") {
      // Once per episode. The episode is deliberately KEPT (not deleted) so the row stays tracked and
      // the concierge can still read "we tried N times and gave up" out of it; it clears when the
      // agent leaves `errored`, like every other episode.
      if (!episode.escalated) {
        episode.escalated = true;
        log.warn("apiRecovery", "escalating to human", { agentId, reason: decision.reason });
        deps.onEscalate(agentId, decision.reason, episode);
      }
      continue;
    }
    if (decision.action !== "ping") continue;

    // THE TERMINATING BOUND (roborev 55566). Kept OUT of the episode, because every episode-keyed bound
    // leaks: that state can only travel through a carry, and a carry lapses once `lastPingAt` stops
    // advancing, after which a fresh episode starts the count over.
    //
    // Charged in EXHAUSTED LADDERS, not pings (roborev 55612) — a ladder that revived the agent cost
    // nothing and must not count against its next, unrelated outage.
    const spent = recentExhausted(agentId, deps.now);
    const pinged = recentPings(agentId, deps.now);
    // The ladder counter is the useful signal; the raw ping ceiling is the one that cannot be evaded.
    // Without it, an outage whose re-errors land outside the carry window completes no ladder, charges
    // nothing, and pings forever at a rung-0 cadence (roborev 55863, High).
    if (spent.length >= MAX_LADDERS_PER_WINDOW || pinged.length >= PING_BUDGET) {
      // Paged once per WINDOW rather than once per episode: `escalated` lives on the episode, and an
      // agent that recovers on its own and re-errors opens a new one, which used to re-page for every
      // such episode while asserting the "says so once" property (roborev 55612).
      // Latched on the COUNTER, not on time-since-last-page: those two windows drift, and a drifted
      // latch swallowed the SECOND give-up entirely (roborev 55863). Cleared below whenever the budget
      // is no longer spent, so the next give-up pages again.
      if (!budgetPaged.has(agentId)) {
        budgetPaged.add(agentId);
        log.warn("apiRecovery", "retry budget spent, leaving it red", {
          agentId,
          exhaustedLadders: spent.length,
          pings: pinged.length,
          windowMs: PING_BUDGET_WINDOW_MS,
        });
        deps.onEscalate(agentId, BUDGET_SPENT_REASON, episode, pinged.length);
      }
      episode.escalated = true;
      continue;
    }

    // A ladder that ran all the way out is the only retry cost worth charging — see `exhaustedLadders`.
    // Recorded when the LAST rung is sent, not when `decideRevive` later gives up: on the path that
    // matters, our own ping clears `errored` and the episode restarts before any sweep ever observes
    // `attempts >= length`, so a give-up-time hook records nothing at all (found by test).
    budgetPaged.delete(agentId); // under budget again, so a later give-up is allowed to page
    pingLog.set(agentId, [...pinged, deps.now]);
    if (decision.attempt >= REVIVE_LADDER_MS.length) {
      const prior = recentExhausted(agentId, deps.now);
      exhaustedLadders.set(agentId, [...prior, deps.now]);
    }

    // Record the attempt BEFORE awaiting the write. If the write throws we must not retry the same
    // rung immediately on the next sweep — that would turn a dead PTY into a tight loop, which is the
    // unbounded-retry failure the ladder's bounds exist to prevent.
    episode.attempts = decision.attempt;
    episode.lastPingAt = deps.now;
    try {
      await deps.submit(agentId, decision.prompt);
      log.info("apiRecovery", "retried", { agentId, attempt: decision.attempt });
    } catch (e) {
      log.warn("apiRecovery", "retry did not land", { agentId, attempt: decision.attempt, error: String(e) });
    }
  }
  return out;
}

/** When the soonest pending rung across all episodes comes due — for diagnostics and the concierge's
 *  "next retry in N seconds" line. Null when nothing is pending. */
export function nextRetryDueAt(now: number): number | null {
  let soonest: number | null = null;
  for (const ep of episodes.values()) {
    const due = nextRungDueAt({
      attempts: ep.attempts,
      erroredSince: ep.erroredSince,
      lastPingAt: ep.lastPingAt,
      now,
    });
    if (due !== null && (soonest === null || due < soonest)) soonest = due;
  }
  return soonest;
}

/**
 * The agent's display name, or its id when the roster cannot answer.
 *
 * `agentDisplayName` is the SHARED naming rule on purpose: a report that names an agent something
 * the sidebar does not call it is a report the human cannot act on. Falling back to the raw id is
 * still better than omitting the subject — an escalation about an unnamed agent is unactionable.
 */
function labelForAgent(agentId: string): string {
  const agent = useProjectStore
    .getState()
    .projects.flatMap((p) => p.agents)
    .find((a) => a.id === agentId);
  return agent === undefined ? agentId : agentDisplayName(agent);
}

/** The real-world dependency set. Split out so the hook and any manual trigger share one wiring. */
export function liveDeps(now: number): ReviveDeps {
  return {
    now,
    statusOf: (id) => useRuntimeStore.getState().status[id],
    canAcceptInput: agentCanAcceptInput,
    processAliveOf,
    // submitPrompt pastes + sends, and registers the text as user input for this agent first — which
    // this path NEEDS: without it our own prompt's echo can read as a self-prompt churn wedge to
    // engine/streamFailure and re-trip the very red we are clearing (see pty.submitPrompt).
    // `machine: true` — this is a RETRY PING, not a person. It still clears the `api`/`churn` red
    // this path depends on clearing (that is how the ladder observes whether the retry worked), but
    // it must not clear an ACCOUNT-limit wall: no amount of pinging moves a session limit, and a
    // machine send that cleared it would repaint the row green and hide the block. See
    // StatusEngine.noteUserInput, which draws exactly that line.
    submit: (id, text) => submitPrompt(id, text, { machine: true }),
    // ── THE LADDER'S TERMINUS NOW REACHES SOMEBODY (sparkle-4cd0x) ─────────────────────────────
    //
    // This was a deliberate no-op, on reasoning that was correct when it was written: the row is
    // already red, `errored` is already in `engine/attention`'s set, so the dock badge, the system
    // notification and the concierge's proactive push all fire without anything more from here, and
    // a second channel would double-page the human for one event.
    //
    // The gap is WHICH event each of those announces. Every one of them fires when the row TURNS
    // red — a change in the needs-you digest. Giving up is a different fact arriving up to an hour
    // and a half later, and it moves no digest at all: the row has been red the whole time, so the
    // proactive channel has nothing to notice and stays silent by design. Nothing anywhere marked
    // the moment retrying stopped. The founder's report is exactly that shape — an agent that died
    // on a 529 after 21 minutes of good work and "has sat `errored` ever since", with the ladder
    // having already run and quit hours earlier.
    //
    // So this is not a second page for the same event; it is the first and only report of a
    // different one. It goes to the CONCIERGE rather than to the founder because a dead agent is
    // something the concierge can act on — restart it, or take its branch over — which is the
    // preference order the Pusher work established: agent, then concierge, then the human.
    //
    // `notifyConcierge` returns false when no window is listening. That is honest rather than
    // ignorable, but there is deliberately nothing to retry here: `escalated` has already latched,
    // and the condition is a standing one the Pusher's own sweep re-observes every minute. Logged,
    // not re-queued.
    onEscalate: (agentId, reason, episode, retriesSpent) => {
      // READ FROM THE EPISODE, NOT ASSUMED (roborev 57761). An earlier version hardcoded
      // `transient: true` on the reasoning that a terminal account limit escalates without ever
      // pinging, so anything reaching here must have been retried. That is false: `decideRevive`
      // answers `failure === "terminal"` with `{action:"escalate"}` BEFORE any ping arm, and the
      // sweep routes every escalate decision through this callback — so an agent behind a spend cap
      // or session window arrives here with `attempts === 0`.
      //
      // Two harms, and the second is the one that matters. The count would have been a false claim
      // ("retried 0 times and stayed dead" about an agent never retried), and the REMEDY would have
      // been wrong: restarting an agent whose account limit has not reset just re-fails. That is
      // exactly the distinction `routeSilence`'s non-transient branch exists to draw — "read its
      // terminal, then restart it" rather than "it was retried N times and stayed dead".
      const transient = episode.failure !== "terminal";
      // The budget path knows the real spend; every other path's truth is on the episode.
      const retries = retriesSpent ?? episode.attempts;
      const route = routeSilence({
        label: labelForAgent(agentId),
        transient,
        retries,
        // Equal, which is what makes `routeSilence` report `transient-retries-exhausted` rather than
        // hold its tongue: reaching this callback IS the exhaustion.
        retryLimit: retries,
        message: reason,
      });
      if (route.target !== "concierge") return;
      if (!notifyConcierge(route.text)) {
        log.warn("apiRecovery", "gave up on an agent and could not tell the concierge", { agentId });
      }
    },
    enabled: () => aiFeatureVisibleNow("autoApprove"),
  };
}

/**
 * Mount the runner: watch every agent's status for episode start/end, and sweep on a timer.
 *
 * Mounted ONCE, app-level — not per pane. Episodes are keyed by agent id in module state, so a
 * per-pane mount would run N sweeps over the same map and could double-send a rung.
 */
export function useApiRecovery(): void {
  useEffect(() => {
    // Seed from anything ALREADY red in this window's status map at mount.
    //
    // Scope, stated accurately (roborev 55433 corrected an overclaim here): this does NOT cover an
    // app restart. `runtimeStore.status` is live-only and never persisted, and the panes that populate
    // it mount AFTER this App-level effect, so on a cold start this loop finds nothing — the
    // subscription below is what catches those agents as their engines report in. What the seed does
    // cover is a REMOUNT with the store already populated (a hot reload, or this component remounting
    // while agents are running). Post-restart recovery would need a source that survives a reload —
    // the captured screen or the transcript — and is not attempted here.
    const seed = useRuntimeStore.getState().status;
    for (const [agentId, status] of Object.entries(seed)) {
      if (status === "errored") noteAgentStatus(agentId, status, Date.now());
    }

    const unsub = useRuntimeStore.subscribe((state, prev) => {
      for (const [agentId, status] of Object.entries(state.status)) {
        if (prev.status[agentId] === status) continue;
        noteAgentStatus(agentId, status, Date.now());
      }
      // An agent removed from the map entirely (project unloaded, agent closed) leaves no transition
      // to observe, so its state would leak and keep being swept against a gone agent. Clears the
      // carry-forward memory too, or a reused agent id could inherit a stale rung count.
      for (const agentId of Object.keys(prev.status)) {
        if (!(agentId in state.status)) forgetAgent(agentId);
      }
    });

    const timer = setInterval(() => {
      void sweepApiRecovery(liveDeps(Date.now()));
    }, SWEEP_INTERVAL_MS);

    return () => {
      unsub();
      clearInterval(timer);
    };
  }, []);
}
