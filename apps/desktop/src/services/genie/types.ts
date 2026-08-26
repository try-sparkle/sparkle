// Genie intent-routing types — bead sparkle-uz87.5, epic sparkle-uz87 (Living Sparkle Overlay).
//
// THE SHAPE OF AN ANSWER. A transcript goes in; a `GenieResponse` comes out. That response carries
// reply TEXT and, at most, one ACTION for the caller to perform. It carries no audio, no voice, no
// utterance and no handle to anything that could produce one — TEXT-TO-SPEECH WAS DELIBERATELY
// REMOVED FROM THIS PRODUCT (commit f24324e6b) and this module must not be the door it comes back
// through. `genie.noSpeech.test.ts` asserts that mechanically over the source of this directory,
// because a comment saying "don't" has never stopped anyone.
//
// WHY `GenieAction` IS A DISCRIMINATED UNION AND NOT A BAG OF OPTIONAL FIELDS. The consumer
// (sparkle-uz87.7, overlay wiring) has to DO something with this — open a project, start an agent,
// set a reminder — and each of those needs different data. A union on `kind` means the consumer
// writes one `switch` and the compiler tells them when a variant is unhandled. In this repo that
// exhaustive `switch` is the ONLY real tie between the union and its handlers: TypeScript cannot
// enumerate a union's members at runtime, so a test that counts variants (`arr.length === 7`) is a
// tautology that passes whatever the union actually says. The tie is `describeGenieAction`'s
// `const _exhaustive: never = action` in handlers.ts — add a variant without handling it and
// `tsc --noEmit` fails.

/** Every category the rules classifier can land on. `chat` is the explicit fallback, never a gap. */
export type GenieIntent =
  | "search"
  | "remind"
  | "summarize"
  | "navigate"
  | "dispatch"
  | "status"
  | "chat";

/** How wide a summary or a status question reaches. */
export type GenieScope = "fleet" | "agent" | "project" | "unspecified";

/** What a navigation request is pointing AT — the three things this app can put on screen. */
export type GenieNavTargetKind = "project" | "agent" | "screen";

/**
 * The one side effect a response may ask for. `chat` produces none — silence is a legal answer, and
 * that is the point: an utterance the genie did not understand must never take an action.
 *
 * `dispatch` splits into two kinds rather than one kind with a `mode` field, because starting a NEW
 * agent and messaging an EXISTING one need different data (there is no agent to name in the first
 * case) and the consumer's `switch` should be forced to notice that.
 */
export type GenieAction =
  | { kind: "search"; query: string }
  | { kind: "remind"; what: string; whenText: string | null }
  | { kind: "summarize"; subject: string; scope: GenieScope }
  | { kind: "navigate"; targetKind: GenieNavTargetKind; target: string }
  | { kind: "dispatch-start"; brief: string }
  | { kind: "dispatch-message"; agent: string; message: string }
  | { kind: "status"; scope: GenieScope; target: string | null };

/** One heard utterance. `at` is when it was CAPTURED, which is not when it is routed — see the
 *  staleness guard in router.ts, which is the reason this field exists at all. */
export interface GenieRequest {
  transcript: string;
  /** Epoch ms at capture. */
  at: number;
}

export interface GenieResponse {
  intent: GenieIntent;
  /** What the overlay shows. Shown, never spoken. */
  replyText: string;
  /**
   * How sure the CLASSIFIER was — not how sure the handler is. It is reported even when the router
   * has overridden the intent (a low-confidence `search` becomes `chat` but still reports 0.35), so
   * a caller can tell "confidently chat" from "gave up and fell back".
   */
  confidence: number;
  action?: GenieAction;
}
