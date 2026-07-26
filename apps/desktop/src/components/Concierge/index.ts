// Public surface of the Concierge column (CM-U1). The integration unit (U7) imports from
// here; the subcomponents stay internal except where a piece is independently useful.
export { ConciergeColumn, deriveWordmarkMode } from "./ConciergeColumn";
export { StarfieldWordmark } from "./StarfieldWordmark";
// The pieces the shell (U7) mounts: ⌘K history search (U5) and the top-right kebab/avatar (U6).
export { CommandPalette, PaletteTrigger } from "./CommandPalette";
export { useCommandPalette, isPaletteShortcut } from "./useCommandPalette";
export type { CommandPaletteController } from "./useCommandPalette";
export { ConciergeTopRight, KebabMenu } from "./KebabMenu";
export type {
  ConciergeAttachKind,
  ConciergeBatchMessage,
  ConciergeColumnProps,
  ConciergeController,
  ConciergeMessage,
  ConciergeNudge,
  ConciergeNudgeAction,
  ConciergePriority,
  ConciergeSendState,
  ConciergeSendTarget,
  ConciergeSparkleMessage,
  ConciergeUserMessage,
  ConciergeViewModel,
  WordmarkMode,
} from "./types";
