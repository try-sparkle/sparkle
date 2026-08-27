// The concierge's TERMINAL I/O domain — read what an agent's terminal says, and type into it.
//
// The concierge column is the user's single point of interaction, which only holds if the concierge
// can answer two questions without the human touching column three: "what is agent X actually doing
// right now?" and "type this into agent X". This module is those two questions, plus the small
// status read the answer to both depends on.
//
// ---------------------------------------------------------------------------------------------
// READING — why this is a CHAIN and not a function call
//
// The obvious implementation is `getAgentScrollback(agentId)` (services/terminalScrollback) and
// nothing else. That returns NULL whenever the agent's terminal pane isn't mounted — and on a real
// fleet most agents are unmounted most of the time, because only the agent you are looking at has a
// live xterm. A concierge built on tier (a) alone would therefore be blind to exactly the agents the
// user ISN'T watching, which is the entire population they'd be asking about.
//
// So the read falls through four sources, freshest first:
//
//   (a) scrollback       — the live xterm buffer. What the terminal shows RIGHT NOW. Mounted panes only.
//   (b) attention-screen — runtimeStore.attentionScreen[agentId], the screen captured the moment the
//                          agent crossed into waiting/approval. Survives an unmounted pane and is
//                          usually the exact text of the ask; it is a SNAPSHOT, not the present. It
//                          is EXPIRED rather than immortal (sparkle-99o9a) — twice over, and neither
//                          expiry alone covers the tier: the store drops it when the agent leaves
//                          red, which never fires for an agent whose pane is unmounted, and
//                          `captureFor` additionally discards it once the movement ledger has seen
//                          that agent act since. Read that as "bounded", not as "live".
//   (c) history-search   — the SQLite FTS store (src-tauri/src/history.rs) of every prompt/response.
//                          Snippets, not screens, and query-driven (see the note on the tier below).
//   (d) transcript       — read_transcript_last_assistant (src-tauri/src/transcript.rs): the last
//                          thing the agent SAID, out of Claude Code's own session JSONL.
//
// Every result names its source and its FRESHNESS, and that reporting is load-bearing rather than
// diagnostic garnish. Tiers (a) and (b) read almost identically — a screenful of terminal text — but
// one is live and the other may be twenty minutes stale. A caller that can't tell them apart will
// narrate a captured screen as "right now", which is precisely the confident-and-wrong failure the
// concierge must not have. The chain also records why each SKIPPED tier had nothing, so "its pane
// isn't mounted" and "it genuinely has produced no output" stay distinguishable.
//
// CONTEXT COST IS A FIRST-CLASS CONSTRAINT. Everything this returns lands in an LLM context window,
// so no caller ever receives an unbounded blob: output is capped by lines and by chars, the cap is
// the MODULE's (a caller can lower it but never raise it past the ceiling), and a truncated read
// says so, in words, with amounts. The budgets follow existing precedent rather than inventing new
// numbers — SNAPSHOT_MAX_LINES=300 from services/terminalScrollback and 4000 chars from
// useAttentionNotifications.DETAIL_MAX, which bounds the same kind of terminal tail for the phone.
//
// ---------------------------------------------------------------------------------------------
// WRITING — a thin delegation, deliberately
//
// `sendToAgentTerminal` does NOT write to a PTY. It hands off to `dispatchConciergeAnswer`
// (services/conciergeDispatch), which already owns live-picker reclassification, CR framing for
// raw-mode Ink pickers, the trial meter, prompt-history side effects, pending-send queueing for a
// PTY that isn't up yet, and the whole refusal taxonomy. Re-implementing any of that here would give
// the app two write paths with two sets of safety rules, and the second one would be the one nobody
// remembers to update. What this module adds is one gate the dispatcher can't add for itself (below)
// and one refusal the dispatcher deliberately doesn't make (`unknown-agent`, see the function).
//
// AUTHORITY. Every concierge-originated PTY write carries a `DispatchAuthority` saying WHY it was
// allowed (services/dispatchAuthority). The union has no `router` arm because a heuristic verdict is
// not a user gesture — and an AI tool call is not one either, so there is no bare `concierge` arm.
// A tool write rides on `{ kind: "concierge-tool", policy }`, where `policy` names the decision that
// permitted it: a standing allow-tier policy, or a human answering an ask-tier prompt with yes. An
// unresolved or denied policy is not representable, and `conciergeToolAuthority` is the only
// constructor.

import { invoke } from "@tauri-apps/api/core";
import { log } from "../../logger";
import {
  agentCanAcceptInput,
  dispatchConciergeAnswer,
  liveOptionsFor,
  wasSubmitted,
  type ConciergeDispatchPath,
} from "../conciergeDispatch";
import { isDispatchAuthority, type ConciergeToolAuthority } from "../dispatchAuthority";
import { PtyGoneError, writePtyChainedStrict } from "../../pty";
import { searchHistory } from "../history";
import { SNAPSHOT_MAX_LINES, getAgentScrollback } from "../terminalScrollback";
import {
  agentConfigDir,
  agentSessionIds,
  agentTranscriptPath,
  agentTranscriptWorktree,
} from "../agentTranscriptRegistry";
import { isRedStatus } from "../windowStatus";
// The "has this agent acted since its red was raised" ledger, shared with the concierge feed's
// stale-red retraction — see `captureFor` for why the ask-screen needs the same answer.
import { movedSince, movedSinceStamp, windowRetractionLedger } from "../../engine/movementRetraction";
import { isObserved, type AgentLiveness } from "../agentLiveness";
import {
  goalReading,
  awaitingCloseEvidenceFor,
  stallReadingFor,
  thrashReadingFor,
  type GoalReading,
} from "../agentGoalReading";
import type { StallReport } from "../../engine/agentStall";
import type { ThrashReport } from "../../engine/agentThrash";
import {
  findKnownAgent,
  knownAgentLiveness,
  type KnownAgentSource,
} from "../knownAgents";
import { SPARKLE_AGENT_ID, isSparkleAgentId } from "../sparkleAgent";
// The ONE "is Improve Sparkle mid-work" rule, shared with the `get_state` row that publishes it as
// `activity` — so the write gate and the roster cannot disagree about the same agent in one turn.
import { sparkleBusyNow } from "../sparkleBusy";
import { calmNewAgent } from "../../engine/newAgentAttention";
import { useInteractionStore } from "../../stores/interactionStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import type { AgentTabStatus } from "../../types";
import { detectTerminalPrompts } from "../suggestions/heuristics";
import type { SuggestionButton } from "../suggestions/types";
// The menu-identity rule, which now lives beside the dispatcher rather than here — see that module's
// header. `conciergeDispatch` has to run it too, and this file imports the dispatcher, so keeping it
// here would have made that a cycle (bead sparkle-jk8zt).
import { pickerFingerprint } from "../pickerFingerprint";
// ── THE `quit_alternate_screen` GATE'S FOUR PREDICATES (bead sparkle-w11lll) ─────────────────────
// Every one of these is REUSED, never re-derived. A private copy of any of them would drift away
// from the module that owns it, and the gate's whole safety argument is that it agrees with the
// dispatcher, the answerability band and the plan router about what is on screen.
import { getAgentViewport, type TerminalViewport } from "../terminalViewport";
// `hasClaudeCodeLiveTui` alongside `isClaudeCodeScreen` on purpose: it is the same evidence without
// the `>= 2` corroboration bar, so it is the arm that still says "Claude Code" in the H2
// false-negative case that motivated this op.
import { hasClaudeCodeLiveTui, isClaudeCodeScreen } from "../../engine/claudeCodeScreen";
import { screenOffersAnswer } from "../../engine/screenAnswerable";
import { isPlanExitDialog } from "../suggestions/planPrompt";
import { isPlanModeDialog } from "../suggestions/conciergeEscalation";
import { parsePickerOptions } from "../suggestions/heuristics";

// ---------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------

/** Char ceiling on anything this module hands back. Matches useAttentionNotifications.DETAIL_MAX,
 *  which bounds the same kind of terminal tail on its way to the phone — the constraint is
 *  identical (a runaway scrollback must not bloat a payload someone pays for), so the number is
 *  too. Not imported from there: that module is a React hook that pulls in the notification and
 *  relay stacks, and a service shouldn't drag those in for one integer. */
export const TERMINAL_READ_MAX_CHARS = 4000;

/** Line ceiling, re-exported from the scrollback serializer so the two can't drift. A snapshot is
 *  already capped at 300 lines on its way out of xterm; keeping the same bound here means the live
 *  tier is never re-truncated to a different shape than the phone sees. */
export const TERMINAL_READ_MAX_LINES = SNAPSHOT_MAX_LINES;

/** Floor on the char budget. A caller may lower the cap, but not below the point where the elision
 *  marker would crowd out the content it is prefixed to — under this the "budget" stops meaning
 *  anything and the guarantee `text.length <= maxChars` gets hard to keep honestly. */
const MIN_READ_CHARS = 64;

/** How many FTS hits to fold into a tier-(c) answer. Snippets are short (FTS5 `snippet()` gives ~12
 *  tokens of context), so a handful is a paragraph, not a wall. */
const DEFAULT_HISTORY_HITS = 5;

/** Ceiling on `historyLimit`, and it belongs to the module for the same reason the char budget does
 *  — with one extra: this number is MULTIPLIED before it reaches SQLite (see the over-fetch below),
 *  so an unclamped `historyLimit: 5_000_000` was a 50M-row FTS query running `snippet()` per row on
 *  the history connection's mutex. That is a UI freeze bought with one hallucinated tool argument.
 *  Twenty snippets is already more terminal history than an answer can use. */
export const HISTORY_MAX_HITS = 20;

/** Ceiling on the OVER-FETCH. The 10× below is a filter allowance, not a budget, so it needs its own
 *  cap — otherwise raising HISTORY_MAX_HITS silently raises what SQLite is asked to do by ten times
 *  as much. */
export const HISTORY_MAX_FETCH = 200;

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/** Where the returned text came from. `none` means every tier was tried and none had content. */
export type TerminalSource =
  | "scrollback"
  | "attention-screen"
  | "history-search"
  | "transcript"
  | "none";

/**
 * How close to NOW the text is. The single most important field for a caller composing an answer:
 * `live` may be narrated in the present tense, `captured` is a snapshot from when the agent last
 * stopped to ask something, and `historical` is a record of what was said, not of what is on screen.
 */
export type TerminalFreshness = "live" | "captured" | "historical" | "none";

/** One tier of the chain, and what came of it. Present for EVERY tier, including the ones that were
 *  never reached — a caller that wants to explain a thin answer needs the misses, not just the hit. */
export interface TerminalTierAttempt {
  source: Exclude<TerminalSource, "none">;
  ok: boolean;
  /** Why this tier produced nothing. Absent when it did. */
  why?: string;
}

export interface AgentTerminalRead {
  agentId: string;
  source: TerminalSource;
  freshness: TerminalFreshness;
  /** The content, already capped. Never null — an agent with nothing anywhere yields `""`. */
  text: string;
  truncated: boolean;
  /** What was dropped, in a sentence with amounts, present only when `truncated`. Meant to be shown
   *  to the model reading `text` so it never treats a tail as the whole story. */
  truncation?: string;
  attempts: TerminalTierAttempt[];
}

export interface ReadAgentTerminalOptions {
  /** Lower the char budget. Values above {@link TERMINAL_READ_MAX_CHARS} are clamped DOWN to it —
   *  the ceiling belongs to the module, not to a caller, because a tool argument is one model
   *  hallucination away from asking for a megabyte — and values under the floor are clamped UP,
   *  because a cap the output can't honour is worse than one that's adjusted. */
  maxChars?: number;
  /** Lower the line budget. Clamped the same way. */
  maxLines?: number;
  /** Search term for tier (c). Without one the tier is skipped, and says so — see the tier. */
  query?: string;
  /**
   * How many history hits to fold in (tier c). Clamped to {@link HISTORY_MAX_HITS}, and a missing or
   * nonsense value falls back to the module default rather than to the ceiling.
   */
  historyLimit?: number;

  // THERE IS DELIBERATELY NO `transcriptPath` HERE. It used to exist, overriding the registry for
  // tier (d), and it was an arbitrary-file read: `read_transcript_last_assistant` opens whatever
  // absolute path it is handed, this module's output goes straight into an LLM context window, and
  // THIS INTERFACE IS THE TOOL ARGUMENT SURFACE — so the path would have been supplied by the model.
  // Any JSONL on disk with an `assistant` record (another project's transcript, another session's)
  // was readable that way. `noteAgentTranscriptPath` is the only source now; a caller with a path to
  // offer registers it, which is a decision made in app code rather than in a tool call.
}

export interface AgentStatusReport {
  agentId: string;
  /**
   * Can this window address this agent at all? `false` means a closed or invented id.
   *
   * NOT "is there a project-store row": it also covers the app-owned Improve Sparkle agent, which is
   * never in any project's roster, and any agent this window has a live status for. `detail` names
   * which. The one guarantee worth branching on is that `known` is TRUE whenever `observed` is —
   * see the note at the return site for the contradiction that used to be reachable here.
   */
  known: boolean;
  status: AgentTabStatus | "unknown";
  runtime: "local" | "cloud" | "unknown";
  /** Can it take input RIGHT NOW? Straight from `agentCanAcceptInput` — see the note there. */
  canAcceptInput: boolean;
  /**
   * Is it in a red state (waiting/approval/blocked/errored) — i.e. stuck until the human acts?
   *
   * ONLY MEANINGFUL WHEN `observed` IS TRUE. `false` here means "no red status was seen", which
   * covers both "it is calm" and "this window never had a status for it". Branch on `observed`
   * first; `detail` says which case you are in, in a sentence you can relay.
   */
  needsYou: boolean;
  /** Whether `status` (and therefore `needsYou`) was READ or merely defaulted — see AgentLiveness. */
  liveness: AgentLiveness;
  /** `liveness === "local"`. The one flag a caller needs before treating `needsYou` as a fact. */
  observed: boolean;
  /**
   * The agent's GOAL — what it is trying to achieve, and where that goal is in its life.
   *
   * ABSENT when the agent has no goal, deliberately, rather than a zero-filled record. "It has no
   * goal" is a real and common answer (it disables auto-continue and it means an idle row cannot be
   * called stalled on goal grounds), and a caller reads it from the key being missing.
   */
  goal?: GoalReading;
  /**
   * Is this agent idle-and-FINISHED or idle-and-STALLED — `engine/agentStall`.
   *
   * ABSENT when there is no status to judge (an unknown agent, or one this window never observed).
   * A stall verdict is a claim about an agent's state, and there is no honest verdict to give about
   * a row we could not read; `unknown` inside the report means something narrower ("idle, and its
   * git state was not read"), so reusing it for "no status at all" would collapse two facts.
   */
  stall?: StallReport;
  /**
   * Is it looping on a command, or out of usable context — `engine/agentThrash`.
   *
   * ABSENT when this window has seen no hook events for the agent. THAT IS NOT "HEALTHY": the
   * accumulator is fed by the pane that drives the agent, so an agent whose pane lives in another
   * window has no reading here at all. Treat the missing key as "not watched", never as calm.
   */
  thrash?: ThrashReport;
  /** One sentence explaining what this report does and does not establish. Always present. */
  detail: string;
}

/** Where a tool send ended up. The dispatcher's own taxonomy plus the two refusals this layer makes
 *  on its own behalf.
 *
 *  `sparkle-busy` is the second (bead sparkle-x0pvw): the app-owned Improve Sparkle agent shares ONE
 *  worktree between its interactive pane and its hourly headless pass, and the app enforces one
 *  `claude` per worktree — so a send landing mid-pass puts a second mutator in that tree. It is a
 *  path of its OWN rather than folded into an existing refusal because the remedy is unlike every
 *  other one here: nothing is wrong, nothing needs retrying, and the correct action is to wait. */
export type ConciergeSendPath = ConciergeDispatchPath | "unknown-agent" | "sparkle-busy";

export interface ConciergeSendResult {
  ok: boolean;
  agentId: string;
  /**
   * HAS THE MESSAGE ACTUALLY BEEN SUBMITTED TO THE AGENT? (bead sparkle-1cu3j)
   *
   * `ok: true` alone does NOT mean delivered, and that was the defect: a send aimed at an agent
   * whose PTY is still coming up returns `ok: true, path: "queued"` having written nothing at all.
   * The caller was told it succeeded, could not tell otherwise without reading the pane, and a
   * caller that retries on failure therefore never retried. Filed six times.
   *
   * READ IT AS THE DELIVERY QUESTION and `ok` as the acceptance one. `ok: true, submitted: false`
   * is the honest shape of a queued send: nothing is wrong, and nothing has arrived yet — `detail`
   * says which. Derived by `conciergeDispatch.wasSubmitted`, exhaustively over the path, so it is
   * never a field somebody forgot to set.
   *
   * ⚠️ A CLAIM ABOUT THE CARRIAGE RETURN, NOT ABOUT THE AGENT'S ATTENTION — see `wasSubmitted`.
   */
  submitted: boolean;
  path: ConciergeSendPath;
  /**
   * The text as the USER should see it. Deliberately NOT the dispatcher's `sent`: that is the wire
   * payload, which may carry attachment temp paths or a bare `2\r` keystroke frame, and this result
   * gets quoted straight back into an LLM context and from there to a human.
   */
  display?: string;
  /** The picker option that matched, when the send answered a live prompt. */
  matchedLabel?: string;
  /** The live options, when the send was refused as ambiguous — so the caller can ask the user. */
  options?: SuggestionButton[];
  /** One sentence explaining the outcome, ready to relay. Always present. */
  detail: string;
}

// ---------------------------------------------------------------------------------------------
// Transcript paths — the seam for tier (d)
// ---------------------------------------------------------------------------------------------

// `read_transcript_last_assistant` takes a PATH, and this module will not invent one — a fabricated
// `~/.claude/projects/<slug>/<id>.jsonl` fails confusingly, and the slug rule belongs to Rust
// (src-tauri/src/claude.rs), not here. So tier (d) reads only what a caller in APP CODE has handed
// over, in one of the two forms below, and skips itself (saying why) when it has neither.
//
// It also does not accept a path from the CALLER of the read: `ReadAgentTerminalOptions` is the tool
// ARGUMENT surface, so a `transcriptPath` override there was a model-supplied arbitrary-file read
// landing in an LLM context. That stays removed — see the note on that interface.
//
// TWO WRITERS, TWO DIFFERENT SAFETY PROPERTIES. Both are app code; neither takes a model's word for
// anything. What they differ on is which file, and how they know it is the right one:
//
//  1. AN EXACT PATH — `noteAgentTranscriptPath`, from `components/AgentPane.noteTranscriptFromHook`,
//     wired as the REQUIRED `noteTranscript` field of `engine/hookEvents.HookEventHandlerDeps` (so the
//     hand-off cannot be dropped without a compile error). Its safety property is Claude Code's own
//     Stop event: the path names the session that just spoke, and the handler's session gate rejects a
//     background `claude` sharing the worktree's log. Read that helper's doc comment before changing
//     anything here; the two are a pair.
//
//     ⚠ AND IT IS ALSO WHAT TIER (d) NOW REQUIRES, which narrows writer (2) below to less than it
//     advertises. Since roborev 63135 the tier is gated on writer (3)'s SESSION IDS, and the only
//     production writers of those are this hook handler and the two Sparkle-only paths
//     (`improvementPass`, `sparkleTranscript`). So a build agent whose pane has never been mounted
//     has a worktree and NO session binding, and its tier-(d) read now returns null where it
//     previously returned a transcript. That is a deliberate fail-closed trade — the alternative is
//     quoting a stranger's conversation to the concierge as this agent's own words — but it is a
//     REAL loss of coverage for exactly the population writer (2) was introduced to serve, and
//     nothing in the suite surfaces it (the test pins the refusal). Tracked as its own bead; the
//     repair is a non-hook binding source for pane-less build agents, mirroring what
//     `bindWorktreeSession` already gives the app-owned Sparkle agent. Read this before concluding
//     from the comment below that the pane-less case still works end to end — it resolves, and then
//     tier (d) declines.
//
//  2. A WORKTREE — `noteAgentTranscriptWorktree`, for an agent with NO pane, hence no hook events
//     — and, since the mounted-concierge transcript work, for EVERY BUILD AGENT: `projectStore
//     .setAgentWorktree` registers one the moment a worktree is cut. (It was the app-owned Improve
//     Sparkle agent alone; see services/sparkleTranscript.) THE SCOPE OF THE RESIDUAL RACE BELOW
//     WIDENED WITH IT — it is now fleet-wide rather than one app-owned agent, so read it as a
//     property of every agent's tier-(d) read, not a footnote about one. Two things bound it, and
//     neither is new: writer (1) WINS wherever it is registered, so any agent with a pane (i.e. any
//     agent the founder is actually looking at) resolves through the session-gated exact path and
//     never reaches this scan; and the failure mode remains mislabelled provenance rather than a
//     read of an arbitrary file, because the directory is still one the app itself created.
//     The mounted pane does not rely on this registry at all — it resolves the worktree from the
//     roster row and calls the transcript reader directly — so widening this writer buys
//     `readAgentTerminal` a fallback it did not have across relaunches without putting the new
//     surface behind the weaker resolution. The file is resolved AT READ TIME as the newest
//     transcript in that worktree's project dir THAT IS ONE OF THE AGENT'S OWN SESSIONS — writer (3)
//     supplies the "own", and without it this read is skipped entirely. Its safety property:
//       • The worktree is one the app itself created; no id-to-path guessing, nothing a model said.
//       • "Newest at read time" is the live session while an agent is running, because the file being
//         written has the freshest mtime. That is the whole point of resolving late: this used to
//         resolve ONCE at spawn time, which — since the improvement pass runs with no `--resume` and
//         therefore writes a brand-new `<uuid>.jsonl` every hour — pinned the PREVIOUS pass's
//         transcript forever, and handed the concierge the wrong conversation (not a stale view of
//         the right one) for the whole pass.
//       • THE SIBLING-`claude` RACE IS CLOSED (roborev 63135). It used to be accepted knowingly: a
//         *different* `claude` invoked with that same cwd writes into the same project dir, can hold
//         the newest mtime, and unlike writer (1) there was no session gate to reject it. That was
//         tolerable when the alternative on offer was a stale pin — pinning the id the pass reports
//         on `sparkle_improve:done` cannot help mid-flight, which is exactly when the read is asked
//         for, and would reintroduce a stale pin outranking a live resolution. Writer (3) is neither:
//         it is a SET that accumulates, so it constrains the resolution without pinning it, and the
//         live session joins it as soon as the agent speaks. `agent_own_session_path` chooses the
//         newest among the agent's own files; an unknown binding resolves NOTHING rather than the
//         newest stranger. Fail-closed here costs a tier; the alternative costs the truth.
//
// Writer (1) WINS when both are registered, because an exact session-gated path is strictly better
// evidence than a directory scan. No agent has both today.
//
// NOTHING CLEARS EITHER MAP TODAY. The `forget*` exports are for a caller that genuinely knows an
// agent is gone, and there isn't one — the pane's unmount cleanup is the wrong place twice over (it
// fires on a project switch, and tier (d) exists to serve UNMOUNTED agents). The cost is one short
// string per agent id opened this process. Stated plainly here so nobody reads the exports as
// evidence of a lifecycle that doesn't exist.
// THE MAPS LIVE IN `services/agentTranscriptRegistry` — a leaf module with no imports of its own.
//
// They were here, next to the reader that consumes them, which reads well but made every WRITER
// import this module: the snapshot machinery, the dispatcher and the suggestion heuristics come with
// it. `stores/projectStore` registers a worktree the moment one is cut, and that edge dragged
// `SNAPSHOT_MAX_LINES` into the module graph of every test importing the project store, failing 16
// of them at COLLECTION with zero test failures. Re-exported here so this module's public surface is
// unchanged for existing importers.
//
// ONLY THE NAMES THAT HAVE AN IMPORTER HERE. `agentSessionIds` and `subscribeAgentSessionIds` were
// also re-exported and nothing imported either one from this module — every consumer reaches the
// leaf directly. That was not merely dead surface: it made the registry header's claim that writer
// (3) constrains writer (2) READ as though it were implemented here, while `resolveWorktreeTranscript`
// below still resolved unfiltered (roborev 63135). It is implemented now, and `agentSessionIds` is
// imported for that use rather than re-exported — a re-export is a promise to other modules, and
// there is no other module.
export {
  noteAgentTranscriptPath,
  noteAgentTranscriptWorktree,
  noteAgentSessionId,
  forgetAgentTranscriptPath,
} from "../agentTranscriptRegistry";

// ---------------------------------------------------------------------------------------------
// Capping
// ---------------------------------------------------------------------------------------------

interface Capped {
  text: string;
  truncated: boolean;
  truncation?: string;
}

/**
 * Resolve a caller's budget against the module's own ceiling.
 *
 * Clamps DOWN to `ceiling` and UP to `floor`, and treats a missing/NaN/non-finite request as "use
 * the ceiling". The ceiling is the module's, not the caller's: a tool argument is one model
 * hallucination away from `maxChars: 1e9`, and honouring that would put a megabyte of terminal into
 * a context window. A request below the floor is equally not honoured — see MIN_READ_CHARS.
 */
function clamp(requested: number | undefined, floor: number, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  return Math.min(Math.max(Math.floor(requested), floor), ceiling);
}

/**
 * Bound `raw` to the line and char budgets, keeping the TAIL.
 *
 * The tail, always, and for one reason: a terminal's current question sits at the BOTTOM of the
 * screen. Keeping the head would reliably drop the only part the concierge is being asked about.
 * (The same reasoning drives DETAIL_MAX's tail slice and the Rust summarizer's SCREEN_TAIL_CHARS.)
 * The history tier orders its snippets oldest-first for the same reason, so "the tail" is the
 * newest material there too.
 *
 * Reports what it dropped in words with amounts. A bare "…" prefix tells a model that something is
 * missing; it does not tell it HOW MUCH, and the difference between "12 lines earlier" and "40,000
 * characters earlier" changes how much a reader should trust the fragment.
 */
function capTail(raw: string, maxChars: number, maxLines: number): Capped {
  const text = raw.replace(/\s+$/, "");
  const notes: string[] = [];
  let out = text;

  const lines = out.split("\n");
  if (lines.length > maxLines) {
    notes.push(`${lines.length - maxLines} earlier line(s)`);
    out = lines.slice(lines.length - maxLines).join("\n");
  }

  // The elision marker is paid for INSIDE the budget. A caller that sized its context window against
  // `maxChars` must not be handed maxChars + 2 because a marker was prefixed after the measuring was
  // done — so the room for content is the budget MINUS the marker, decided before the slice.
  const marker = "…\n";
  const room = Math.max(0, maxChars - marker.length);
  if (out.length > room) {
    notes.push(`${out.length - room} more character(s)`);
    out = out.slice(out.length - room);
  }
  if (notes.length === 0) return { text: out, truncated: false };
  return {
    text: marker + out,
    truncated: true,
    truncation: `Truncated to the most recent output — dropped ${notes.join(" and ")} from the start.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

const FRESHNESS: Record<Exclude<TerminalSource, "none">, TerminalFreshness> = {
  scrollback: "live",
  "attention-screen": "captured",
  "history-search": "historical",
  transcript: "historical",
};

/** One tier's outcome: content, or the reason there wasn't any. */
type TierResult = { text: string } | { why: string };
const hasText = (r: TierResult): r is { text: string } => "text" in r;

/**
 * Read an agent's recent terminal content, saying WHERE it came from.
 *
 * Walks the four-tier chain documented at the top of this file, freshest first, stopping at the
 * first tier with real content. Never throws and never returns null: an agent with nothing anywhere
 * comes back as `source: "none"` with an empty string and four recorded misses, which is a fact the
 * concierge can state ("I can't see anything from that agent") rather than an error it must handle.
 */
export async function readAgentTerminal(
  agentId: string,
  opts: ReadAgentTerminalOptions = {},
): Promise<AgentTerminalRead> {
  // Both budgets are resolved against the MODULE's ceiling, never the caller's — see `clamp`.
  const maxChars = clamp(opts.maxChars, MIN_READ_CHARS, TERMINAL_READ_MAX_CHARS);
  const maxLines = clamp(opts.maxLines, 1, TERMINAL_READ_MAX_LINES);

  const attempts: TerminalTierAttempt[] = [];
  const tiers: [Exclude<TerminalSource, "none">, () => TierResult | Promise<TierResult>][] = [
    ["scrollback", () => readScrollbackTier(agentId)],
    ["attention-screen", () => readAttentionTier(agentId)],
    ["history-search", () => readHistoryTier(agentId, opts)],
    ["transcript", () => readTranscriptTier(agentId)],
  ];

  let hit: { source: Exclude<TerminalSource, "none">; text: string } | null = null;
  for (const [source, run] of tiers) {
    if (hit) {
      // Record the untried tiers so the attempts array is always the full chain — a caller
      // reasoning about coverage shouldn't have to infer which tiers exist from which ones ran.
      attempts.push({ source, ok: false, why: `not needed — answered from ${hit.source}` });
      continue;
    }
    let r: TierResult;
    try {
      r = await run();
    } catch (err) {
      // A tier is a best-effort source, and three of the four are IPC. One failing must not fail the
      // read — that would make the concierge blind whenever SQLite is busy.
      r = { why: `${source} failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (hasText(r)) {
      hit = { source, text: r.text };
      attempts.push({ source, ok: true });
    } else {
      attempts.push({ source, ok: false, why: r.why });
    }
  }

  if (!hit) {
    log.debug("concierge", "terminal read found nothing", { agentId });
    return { agentId, source: "none", freshness: "none", text: "", truncated: false, attempts };
  }
  const capped = capTail(hit.text, maxChars, maxLines);
  return {
    agentId,
    source: hit.source,
    freshness: FRESHNESS[hit.source],
    text: capped.text,
    truncated: capped.truncated,
    ...(capped.truncation ? { truncation: capped.truncation } : {}),
    attempts,
  };
}

/** Tier (a): the live xterm buffer, when the pane is mounted. */
function readScrollbackTier(agentId: string): TierResult {
  const raw = getAgentScrollback(agentId);
  if (raw === null) {
    return { why: "the agent's terminal pane isn't mounted, so there is no live scrollback" };
  }
  // A mounted-but-blank terminal is not an answer. Falling through matters: an agent whose pane was
  // just opened has an empty buffer while its captured ask-screen still explains what it wants.
  if (raw.trim() === "") return { why: "the mounted terminal has produced no output yet" };
  return { text: raw };
}

/**
 * The captured ask-screen, with BOTH expiries applied — the one place either is asked, so tier (b)
 * and `mayHaveMenu` cannot end up believing different things about the same snapshot.
 *
 * TWO EXPIRIES, BECAUSE ONE SIGNAL DOES NOT COVER THE POPULATION THIS TIER EXISTS FOR.
 *
 *   1. `runtimeStore.setStatus` drops the capture when the agent leaves the red tier (sparkle-99o9a).
 *      That is the whole answer for an agent with a MOUNTED pane — but `runtimeStore.status` has
 *      exactly one writer, `components/AgentPane`, so for an agent this window is not hosting the
 *      status is a frozen last reading and no `setStatus` ever runs (engine/movementRetraction's
 *      header states this at length). That is precisely the population that reaches tier (b) at all:
 *      tier (a) is consulted first and is blind exactly when the pane is unmounted. So expiry 1 alone
 *      would leave the capture immortal for every agent it actually matters for.
 *   2. So the second expiry reads the signal that DOES exist for an unhosted agent: the movement
 *      ledger `engine/movementRetraction` accumulates from `fleet_digest` — hook work events, session-
 *      gated, high-water-marked per red episode. `movedSince` is the SAME predicate the concierge feed
 *      uses to retract a frozen red from the UI, imported rather than restated: if it is enough to say
 *      "that red is over", it is enough to say "the screen that red was raised on is over".
 *
 * Both fail toward SERVING the capture: an empty ledger (no feed built yet) and a status nobody has
 * moved both leave it in place. For `mayHaveMenu` that is the fail-closed direction (it keeps
 * refusing); for the read chain it is today's behaviour.
 */
function captureFor(agentId: string): TierResult {
  const raw = useRuntimeStore.getState().attentionScreen[agentId];
  if (!raw || raw.trim() === "") {
    return { why: "the agent hasn't stopped to ask anything, so no ask-screen was captured" };
  }
  // AGAINST THE CAPTURE'S OWN WRITE TIME when we have one (bead sparkle-5wbhn). `movedSince`
  // compares against the red episode's RAISE time, and `waiting → approval` is one episode — so an
  // agent that asks, is answered, and asks again inside it wrote a capture NEWER than the movement,
  // and judging it episode-relative threw away the freshest evidence there is. That is not merely a
  // stale read: `mayHaveMenu` then returns false and `sendControlKey` PERMITS `enter` into a live,
  // unread picker. A capture with no stamp keeps the old comparison rather than being trusted
  // blindly — absent evidence must not become permission.
  const capturedAt = useRuntimeStore.getState().attentionScreenAt[agentId];
  const stale =
    capturedAt === undefined
      ? movedSince(windowRetractionLedger(), agentId)
      : movedSinceStamp(windowRetractionLedger(), agentId, capturedAt);
  if (stale) {
    return {
      why: "the agent captured an ask-screen, but it has been seen working since — that screen describes a question it has already moved past",
    };
  }
  return { text: raw };
}

/** Tier (b): the screen captured when the agent crossed into waiting/approval. */
function readAttentionTier(agentId: string): TierResult {
  return captureFor(agentId);
}

/**
 * Tier (c): the SQLite FTS store of every prompt and response.
 *
 * QUERY-DRIVEN, and that is structural rather than a shortcut. The FTS5 virtual table in
 * src-tauri/src/history.rs indexes the `text` column ONLY (`agent_id` is a plain column on the base
 * table, not part of the index), so "everything agent X said" is not a query it can answer — there
 * is no match expression that means "all rows". A query-less read therefore skips this tier and
 * SAYS SO, rather than inventing a search term (the agent's name would match other agents' text)
 * or silently returning nothing (which reads as "this agent has no history").
 *
 * With a query, the search is global and the filtering is ours: hits for other agents, and
 * unattributed hits, are dropped. Leaking either would have the concierge narrate another agent's
 * work as this one's, with full confidence.
 */
async function readHistoryTier(
  agentId: string,
  opts: ReadAgentTerminalOptions,
): Promise<TierResult> {
  const query = opts.query?.trim();
  if (!query) {
    return {
      why: "no search term was given, and the history index is full-text over message text only — it can't list one agent's rows",
    };
  }
  // Clamped against the module's ceiling, exactly like the char and line budgets — see
  // HISTORY_MAX_HITS for why this one matters more than either. A missing or nonsense limit falls
  // back to the DEFAULT rather than to the ceiling: an unstated preference is not a request for the
  // most rows available, and NaN used to slide through `Math.max` straight into the invoke args.
  const want =
    opts.historyLimit === undefined || !Number.isFinite(opts.historyLimit)
      ? DEFAULT_HISTORY_HITS
      : clamp(opts.historyLimit, 1, HISTORY_MAX_HITS);
  // Over-fetch: the filter below is ours, so asking for exactly `want` rows would come back short
  // whenever other agents outrank this one on the query. Capped in its own right — see
  // HISTORY_MAX_FETCH.
  const hits = await searchHistory(query, Math.min(want * 10, HISTORY_MAX_FETCH));
  // TWO filters, and the second is a GATE rather than a relevance rule (roborev 61894-M1).
  //
  // `agentId` is what this tier is about: one agent's own terminal work. `source` is about who may
  // read what — `concierge` rows are the founder's private conversations with his minder, and
  // `workspace.ts`'s `search_history` makes reading them cost an approval card (`scope: "all"`).
  // This tool is `read-only`, i.e. auto-allowed, and calls the raw history service, so without this
  // line it is a SECOND door onto the same rows with no card and no scope argument.
  //
  // "The agentId filter already excludes them" is not a safe answer: it holds only while the
  // recording half stores concierge turns with `agentId: null`, and the concierge column tracks a
  // `mountedAgentId` that a plausible implementation would stamp onto them. Defence in depth — a
  // terminal tier has no business returning concierge turns under ANY recording scheme.
  const mine = hits.filter((h) => h.agentId === agentId && h.source !== "concierge");
  if (mine.length === 0) return { why: `no history entries for this agent matched "${query}"` };
  // Oldest last would put the newest material at the head, where the tail-cap would cut it. Order
  // oldest-first so "keep the tail" keeps the most recent, exactly as it does for a screen.
  const chosen = mine
    .slice(0, want)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((h) => `[${h.kind}] ${h.snippet}`);
  return { text: chosen.join("\n") };
}

/**
 * Tier (d): the last thing the agent SAID, from Claude Code's own session transcript.
 *
 * The file comes from the REGISTRY and from nowhere else — an exact path if a Stop event gave us one,
 * otherwise the newest transcript in a registered worktree, resolved HERE rather than at registration
 * so a long-running agent is never read one session behind. A caller-supplied override was the one
 * place in this module where an argument became a filesystem path — see the note on
 * `ReadAgentTerminalOptions` for why that is not a knob a tool argument gets to turn.
 */
async function readTranscriptTier(agentId: string): Promise<TierResult> {
  const path = agentTranscriptPath(agentId) ?? (await resolveWorktreeTranscript(agentId));
  if (!path) {
    // THE TWO REASONS ARE NAMED SEPARATELY, because they call for opposite responses and this string
    // is read by an LLM that will act on it. "No worktree" means nobody registered this agent yet;
    // "unknown binding" means we know where to look and are REFUSING to guess whose file it is. A
    // single message would have the concierge report a deliberate, correct refusal as missing
    // plumbing — and the obvious repair for missing plumbing is to widen the read, which is the
    // defect. (AGENTS.md: a remedy string is an instruction the reader will follow.)
    // THE TRAILING CLAUSE USED TO PROMISE A WAIT THAT NEVER ENDS (roborev 63248). It said the
    // binding "arrives with its first hook event" — but hook-driven binding requires a mounted
    // pane, and an agent with a mounted pane has writer (1) and never reaches this branch at all.
    // So for exactly the population that reads this string, the promised event cannot arrive. An
    // LLM told to wait for it waits forever, and the obvious repair for a wait that never resolves
    // is to widen the read — which is the wrong-attribution defect this tier was closed to prevent.
    // It now describes a standing condition, so the reader stops waiting and reports it instead.
    //
    // SPLIT ON THE BINDING, NOT ON THE WORKTREE (roborev 63331). The worktree-present branch is
    // reached from TWO states that call for opposite responses, and answering both with one
    // sentence inverts the transient/standing axis for one of them — the very axis this string
    // exists to get right:
    //   (b1) NO BINDING. Standing: hook-driven binding needs a mounted pane, and an agent with one
    //        never reaches this branch, so nothing will arrive on its own.
    //   (b2) BOUND, but Claude has not yet written one of this agent's sessions into that worktree.
    //        `resolveWorktreeTranscript`'s own doc calls this "the normal state of a brand-new agent
    //        rather than a fault" — it resolves by itself the moment the file appears.
    // Telling (b2) the condition is standing is the more dangerous error of the two: a reader that
    // stops re-reading reports a healthy new agent as permanently unreadable, or widens the read to
    // compensate, which is the wrong-attribution defect this tier was closed to prevent.
    const bound = (agentSessionIds(agentId)?.length ?? 0) > 0;
    const why = agentTranscriptWorktree(agentId)
      ? bound
        ? "this agent is bound to its Claude sessions, but none of them has been written into its worktree yet — that is the normal state of a brand-new agent, and it resolves on its own once Claude writes the first one"
        : "this agent's Claude sessions aren't known, so its transcript can't be read without risking another agent's conversation. No session binding is recorded, which is the standing state for an agent whose pane has never been open — it is not a delay to wait out"
      : "no transcript path is known for this agent (see noteAgentTranscriptPath / noteAgentTranscriptWorktree)";
    return { why };
  }
  const text = await invoke<string>("read_transcript_last_assistant", { path });
  if (!text || text.trim() === "") return { why: "the transcript has no assistant turn yet" };
  return { text };
}

/**
 * Writer (2)'s half of tier (d): the newest transcript in this agent's registered worktree that is
 * one of THIS AGENT'S OWN sessions — or null when it has no worktree registered, no session binding,
 * or a worktree Claude has not yet written one of its sessions into (the normal state of a brand-new
 * agent rather than a fault).
 *
 * CONSTRAINED BY WRITER (3), which is what the registry's header claims and, until roborev 63135,
 * was not true here. This resolved through the unfiltered `claude_latest_session_path`, so it could
 * hand `read_transcript_last_assistant` whichever `claude` in that directory had the newest mtime —
 * the identical wrong-attribution defect the mounted pane was fixed for, on the surface where it is
 * arguably worse: the pane shows a stranger's words to a human who can see they look wrong, whereas
 * this quotes them to the concierge as "what this agent last said", which then repeats it as fact.
 *
 * FAILS CLOSED on an unknown binding, exactly like the page and tail reads. Checked HERE rather than
 * left to Rust — which also fails closed — so an unidentified agent costs zero IPC, and so the
 * refusal has a reason the caller can be told (see `readTranscriptTier`). The Rust guard stays as
 * defence in depth: it is the surface, and `agent_own_session_path` documents why it is a separate
 * command from the unfiltered LEARN seam rather than a mode of it.
 */
async function resolveWorktreeTranscript(agentId: string): Promise<string | null> {
  const worktreePath = agentTranscriptWorktree(agentId);
  if (!worktreePath) return null;
  const sessionIds = agentSessionIds(agentId);
  if (!sessionIds) return null;
  // `[...sessionIds]`, matching the page and tail call sites in `services/agentTranscript`: the
  // registry hands out a FROZEN array (its identity has to be stable for `useSyncExternalStore`), and
  // all three readers of that binding send a copy across the boundary rather than the shared object.
  // AND WHICH ACCOUNT'S `projects/` ROOT TO SCAN — writer (4). Sparkle spawns each agent's `claude`
  // with a per-account `CLAUDE_CONFIG_DIR`, so the transcript lives under
  // `<accountConfigDir>/projects/<slug>/`. Omitting it sent Rust to `$HOME/.claude/projects/<slug>`,
  // which for an account-spawned agent does not exist — so this returned null and tier (d) reported
  // "none of its sessions has been written into its worktree yet" about an agent that was writing at
  // that moment. `undefined` here is NOT writer (3)'s fail-closed UNKNOWN: pass `null` and let Rust
  // fall back to `$HOME/.claude`, which is right for an agent with no account override.
  return (
    (await invoke<string | null>("agent_own_session_path", {
      worktreePath,
      configDir: agentConfigDir(agentId) ?? null,
      sessionIds: [...sessionIds],
    })) ?? null
  );
}

// ---------------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------------

/** Anything this window can address by this id — a roster row, the app-owned Sparkle agent, or an
 *  agent it is actively observing. See services/knownAgents for the three arms and why a bare
 *  roster scan was wrong (it is what made "Improve Sparkle" unreachable from here). */
const findAgent = findKnownAgent;

/** The sentence that goes with each report, so an LLM reading this result does not have to infer
 *  what a `false` establishes. Kept beside the report it describes. Pure. */
function statusDetail(
  source: KnownAgentSource | undefined,
  liveness: AgentLiveness,
  status: AgentTabStatus | undefined,
  needsYou: boolean,
): string {
  if (source === undefined) {
    return (
      "No agent with this id is open. It was closed, or the id is stale — a roster read taken " +
      "even a moment earlier can legitimately list an agent that has since been closed, so this " +
      "is not the app contradicting itself. Re-read the roster before treating it as missing."
    );
  }
  // WHAT KIND of known, said out loud. `known: true` used to imply "there is a roster row", and the
  // two extra arms would be a silent widening of that promise if the detail did not name them: a
  // caller told an agent exists will go looking for it in `get_state`, and neither of these appears
  // there. The Sparkle line also carries the ADDRESS, because the id is the one thing a caller
  // cannot discover from the roster.
  if (source === "sparkle") {
    return (
      "This is the built-in Improve Sparkle agent — the app's own self-improvement agent, " +
      "addressable at the stable id `" +
      SPARKLE_AGENT_ID +
      "`. It is not part of any project's roster (it works on Sparkle itself, in an app-owned " +
      "clone), so it will not appear in get_state — but these terminal ops reach it exactly as " +
      "they reach a build agent. " +
      (liveness === "local"
        ? `Read live: status '${status}'.`
        : "Its pane is open in another window, so the status below is a default, not a reading.")
    );
  }
  if (source === "observed") {
    return (
      "This window is reading a live status for this agent, but it has no roster row here — its " +
      "project is not loaded in this window, or it was closed while running. The status below is " +
      "a real reading; the agent's name, project and kind are not available."
    );
  }
  if (liveness !== "local") {
    return (
      "This window has no live status for this agent" +
      (liveness === "other-window" ? " (its pane is open elsewhere)" : "") +
      ", so needsYou:false means NOT OBSERVED — not 'nothing needs you'. Do not report it as calm."
    );
  }
  return needsYou
    ? `Read live: status '${status}' — it is stuck until the human acts.`
    : `Read live: status '${status}' — nothing is waiting on the human.`;
}

/**
 * The agent's live status and whether it can take input right now.
 *
 * `canAcceptInput` is `agentCanAcceptInput` (services/conciergeDispatch) verbatim rather than a
 * second predicate over the same store. That function is documented to fail CLOSED — an agent the
 * store has never heard of answers `false`, because that is when delivery is least likely to work —
 * and a tool surface wants precisely that bias. Re-deriving it here would be the exact duplication
 * that conciergeDispatch.predicates.test.ts exists to warn about.
 *
 * `needsYou` USED TO BE REPORTED AS A FACT even when there was nothing to read. `runtimeStore.status`
 * is window-local, so an agent with no entry produced `isRedStatus(undefined) === false` — the same
 * value a calm agent produces. A concierge polling its fleet one agent at a time got `false` from
 * every row and told the human nothing needed them while the sidebar had one painted red. `status`
 * was already honest ("unknown"); the derived boolean was the lie, and the boolean is what gets
 * branched on. `liveness`/`observed`/`detail` are that fix, and they reuse services/agentLiveness so
 * this cannot drift from the identical correction already made to `get_state`.
 *
 * The open-pane set is built EXACTLY as `handleGetState` builds it — in-memory merged with the
 * persisted set on every call. `runtimeStore.openAgentIds` is merged with what is on disk only at
 * open()/close() time, so a window's in-memory copy goes stale between those events; re-reading the
 * persisted set each call is what `get_state` does to avoid that (roborev 53406 / ).
 * Skipping it here would have made this surface answer "unknown" for an agent `get_state` was
 * calling "other-window" at the same moment — two views contradicting each other about the very
 * field added to stop that. (roborev 54546.)
 */
export function getAgentStatus(agentId: string): AgentStatusReport {
  const agent = findAgent(agentId);
  const rt = useRuntimeStore.getState();
  // `calmNewAgent` corrects for "spawned but never briefed", which needs the roster row's own
  // creation/brief timestamps. The other two arms have no row, and neither needs the correction: the
  // Sparkle agent is briefed by the app itself the moment it starts (a mission prompt, or the hourly
  // pass's), and an `observed`-only id is by definition one this window is watching run. So they
  // read the raw status rather than being handed a synthetic row to satisfy a signature.
  const tab = agent?.tab;
  // The raw runtime status, CORRECTED for "spawned but never briefed" (engine/newAgentAttention).
  // A briefless agent reaches `blocked` on statusEngine's 25s stall timer having asked nobody
  // anything, and `blocked` is in the red-colour tier `needsYou` is derived from — so without this
  // the tool answered `needsYou: true` for every agent the user had spawned and not yet briefed,
  // which is the single most expensive FALSE POSITIVE this API can produce (it is what a concierge
  // polls to find the agent that is stuck). Applied HERE, on the same map every other surface reads,
  // rather than as a special case on the boolean: `status` is reported to the caller too, and a tool
  // that said `blocked` while the sidebar said `new` would just move the disagreement.
  //
  // `livenessOf` deliberately keeps asking the RAW map: it answers "did this window observe this
  // agent at all", which is a question about the entry's existence, not its value.
  const status = tab
    ? calmNewAgent(
        rt.status[agentId],
        tab,
        Date.now(),
        // Route 4: the LIVE (in-memory) record of a brief typed straight into the terminal pane.
        // Not the only one any more — route 5 (`agent.terminalBriefedAt`) rides along on the agent
        // record passed above and is what makes the answer survive a relaunch, which this
        // session-scoped map cannot. See engine/newAgentAttention.
        useInteractionStore.getState().lastAt[agentId],
      )
    : rt.status[agentId];
  const liveness = knownAgentLiveness(agentId);
  // The red-COLOR tier (waiting|approval|blocked|errored), asked of the shared predicate so this
  // can't drift from what the sidebar paints.
  const needsYou = isRedStatus(status);
  // ── GOAL / STALL / THRASH — the three readings that tell a GRAY row apart from a done one ─────
  //
  // One clock for all three, so a goal reported `unmet` can never sit beside a stall report that
  // read it as `expired` a millisecond later.
  const now = Date.now();
  // `agent.tab` is the roster row; the other two `findKnownAgent` arms (the Sparkle agent, and an
  // observed-only id) have no AgentTab and therefore no goal, which reads as "no goal" — correct,
  // rather than inventing a synthetic row to hang one on.
  // WITH THE EVIDENCE, because `stallReadingFor` below computes its own — a report whose `goal.state`
  // said `escalated` while its `stall.causes` said `awaiting-close` is one object disagreeing with
  // itself, which is the divergence this whole module was extracted to prevent (roborev 65987).
  const goal = goalReading(
    agent?.tab?.goal,
    now,
    awaitingCloseEvidenceFor(agentId, agent?.tab?.goal),
  );
  // `stallReadingFor` needs a STATUS to judge, and `status` is `undefined` for an unknown agent or
  // one this window never observed. There is no honest verdict there, so the field is omitted
  // rather than filled with a guess — see AgentStatusReport.stall.
  const stall =
    status === undefined ? undefined : stallReadingFor(agentId, status, agent?.tab?.goal, now);
  // `undefined` when no hook event for this agent has been seen here. Passed through unchanged:
  // synthesising a healthy report for an unwatched agent is the exact false negative this whole
  // report's `observed` flag exists to prevent (see AgentStatusReport.thrash).
  const thrash = thrashReadingFor(agentId, agent?.tab?.goal, now);
  return {
    agentId,
    // KNOWN AND OBSERVED CAN NO LONGER DISAGREE, and that is an invariant, not a side effect of
    // this particular resolver. The pair used to report `{ known: false, observed: true, status:
    // "working" }` for the Improve Sparkle agent — the same call saying it was reading a live status
    // for an agent that does not exist. A caller cannot act on that: `known: false` is documented as
    // "closed or invented", which tells it to stop, while `observed: true` tells it the reading is
    // authoritative. `findKnownAgent`'s third arm resolves ANY id with a live status entry, so the
    // contradiction is now unrepresentable rather than merely unlikely. See knownAgents' header, and
    // the invariant test in terminal.test.ts.
    known: agent !== undefined,
    status: status ?? "unknown",
    runtime: agent?.runtime ?? "unknown",
    canAcceptInput: agentCanAcceptInput(agentId),
    needsYou,
    liveness,
    observed: isObserved(liveness),
    ...(goal ? { goal } : {}),
    ...(stall ? { stall } : {}),
    ...(thrash ? { thrash } : {}),
    detail: statusDetail(agent?.source, liveness, status, needsYou),
  };
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

export interface SendToAgentTerminalOptions {
  /**
   * Is this text the USER's own prompt? Default TRUE, because the concierge tool exists to relay
   * what the human asked for — which means it should be metered, recorded in prompt history, and
   * allowed to feed auto-naming, exactly as typing it into the composer would have been. It also
   * turns on the dispatcher's terseness guard, so "yes, but rename the flag first" is refused as
   * ambiguous instead of collapsing onto a picker's `y\r`. Set false only for machine-authored
   * relay text that must not be charged or recorded.
   */
  userPrompt?: boolean;
  /**
   * This send is a PICKER PRESS answering the named menu — see `ConciergeDispatchOptions.pickerPress`
   * for what it does and why it is a fingerprint rather than a flag (bead sparkle-jk8zt).
   *
   * NOT IN ANY TOOL SCHEMA, deliberately. `selectPickerOption` sets it after its own fingerprint
   * check; the model-facing `send_to_agent_terminal` handler passes only `userPrompt`, so free text
   * has no way to ask for the alternate-screen exemption this carries.
   */
  pickerPress?: { fingerprint: string };
}

/** One sentence per outcome, ready to hand back to a model composing a reply.
 *
 *  EXPORTED FOR THE CLASSIFIER'S PRODUCER-BOUND TESTS, not for another caller.
 *  `Concierge/refusalAudience` matches some of these sentences literally, and nothing coupled the two
 *  — so a routine copy edit here would silently reclassify a gate and put the wall of text back in
 *  the founder's feed with the whole suite green. That drift had already happened once for the
 *  roborev gates (roborev 63295); `refusalAudience.test.ts` now reads THIS function so a reword reds. */
export function sendDetail(path: ConciergeSendPath, agentId: string): string {
  switch (path) {
    case "picker-option":
      return "Answered the prompt that was on screen.";
    case "free-text":
      return "Sent to the agent's terminal.";
    case "queued":
      return "The agent's terminal isn't up yet — held and will be sent the moment it is ready.";
    case "queue-full":
      return "Not sent: too many messages are already waiting for this agent to start.";
    case "ambiguous-picker":
      return "Not sent: the agent has a prompt on screen and this text doesn't match any of its options.";
    case "empty":
      return "Nothing to send — the message was blank.";
    case "trial-spent":
      return "Not sent: the free trial is spent.";
    case "expired":
      return "Not sent: it waited too long for a terminal that never came up.";
    case "abandoned":
      return "Not sent: the agent closed while the message was waiting.";
    case "agent-failed":
      return "Not sent: the agent gave up starting. It needs a Retry.";
    // NARROWED with the dispatcher (design 2026-08-01 §Decision 7): a cloud agent DOES take a
    // prompt now — it goes to the sandbox's stdin over the relay — so this path no longer means
    // "there is no terminal to type into". It means the send was an ANSWER to something on the
    // agent's own screen, which only its own pane can give.
    case "cloud-agent":
      return "Not sent: that agent runs in the cloud and is waiting on something on screen — that has to be answered in its own pane.";
    case "cloud-offline":
      return "Not sent: that agent runs in the cloud and there's no live connection to it right now.";
    case "unauthorized":
      return "Not sent: nothing authorized this write.";
    case "pty-gone":
      return "Not sent: the agent's terminal has closed.";
    // Unreachable from this tool today — `neverPickerAnswer` is set only by the CONCIERGE COMPOSE
    // send — but the union is exhaustive here on purpose, so it gets an honest line rather than
    // falling into the bare "Not sent." default if a caller ever sets it.
    case "addressed-at-picker":
      return "Not sent: the agent is waiting on a choice on screen, so a message can't go in right now.";
    // ── NAME THE EVIDENCE, NOT A GUESS DRESSED AS ONE (roborev 63727, Medium) ────────────────────
    //
    // This read "the agent is in a full-screen app (an editor or pager), where typed text would run
    // as commands." That asserts as fact something this path does not know, and which the field
    // measurements in this tree say is essentially never true. The refusal fires on
    // `alternateBuffer && !claudeCodeHoldsTheBuffer` (services/conciergeDispatch) — and CLAUDE CODE'S
    // OWN PERMISSION DIALOG takes it, because the dialog replaces the composer box
    // `isClaudeCodeScreen` requires, leaving exactly one marker family and a `false`.
    //
    // `goalContinuationRunner` already made this correction for its own copy of the sentence, on the
    // measured evidence: "five agents frozen with this reason, every one of them a normal Claude Code
    // pane stopped at `Do you want to proceed?`, not one in an editor or a pager". The two sentences
    // describe ONE screen state; they must not disagree about what is on it. AGENTS.md is explicit
    // that user-facing copy is code and that a remedy string is an instruction — "quit that app" is
    // one a human cannot follow when there is no app to quit, and it names an obstacle that does not
    // exist while withholding the one that does.
    //
    // The guard's PREMISE is untouched: typed text in a real pager still runs as commands, and this
    // still refuses. Only the claim about WHY has been narrowed to what was actually observed.
    //
    // ── AND THE REMEDY IS ADDRESSED TO THE HUMAN, OUT LOUD (roborev 63747, Medium) ────────────────
    //
    // THIS STRING IS DUAL-AUDIENCE, which is the trap. `registry.ts` returns it to the concierge
    // MODEL as the tool's error `detail`, and `controlListener` settles the same text as the
    // FOUNDER-facing receipt reason. A first draft ended "open its pane and answer what's on screen"
    // — read by the human that is right, and read by the model it is an invitation to answer the
    // prompt ITSELF via `read_picker_options` + `select_picker_option`, which is the one write path
    // holding a verified exemption from this very guard (`conciergeDispatch`'s `verifiedPickerPress`).
    // A refusal that points at the path around itself, ending in a button press the founder never
    // read.
    //
    // That is exactly the `sparkle-8bvh` shape AGENTS.md names: a remedy string is an INSTRUCTION,
    // and it has to be safe under the same conditions that triggered the refusal. So the remedy now
    // names WHOSE it is and says plainly that this side will not act on it. The founder still learns
    // what to do; the model is told, in the same sentence, not to do it for him.
    //
    // NO EM-DASH IN THIS SENTENCE, deliberately: ` — ` is the receipt line's own separator between
    // verb, reason and agent pills, and a reason containing it leaves the reader unable to see where
    // the reason ends and the agent list begins (same finding). Keep any future wording clear of it.
    case "alternate-screen":
      return "Not sent: that terminal is in full-screen mode and I couldn't recognise it as Claude Code's own prompt, so typing there could have run as commands. Usually that means a permission dialog is waiting. It's the human's to answer in that agent's own pane; I won't press anything on their behalf.";
    // Same shape as the line above and the same reason it offers no rephrasing: the screen is
    // waiting on a specific answer, and free text submitted into it would be answering the wrong
    // question — or, at a credential field, echoing nothing while it did so.
    //
    // ── AND IT NOW ALSO COVERS A PERMISSION DIALOG (bead sparkle-d6a5r) ──────────────────────────
    // A Claude Code permission dialog on the alternate buffer used to take `alternate-screen`,
    // because `isClaudeCodeScreen` false-negatives on the screen where the dialog has replaced the
    // composer box. `conciergeDispatch` now classifies that correctly, which routes it HERE — so
    // this sentence has to name it, or the most common screen reaching this refusal is the one it
    // does not describe. AGENTS.md: a fix that changes what happens must update every string that
    // narrated the old behaviour.
    case "blocked-prompt":
      return "Not sent: the agent is waiting on something on screen (a permission dialog, a prompt, or a credential field), which this text would have been submitted into. It's the human's to answer in that agent's own pane; I won't press anything on their behalf.";
    case "unknown-agent":
      return `Not sent: there is no open agent with id ${agentId}.`;
    // THE GENERIC FORM. The refusal site passes the LIVE sentence from services/sparkleBusy instead
    // of this, because "which hold, and how long" is exactly what makes the answer actionable — a
    // 30-minute headless pass and a 20-second pane turn call for very different waits. This line is
    // the honest fallback for any caller that reaches `sendDetail` with the path alone, and it says
    // "wait" rather than offering an alternative, because there is no rephrasing that makes a second
    // writer in that worktree safe (AGENTS.md: a remedy string is an instruction).
    case "sparkle-busy":
      return "Not sent: the Improve Sparkle agent is mid-work in the worktree this would write to. Wait for it rather than retrying.";
    default: {
      const unhandled: never = path;
      void unhandled;
      return "Not sent.";
    }
  }
}

/**
 * Send `text` to an agent's terminal, under a declared authority.
 *
 * DELEGATES to `dispatchConciergeAnswer` for the actual write — see the header. This function's own
 * contribution is two gates:
 *
 * 1. The AUTHORITY check, run first and before anything is read or written. Two questions, not one:
 *    is this a well-formed authority at all, AND is it the concierge-tool arm? The dispatcher can
 *    only ask the first — it accepts every arm, because every other arm is a real user gesture that
 *    a real call site passes it. A TOOL may not claim one. `{kind:"suggestion", agentId}` and
 *    `{kind:"mention", agentId}` need nothing but an agent id, which the tool call already supplies,
 *    so accepting any arm here would let the tool surface authorize itself with a shape it can build
 *    from its own arguments and no policy decision would ever be consulted. The parameter type says
 *    so and this check re-states it at runtime, for the JS callers and off-the-wire objects
 *    TypeScript never sees.
 *
 * 2. `unknown-agent` — a refusal the dispatcher deliberately does NOT make, and the asymmetry is on
 *    purpose. The dispatcher lets an unknown id through because the compose box aims at agents the
 *    store may not have caught up with yet, and a live PTY may well be there. A TOOL's agentId comes
 *    from a MODEL and can simply be invented, so an id nothing recognizes is far likelier to be a
 *    hallucination than a sync gap — and an irreversible write is the wrong way to find out. That is
 *    the same reasoning `agentCanAcceptInput` encodes, which is why the gate asks it rather than
 *    restating it.
 *
 * A CLOUD agent falls THROUGH to the dispatcher instead of being refused here, and that is now what
 * makes a cloud send WORK rather than what makes the refusal consistent: the dispatcher relays a
 * prompt to the sandbox's stdin, and refuses only an answer to the agent's own on-screen prompt
 * (design 2026-08-01 §Decision 7). Either way the verdict comes from the one place that owns it —
 * this module still invents no cloud path of its own.
 */
export async function sendToAgentTerminal(
  agentId: string,
  text: string,
  authority: ConciergeToolAuthority,
  opts: SendToAgentTerminalOptions = {},
): Promise<ConciergeSendResult> {
  // `detailOverride` exists for ONE caller: gate 2.5 below, whose sentence depends on live state
  // (which hold, and for how long) rather than on the path alone. Everything else takes the
  // path-derived line, so the taxonomy stays the single source of the wording.
  const refuse = (path: ConciergeSendPath, detailOverride?: string): ConciergeSendResult => ({
    ok: false,
    agentId,
    // A refusal never wrote a byte. Stated rather than derived here because these three paths
    // (`unauthorized`, `unknown-agent`, `sparkle-busy`) are this layer's own and never reach the
    // dispatcher, so `wasSubmitted` is not the thing that answers for them.
    submitted: false,
    path,
    detail: detailOverride ?? sendDetail(path, agentId),
  });

  // Gate 1. Fails closed on every shape TypeScript can't see — including a `concierge-tool`
  // authority whose policy is still `ask` or was `deny`, which is not a representable value of the
  // union and therefore only ever arrives by cast or off the wire.
  //
  // The `kind` check is not redundant with `isDispatchAuthority`: that validator accepts ANY arm, by
  // design, because it also guards the six user-gesture call sites. A tool write rides on the tool
  // arm or on nothing at all — see the doc comment.
  if (!isDispatchAuthority(authority) || authority.kind !== "concierge-tool") {
    log.warn("concierge", "tool send refused — no valid authority", { agentId });
    return refuse("unauthorized");
  }

  // Gate 2. `agentCanAcceptInput` is false two ways, and they are different facts.
  if (!agentCanAcceptInput(agentId)) {
    // Unknown id → refuse here, without a write. See the doc comment.
    if (findAgent(agentId) === undefined) {
      log.warn("concierge", "tool send refused — no such agent", { agentId });
      return refuse("unknown-agent");
    }
    // Otherwise it's a cloud agent: fall through, so the refusal comes from the dispatcher that
    // owns it rather than from a second copy of the same sentence invented here.
  }

  // Gate 2.5. THE APP'S OWN AGENT SHARES ITS WORKTREE WITH A SCHEDULER (bead sparkle-x0pvw).
  //
  // Improve Sparkle has two bodies — the interactive pane whose PTY this write targets, and an
  // hourly HEADLESS `claude -p` pass — and they work in ONE worktree, under the app's one-claude-
  // per-worktree invariant. A send delivered mid-pass is therefore not merely ill-timed: it puts a
  // second mutator into a tree another process is committing from. Giving the concierge access to
  // this agent was explicitly conditioned on not breaking what it is already doing, and this gate is
  // where that condition lives.
  //
  // HERE, NOT IN `agentCanAcceptInput`. That predicate answers "does this agent have a local PTY",
  // and `sendControlKey`, dictation and the API-recovery ping all gate on it too — overloading it
  // would silently block those paths as well, including the `esc` that is the way to interrupt a
  // runaway agent. This refusal belongs to the free-text send alone.
  //
  // The refusal carries the LIVE sentence, and it is the SAME reading the agent's `get_state` row
  // publishes as its `activity` (services/sparkleBusy) — so a caller cannot be told "idle" by the
  // roster and "busy" by the write in the same turn. That contradiction is not a cosmetic one: a
  // model reads a refusal that disagrees with the roster as a malfunctioning tool, and retries.
  if (isSparkleAgentId(agentId)) {
    const busy = sparkleBusyNow(Date.now());
    if (busy) {
      log.info("concierge", "tool send held — Improve Sparkle is mid-work", {
        agentId,
        kind: busy.kind,
      });
      return refuse("sparkle-busy", busy.detail);
    }
  }

  const r = await dispatchConciergeAnswer(agentId, text, {
    authority,
    userPrompt: opts.userPrompt ?? true,
    // Forwarded only when the caller supplied it. Spread rather than passed as `undefined` so a
    // plain free-text send carries no `pickerPress` key at all.
    ...(opts.pickerPress !== undefined ? { pickerPress: opts.pickerPress } : {}),
  });
  return {
    ok: r.ok,
    agentId: r.agentId,
    // THE HONEST HALF OF THE ACK (bead sparkle-1cu3j). From the dispatcher's own exhaustive
    // derivation, not re-decided here — a second copy of "which paths deliver" is exactly how the
    // two would come to disagree.
    submitted: wasSubmitted(r),
    path: r.path,
    // `display`, never `sent` — see ConciergeSendResult.display.
    ...(r.display !== undefined ? { display: r.display } : {}),
    ...(r.matchedLabel !== undefined ? { matchedLabel: r.matchedLabel } : {}),
    ...(r.options !== undefined ? { options: r.options } : {}),
    detail: sendDetail(r.path, agentId),
  };
}

// ---------------------------------------------------------------------------------------------
// The registration seam
// ---------------------------------------------------------------------------------------------

/**
 * A plain description of one tool. Deliberately structural and dependency-free: registering these
 * on the MCP surface is a separate integration step owned elsewhere, so this carries no schema
 * library, no handler binding, and nothing that presumes a particular tool protocol.
 *
 * A NOTE FOR WHOEVER WRITES THE ARGUMENT SCHEMAS. Because there is no schema here, the exported
 * option interfaces are the contract: `read_agent_terminal` takes exactly what
 * {@link ReadAgentTerminalOptions} declares, and a field absent from it is absent because exposing
 * it to a model would be unsafe, not because nobody got round to it. `transcriptPath` is the worked
 * example — it was removed precisely so a model could not name a file to read. Do not add fields
 * back at the schema layer that this module refuses to accept.
 *
 * The same goes for `send_to_agent_terminal`: its authority argument is not a tool argument at all.
 * It comes from `conciergeToolAuthority` on the app side, holding the policy decision for THIS call.
 * A schema that let the model supply one would forge the gate.
 */
export interface ConciergeToolDescriptor {
  name: string;
  description: string;
  /** True when invoking it can change the world. The policy layer keys its allow/ask tiers on this. */
  write: boolean;
}

/**
 * The terminal domain's tools, as descriptors only.
 *
 * The seam, and it stops here on purpose: this branch owns the module, not the wiring. Whoever
 * registers these binds them to `readAgentTerminal` / `sendToAgentTerminal` / `getAgentStatus` and
 * supplies the argument schema their protocol wants.
 */
// `as const satisfies` rather than a plain `: readonly ConciergeToolDescriptor[]` annotation: the
// annotation widens every `name` to `string`, which makes the list useless as a source of truth for
// the dispatch registry (services/conciergeTools/registry.ts derives `TerminalOp` from it, and a
// `string` union routes nothing and catches nothing). `satisfies` keeps the shape check this
// annotation was doing while preserving the literal names, so adding a descriptor here is a
// TYPECHECK FAILURE in the registry until it is routed.
/** The one sentence that names "Improve Sparkle" at the point of use.
 *
 *  IT USED TO SAY THE OPPOSITE, and updating it is not housekeeping — it is the same change. This
 *  note existed because the id was "the only agent address in the app that a caller cannot
 *  discover": app-owned, deliberately absent from `get_state`'s roster, while the concierge's whole
 *  model of "which agents exist" comes from that roster. `get_state` now LISTS the agent (bead
 *  sparkle-x0pvw, services/controlListener), so the sentence "it does NOT appear in get_state's
 *  roster" became false the moment that landed — and a false line in a tool description is worse
 *  than a missing one, because a model will act on it and skip the roster lookup that would now
 *  answer. The repo rule is explicit: a fix that changes behaviour must update every string that
 *  described the old behaviour.
 *
 *  What is left worth saying is the part that is still true and still not derivable from the roster
 *  row: the id is STABLE (so it can be written down rather than re-discovered each turn), and the
 *  agent is APP-OWNED, which is why the destructive lifecycle ops refuse it. Appended to all three
 *  descriptions because a caller may reach for any of them first, and the read ops are the ones it
 *  will reach for before it dares a write. */
const SPARKLE_AGENT_TOOL_NOTE =
  `Works for the built-in Improve Sparkle agent too, at the stable id \`${SPARKLE_AGENT_ID}\` — ` +
  "the app's own self-improvement agent. It appears in get_state's roster like any other agent " +
  "(marked `appOwned: true`), and these ops reach it exactly as they reach a build agent. Because " +
  "the app owns it, the destructive lifecycle ops (discard/close/ship/save) refuse it; restart and " +
  "stop do not. It runs an hourly improvement pass in a worktree its interactive pane shares, so a " +
  "send while that pass is running is refused with a reason rather than queued — its roster row's " +
  "`activity` says when it is mid-pass, so read that before writing.";

export const CONCIERGE_TERMINAL_TOOLS = [
  {
    name: "read_agent_terminal",
    description:
      "Read what an agent's terminal recently showed. Returns the text plus the SOURCE and FRESHNESS it came from (live screen, the screen captured when it last asked for you, searched history, or its transcript) — say which when it isn't live. Output is capped and reports what it dropped. " +
      SPARKLE_AGENT_TOOL_NOTE,
    write: false,
  },
  {
    name: "get_agent_status",
    description:
      "An agent's live status, whether it is stuck waiting on the human, and whether it can accept input right now. Check `observed` first: when it is false there was no live status to read, so `needsYou: false` means NOT OBSERVED rather than calm — relay `detail` instead of reporting the agent as fine. Also reports `goal` (its objective, that goal's state, time left and retry counters), `stall` (is a resting row FINISHED or STALLED, with the causes and a sentence), and `thrash` (is it looping on a command or out of context). Each of those three is ABSENT rather than empty when there is nothing to report, and absent means NOT OBSERVED, never healthy: no `goal` key means it has no goal, no `stall` key means there was no status to judge, and no `thrash` key means no hook events for it were seen here. Read-only. " +
      SPARKLE_AGENT_TOOL_NOTE,
    write: false,
  },
  {
    name: "read_picker_options",
    description:
      "Read the menu an agent is offering right now, as indexed options. Empty when there is no menu — a normal state, not an error. An empty read also says WHY in `blind`: `no-menu` (nothing on screen resolves to a menu — the agent is working, and this is the overwhelmingly common case), `pane-not-mounted` (this window cannot see that terminal at all), or `footer-without-options` (a dialog IS up and its options could not be read — relay that to the human, who can open the pane and answer it). `blind` is REPORTING, never permission: no value of it makes anything pressable. A PRESENT menu with an EMPTY `fingerprint` is different: the menu is there but its question could not be read, so it cannot be told apart from any other menu with the same options and is NOT answerable — relay it to the human rather than pressing anything. Read this BEFORE select_picker_option: that op requires you to echo back the `fingerprint` this returns, which covers the question AND the options — so a menu that re-rendered into a different ask is refused rather than answered.",
    write: false,
  },
  {
    name: "select_picker_option",
    description:
      "Press one of an agent's live menu options. Takes the index AND the `fingerprint` from read_picker_options, and refuses if the menu changed underneath — pressing a button the human never read is not something to guess at. An EMPTY fingerprint is refused as `unreadable-picker`: the question could not be read, so there is nothing to match against. Requires an authorized tool policy, like any other write to a terminal.",
    write: true,
  },
  {
    name: "send_control_key",
    description:
      "Press a key that is not text: esc to interrupt a runaway agent, shift+tab to cycle its permission modes, ctrl+b to background a long-running command, enter to submit what is already typed, or an arrow key. A NAMED set — no arbitrary escape sequences. Nothing is appended: these are keys, not lines. When a menu is VISIBLE to the app the picker-driving keys (enter, arrows) are refused — answer it with select_picker_option instead. VISIBLE means the LIVE screen when the app can read it; only when it cannot — an unmounted pane — does the screen captured at the agent's last ask count, and then only while that agent is still asking. That refusal is EVIDENCE-BASED, not a guarantee: an agent whose pane is closed and which is not currently asking has no menu evidence at all, so the keys go through. Never infer safety from it. Nor are the keys it does not refuse harmless while a dialog is up: esc DECLINES whatever is being asked, which can discard work in progress, and shift+tab changes the permission mode governing that very approval. Requires an authorized tool policy.",
    write: true,
  },
  {
    name: "quit_alternate_screen",
    description:
      "Get an agent OUT of a full-screen pager (less, more, man, git's pager) that it is wedged on. " +
      "This is the only way q ever reaches a terminal, and it is not a general keypress: it refuses " +
      "unless ALL FIVE of these hold — the terminal is genuinely on the alternate screen buffer (the " +
      "emulator's own mode bit, not a guess from the text), the screen is NOT Claude Code's own " +
      "interface, the screen offers NO choice to answer, it is not a plan-mode surface, and there is " +
      "POSITIVE evidence it is a pager (a less/more/man status row), with full-screen EDITORS " +
      "refused outright. That last gate is the load-bearing one, NOT the buffer bit: Claude Code " +
      "holds the alternate buffer at all times on a modern fleet, so the buffer bit does not exclude " +
      "a Claude Code pane — what excludes it is that an idle prompt carries no pager status row. In " +
      "an editor q is not a quit key but a character written into the file, which is why an editor " +
      "is refused even though it offers no choice to answer. Each refusal names WHICH of those it " +
      "was. It presses q, re-reads the screen, and only then escalates to ctrl+c if the terminal is " +
      "still full-screen and all five still hold. It re-reads again afterwards and tells " +
      "you whether the screen ACTUALLY cleared — vim quits on neither key, and it will say so rather " +
      "than claiming success. Requires an authorized tool policy.",
    write: true,
  },
  {
    name: "send_to_agent_terminal",
    description:
      "Type a message into an agent's terminal, as if the human had typed it. " +
      "State `goal` — an objectively verifiable completion criterion anyone can check — or " +
      "`notWork: { reason }` when the send assigns no work; a send stating neither is refused. " +
      "Requires an authorized tool policy. Refuses rather than guessing when the agent has a prompt on screen the message doesn't answer. " +
      "READ `submitted`, NOT `ok`, TO KNOW WHETHER THE MESSAGE ARRIVED: `ok` says the send was accepted and nothing is wrong, " +
      "while `submitted: false` says it has NOT been typed and entered yet. The one case is an agent whose terminal is still " +
      "coming up (`path: \"queued\"`) — the message is held and delivered when it is ready, so do NOT re-send it, and do not " +
      "report it to the human as delivered. " +
      SPARKLE_AGENT_TOOL_NOTE,
    write: true,
  },
] as const satisfies readonly ConciergeToolDescriptor[];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ANSWERING A PICKER
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// A menu on screen is the single most common state that blocks an agent, and until now the
// concierge could SEE one and do nothing about it: `send_to_agent_terminal` correctly refuses an
// ambiguous send (`ambiguous-picker`) and even returns the live options, but there was no op to read
// them deliberately and no op to answer one.
//
// SELECTION PRESSES A BUTTON THE HUMAN NEVER READ, which is why this is two ops and not one, and
// why the second one is defensive. The addressed-at-picker incident (AGENTS.md, bead sparkle-8bvh)
// is the precedent: a control surface that answers a menu on the model's inference put an answer
// somewhere nobody intended. So:
//
//   • the caller must have READ the options (`read_picker_options`) and echo back the `fingerprint`
//     it returned. An index alone is not enough — the menu is live, and an option list that
//     re-renders between the read and the press would make the same index a different answer. Nor is
//     a LABEL enough: numbered menus reuse labels, and a yes/no dialog's Approve/Deny pair is a
//     global constant, so the fingerprint covers the QUESTION as well as the options.
//   • `select_picker_option` re-reads the menu and refuses unless that fingerprint still matches.
//     A changed menu is a refusal, never a best guess.
//   • the press goes through the SAME authority-gated write as any other send, so a picked option is
//     attributable to a toolCallId exactly like typed text.

// THE READ LIVES IN `services/pickerRead` — a leaf whose only imports are the three it genuinely
// needs. Same reasoning as the transcript registry above: keeping the reader next to the writes it
// guards reads well, but it forced every caller of the READ to import this whole domain module, and
// with it `SNAPSHOT_MAX_LINES` at module scope. `suggestions/conciergeHandoff` needs the read to
// re-validate a notice at delivery, and reaching for it here killed three `useSuggestions` suites at
// COLLECTION and tripped the composer/improvement-pass latch in one move. The split falls on the
// line that latch already draws: the READ is a pure query and may be reached from anywhere, the
// WRITES below stay behind the boundary. Re-exported so this module's public surface is unchanged.
//
// ONLY THE NAME THAT HAS AN IMPORTER HERE, exactly as the transcript-registry re-export above says.
// `PickerOptionView` and `PickerOptionsRead` came along in the first pass and `dormant-exports`
// reds on them: a type re-export with no in-file use has no production importer, so re-exporting
// it is a promise to a module that does not exist. `registry.ts` imports `readPickerOptions` from
// here; every consumer of the TYPES reaches the leaf directly.
export { readPickerOptions } from "../pickerRead";

export interface SelectPickerResult {
  ok: boolean;
  agentId: string;
  /** The label actually pressed, on success. */
  label?: string;
  /** Why it was refused, machine-readable. */
  reason?: "no-picker" | "out-of-range" | "changed" | "unreadable-picker" | ConciergeSendPath;
  detail?: string;
}

/**
 * Press one of the agent's live options.
 *
 * `expectFingerprint` is REQUIRED and is the whole safety property: it is the caller stating WHICH
 * MENU it read. If the agent moved on between the read and this call, the fingerprint no longer
 * matches and we refuse — rather than pressing whatever now happens to sit at that index. It
 * identifies the menu rather than the option precisely because a numbered menu's labels ("1", "2")
 * are identical across completely different questions.
 */
export async function selectPickerOption(
  agentId: string,
  index: number,
  expectFingerprint: string,
  authority: ConciergeToolAuthority,
): Promise<SelectPickerResult> {
  const live = liveOptionsFor(agentId);
  if (live.length === 0) {
    return {
      ok: false,
      agentId,
      reason: "no-picker",
      detail: "That agent doesn't have a menu on screen right now, so there's nothing to answer.",
    };
  }
  if (!Number.isInteger(index) || index < 0 || index >= live.length) {
    return {
      ok: false,
      agentId,
      reason: "out-of-range",
      detail: `There are ${live.length} options (0–${live.length - 1}); ${index} isn't one of them.`,
    };
  }
  const now = pickerFingerprint(agentId, live);
  // CANNOT FINGERPRINT. The detector found options but this could not locate the dialog they came
  // from, so there is no material that distinguishes THIS ask from any other with the same option
  // shape — and both shapes that reach here have a constant one. Comparing "" to "" would let a
  // caller answer any such dialog with a fingerprint read from a different one, which is the
  // collision the fingerprint exists to prevent. Refuse instead (roborev 55182).
  if (now === "" || expectFingerprint === "") {
    return {
      ok: false,
      agentId,
      reason: "unreadable-picker",
      detail:
        "That agent has a menu up, but I can't read the question it's attached to — so I can't " +
        "tell this prompt apart from any other with the same options, and I won't press a button " +
        "on a guess. Its terminal pane may not be mounted; open it and read the prompt directly.",
    };
  }
  if (now !== expectFingerprint) {
    return {
      ok: false,
      agentId,
      reason: "changed",
      detail:
        "The menu changed since you read it, so I didn't press anything. Read the options again " +
        "and decide against the current list.",
    };
  }
  const chosen = live[index]!;
  // The option's own `value` is the exact string the human's click would inject, so this presses the
  // button the same way the UI does — through the ordinary authority-gated send, not a second path.
  //
  // `pickerPress` carries `now` — the fingerprint THIS function just derived from the live screen and
  // matched against the caller's — down to the dispatcher, which re-derives it once more and compares
  // again before waiving the alternate-screen refusal (bead sparkle-jk8zt). Without it every press
  // was refused: Claude Code's permission dialog replaces the composer box `isClaudeCodeScreen`
  // requires, so an approval prompt reads as a full-screen app to the write path even while
  // `read_picker_options` reads the menu off it cleanly.
  //
  // NOT A SHORTCUT PAST THE SEND. It is still the same authority-gated call, still subject to every
  // other guard the dispatcher runs — the exemption is scoped to the one refusal that was wrong here.
  const sent = await sendToAgentTerminal(agentId, chosen.value, authority, {
    pickerPress: { fingerprint: now },
  });
  return sent.ok
    ? { ok: true, agentId, label: chosen.label }
    : { ok: false, agentId, reason: sent.path, detail: sent.detail };
}


// ─────────────────────────────────────────────────────────────────────────────────────────────
// CONTROL KEYS
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Some things a human does to an agent are not text. Interrupting a runaway command is `esc`;
// cycling permission modes is `shift+tab`; backgrounding a long-running one is `ctrl+b`. Without
// these the concierge could only ever ADD to what an agent is doing, never steer or stop it — so
// "it's stuck in a loop, make it stop" was something it had to ask the human to do by hand.
//
// A NAMED SET, NOT ARBITRARY BYTES. The op takes a key NAME and this module owns the mapping. A
// `send_control_bytes(agentId, "\x1b[200~…")` would be strictly more powerful and strictly worse:
// arbitrary escape sequences can rewrite the terminal's state, spoof a bracketed paste around
// somebody else's text, or issue a mode change nothing here reasons about. The point of this tool
// is the handful of things a human's keyboard actually does.
//
// NO CARRIAGE RETURN IS EVER APPENDED. These are keys, not lines. `enter` exists as its own key for
// the case where the caller genuinely wants to submit what is already on the input line — a
// different act from typing text, and one that stays visible as its own entry in the audit log.

/** The keys a human's keyboard sends that are not text. */
export const CONTROL_KEYS = {
  /** Interrupt / dismiss. The one that stops a runaway agent. */
  esc: "\x1b",
  /** Submit whatever is already on the input line. */
  enter: "\r",
  /** Claude Code cycles permission modes on shift+tab (CSI Z — "back-tab"). */
  "shift+tab": "\x1b[Z",
  /** Background the running foreground job. */
  "ctrl+b": "\x02",
  /** History / menu movement. */
  up: "\x1b[A",
  down: "\x1b[B",
  left: "\x1b[D",
  right: "\x1b[C",
} as const;

export type ControlKeyName = keyof typeof CONTROL_KEYS;

/** The keys that DRIVE a picker: `enter` commits the highlighted option, the arrows move which one
 *  that is. Refused while a menu is live, so `select_picker_option`'s fingerprint guard cannot be
 *  walked around by pressing keys instead (roborev 55165). `esc`/`ctrl+b` are deliberately absent:
 *  they decline rather than answer, and declining is the thing this tool is most useful for. */
const PICKER_DRIVING_KEYS = new Set<ControlKeyName>(["enter", "up", "down", "left", "right"]);

/**
 * Might this agent have a menu up? FAILS CLOSED when blind — but only when it is actually blind.
 *
 * TIER (a) IS EXCLUSIVE WHEN IT IS READABLE. `liveOptionsFor` reads the live xterm buffer, which is
 * the present tense; `attentionScreen` is a SNAPSHOT taken when the agent crossed into
 * waiting/approval. It is now BOUNDED — `captureFor` applies both expiries (sparkle-99o9a) — but
 * bounded is not live, and the `isRedStatus` gate below STAYS: two safety properties, held in two
 * places on purpose. A capture can still describe an ask this agent answered and re-entered within
 * one red span, and neither expiry can see an agent that is unhosted AND absent from the digest.
 *
 * Consulting the snapshot while the live screen is readable and definitively clean
 * would refuse `enter` and the arrows FOREVER for any agent that has ever hit a picker — and
 * `select_picker_option` refuses there too (`no-picker`), so the refusal's own remedy is a dead end
 * and the concierge has no route at all. That is a deadlock, not a guard (roborev 55170). It also
 * inverts the tier ordering the read chain follows, where (b) is strictly a fallback for an
 * unreadable (a).
 *
 * WHEN IT IS BLIND — an unmounted pane, the norm on a real fleet by this module's own header — the
 * capture is the only evidence there is, and gating on it is what stops the raw keystroke sailing
 * through on exactly the agents the concierge exists to drive unattended (roborev 55168). But a
 * stale capture says nothing about NOW, so it counts only while the agent is still in a red status,
 * i.e. still asking.
 */
function mayHaveMenu(agentId: string): boolean {
  if (getAgentScrollback(agentId) !== null) return liveOptionsFor(agentId).length > 0;
  if (!isRedStatus(useRuntimeStore.getState().status[agentId])) return false;
  const captured = captureFor(agentId);
  return hasText(captured) && detectTerminalPrompts(captured.text).length > 0;
}

/** The names, for the wire enum and for a caller listing what it may press. */
export const CONTROL_KEY_NAMES = Object.keys(CONTROL_KEYS) as ControlKeyName[];

export interface ControlKeyResult {
  ok: boolean;
  agentId: string;
  key?: ControlKeyName;
  /** The dispatch vocabulary, plus one of this op's own: `send-failed` covers a write that failed
   *  for a reason that is NOT a dead PTY. Kept out of `ConciergeDispatchPath` because that union
   *  describes what the dispatcher did, and this never reaches it. */
  reason?: ConciergeSendPath | "send-failed";
  detail?: string;
}

/**
 * Press one control key in an agent's terminal.
 *
 * Rides the SAME gates as a text send — authority, then `agentCanAcceptInput` — because it is the
 * same kind of act: it changes what a running process does next and cannot be un-pressed. `esc` in
 * particular is the most consequential thing on this list; it can discard work in progress.
 *
 * Writes RAW, via `writePtyChainedStrict`: a control key is bytes, not a prompt, so it must not get
 * the bracketed-paste + carriage-return framing `submitPrompt` applies. Chained on the same
 * per-agent queue as every other write, so a key can never land between another write's paste and
 * its return and be swallowed by it.
 */
export async function sendControlKey(
  agentId: string,
  key: ControlKeyName,
  authority: ConciergeToolAuthority,
): Promise<ControlKeyResult> {
  if (!isDispatchAuthority(authority) || authority.kind !== "concierge-tool") {
    log.warn("concierge", "control key refused — no valid authority", { agentId, key });
    return {
      ok: false,
      agentId,
      reason: "unauthorized",
      detail: sendDetail("unauthorized", agentId),
    };
  }
  if (!agentCanAcceptInput(agentId)) {
    const path: ConciergeSendPath =
      findAgent(agentId) === undefined ? "unknown-agent" : "cloud-agent";
    return { ok: false, agentId, reason: path, detail: sendDetail(path, agentId) };
  }
  // A LIVE MENU CLOSES THIS ROUTE TO THE PICKER-DRIVING KEYS.
  //
  // Without this, `send_control_key` is an unguarded way to do the exact act `select_picker_option`
  // refuses to do blind (roborev 55165). `enter` presses the HIGHLIGHTED option of whatever dialog
  // is on screen — nothing read, no fingerprint, no index — and the arrows move that highlight, so
  // down-then-enter reaches any option at all. Both ops sit in the same `disruptive` tier, so the
  // policy layer cannot tell them apart either: the guard was simply missing on one route.
  //
  // `esc` and `ctrl+b` stay allowed, and that asymmetry is the point. They DECLINE or step back —
  // "stop what you're doing" is the single most valuable thing this tool does, and it is the one
  // act that is safe precisely because it commits to nothing.
  if (PICKER_DRIVING_KEYS.has(key) && mayHaveMenu(agentId)) {
    return {
      ok: false,
      agentId,
      reason: "ambiguous-picker",
      detail:
        `That agent has a menu on screen, so "${key}" would answer it without either of us having ` +
        `read it. Use read_picker_options and then select_picker_option, which names the option and ` +
        `refuses if the menu moved. esc is NOT a safe way out of this: it DECLINES whatever is being ` +
        `asked, which on an unread dialog can discard work in progress or deny a call the human ` +
        `wanted. Send it only when interrupting is what you mean to do.`,
    };
  }
  try {
    await writePtyChainedStrict(agentId, CONTROL_KEYS[key]);
    return { ok: true, agentId, key };
  } catch (e) {
    log.warn("concierge", "control key write failed", { agentId, key, error: String(e) });
    // NARROW, deliberately. `writePtyChainedStrict` converts only a dead PTY into `PtyGoneError`;
    // pty.ts says any other error propagates unchanged, and conciergeDispatch is the precedent that
    // checks the type rather than assuming it. `pty-gone`'s copy is a factual claim — "the agent's
    // terminal has closed" — and under this repo's rule that a remedy is an instruction the user
    // will follow, telling them that after a transient IPC failure invites them to close or discard
    // an agent that is alive and fine (roborev 55165).
    if (e instanceof PtyGoneError) {
      return { ok: false, agentId, reason: "pty-gone", detail: sendDetail("pty-gone", agentId) };
    }
    return {
      ok: false,
      agentId,
      reason: "send-failed",
      detail: `I couldn't press ${key} in that agent's terminal: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// QUITTING AN ALTERNATE SCREEN (bead sparkle-w11lll)
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// THE INCIDENT. Two agents were found WEDGED on an alternate screen with no automated way out.
// While one sits there, EVERY automated route is shut:
//
//   • `dispatchConciergeAnswer` refuses every write with path `alternate-screen` — correctly, since
//     typed text in a pager runs as commands.
//   • the goal auto-resume (`goalContinuationRunner`) takes the same refusal and BURNS its retry
//     budget doing so, until `MAX_UNDELIVERED_CONTINUES` escalates a human out of bed.
//   • the one key that quits a pager is `q`, and `sendControlKey` cannot send it: its vocabulary is
//     exactly esc/enter/shift+tab/ctrl+b/arrows, and widening that enum is NOT the fix. A freely
//     pressable `q` is a keystroke the concierge could put into a Claude Code permission prompt.
//
// So this is a NARROW, GATED op rather than a new key. The gate IS the safety boundary; the byte it
// writes is incidental.
//
// ══ THE DIAGNOSIS IS UNSETTLED, AND THAT DRIVES THE GATE ══════════════════════════════════════
// Both wedged screens showed a scrolling viewport on `<app data>/accounts/<hash>/plans/*.md`. No
// pager is invoked anywhere in this repo, and that path is `$CLAUDE_CONFIG_DIR/plans/` — written by
// CLAUDE CODE ITSELF in plan mode, into the account dir Sparkle hands it. Two live hypotheses:
//
//   H1 — a genuine pager (`less`) really was open on that file.
//   H2 — it was CLAUDE CODE'S OWN PLAN-MODE / ExitPlanMode surface, and `isClaudeCodeScreen` FAILED
//        TO RECOGNISE IT (a false negative) — which is why the write was refused at all.
//
// This op must be safe under BOTH. An escape hatch gated only on `!isClaudeCodeScreen` would, under
// H2, press `q` INTO A CLAUDE CODE PLAN DIALOG. That is the regression we must not ship, so the gate
// below deliberately does not depend on `isClaudeCodeScreen` being right.
//
// ══ WHY THIS CANNOT FIRE ON A REAL CLAUDE CODE DIALOG — the argument, gate by gate ════════════
//
//   1. BUFFER MODE, NOT CONTENT. `alternateBuffer` is the emulator's own mode bit
//      (`term.buffer.active.type !== "normal"`, components/Terminal), never a heuristic over text.
//
//      READ THE NEXT SENTENCE BEFORE RELYING ON THIS GATE (roborev 68360, High). An earlier version
//      of this comment claimed gate 1 "alone excludes every real Claude Code dialog, before a single
//      byte is written", on the reasoning that Claude Code renders its prompt and dialogs on the
//      NORMAL buffer. THAT IS FALSE ON A MODERN FLEET, and this file's own neighbour says so:
//      `conciergeDispatch.ts` records, measured on v2.1.237 at a bare idle prompt, a fleet where
//      "Claude Code holds the alternate buffer at all times". So gate 1 is TRUE for ordinary Claude
//      Code panes and excludes nothing by itself.
//
//      That wrong claim was worse than no claim, because it presented the cheapest gate as
//      sufficient — which is exactly how a later reader deletes gate 5 as redundant. Gate 1 is a
//      NECESSARY precondition ("there is some full-screen thing to quit"), never a sufficient one.
//      What actually keeps `q` out of a Claude Code pane is gate 5's POSITIVE pager evidence: an
//      idle Claude Code prompt has no `(END)`, no `--More--`, no `lines n/m` status row, so it is
//      refused as `not-a-pager` no matter what gates 1-4 concluded.
//   2. THE PREDICATE THE DISPATCHER ALREADY TRUSTS. `isClaudeCodeScreen` is exactly what
//      `conciergeDispatch` uses to decide Claude Code owns the buffer, and its job is telling a live
//      TUI from a document QUOTING one — `nothingUnrecognizedBelowFooter`: a pager draws its own
//      status row beneath the footer, a live dialog does not. Paired here with
//      `hasClaudeCodeLiveTui`, which is the same evidence WITHOUT the `>= 2` corroboration bar —
//      i.e. precisely the arm that stays TRUE in the H2 false-negative case, because H2 is a screen
//      that carries the composer box or the live dialog and fails only the corroboration count.
//   3. THE GATE THAT SURVIVES GATE 2 BEING WRONG. A permission prompt, a plan-approval dialog and a
//      picker all OFFER A CHOICE; a pager offers none. `screenOffersAnswer` is measured true on
//      every captured Claude Code dialog in `capturedScreens.fixture.ts` and false on the captured
//      `vim` and `less` screens. So even a TOTAL false negative in `isClaudeCodeScreen` cannot get
//      `q` into a dialog.
//   4. THE SURFACE WE HAVE LIVE EVIDENCE OF, named explicitly. `isPlanExitDialog` covers today's
//      plan-exit prompt (and the renamed shapes it anticipates); `isPlanModeDialog` covers the older
//      "No, keep planning" triple. Reusing those predicates rather than writing a fifth regex is the
//      point — a private copy would drift away from the ones the router and the answerer use.
//
//   INVARIANT, stated here and TESTED in terminal.test.ts: the set of screens where this op may
//   write is a strict SUBSET of the set where `dispatchConciergeAnswer` already refuses all text
//   with `alternate-screen`. It can never write where a text write is permitted. Gates 1 and 2 are
//   the dispatcher's own two conditions; gates 3 and 4 only narrow further.
//
// ══ AND IT NEVER CLAIMS SUCCESS IT DID NOT OBSERVE ════════════════════════════════════════════
// `q` quits `less`. It does NOT quit `vim`, and neither does ctrl+c. So the op RE-READS the viewport
// after each write and reports what it actually found. A truthful "still in full-screen mode after
// both keys" is the useful answer there; looping or claiming success is not.

// ══ GATE 5 EXISTS BECAUSE THE OTHER FOUR ARE ALL NEGATIVE (roborev 68359, High) ═══════════════
//
// Gates 1-4 establish "not Claude Code, not answerable, not a plan surface". NONE of them
// establishes that the alternate screen is a PAGER — and the first version of this op shipped with
// exactly that hole. Every other full-screen program passes all four of them, and the dangerous
// family is FULL-SCREEN EDITORS, where `q` is not a quit key at all but A CHARACTER INSERTED INTO
// THE FILE.
//
// The concrete failure, and it is live in this repo: an agent runs `git commit` or `roborev comment`
// with no `-m`, `$EDITOR` opens `nano` (or vim already in insert mode) on the alternate buffer.
// `isClaudeCodeScreen` is false, `screenOffersAnswer` is false — nano's `^X Exit` footer is neither
// a picker block nor a `(y/n)` prompt — and it is no plan surface. So the op pressed `q`, which nano
// INSERTED INTO THE COMMIT MESSAGE, then escalated to ctrl+c. It then reported `still-alternate`,
// which reads to the caller as a harmless no-op, while the agent's file had silently gained a `q`.
//
// So the gate is POSITIVE: prove it is a pager before writing, and REFUSE when the evidence is
// absent. That direction is the safe one — a false refusal costs a human pressing `q` in a pane,
// a false accept corrupts a file nobody is watching. It also strictly SHRINKS the write set, so the
// subset invariant against `dispatchConciergeAnswer` still holds a fortiori.

/** The status row a pager leaves on the last line. Anchored to that ROW, the way `hasLiveDialog`
 *  anchors to the grid terminator, because these tokens are unremarkable in body text and only mean
 *  "pager" in the position a pager puts them. */
const PAGER_STATUS_ROW: RegExp[] = [
  /^\(END\)$/,                       // less, at EOF
  /^:$/,                             // less's own prompt, waiting for a command
  /^--More--(\(\d+%\))?$/,           // more(1)
  /\blines?\s+\d+([-–]\d+)?\/\d+/, // less -M: "lines 1-40/1061"
  /\bbyte\s+\d+/,                   // less -M: "byte 1234"
  /^\S.*\s\d{1,3}%$/,                // a trailing percentage — less's default -m ruler
  /\(press h for help or q to quit\)/, // man(1)
  /^Manual page\b.*\bline\s+\d+/,   // man(1), long form
];

/** Full-screen EDITOR chrome. A denylist beside the allowlist above, and deliberately redundant:
 *  the allowlist's weakest arm is the bare filename `less` prints when it has not been scrolled, and
 *  a bare filename is exactly what an editor's ruler starts with too. This is what separates them.
 *
 *  Measured on the captured fixtures, which differ ONLY in their last row:
 *      less →  `AGENTS.md`
 *      vim  →  `"AGENTS.md" 1061L, 78092B`
 *  so the quoted-name-plus-size ruler is the discriminator, not the filename. */
const EDITOR_CHROME: RegExp[] = [
  /"[^"]+"\s+\d+L,\s*\d+B/,          // vim's opening ruler
  /^\s*--\s*(INSERT|VISUAL|REPLACE)\b/im, // vim modes — where `q` is literally typed into the file
  /\^[GOXKWV]\s+(Get Help|WriteOut|Write Out|Exit|Cut|Where Is)/, // nano / pico footer
  /^-[-U*:]{2,}.*\s\(.*\)\s*$/m,      // emacs mode line, e.g. `-UUU:----F1  file  (Text)`
  /\bNORMAL\b.*\b\d+:\d+\b/,        // helix / kakoune style mode + cursor ruler
];

/** The last non-empty row of the screen — where every pager puts its status line. */
function lastNonEmptyRow(text: string): string {
  const rows = text.split("\n");
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!.trim();
    if (row) return row;
  }
  return "";
}

/** Is there POSITIVE evidence this alternate screen is a pager?
 *
 *  Two conditions, and the denylist is checked over the WHOLE screen rather than just the status
 *  row: vim's `-- INSERT --` sits on the last row, but its opening ruler can be scrolled off while
 *  the buffer is still an editor, and emacs' mode line is not the final row when the minibuffer is
 *  in use. Refusing on editor chrome ANYWHERE is the conservative reading, and conservative is the
 *  correct direction for a gate whose false-accept corrupts a file. */
export function looksLikePager(text: string): boolean {
  if (EDITOR_CHROME.some((re) => re.test(text))) return false;
  const status = lastNonEmptyRow(text);
  if (!status) return false;
  if (PAGER_STATUS_ROW.some((re) => re.test(status))) return true;
  // The weak arm, reachable only because the editor denylist above already ran: `less` opened on a
  // file and not yet scrolled prints the BARE FILENAME and nothing else. One token, no spaces, and
  // a file-ish shape — anything wordier is prose, not a status row.
  return /^[\w.@+-]+(\/[\w.@+-]+)*$/.test(status) && /[./]/.test(status) && status.length <= 120;
}

/** The keys this op may press, in the order it presses them. NOT added to `CONTROL_KEYS`: the whole
 *  safety argument above is that `q` is reachable ONLY through this gate. A `q` in the freely
 *  pressable enum could land in a permission prompt, which is the thing we are protecting. */
const QUIT_KEYS = {
  /** `q` — how every common pager (`less`, `more`, `man`, `git log`'s pager) exits. */
  q: "\x71",
  /** The fallback. Interrupts a foreground program that ignored `q`. */
  "ctrl+c": "\x03",
} as const;

export type QuitKeyName = keyof typeof QUIT_KEYS;

/** How long to wait for the emulator to repaint after a key before re-reading the buffer bit.
 *
 *  BOUNDED AND SMALL, deliberately. A pager clears the alternate buffer within one frame; anything
 *  that needs longer than this is not going to be rescued by waiting, and the whole op has to stay
 *  well inside a concierge turn. Two settles + two reads is the entire budget. */
const QUIT_SETTLE_MS = 150;

/** Which gate refused, in this op's own vocabulary. Every value names ONE gate, so a caller (and a
 *  human reading a receipt) can tell "there is nothing to quit" from "I refused to press into a
 *  dialog" — two very different facts that a single `refused` would collapse. */
export type QuitAlternateScreenRefusal =
  /** Gate 0 — this window cannot see that terminal at all. Blind is a REFUSAL, never an empty
   *  screen: `getAgentViewport`'s own doc says so, and a write decided on no evidence is the shape
   *  this whole module exists to avoid. */
  | "pane-not-mounted"
  /** Gate 1 — the terminal is on the normal buffer. There is no alternate screen to quit. */
  | "normal-buffer"
  /** Gate 2 — Claude Code owns this buffer (or shows live-TUI evidence that it does). */
  | "claude-code-screen"
  /** Gate 3 — the screen presents an answerable choice. A pager offers none. */
  | "offers-an-answer"
  /** Gate 4 — a plan-mode / plan-exit surface, the one we have live evidence of. */
  | "plan-mode-surface"
  /** Gate 5 — nothing positively identifies this as a pager, and `q` is a destructive keystroke in
   *  an editor. Refusing without pager evidence is the safe direction (roborev 68359). */
  | "not-a-pager"
  /** Not a gate: both keys went out and the terminal is STILL on the alternate buffer. Something
   *  like `vim` quits on neither. Reported honestly rather than retried. */
  | "still-alternate";

export interface QuitAlternateScreenResult {
  /** True ONLY when the alternate screen was observed to clear. Never inferred from a successful
   *  write — a write that lands and changes nothing is exactly the `vim` case. */
  ok: boolean;
  agentId: string;
  /** What was actually written, in order. Empty on every refusal. */
  sent: QuitKeyName[];
  /** Did the alternate buffer clear? `null` means COULD NOT TELL — the pane stopped being readable
   *  mid-op — and is never reported as either outcome. */
  cleared: boolean | null;
  reason?: ConciergeSendPath | "send-failed" | QuitAlternateScreenRefusal;
  detail: string;
}

/** The five gates, over ONE viewport snapshot.
 *
 *  ONE SNAPSHOT IS THE CONTRACT. `TerminalViewport` exists precisely so `text` and `alternateBuffer`
 *  describe the same instant; re-reading between checks could straddle a `less` launch and mix a
 *  normal-buffer prompt's text with an alternate-buffer bit. The caller reads once and passes the
 *  snapshot in, and the escalation step re-runs this whole function against a NEW single snapshot
 *  rather than reusing any part of the old one.
 *
 *  Returns null when every gate passes. */
function quitGateRefusal(
  screen: TerminalViewport | null,
): { reason: QuitAlternateScreenRefusal; detail: string } | null {
  // GATE 0 — blind.
  if (!screen) {
    return {
      reason: "pane-not-mounted",
      detail:
        "Not pressed: this window can't see that agent's terminal, so I can't tell what pressing q " +
        "would land in. That has to be done in the agent's own pane.",
    };
  }
  // GATE 1 — the emulator's buffer-mode bit. NECESSARY, NOT SUFFICIENT, and the difference is the
  // whole point (roborev 68360/68368): Claude Code HOLDS the alternate buffer at all times on a
  // modern fleet — conciergeDispatch.ts records it, measured on v2.1.237 at a bare idle prompt — so
  // this gate is TRUE for ordinary Claude Code panes and excludes none of them. All it establishes
  // is that there is some full-screen thing to quit. GATE 5 is what keeps `q` out of a Claude Code
  // pane. An earlier version of this very comment claimed the opposite; do not restore it.
  if (!screen.alternateBuffer) {
    return {
      reason: "normal-buffer",
      detail:
        "Not pressed: that terminal isn't in full-screen mode, so there is no pager to quit. A q " +
        "there would just be typed into whatever is on the line.",
    };
  }
  // GATE 2 — the dispatcher's own predicate, PLUS the un-corroborated form that survives H2.
  if (isClaudeCodeScreen(screen.text) || hasClaudeCodeLiveTui(screen.text)) {
    return {
      reason: "claude-code-screen",
      detail:
        "Not pressed: that screen is Claude Code's own interface, not a pager. Pressing q there " +
        "would go to Claude Code as a keystroke.",
    };
  }
  // GATE 3 — THE ONE THAT HOLDS WHEN GATE 2 IS WRONG. Anything offering a choice is something to be
  // answered, not something to be quit.
  if (screenOffersAnswer(screen.text)) {
    return {
      reason: "offers-an-answer",
      detail:
        "Not pressed: that screen is offering a choice, so it is a dialog to answer rather than a " +
        "pager to quit. Read it with read_picker_options, or leave it for the human.",
    };
  }
  // GATE 4 — the plan surfaces, by the predicates the router and the answerer already use.
  const planOptions = parsePickerOptions(screen.text).map((o) => ({ index: o.n, label: o.label }));
  if (isPlanExitDialog(screen.text) || isPlanModeDialog(planOptions)) {
    return {
      reason: "plan-mode-surface",
      detail:
        "Not pressed: that is Claude Code's plan surface. Whether a plan runs is the human's " +
        "decision, and q is not how it is made.",
    };
  }
  // GATE 5 — POSITIVE PAGER EVIDENCE. Read the section above before relaxing this: gates 1-4 only
  // ever prove what the screen ISN'T, and a full-screen editor satisfies all of them while turning
  // `q` into a character written to the user's file.
  if (!looksLikePager(screen.text)) {
    return {
      reason: "not-a-pager",
      detail:
        "Not pressed: that is a full-screen program but nothing about it says pager — no status " +
        "row, or it looks like an editor. In an editor q is typed INTO the file, so I won't guess. " +
        "It needs a human in that pane.",
    };
  }
  return null;
}

/** Wait for the emulator to repaint. Bounded by {@link QUIT_SETTLE_MS} and nothing else — no
 *  polling loop, no retry ladder. AGENTS.md: bound every wait so a wrong assumption fails in
 *  seconds instead of hanging. */
const settle = () => new Promise<void>((r) => setTimeout(r, QUIT_SETTLE_MS));

/**
 * Get an agent out of a full-screen pager it is wedged on — the ONLY route by which `q` reaches a
 * terminal. Read the module section above before changing anything here: the five gates are the
 * safety argument, not an optimisation.
 *
 * Rides the SAME authority and `agentCanAcceptInput` gates as `sendControlKey`, and writes through
 * the SAME `writePtyChainedStrict` queue, for the same reasons: this changes what a running process
 * does next, it cannot be un-pressed, and a key must never land between another write's paste and
 * its carriage return.
 */
export async function quitAlternateScreen(
  agentId: string,
  authority: ConciergeToolAuthority,
): Promise<QuitAlternateScreenResult> {
  const no = (
    reason: QuitAlternateScreenResult["reason"],
    detail: string,
    sent: QuitKeyName[] = [],
    cleared: boolean | null = null,
  ): QuitAlternateScreenResult => ({ ok: false, agentId, sent, cleared, reason, detail });

  if (!isDispatchAuthority(authority) || authority.kind !== "concierge-tool") {
    log.warn("concierge", "quit-alternate-screen refused — no valid authority", { agentId });
    return no("unauthorized", sendDetail("unauthorized", agentId));
  }
  if (!agentCanAcceptInput(agentId)) {
    const path: ConciergeSendPath =
      findAgent(agentId) === undefined ? "unknown-agent" : "cloud-agent";
    return no(path, sendDetail(path, agentId));
  }

  const first = quitGateRefusal(getAgentViewport(agentId));
  if (first) return no(first.reason, first.detail);

  const sent: QuitKeyName[] = [];
  /** One write, with the SAME narrow error handling `sendControlKey` uses: only a real
   *  `PtyGoneError` may claim the terminal closed, because that sentence is an instruction a human
   *  acts on and a transient IPC failure must not send them to discard a live agent. */
  const press = async (key: QuitKeyName): Promise<QuitAlternateScreenResult | null> => {
    try {
      await writePtyChainedStrict(agentId, QUIT_KEYS[key]);
      sent.push(key);
      return null;
    } catch (e) {
      log.warn("concierge", "quit-alternate-screen write failed", { agentId, key, error: String(e) });
      if (e instanceof PtyGoneError) return no("pty-gone", sendDetail("pty-gone", agentId), sent);
      return no(
        "send-failed",
        `I couldn't press ${key} in that agent's terminal: ${e instanceof Error ? e.message : String(e)}`,
        sent,
      );
    }
  };

  const qFailed = await press("q");
  if (qFailed) return qFailed;

  await settle();

  // RE-READ, AND RE-GATE. Not just "is it still alternate": the screen may have CHANGED into
  // something this op must not press into — a pager that exited straight back into a Claude Code
  // dialog, say. Escalating on a stale verdict would be exactly the H2 mistake one step later, so
  // the second key has to clear all five gates against a FRESH single snapshot of its own.
  const afterQ = getAgentViewport(agentId);
  if (!afterQ) {
    return no(
      "pane-not-mounted",
      "I pressed q, then lost sight of that terminal before I could check whether it worked. I " +
        "can't say either way.",
      sent,
    );
  }
  if (!afterQ.alternateBuffer) {
    return {
      ok: true,
      agentId,
      sent,
      cleared: true,
      detail: "Pressed q; that terminal is out of full-screen mode and back at a normal prompt.",
    };
  }
  const second = quitGateRefusal(afterQ);
  if (second) {
    return no(
      second.reason,
      `I pressed q and it stayed in full-screen mode. I stopped there rather than escalating to ` +
        `ctrl+c: ${second.detail.replace(/^Not pressed: /, "")}`,
      sent,
    );
  }

  const ctrlCFailed = await press("ctrl+c");
  if (ctrlCFailed) return ctrlCFailed;

  await settle();

  const afterCtrlC = getAgentViewport(agentId);
  if (!afterCtrlC) {
    return no(
      "pane-not-mounted",
      "I pressed q and then ctrl+c, then lost sight of that terminal before I could check whether " +
        "it worked. I can't say either way.",
      sent,
    );
  }
  if (!afterCtrlC.alternateBuffer) {
    return {
      ok: true,
      agentId,
      sent,
      cleared: true,
      detail:
        "q didn't take, so I pressed ctrl+c; that terminal is out of full-screen mode now.",
    };
  }
  // THE HONEST DEAD END. `vim` quits on neither key, and no amount of repeating them changes that.
  return no(
    "still-alternate",
    "I pressed q and then ctrl+c and that terminal is STILL in full-screen mode — something like " +
      "vim quits on neither. It needs a human in that pane.",
    sent,
    false,
  );
}
