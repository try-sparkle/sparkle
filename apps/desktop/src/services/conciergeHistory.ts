// INDEX THE CONCIERGE'S OWN CONVERSATION — so "did I ever ask you for this?" is answerable.
//
// ── WHAT THIS CLOSES (bead sparkle-yd1ud) ───────────────────────────────────────────────────────
// `search_history` is the tool the concierge reaches for when the founder asks what became of
// something. Until now every row in that index came from `AgentPane`'s hook-driven capture, tagged
// `source: "build"` — so the index could answer *did an agent ever ACT on this* and nothing else.
//
// That is the wrong question for the case it keeps being used for. When he asked about four
// previously-requested things on 2026-08-09, two had never produced an agent at all, so the honest
// answer to "did an agent act on this" was no — which is indistinguishable from "you never asked".
// The concierge could not tell those apart, and went archaeology-hunting through git and the board
// instead.
//
// ── HOW IT RELATES TO THE ASK QUEUE, WHICH IS A DIFFERENT MECHANISM ─────────────────────────────
// `conciergeAskQueue` keeps a durable, *actionable* list of outstanding requests — a short thing he
// is owed. This is the *searchable* record of everything said, outstanding or not. The queue is what
// stops an ask being dropped; this is what lets a question about the past be answered by lookup
// rather than by memory. Neither subsumes the other: the queue deliberately excludes ordinary
// conversation and closes rows when work is done, and searching a closed ask is exactly what "what
// happened to X" needs.
//
// ── BEST-EFFORT, ALWAYS ─────────────────────────────────────────────────────────────────────────
// `useHistoryStore.record` swallows its own failures by design ("a failed write must never surface
// to the chat / agent flow"). This module keeps that property: capture is fire-and-forget and no
// path here can reject into a turn.

import { log } from "../logger";
import { useHistoryStore } from "../stores/historyStore";
import type { HistoryKind } from "./history";

/**
 * The concierge has no agent row and no project of its own.
 *
 * `agentId`/`projectId` are therefore `null` rather than borrowed from whatever project happens to
 * be pinned. A borrowed id would make the palette's "jump to this hit's source agent" routing open
 * an unrelated agent, and the reader could not tell — the same reasoning `ConflictingPr.ownerAgentId`
 * gives for reporting an unresolved owner as unresolved instead of guessing one.
 */
const CONCIERGE_AGENT_NAME = "Concierge";

/**
 * An id for one entry, with a fallback that cannot throw.
 *
 * `crypto.randomUUID` is absent in a non-secure context — `usageTelemetry` names the same hazard and
 * injects the function for it. Losing the row over a missing id source would be gratuitous: the id
 * only has to be unique enough for `INSERT OR IGNORE` to dedupe on, and a timestamp plus randomness
 * is. Uniqueness is the requirement here, not unguessability.
 */
function entryId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `ch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function capture(kind: HistoryKind, text: string): void {
  // ── THE TRY IS LOAD-BEARING, AND IT IS NOT DEFENSIVE PROGRAMMING ────────────────────────────────
  // `record` swallows its own rejection, but everything BEFORE it can throw SYNCHRONOUSLY —
  // `crypto.randomUUID` is absent in some environments, and `getState()` reaches a store that may not
  // be initialised. These calls sit on the concierge's dispatch path, directly ahead of
  // `startConciergeTurn`, so a synchronous throw here does not merely lose an index entry: it aborts
  // the send, and the founder's message is silently never delivered.
  //
  // That is not hypothetical — it is what happened. The first version of this function called
  // `crypto.randomUUID()` unguarded and took down the concierge's queue-drain path, surfacing as
  // `ConciergeHost.test.tsx > "reports a message dropped at the cap"` hanging for its full 15s
  // timeout. Losing a history row is a nuisance; losing his message is the class of bug this whole
  // change exists to remove, so the capture must never be able to cost the turn.
  try {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    void useHistoryStore.getState().record({
      id: entryId(),
      kind,
      source: "concierge",
      projectId: null,
      agentId: null,
      projectName: null,
      agentName: CONCIERGE_AGENT_NAME,
      text: trimmed,
      createdAt: Date.now(),
    });
  } catch (e) {
    // LOGGED, NOT SILENT (roborev 61903). The failures this catches are PERMANENT, not transient —
    // an uninitialised store stays uninitialised — so a silent catch means the concierge index is
    // dead for every turn from now on with nothing anywhere saying so. `search_history` would then
    // answer "nothing" for a question he genuinely did ask, which is the precise confusion this
    // module exists to remove. `log.debug` is the sibling rule from `conciergeAskQueue`: "we could
    // not look" is a different fact from "there is nothing", and only the log preserves it. Debug,
    // not warn, because it runs per turn.
    log.debug("conciergeHistory", "could not index this turn", {
      kind,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Record what the founder said to the concierge.
 *
 * HIS RAW MESSAGE, not the composed prompt. `buildSnapshot` wraps it in a roster dump and an open-ask
 * block, and indexing that would bury one sentence of his under a page of generated context — every
 * search would match the boilerplate and rank by nothing.
 */
export function recordConciergePrompt(text: string): void {
  capture("prompt", text);
}

/** Record what the concierge replied. */
export function recordConciergeReply(text: string): void {
  capture("response", text);
}
