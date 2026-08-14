// The QUIET half of the local-engine notice — a caption under the mic ring, not a bar across the
// window (sparkle-cbyhg).
//
// ── WHY THIS EXISTS RATHER THAN A SECOND BANNER ──────────────────────────────────────────────────
// DictationEngineBanner's header argues, correctly, that a SILENT engine swap reads as a broken
// feature and therefore has to be said out loud somewhere the user will see it. That argument is
// about being SEEN. It says nothing about the WEIGHT of the surface, and the two got conflated: one
// self-healing condition ended up rendered as a full-width amber warning above the founder's entire
// agent fleet, for a degradation in which not one word is lost.
//
// The split is by whether the user has anything to DO:
//   • the banner keeps every reason with a remedy (refill, sign in, unlock, close a window) and
//     every reason where words were actually LOST — missing one of those is expensive;
//   • this keeps `unavailable`, which has no remedy, heals itself in ~90 ms, and captures every
//     word regardless. Warning colour is for something you must act on; this needs nothing.
// `localEngineNoticeSurface` owns that routing, so neither component re-derives it.
//
// ── IT SITS UNDER THE MIC RING, WHICH IS THE ALWAYS-PRESENT MIC SURFACE ─────────────────────────
// Not `ComposerMic`: that returns null when the mic is off, so a notice mounted there would be
// invisible in exactly the state the founder was in when he screenshotted it. The ring is rendered
// whether or not the mic is armed, and it is the anchor everything else about dictation points at.
//
// ── AND IT IS NOT DISMISSIBLE, DELIBERATELY ─────────────────────────────────────────────────────
// A ✕ is the affordance for "I have read this and want it gone". This clears itself the moment the
// relay reconnects (`noteCloudLive`) and expires on its own TTL besides, so offering a manual
// dismiss would be offering work the user does not have to do — the same reasoning that took the
// warning colour off it.
import { FiCloudOff } from "react-icons/fi";
import { C } from "../theme/colors";
import { TYPE } from "../theme/scale";
import { localEngineNoticeSurface, useDictationEngineStore } from "../stores/dictationEngineStore";
import { useRetireStaleNotice } from "./useRetireStaleNotice";

/** MUCH shorter than the banner's sentence for the same condition, and that is the point.
 *
 *  The banner's copy has to survive being read once, at the top of the window, out of context — so
 *  it names the cause, the loss, the reassurance and the remedy in four clauses. This sits directly
 *  under the mic, where the context is already established by its position, and it competes with the
 *  live status line for the same few square centimetres. So it keeps the two facts a user actually
 *  needs — the preview is off, the words are still being captured — and drops the rest.
 *
 *  It still obeys every copy rule the banner's header states: no PII, no raw error text, no status
 *  code, and no blaming the user's network or their Claude allowance. It also does NOT say "try
 *  again in a moment": by the time this is on screen the relay has been unreachable for over twenty
 *  seconds across repeated attempts, so a retry is not the user's to make — the next dictation
 *  retries automatically. */
export const MIC_NOTICE = "Live preview off — using the local engine. Your words are still captured";

export function DictationMicNotice() {
  // Subscribe to the whole state and let the STORE decide, exactly as the banner does — the routing
  // rule lives in `localEngineNoticeSurface` and must not be re-derived per surface.
  const engine = useDictationEngineStore((s) => s);

  // Armed regardless of which surface is chosen, so this notice can retire itself without depending
  // on a DictationEngineBanner being mounted somewhere else in the tree.
  useRetireStaleNotice(engine.fallbackReason, engine.observedAt);

  if (localEngineNoticeSurface(engine) !== "mic") return null;

  return (
    <div
      style={{
        marginTop: 4,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        // Muted, not amber. The colour IS the message here: this is a status caption in the same
        // register as the mode line it sits beside, not a caution.
        color: C.muted,
        // `TYPE.small`, not a bare 11: the type scale is a ratchet with an off-scale ceiling of ZERO
        // (theme/scale.test.ts), and `small` is the register this belongs to anyway — secondary UI,
        // the same one the sibling captions under this ring use.
        fontSize: TYPE.small,
        textAlign: "center",
      }}
    >
      <FiCloudOff size={11} aria-hidden style={{ flexShrink: 0 }} />
      {/* `polite`, and scoped to the sentence alone — the same treatment the banner gives its text.
          A degradation that loses nothing must not interrupt a screen reader mid-utterance. */}
      <span role="status" aria-live="polite">
        {MIC_NOTICE}.
      </span>
    </div>
  );
}
