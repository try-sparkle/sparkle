// ONE PLACE: a bead COMMENT → a cross-agent mention the concierge pane can render.
//
// The concierge pane watches a shared "thread" bead for NEW comments written by the two Sparkle-side
// agents to each other. A `BeadComment` today is only `{ id, author, text, createdAt }` — there is no
// interaction-type field and no structured `from` (see beadsCommands.ts:273). So the backend agent
// (branch `sparkle/mention-channel-backend`) encodes sender + interaction INTO the comment, and this
// module is the single seam that decodes it. If the backend's encoding changes, THIS is the one file
// to touch — the notice view-model, the components and the hook never parse a comment.
//
// ══ THE CONVENTION THIS DECODES (flagged for the backend to confirm — bead sparkle-hdlhox) ══════════
//   • SENDER comes from `author`: an author naming "improve" is Improve-Sparkle; one naming
//     "concierge" or "sparkle" is the concierge. Substring + case-insensitive, because inbox already
//     attributes as a display-name string ("Improve Sparkle [<id>]", "concierge") rather than a bare
//     handle (inbox.rs:316, conciergeInbox.ts:94) — matching the shape avoids a second vocabulary.
//   • INTERACTION comes from a LEADING tag in `text`: `[request]`, `[response]`, or `[challenge]`
//     (case-insensitive, optional surrounding space). The tag is stripped from the preview body. A
//     comment from a known agent with NO tag is treated as a `response` — the neutral verb — so a
//     real exchange is still shown rather than dropped; the backend is asked to always tag.
//   • A comment whose author is neither agent is NOT a cross-agent mention (`null`) — an ordinary
//     human or third-party comment must never render as one.
import type { BeadComment } from "../../services/beadsCommands";
import type { CrossAgentMention, MentionInteraction, MentionSender } from "./crossAgentNotice";

/** The interaction tags the backend writes at the head of a comment body. Exported so a test and the
 *  backend agree on one spelling. */
export const INTERACTION_TAGS: Record<MentionInteraction, string> = {
  request: "[request]",
  response: "[response]",
  challenge: "[challenge]",
};

/** When a known agent's comment carries no recognized tag, this is the verb it reads as. */
export const DEFAULT_INTERACTION: MentionInteraction = "response";

/** Which agent an `author` string names, or null when it names neither. */
export function senderFromAuthor(author: string | null): MentionSender | null {
  if (!author) return null;
  const a = author.toLowerCase();
  if (a.includes("improve")) return "improve";
  if (a.includes("concierge") || a.includes("sparkle")) return "sparkle";
  return null;
}

const LEADING_TAG = /^\s*\[(request|response|challenge)\]\s*/i;

/** Split a body into its leading interaction tag (if any) and the remaining text. */
export function splitInteractionTag(text: string): {
  interaction: MentionInteraction;
  body: string;
} {
  const m = LEADING_TAG.exec(text);
  if (!m) return { interaction: DEFAULT_INTERACTION, body: text };
  const interaction = m[1]!.toLowerCase() as MentionInteraction;
  return { interaction, body: text.slice(m[0].length) };
}

/**
 * Decode one bead comment into a cross-agent mention, or `null` if it is not one.
 *
 * `beadId` is passed in because it is the bead the comment lives ON — the subject the feedback is
 * "about" and the click-target — and a `BeadComment` does not carry its own bead id. The detection
 * layer knows it (it fetched that bead's thread), so it supplies it here.
 */
export function parseCrossAgentComment(
  comment: BeadComment,
  beadId: string,
): CrossAgentMention | null {
  const from = senderFromAuthor(comment.author);
  if (from === null) return null;
  const { interaction, body } = splitInteractionTag(comment.text);
  return {
    id: comment.id,
    from,
    interaction,
    beadId,
    body,
    ts: comment.createdAt ? Date.parse(comment.createdAt) || undefined : undefined,
  };
}
