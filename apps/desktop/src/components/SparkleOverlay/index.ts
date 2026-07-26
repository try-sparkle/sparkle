// Public surface of the Living Sparkle Overlay. Batch 2 (integration) should import
// from here only; ./engine, ./state, ./presize are implementation detail.
export {
  SparkleOverlay,
  useSparkleOverlayController,
  type SparkleOverlayController,
  type SparkleOverlayProps,
} from "./SparkleOverlay";
export { sparkleOverlayEnabled, SPARKLE_OVERLAY_FLAG } from "./flag";
export type { Anchor, Mode, OverlayState } from "./state";
export type { LevelSource, Rect } from "./engine";
