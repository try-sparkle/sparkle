// Public surface of the Concierge column (CM-U1). The integration unit (U7) imports from
// here; the subcomponents stay internal except where a piece is independently useful.
export { ConciergeColumn } from "./ConciergeColumn";
// The receipt's sentence, so the host can announce the same wording it renders.
export { receiptText } from "./RoutingReceipt";
// The pieces the shell (U7) mounts: ⌘K history search (U5) and the top-right kebab/avatar (U6).
export { CommandPalette, PaletteTrigger } from "./CommandPalette";
export { useCommandPalette, isPaletteShortcut } from "./useCommandPalette";
export type { CommandPaletteController } from "./useCommandPalette";
export { ConciergeTopRight, KebabMenu } from "./KebabMenu";
// The pending tool-approval prompt (the column's `approvalSlot`) and the presentational card it
// renders — the card is exported too because it is independently useful in a test or a story.
export { ConciergeApprovals } from "./ConciergeApprovals";
export { ApprovalPrompt } from "./ApprovalPrompt";
export type {
  Attachment,
  ConciergeAnnouncement,
  ConciergeAttachKind,
  ConciergeBatchMessage,
  ConciergeDigestMessage,
  ConciergeColumnProps,
  ConciergeController,
  ConciergeCopyKind,
  ConciergeMessage,
  ConciergeNudge,
  ConciergeNudgeAction,
  ConciergeReceipt,
  ConciergeSendTarget,
  ConciergeSparkleMessage,
  ConciergeUserMessage,
  ConciergeViewModel,
  StatusBand,
} from "./types";
