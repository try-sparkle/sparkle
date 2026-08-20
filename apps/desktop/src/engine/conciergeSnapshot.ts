// The compact fleet context the headless brain is given with every user turn.
//
// Moved verbatim out of components/ConciergeHost. It is a pure string build over the feed with no
// React in it, and it is the SECOND caller of `engine/conciergeRosterLine` — `buildProactivePrompt`
// is the first — so it sits beside that rather than inside a component.
import { renderOpenAsks, type OpenAsk } from "@sparkle/core";

import { bandCountLabel } from "./statusBandLabels";
import { rosterLine } from "./conciergeRosterLine";
import { accountedAgents, type ConciergeFeed } from "../services/conciergeFeed";

/**
 * Compact context handed to the headless brain so its reply is grounded in what's actually happening.
 *
 * ── IT CARRIES WHAT HE ASKED FOR, NOT JUST WHAT IS RUNNING (bead sparkle-yd1ud) ─────────────────
 * For most of this function's life it was two things: the live roster, and the message just typed.
 * Both describe the PRESENT. Nothing described what the founder had previously asked for, so an ask
 * survived only if the concierge minted an artifact for it inside that same turn — and when it
 * merely replied "I'll get that started", the request existed nowhere in the app and evaporated with
 * the context. Two of the four items he had to chase on 2026-08-09 died exactly here.
 *
 * `openAsks` is the fix, and it belongs in THIS function specifically. Filing asks into beads makes
 * them durable, but durability alone changed nothing: the board already existed and the dropped
 * items were still never mentioned, because nothing put them in front of the brain. A durable record
 * nobody reads is the same silence with more storage.
 *
 * ── AND WHAT WAS ALREADY SAID (bead sparkle-s7rfc) ──────────────────────────────────────────────
 * `continuity` is the bounded slice of the CONVERSATION (engine/conciergeContinuity) — the thread
 * the human can see. It is a DIFFERENT signal from `openAsks` and neither subsumes the other: the
 * asks are what is still OWED, the continuity is what was already SAID. It is passed in already
 * built and already bounded rather than derived here, because this module is pure over the feed and
 * the thread lives in a store; the caller (`ConciergeHost.dispatchTurn`) is the one seam with both.
 *
 * Empty string means "no conversation yet", and the prompt is then byte-identical to what it was
 * before continuity existed — see `buildContinuityBlock`'s own note on why that matters.
 *
 * ── WHY `continuity` IS FOURTH AND NOT THIRD ────────────────────────────────────────────────────
 * These two parameters were added independently, on two branches, both in the third slot (the
 * sparkle-yd1ud × sparkle-s7rfc merge). Keeping `openAsks` third leaves every existing call site —
 * this module's seven test calls and `ConciergeHost` — reading correctly; the alternative order
 * would have silently re-bound them all to the wrong argument. Positional order here is a merge
 * artifact, not a statement about which signal matters more.
 */
export function buildSnapshot(
  feed: ConciergeFeed,
  userText: string | readonly string[],
  openAsks: readonly OpenAsk[] = [],
  continuity = "",
): string {
  // The FULL accounted population, rows and rowless alike — this states `scopedCounts.needs_you`
  // right below, and listing only the row-owning half would hand the brain a count it can't see the
  // items behind.
  const surfaced = accountedAgents(feed);
  // The line format — including the trailing `id:<agentId>` the persona's pill syntax depends on —
  // lives in engine/conciergeRosterLine, shared with buildProactivePrompt. See that module's header
  // for why a second copy of the template string is not an option.
  const lines = surfaced.map((a) => rosterLine(a));
  // Keep the project count SCOPED to what's actually surfaced so it can't misstate scope (e.g. say
  // "5 projects" while only counting in-scope agents).
  const scopedProjects = new Set(surfaced.map((a) => a.projectId)).size;
  const state =
    surfaced.length > 0
      ? `${bandCountLabel("needs_you", feed.scopedCounts.needs_you)} across ${scopedProjects} project(s):\n${lines.join("\n")}`
      : `All projects are calm right now.`;
  // ORDER: fleet state → open asks → the conversation → his message. Both merged branches wrote the
  // same rule from different sides and it is load-bearing in both: the brain reads the LAST thing
  // hardest, and the last thing must be what it was just asked. So the asks are standing context the
  // reply must be consistent with (BEFORE his message, not after), the thread is the conversation
  // that context sits in, and his own words close the prompt — the turn stays about what he just
  // said while what he is still owed remains in view.
  const said = renderUserSaid(userText);
  const asksBlock = renderOpenAsks(openAsks);
  const preamble = asksBlock === null ? state : `${state}\n\n${asksBlock}`;
  const thread = continuity ? `\n\n${continuity}` : "";
  return `${preamble}${thread}\n\n${said}\n\nReply briefly and recommend the next action.`;
}

/**
 * His words, as one message or as an absorbed RUN of them.
 *
 * ══ THE DEFECT ═════════════════════════════════════════════════════════════════════════════════
 * The founder: *"I often will send a message right after the one that I just sent that has more
 * context… so that everything that I'm saying can be queued together in your response."* When
 * `engine/conciergeTurnQueue` folds several of his messages into one turn, this is where they have
 * to arrive — a prompt carrying only the first would answer the question he had already corrected.
 *
 * ══ WHY THE SINGLE-MESSAGE FORM IS BYTE-IDENTICAL ══════════════════════════════════════════════
 * One message renders exactly the string it always did, down to the byte. That is deliberate: a run
 * of one is the overwhelmingly common case, and `claude_oneshot` caches on the prompt text, so a
 * cosmetic reword of the common path would miss every warm cache entry and change the model's
 * behaviour on turns this feature never meant to touch.
 *
 * ══ WHY THE CLOSING INSTRUCTION ════════════════════════════════════════════════════════════════
 * Multiple messages are not self-evidently ONE question. Without a line saying so the model
 * reliably answers the last one and treats the rest as background — which is the same failure as
 * answering the first alone, only from the other end. It goes AFTER the messages and before the
 * standing "Reply briefly" close, so the last thing read is still what to do.
 */
function renderUserSaid(userText: string | readonly string[]): string {
  const texts = (typeof userText === "string" ? [userText] : userText).filter((t) => t.trim() !== "");
  // An empty run cannot reach here from the queue (a run is a non-empty tuple), but a caller passing
  // `[]` or `[""]` must not silently produce `The user says: undefined`.
  if (texts.length === 0) return `The user says: `;
  if (texts.length === 1) return `The user says: ${texts[0]}`;
  const rest = texts.slice(1).map((t) => `Then, before you replied, he added: ${t}`);
  return (
    `The user says: ${texts[0]}\n\n${rest.join("\n\n")}\n\n` +
    `Those ${texts.length} messages arrived together, as one thought — answer ALL of them in a ` +
    `single reply, not just the first or the last.`
  );
}
