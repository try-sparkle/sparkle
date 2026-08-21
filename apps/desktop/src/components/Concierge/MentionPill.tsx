// THE mention pill. One component, three surfaces.
//
// A mention is drawn in three places, and until this file existed two of them each owned a copy of
// the same six style properties:
//
//   1. THE SENT BUBBLE — `ConciergeThread`'s `MentionedText`, the record of who the user addressed.
//   2. THE COMPOSER — `MentionMirror`, painted behind the textarea so a mention reads as a pill
//      while you are still writing it, not only after you press Send. This is the surface the
//      founder reported missing: a completed `@Kraken Auth` rendered as plain text in the box.
//   3. A CONCIERGE REPLY naming an agent — `AgentPill`, which is a BUTTON (it opens the agent) and
//      carries a live status dot, so it keeps its own element but takes its fill from here.
//
// The founder's ask for mentions was that they be SYMMETRICAL: what you address, what you sent, and
// what the concierge names back all read as one vocabulary. A second literal `color-mix(… teal 18%
// …)` is how that stops being true — silently, because nothing fails when two pills drift a shade
// apart. So the fill is a constant, and the plain (non-interactive) pill is this component.
import type { CSSProperties, ReactNode } from "react";
import { C } from "../../theme/colors";

/** The pill's ground. The attachment chip's teal wash — this column's established "something rode
 *  along with this message" tint — at the one opacity every mention surface shares. */
export const MENTION_PILL_FILL = `color-mix(in srgb, ${C.teal} 18%, transparent)`;

/**
 * The shape, minus anything positional.
 *
 * TINTED, NOT BORDERED — the same call the user's bubble makes: a fill is already a shape, and a
 * hairline around something this small at 13px reads as noise.
 *
 * `whiteSpace: nowrap` is load-bearing rather than cosmetic. An agent address is two or three words
 * ("@Blueprint UI/UX", "@Docs (mobile)"), and a pill broken across a line wrap stops reading as one
 * object — which matters most in the composer, where the whole point of the pill is that the user
 * can see at a glance that those words are an ADDRESS and not prose.
 */
export const MENTION_PILL_STYLE: CSSProperties = {
  background: MENTION_PILL_FILL,
  // `pillInk`, NOT `cream` — a pill's label is neutral and never follows a row's de-emphasis.
  // See C.pillInk for the rule and the bug that produced it (bead sparkle-s6gonk).
  color: C.pillInk,
  borderRadius: 4,
  padding: "1px 4px",
  whiteSpace: "nowrap",
};

/**
 * One drawn mention.
 *
 * `testId` defaults to the sent-bubble's id, which is what every existing query for a mention pill
 * reads. The composer passes its OWN id, deliberately: the two surfaces are on screen at the same
 * time (a draft in the box under a thread of sent messages), so a single shared id would make
 * `getByTestId` ambiguous exactly when a test is checking one of them.
 */
export function MentionPill({
  agentId,
  testId = "concierge-mention-pill",
  style,
  children,
}: {
  /** Which agent this addresses. Surfaced on the element so a test — and a human with the
   *  inspector — can tell WHICH agent a pill names, not merely that a pill is there. */
  agentId: string;
  testId?: string;
  /** Extra properties for the surface's own needs; never a replacement for the shared shape. */
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <span
      data-testid={testId}
      data-agent-id={agentId}
      style={{ ...MENTION_PILL_STYLE, ...style }}
    >
      {children}
    </span>
  );
}
