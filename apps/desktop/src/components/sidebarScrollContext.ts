import { createContext, type RefObject } from "react";

/**
 * THE ONE BINDING SHARED BY THE COLUMN'S ROOT AND ITS ROWS, which is why it is its own module.
 *
 * `AgentSidebar` provides it; `AgentRow` consumes it with useContext. Those two live in separate
 * files now and neither can import the other without a cycle, so the context and its API type have
 * to sit in a third place that both can reach. Moved verbatim out of AgentSidebar.tsx.
 */

// Coordinates the gentle auto-scroll of the agent list when a near-the-bottom row's hover card
// would otherwise be clipped by the viewport. A hovered row asks the column to `scrollToReveal`
// just enough room below it for its full card; on un-hover it `restore`s the column to where the
// user had it. `isAutoScrolling` lets a row tell OUR programmatic smooth-scroll apart from a
// user's own scroll: during ours the card glides along glued to its row; on a user scroll the
// card closes (the original behavior). All three only touch refs, so the value identity is stable.
export type SidebarScrollApi = {
  containerRef: RefObject<HTMLDivElement | null>;
  // Scroll the list so `overflowPx` more of the hovered card fits below its row, remembering the
  // pre-scroll position as the baseline to return to. Capped at the list's own max scroll, so a
  // row near the natural bottom reveals as much as physically possible (the card's internal
  // max-height scroll covers any remainder).
  scrollToReveal: (overflowPx: number) => void;
  // Smoothly return the list to the baseline captured before auto-scrolling. Debounced so gliding
  // the cursor straight from one bottom row to the next keeps the same baseline instead of bouncing.
  restore: () => void;
  // Cancel a pending ease-back WITHOUT discarding the baseline — called when a card opens, so a
  // re-hover during the debounce window doesn't bounce the column back and re-clip.
  cancelRestore: () => void;
  // Drop the baseline and any pending ease-back so nothing yanks the list away from where it is
  // now. `abortInFlight` additionally kills an ease-back that is ALREADY ANIMATING, via a direct
  // scroll-offset write — pass it from the reveal path, and NOT from the user-scroll path, where
  // that write would cancel the user's own momentum scroll.
  abandonReveal: (abortInFlight?: boolean) => void;
  // True while our own smooth scroll (reveal or restore) is in flight toward its target.
  isAutoScrolling: () => boolean;
};

export const SidebarScrollContext = createContext<SidebarScrollApi | null>(null);
