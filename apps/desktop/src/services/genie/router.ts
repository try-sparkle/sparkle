// The genie's entry point: one transcript in, one structured response out. Bead sparkle-uz87.5.
//
// `routeGenieIntent` is the ONLY function the overlay (sparkle-uz87.7) needs. It classifies, guards,
// dispatches to a handler, and guarantees a response — there is no path out of here that throws and
// no path that returns nothing, because the caller is a UI that has already shown the user a
// listening swarm and must put SOMETHING in the bubble.
//
// THREE GUARANTEES, each with a test that fails if it is removed:
//
//   1. LOW CONFIDENCE FALLS TO CHAT. A rule that matched its verb but filled no slots ("search",
//      full stop) scores below GENIE_CONFIDENCE_FLOOR and is routed to `chat` instead of
//      dispatching an empty action. The reported `confidence` still shows the low score, so the
//      caller can tell this apart from a confident chat.
//   2. A THROWING HANDLER CANNOT ESCAPE. Handlers are ordinary code that will eventually touch
//      stores; one of them will throw, and when it does the overlay must not unmount behind an
//      error boundary. A throw (sync OR a rejected promise — both are tested) becomes a response
//      that keeps the classified intent, so the caller knows what was ATTEMPTED, and carries NO
//      action, because nothing happened.
//   3. A STALE UTTERANCE TAKES NO ACTION. This is why the clock is injected and why `GenieRequest`
//      carries `at`. Voice capture and routing are not the same instant: a transcript can sit
//      behind a queued turn, a suspended machine, or a dropped websocket. "Start an agent on the
//      auth bug" is not a sentence that should still fire minutes after it was said, and the user
//      is no longer watching to stop it. Past GENIE_STALE_MS the router answers in text and calls
//      NO handler at all — so the guard is observable as an absence of side effect, not just as
//      different copy.
//
// NEVER SPEAKS. Text-to-speech was deliberately removed from this product (commit f24324e6b). This
// module returns strings for the overlay to paint and touches no audio API — asserted mechanically
// by `genie.noSpeech.test.ts` over the source of this directory.
import { classifyTranscript, type GenieClassification } from "./classify";
import { defaultGenieHandlers, type GenieHandlerMap } from "./handlers";
import type { GenieRequest, GenieResponse } from "./types";

/**
 * Below this, a classified intent is not trusted and the request is answered as chat. Sits above
 * GENIE_CONFIDENCE_WEAK (0.35) and below GENIE_CONFIDENCE_STRONG (0.9); the comparison is strict
 * `<`, so a classification scoring exactly the floor is TRUSTED.
 */
export const GENIE_CONFIDENCE_FLOOR = 0.4;

/**
 * How old a captured transcript may be before the router refuses to act on it. One minute: long
 * enough that no ordinary turn — including a slow classify and a queued handler — trips it, short
 * enough that a resumed machine or a drained queue never fires a stale side effect at a user who
 * has stopped watching.
 */
export const GENIE_STALE_MS = 60_000;

export interface GenieRouterDeps {
  /** Substitute the handler map in tests. Omit it and the REAL map is used — see handlers.ts. */
  handlers?: GenieHandlerMap;
  /** Substitute the classifier in tests. Omit it and the real rules classifier is used. */
  classify?: (transcript: string) => GenieClassification;
  /** Injected clock. Omit it and `Date.now` is used. */
  now?: () => number;
}

/** Age of a request at routing time. Negative skew (a capture stamped in the future by a jittery
 *  clock) reads as age <= 0, i.e. FRESH — never as an enormous staleness. */
function ageMs(at: number, now: number): number {
  return now - at;
}

export async function routeGenieIntent(
  request: GenieRequest,
  deps: GenieRouterDeps = {},
): Promise<GenieResponse> {
  const classify = deps.classify ?? classifyTranscript;
  const handlers = deps.handlers ?? defaultGenieHandlers;
  const now = deps.now ?? Date.now;

  const classification = classify(request.transcript);

  if (ageMs(request.at, now()) > GENIE_STALE_MS) {
    return {
      intent: "chat",
      replyText: "That was a while ago, so I didn't act on it. Say it again and I will.",
      confidence: classification.confidence,
    };
  }

  const intent =
    classification.intent !== "chat" && classification.confidence < GENIE_CONFIDENCE_FLOOR
      ? "chat"
      : classification.intent;

  const handler = handlers[intent];
  try {
    return await handler({ request, classification, at: now() });
  } catch {
    // Deliberately swallowed: see guarantee 2 above. The intent is kept so the caller can tell the
    // user what was attempted; the action is dropped because nothing happened.
    return {
      intent,
      replyText: "Something went wrong handling that. Nothing changed — want to try again?",
      confidence: classification.confidence,
    };
  }
}
