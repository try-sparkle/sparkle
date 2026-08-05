// WHICH COLLAPSED BLOCKS A TRANSCRIPT ENTRY CARRIES — one rule, read by the two components that
// need it, and the reason it is a module rather than a method on either.
//
// The thread owns the modal and the "shown as regular text" set; the row draws the pills. Both have
// to agree on the same list of blocks for the same message, and they reach it from opposite ends —
// the thread resolves an open BLOCK ID back to a block, the row maps blocks to pills. Two copies of
// "a sparkle message has one, a user message has an array" is exactly the kind of near-identical
// pair that drifts with nothing failing.
//
// KEYED BY THE PAIR (MESSAGE, BLOCK) — not by the message alone, and NOT by the block alone.
//
// Not the message alone, because a user message can carry SEVERAL pastes (the compose box stages one
// pill per paste), so expanding one would have expanded its siblings and the modal could not say
// which of them to show.
//
// NOT THE BLOCK ALONE EITHER, and this is the part that is easy to get wrong (roborev 58639). Block
// ids come from `nextId` (composer/attachmentsApi), whose counter is MODULE-LEVEL and restarts at 0
// on every page load, and `rehydrateThread` reindexes a restored message's `id` but never its
// blocks'. So yesterday's restored paste and today's first paste are BOTH `blk-1`: a lookup by block
// id alone would open the wrong one (first match down the transcript wins) and "show as regular
// text" would spill both bubbles at once. Message ids do not have that problem — making them unique
// across a restart is exactly what `rehydrateThread`'s reindex is for — so pairing with the message
// borrows a guarantee that already exists rather than minting a second id space to keep in step.
import type { TextBlock } from "../composer/attachments";
import type { ConciergeMessage } from "./types";

/** Allocated once: this runs per message per render, and a fresh `[]` each time would defeat the
 *  identity checks the callers do on the result. */
const NONE: readonly TextBlock[] = [];

/** Every collapsed block on one entry, in the order it was sent. Empty for every other kind. */
export function collapsedBlocksOf(m: ConciergeMessage): readonly TextBlock[] {
  if (m.kind === "sparkle") return m.collapsed ? [m.collapsed] : NONE;
  if (m.kind === "you") return m.collapsed ?? NONE;
  return NONE;
}

/** The identity of one payload ANYWHERE IN THE THREAD: its message and its block. See this file's
 *  header for why the block id alone is not one. */
export function blockKey(messageId: string, blockId: string): string {
  return `${messageId}::${blockId}`;
}

/** The separator in the row's `shownBlockIds` prop. A character no minted block id contains.
 *
 *  A STRING rather than the thread's `Set`, because ConciergeMessageRow is memoised and handing it
 *  the set would re-render the ENTIRE transcript every time one payload was expanded — the same
 *  reasoning that made `answeredBy` a plain string (see that prop's doc). */
export const SHOWN_ID_SEP = "|";

/**
 * This message's expanded-in-place block ids, as the row's stable primitive prop.
 *
 * Membership is tested on the PAIR (see {@link blockKey}); the RESULT is plain block ids, because it
 * has already been scoped to this message and the row only ever asks about its own.
 */
export function shownIdsFor(m: ConciergeMessage, shown: ReadonlySet<string>): string {
  // The overwhelmingly common case, and worth the early return: nothing is expanded, so no message
  // needs its blocks enumerated at all.
  if (shown.size === 0) return "";
  return collapsedBlocksOf(m)
    .filter((b) => shown.has(blockKey(m.id, b.id)))
    .map((b) => b.id)
    .join(SHOWN_ID_SEP);
}
