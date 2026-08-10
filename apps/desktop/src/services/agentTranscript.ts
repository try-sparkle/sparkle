// agentTranscript — READ a build agent's OWN conversation, for the mounted concierge pane.
//
// WHY THIS EXISTS. When the concierge is mounted to a build agent, the pane must stop showing the
// general Sparkle conversation and show THAT AGENT'S. The founder's framing is stronger than a
// history panel: *"I would love to be primarily interacting with the concierge and not even
// interacting with the terminal at all."* So this is a replacement surface for the terminal, and
// history + live tail are the same mechanism — Claude Code APPENDS to the session JSONL as the
// agent works, so the reader that renders the past renders the present by reading further.
//
// THERE IS ONLY EVER ONE LIST — the finding that collapses the hardest requirement.
// "Terminal-typed and concierge-relayed messages must interleave as ONE ordered timeline" is not
// something to build. A message relayed through the concierge is ALREADY in the agent's JSONL:
// `sendToAgentTerminal` delegates to `dispatchConciergeAnswer` (services/conciergeDispatch), which
// TYPES INTO THE PTY. Claude Code sees an ordinary submission and appends it exactly like something
// typed at the keyboard. The transcript IS the merged timeline; nothing here merges two sources.
//
// What is genuinely lost is PROVENANCE — from the JSONL you cannot tell which of your own messages
// you typed into the terminal and which you sent through the concierge. `promptSource` is carried
// through for a best-effort mark, and when it cannot be established we render NO mark rather than a
// guessed one, per the `agentId: null` means UNKNOWN convention in AGENTS.md.
//
// TWO-LAYER FILTER, AND WHY THE SPLIT IS WHERE IT IS. Raw transcripts are ~11% signal.
//
//   • STRUCTURE lives in Rust (`agent_transcript_page`). It is what keeps 70+ MB off the IPC
//     boundary, and it is decidable from record FIELDS: allowlist `user`/`assistant`, drop
//     `isMeta`/`isSidechain`, drop `tool_result` payloads, drop `promptSource` of "sdk" (an injected
//     agent prompt belonging to a DIFFERENT claude process sharing the worktree) and "system"
//     (harness `<task-notification>` blocks), and FOLD tool_use runs into activity summaries.
//
//   • SEMANTICS live here, in TypeScript, via `isSystemAuthoredPrompt` from engine/agentOriginated.
//     That module OWNS the marker strings and has a round-trip test binding them to the code that
//     GENERATES them; duplicating the literals in Rust would recreate exactly the drift it exists to
//     prevent. This layer is not redundant: Sparkle's auto-resume banner reaches the transcript as
//     `promptSource:"typed"` with `origin.kind:"human"` — because Sparkle really does type it into
//     the PTY — so it is structurally indistinguishable from a human turn and ONLY the text tells
//     them apart. Rust deliberately does not filter it; `filterSystemAuthored` here does.
//
// This module is a pure projection of disk. It holds no state, and nothing it returns is persisted
// — see stores/mountedThreadStore for why re-deriving on mount is the correct lifecycle.

import { invoke } from "@tauri-apps/api/core";

import { isNudgePrompt, isSystemAuthoredPrompt } from "../engine/agentOriginated";

/** Where an entry sits in the transcript set: which session file, and which record within it.
 *  Opaque to the UI — it round-trips back to Rust as the `before` bound when paging backwards. */
export interface TranscriptCursor {
  file: string;
  line: number;
}

/** One folded tool call inside an {@link ActivityEntry}. `detail` is best-effort (the matching
 *  tool_result is not always adjacent) and is allowed to be empty. */
export interface ActivityItem {
  verb: string;
  target: string;
  detail: string;
}

interface EntryBase {
  id: string;
  timestamp: string;
  sessionId: string;
  /** The verbatim JSONL that produced this entry, for the per-turn "view raw" escape hatch. Capped
   *  in Rust — a raw block is a QUOTE, useful for verbatim fidelity when something looks wrong, and
   *  a bad default surface (it cannot wrap at a ~380px column and re-imports the noise we removed). */
  raw: string;
  cursor: TranscriptCursor;
}

/** Something the FOUNDER said to this agent — typed into its terminal, or relayed by the concierge
 *  (both land here; see the module header). Includes Sparkle's own auto-resume banner until
 *  {@link filterSystemAuthored} removes it. */
export interface HumanEntry extends EntryBase {
  kind: "human";
  text: string;
  /** Claude Code's own classification: "typed" for a real submission, absent on older sessions and
   *  on slash commands. NOT a provenance answer by itself — see the module header. */
  promptSource: string | null;
}

/** Something the AGENT said. Prose, rendered as markdown in the terminal's typographic register. */
export interface AgentEntry extends EntryBase {
  kind: "agent";
  text: string;
}

/** A whole stretch of tool machinery, collapsed to one expandable line. This is what makes the pane
 *  a terminal SUBSTITUTE rather than a terminal SUMMARY: the work is not deleted, it is compressed. */
export interface ActivityEntry extends EntryBase {
  kind: "activity";
  summary: string;
  items: ActivityItem[];
  endTimestamp: string;
}

export type TranscriptEntry = HumanEntry | AgentEntry | ActivityEntry;

/** One backwards page of an agent's transcript. `entries` are OLDEST-FIRST, ordered by record
 *  timestamp (not by file — sessions resume and interleave). */
export interface TranscriptPage {
  entries: TranscriptEntry[];
  /** Feed back as `before` to page further into the past. `null` = start of history. */
  next: TranscriptCursor | null;
  hasMore: boolean;
  sessionsScanned: number;
  /** How many session files were opened to build this page. Exposed because "does a first page
   *  touch exactly one file" is the load-bearing performance property, and a number is the only
   *  honest way to assert it. */
  filesOpened: number;
  /** WHERE THE LIVE TAIL SHOULD START — the newest session file and its length at page time.
   *
   *  Carried on the PAGE rather than discovered by the tail, because the alternative is a first
   *  `fetchTranscriptTail({ fromByte: 0 })` that re-reads the entire newest session to find its end.
   *  That file is routinely multi-MB (29 MB was measured), so paying for it once per mount would
   *  undo the whole point of a bounded reader. One round trip establishes both the history and the
   *  live cursor. `null`/`0` when the agent has no sessions yet. */
  tailFile: string | null;
  tailByte: number;
}

/** New records appended since a byte offset, plus where to resume. */
export interface TranscriptTail {
  entries: TranscriptEntry[];
  /** The session file these came from. Compare against your last value: when it CHANGES a new
   *  session started, and the caller must reset its byte offset rather than seeking into a
   *  different file at a stale position. */
  file: string;
  nextByte: number;
}

/** How many entries a page asks for. 40 is small enough that one page typically opens a single
 *  session file, and large enough to fill the column without an immediate second fetch. No
 *  virtualization at this size; add it only if a page proves janky. */
export const TRANSCRIPT_PAGE_SIZE = 40;

/**
 * Read one page of an agent's transcript, newest-first-by-default.
 *
 * `before` is an EXCLUSIVE upper bound — pass the previous page's `next` to walk backwards. Rust
 * bounds the work: session files are ordered by mtime (metadata only, nothing is opened to sort),
 * then read from the TAIL backwards until `limit` renderable entries exist. A 156-file, 70 MB agent
 * costs one file read for its first page.
 */
export async function fetchTranscriptPage(opts: {
  worktreePath: string;
  configDir?: string | null;
  before?: TranscriptCursor | null;
  limit?: number;
}): Promise<TranscriptPage> {
  return await invoke<TranscriptPage>("agent_transcript_page", {
    worktreePath: opts.worktreePath,
    configDir: opts.configDir ?? null,
    before: opts.before ?? null,
    limit: opts.limit ?? TRANSCRIPT_PAGE_SIZE,
  });
}

/**
 * Read only what has been APPENDED to the newest session since `fromByte`.
 *
 * This is the live tail, and it is the same reader — not a second mechanism. `fromByte: 0` reads the
 * whole current file. A trailing partial line is not consumed and does not advance `nextByte`, so
 * the next poll re-reads it once the write completes.
 */
export async function fetchTranscriptTail(opts: {
  worktreePath: string;
  configDir?: string | null;
  fromByte: number;
  /** The file `fromByte` was measured in. Pass it — an offset without its file is unsafe (see the
   *  param's own note below). `null` only on the very first poll after a page load. */
  fromFile?: string | null;
}): Promise<TranscriptTail> {
  return await invoke<TranscriptTail>("agent_transcript_tail", {
    worktreePath: opts.worktreePath,
    configDir: opts.configDir ?? null,
    fromByte: opts.fromByte,
    // WHY THE FILE TRAVELS WITH THE OFFSET. Rust resolves "the newest session" itself, so a bare
    // byte offset is a claim about a file the caller cannot name. When the agent restarts (or is
    // resumed with `--continue`) it opens a new `<uuid>.jsonl` that immediately becomes newest — and
    // once that file has grown past the stale offset it is NOT past EOF, so the read seeks into the
    // middle of it and silently skips everything before that point. Naming the file lets Rust notice
    // and restart from 0.
    fromFile: opts.fromFile ?? null,
  });
}

/**
 * Drop the entries a human never authored and an agent never said.
 *
 * THE SEMANTIC HALF of the two-layer filter (see the module header). Rust has already removed
 * everything decidable from record structure; what survives to here are `human` entries that LOOK
 * like real submissions in every field — because Sparkle typed them into the PTY — and are
 * recognisable only by their text.
 *
 * Delegates to `isSystemAuthoredPrompt` rather than restating any marker, so the auto-resume banner,
 * the goal-expiry banner and `<task-notification>` blocks are matched by the SAME definition that
 * `agentThrash` and `goalContinuation` use, and a reword on the authoring side fails one test
 * instead of silently blinding three consumers.
 *
 * Also drops entries with no renderable content: an `agent` record whose only blocks were
 * `thinking`, or a `human` record that was pure whitespace. An empty bubble is noise the founder
 * has to scroll past, and it carries nothing.
 *
 * ── ONE DELIBERATE EXCEPTION: THE NUDGE STAYS VISIBLE (bead sparkle-hpbkw) ───────────────────────
 * `isSystemAuthoredPrompt` gained the nudge marker so the THRASH TALLY would stop scoring Sparkle's
 * own automated ping as the agent's command. That is the right call for a tally and the wrong one
 * here, and the two questions are genuinely different:
 *
 *   • the tally asks "does this text carry information about whether the AGENT is progressing?"
 *     — no, for every marker, which is why they share one predicate there.
 *   • the transcript asks "should a human SEE that this happened?" — and for a nudge the answer is
 *     emphatically yes.
 *
 * A nudge bubble is the ONLY in-app evidence that SPARKLE, not the founder, opened that turn.
 * Hiding it would delete exactly the evidence this bead exists to surface: the whole incident was
 * an agent looping on our own pings being reported to him as though he were the blocker, and a
 * transcript that shows the turns while hiding what started them makes that misreading harder to
 * catch, not easier. The auto-resume and goal-expiry banners stay hidden because they are pure
 * noise — a nudge is a record of an intervention.
 */
export function filterSystemAuthored(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((e) => {
    if (e.kind === "activity") return e.items.length > 0;
    if (e.text.trim() === "") return false;
    if (e.kind === "human") return !isSystemAuthoredPrompt(e.text) || isNudgePrompt(e.text);
    return true;
  });
}

/**
 * Merge a newly-read batch into entries already held, newest-last, without duplicates.
 *
 * DEDUPES BY `id` (the record's own uuid), which matters on two seams the tail poll creates: a
 * re-read of a line that was partial last tick, and the overlap between the first page and the
 * first tail read of the same session. Keeps the EXISTING entry on collision — it is the one
 * already rendered, so replacing it would churn React keys for no gain.
 *
 * Sorts by timestamp, then by id, so ordering is TOTAL and stable: two records written inside the
 * same millisecond (common for a fast tool run) would otherwise swap places between renders
 * depending on arrival order, making the list visibly reshuffle while the agent works.
 */
export function mergeEntries(
  existing: readonly TranscriptEntry[],
  incoming: readonly TranscriptEntry[],
): TranscriptEntry[] {
  if (incoming.length === 0) return existing as TranscriptEntry[];
  const seen = new Set(existing.map((e) => e.id));
  const merged = [...existing];
  for (const e of incoming) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    merged.push(e);
  }
  merged.sort((a, b) => (a.timestamp === b.timestamp ? cmp(a.id, b.id) : cmp(a.timestamp, b.timestamp)));
  return merged;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
