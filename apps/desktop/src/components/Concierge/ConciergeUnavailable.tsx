// THE STICKY ONE: a RUN OF REAL ERRORS, in the concierge's own words, stated above the compose box
// so it is the last thing read before typing the next message into a void.
//
// SILENCE NO LONGER REACHES THIS COMPONENT (2026-07-30). It used to render for two different
// reasons — a run of hard failures, or ninety seconds of nothing — with a hand-written headline for
// the second. The founder's retune deleted the words from the silence path entirely: silence is now
// said only as a colour, by the thinking indicator (see engine/conciergeLiveness). What survives
// here is the case where the app RECEIVED something and can quote it: a quota message, a billing
// rejection, a hard failure. Those are not suppressed and never were the complaint.
//
// That is also, by construction, the end of a lie this header used to spend four paragraphs
// avoiding (roborev 55442-M4). A recorded failure OUTLIVES the sends that follow it — deliberately,
// since clearing it on send would break the consecutive-failure run — so the old silence route
// could present an unrelated 8:40am quota rejection as the reason the concierge is quiet at 2pm.
// With the silence route gone there is one route, and it is the one that owns its evidence; there
// is no `reason` discriminator left to get wrong.
//
// WHY IT IS NOT THE THINKING INDICATOR. That row lives inside the scroller and disappears the
// instant the turn is no longer in flight — which is precisely what happens when a turn dies. The
// state this component renders has to OUTLIVE the turn that produced it, because the whole failure
// mode is "the concierge stopped answering and the column went back to looking normal".
//
// WHY IT IS NOT AN APP-SHELL BANNER (OfflineBanner / ProviderUnavailableBanner / AiServiceBanner).
// Those speak for the whole app; this is one column's brain. The app's yield hierarchy
// (aiServiceHealthStore's header) says a more specific surface owns its condition rather than
// stacking a vaguer bar on top, and it deliberately never says "your connection" — OfflineBanner
// owns that claim, and this component makes none about the network.
//
// IT NEVER DIAGNOSES WHAT IT CANNOT SEE. Every word it prints came off the wire; nothing here is
// inferred, and there is no arm that guesses.
//
// NO aria-live HERE. The column has exactly one live region, mounted with it and fed through
// `announce` — a second one is forbidden by convention in six file headers, and a region inserted
// into the DOM together with its text is not announced anyway (see RoutingReceipt's note).
import type { CSSProperties } from "react";
import { FiAlertTriangle } from "react-icons/fi";

import { C } from "../../theme/colors";
import { FONT_UI } from "../../theme/scale";
import { useConciergeLiveness } from "../../services/conciergeLiveness";

export const CONCIERGE_UNAVAILABLE_TESTID = "concierge-unavailable";
export const CONCIERGE_UNAVAILABLE_EVIDENCE_TESTID = "concierge-unavailable-evidence";

const wrap: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  margin: "0 16px 8px",
  padding: "8px 10px",
  borderRadius: 6,
  // The CountdownBanner shape, in the alarm colour rather than the neutral one — this is the same
  // kind of object (an in-column strip between the thread and the box), doing the loud version of
  // the same job.
  background: `color-mix(in srgb, ${C.sienna} 14%, transparent)`,
  border: `1px solid color-mix(in srgb, ${C.sienna} 35%, transparent)`,
  fontFamily: FONT_UI,
  fontSize: 12,
  lineHeight: 1.45,
  color: C.cream,
};

const evidenceStyle: CSSProperties = {
  margin: "4px 0 0",
  color: C.conciergeMuted,
  // The machine's own words, so they are set apart from ours and NOT run through markdown — a
  // stderr dump is not formatting instructions. `pre-wrap` keeps a multi-line detail's line breaks
  // while still wrapping inside a 360px column.
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

/**
 * Renders only for a RUN of hard failures, and nothing otherwise.
 *
 * SLOWNESS is deliberately not rendered here, in any degree. A slow turn may still answer, the
 * thinking indicator is already tinting for it inside the scroller, and a strip that appeared and
 * vanished on every slow-ish turn would train the user to ignore the one that matters. The run
 * requirement (`engine.failureOutage`) does the same job for errors: one transient failure is not
 * an outage worth pinning above the compose box.
 */
export function ConciergeUnavailable() {
  const { outage } = useConciergeLiveness();
  if (!outage) return null;

  return (
    <div data-testid={CONCIERGE_UNAVAILABLE_TESTID} role="region" aria-label="Concierge unavailable" style={wrap}>
      <FiAlertTriangle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: C.sienna }} />
      <div style={{ minWidth: 0 }}>
        <span>{outage.headline}</span>
        {outage.evidence && (
          <p data-testid={CONCIERGE_UNAVAILABLE_EVIDENCE_TESTID} style={evidenceStyle}>
            {outage.evidence}
          </p>
        )}
      </div>
    </div>
  );
}
