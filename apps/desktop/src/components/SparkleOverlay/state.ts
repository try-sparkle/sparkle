// SparkleOverlay state machine — pure, testable. The swarm has exactly two axes:
// WHERE it is (anchor) and WHAT it's doing (mode). Everything the component toggles
// in the DOM (dim veil, infused glows, orb-text visibility) derives from those two
// values through deriveFlags, so the render layer never invents its own rules.
// Ported from the canonical prototype: PRD/sparkle/living-sparkle-overlay/prototype.html.

export type Anchor = "perch" | "center" | "card" | "row";
// The four things the swarm can be DOING. `processing` is the genie thinking: the utterance is
// finished and the answer has not arrived, which is a visually distinct beat from both listening
// (you are talking) and speaking (the reply is painting). It was added for sparkle-uz87.7 — the
// state machine needs somewhere to sit during an await, and parking it in `still` would say the
// conversation had ended.
//
// WIDENING THIS UNION IS THE DANGEROUS EDIT. Every `mode === "x" ? … : "y"` ternary stops covering
// the moment a variant is added, silently and with no type error — that is why `modeMotion` below
// exists and why the render layer branches on IT rather than on the literals.
export type Mode = "still" | "listening" | "processing" | "speaking";

export interface OverlayState {
  anchor: Anchor;
  mode: Mode;
}

export interface DerivedFlags {
  /** The app behind the swarm dims ONLY while Sparkle is front-and-center answering. */
  dimmed: boolean;
  /** The flagged card holds a pure motionless glow — stars were absorbed into it. */
  cardInfused: boolean;
  /** The freshly-born agent row glows after the swarm pours into it (handoff). */
  rowInfused: boolean;
  /**
   * The in-sparkle text bubble shows front-and-center, over a card, or at the perch
   * ONLY while listening (what you say prints just below the top bar). Never on row —
   * by then the conversation has collapsed into the spark.
   */
  orbTextVisible: boolean;
  /** The galaxy's home slot reads as vacated while Sparkle is out front. */
  homeAway: boolean;
  listening: boolean;
  /** The genie is thinking: the utterance closed, the answer has not landed yet. */
  processing: boolean;
  speaking: boolean;
}

/**
 * How the swarm MOVES in a given mode — the one place the mode union is decoded.
 *
 * The render layer (engine.ts, SparkleOverlay.tsx) branches on this rather than on the mode
 * literals, so that adding a fifth `Mode` is a COMPILE ERROR here instead of a silent fall-through
 * into whatever the last `:` of a chained ternary happened to be. The `never` assignment is the
 * only real tie between the union and its consumers: TypeScript cannot enumerate a union at
 * runtime, so a test that counts variants would be a tautology, and this is what a test can
 * actually pin.
 */
export type ModeMotion = "rest" | "ripple" | "swirl" | "pulse";

export function modeMotion(mode: Mode): ModeMotion {
  switch (mode) {
    case "still":
      return "rest";
    case "listening":
      return "ripple";
    case "processing":
      return "swirl";
    case "speaking":
      return "pulse";
    default: {
      const _exhaustive: never = mode;
      return _exhaustive;
    }
  }
}

export function deriveFlags(anchor: Anchor, mode: Mode): DerivedFlags {
  return {
    dimmed: anchor === "center",
    cardInfused: anchor === "card",
    rowInfused: anchor === "row",
    // At the perch the bubble holds what you just SAID, so it must survive the beat between the
    // end of the utterance and the arrival of the answer — dropping it on `processing` would blank
    // your own words at exactly the moment you are waiting to see them acted on.
    orbTextVisible:
      anchor === "center" ||
      anchor === "card" ||
      (anchor === "perch" && (mode === "listening" || mode === "processing")),
    homeAway: anchor !== "perch",
    listening: mode === "listening",
    processing: mode === "processing",
    speaking: mode === "speaking",
  };
}

/**
 * Which particles dive INTO the new anchor and get absorbed there. On 'card' only a
 * subset pours in (the rest stay as Sparkle's own shell so it can keep talking); on
 * 'row' the WHOLE swarm dives — the handoff absorbs Sparkle entirely. `ix` is the
 * particle's frozen 0..1 slot inside an infused element, reused here as a stable
 * pseudo-random selector so the same particles dive every time.
 */
export function divesOnTransition(anchor: Anchor, ix: number): boolean {
  if (anchor === "card") return ix < 0.45;
  return anchor === "row";
}
