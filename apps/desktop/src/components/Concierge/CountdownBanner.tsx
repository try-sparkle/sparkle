// "I'll tell Kraken Auth: “ship the DMG”. Sending in 3… [Cancel]" — the escape hatch that turns the
// router from a post-hoc receipt into a pre-send one.
//
// See docs/superpowers/specs/2026-07-27-concierge-control-design.md §3 A3. The reported bug was
// concierge-aimed text silently forwarded to a build agent; services/dispatchIntent is what arms the
// send instead of making it, and this is the part the user actually sees. Everything about it is in
// service of one interaction: read where it's going, and stop it if that's wrong.
//
// NO LIVE REGION HERE — this is the a11y point of the whole component and it is easy to get wrong.
// The column already owns ONE long-lived `role="status"` announcer (ConciergeColumn), and the host
// feeds it through `announce` when an intent arms. A second live region on this banner would make a
// screen reader say the countdown twice, which was learned and fixed once already during the
// auto-routing rescue (roborev 52648/53010). The Cancel button is a plain focusable control and
// needs no region of its own; the announcement names the agent and the message, so a user who
// hears it has everything they need to decide.
//
// The counter ticks LOCALLY (a 250ms interval per mounted banner, driven off `armedAt` rather than
// a decremented counter), so a re-render storm in the column can't make the displayed seconds drift
// from the timer that will actually fire.
import { useEffect, useState } from "react";
import { C } from "../../theme/colors";
import {
  countdownSentence,
  remainingSeconds,
  type DispatchIntent,
} from "../../services/dispatchIntent";

/** How often the displayed counter recomputes. Comfortably under a second, so the visible number
 *  never lags the real deadline by enough to notice. */
const TICK_MS = 250;

export interface CountdownBannerProps {
  /** Every PRESENTED send, oldest first (services/dispatchIntent.armedIntents). Held ones are not
   *  here — they are in `queuedIntents` and arrive one at a time when the user comes back. */
  intents: readonly DispatchIntent[];
  onCancel: (intentId: string) => void;
  /** The user clicked Send on an intent that came back from the queue too old to auto-send
   *  (services/dispatchIntent.confirmIntent). */
  onConfirm: (intentId: string) => void;
  /** Injectable clock, so a test can drive the counter with fake timers. */
  now?: () => number;
}

/**
 * Every presented send, each with its own Cancel.
 *
 * ALL of them, not just the newest. A banner that showed one while another counted down invisibly
 * would be a silent send with extra steps — the precise failure this component exists to remove.
 * In practice the 3s window makes more than one rare, and the queue's own drain is serialized
 * upstream (dispatchIntent.presentNextQueued) so a return from Away can never stack them.
 */
export function CountdownBanner({
  intents,
  onCancel,
  onConfirm,
  now = Date.now,
}: CountdownBannerProps) {
  const [, setTick] = useState(0);
  const pending = intents.length > 0;
  // Only a COUNTING intent needs the ticker. An intent awaiting confirmation sits in the banner
  // indefinitely with no number on it, and re-rendering it four times a second until the user
  // notices it would be a permanent idle timer for a static line of text.
  const counting = intents.some((i) => !i.needsConfirmation);

  useEffect(() => {
    // No interval when nothing is counting — this component stays mounted in the column, and a
    // timer running against an empty list would re-render it forever for nothing.
    if (!counting) return;
    const h = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(h);
  }, [counting]);

  if (!pending) return null;
  const t = now();
  return (
    <div data-testid="countdown-banners" style={{ flex: "none", padding: "0 12px 8px" }}>
      {intents.map((intent) => (
        <div
          key={intent.id}
          data-testid="countdown-banner"
          data-intent-id={intent.id}
          data-dispatch-class={intent.class}
          data-needs-confirmation={intent.needsConfirmation ? "true" : "false"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            marginTop: 6,
            borderRadius: 6,
            background: `color-mix(in srgb, ${C.muted} 18%, transparent)`,
            border: `1px solid color-mix(in srgb, ${C.muted} 35%, transparent)`,
            fontSize: 12,
            lineHeight: 1.4,
          }}
        >
          <span style={{ flex: 1, minWidth: 0, color: C.cream }}>
            {countdownSentence(intent)}{" "}
            {/* The counter is the only part that changes per tick. Split out so the sentence
                beside it stays a stable, readable line rather than re-flowing every 250ms.
                A confirmation-required intent shows no counter at all — there is no deadline, and
                a number here would imply one. */}
            <span style={{ opacity: 0.8, whiteSpace: "nowrap" }}>
              {intent.needsConfirmation
                ? "Held while you were away."
                : `Sending in ${remainingSeconds(intent, t)}…`}
            </span>
          </span>
          {/* The affirmative action exists ONLY on the held path. A counting intent already sends
              itself, so a Send button beside it would just be a way to skip your own safety net. */}
          {intent.needsConfirmation && (
            <button
              type="button"
              onClick={() => onConfirm(intent.id)}
              aria-label={`Send this to ${intent.targetName}`}
              style={{
                flex: "none",
                padding: "4px 10px",
                borderRadius: 6,
                border: `1px solid color-mix(in srgb, ${C.cream} 35%, transparent)`,
                background: `color-mix(in srgb, ${C.cream} 12%, transparent)`,
                color: C.cream,
                font: "inherit",
                cursor: "pointer",
              }}
            >
              Send
            </button>
          )}
          <button
            type="button"
            onClick={() => onCancel(intent.id)}
            // Names the AGENT, not just "Cancel": with several banners stacked, a screen-reader
            // user tabbing through identical buttons has no way to tell which send each stops.
            aria-label={`Cancel sending to ${intent.targetName}`}
            style={{
              flex: "none",
              padding: "4px 10px",
              borderRadius: 6,
              border: `1px solid color-mix(in srgb, ${C.cream} 35%, transparent)`,
              background: "transparent",
              color: C.cream,
              font: "inherit",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
        </div>
      ))}
    </div>
  );
}
