// Every sentence the chat surfaces say to a person, in one place.
//
// User-facing copy is code (AGENTS.md): a fix that changes WHEN something happens has to update
// every string that described the old behaviour, and strings scattered through components are how
// one of them gets missed. Keeping them here also means a test can assert on the CONSTANT rather
// than on a literal it retypes — a test that retypes the string passes after a reword that broke
// the screen.
//
// Design: `docs/superpowers/specs/2026-08-05-social-coding-design.md`. Bead `sparkle-xnjil.10`.

/**
 * THE NO-TRANSPORT STATE, and it is deliberately not phrased as an error.
 *
 * The pane is real and mounted before the server half (S4) exists, and the honest thing to say
 * then is that messaging is not connected yet — not "no messages", which is what an empty thread
 * would imply and which is a claim about the conversation rather than about the app. A remedy
 * message is an instruction the reader will follow, so this one deliberately asks for nothing:
 * there is no action the user can take to connect it.
 */
export const CHAT_UNWIRED_TITLE = "Messaging isn't connected yet";
export const CHAT_UNWIRED_BODY =
  "This conversation will appear here once Sparkle's messaging service is switched on.";

/** A thread that has loaded and genuinely holds nothing. Distinct from the above on purpose — one
 *  says the app cannot carry a message, the other says nobody has sent one. */
export const CHAT_EMPTY_TITLE = "No messages yet";
export const CHAT_EMPTY_BODY = "Say hello — messages you send appear here.";

export const CHAT_LOADING = "Loading messages…";

/** Prefix for a transport-reported failure, so the reader sees the cause rather than a generic
 *  "something went wrong" that sends them nowhere. */
export const CHAT_ERROR_TITLE = "Couldn't load this conversation";

/** The composer. `%s` is the person's display name or username. */
export function chatComposerPlaceholder(personName: string): string {
  return `Message ${personName}`;
}
export const CHAT_COMPOSER_PLACEHOLDER_UNWIRED = "Messaging isn't connected yet";
export const CHAT_SEND_LABEL = "Send";

/** What a failed bubble says under itself. Short, because it sits inside the thread. */
export const CHAT_SEND_FAILED = "Not delivered";
/** What an unacknowledged bubble says. */
export const CHAT_SENDING = "Sending…";

/** The pane's accessible name. `%s` is the person's name. */
export function chatPaneLabel(personName: string): string {
  return `Chat with ${personName}`;
}

/** Shown in place of the whole pane when the mount id is not a person id. Not an empty render:
 *  a pane that silently paints nothing is indistinguishable from a pane that failed to mount. */
export const CHAT_NO_PERSON = "No conversation selected";
