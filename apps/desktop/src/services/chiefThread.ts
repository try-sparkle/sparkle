// A continuous Chief chat for the Think tab's @chief lane. Bead sparkle-xh4j.
//
// The Think tab used to open a BRAND-NEW Chief chat on every turn, so Chief held no server-side
// history and the entire conversation had to be re-sent each time — bytes grew O(N^2) and long
// sessions tripped Chief's undocumented prompt limit (an opaque 400; see chief.ts:parseOrThrow).
// Holding the chat lets Chief remember its own history, so a turn only carries what's NEW.
//
// The delta is not merely an optimization: Sparkle's turns never enter Chief's server-side history
// on their own — Chief only ever learns what we send it. Shipping the undelivered turns, with their
// speakers attached, is precisely what keeps the two participants aware of each other.
import { selectTurns, selectOldestWithin, type TranscriptMsg } from "./thinkTranscript";
import { ChiefError, isChiefQuotaError, type ChatOptions } from "./chief";

/** A Think-tab chat turn, with the id used to track what Chief has already been told. */
export interface ThreadMsg extends TranscriptMsg {
  id: string;
}

/** The live chat, scoped to the Chief project it belongs to. */
export interface ChiefThreadState {
  chatId: string | null;
  /** The Chief project `chatId` lives in. A chat belongs to exactly one project; carrying this
   *  makes a cross-project reuse impossible rather than merely unlikely. */
  chiefProjectId: string | null;
  /** Ids of turns already conveyed into `chatId`. */
  deliveredIds: string[];
}

export function emptyThread(): ChiefThreadState {
  return { chatId: null, chiefProjectId: null, deliveredIds: [] };
}

export interface ChiefThreadDeps {
  startChat: (
    pat: string,
    projectId: string,
    prompt: string,
    opts?: ChatOptions,
  ) => Promise<{ chat_id: string; message_id: string }>;
  sendMessage: (
    pat: string,
    projectId: string,
    chatId: string,
    prompt: string,
    opts?: ChatOptions,
  ) => Promise<{ message_id: string }>;
  pollForResponse: (
    pat: string,
    projectId: string,
    chatId: string,
    messageId: string,
  ) => Promise<string>;
}

export interface AskChiefArgs {
  pat: string;
  chiefProjectId: string;
  /** The full Think conversation so far (the caller need not track deltas). */
  messages: ThreadMsg[];
  /** The question this turn is asking Chief. */
  question: string;
  /** Id of the message carrying `question`, when it is also present in `messages`. `compose`
   *  restates the question, so that turn is left out of the transcript to avoid sending it twice —
   *  but it is still recorded as delivered, because the restatement conveys it. */
  questionMsgId?: string;
  opts?: ChatOptions;
  /** Appended after the question (e.g. the markdown hint). */
  suffix?: string;
}

/** True when a send failed because the chat itself is gone/expired — the only case a fresh chat
 *  fixes. A 402/429/5xx/network drop, or an oversized prompt (the opaque 400), would be made WORSE
 *  by re-seeding: the new chat carries the FULL conversation, which is the very payload most likely
 *  to have failed in the first place. Those must propagate with their real cause intact. */
function isChatGone(e: unknown): boolean {
  return e instanceof ChiefError && (e.status === 404 || e.status === 410);
}

// Marks an error as one that MIGHT mean the chat is unhealthy: it came from the SEND on a live chat
// (not the poll, which proves the chat is alive and the turn accepted, nor startChat, where there is
// no chat yet), AND its status doesn't already explain itself. Tagged rather than wrapped so the
// original error — and the message the user sees — is preserved.
const SEND_FAILED = Symbol.for("sparkle.chiefThread.sendFailed");

/** Errors that are known NOT to mean the chat is dead, and so must not count toward abandoning it:
 *  a quota/credit/rate-limit condition, or the opaque oversized-prompt 400. Each persists across
 *  turns by its own nature, so counting them would abandon a live chat and push the next turn onto
 *  the full re-seed — a LARGER prompt than the delta that just failed, i.e. the opposite of a remedy
 *  (see {@link isChatGone}). The escape exists for a dead chat reporting an UNKNOWN status.
 *
 *  Quota is delegated to isChiefQuotaError rather than re-listed as statuses, because it recognizes
 *  more than 402/429: chief.ts folds the response detail into the message precisely so quota
 *  language reaches this classifier even when the status is absent or unexpected. A parallel status
 *  list would miss an out-of-credits surfaced as, say, a 503.
 *
 *  The trade, which runs the other way: that classifier's regex matches on MESSAGE TEXT for any
 *  ChiefError, so a genuinely dead chat whose body happens to say "insufficient permissions" or
 *  mentions billing is excluded here and never counts toward the escape — the lane then wedges on
 *  that chat for the life of the panel. We accept it because a false-positive re-seed is the worse
 *  failure (it sends the FULL conversation on every turn, exactly the payload most likely to have
 *  failed), and because the escape is a backstop for an unknown status, not the primary path. But
 *  if a wedged @chief lane is ever reported, suspect the error's WORDING, not just its status. */
function explainsItself(e: unknown): boolean {
  return isChiefQuotaError(e) || (e instanceof ChiefError && e.status === 400);
}

/** Whether this error might mean the held chat is unhealthy. See {@link askChief}. */
export function isSendFailure(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[SEND_FAILED] === true;
}

// Assumes a FRESH error instance per call (parseOrThrow constructs one per response). A shared or
// frozen sentinel would either stay tagged for every later check or throw on assignment — and a
// TypeError raised here would replace the real 402/429/timeout on its way to the user, which is
// exactly the cause-swallowing this tag exists to prevent. So the write is best-effort.
function markSendFailure(e: unknown): void {
  if (typeof e !== "object" || e === null) return;
  if (explainsItself(e)) return;
  try {
    (e as Record<symbol, unknown>)[SEND_FAILED] = true;
  } catch {
    // frozen/sealed — leave it untagged rather than mask the real error with a TypeError
  }
}

function compose(transcript: string, question: string, suffix?: string): string {
  return [transcript, `User asks Chief directly: ${question}`, suffix]
    .filter((p) => p && p.trim())
    .join("\n\n");
}

/**
 * Ask Chief a question on the project's continuing chat, opening one if needed.
 *
 * Returns the reply and the next thread state — callers must persist the returned state, which is
 * how the chat and the delivered set survive to the following turn.
 */
export async function askChief(
  deps: ChiefThreadDeps,
  state: ChiefThreadState,
  args: AskChiefArgs,
): Promise<{ reply: string; state: ChiefThreadState }> {
  const { pat, chiefProjectId, messages, question, questionMsgId, opts, suffix } = args;

  // A chat is only reusable within the project it was opened in.
  const live = state.chatId !== null && state.chiefProjectId === chiefProjectId;
  const delivered = live ? state.deliveredIds : [];
  const seen = new Set(delivered);
  // `compose` restates the question, so its own turn is not also rendered into the transcript.
  const conveyed = (m: ThreadMsg) => m.id === questionMsgId;
  const candidates = messages.filter((m) => !seen.has(m.id) && !conveyed(m));
  // The question turn is delivered by the restatement whether or not it is in the transcript.
  const restated = messages.filter((m) => conveyed(m) && !seen.has(m.id)).map((m) => m.id);

  if (live) {
    // Only the SEND is guarded, and only for a chat that is GONE. A POLL failure means the turn was
    // already accepted and the chat is alive — re-seeding there would duplicate it.
    let messageId: string | null = null;
    // deliveredIds must come from what the transcript actually KEPT: an over-budget delta can't
    // send everything, and recording the rest as sent would lose it from Chief's history forever.
    //
    // Chronological, not newest-first: Chief APPENDS each delta to its own running history, so
    // draining a backlog newest-first would leave it reading older turns as the most recent thing
    // said. What doesn't fit stays undelivered and goes next turn, in order. The current question
    // still always arrives — `compose` restates it — so nothing is lost by not front-loading it.
    const { text, kept } = selectOldestWithin(candidates);
    try {
      ({ message_id: messageId } = await deps.sendMessage(
        pat,
        chiefProjectId,
        state.chatId!,
        compose(text, question, suffix),
        opts,
      ));
    } catch (e) {
      if (!isChatGone(e)) {
        markSendFailure(e); // the chat may be unhealthy — let the caller judge over repeats
        throw e;
      }
      console.warn("chief chat gone — reopening", e);
      messageId = null;
    }
    if (messageId !== null) {
      const reply = await deps.pollForResponse(pat, chiefProjectId, state.chatId!, messageId);
      return {
        reply,
        state: {
          chatId: state.chatId,
          chiefProjectId,
          deliveredIds: [...delivered, ...kept.map((m) => m.id), ...restated],
        },
      };
    }
  }

  // No usable chat: open one. It knows nothing, so it is seeded from the WHOLE conversation.
  const fresh = selectTurns(messages.filter((m) => !conveyed(m)));
  const { chat_id, message_id } = await deps.startChat(
    pat,
    chiefProjectId,
    compose(fresh.text, question, suffix),
    opts,
  );
  const reply = await deps.pollForResponse(pat, chiefProjectId, chat_id, message_id);
  return {
    reply,
    state: {
      chatId: chat_id,
      chiefProjectId,
      deliveredIds: [...fresh.kept.map((m) => m.id), ...messages.filter(conveyed).map((m) => m.id)],
    },
  };
}
