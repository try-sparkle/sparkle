// The shapes a concierge SEND carries with it, plus the one adapter between two of them.
//
// Extracted verbatim from ConciergeHost, which re-exports `ConciergePromptTarget` so its five test
// importers keep resolving it there. They live together because they are the same story told at three
// moments of one send: who it is aimed at (`ConciergePromptTarget`), what an out-loud address adds to
// that (`ConciergeMentionAim`), and what has to be given back if it fails (`SentQuote`).
import type { ComposeQuote } from "./composeQuote";
import type { ReferencableAgent } from "./conciergeLine";

/**
 * One send's quote, carried WITH that send.
 *
 * `restore` is captured at send time because `useConciergeQuote.restore` is bound to `draftKey`;
 * resolving it later would write to whatever conversation is current then. The pair travels as an
 * argument (through `deliver` to `restoreDraft`) rather than living in a ref, because several sends
 * can be outstanding simultaneously — see `restoreDraft`.
 */
export interface SentQuote {
  quote: ComposeQuote | null;
  /** Returns whether the quote actually came back — false when a newer one has been staged since
   *  (see `useConciergeQuote.restore`), which DISCARDS this one. */
  restore: (quote: ComposeQuote | null) => boolean;
}

/** The agent a compose-box send would reach when the target is "agent": the selected tab's
 *  selected agent. Null when there's no project open or no agent selected. */
export interface ConciergePromptTarget {
  projectId: string;
  agentId: string;
  name: string;
}

/** An addressed target — which spells its id `agentId` — as something `ref` can reference.
 *
 *  A shape adapter and nothing more. It exists so the call sites below read as prose rather than as
 *  object literals, and so the `agentId`→`id` rename happens in ONE place: a call site that built
 *  the object inline is a call site that can build it wrong, and `ref` cannot tell a mistyped id
 *  from a real one. */
export function asAgent(t: { agentId: string; name: string }): ReferencableAgent {
  return { id: t.agentId, name: t.name };
}

/**
 * An aim the user stated OUT LOUD, by naming an agent in the message itself (`@Blueprint UI/UX move
 * it 5px`). Everything the send needs to honour that, captured at submit like every other aim.
 *
 * ══ WHY THIS IS ALLOWED TO SKIP THE ROUTER, WHEN `forceSparkle` IS ONLY ALLOWED ONE WAY ═════════
 * `deliver`'s `forceSparkle` carries a warning that a `forceAgent` twin must never be added, because
 * it "would type a paragraph into a live PTY on the strength of a latch". That warning stands, and
 * this is not the thing it forbids. Three differences, and the third is the one that matters:
 *
 *   1. A LATCH is invisible state left over from an earlier action (the capture window's Chat ❯,
 *      set once and consumed later), which is why it has to be retired the moment the words that
 *      set it are gone. A mention is not state at all — it is DERIVED from the text being sent, at
 *      the moment of sending (components/Concierge/mentions). It cannot outlive its own words
 *      because it has no existence apart from them.
 *   2. It is VISIBLE. The user typed the name, the picker offered it, and the pill is in the bubble.
 *   3. **IT DOES NOT SKIP THE GATE.** This changes only WHO decides the destination — the user
 *      instead of the classifier. It still arms an intent, still counts down in the banner, still
 *      offers Cancel, and still posts a receipt. What the warning is really protecting is that no
 *      heuristic verdict reaches a terminal unseen; a mention reaches it by exactly the same
 *      countdown every routed send does. That is why there is still no `router` arm in
 *      DispatchAuthority and must never be one.
 *
 * So: explicitness buys the user a skipped classify, never a skipped gate. If you are ever tempted
 * to dispatch a mention directly, that is the line this comment exists to hold.
 */
export interface ConciergeMentionAim {
  /**
   * HOW this terminal was chosen — the user naming it, or the cable being patched to it.
   *
   * The `mount` arm is the founder's mounted-composer rule (Concierge/composerRoute): while the
   * concierge is patched to a build agent, plain text goes to that agent's terminal. It arrives on
   * THIS type rather than on a parallel one because everything downstream of the choice is identical
   * — the same stripped wire, the same armed intent, the same countdown, the same receipt — and a
   * second aim type would be a second delivery path to keep in step with this one.
   *
   * Three things read it, and each difference is deliberate: the decision's `reason` string, whether
   * Sparkle follows up with a turn of its own, and whether an unreadable terminal screen is fatal.
   */
  via: "address" | "mount";
  /** The agent the message named, or — under a mount — the agent the cable is patched to. */
  target: ConciergePromptTarget;
  /** What the PTY receives — the address stripped off, attachment paths prefixed. The `@` must not
   *  reach the terminal: the agent there is a Claude Code CLI, where a leading `@` opens its own
   *  file-reference autocomplete (see mentions.mentionFreeText). */
  payload: string;
  /** The same without attachment paths — what the auto-namer reads. */
  text: string;
}
