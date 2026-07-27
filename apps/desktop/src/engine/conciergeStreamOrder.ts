// Where a concierge message sits in the thread — by WHEN IT ARRIVED, not by what kind it is.
//
// WHY THIS EXISTS. The column used to build its stream as `[...chat, ...digests, ...nudges]`, so
// every digest line ("17 Need you in sparkle-desktop") and every alert card was appended BELOW the
// entire conversation no matter when it showed up. To a reader that looks like the notices are
// stuck to the bottom of the pane rather than being part of the conversation — you say something,
// Sparkle answers, and the notices sit underneath both, out of sequence.
//
// The fix is not a timestamp on every message: chat messages carry none, and digests are DERIVED
// state rebuilt from scratch on every feed tick, so anything stamped at build time would race to
// the bottom continuously. Instead we record the order in which each id ARRIVED and sort by that.
//
// A SLOT SURVIVES A BRIEF ABSENCE, NOT A LONG ONE. This is the subtle part, and getting it wrong in
// either direction is a real bug:
//
//   - Re-assign on every reappearance, and a digest group jumps to the bottom whenever it dips
//     below its ≥2-agent threshold and re-forms — the jumping-around this app has spent real effort
//     removing elsewhere.
//
//   - Never re-assign, and a genuinely RE-RAISED alert renders where it first appeared. Nudge ids
//     are bare agent ids and digest ids are `digest-<projectId>::<band>`; both recycle constantly,
//     because asks → answered → works → asks again is simply the life of an agent. An agent that
//     asked at 9:00, got answered, and asks again at 9:40 would re-render at its ORIGINAL slot,
//     far above the fold — and since the thread auto-follows the bottom, the reader never sees it.
//     An alert you cannot see is worse than one in the wrong place (roborev 53572).
//
// SO THE WINDOW IS WALL-CLOCK TIME, AND IT HAS TO BE. The first attempt counted REBUILDS, which
// seemed like a reasonable proxy and is wrong in both directions at once (roborev 53581):
//
//   - Too slow. A quiet fleet produces a byte-identical id set — the agent is working, nobody is
//     typing, nothing crosses `needs_you` — so no rebuild is distinguishable from any other and the
//     counter barely moves. A forty-minute absence then costs the same one or two ticks as a
//     two-second flicker, and the original bug comes straight back.
//
//   - Too fast. A fleet busy enough to warrant a digest at all has unrelated agents entering and
//     leaving `needs_you` constantly, and every one of those is a rebuild. A genuine flicker blows
//     through a count-based window while the group is collapsed, and the line yanks to the bottom.
//
// A timestamp is safe here precisely because it is only read to decide RE-SLOTTING. It is never the
// sort key, so it does not reintroduce the "stamped at build time races to the bottom" problem the
// paragraph above rules out.
//
// The ledger is small and bounded in practice — projects × bands for digests, fleet size for
// nudges, session length for chat — so entries are kept rather than swept.

/** How long an id may be absent and still reclaim its old slot.
 *
 *  Ten seconds: comfortably longer than any render/poll churn (which is what a genuine flicker is),
 *  and far shorter than a stretch of conversation. Anything past it is a new event and belongs at
 *  the bottom, where the thread's auto-follow has the reader looking. */
export const ARRIVAL_GRACE_MS = 10_000;

interface ArrivalEntry {
  /** Position in the thread. Lower sorts higher. */
  slot: number;
  /** Wall-clock ms when this id was last on screen. Only ever read to decide re-slotting. */
  lastSeenAt: number;
}

/** The arrival ledger: where each id sits and when it was last present. */
export interface ArrivalOrder {
  entries: Map<string, ArrivalEntry>;
  nextSlot: number;
}

export function createArrivalOrder(): ArrivalOrder {
  return { entries: new Map(), nextSlot: 0 };
}

/**
 * Order `items` by when each arrived, assigning fresh slots to ids that are new — or that have been
 * gone longer than ARRIVAL_GRACE_MS and so count as a new event.
 *
 * MUTATES `order` — it is a ledger that has to persist across renders (hold it in a ref). Pure with
 * respect to `items`: returns a new array and never touches the input.
 *
 * Pass `items` already concatenated in the order you want NEW arrivals to tie-break. Everything
 * newly slotted in one call is numbered in the order given, so if a chat message and a digest first
 * appear together, whichever you list first sits higher.
 *
 * IDEMPOTENT by construction. The caller runs this inside a `useMemo` that mutates a ref, and React
 * may re-run or discard a render — so the number of calls is not something we control. Calling it
 * repeatedly only refreshes the `lastSeenAt` of ids that are still present; no slot moves, and an
 * absent id ages by real elapsed time rather than by how often React happened to render.
 *
 * `now` is injectable so the window is testable without waiting on a real clock.
 */
export function orderByArrival<T extends { id: string }>(
  order: ArrivalOrder,
  items: readonly T[],
  now: number = Date.now(),
): T[] {
  for (const item of items) {
    const prev = order.entries.get(item.id);
    // Gone longer than the window ⇒ a NEW event that happens to reuse an id (an agent asking
    // again), not the same one flickering. Fresh slot, so it lands at the bottom.
    if (prev == null || now - prev.lastSeenAt > ARRIVAL_GRACE_MS) {
      order.entries.set(item.id, { slot: order.nextSlot, lastSeenAt: now });
      order.nextSlot += 1;
    } else {
      prev.lastSeenAt = now;
    }
  }
  return sortBySlot(order, items);
}

/** Slice first: sort mutates, and `items` belongs to the caller. */
function sortBySlot<T extends { id: string }>(order: ArrivalOrder, items: readonly T[]): T[] {
  return items
    .slice()
    .sort((a, b) => (order.entries.get(a.id)?.slot ?? 0) - (order.entries.get(b.id)?.slot ?? 0));
}
