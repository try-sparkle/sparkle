// Writes both halves of every concierge exchange into the searchable history DB.
//
// WHY THIS WAS MISSING. `HistorySource` was `"brainstorm" | "build"`, and the repo's only production
// history write is `AgentPane.captureHistoryFromHook`, gated to build/worker agents. `ConciergeHost`
// imports `historyStore` to READ only. So the founder's conversation with the concierge was never
// written at all — which is why searching for it found nothing at ANY retention tier. Not pruned:
// never captured.
//
// WHAT THAT COST, CONCRETELY (bead sparkle-yd1ud). `search_history` is the tool the concierge
// reaches for when the founder asks what became of something. With every row coming from
// `AgentPane`'s capture and tagged `source: "build"`, the index could answer *did an agent ever ACT
// on this* and nothing else — which is the wrong question for the case it keeps being used for. When
// he asked about four previously-requested things on 2026-08-09, two had never produced an agent at
// all, so the honest answer to "did an agent act on this" was no, indistinguishable from "you never
// asked". The concierge went archaeology-hunting through git and the board instead.
//
// HOW THIS RELATES TO THE ASK QUEUE, WHICH IS A DIFFERENT MECHANISM. `conciergeAskQueue` keeps a
// durable, *actionable* list of outstanding requests — the short thing he is owed. This is the
// *searchable* record of everything said, outstanding or not. Neither subsumes the other: the queue
// deliberately excludes ordinary conversation and closes rows when work is done, and searching a
// CLOSED ask is exactly what "what happened to X" needs.
//
// ONE WRITER, NOT TWO (the sparkle-yd1ud × sparkle-s7rfc merge). Main landed a second
// implementation — `services/conciergeHistory.ts`, three hand-placed `recordConciergePrompt` /
// `recordConciergeReply` calls on the dispatch and reply paths in `ConciergeHost`. It was deleted in
// favour of this one, and the reasoning is the two paragraphs below: ids that dedupe structurally,
// and coverage that does not depend on remembering a call site. If you are about to add a capture
// call somewhere, you almost certainly do not need to — check whether the bubble reaches the thread
// store first, because writing both ways records every message TWICE and git will not flag it.
//
// WHY IT SUBSCRIBES TO THE THREAD STORE INSTEAD OF HOOKING THE TURN.
//
// `onConciergeDone` looks like the obvious seam and is a trap. A reply that fails the lint policy
// takes an early return (`ConciergeHost.tsx`, the `takeHold` branch) and never reaches the normal
// render — it lands later in `settleHold` or `finishCorrection`. A capture hook on the completion
// handler would therefore silently miss every linted reply, and "silently misses a subset" is the
// hardest defect shape to notice in a search index: you don't find what you don't know is absent.
//
// `conciergeThreadStore.chat` is downstream of ALL of those paths — normal, held, corrected and
// proactive — because it is what the human ends up seeing. Capturing from there means the invariant
// is the one that actually matters: IF IT IS ON SCREEN, IT IS IN THE INDEX.
//
// IDEMPOTENCE IS STRUCTURAL — BUT ONLY ONCE THE ROW ID IS NAMESPACED PER APP LOAD.
//
// `record_into` is `INSERT OR IGNORE` on the history row's primary key (pinned by
// `duplicate_id_is_ignored` in src-tauri/src/history.rs), so whatever id this module writes decides
// both what dedupes and what is silently DROPPED. This module used to write the bubble's own id,
// and the comment here claimed that made a re-render, a rehydrate on restart or a double subscribe
// unable to produce duplicate rows. That argument holds WITHIN one session and was FALSE ACROSS
// them, because `ConciergeHost`'s `nextId` counter restarts at 0 on every app reload: the second
// load's `you-1` is a different message with the same key, and `INSERT OR IGNORE` threw it away.
//
// Measured before the fix: of 200 on-screen bubbles, 199 shared an id with an existing row but held
// DIFFERENT text, and only one new row was written. Responses stopped being recorded entirely once
// the `sparkle-N`/`brain-N` id space filled. One day of the founder's conversation — 41 prompts —
// left ZERO rows. Ten days ran that way with nothing anywhere saying so.
//
// So the row id is now `historyRowId(m.id)` = `${sessionToken}:${bubbleId}` (see
// services/conciergeSessionToken.ts, which also carries the inverse the scrubber rail needs and the
// reason the BUBBLE ids themselves were deliberately left alone). Within one app load the id is
// still a pure function of the bubble id, so every dedupe property above is retained; across loads
// the messages no longer collide. Existing un-namespaced rows are untouched and need no migration.
import {
  useConciergeThreadStore,
  RESTORED_ID_PREFIX,
  BRAIN_ID_PREFIX,
} from "../stores/conciergeThreadStore";
import { useHistoryStore } from "../stores/historyStore";
import { historyRowId } from "./conciergeSessionToken";
import { log } from "../logger";
import type { ConciergeMessage } from "../components/Concierge/types";
import type { HistoryEntry } from "./history";

/**
 * Is this bubble's text FINISHED, or is it still being written?
 *
 * ── THE DEFECT THIS EXISTS TO PREVENT (roborev 62934) ───────────────────────────────────────────
 * A brain reply is STREAMED: `ConciergeHost` upserts the bubble on every delta — roughly per token
 * chunk — so it enters the store holding its first few tokens. A capture that fires on the store
 * write and dedupes on the bubble id therefore indexes a FRAGMENT and can never repair it: the sink
 * is `INSERT OR IGNORE` on that same id, so every later delta and the `done` handler's final
 * `replace: true` upsert are dropped. The searchable row stays a few tokens long forever.
 *
 * It is worse on the lint-block path, where the fragment is the VIOLATING text: `blankHeldBubble`
 * then `settleHold` replace it on screen with the corrected reply, which never reaches the index at
 * all. That inverts this module's whole invariant — IF IT IS ON SCREEN, IT IS IN THE INDEX — and
 * reintroduces the defect the concierge-memory work exists to close.
 *
 * ── HOW THE TWO ARE TOLD APART ──────────────────────────────────────────────────────────────────
 * `settled` is stamped by `markSettled`, which every reply exit funnels through — the plain `done`
 * handler, `settleHold`, and `finishCorrection` (whose only exit IS `settleHold`). So a streamed
 * reply is final exactly when it is settled.
 *
 * But `settled` alone would be too strict: a `postSparkle` notice, a receipt or a refusal is
 * appended WHOLE and never streams, so nothing ever settles it and gating on `settled` would index
 * none of them. Marking those settled instead is not available — `replyAnchors` reads `settled` to
 * find the previous real ANSWER, and a receipt that ended a burst is a defect it already fixed.
 * The id namespace is what separates them: only a streaming reply is keyed `BRAIN_ID_PREFIX`.
 *
 * ── AND "IT STOPPED GROWING" IS NOT THE SAME QUESTION AS "IT ANSWERED" (roborev 62935) ──────────
 * A first cut waited for `settled` alone, and that dropped a whole class of reply the founder DID
 * read. A turn that fails mid-stream, or that a newer send supersedes mid-stream, leaves its already
 * painted text on screen and never settles — `ConciergeHost` deliberately keeps that fragment (see
 * ConciergeMessage's ABANDONED FRAGMENT note). Waiting for `settled` therefore made a reply he can
 * still scroll back to permanently unsearchable, which is the same "we never captured it" confusion
 * from the other direction. `streamEnded` is the marker for exactly that state; both are accepted
 * here, and neither could be replaced by the other — see the type's own note for why they are two
 * fields and not one.
 *
 * A bubble that is still growing is skipped, not partially indexed: a fragment in the index is worse
 * than an absence, because it answers a search with a truncated version of what was said.
 */
function isFinalText(m: ConciergeMessage): boolean {
  if (m.kind !== "sparkle") return true;
  if (!m.id.startsWith(BRAIN_ID_PREFIX)) return true;
  return m.settled === true || m.streamEnded === true;
}

/**
 * The concierge has no agent row and no project of its own.
 *
 * `agentId`/`projectId` stay `null` below rather than being borrowed from whatever project happens
 * to be pinned — a borrowed id would make the palette's "jump to this hit's source agent" routing
 * open an unrelated agent, and the reader could not tell. But the NAME is not a guess: every row in
 * the index renders its source, and an unnamed one reads as an orphan. (Carried over from the
 * deleted `services/conciergeHistory.ts`.)
 */
const CONCIERGE_AGENT_NAME = "Concierge";

/** Bubble kinds that are CONVERSATION. Mirrors `conciergeThreadStore`'s own persisted allowlist —
 *  the same two kinds it writes to disk are the two worth indexing. */
function conversationEntry(m: ConciergeMessage): HistoryEntry | null {
  if (m.kind !== "you" && m.kind !== "sparkle") return null;

  // A RESTORED bubble is a replay of something a previous session already captured. Its id is
  // rewritten on rehydrate (`RESTORED_ID_PREFIX`), so it would NOT collide with the original row and
  // the INSERT OR IGNORE above could not dedupe it — every restart would re-index the whole visible
  // thread under fresh ids. Skipping them is what keeps idempotence structural.
  //
  // STILL RIGHT UNDER NAMESPACED ROW IDS, and for a sharper reason: the restored bubble was already
  // written during the session that created it, under THAT session's token. Capturing it again now
  // would namespace it with THIS load's token, so it could not dedupe against the original even in
  // principle — it would be a genuine duplicate row of the same words. `rehydrateThread`'s
  // `restored:N` reindex likewise stays: it solves React-key and upsert collisions among ON-SCREEN
  // bubbles, which is a different problem from storage identity.
  if (m.id.startsWith(RESTORED_ID_PREFIX)) return null;

  const text = (m.text ?? "").trim();
  if (!text) return null;

  return {
    // NOT `m.id`. The bubble id is only unique within one app load; the primary key must be unique
    // across all of them. See the header note and services/conciergeSessionToken.ts.
    id: historyRowId(m.id),
    kind: m.kind === "you" ? "prompt" : "response",
    source: "concierge",
    // The concierge is cross-project by construction — it is the one surface that is not scoped to a
    // project or an agent, so these are null rather than a guess at "whatever was focused".
    projectId: null,
    agentId: null,
    projectName: null,
    agentName: CONCIERGE_AGENT_NAME,
    text,
    createdAt: Date.now(),
  };
}

/**
 * Start capturing. Returns an unsubscribe.
 *
 * Safe to call more than once (the id-keyed dedupe above makes a second subscription harmless), but
 * `ConciergeHost` mounts it once.
 */
export function startConciergeHistoryCapture(
  deps: {
    record?: (e: HistoryEntry) => void | Promise<void>;
    subscribe?: typeof useConciergeThreadStore.subscribe;
  } = {},
): () => void {
  // The seam is on the deps object rather than read inline at the call site so a test can drive the
  // REAL production path with only the sink swapped — a default that every test overrides would
  // leave the line that supplies the real value covered by nothing.
  const record = deps.record ?? ((e: HistoryEntry) => void useHistoryStore.getState().record(e));
  const subscribe = deps.subscribe ?? useConciergeThreadStore.subscribe;

  // Keyed on the NAMESPACED row id, not the bubble id, so it stays in agreement with what is
  // actually written. Within one app load the two are in bijection, so nothing about the
  // within-session dedupe changes; keying on the stored id is simply the honest key.
  const seen = new Set<string>();

  const drain = (chat: ConciergeMessage[]): void => {
    for (const m of chat) {
      const rowId = historyRowId(m.id);
      if (seen.has(rowId)) continue;
      // NOT YET — come back on the next store write. A streaming reply is skipped until its turn
      // settles, so what lands in the index is the text the founder was actually shown rather than
      // its first token chunk. See `isFinalText`.
      if (!isFinalText(m)) continue;
      const entry = conversationEntry(m);
      // Also a "come back later", not a permanent verdict: a held reply is BLANKED on screen while
      // its correction runs, and blank text yields no entry. Marking it seen here would strand the
      // corrected reply that replaces it (roborev 62934). Re-deciding a handful of skipped bubbles
      // per store write is a prefix test and a trim; the alternative is a silently missing row.
      if (!entry) continue;
      // Marked seen ONCE AN ATTEMPT IS ACTUALLY MADE — before `record` runs, so a message that
      // throws is not retried on every subsequent store write (a permanently-failing row would
      // otherwise re-throw for the life of the session), but after the two skips above, so nothing
      // is retired before it had a chance to be recorded.
      seen.add(rowId);
      // THIS SUBSCRIBER MUST NEVER THROW.
      //
      // It runs inside the thread store's listener chain, and zustand propagates a listener's
      // exception out of `setState` — so one throw here stops every LATER subscriber from running
      // and surfaces as a failed render at the call site that merely posted a message. Search
      // capture is best-effort bookkeeping; it does not get to break the conversation it observes.
      // (`historyStore.record` already swallows its own async failures; this covers a SYNCHRONOUS
      // throw before a promise ever exists — which is what an unavailable Tauri bridge produces.)
      try {
        void record(entry);
      } catch (e) {
        // LOGGED, NOT SILENT (roborev 61903, carried over from the deleted `conciergeHistory.ts`).
        // The failures this catches are PERMANENT, not transient — an uninitialised store stays
        // uninitialised — so a silent catch means the concierge index is dead from here on with
        // nothing anywhere saying so, and `search_history` then answers "nothing" for a question he
        // genuinely did ask. That is the precise confusion this module exists to remove: "we could
        // not look" is a different fact from "there is nothing", and only the log preserves it.
        // Debug, not warn, because this runs per message; the conversation itself is unaffected and
        // the next message tries again on its own.
        log.debug("conciergeHistoryCapture", "could not index this message", {
          kind: entry.kind,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };

  // Capture what is already on screen at mount, then everything that arrives after. Without the
  // first pass, a thread rehydrated from localStorage before this starts would never be indexed.
  drain(useConciergeThreadStore.getState().chat);
  return subscribe((s) => drain(s.chat));
}
