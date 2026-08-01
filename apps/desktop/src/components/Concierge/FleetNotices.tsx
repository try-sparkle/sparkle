// THE MOUNT — the self-subscribing wrapper that puts the fleet notice on screen.
//
// Kept separate from `FleetNoticeCard` so the card stays purely presentational: it takes conditions
// and renders them, which is what lets its tests assert exact strings without a store in sight.
// Everything that needs the app — the stores, the registry, a clock — lives here.
//
// ══ MOUNTED DIRECTLY, NOT THROUGH A SLOT ═══════════════════════════════════════════════════════
// `ConciergeColumn` is a pure renderer and most rows reach it as slots from the host. This one is
// mounted directly, for the reason `ConciergeUnavailable` and `PresenceSlider` already are: it takes
// NO data from the host at all — it reads its own stores. Routing it through a slot would add a
// second place for "what is wrong across the fleet" to be decided.
//
// ══ NOT GATED ON THE AI LOCK, AND THAT IS THE POINT ════════════════════════════════════════════
// Its neighbours (`ConciergeUnavailable`, `MountedNotice`) render only when `!aiLock`, because when
// the paid half is off there is no brain to be unresponsive. This row is the opposite case: it needs
// no model and no network, so it is the ONE thing in this column that still works when the AI half
// is switched off, unbought, or out of credits — which is exactly the state a quota-blocked fleet
// is in. Gating it would hide the report precisely when it is the only report available.
//
// ══ THE CLOCK ══════════════════════════════════════════════════════════════════════════════════
// Two conditions are duration-based — how overdue a duty is, and how long ago a shared failure
// happened — so a static `now` would freeze those numbers on a quiet fleet and the card would read
// "9h overdue" for as long as nothing else changed. A minute is the right grain: every number the
// card prints is in whole minutes or hours, so a faster tick would re-render to produce identical
// text.
import { useEffect, useState } from "react";
import { FleetNoticeCard } from "./FleetNoticeCard";
import { useFleetNotices } from "../../useFleetNotices";

/** How often the duration-based conditions are recomputed. See the header for why a minute. */
export const FLEET_NOTICE_TICK_MS = 60_000;

export function FleetNotices() {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), FLEET_NOTICE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  // Hoisted rather than called inline in the JSX: a hook belongs at the top level of the render
  // body, where the rules-of-hooks lint can see it is unconditional.
  const conditions = useFleetNotices(now);

  return <FleetNoticeCard conditions={conditions} />;
}
