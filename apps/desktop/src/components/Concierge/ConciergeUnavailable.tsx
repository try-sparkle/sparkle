// THE STICKY ONE: "your concierge is not answering", stated above the compose box so it is the last
// thing read before typing the next message into a void.
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
// IT NEVER DIAGNOSES WHAT IT CANNOT SEE. When a RUN OF FAILURES is what got us here it shows the
// concierge's own words (engine/conciergeFailureNotice keeps them verbatim); when only silence did,
// it says only that nothing came back. There is no third arm that guesses.
//
// That distinction is `reason`, not `failure != null`, and the difference is a real lie avoided. A
// recorded failure OUTLIVES the sends that follow it — deliberately, since clearing it on send would
// break the consecutive-failure run — so an outage reached through silence can be carrying an
// unrelated quota rejection from hours earlier. Presenting `resets 8:40am` at 2pm as the reason the
// concierge is quiet now is a causal claim from stale evidence, which is precisely what this header
// forbids (roborev 55442-M4).
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

/** The headline when nothing has come back and there is no error to explain it.
 *
 *  Says what was OBSERVED — no answers — rather than what it might mean. "Your concierge crashed"
 *  and "Claude is down" are both diagnoses this app cannot make from silence, and being confidently
 *  wrong about the cause is how a user ends up debugging their network for half an hour. */
export const UNAVAILABLE_SILENT_HEADLINE =
  "Your concierge isn't answering. Your last messages went out and nothing came back.";

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
 * Renders only in the sticky UNAVAILABLE state, and nothing otherwise.
 *
 * OFFLINE is deliberately NOT rendered here: it is transient by design (the turn may still answer),
 * the thinking indicator is already stating it inside the scroller, and a strip that appeared and
 * vanished on every slow-ish turn would train the user to ignore the one that matters.
 */
export function ConciergeUnavailable() {
  const { liveness, reason, failure } = useConciergeLiveness();
  if (liveness !== "unavailable") return null;
  // Only the failure ROUTE may speak for the cause — see the header.
  const cause = reason === "failures" ? failure : null;

  return (
    <div data-testid={CONCIERGE_UNAVAILABLE_TESTID} role="region" aria-label="Concierge unavailable" style={wrap}>
      <FiAlertTriangle size={14} aria-hidden style={{ flexShrink: 0, marginTop: 2, color: C.sienna }} />
      <div style={{ minWidth: 0 }}>
        <span>{cause ? cause.headline : UNAVAILABLE_SILENT_HEADLINE}</span>
        {cause && cause.evidence && (
          <p data-testid={CONCIERGE_UNAVAILABLE_EVIDENCE_TESTID} style={evidenceStyle}>
            {cause.evidence}
          </p>
        )}
      </div>
    </div>
  );
}
