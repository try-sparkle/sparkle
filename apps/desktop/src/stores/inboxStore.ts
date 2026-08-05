// inboxStore — the LIVE Level 2 inbox, per agent, for every surface that has to render it.
//
// THE BUG THIS EXISTS FOR (sparkle-zm0c8), in the founder's words: *"You said you sent this to
// @Pusher Unsticks The Fleet but I don't see a followup message from you in that agent thread with
// this, just the original instruction."* He was right about what he saw and the message really had
// been queued — both true, which is the bug. An inbox message drains at the agent's NEXT TURN
// BOUNDARY by design (it deliberately does not interrupt mid-task), and until that boundary arrives
// the message existed ONLY in a JSONL file under app-data. It appeared nowhere: not in the agent's
// terminal, not in its thread, not on its row, not in the concierge transcript.
//
// So "the concierge sent it" and "the concierge imagined it" were indistinguishable to the one person
// who has to decide which — and he had good reason to suspect the second, because sparkle-bbghz
// recorded `inbox_send` returning ok WITH A MESSAGE ID for messages that were never queued at all.
// This store is the read side that makes the claim checkable; `inbox.rs::enqueue`'s read-back is the
// write side that makes it true.
//
// WHY A STORE AND NOT A CALL PER COMPONENT. Two surfaces need this — the agent ROW's pending badge
// and the MOUNTED AGENT THREAD's queued bubbles — and a fleet has dozens of rows. One batched
// `inbox_peek` per beat over exactly the ids currently on screen is the difference between a free
// poll and a per-row IPC storm.
//
// DEMAND-DRIVEN, NOT ROSTER-DRIVEN. Watchers register the ids they are rendering, so this never has
// to know how the roster is shaped — which matters because the roster is NOT the set of addressable
// agents (see services/knownAgents: the app-owned `__sparkle_self__` agent is deliberately in no
// project's array, and would be missed by a roster walk).
//
// IT NEVER CLAIMS. `inbox_peek` is read-only in Rust, and that is load-bearing rather than incidental:
// a UI poll that claimed would itself BE a delivery path, so merely looking at the column would
// consume messages the agent never saw — the silent drop this pair of bugs is about, reintroduced by
// the fix for it.
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

import { log } from "../logger";
import type { InboxEntry, InboxView } from "../services/conciergeTools/fleet";

/**
 * Poll cadence.
 *
 * TEN SECONDS. This used to say "matching `fleetWatch.FLEET_POLL_INTERVAL_MS`"; that watch has since
 * moved to thirty seconds because its per-agent cost turned out to be five `git` subprocess spawns,
 * and the two cadences are now deliberately DIFFERENT rather than accidentally equal.
 *
 * Ten stays right here, for the reason the fleet watch could afford to give up: a tick is a bounded
 * pair of file reads per watched agent — no subprocess, no agent turn, no network, no LLM. It also
 * has to be fast relative to what it is watching for, and what it is watching for is a message the
 * concierge queued SECONDS ago while telling the founder it had done so. A badge that took a minute
 * to appear would leave the exact window of doubt this closes.
 *
 * A NEW registration does not wait for the next tick — see {@link watch}.
 */
export const INBOX_POLL_INTERVAL_MS = 10_000;

/** Nothing queued. Module-level so the selector below returns a STABLE reference for the common case
 *  — a fresh `[]` per render would re-render every agent row on every poll. */
const NO_ENTRIES: readonly InboxEntry[] = Object.freeze([]);

interface InboxState {
  /** Live entries per agent id. Absent = never polled; empty = polled and genuinely nothing queued.
   *  Those are different facts and the badge must not read the first as the second. */
  byAgent: Record<string, readonly InboxEntry[] | undefined>;
  /** Set once a poll has answered, so a caller can tell "no messages" from "no answer yet". */
  polledAgents: Record<string, true | undefined>;
  /** The last poll failure, for diagnosis. A failed poll NEVER clears what is already known: a badge
   *  that vanished on a transient IPC error would recreate the invisibility this store exists to fix. */
  error: string | null;
}

export const useInboxStore = create<InboxState>()(() => ({
  byAgent: {},
  polledAgents: {},
  error: null,
}));

// ── The watcher registry ────────────────────────────────────────────────────────────────────────
// Refcounted, at module scope so a re-render never touches the timer, and so the same agent rendered
// in two columns (Sparkle spans two windows' worth of rows) costs one entry, not two polls.
const watchers = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
/** Coalesces the burst of registrations a mounting column produces into ONE immediate poll. */
let eagerPoll: ReturnType<typeof setTimeout> | null = null;

/** The seam tests replace. Kept as a mutable binding rather than a parameter so the two public hooks
 *  stay parameterless — every caller is a component that only knows an agent id. */
let peek: (agentIds: string[]) => Promise<InboxView[]> = (agentIds) =>
  invoke<InboxView[]>("inbox_peek", { agentIds });

/** TEST SEAM. Swap the Tauri call; returns a restore function. */
export function __setInboxPeekForTests(fn: typeof peek): () => void {
  const prev = peek;
  peek = fn;
  return () => {
    peek = prev;
  };
}

/**
 * Whether an id can be sent to `inbox_peek` at all. Mirrors `inbox.rs::validate_agent_id`.
 *
 * THIS IS HERE BECAUSE THE BATCH IS ALL-OR-NOTHING. `inbox_peek` validates before the thread hop and
 * refuses the WHOLE call on the first bad id — correctly, since serving the good ids and dropping a
 * traversal-shaped one would tell the caller its probe was partly accepted. But the batch is every
 * agent on screen, so ONE malformed id anywhere in the window would take every badge in the fleet
 * down at once, and it would do it QUIETLY: the read throws, the store keeps its last snapshot by
 * design, and every badge silently freezes at whatever it last said. That is this bead's own failure
 * mode — an inbox nobody can see — reached through the fix for it.
 *
 * Filtering here rather than relaxing the command keeps both properties: the batch that goes out is
 * always well-formed, and an id that could never name an inbox is simply not asked about. Nothing is
 * lost by dropping one — such an id cannot have an inbox, because `enqueue` refuses to create one.
 */
function isAddressable(agentId: string): boolean {
  return (
    agentId !== "" &&
    !agentId.includes("/") &&
    !agentId.includes("\\") &&
    !agentId.includes("..") &&
    !agentId.includes("\0")
  );
}

/**
 * Read every watched agent's inbox in ONE call and publish the result.
 *
 * Never throws and never clears on failure — see {@link InboxState.error}. Overlapping ticks are
 * skipped rather than queued: a slow disk must not build a backlog of identical reads.
 */
export async function refreshInbox(): Promise<void> {
  if (pollInFlight) return;
  const agentIds = [...watchers.keys()].filter(isAddressable);
  if (agentIds.length === 0) return;
  pollInFlight = true;
  try {
    const views = await peek(agentIds);
    useInboxStore.setState((s) => {
      const byAgent = { ...s.byAgent };
      const polledAgents = { ...s.polledAgents };
      for (const v of views) {
        // Identity is what the row memoization keys on, so an unchanged inbox must keep its array.
        // Rows re-render on every tick otherwise, at a fleet's worth of rows every ten seconds.
        const prev = byAgent[v.agentId];
        byAgent[v.agentId] = sameEntries(prev, v.entries) ? prev : Object.freeze(v.entries);
        polledAgents[v.agentId] = true;
      }
      return { byAgent, polledAgents, error: null };
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // WARN, not error, and the previous snapshot survives: the honest state after a failed read is
    // "what I last saw", not "nothing is queued".
    log.warn("inbox", "could not read the live inbox", e);
    useInboxStore.setState({ error: msg });
  } finally {
    pollInFlight = false;
  }
}

/** Whether two entry lists describe the same inbox. Compares the fields any surface renders — id,
 *  stage and text — rather than deep-equalling, so an ack timestamp arriving alone still counts as a
 *  change (it moves a message to `acknowledged`, which the thread renders). */
function sameEntries(a: readonly InboxEntry[] | undefined, b: readonly InboxEntry[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return x.id === y.id && x.state === y.state && x.text === y.text && x.severity === y.severity;
  });
}

/**
 * Register interest in one agent's inbox; returns the release function.
 *
 * A FIRST registration for an id polls IMMEDIATELY rather than waiting up to a full interval. That is
 * the whole point of the eager path: the founder's question is asked seconds after a send, and a
 * badge that took ten seconds to appear would leave a window in which the app still says nothing —
 * a smaller version of the same bug. Registrations are coalesced through a zero-delay timeout so a
 * mounting column of forty rows produces one call, not forty.
 */
export function watch(agentId: string): () => void {
  const before = watchers.get(agentId) ?? 0;
  watchers.set(agentId, before + 1);
  if (before === 0 && eagerPoll === null) {
    eagerPoll = setTimeout(() => {
      eagerPoll = null;
      void refreshInbox();
    }, 0);
  }
  return () => {
    const now = (watchers.get(agentId) ?? 1) - 1;
    if (now <= 0) watchers.delete(agentId);
    else watchers.set(agentId, now);
  };
}

/**
 * Start the poll. Idempotent; returns the stop function.
 *
 * Mounted once from `App`, beside `startFleetWatch`. It is a timer over a registry that may well be
 * empty — `refreshInbox` returns immediately when nothing is watched — so the cost when no agent row
 * is on screen is one no-op callback every ten seconds.
 */
export function startInboxWatch(): () => void {
  if (timer !== null) return stopInboxWatch;
  timer = setInterval(() => void refreshInbox(), INBOX_POLL_INTERVAL_MS);
  void refreshInbox();
  return stopInboxWatch;
}

export function stopInboxWatch(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (eagerPoll !== null) clearTimeout(eagerPoll);
  eagerPoll = null;
}

/** TEST SEAM. Drop every registration and every snapshot, so one test cannot leak into the next. */
export function __resetInboxForTests(): void {
  stopInboxWatch();
  watchers.clear();
  pollInFlight = false;
  useInboxStore.setState({ byAgent: {}, polledAgents: {}, error: null });
}

// ── Derived reads ───────────────────────────────────────────────────────────────────────────────

/** How many messages are queued and NOT YET HANDED OVER — the number the row badge shows. */
export function pendingCount(entries: readonly InboxEntry[]): number {
  return entries.filter((e) => e.state === "pending").length;
}

/**
 * What a THREAD should render as "not visible above": everything still in flight.
 *
 * `pending` is the obvious half. `delivered` is here too, and deliberately: delivery means the text
 * was handed to the agent, and until the agent either acknowledges it or the transcript shows the
 * turn that carried it, "did it actually land?" is still an open question — which is the question
 * this whole change exists to let a human answer. `acknowledged` is terminal and drops out: the agent
 * has confirmed in writing, so the thread no longer owes the reader a placeholder for it.
 */
export function inFlight(entries: readonly InboxEntry[]): readonly InboxEntry[] {
  const out = entries.filter((e) => e.state !== "acknowledged");
  return out.length === entries.length ? entries : out;
}

/** Read one agent's live inbox. Returns a stable reference while the inbox is unchanged. */
export function readAgentInbox(agentId: string): readonly InboxEntry[] {
  return useInboxStore.getState().byAgent[agentId] ?? NO_ENTRIES;
}

/** Selector for one agent's entries. Callers subscribe via `useInboxStore(selectAgentEntries(id))`;
 *  kept as a factory so the hook file that consumes it does not have to re-derive the fallback. */
export function selectAgentEntries(agentId: string) {
  return (s: InboxState): readonly InboxEntry[] => s.byAgent[agentId] ?? NO_ENTRIES;
}

/**
 * Subscribe a component to one agent's live inbox, registering interest for as long as it is mounted.
 *
 * The registration IS the subscription — nothing polls an agent nobody is rendering — so a surface
 * that only wants the count still has to call this rather than reading the store directly.
 *
 * An empty `agentId` (a row with no agent, a thread before one is mounted) registers nothing and
 * returns nothing, rather than sending `""` to a command that would refuse the whole batch for it.
 */
export function useAgentInbox(agentId: string): readonly InboxEntry[] {
  useEffect(() => (agentId === "" ? undefined : watch(agentId)), [agentId]);
  const selector = useMemo(() => selectAgentEntries(agentId), [agentId]);
  return useInboxStore(selector);
}
