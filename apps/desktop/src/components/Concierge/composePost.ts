// THE "WRITE A POST" ENTRY POINT — the pure half.
//
// The founder's ask (2026-08-20, bead sparkle-131ms.10): "the ability to post socially from
// Sparkle … to have the ability next to the screenshot button. To create a post that would post
// out socially." So this is a control in the composer's icon cluster, beside Screenshot, that puts
// the user ONE STEP INTO writing a post — nothing more.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────────────────────────────
// It never publishes and never sends. The compose surface for this epic is the concierge chat
// itself (bead sparkle-131ms.6, confirmed 2026-08-13 — chat-only, no dedicated compose UI), and
// publishing is gated behind an approval card owned by that same bead. Seeding the box's own text
// is the whole behaviour: the user still reads, edits, and presses Send. A synthetic send would
// hand the model words the user never chose to say, and would step over the approval gate that is
// the only thing standing between a draft and something leaving the machine.
//
// ── THE COPY IS DESTINATION-NEUTRAL, ON PURPOSE ────────────────────────────────────────────────
// "post out socially" has not been pinned down to a destination: it may mean the configured
// destination MCP (what this epic delivers today) or genuine social networks (bead
// sparkle-131ms.9, an explicit v2 that reopens the one-destination decision). Naming a network
// Sparkle cannot reach would be a lie in the UI, and this repo treats user-facing copy as code —
// so the label says what the button DOES ("write a post"), never where it would land. That is the
// same rule the placeholder already follows: see the "nothing here NAMES A DESTINATION" note in
// ComposeBox's header, where the host routes per message and the box cannot promise a target
// before anything is written.

/** The hover tooltip AND the accessible name — one string, matching the attach buttons beside it. */
export const COMPOSE_POST_LABEL = "Write a post";

/** The keyboard-hint id. Its mnemonic lives in CHROME_HINTS (keyboardHints/hintTargets), like the
 *  two attach buttons it sits with — carried as a constant so the button and the mnemonic table
 *  cannot drift apart on a rename. */
export const COMPOSE_POST_HINT = "compose-post";

/**
 * What lands in the box.
 *
 * Addressed to Sparkle in the first person, because the box's send is ROUTED (services/
 * conciergeRouter) — this is the opening line of a conversation, not a command string. It is a
 * PROMPT rather than a draft post: seeding placeholder post copy would put words in the user's
 * mouth, and the one thing the user has actually told us by pressing this button is that they want
 * to write one.
 *
 * No destination in it, for the reason in the header.
 */
export const COMPOSE_POST_PROMPT = "Help me write a post to share.";

/**
 * The box's next text + caret after the button is pressed.
 *
 * REPLACE-ONLY-IF-EMPTY, append on a new line otherwise — the same rule `Composer.insertPrompt`
 * and `appendDictated` already use for pushing text into a composer someone may be mid-draft in.
 * A draft is the user's typing; clobbering it to seed a prompt would destroy work on a mis-click,
 * and this button is one pixel-slip away from Screenshot.
 *
 * Pure, and exported for the reason this file's siblings are (cf. `toolbarShowsLabels`): the rule
 * is testable without rendering, so the render test is free to assert the DOM relationship the
 * founder actually asked about.
 */
export function seedComposePost(current: string): { text: string; caret: number } {
  const draft = current.trimEnd();
  const text = draft === "" ? COMPOSE_POST_PROMPT : `${draft}\n${COMPOSE_POST_PROMPT}`;
  return { text, caret: text.length };
}
