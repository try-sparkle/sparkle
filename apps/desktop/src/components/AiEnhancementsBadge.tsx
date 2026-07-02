// The "✦ Sparkle + AI enhancements" pill from the website: a thin stroke shaded left→right
// from the logo's light teal to its darker blue. Implemented as a gradient border via a
// double-background trick (padding-box fill + border-box gradient) so the stroke itself
// carries the gradient, matching the marketing badge.
import type { CSSProperties } from "react";
import { C } from "../theme/colors";
import { C as BRAND } from "@sparkle/ui";

// Left→right logo fade: light teal (accent cyan) → primary brand blue. Exported so the
// Welcome screen's paid-box stroke reuses the exact same gradient (no literal duplication).
export const AI_ENHANCEMENTS_GRADIENT = `linear-gradient(90deg, ${BRAND.accent}, ${BRAND.teal})`;

const wrap: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 16px",
  borderRadius: 4,
  border: "1.5px solid transparent",
  background: `linear-gradient(${C.forest}, ${C.forest}) padding-box, ${AI_ENHANCEMENTS_GRADIENT} border-box`,
  fontFamily: '"IBM Plex Sans", sans-serif',
  fontWeight: 700,
  fontSize: 18,
};

export function AiEnhancementsBadge() {
  return (
    <span style={wrap}>
      <span aria-hidden style={{ color: BRAND.accent }}>✦</span>
      <span
        style={{
          background: AI_ENHANCEMENTS_GRADIENT,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
        }}
      >
        Sparkle + AI enhancements
      </span>
    </span>
  );
}
