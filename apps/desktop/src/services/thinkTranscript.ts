// The Think tab's conversation transcript, as handed to the Chief-backed lanes (@chief, an
// @mentioned voice, Chief's background interjection, and Make a Plan). Bead sparkle-xh4j.
//
// Two constraints hold this module together:
//
//  1. Every speaker is named distinctly, and a turn's boundary + attribution cannot be forged by
//     its own content. Message bodies are GitHub-flavored markdown (MD_HINT asks for it), so any
//     plain-text delimiter — a blank line, a `---` rule — occurs INSIDE bodies too, and a reader
//     cannot then tell a second paragraph from a new unlabelled speaker. Turns are therefore
//     wrapped in an explicit element and the delimiter is neutralized in the body.
//  2. The output is bounded. Chief's prompt limit is undocumented and it rejects an oversized
//     request with an opaque `{code:"",statusCode:400}` carrying no human-readable message (see
//     chief.ts:parseOrThrow), so the true limit can't be learned from a response and the user can
//     never be told what went wrong. We stay well under any plausible limit rather than discover it
//     in production.
import { findVoice } from "./expertRoster";

/** Author of a Think-tab chat turn. Structurally matches ThinkPanel's `ChatMsg["author"]`. */
export type TranscriptAuthor = "user" | "claude" | "chief" | "voice";

/** The shape buildTranscript needs. ThinkPanel's `ChatMsg` satisfies this structurally, so the two
 *  stay decoupled (no import cycle back into the component). */
export interface TranscriptMsg {
  author: TranscriptAuthor;
  /** For author "voice": the roster handle (e.g. "product-manager"). */
  voiceHandle?: string;
  text: string;
  /** Awaiting a reply — excluded, it has no content yet. */
  pending?: boolean;
}

/**
 * Hard ceiling on the transcript we will send, in characters. ~24k chars is roughly 6k tokens —
 * generous for a design conversation, with headroom for the per-lane wrapper (the question, the
 * persona instructions, the markdown hint) added on top of this string.
 */
export const TRANSCRIPT_BUDGET_CHARS = 24_000;

/** Prepended when older turns were dropped, so the reader knows its history is partial and does not
 *  confidently reason from a conversation it can only half see. */
export const ELISION_MARKER = "[earlier turns elided to fit the context budget]";

/** Marks a single turn that was itself clipped (it alone exceeded the budget), so the reader knows
 *  the text it can see stops mid-thought rather than being a complete statement. */
export const TRUNCATION_MARKER = "[this turn was clipped to fit the context budget]";

/** The budget could not hold even one turn's scaffolding, so NO conversation is present. Distinct
 *  from {@link TRUNCATION_MARKER}, which promises a (clipped) turn the reader can actually see. */
export const NOTHING_FIT_MARKER = "[the conversation did not fit the context budget]";

const TURN_CLOSE = "</turn>";
const TURN_SEPARATOR = "\n\n";

/**
 * The speaker name for a turn. Every participant is distinct: the human, Sparkle (the local Claude
 * Code engine), Chief, and each expert voice by handle + roster label. A voice gets both its handle
 * and its human label ("@product-manager (Product Manager)") so a reader can match it to the
 * @mention the user typed AND read it as a role.
 */
export function speakerLabel(m: TranscriptMsg): string {
  switch (m.author) {
    case "user":
      return "User";
    case "claude":
      return "Sparkle";
    case "chief":
      return "Chief";
    case "voice": {
      const handle = m.voiceHandle ?? "";
      if (!handle) return "Expert voice";
      const label = findVoice(handle)?.label;
      return label ? `@${handle} (${label})` : `@${handle}`;
    }
  }
}

/**
 * Neutralize anything in a message body that could close or forge a turn element. Only the exact
 * delimiter is touched, so markdown, code fences and prose survive intact. Without this, a user (or
 * a quoted document) that contains `</turn>` could end Sparkle's turn early and open what reads as
 * an authentic turn from someone else — the labels are only trustworthy identity if the body cannot
 * counterfeit them.
 */
function neutralizeDelimiters(text: string): string {
  return text.replace(/<\/?turn(\s[^>]*)?>/gi, (m) => m.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}

/** A turn as a self-delimiting element, so its boundary is independent of its markdown content. */
function renderTurn(m: TranscriptMsg): string {
  // Labels are built from a fixed set plus roster handles (constrained to [a-z0-9-] by ThinkPanel's
  // MENTION_RE), so the attribute value needs no escaping of its own.
  return `<turn speaker="${speakerLabel(m)}">\n${neutralizeDelimiters(m.text.trim())}\n${TURN_CLOSE}`;
}

/**
 * Render the conversation as a speaker-attributed transcript bounded to `budgetChars`, AND report
 * which messages actually made it in.
 *
 * Callers that track what a reader has been told must key that off `kept`, never off the input:
 * anything this dropped was never conveyed, and recording it as sent would lose it permanently.
 */
export function selectTurns<T extends TranscriptMsg>(
  msgs: T[],
  opts: { budgetChars?: number } = {},
): { text: string; kept: T[] } {
  // Clamped once, here: a negative budget would invert every `slice(0, budget)` below into
  // "drop the last N chars", returning far MORE than the caller asked for.
  const budget = Math.max(0, opts.budgetChars ?? TRANSCRIPT_BUDGET_CHARS);
  const live = msgs.filter((m) => !m.pending && m.text.trim());
  if (live.length === 0) return { text: "", kept: [] };

  const turns = live.map(renderTurn);
  const whole = turns.join(TURN_SEPARATOR);
  if (whole.length <= budget) return { text: whole, kept: live };

  // Walk backwards from the newest turn, keeping what fits alongside the marker.
  const reserved = ELISION_MARKER.length + TURN_SEPARATOR.length;
  const rendered: string[] = [];
  const kept: T[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const cost = turn.length + (rendered.length > 0 ? TURN_SEPARATOR.length : 0);
    if (reserved + used + cost > budget) break;
    rendered.unshift(turn);
    kept.unshift(live[i]!);
    used += cost;
  }

  if (rendered.length > 0) {
    return { text: [ELISION_MARKER, ...rendered].join(TURN_SEPARATOR), kept };
  }

  // Degenerate: even the single newest turn can't fit beside the marker. Send a CLIPPED newest turn
  // rather than an empty transcript — a responder with a partial last question can still engage,
  // one with nothing answers blind.
  const newest = live[live.length - 1]!;
  // Only claim earlier turns were elided when there WERE earlier turns: a lone oversized message has
  // no history to drop, and a false claim about history is precisely what this module must not emit.
  const open = `<turn speaker="${speakerLabel(newest)}">\n`;
  const head = live.length > 1 ? `${ELISION_MARKER}${TURN_SEPARATOR}${open}` : open;
  const tail = `\n${TRUNCATION_MARKER}\n${TURN_CLOSE}`;
  // The budget is a hard ceiling, so it must hold even when it can't fit the scaffolding itself.
  // Below that size a body fragment would carry no usable content and could only be an
  // unterminated element — a half-written `<turn speaker="Us` attributes nothing and, markerless,
  // would imply an intact history. Say the one thing that IS true — nothing fit — rather than
  // TRUNCATION_MARKER, which would promise a clipped turn that isn't there. Nothing is kept,
  // because nothing was conveyed.
  //
  // This reports NO progress, so a delivery-tracking caller (chiefThread) would re-offer the same
  // turns every turn. That is the honest answer: at a budget this small the BUDGET is unusable, not
  // the conversation, and marking a turn delivered that never went would lose it silently. It does
  // NOT contradict the clip-don't-stall rule below, which applies where a turn can still be partly
  // conveyed. Unreachable from the app: the 24k default is orders of magnitude above this branch
  // and askChief never passes budgetChars.
  if (budget <= head.length + tail.length) {
    return { text: NOTHING_FIT_MARKER.slice(0, budget), kept: [] };
  }
  // A clipped turn DOES count as kept: it can never fit whole, so holding it back as "undelivered"
  // would re-clip it on every subsequent turn and wedge the conversation forever.
  const room = budget - head.length - tail.length;
  return {
    text: `${head}${neutralizeDelimiters(newest.text.trim()).slice(0, room)}${tail}`,
    kept: [newest],
  };
}

/** {@link selectTurns}'s text, for callers that don't track delivery. */
export function buildTranscript(msgs: TranscriptMsg[], opts: { budgetChars?: number } = {}): string {
  return selectTurns(msgs, opts).text;
}

/**
 * Take the OLDEST turns that fit, in order — for feeding a reader that is ACCUMULATING history
 * across calls (see chiefThread), as opposed to {@link selectTurns}, which renders a whole
 * conversation one-shot and so keeps the newest.
 *
 * The two have opposite requirements and must not be confused. A reader appending each batch to a
 * running history needs them chronological: keeping the newest would deliver a long backlog in
 * reverse, and the reader would file older turns as the most recent thing said. Nothing is elided
 * here — what doesn't fit is simply not `kept`, so the caller offers it again next time and the
 * backlog drains in order.
 */
export function selectOldestWithin<T extends TranscriptMsg>(
  msgs: T[],
  opts: { budgetChars?: number } = {},
): { text: string; kept: T[] } {
  const budget = Math.max(0, opts.budgetChars ?? TRANSCRIPT_BUDGET_CHARS);
  const live = msgs.filter((m) => !m.pending && m.text.trim());
  if (live.length === 0) return { text: "", kept: [] };

  const rendered: string[] = [];
  const kept: T[] = [];
  let used = 0;
  for (const m of live) {
    const turn = renderTurn(m);
    const cost = turn.length + (rendered.length > 0 ? TURN_SEPARATOR.length : 0);
    if (used + cost > budget) break;
    rendered.push(turn);
    kept.push(m);
    used += cost;
  }

  // The oldest turn alone can't fit.
  if (rendered.length === 0) {
    const oldest = live[0]!;
    const open = `<turn speaker="${speakerLabel(oldest)}">\n`;
    const tail = `\n${TRUNCATION_MARKER}\n${TURN_CLOSE}`;
    // Not even the scaffolding fits: nothing can be conveyed, so nothing is kept. That reports no
    // progress and a delivery-tracking caller would re-offer these turns indefinitely — which is
    // the honest outcome, because at this budget the BUDGET is unusable, not the conversation, and
    // marking a turn delivered that never went would lose it silently. Unreachable from the app
    // (the 24k default is orders of magnitude above this; askChief never passes budgetChars).
    if (budget <= open.length + tail.length) {
      return { text: NOTHING_FIT_MARKER.slice(0, budget), kept: [] };
    }
    // A partial turn CAN be conveyed, so clip it rather than stall: left unkept it would be
    // re-offered forever and the backlog would never drain past it.
    const room = budget - open.length - tail.length;
    return {
      text: `${open}${neutralizeDelimiters(oldest.text.trim()).slice(0, room)}${tail}`,
      kept: [oldest],
    };
  }

  return { text: rendered.join(TURN_SEPARATOR), kept };
}
