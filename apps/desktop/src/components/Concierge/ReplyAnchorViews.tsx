// THE TWO HALVES OF REPLY ANCHORING, drawn.
//
// `ReplyAnchorStubs` sits ABOVE a concierge reply and quotes the message(s) it is answering, the way
// iMessage shows the original above a reply. `AnsweredMarker` sits under the USER'S OWN message and
// says the answer is further down.
//
// THE MARKER IS THE HALF THAT ACTUALLY FIXES THE COMPLAINT, and it is worth saying why both exist. The
// founder is not looking at the reply when he says "I've sent you, like, 10 messages and not gotten a
// response" — he is looking at his own messages, sitting in the column with nothing under them. A stub
// over the reply is only legible once you have found the reply. The marker is what makes an answered
// message look answered from where he actually is.
//
// Neither carries an `aria-live` region. The concierge column has exactly ONE (see types.ts
// `ConciergeAnnouncement`); a second one here is the double-announcement roborev 52648/53010/53088
// were about. Both are plain buttons with accessible names, which is what a jump affordance needs.
import { FiCornerDownRight } from "react-icons/fi";
import { C } from "../../theme/colors";
import { TYPE } from "../../theme/scale";
import type { ReplyAnchor } from "./replyAnchors";

export const REPLY_ANCHOR_TESTID = "reply-anchor";
export const ANSWERED_MARKER_TESTID = "answered-marker";

/** How long a jumped-to message stays lit. Long enough to find it after a smooth scroll settles,
 *  short enough that it doesn't become a second kind of persistent state in the thread. */
export const ANCHOR_HIGHLIGHT_MS = 1600;

/** The recessed quote's chrome, shared by the clickable and the un-clickable form so a stub whose
 *  target aged out is the same object minus the affordance — not a different-looking one. */
const stubStyle = {
  display: "block",
  maxWidth: "100%",
  textAlign: "left" as const,
  fontFamily: "inherit",
  fontSize: TYPE.small,
  color: C.conciergeMuted,
  background: "transparent",
  border: "none",
  // The iMessage idiom: a bar down the left of the quoted original, not a box around it. A box would
  // read as a card — another thing in the column — where this has to read as a margin note.
  borderLeft: `2px solid color-mix(in srgb, ${C.muted} 45%, transparent)`,
  borderRadius: 0,
  padding: "0 0 0 7px",
  margin: 0,
  // ONE LINE, always. `pendingAnchors` already collapses and caps the string; this is the second half
  // of the same promise, for a quote that is short enough to store but still wider than the column.
  whiteSpace: "nowrap" as const,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/**
 * The quoted originals above a reply, in the order the user SENT them.
 *
 * Renders nothing at all for a reply that answers nothing — a push, or the first line of a session.
 * An empty container would still cost a gap in the thread's flex column.
 */
export function ReplyAnchorStubs({
  anchors,
  onJump,
}: {
  anchors?: readonly ReplyAnchor[];
  /** Scroll to and briefly light up the quoted message. */
  onJump?: (id: string) => void;
}) {
  if (!anchors?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 5, minWidth: 0 }}>
      {anchors.map((a, i) =>
        // NO TARGET LEFT TO JUMP TO. The message aged out of the persisted thread (see
        // replyAnchors.remapAnchors), so the quote is still a true record of what was asked and the
        // reply still says what it answered — but a button that scrolls nowhere is the dead
        // affordance this column's rules are written against. It degrades to text, not to nothing.
        a.id && onJump ? (
          <button
            // Index as key: these are positional slices of one immutable array on a message that,
            // once settled, never re-renders with different content.
            key={i}
            type="button"
            data-testid={REPLY_ANCHOR_TESTID}
            data-anchor-id={a.id}
            onClick={() => onJump(a.id)}
            // The full text is capped at 120 chars, so the title is the recoverable half of a quote
            // the column was too narrow to show.
            title={a.quote}
            aria-label={`Replying to: ${a.quote}. Show that message.`}
            style={{ ...stubStyle, cursor: "pointer" }}
          >
            {a.quote}
          </button>
        ) : (
          <div key={i} data-testid={REPLY_ANCHOR_TESTID} data-anchor-id="" title={a.quote} style={stubStyle}>
            {a.quote}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Under the user's own bubble: this one WAS answered, and the answer is below.
 *
 * Deliberately quiet — muted, 12px, right-aligned to sit with the routing receipt rather than compete
 * with it. It is a navigational fact, not a status badge; a message with no marker is simply one
 * nothing has replied to yet, which is the state it already looks like.
 */
export function AnsweredMarker({ replyId, onJump }: { replyId: string; onJump?: (id: string) => void }) {
  if (!onJump) return null;
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
      <button
        type="button"
        data-testid={ANSWERED_MARKER_TESTID}
        data-reply-id={replyId}
        onClick={() => onJump(replyId)}
        aria-label="Answered below. Show the reply."
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontFamily: "inherit",
          fontSize: TYPE.small,
          color: C.conciergeMuted,
          background: "transparent",
          border: "none",
          padding: 0,
          cursor: "pointer",
        }}
      >
        <FiCornerDownRight size={11} aria-hidden />
        Answered below
      </button>
    </div>
  );
}
