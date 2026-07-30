// Prompts waiting for an agent's PTY to come up (bead sparkle-qd80 / CM-U7).
//
// The removed AgentPane composer accepted a prompt while the agent was still `preparing`, held it,
// and delivered it the moment the PTY reported ready — that is what made the app's most common
// flow ("create an agent, then tell it what to do") work. Nothing replaced it when the composer
// went away: a prompt aimed at a just-spawned agent failed with `pty-gone` and the user's words
// were dropped. This is that queue, as a tiny DOM-free module so it can be unit-tested and reused
// by any send path.
//
// Deliberately dumb and BOUNDED — it is a hand-off buffer, not a durable outbox:
//   • at most MAX_PER_AGENT entries per agent (a user hammering Send at a dead agent can't grow it),
//   • entries older than MAX_AGE_MS are discarded when the queue is drained (a pane that never
//     becomes ready must not deliver a prompt the user typed half an hour ago into a fresh session),
//   • nothing is persisted — a relaunch starts empty, exactly like the composer's in-memory queue.
//
// The delivery itself lives in services/conciergeDispatch (flushPendingSends), which owns the
// submitPrompt call and the prompt side-effects; this module only holds and hands back.

/** One held send. `userPrompt` rides along so the side-effects decision made at dispatch time
 *  (see ConciergeDispatchOptions) is preserved across the wait — and so do the other two
 *  renderings of the message, or a held attachment send would flush with the raw payload in the
 *  pinned header and the naming basis (roborev 46911/46925). */
export interface PendingSend {
  agentId: string;
  /** The wire payload — what actually gets written to the PTY. */
  text: string;
  userPrompt: boolean;
  /**
   * Did a PERSON compose this text (`dispatchAuthority.isHumanAuthored`)? Decided at DISPATCH time
   * and carried across the wait, for the same reason the two renderings below are.
   *
   * REQUIRED, AND DELIBERATELY NOT OPTIONAL-WITH-A-DEFAULT (roborev 55628, High). Every other field
   * here has a SAFE default — an absent `display` means "same as text" and the worst case is a
   * cosmetic regression. This one's unsafe default is the whole bug: `appendPrompt`'s `humanAuthored`
   * parameter defaults to `true`, and a `true` here runs `projectStore.releaseGoalDebt`, which clears
   * an agent's retry budget AND un-latches the escalation whose entire purpose is to hand that agent
   * to a human. The direct send path got the authorship gate in this branch's previous commit; the
   * flush path kept passing the whole entry and inherited the default, so a `send_to_agent_terminal`
   * dispatch — `userPrompt: true` over prose the concierge LLM composed — cleared the latch as soon
   * as it was queued and flushed. Queuing is not exotic on that path: a concierge nudging a
   * just-spawned or just-restarted agent is exactly when the pane is still `starting`.
   *
   * So a new queue site must ANSWER the question rather than omit it. Default-by-omission is the
   * failure `dispatchAuthority.HUMAN_AUTHORED` is a `Record` (not a `Set`) to prevent, one layer up.
   */
  humanAuthored: boolean;
  /** What the user-visible prompt surfaces show; undefined → same as `text`. */
  display?: string;
  /** What auto-naming and ghost-text learn from; undefined → same as `text`, "" → skip naming. */
  namingBasis?: string;
  /** When it was queued (epoch ms), for the staleness sweep on drain. */
  at: number;
}

/** Per-agent cap. Small on purpose: this buffers the seconds between spawn and first prompt. */
export const MAX_PER_AGENT = 5;
/** A held prompt older than this is dropped rather than delivered (2 minutes). */
export const MAX_AGE_MS = 2 * 60 * 1000;

const queues = new Map<string, PendingSend[]>();

/** Entries still young enough to deliver. Applied everywhere a queue is read, so an aged-out
 *  entry never counts toward the cap or the reported count — it is already dead, just not swept. */
function live(q: PendingSend[], nowMs: number): PendingSend[] {
  return q.filter((e) => nowMs - e.at <= MAX_AGE_MS);
}

/**
 * Hold `entry` until its agent's PTY is ready. Returns false when this agent's queue is already
 * full of LIVE entries — the caller must then report the send as failed rather than pretend it
 * landed. Stale entries are pruned first, so five expired holds can't refuse a fresh prompt.
 *
 * `onPruned` receives anything the prune dropped, oldest first. Those entries were PROMISED
 * ("I'll send that when it's ready") and would otherwise vanish with no outcome at all — the same
 * "worst of both worlds" takePendingSends' comment describes, on a path that never reaches it
 * (roborev 53015). It also keeps the producer/consumer counts balanced for callers that pair
 * something with each queued send: without it, one silent prune puts every later outcome one slot
 * out of step, forever.
 */
export function queuePendingSend(
  entry: Omit<PendingSend, "at"> & { at?: number },
  onPruned?: (dropped: PendingSend[]) => void,
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
 * Remove everything queued for `agentId` and split it, oldest first, into what is still
 * deliverable and what aged out past MAX_AGE_MS. The caller REPORTS the expired ones — a prompt
 * that was promised ("I'll send that when it's ready") and then silently dropped is the worst of
 * both worlds. `nowMs` is injectable so the staleness rule is testable without a clock.
 */
export function takePendingSends(
  agentId: string,
  nowMs: number = Date.now(),
): { due: PendingSend[]; expired: PendingSend[] } {
  const q = queues.get(agentId);
  if (!q || q.length === 0) return { due: [], expired: [] };
  queues.delete(agentId);
  return {
    due: q.filter((e) => nowMs - e.at <= MAX_AGE_MS),
    expired: q.filter((e) => nowMs - e.at > MAX_AGE_MS),
  };
}

/** How many LIVE sends are currently held for an agent (0 when none). For UI copy and tests. */
export function pendingSendCount(agentId: string, nowMs: number = Date.now()): number {
  return live(queues.get(agentId) ?? [], nowMs).length;
}

/** Drop this agent's held sends without delivering them — e.g. its pane closed for good. */
export function clearPendingSends(agentId: string): void {
  queues.delete(agentId);
}

/** Test seam: drop every queue. */
export function resetPendingSends(): void {
  queues.clear();
}
