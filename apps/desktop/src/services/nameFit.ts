// Width-fitted agent names (spec: width-fitted agent names). Given the three length variants
// and the pixel width available in the sidebar column, pick the longest variant that fits.
// Pure + measurement-injected so it unit-tests without a DOM.
import type { AgentNameVariants } from "../types";

/** Measures the rendered pixel width of a string at the row's font. */
export type MeasureText = (text: string) => number;

/**
 * Pick the longest variant whose measured width fits `availableWidth`, trying long → medium →
 * short. If even the shortest overflows, return it anyway (CSS ellipsis is the final safety
 * net). Empty variants are skipped so a missing length never wins.
 */
export function pickFittedVariant(
  variants: AgentNameVariants,
  availableWidth: number,
  measure: MeasureText,
): string {
  const ordered = [variants.long, variants.medium, variants.short];
  for (const candidate of ordered) {
    if (candidate && measure(candidate) <= availableWidth) return candidate;
  }
  // Nothing fit — show the shortest non-empty variant and let ellipsis trim it.
  return variants.short || variants.medium || variants.long;
}
