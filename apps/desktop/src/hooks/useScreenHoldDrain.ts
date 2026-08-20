// DELIVERS A MOUNTED SEND THAT WAS HELD BECAUSE THE SCREEN WAS BUSY (bead sparkle-tbsvf, reopened).
//
// services/conciergeDispatch's `holdForScreenClear` queues a mounted send instead of refusing it
// outright when the agent's screen is a full-screen app or sitting at a prompt it must not
// receive free text — see that file's header for who may ask for the hold and why. Something then
// has to notice the screen has cleared and actually flush the queue; this hook is that something.
//
// POLLING IS THE ONLY OPTION HERE, not a design default. `services/terminalViewport` is a PULL
// registry with no change event — nothing publishes "this agent's screen just redrew" — so the
// only way to learn the screen cleared is to keep asking.
//
// POLLS EVERY AGENT WITH A LIVE HOLD, not only the currently mounted one. A hold can legitimately
// outlive the mount that created it — the founder types into a busy pane, then unmounts (⌘⇧U) while
// it is still busy, or switches the cable to a different agent. The message he was promised
// ("I'll send that the moment it clears") must still arrive; it does not become void because he
// looked away. `agentIdsWithScreenHolds` keeps this cheap: it is only ever the handful of agents
// that actually have something held, bounded by MAX_PER_AGENT on each — never a scan of the fleet.
import { useEffect } from "react";
import {
  deferScreenHoldsWhileHidden,
  flushScreenHeldSends,
  sweepExpiredScreenHeldSends,
} from "../services/conciergeDispatch";
import { agentIdsWithScreenHolds } from "../services/screenHoldQueue";
import { getAgentViewport } from "../services/terminalViewport";
import { terminalWriteRefusal } from "../voice/dictationTerminalRoute";

/** How often to re-check held agents' screens. Short enough that a held message lands within a
 *  beat of the screen clearing; the read it drives (one viewport snapshot per held agent, one
 *  regex pass each) is cheap enough that this cadence costs nothing against it. */
export const SCREEN_HOLD_POLL_MS = 1500;

/** Call once, unconditionally — it has no per-mount state, unlike useMountedNotice beside it. */
export function useScreenHoldDrain(): void {
  useEffect(() => {
    const id = setInterval(() => {
      // `includeExpired: true` — see agentIdsWithScreenHolds' own doc (roborev 64238's High). A
      // live-only view drops an agent whose screen never clears once its entries have all aged out
      // but before anything has SWEPT them — and a live-only poll never visits that agent again to
      // do the sweeping. (An UNREGISTERED viewport used to reach expiry the same way; it no longer
      // ages at all — see the `no-viewport` branch below — but a hold that aged out before the
      // pane went unreadable still has to be visited, so this stays `true` either way.)
      for (const agentId of agentIdsWithScreenHolds(undefined, { includeExpired: true })) {
        // The SAME predicate `holdForScreenClear`'s callers used to decide this needed holding in
        // the first place — reusing it here, rather than re-deriving "is it safe now" a second
        // way, is what keeps the hold and the drain from ever disagreeing about what the screen
        // shows.
        const refusal = terminalWriteRefusal(getAgentViewport(agentId));
        // ══ "I CANNOT SEE THIS SCREEN" IS NOT "THIS SCREEN IS BUSY" (bead sparkle-9gsjqm) ═══════
        // `no-viewport` is what this reads for a pane that simply is not mounted in THIS window —
        // the founder unmounted, switched the cable, or the pane is in another window. Lumping it
        // in with the two refusals below (the branch used to test only `!== null`) meant a held
        // send for a hidden pane could never be flushed and could only ever age out to `expired`
        // after MAX_AGE_MS, at which point the sweep dropped it. That is the exact outcome the
        // header above promises does NOT happen: a hold "does not become void because he looked
        // away". So the unreadable stretch stops the hold's clock instead of consuming it, and
        // delivery still waits for a viewport that comes back and READS CLEAR — this branch never
        // writes into a PTY it cannot see.
        if (refusal === "no-viewport") {
          deferScreenHoldsWhileHidden(agentId);
          continue;
        }
        if (refusal !== null) {
          // Still blocked — `alternate-screen` or `awaiting-input`, both of which mean the screen
          // is right here and is a screen no write belongs on: nothing may be DELIVERED, but
          // anything that aged out while waiting still has to be reported and cleared rather than
          // left to rot in the queue.
          sweepExpiredScreenHeldSends(agentId);
          continue;
        }
        void flushScreenHeldSends(agentId);
      }
    }, SCREEN_HOLD_POLL_MS);
    return () => clearInterval(id);
  }, []);
}
