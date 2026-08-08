// Extracted verbatim from ConciergeHost. It was already a standalone leaf component there; the only
// reason it lived in that file was proximity to its one mount site. It stays a SIBLING of
// <ConciergeColumn/> in the host's render — its 1 Hz ticker is deliberately outside the column's
// subtree, which is the whole reason it is a component and not an effect (see below).
import { useEffect, useRef } from "react";
import { useConciergeLiveness } from "../../services/conciergeLiveness";
import { livenessAnnouncement, type ConciergeLiveness } from "../../engine/conciergeLiveness";

/**
 * THE LIVENESS COLOUR, SPOKEN — a component that renders nothing and exists for two reasons.
 *
 * The concierge's no-answer signal is a COLOUR and nothing else: gray, yellow at 30s, red at 60s
 * (engine/conciergeLiveness). The founder asked for exactly that and no words — *"don't have it say
 * no answer yet, just have the color change from gray to yellow to then red."* A colour cannot be
 * read aloud, and the objection was to visual noise, so the step is spoken through `announce`, the
 * column's ONE live region, like every other line the column says. It does not belong to the
 * indicator: two attempts to give that component its own region failed, the second because the
 * thread deliberately owns no announcer (a second region double-announces, asserted by
 * ConciergeThread.roleLabels) and because the indicator's row is `aria-hidden` when it carries no
 * activity line, which would have muted a nested region in the exact case it existed for.
 *
 * WHY IT IS ITS OWN COMPONENT and not an effect in the host (roborev 56177-M2). The liveness hook
 * keeps `now` in component state and re-renders its caller once a second for the WHOLE of every turn
 * — `reduceProgress` pushes `silentSince` forward on every delta and tool call, so the ticker is not
 * confined to the silent stretches. Calling it in the host would reconcile the entire column subtree
 * (neither ConciergeColumn nor ConciergeThread is memo'd) at 1 Hz to derive a string that changes at
 * most twice. Here the 1 Hz re-render lands in a leaf that renders nothing.
 *
 * IT ANNOUNCES ONLY AN OBSERVED CHANGE (roborev 56177-M1). The liveness store is module-level and
 * outlives this component — the host unmounts whenever no project is open (App.tsx), and a turn in
 * flight at that moment loses its terminal listeners and leaves `silentSince` set forever. Speaking
 * on the effect's FIRST run would then have a reopened project greet the user with "nothing has come
 * back" about a turn nobody is waiting for, and clobber the column's one live region on mount. So
 * the first reading is recorded silently, whatever it is, and only a genuine step change speaks.
 */
export function LivenessAnnouncer({ announce }: { announce: (text: string) => void }) {
  const { liveness } = useConciergeLiveness();
  // `null` means "nothing observed yet in this mount" — distinct from any real step, so the first
  // run can be told apart from a transition into the same value.
  const spoken = useRef<ConciergeLiveness | null>(null);

  useEffect(() => {
    const previous = spoken.current;
    spoken.current = liveness;
    if (previous === null || previous === liveness) return;
    const line = livenessAnnouncement(liveness);
    // `announce` bumps a write counter so identical repeats still speak (roborev 53392), which is
    // exactly why this must fire on the transition rather than per render: a turn that sits red for
    // ten minutes says it once.
    if (line) announce(line);
  }, [liveness, announce]);

  return null;
}
