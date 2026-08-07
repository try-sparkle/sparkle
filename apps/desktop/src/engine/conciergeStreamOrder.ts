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
// AND THE CLOCK STARTS WHEN THE ID GOES, NOT WHEN IT WAS LAST HERE. Those differ by exactly the
// silence in between, and silence is this memo's resting state — it is keyed on feed/chat identity,
// so ten idle seconds is ordinary rather than exceptional (it is the premise of the render-gap case
// below). Timing from the last build that CONTAINED an id therefore bills the quiet stretch to the
// absence: twelve idle seconds, a dip below the digest's >=2-agent threshold, and a re-form 200ms
// later reads as a twelve-second disappearance, and the line jumps (roborev 53651). Recording when
// the absence STARTED measures the thing the window is about, and it absorbs the render-gap guard
// as a side effect — an id nobody re-rendered was never observed missing, so it has no absence to
// time and cannot go stale, without a separate condition to keep in step.
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
  /**
   * When this id was first missing from a build, or `null` while it is on screen.
   *
   * This is the ONLY thing the window is measured against, and the field it replaced — "when the id
   * was last present" — is why (roborev 53651). Both answer "how long has it been gone?" only if a
   * build happens the instant it goes, and builds are exactly what this module cannot assume: the
   * memo runs on input identity, so a quiet stretch produces none at all. Timing from last-present
   * charges that silence to the absence, so a 200ms flicker after twelve idle seconds reads as a
   * twelve-second disappearance and the line jumps to the bottom.
   *
   * Timing from `absentSince` also subsumes the separate "did it miss a build?" test this used to
   * need. An id nobody re-rendered was never observed missing, so it has no `absentSince` and
   * cannot go stale — a render gap re-slots nothing by construction rather than by a second
   * condition ANDed on (see the header).
   */
  absentSince: number | null;
}

/** The arrival ledger: where each id sits, and — for ids a build has actually been seen without —
 *  when that absence started. */
export interface ArrivalOrder {
  entries: Map<string, ArrivalEntry>;
  nextSlot: number;
}

export function createArrivalOrder(): ArrivalOrder {
  return { entries: new Map(), nextSlot: 0 };
}

/** Monotonic by preference. `Date.now()` walks backwards on an NTP correction and jumps forward
 *  across a sleep/wake, either of which would make on-screen ids look long-absent and re-slot the
 *  whole thread at once. `performance.now()` cannot do that; the fallback is for non-DOM callers. */
function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
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
  now: number = defaultNow(),
): T[] {
  const present = new Set<string>();
  for (const item of items) present.add(item.id);

  for (const item of items) {
    const prev = order.entries.get(item.id);
    // Re-slot an id only once its ABSENCE — not the silence preceding it — has outrun the window.
    // `absentSince` is null for anything that has never been observed missing, which is what makes
    // a render gap a no-op here: a reader who pauses produces no build, so nothing is observed
    // missing, so nothing goes stale. Timing from "last present" instead would find EVERY on-screen
    // id stale on the next keystroke and renumber all of them into the caller's
    // `[chat, digests, nudges]` concatenation order — the original out-of-sequence layout this
    // module exists to remove, delivered as a jump, triggered by reading (roborev 53594/53651).
    const goneTooLong = prev?.absentSince != null && now - prev.absentSince > ARRIVAL_GRACE_MS;
    if (prev == null || goneTooLong) {
      order.entries.set(item.id, { slot: order.nextSlot, absentSince: null });
      order.nextSlot += 1;
    } else {
      prev.absentSince = null; // back on screen: whatever gap there was did not count against it
    }
  }

  // Anything the ledger holds that THIS build did not contain is absent as of now. `??=` starts the
  // clock on the first build that misses it and leaves it alone thereafter, so the window measures
  // one continuous absence however many times React re-renders during it.
  for (const [id, entry] of order.entries) {
    if (!present.has(id) && entry.absentSince == null) entry.absentSince = now;
  }

  return sortBySlot(order, items);
}

/**
 * Drop an id's slot, so its NEXT appearance is treated as a brand-new arrival and lands at the
 * bottom of the thread. Mutates `order`.
 *
 * WHY A CARD WOULD EVER NEED THIS. The grace window above re-slots an id that has been GONE too
 * long, and that is the only way a recycled id normally earns a new position. A nudge card that
 * resolves does not go anywhere — it stays in the thread, greyed, wearing the same agent id (see
 * `engine/resolvedNudges`) — so from this ledger's point of view it is continuously present. When
 * that agent blocks AGAIN, the card would therefore go loud at the slot it has occupied all along,
 * which for a long conversation is far above the fold. The header already names this as the worse of
 * the two failure directions: "An alert you cannot see is worse than one in the wrong place."
 *
 * So the caller tells the ledger explicitly, at the one moment the absence rule cannot infer:
 * a resolved card going live again is a NEW event.
 *
 * Idempotent, and a no-op for an id the ledger has never seen.
 */
export function forgetArrival(order: ArrivalOrder, id: string): void {
  order.entries.delete(id);
}

/** Slice first: sort mutates, and `items` belongs to the caller. */
function sortBySlot<T extends { id: string }>(order: ArrivalOrder, items: readonly T[]): T[] {
  return items
    .slice()
    .sort((a, b) => (order.entries.get(a.id)?.slot ?? 0) - (order.entries.get(b.id)?.slot ?? 0));
}
