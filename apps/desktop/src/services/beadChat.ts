// apps/desktop/src/services/beadChat.ts
// "Chat about this bead" — the dispatch behind the bead card's Chat button (bead sparkle-1cpomd).
//
// The founder's ask, verbatim: *"a Chat button in the TOP RIGHT of every bead card, task or epic,
// in the same blue as Build It. Clicking it prefills the concierge compose window with 'RE: [@bead
// name] ...' so a chat is ready that references that epic or task."*
//
// ══ THE TEXT IS A MENTION LITERAL, NOT A MARKDOWN LINK ═════════════════════════════════════════
// The pill the founder sees in the sent bubble is drawn because the mention is RECORDED FROM THE
// TEXT — `scanMentions`/`mentionsIn` re-derive the aim by matching `@<label>` against the roster on
// every keystroke, which is `mentions.ts`'s founding rule. So the ONLY thing that produces a pill is
// the exact literal `insertMention` would have written had the user picked the bead out of the
// picker himself: `MENTION_SIGIL + beadMentionLabel(title, id)`. Writing a second, prettier format
// here — `[@Title](sparkle-bead:id)` is the tempting one — buys nothing and loses twice over: the
// roster match fails so no mention is recorded, AND a sent USER bubble does not render markdown, so
// the founder is shown raw brackets and parentheses instead of the reference he asked for.
//
// ══ THE TRAILING SPACE IS LOAD-BEARING ════════════════════════════════════════════════════════
// `insertMention`'s docstring states why and it applies identically here: the space terminates the
// mention so the next character typed cannot extend the label into something that matches no
// referent (which, under the derive-from-text rule, silently drops the aim), and it puts the caret
// where the founder's next word goes. He is about to type the rest of the sentence — "RE: @Foo" with
// the caret jammed against the label is a composer he has to fix before he can use it.
import { useComposeHandoffStore } from "../stores/composeHandoffStore";
import { MENTION_SIGIL, beadMentionLabel } from "../components/Concierge/mentions";
import type { Bead } from "./beads";
import { log } from "../logger";

/** The draft the button writes. Exported so the button's tests and the composer's can assert the
 *  SAME string rather than two hand-copied spellings of it drifting apart. */
export function beadChatDraft(bead: Bead): string {
  return `RE: ${MENTION_SIGIL}${beadMentionLabel(bead.title, bead.id)} `;
}

/**
 * Hand the concierge compose box a draft that already references `bead`, ready for the founder to
 * finish the sentence and send. Nothing is sent, no agent is created, selected or touched.
 *
 * `route: "sparkle"` is REQUIRED, for exactly the reason `captureSends.ts`'s `dispatchChat` states
 * (captureSends.ts:197-199): without it the concierge's auto-router classifies the draft like any
 * other message and can aim it at whatever build agent happens to be on screen. That destination is
 * precisely the one the user declined — he pressed Chat, next to a Build It button he did not press.
 *
 * NO `focusThisWindow()`, unlike the capture path. Capture dispatches from the capture window into
 * a window that may be hidden; this click already happened in the window that owns the composer, and
 * the handoff's consumer (ConciergeHost) calls `requestComposeFocus()` on delivery. Raising the
 * window the user is already looking at is at best a no-op and at worst steals focus back from
 * something they alt-tabbed to.
 */
export function dispatchBeadChat(bead: Bead, projectId: string): void {
  const text = beadChatDraft(bead);
  useComposeHandoffStore.getState().set({
    origin: "bead-chat",
    projectId,
    text,
    attachments: [],
    route: "sparkle",
  });
  // Mirrors dispatchChat's line. The bead ID, never the title: this log ships with support tickets
  // and a title is the user's prose.
  log.info("beads", "bead→chat handed off to the concierge compose box", {
    projectId,
    beadId: bead.id,
    chars: text.length,
  });
}
