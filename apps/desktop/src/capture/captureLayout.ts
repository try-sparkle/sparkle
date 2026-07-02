// Adaptive layout chooser for the capture modal (spec §3). Pure so vitest covers it directly:
// the composer block sits BELOW landscape shots and to the RIGHT of portrait shots, and the
// image only ever shrinks (to fit 80% of the screen box) — it is never upscaled.

export interface CaptureLayout {
  placement: "below" | "right";
  /** Multiplier applied to the image's natural size. Always in (0, 1]. */
  imgScale: number;
}

/** Fraction of the screen the image may occupy before it gets downscaled. */
const FIT_FRACTION = 0.8;

export function chooseLayout(
  imgW: number,
  imgH: number,
  screenW: number,
  screenH: number,
): CaptureLayout {
  // Strictly taller than wide = portrait; square ties break to landscape (below).
  const placement = imgH > imgW ? "right" : "below";
  const maxW = screenW * FIT_FRACTION;
  const maxH = screenH * FIT_FRACTION;
  // Shrink-to-fit both axes; clamp at 1 so small captures render true-to-size.
  const imgScale = Math.min(1, maxW / imgW, maxH / imgH);
  return { placement, imgScale };
}
