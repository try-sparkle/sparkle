// THE CONCIERGE-PANE SURFACE: a compact feed of @improve ↔ @sparkle exchanges the founder can watch.
//
// This is the "watch them coordinate without relaying" half of the mention UI (bead sparkle-hdlhox).
// It renders newest-last (so it reads like a transcript that grows downward, matching the concierge
// thread) and does nothing when there is nothing to show — it must NOT paint an empty box in the
// pane on a quiet day. It is presentational: the caller supplies the already-built notices and the
// bead-open callback. The store subscription + new-comment detection lives in `useCrossAgentMentions`,
// kept separate so this renders in a test without a live beads store.
import { CrossAgentMentionNotice } from "./CrossAgentMentionNotice";
import { buildNotice, type CrossAgentMention } from "./crossAgentNotice";

export interface ConciergeMentionFeedProps {
  /** The cross-agent mentions to show, oldest-first (the order the pane renders them). */
  mentions: readonly CrossAgentMention[];
  /** Open the bead a notice is about. */
  onOpenBead?: (beadId: string) => void;
  /** Preview character cap; defaults to `PREVIEW_CAP` (~100). */
  previewCap?: number;
}

export function ConciergeMentionFeed({ mentions, onOpenBead, previewCap }: ConciergeMentionFeedProps) {
  // Render NOTHING when idle — no empty-state chrome in the pane. (Distinct from the compose panel,
  // which owns its own box and can show a placeholder.)
  if (mentions.length === 0) return null;

  return (
    <section
      data-testid="concierge-mention-feed"
      aria-label="Agent coordination"
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      {mentions.map((m) => (
        <CrossAgentMentionNotice key={m.id} notice={buildNotice(m, previewCap)} onOpenBead={onOpenBead} />
      ))}
    </section>
  );
}
