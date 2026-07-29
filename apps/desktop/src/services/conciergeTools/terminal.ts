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
//                          usually the exact text of the ask; it is a SNAPSHOT, not the present.
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
  type ConciergeDispatchPath,
} from "../conciergeDispatch";
import { isDispatchAuthority, type ConciergeToolAuthority } from "../dispatchAuthority";
import { PtyGoneError, writePtyChainedStrict } from "../../pty";
import { searchHistory } from "../history";
import { SNAPSHOT_MAX_LINES, getAgentScrollback } from "../terminalScrollback";
import { isRedStatus } from "../windowStatus";
import { isObserved, type AgentLiveness } from "../agentLiveness";
import {
  findKnownAgent,
  knownAgentLiveness,
  type KnownAgentSource,
} from "../knownAgents";
import { SPARKLE_AGENT_ID } from "../sparkleAgent";
import { calmNewAgent } from "../../engine/newAgentAttention";
import { useInteractionStore } from "../../stores/interactionStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import type { AgentTabStatus } from "../../types";
import {
  detectTerminalPrompts,
  pickerBlockBounds,
  pickerWindow,
  MENU_LINE,
  genericMenuRun,
  genericMenuWindow,
  YN,
} from "../suggestions/heuristics";
import type { SuggestionButton } from "../suggestions/types";

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
  /** One sentence explaining what this report does and does not establish. Always present. */
  detail: string;
}

/** Where a tool send ended up. The dispatcher's own taxonomy plus the one refusal this layer makes
 *  on its own behalf. */
export type ConciergeSendPath = ConciergeDispatchPath | "unknown-agent";

export interface ConciergeSendResult {
  ok: boolean;
  agentId: string;
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

// `read_transcript_last_assistant` takes a PATH, and a Stop hook event is the only place one is ever
// known. This tiny registry is where that path is parked so tier (d) has something to read, without
// this module reaching into the hook plumbing itself.
//
// THE ONE WRITER is `components/AgentPane.noteTranscriptFromStop`, wired as the REQUIRED
// `noteTranscript` field of `engine/hookEvents.HookEventHandlerDeps` — so the hand-off cannot be
// dropped without a compile error, and it sits behind that handler's session gate (a background
// `claude` sharing a worktree's log must not register ITS transcript against this agent). Read that
// helper's doc comment before changing anything here; the two are a pair.
//
// This registry is also the ONLY source. Tier (d) does not guess a path — a fabricated
// `~/.claude/projects/<slug>/<id>.jsonl` would fail confusingly, and slug derivation is exactly the
// kind of guess this module shouldn't make — and it no longer accepts one from the caller either:
// `ReadAgentTerminalOptions` is the tool ARGUMENT surface, so an override there was a model-supplied
// arbitrary-file read landing in an LLM context. With no entry, tier (d) skips itself and says why.
//
// NOTHING CLEARS IT TODAY. `forgetAgentTranscriptPath` exists for a caller that genuinely knows an
// agent is gone, and there isn't one — the pane's unmount cleanup is the wrong place twice over (it
// fires on a project switch, and tier (d) exists to serve UNMOUNTED agents). The cost is one short
// string per agent id opened this process. Stated plainly here so nobody reads the export as
// evidence of a lifecycle that doesn't exist.
const transcriptPaths = new Map<string, string>();

/** Remember where this agent's session transcript lives, enabling tier (d) of the read chain.
 *  Called from AgentPane's `noteTranscriptFromStop` — see the block above. */
export function noteAgentTranscriptPath(agentId: string, path: string): void {
  if (path.trim() === "") return;
  transcriptPaths.set(agentId, path);
}

/** Forget an agent's transcript path. No production caller today (see the block above); used by
 *  tests resetting between cases, and available for a real agent-close seam when one exists. */
export function forgetAgentTranscriptPath(agentId: string): void {
  transcriptPaths.delete(agentId);
}

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

/** Tier (b): the screen captured when the agent crossed into waiting/approval. */
function readAttentionTier(agentId: string): TierResult {
  const raw = useRuntimeStore.getState().attentionScreen[agentId];
  if (!raw || raw.trim() === "") {
    return { why: "the agent hasn't stopped to ask anything, so no ask-screen was captured" };
  }
  return { text: raw };
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
  const mine = hits.filter((h) => h.agentId === agentId);
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
 * The path comes from the REGISTRY and from nowhere else. A caller-supplied override was the one
 * place in this module where an argument became a filesystem path — see the note on
 * `ReadAgentTerminalOptions` for why that is not a knob a tool argument gets to turn.
 */
async function readTranscriptTier(agentId: string): Promise<TierResult> {
  const path = transcriptPaths.get(agentId);
  if (!path) {
    return { why: "no transcript path is known for this agent (see noteAgentTranscriptPath)" };
  }
  const text = await invoke<string>("read_transcript_last_assistant", { path });
  if (!text || text.trim() === "") return { why: "the transcript has no assistant turn yet" };
  return { text };
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
}

/** One sentence per outcome, ready to hand back to a model composing a reply. */
function sendDetail(path: ConciergeSendPath, agentId: string): string {
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
    case "cloud-agent":
      return "Not sent: that agent runs in the cloud and has no terminal to type into.";
    case "unauthorized":
      return "Not sent: nothing authorized this write.";
    case "pty-gone":
      return "Not sent: the agent's terminal has closed.";
    // Unreachable from this tool today — `neverPickerAnswer` is set only for an @-addressed compose
    // send — but the union is exhaustive here on purpose, so it gets an honest line rather than
    // falling into the bare "Not sent." default if a caller ever sets it.
    case "addressed-at-picker":
      return "Not sent: the agent is waiting on a choice on screen, so a message can't go in right now.";
    case "unknown-agent":
      return `Not sent: there is no open agent with id ${agentId}.`;
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
 * A CLOUD agent falls THROUGH to the dispatcher instead of being refused here, so the user gets the
 * existing honest `cloud-agent` refusal from the one place that owns it. There is no cloud input
 * path; this module does not invent one.
 */
export async function sendToAgentTerminal(
  agentId: string,
  text: string,
  authority: ConciergeToolAuthority,
  opts: SendToAgentTerminalOptions = {},
): Promise<ConciergeSendResult> {
  const refuse = (path: ConciergeSendPath): ConciergeSendResult => ({
    ok: false,
    agentId,
    path,
    detail: sendDetail(path, agentId),
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

  const r = await dispatchConciergeAnswer(agentId, text, {
    authority,
    userPrompt: opts.userPrompt ?? true,
  });
  return {
    ok: r.ok,
    agentId: r.agentId,
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
/** The one sentence that makes "Improve Sparkle" REACHABLE rather than merely resolvable.
 *
 *  Its id is the only agent address in the app that a caller cannot discover: it is app-owned, so it
 *  is deliberately absent from `get_state`'s roster, and the concierge's whole model of "which
 *  agents exist" comes from that roster. Fixing the resolver without saying the id out loud would
 *  leave the capability present and undiscoverable — which is indistinguishable, from the user's
 *  seat, from the bug it fixes. Appended to all three descriptions because a caller may reach for
 *  any of them first, and the read ops are the ones it will reach for before it dares a write. */
const SPARKLE_AGENT_TOOL_NOTE =
  `Works for the built-in Improve Sparkle agent too, at the stable id \`${SPARKLE_AGENT_ID}\` — ` +
  "it is the app's own self-improvement agent, so it does NOT appear in get_state's roster, but " +
  "these ops reach it exactly as they reach a build agent.";

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
      "An agent's live status, whether it is stuck waiting on the human, and whether it can accept input right now. Check `observed` first: when it is false there was no live status to read, so `needsYou: false` means NOT OBSERVED rather than calm — relay `detail` instead of reporting the agent as fine. Read-only. " +
      SPARKLE_AGENT_TOOL_NOTE,
    write: false,
  },
  {
    name: "read_picker_options",
    description:
      "Read the menu an agent is offering right now, as indexed options. Empty when there is no menu — a normal state, not an error. A PRESENT menu with an EMPTY `fingerprint` is different: the menu is there but its question could not be read, so it cannot be told apart from any other menu with the same options and is NOT answerable — relay it to the human rather than pressing anything. Read this BEFORE select_picker_option: that op requires you to echo back the `fingerprint` this returns, which covers the question AND the options — so a menu that re-rendered into a different ask is refused rather than answered.",
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
    name: "send_to_agent_terminal",
    description:
      "Type a message into an agent's terminal, as if the human had typed it. Requires an authorized tool policy. Refuses rather than guessing when the agent has a prompt on screen the message doesn't answer. " +
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

// NO LOCAL "OPTION ROW" PATTERN LIVES HERE ANY MORE.
//
// There used to be one, deliberately WIDER than the detector's `MENU_LINE` so it could not miss a
// shape the parser accepted. That reasoning was backwards: a locator that matches a line the PARSER
// SKIPS is just as broken as one that misses a line the parser takes — a stray `> 4. see the guide`
// counted as an option row here, broke the run, produced no block, and refused every press forever
// (roborev 55218). The rule that survived four rounds of this is parity, not generosity, so the
// generic branch imports `MENU_LINE` and there is exactly one definition of what an option row is.

/** Content that MOVES on its own: progress percentages, `(3120/6640)` counters, byte totals,
 *  elapsed-time readouts, braille/ASCII spinners. Any of it inside a fingerprint makes the
 *  fingerprint tick while the question sits still, so `read_picker_options` and
 *  `select_picker_option` disagree and the prompt becomes UNANSWERABLE — with a refusal whose own
 *  remedy is "re-read and try again", which loops (roborev 55170).
 *
 *  NORMALISED, NOT DROPPED. Dropping the whole line was worse than the bug it fixed: these patterns
 *  match ordinary question text — "Delete 2.3 GB of build artifacts? [y/n]" is a volatile line by
 *  this pattern — so the filter discarded the only content that distinguishes one prompt from
 *  another, and two destructive-vs-benign prompts collapsed to the same empty block (roborev 55172).
 *  Replacing just the moving SPAN with a placeholder keeps the distinguishing text and neutralises
 *  the movement. */
const VOLATILE_SPAN = /\d+(?:\.\d+)?\s*%|\(\s*\d+\s*\/\s*\d+\s*\)|\b\d+(?:\.\d+)?\s*[KMG]i?B\b|\b\d+m\s*\d+s\b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]/g;

/** Neutralise the moving parts of a line, keeping everything else. */
function steady(line: string): string {
  return line.replace(VOLATILE_SPAN, "#");
}

/** How far above the option block the question may sit. Claude Code's Bash-approval dialog puts the
 *  command and its description 3–4 lines up; generous without reaching into unrelated output. */
const QUESTION_CONTEXT_LINES = 10;

/** Hard ceiling on the block, whatever the anchors say. A fingerprint over hundreds of lines of live
 *  log output changes constantly, which is the same permanent-disagreement failure as a moving tail. */
const QUESTION_BLOCK_MAX_LINES = 20;

/** How many trailing non-empty lines a y/n question may occupy — the detector's own rule. */
const YN_TAIL = 2;

/** The same screen re-rendered with a different highlight colour must not read as a different
 *  question, so escapes come off before anything is hashed. Hoisted with the disable comment the
 *  way `suggestions/pendingQuestion.ts` and `engine/statusEngine.ts` do it — the rule is right in
 *  general, and this is the one place it does not apply. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

// NO LOCAL RUN SELECTOR EITHER.
//
// Sharing the PATTERN (`MENU_LINE`) closed the deadlock but left the SELECTION RULE as a second
// definition, and the two disagreed: the detector USED TO keep the longest 1-based run (first-wins
// on ties) while this kept the run nearest the END. With a numbered plan above a live menu the
// buttons came from one block and the fingerprinted question from the other — an options/question
// mismatch the fingerprint cannot catch, because it is hashing the wrong block rather than a stale
// one (roborev 55245). `genericMenuRun` is now the single definition, indices included, and its rule
// is NEAREST THE END for both callers — agreeing on the longest run was still wrong (roborev 55258).

/**
 * The dialog's OWN text: the option block the DETECTOR parsed, plus the lines above it.
 *
 * ASK THE PARSER, DO NOT RE-DERIVE IT. Every previous version of this located the block with its own
 * rule and every one of them disagreed with `parsePickerOptions` in some way — a narrower option
 * pattern (55166), a wider window (55172), a stricter adjacency rule and a wider footer search
 * (55195). A locator that disagrees with the parser that produced its input IS the bug class: the
 * option shape describes one dialog while the question describes another, and two different prompts
 * hash the same. `pickerBlockBounds` returns the exact indices that parse used, so there is nothing
 * left to disagree about — including the wrapped and description lines the parser deliberately skips
 * between option rows, which a strict adjacency rule rejected outright and thereby made every
 * soft-wrapped picker permanently unanswerable.
 *
 * The y/n path stays separate because the detector treats it separately: a confirmation has no
 * option rows at all, and `YN` (the detector's own regex) is what tells the two apart.
 */
function questionBlock(scrollback: string, yesNo: boolean): string {
  const clean = scrollback.replace(ANSI, "");
  if (!yesNo) {
    const lines = pickerWindow(clean);
    const bounds = pickerBlockBounds(clean);
    if (bounds) {
      // The footer sits just below the last option row, so the block is [first, footer).
      const block = lines
        .slice(Math.max(0, bounds.first - QUESTION_CONTEXT_LINES), bounds.footer)
        // The pointer MOVES as the user arrows around without the question changing, so it is
        // normalised away — otherwise merely navigating a menu would invalidate a fingerprint.
        .map((l) => steady(l.replace(/^\s*[❯›>]\s*/, "")).trim())
        .filter((l) => l !== "");
      // Cap from the START. The block runs question-first, option-rows-last, and the OPTIONS are
      // already in the fingerprint's `shape` half — the question is the only part this contributes.
      // Taking the last N therefore dropped precisely the material that distinguishes one ask from
      // another, which is the collision everything here exists to prevent (roborev 55204).
      return block.slice(0, QUESTION_BLOCK_MAX_LINES).join("\n");
    }
    // No Claude Code picker. The GENERIC menu path is the detector's other option source — same
    // window, same pattern, same run selection, because they are literally the same function.
    const generic = genericMenuWindow(clean);
    const run = genericMenuRun(generic);
    if (!run) return "";
    let first = run.first;
    for (let i = run.first - 1; i >= 0; i--) {
      if (MENU_LINE.test(generic[i]!)) first = i;
      else break;
    }
    return generic
      .slice(Math.max(0, first - QUESTION_CONTEXT_LINES), run.last + 1)
      .map((l) => steady(l.replace(/^\s*[❯›>]\s*/, "")).trim())
      .filter((l) => l !== "")
      // Question-first: see the note in the picker branch above.
      .slice(0, QUESTION_BLOCK_MAX_LINES)
      .join("\n");
  }
  // A yes/no confirmation: no option rows, and its question is in the trailing lines by the
  // detector's own rule. Without this the fingerprint would fall back to the option shape alone,
  // which for the constant Approve/Deny pair is a GLOBAL CONSTANT (roborev 55166).
  const tail = clean
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-YN_TAIL);
  if (!YN.test(tail.join("\n"))) return "";
  return tail
    .map((l) => steady(l).trim())
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * A stable identity for the MENU ITSELF, not for its options.
 *
 * WHY NOT THE OPTIONS ALONE. The most common picker shape is a NUMBERED menu whose labels are "1",
 * "2", "3", so two different questions are label-identical. Worse, Claude Code's Bash-approval
 * dialog renders the SAME three options for every command ("Yes" / "Yes, and don't ask again" /
 * "No, and tell Claude what to do…") — the option set is constant while the thing being approved
 * changes completely.
 *
 * WHY NOT THE TAIL OF THE SCROLLBACK. That was the first implementation and it was wrong (roborev
 * 55163). Ink keeps rendering BELOW the dialog, which is the entire reason `detectClaudeCodePicker`
 * searches a window for the footer rather than reading the last line. A blind tail slice hashes UI
 * chrome, and fails BOTH ways: it misses a changed question — you could approve `rm -rf build/`
 * having read the prompt for `git status` — and it invents changes from a moving task checklist,
 * refusing a menu that never moved.
 *
 * Not a cryptographic hash — this guards against the menu MOVING, not against a forger. A caller
 * that fabricates a fingerprint already holds an authority and could just send the keystroke.
 */
function pickerFingerprint(agentId: string, options: readonly SuggestionButton[]): string {
  // The detector emits exactly this pair, and only this pair, for a yes/no confirmation
  // (`heuristics.ts`: `[btn("Approve", "y\n"), btn("Deny", "n\n")]`). Matching on the VALUES rather
  // than the labels because the values are the keystrokes — a label is display text and could be
  // relabelled without changing what the buttons do.
  const yesNo =
    options.length === 2 && options[0]?.value === "y\n" && options[1]?.value === "n\n";
  const prompt = questionBlock(getAgentScrollback(agentId) ?? "", yesNo);
  // An EMPTY question block means the dialog could not be located, not that it has no question. A
  // fingerprint over the option shape alone is a global constant for both of the shapes that matter
  // (numbered menus, and the constant Approve/Deny pair), so producing one would be worse than
  // producing none. "" is the sentinel: `select_picker_option` refuses on it.
  if (prompt === "") return "";
  const shape = options.map((o) => `${o.label}\u0000${o.value}`).join("\u0001");
  let h = 5381;
  const material = `${shape}\u0002${prompt}`;
  for (let i = 0; i < material.length; i++) h = ((h * 33) ^ material.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** One option as the concierge sees it. `index` is what `select_picker_option` takes. */
export interface PickerOptionView {
  index: number;
  label: string;
}

export interface PickerOptionsRead {
  agentId: string;
  /** Empty when there is no menu on screen — a normal state, not an error. */
  options: PickerOptionView[];
  /** True when the agent has a live prompt with options right now. */
  present: boolean;
  /** Echo this back to `select_picker_option`. It identifies the MENU, so a different question with
   *  the same option labels (every numbered menu) cannot be answered by mistake.
   *
   *  EMPTY MEANS UNANSWERABLE, in either of two ways: there is no menu, or there is one but its
   *  question could not be located — and without the question there is nothing that distinguishes
   *  this ask from any other with the same option shape, which for both shapes that reach here is a
   *  global constant. `select_picker_option` refuses on an empty fingerprint rather than comparing
   *  it, so the two collapse to the same safe outcome and the caller never has to tell them apart. */
  fingerprint: string;
}

/** Read the options an agent is offering, so the caller can decide (or relay them to the human). */
export function readPickerOptions(agentId: string): PickerOptionsRead {
  const live = liveOptionsFor(agentId);
  return {
    agentId,
    options: live.map((o, index) => ({ index, label: o.label })),
    present: live.length > 0,
    fingerprint: live.length > 0 ? pickerFingerprint(agentId, live) : "",
  };
}

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
  const sent = await sendToAgentTerminal(agentId, chosen.value, authority);
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
 * waiting/approval and is never cleared when it answers and resumes (runtimeStore drops it only on
 * close/reset). Consulting the snapshot while the live screen is readable and definitively clean
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
  const { attentionScreen, status } = useRuntimeStore.getState();
  if (!isRedStatus(status[agentId])) return false;
  const captured = attentionScreen[agentId];
  return typeof captured === "string" && detectTerminalPrompts(captured).length > 0;
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
