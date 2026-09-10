// personMessaging — SEND A CHAT MESSAGE TO A HUMAN, addressed by `@name` in the concierge composer.
//
// ══ WHAT THIS IS FOR ══════════════════════════════════════════════════════════════════════════
// The founder's own words for the deferred feature (design line 41) are "`@mention`ing a username
// **to send a message**". So `@Ada` is not decoration on a message body — it is the ADDRESS, and
// this module is what the address resolves to. `Concierge/composerRoute` classifies a leading
// `@person` as `{kind: "person"}` and `ConciergeHost` calls this; nothing else does.
//
// ══ WHY IT IS NOT `dispatchConciergeAnswer` ═══════════════════════════════════════════════════
// That function is documented as the single door into a LOCAL PTY, and design §8 R3 forbids a
// chat message reaching an agent's stdin in either direction. A person has no terminal to type
// into: the destination is the server, and the transport is HTTP. `dispatchConciergeAnswer`
// refuses a `person:` id outright for exactly this reason (bead sparkle-6baj6s) — the two paths are
// disjoint by construction, and this module is the OTHER one.
//
// ══ TWO CALLS, AND THE FIRST IS NOT SKIPPABLE ═════════════════════════════════════════════════
// `createConversation` is documented as "the only way to obtain a conversation id for someone you
// have no thread with", and it is the choke point where the SERVER runs `canMessage`: a stranger
// gets a conversation whose recipient participant is `requested`, a connection gets one `active`,
// and a blocked sender gets a 403 with no row created. It is idempotent via the `dm_key` index, so
// calling it on every send is correct rather than wasteful — there is no local cache that could go
// stale, and a cache here would be a second, laxer notion of who may be messaged.
//
// It follows that THIS MODULE NEVER DECIDES WHO MAY BE MESSAGED. It cannot: `canMessage` reads the
// connection graph and the block flags, which live server-side and are the one authority. A
// client-side pre-check would be a copy of that rule that drifts, and drifting toward permissive
// is how a blocked sender gets a send affordance. A refusal comes back as a `SocialApiError` and
// is reported, never predicted.
import { log } from "../logger";
import {
  createConversation,
  sendMessage,
  SocialApiError,
  SocialNetworkError,
} from "./socialApi";
import { useSocialStore } from "../stores/socialStore";
import { personName } from "../stores/socialStore";

/** What a send did. A VALUE rather than a throw, mirroring `engine/chatThread.ChatSendResult` and
 *  for the same reason: a failed send must leave the founder's words on screen, and an exception
 *  crossing a submit handler is how they get lost instead. */
export type SendDirectMessageResult =
  | { ok: true; conversationId: string }
  /** `reason` is a SENTENCE FOR THE FOUNDER, already resolved against the failure — never a code.
   *  The caller posts it verbatim, so a caller cannot accidentally render a raw 403. */
  | { ok: false; reason: string };

/** The two transport calls, injected so a test can drive this without a network — and injected as
 *  a whole object with a default, so the production wiring is ONE expression a test can also
 *  assert (see the "defaulted seam" note in AGENTS.md: when every test passes its own deps, the
 *  line supplying the real value is covered by nothing). */
export interface PersonMessagingDeps {
  createConversation: typeof createConversation;
  sendMessage: typeof sendMessage;
  /** The dedupe key generator. `sendMessage`'s `client_msg_id` is unique per conversation
   *  server-side, so a timeout-retry carrying the SAME id is a no-op returning the original row
   *  rather than a duplicate message. Injected only so a test can pin a stable id. */
  newClientMsgId: () => string;
}

export const REAL_PERSON_MESSAGING_DEPS: PersonMessagingDeps = {
  createConversation,
  sendMessage,
  newClientMsgId: () => crypto.randomUUID(),
};

/**
 * Send `body` to the person with `socialId`. Never throws.
 *
 * `socialId` rather than a username because that is what the mount id carries, and §6.1 is explicit
 * that the mount key is NOT the username precisely so a rename cannot orphan a thread. The username
 * is looked up at send time from the roster the app already holds — so a send addressed a moment
 * before a rename still reaches the right person, and one addressed at somebody the roster no
 * longer knows fails HERE with a sentence rather than at the server with a 404.
 */
export async function sendDirectMessage(
  socialId: string,
  body: string,
  deps: PersonMessagingDeps = REAL_PERSON_MESSAGING_DEPS,
): Promise<SendDirectMessageResult> {
  // Whitespace is not a message. Checked here as well as at the composer because this is a service
  // with more than one prospective caller, and an empty `text` block is a row the server would
  // happily store and every reader would render as a blank bubble.
  const text = body.trim();
  if (text === "") return { ok: false, reason: "There was nothing to send." };

  const person = useSocialStore.getState().people[socialId];
  if (!person) {
    // Not a crash and not a retry: the roster genuinely does not know this id. The likeliest cause
    // is a person removed between the composer resolving the pill and the founder pressing send.
    return { ok: false, reason: "I don't have that person in your chat list any more." };
  }
  const who = personName(person);

  try {
    const convo = await deps.createConversation(person.username);
    await deps.sendMessage(convo.id, {
      clientMsgId: deps.newClientMsgId(),
      blocks: [{ kind: "text", text }],
    });
    return { ok: true, conversationId: convo.id };
  } catch (err) {
    return { ok: false, reason: failureSentence(err, who) };
  }
}

/**
 * The founder-facing sentence for a failed send.
 *
 * Every arm says the message did NOT go and, where there is one, names an action that is safe under
 * the condition that produced the failure (AGENTS.md: a remedy string is an instruction the user
 * will follow). Note which arms deliberately offer NO remedy: a block and a spent trial are
 * decisions, and "try again" at either is an instruction that cannot succeed.
 */
function failureSentence(err: unknown, who: string): string {
  if (err instanceof SocialNetworkError) {
    // The server was never reached, so nothing was decided — the one arm where a retry is genuinely
    // the right advice.
    return `I couldn't reach the server, so that didn't go to ${who} — your words are still here.`;
  }
  if (err instanceof SocialApiError) {
    switch (err.code) {
      case "blocked":
        return `${who} isn't accepting messages from you, so I didn't send that.`;
      case "not_connected":
        return `You're not connected to ${who} yet, so I didn't send that — send a connection request first.`;
      case "trial_spent":
        return `Your free trial is spent, so I couldn't send that to ${who}.`;
      default:
        // 403 with no code is the block/permission shape the server may render without one, so it
        // is named separately from the generic arm rather than folded into it.
        if (err.status === 403) return `You're not allowed to message ${who}, so I didn't send that.`;
        if (err.status === 404) return `I couldn't find ${who} on the server, so that didn't send.`;
        return `The server refused that message to ${who}, so it didn't send.`;
    }
  }
  // An unknown throw. Say the honest thing and invent no remedy — the log carries the diagnosis.
  log.warn("social", "unexpected failure sending a direct message", { err: String(err) });
  return `Something went wrong on my side, so that didn't go to ${who}.`;
}
