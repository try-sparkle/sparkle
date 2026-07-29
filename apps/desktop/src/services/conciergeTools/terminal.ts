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
  type ConciergeDispatchPath,
} from "../conciergeDispatch";
import { isDispatchAuthority, type ConciergeToolAuthority } from "../dispatchAuthority";
import { searchHistory } from "../history";
import { SNAPSHOT_MAX_LINES, getAgentScrollback } from "../terminalScrollback";
import { isRedStatus } from "../windowStatus";
import { isObserved, livenessOf, type AgentLiveness } from "../agentLiveness";
import { useProjectStore } from "../../stores/projectStore";
import {
  useRuntimeStore,
  mergeOpenAgentIds,
  readPersistedOpenAgentIds,
} from "../../stores/runtimeStore";
import type { AgentTabStatus } from "../../types";
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
  /** Does the project store know this agent at all? `false` usually means a closed or invented id. */
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

/** The store row for an agent, or undefined. */
function findAgent(agentId: string) {
  return useProjectStore
    .getState()
    .projects.flatMap((p) => p.agents)
    .find((a) => a.id === agentId);
}

/** The sentence that goes with each report, so an LLM reading this result does not have to infer
 *  what a `false` establishes. Kept beside the report it describes. Pure. */
function statusDetail(
  known: boolean,
  liveness: AgentLiveness,
  status: AgentTabStatus | undefined,
  needsYou: boolean,
): string {
  if (!known) {
    return (
      "No agent with this id is open. It was closed, or the id is stale — a roster read taken " +
      "even a moment earlier can legitimately list an agent that has since been closed, so this " +
      "is not the app contradicting itself. Re-read the roster before treating it as missing."
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
  const status = rt.status[agentId];
  const openIds = new Set(
    mergeOpenAgentIds(rt.openAgentIds ?? [], readPersistedOpenAgentIds()),
  );
  const liveness = livenessOf(agentId, rt.status, openIds);
  // The red-COLOR tier (waiting|approval|blocked|errored), asked of the shared predicate so this
  // can't drift from what the sidebar paints.
  const needsYou = isRedStatus(status);
  return {
    agentId,
    known: agent !== undefined,
    status: status ?? "unknown",
    runtime: agent === undefined ? "unknown" : agent.runtime === "cloud" ? "cloud" : "local",
    canAcceptInput: agentCanAcceptInput(agentId),
    needsYou,
    liveness,
    observed: isObserved(liveness),
    detail: statusDetail(agent !== undefined, liveness, status, needsYou),
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
export const CONCIERGE_TERMINAL_TOOLS = [
  {
    name: "read_agent_terminal",
    description:
      "Read what an agent's terminal recently showed. Returns the text plus the SOURCE and FRESHNESS it came from (live screen, the screen captured when it last asked for you, searched history, or its transcript) — say which when it isn't live. Output is capped and reports what it dropped.",
    write: false,
  },
  {
    name: "get_agent_status",
    description:
      "An agent's live status, whether it is stuck waiting on the human, and whether it can accept input right now. Check `observed` first: when it is false there was no live status to read, so `needsYou: false` means NOT OBSERVED rather than calm — relay `detail` instead of reporting the agent as fine. Read-only.",
    write: false,
  },
  {
    name: "send_to_agent_terminal",
    description:
      "Type a message into an agent's terminal, as if the human had typed it. Requires an authorized tool policy. Refuses rather than guessing when the agent has a prompt on screen the message doesn't answer.",
    write: true,
  },
] as const satisfies readonly ConciergeToolDescriptor[];
