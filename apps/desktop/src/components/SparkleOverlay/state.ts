// SparkleOverlay state machine — pure, testable. The swarm has exactly two axes:
// WHERE it is (anchor) and WHAT it's doing (mode). Everything the component toggles
// in the DOM (dim veil, infused glows, orb-text visibility) derives from those two
// values through deriveFlags, so the render layer never invents its own rules.
// Ported from the canonical prototype: PRD/sparkle/living-sparkle-overlay/prototype.html.

export type Anchor = "perch" | "center" | "card" | "row";
export type Mode = "still" | "listening" | "speaking";

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
  speaking: boolean;
}

export function deriveFlags(anchor: Anchor, mode: Mode): DerivedFlags {
  return {
    dimmed: anchor === "center",
    cardInfused: anchor === "card",
    rowInfused: anchor === "row",
    orbTextVisible:
      anchor === "center" ||
      anchor === "card" ||
      (anchor === "perch" && mode === "listening"),
    homeAway: anchor !== "perch",
    listening: mode === "listening",
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
