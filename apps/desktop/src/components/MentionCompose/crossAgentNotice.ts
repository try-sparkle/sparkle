// WATCHING @improve ↔ @sparkle TALK — the compact one-line notice the concierge pane shows.
//
// The founder wants to SEE the two agents coordinate without relaying between them (bead
// sparkle-hdlhox). When one pings the other about a bead, the concierge pane shows a single line:
//
//   Improve Sparkle just asked for my feedback on sparkle-hdlhox: "should PR #2153 supersede…"
//   Concierge just requested Improve Sparkle's feedback on sparkle-hdlhox: "take a look at the…"
//   Improve Sparkle just responded on sparkle-hdlhox: "agreed — I'll hold the artifact fixes."
//
// ══ BEADS IS THE MESSAGE; THE INBOX IS ONLY A DOORBELL ═════════════════════════════════════════════
// The full text lives in the BEAD COMMENT the agent wrote, not in the inbox (which only signals that
// something happened). So this module's input is a bead-comment envelope, and the preview is built
// from the comment BODY. The beads store is polled every ~5s, so a new comment surfaces on its own.
//
// This file is PURE (no React, no store, no Tauri): given one envelope it produces one view-model.
// That is what lets the verb selection and the truncation be unit-tested — and mutation-tested —
// without a rendered tree or a live store.

/**
 * What kind of cross-agent turn this is. Sourced from the backend message envelope (the backend
 * agent owns the field; this is the shape the frontend maps in ONE place — see `noticeFrom`).
 *   • request   — one agent asked the other for feedback / review.
 *   • response  — one agent answered a prior request.
 *   • challenge — one agent pushed back on the other's position.
 */
export type MentionInteraction = "request" | "response" | "challenge";

/** Which of the two reserved agents authored the comment. */
export type MentionSender = "improve" | "sparkle";

/**
 * A cross-agent mention, normalized from a bead comment. The detection layer (`useCrossAgentMentions`,
 * via `parseCrossAgentComment`) builds these from the thread bead's comments; this module never
 * touches the store itself.
 */
export interface CrossAgentMention {
  /** Stable id (the bead comment id) — for de-duping already-seen notices. */
  id: string;
  /** Who wrote it. */
  from: MentionSender;
  /** Request / response / challenge. */
  interaction: MentionInteraction;
  /** The bead the feedback is ABOUT — the click-target. */
  beadId: string;
  /** The comment body — the source of the preview. */
  body: string;
  /** When it was written (ms epoch), for ordering. Optional; absent sorts oldest. */
  ts?: number;
}

/** The rendered notice: a sentence in parts, so the bead id can be a click-target on its own. */
export interface MentionNoticeView {
  id: string;
  from: MentionSender;
  /** The sender's display name — "Improve Sparkle" or "Concierge". */
  senderName: string;
  /** The verb phrase — "asked for my feedback", "requested Improve Sparkle's feedback", "responded",
   *  "challenged". */
  verb: string;
  beadId: string;
  /** The body, flattened to one line and capped. */
  preview: string;
}

export const IMPROVE_DISPLAY = "Improve Sparkle";
export const CONCIERGE_DISPLAY = "Concierge";

/** The default preview cap. ~100 chars keeps the notice to one compact line. */
export const PREVIEW_CAP = 100;

/** The sender's display name. The concierge is "Concierge" (it is speaking in the pane); the other
 *  agent is "Improve Sparkle". */
export function senderDisplayName(from: MentionSender): string {
  return from === "improve" ? IMPROVE_DISPLAY : CONCIERGE_DISPLAY;
}

/**
 * The verb phrase for a (sender, interaction) pair.
 *
 * A REQUEST reads differently depending on who asked, and both match the founder's own wording:
 *   • Improve → the concierge: "asked for my feedback" (the pane is the concierge's voice, so "my").
 *   • Concierge → Improve:     "requested Improve Sparkle's feedback".
 * A RESPONSE is "responded" from either side; a CHALLENGE is "challenged".
 */
export function verbFor(from: MentionSender, interaction: MentionInteraction): string {
  switch (interaction) {
    case "request":
      return from === "improve" ? "asked for my feedback" : "requested Improve Sparkle's feedback";
    case "response":
      return "responded";
    case "challenge":
      return "challenged";
  }
}

/**
 * Flatten to one line and cap at `cap` characters, appending an ellipsis when anything was dropped.
 *
 * Flattening first is deliberate: a comment body carries newlines, and a raw slice of a multi-line
 * string paints as several lines inside a control meant to be ONE line. The cap counts the flattened
 * length, so the ellipsis reflects what the reader actually sees.
 */
export function truncatePreview(body: string, cap: number = PREVIEW_CAP): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= cap) return flat;
  return flat.slice(0, cap).trimEnd() + "…";
}

/** Build the view-model for one cross-agent mention. */
export function buildNotice(m: CrossAgentMention, cap: number = PREVIEW_CAP): MentionNoticeView {
  return {
    id: m.id,
    from: m.from,
    senderName: senderDisplayName(m.from),
    verb: verbFor(m.from, m.interaction),
    beadId: m.beadId,
    preview: truncatePreview(m.body, cap),
  };
}
