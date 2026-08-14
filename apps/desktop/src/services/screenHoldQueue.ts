// Sends waiting for a MOUNTED agent's screen to clear (bead sparkle-tbsvf, reopened).
//
// A SEPARATE queue from services/pendingSends, deliberately — the two share almost the same shape
// (bounded, per-agent, a staleness sweep on drain) but not the same POLICY, and folding them onto
// one module would have meant one of the two inherited a constant tuned for the other's scenario:
//
//   • pendingSends' MAX_AGE_MS (2 minutes) is right for "the PTY isn't up yet" — that hold is
//     bridging the seconds between spawn and first prompt, and its own header explains why a longer
//     wait would risk delivering a prompt typed into a session that no longer resembles the one the
//     user meant it for.
//   • A screen hold is bridging something else entirely: the founder is looking at a pane he
//     mounted and typed into, and the thing he is waiting on — a long tool call, a `vim` session —
//     can easily outlast 2 minutes. A hold that expired that fast would hand his message back
//     mid-edit, which is worse than the refusal this feature replaces: at least a refusal is
//     immediate and honest about not having sent anything.
//
// So this queue gets its own, longer ceiling. Same shape otherwise — see services/pendingSends for
// why the shape looks the way it does; this file does not re-derive that reasoning.
//
// The delivery itself lives in services/conciergeDispatch (flushScreenHeldSends), which owns the
// submitPrompt call and the prompt side-effects; this module only holds and hands back.

/** One held send. Same fields as `pendingSends.PendingSend`, for the same reasons — see that file's
 *  doc on `humanAuthored` in particular; it applies here unchanged. */
export interface ScreenHeldSend {
  agentId: string;
  /** The wire payload — what actually gets written to the PTY. */
  text: string;
  userPrompt: boolean;
  humanAuthored: boolean;
  /** What the user-visible prompt surfaces show; undefined → same as `text`. */
  display?: string;
  /** What auto-naming and ghost-text learn from; undefined → same as `text`, "" → skip naming. */
  namingBasis?: string;
  /** When it was queued (epoch ms), for the staleness sweep on drain. */
  at: number;
}

/** Per-agent cap. Small on purpose — this is a hand-off buffer for what the founder types while
 *  looking at one busy pane, not a durable outbox. */
export const MAX_PER_AGENT = 5;
/** A held send older than this is handed back rather than delivered (~15 minutes) — long enough to
 *  outlast an ordinary tool call or `vim` session; see this file's header for why it is NOT
 *  pendingSends' 2-minute constant. */
export const MAX_AGE_MS = 15 * 60 * 1000;

const queues = new Map<string, ScreenHeldSend[]>();

/** Entries still young enough to deliver. Applied everywhere a queue is read, so an aged-out entry
 *  never counts toward the cap or the reported count — it is already dead, just not swept. */
function live(q: ScreenHeldSend[], nowMs: number): ScreenHeldSend[] {
  return q.filter((e) => nowMs - e.at <= MAX_AGE_MS);
}

/**
 * Hold `entry` until its agent's screen clears. Returns false when this agent's queue is already
 * full of LIVE entries — the caller must then report the send as refused rather than pretend it
 * landed. Stale entries are pruned first, so old expired holds can't refuse a fresh message.
 *
 * `onPruned` receives anything the prune dropped, oldest first — see pendingSends' identical
 * parameter for why this exists: a promised send must not vanish with no outcome at all.
 */
export function queueScreenHeldSend(
  entry: Omit<ScreenHeldSend, "at"> & { at?: number },
  onPruned?: (dropped: ScreenHeldSend[]) => void,
): boolean {
  const now = entry.at ?? Date.now();
  const all = queues.get(entry.agentId) ?? [];
  const q = live(all, now);
  if (onPruned && q.length !== all.length) {
    const kept = new Set(q);
    onPruned(all.filter((e) => !kept.has(e)));
  }
  if (q.length >= MAX_PER_AGENT) {
    queues.set(entry.agentId, q); // keep the pruned list even when refusing
    return false;
  }
  q.push({ ...entry, at: now });
  queues.set(entry.agentId, q);
  return true;
}

/**
 * Remove everything held for `agentId` and split it, oldest first, into what is still deliverable
 * and what aged out past MAX_AGE_MS. The caller REPORTS the expired ones — see pendingSends'
 * `takePendingSends` for why silent dropping is the worst option. `nowMs` is injectable so the
 * staleness rule is testable without a clock.
 */
export function takeScreenHeldSends(
  agentId: string,
  nowMs: number = Date.now(),
): { due: ScreenHeldSend[]; expired: ScreenHeldSend[] } {
  const q = queues.get(agentId);
  if (!q || q.length === 0) return { due: [], expired: [] };
  queues.delete(agentId);
  return {
    due: q.filter((e) => nowMs - e.at <= MAX_AGE_MS),
    expired: q.filter((e) => nowMs - e.at > MAX_AGE_MS),
  };
}

/** How many LIVE sends are currently held for an agent (0 when none). For the drain poll's cheap
 *  early-exit and for tests. */
export function screenHeldSendCount(agentId: string, nowMs: number = Date.now()): number {
  return live(queues.get(agentId) ?? [], nowMs).length;
}

/** Every agent id with at least one LIVE held send. Small by construction (MAX_PER_AGENT bounds
 *  each entry, and only a mounted send ever queues here at all), so a caller can safely poll every
 *  one of them each tick without needing to track "which agents" separately. */
export function agentIdsWithScreenHolds(nowMs: number = Date.now()): string[] {
  const ids: string[] = [];
  for (const [agentId, q] of queues) {
    if (live(q, nowMs).length > 0) ids.push(agentId);
  }
  return ids;
}

/** Drop this agent's held sends without delivering them — e.g. its pane closed for good. */
export function clearScreenHeldSends(agentId: string): void {
  queues.delete(agentId);
}

/** Test seam: drop every queue. */
export function resetScreenHeldSends(): void {
  queues.clear();
}
