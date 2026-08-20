// ⚠️ INERT SINCE bead sparkle-93wnu3 — NOTHING ENQUEUES HERE ANY MORE, AND NOTHING SHOULD.
//
// The only producer was the MOUNTED send, and a mounted send is now DELIVERED rather than held:
// see `services/conciergeDispatch`'s `mountedHumanSend`. This module and its drain are removed in
// the follow-up change; they are kept for one commit so the behavioural fix lands on its own and
// can be reverted on its own.
//
// DO NOT ADD A NEW PRODUCER. The defect this queue caused is structural, not a tuning mistake: its
// release condition was the SAME predicate that caused the hold (hooks/useScreenHoldDrain re-ran
// `terminalWriteRefusal`), so a screen the predicate is WRONG about never clears — the founder's
// message waited out MAX_AGE_MS and was dropped, fifteen minutes after he was told it would arrive.
// Any future "wait for the screen" feature needs a release condition INDEPENDENT of the one that
// blocked the write, plus a way for the human to force it through.

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

/**
 * Per-agent generation, bumped whenever a queue is cleared out from UNDER an in-flight flush
 * (abandonment, an explicit clear) rather than by the flush's own ordinary take-and-deliver.
 *
 * WHY THIS EXISTS (roborev 64289's Medium). `flushScreenHeldSends` takes the queue, awaits
 * `submitPrompt`, then re-queues whatever it could not deliver this round. If the pane tears down
 * DURING that await, `abandonScreenHeldSends` finds an already-empty queue (the flush took it) and
 * reports nothing — and the flush then re-queues into what is now a dead agent's queue, resurrecting
 * sends the founder never typed into the session that (maybe) relaunches under that id. A flush
 * that captures the generation before its own take, and checks it again before re-queuing, can tell
 * "nothing changed" apart from "this agent was abandoned while I was waiting" and must not resurrect
 * the latter.
 */
const generations = new Map<string, number>();

function bumpGeneration(agentId: string): void {
  generations.set(agentId, (generations.get(agentId) ?? 0) + 1);
}

/** This agent's current generation. Compare a value captured before an await against one read
 *  after it to detect an intervening abandon/clear — see the constant's own doc above. */
export function screenHoldGeneration(agentId: string): number {
  return generations.get(agentId) ?? 0;
}

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
 *
 * INSERTS BY `at`, NOT APPENDS (roborev 64268's Medium). `flushScreenHeldSends` re-queues
 * still-due entries through this same function AFTER an `await submitPrompt` — and a genuinely
 * NEW message can land in that same window, queued by an entirely separate `holdForScreenClear`
 * call. A plain append would put that new arrival ahead of the older re-queued ones (they are
 * re-added after the await returns, the new one during it), delivering a follow-up before the
 * message it follows. Every existing caller already passes an ascending `at`, so this changes
 * nothing about their behaviour — it only fixes the interleaved-caller case none of them can see
 * from inside their own call.
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
  const toInsert: ScreenHeldSend = { ...entry, at: now };
  const insertAt = q.findIndex((e) => e.at > toInsert.at);
  if (insertAt === -1) q.push(toInsert);
  else q.splice(insertAt, 0, toInsert);
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

/**
 * Every agent id with at least one held send. Small by construction (MAX_PER_AGENT bounds each
 * entry, and only a mounted send ever queues here at all), so a caller can safely poll every one
 * of them each tick without needing to track "which agents" separately.
 *
 * `includeExpired` DEFAULTS FALSE for the general case (most callers only care about live entries),
 * but the drain poll must pass `true` — see roborev 64238's High. An agent whose entries are all
 * expired but never yet SWEPT (see `sweepExpiredScreenHolds`) has a live-only filter here return
 * `false` for it, which would mean nothing ever visits that agent again to report the expiry or
 * free the map entry: an agent that unmounts (or is switched away from) while its screen stays
 * blocked drops out of the live-only view forever, well before its 15-minute TTL lapses, and the
 * entries then sit in `queues` unswept for the rest of the session.
 */
export function agentIdsWithScreenHolds(
  nowMs: number = Date.now(),
  opts?: { includeExpired?: boolean },
): string[] {
  const ids: string[] = [];
  for (const [agentId, q] of queues) {
    const has = opts?.includeExpired ? q.length > 0 : live(q, nowMs).length > 0;
    if (has) ids.push(agentId);
  }
  return ids;
}

/**
 * Remove ONLY the entries that have aged out past MAX_AGE_MS, leaving any still-live ones queued.
 * The counterpart to `takeScreenHeldSends` for a screen that is STILL blocked: a full take would
 * hand back live entries that must stay queued (the screen isn't safe to write to), but leaving
 * expired ones untouched is exactly the silent-drop `flushScreenHeldSends`'s `expired` branch
 * exists to prevent (roborev 64238's High) — this is what lets the drain report and clear them
 * without touching entries that are still waiting.
 */
export function sweepExpiredScreenHolds(
  agentId: string,
  nowMs: number = Date.now(),
): ScreenHeldSend[] {
  const q = queues.get(agentId);
  if (!q || q.length === 0) return [];
  const stillLive = live(q, nowMs);
  const expired = q.filter((e) => !stillLive.includes(e));
  if (expired.length === 0) return [];
  if (stillLive.length > 0) queues.set(agentId, stillLive);
  else queues.delete(agentId);
  return expired;
}

/** Drop this agent's held sends without delivering them — e.g. its pane closed for good. Bumps
 *  the generation (see `screenHoldGeneration`) so a flush already in flight for this agent knows
 *  not to resurrect what it re-queues. */
export function clearScreenHeldSends(agentId: string): void {
  queues.delete(agentId);
  bumpGeneration(agentId);
}

/**
 * Take EVERYTHING held for `agentId` — due, expired, all of it — and mark the agent abandoned by
 * bumping its generation. The caller reports each returned entry as abandoned; this function only
 * owns the queue mutation and the generation bump, atomically, so nothing observing the generation
 * can see the bump without also seeing the empty queue (or vice versa).
 */
export function abandonAllScreenHeldSends(agentId: string): ScreenHeldSend[] {
  const q = queues.get(agentId) ?? [];
  queues.delete(agentId);
  bumpGeneration(agentId);
  return q;
}

/**
 * Re-queue entries a flush took off the queue but could not deliver this round — as opposed to a
 * FRESH message arriving via `queueScreenHeldSend`. Unlike that function, this PREFERS the entries
 * being reinstated over whatever queued in during the flush's `await` window: merges both sets,
 * sorts oldest-first by `at`, and keeps only the oldest `MAX_PER_AGENT` — so a promised send cannot
 * be crowded out by a message that arrived after it (roborev 64289's Medium: a plain per-entry
 * `queueScreenHeldSend` call let mid-flush arrivals occupy the cap first and refuse the OLDER
 * promised sends instead, the exact ordering inversion the `at`-insert change above was made to
 * prevent).
 *
 * Evaluates staleness and the cap against the REAL clock (`Date.now()`), never against a reinstated
 * entry's own past `at` — using a past `at` as "now" made every already-queued entry read as
 * younger than "now" and therefore permanently un-prunable, which is also why the same finding's
 * `onPruned` never fired in the first cut and the cap could refuse an entry that was actually
 * already expired.
 *
 * `onCrowdedOut` receives whatever had to be evicted to make room, oldest of the evicted first, so
 * the caller can report a truthful `queue-full` rather than let it vanish silently.
 */
export function reinstateScreenHeldSends(
  agentId: string,
  entries: readonly ScreenHeldSend[],
  onCrowdedOut?: (evicted: ScreenHeldSend[]) => void,
  onPruned?: (dropped: ScreenHeldSend[]) => void,
): void {
  if (entries.length === 0) return;
  const now = Date.now();
  const all = queues.get(agentId) ?? [];
  const current = live(all, now);
  if (onPruned && current.length !== all.length) {
    const kept = new Set(current);
    onPruned(all.filter((e) => !kept.has(e)));
  }
  const merged = [...current, ...entries].sort((a, b) => a.at - b.at);
  const keep = merged.slice(0, MAX_PER_AGENT);
  const evicted = merged.slice(MAX_PER_AGENT);
  if (keep.length > 0) queues.set(agentId, keep);
  else queues.delete(agentId);
  if (onCrowdedOut && evicted.length > 0) onCrowdedOut(evicted);
}

/** Test seam: drop every queue and every generation counter. */
export function resetScreenHeldSends(): void {
  queues.clear();
  generations.clear();
}
