// WHERE DOES A COMPOSE-BOX MESSAGE GO? — the mount, the address, and the escape hatch.
//
// Pure. No React, no stores, no Tauri, and no DOM: the one rule that decides whether the founder's
// words reach a live PTY or the concierge is the last rule in this app that should need a rendered
// tree to test. (Same convention as `mentions`, `conciergeRouter`, `dictationTerminalRoute`.)
//
// ══ THE FOUNDER'S RULE, VERBATIM ═════════════════════════════════════════════════════════════════
// *"When the concierge is mounted to a build agent, what I type goes to THAT AGENT'S TERMINAL —
// unless I @-mention Sparkle, in which case it goes to the concierge instead."*
//
// Four cases fall out, and they are the whole of this module:
//
//   1. MOUNTED, plain text          → that agent's terminal.
//   2. MOUNTED, leading `@Sparkle`  → the concierge. THE ESCAPE HATCH.
//   3. Leading `@Other Agent`       → that agent's terminal. The mount does not move — mentioning is
//                                     not re-mounting, and this module could not move it if it tried
//                                     (the mount is cable state, and nothing here writes).
//   4. UNMOUNTED, plain text        → the concierge, exactly as before this module existed.
//
// ══ AND A FIFTH THING, WHICH IS A REFERENT RATHER THAN A CASE ═══════════════════════════════════
// A leading `@<bead title>` is NOT case 3. A bead names the work a message is ABOUT; it can never be
// a destination, in any position. See `addressingSpan` for why that is stated there rather than left
// to fail safe downstream — it fails safe today only by an accident of lookup, and three silent
// defects live in the gap.
//
// ══ WHY THE MOUNT MAY AIM AT A TERMINAL WHEN THE ROUTER MAY NOT ══════════════════════════════════
// `conciergeRouter`'s header states an absolute rule — `routeMessage` NEVER returns `target: "agent"`
// — because a message was once typed into a build agent's terminal on the strength of a HEURISTIC
// ("that agent has a live prompt and this text is terse, so it must be an answer"). The founder was
// answering the concierge, and their words went into a PTY.
//
// That rule is untouched, and this module does not weaken it. What it turns on is the distinction the
// router's own header draws: **a heuristic verdict is not a user gesture.** Mounting is a gesture —
// the user clicked that build row, the cable is drawn on screen connecting the concierge to it, the
// column has swapped to that agent's own conversation, and the compose box is keyed to that agent's
// draft. Nothing here is inferred from the shape of the text. The decision is made HERE, before
// `routeMessage` is ever called, exactly as an `@Name` address already is.
//
// And it still does not skip the gate. A terminal-bound verdict from this module arms a cancellable
// intent and counts down, like every other routed send (see ConciergeHost's `deliver`). Explicitness
// buys a skipped classify, never a skipped write-guard: the caller must still ask
// `terminalWriteRefusal` whether the screen may receive free text at all.
//
// ══ AN ADDRESS IS A PREFIX. A NAME IN A SENTENCE IS A SUBJECT. ═══════════════════════════════════
// The rule that decides the DESTINATION is positional, and it is the same predicate
// `mentionFreeText` uses to decide what to strip off the wire — {@link isAddressingPosition}. One
// predicate, deliberately, because the two questions have to agree: the span consumed from the text
// must be the span that chose the terminal, or the user's message reaches an agent with a hole where
// its subject was.
//
// This closes the half of commit 898cea330 ("a mention names the subject as often as it addresses the
// agent") that it deliberately left open, tracked as bead sparkle-3dbp6. That commit fixed the TEXT —
// a mid-sentence mention keeps its name and loses only its sigil — while routing still read
// `mentions[0]` by ORDINAL. So:
//
//     "Why is @Status Check just sitting there? It looks like it has unmerged work."
//
// was dispatched INTO Status Check's terminal, as a third-person question about itself, and Sparkle —
// who it was plainly for — never saw it. Under this module that message has no leading address, so it
// follows the mount: to the terminal if the founder is mounted to something (which is what they asked
// for), and to the concierge otherwise (which is what that sentence meant).
//
// ══ THE ASYMMETRY THIS RESOLVES, STATED PLAINLY ═════════════════════════════════════════════════
// Under a mount, a mid-sentence `@Sparkle` now reaches the TERMINAL rather than the concierge, and
// that is the irreversible direction — so it is worth saying why it is nonetheless right. The safe
// reading ("any `@Sparkle` anywhere is a redirect") makes the escape hatch fire on sentences that
// merely mention the app by name, and this app is called Sparkle: *"ask Sparkle about it once you've
// landed"* is an instruction FOR the agent, and hijacking it to the concierge silently drops the
// instruction the founder was giving. The founder named the distinction themselves, and a leading
// address is unambiguous, visible as a pill before Enter is pressed, and one Backspace from being
// undone (`backspaceMention`). The recoverable-direction argument is what governs a GUESS; this is
// not a guess.
import {
  MENTION_SIGIL,
  SPARKLE_MENTION_ID,
  findMentionSpans,
  isAddressingPosition,
  isBeadMentionId,
  rosterFromMentions,
  type ConciergeMention,
  type MentionSpan,
} from "./mentions";

/** How the destination was decided. Carried on the verdict rather than re-derived, because the
 *  caller's downstream behaviour genuinely differs per arm — see {@link ComposerRoute}. */
export type ComposerRouteVia =
  /** A leading `@Name` (or `@Sparkle`) — the user stated the destination in the message. */
  | "address"
  /** No address; the concierge is mounted to a build agent, so the words follow the cable. */
  | "mount"
  /** No address and no mount — the concierge, as every send did before mounts routed anywhere. */
  | "default";

/**
 * Where this message goes.
 *
 * `via` is not decoration. The caller treats the two agent-bound arms differently in three places,
 * and each difference is deliberate:
 *   • the receipt's reason string ("you named this agent" vs "the concierge is mounted to it");
 *   • the concierge's own follow-up turn — an ADDRESSED message is relayed *through* the concierge,
 *     so it stays in the conversation; a MOUNTED one is the founder talking straight to the agent,
 *     and billing a brain turn per line of that conversation is not a thought partner, it is a tax;
 *   • an unreadable terminal screen refuses a `mount` outright but not an `address` — see
 *     ConciergeHost, where the seam that can actually read a viewport lives.
 */
export type ComposerRoute =
  | { kind: "sparkle"; via: Extract<ComposerRouteVia, "address" | "default"> }
  | { kind: "agent"; agentId: string; via: Extract<ComposerRouteVia, "address" | "mount"> };

export interface ComposerRouteInput {
  /** Exactly what the user typed — sigils, punctuation and all. The spans are re-derived from it. */
  text: string;
  /** The mentions the COMPOSER resolved for this message, in first-appearance order. Re-matched
   *  here through `rosterFromMentions` so there is no second, laxer notion of where a mention sits
   *  in the string (the same round-trip `mentionFreeText` makes, for the same reason). */
  mentions: readonly ConciergeMention[];
  /**
   * The spans those mentions came from, when the caller has them.
   *
   * OPTIONAL, AND NOT A SHORTCUT PAST THE RULE. `mentions` alone carries no positions, so the
   * re-match above is the only way to recover them — but the LIVE composer already ran that match a
   * moment ago against the live roster, and handing the result back is strictly more information
   * than re-deriving it from a lossy projection. Making it optional keeps the send path, the thread
   * and every existing test on the two-argument form unchanged; what it removes is the second walk
   * of the draft that ran on every keystroke purely to recover a number the caller was holding.
   *
   * The two derivations agree by construction — see `mentions.splitAtMentionSpans` for why, and
   * `mentions.test.ts` for the cases that pin it.
   */
  spans?: readonly MentionSpan[];
  /** The agent the concierge is patched to, or null when it floats free. NOT "the selected agent":
   *  something is selected almost always, and routing on that would type into whichever row the
   *  founder last clicked in the sidebar. The cable is the gesture. */
  mountedAgentId: string | null;
}

/**
 * The span that ADDRESSES this message, or null when nothing does.
 *
 * ONLY `spans[0]` CAN QUALIFY, and that is a property rather than an optimisation: every later span
 * has an earlier span's own literal somewhere to its left, so "nothing but whitespace precedes it" is
 * false for all of them by construction. Written as a look at the first span rather than a `.find()`
 * so a reader is not left wondering which of several leading addresses would win — there cannot be
 * two.
 *
 * Exported because the pill-rendering and copy surfaces want to say "this one is the destination"
 * without re-implementing the test.
 */
export function addressingSpan(
  text: string,
  mentions: readonly ConciergeMention[],
  /** Skip the re-match when the caller already holds the spans — see `ComposerRouteInput.spans`. */
  spans?: readonly MentionSpan[],
): MentionSpan | null {
  const trusted = fitsText(text, mentions, spans)
    ? spans
    : findMentionSpans(text, rosterFromMentions(mentions));
  const first = trusted[0];
  if (!first) return null;
  // ══ A BEAD IS A SUBJECT IN EVERY POSITION, INCLUDING THE FIRST (bead sparkle-1cpomd) ═══════════
  // Stated HERE rather than relied on downstream, and that distinction is the whole of it. Without
  // this line a leading bead title still produces `{kind: "agent", agentId: "bead:sparkle-…"}`,
  // because the `agent` arm below is the DEFAULT arm — everything that is not the concierge sentinel
  // falls into it. Nothing reaches a terminal even so, but only by accident of lookup: the feed keys
  // on uuids, so the host's `mentionAgentsRef.find` misses and the aim comes back empty.
  //
  // Three defects live in that accident, and all three are silent:
  //   • IT ESCAPES A MOUNT. `mountRouted` is computed only for `via === "mount"`, as is the
  //     unreachable-mount refusal — so a mounted founder opening a line with a bead reference has
  //     his message quietly diverted to the concierge, with no receipt saying so.
  //   • THE BOX PAINTS THE WRONG FACE. ComposeBox switches to its terminal metrics on
  //     `kind === "agent"`, telling him his words are going to a PTY when they are not.
  //   • THE TITLE IS DELETED FROM THE WIRE. `mentionFreeText` consumes a leading address whole, so
  //     the subject of his sentence would vanish — the exact corruption commit 898cea330 closed.
  //
  // Returning null answers all three at once, and answers them the SAME way `mentionFreeText` does:
  // same predicate, same id. There is no case for looking past a leading bead at a later span —
  // every later span has this one's literal to its left, so none of them leads either.
  if (isBeadMentionId(first.agentId)) return null;
  return isAddressingPosition(text, first.start) ? first : null;
}

/**
 * Do these spans actually describe THIS text?
 *
 * ══ WHY THE OPTIONAL `spans` IS CHECKED RATHER THAN TRUSTED ═════════════════════════════════════
 * `spans` is a second representation of something `mentions` already implies, and a redundant input
 * that is trusted is a way for two facts to disagree. The disagreement here has a specific and
 * unrecoverable shape: a span captured one render earlier — through a ref, a memo with incomplete
 * deps, a debounced draft — would have `isAddressingPosition` read the prefix of the NEW text at an
 * offset from the OLD one, and hand back an `agentId` the current draft no longer addresses. The
 * route resolves to `{kind: "agent"}` and the founder's words are written into that agent's PTY.
 * That is the exact failure this module's header is written around, and the whole point of
 * derive-from-text is that it cannot happen.
 *
 * Both callers today build the text and the spans in one expression, so no stale span is reachable —
 * this is a guard against the shape, not a live bug. It earns its place because it costs one slice
 * comparison on ONE span and because it fails to the SAFE side: spans that do not fit are ignored
 * and the authoritative re-match runs, which is exactly what happens when no spans are passed at
 * all. A caller cannot make the answer worse by handing over something wrong, only slower.
 *
 * Checking the FIRST span is sufficient for what this function decides: it only ever reads
 * `spans[0]` (see the note above — no later span can be an address), so a mismatch anywhere that
 * could change the verdict shows up there.
 *
 * AN EMPTY `spans` IS CHECKED TOO, and it is the case a laxer guard would wave through. "No spans"
 * is not self-evidently about this text — a stale empty array over a draft that DOES open with an
 * address means no address is found, the message follows the mount, and the leading `@Sparkle` that
 * exists precisely to escape a mount is the send that gets swallowed. So emptiness is cross-checked
 * against `mentions`, which is derived from the same scan: the two must agree there is nothing to
 * find.
 */
function fitsText(
  text: string,
  mentions: readonly ConciergeMention[],
  spans?: readonly MentionSpan[],
): spans is readonly MentionSpan[] {
  if (!spans) return false;
  const first = spans[0];
  // `mentions` is `spans` de-duplicated in place, so the two are empty together and their first
  // entries name the same agent. Either disagreement means these did not come from one reading.
  if (!first) return mentions.length === 0;
  if (first.agentId !== mentions[0]?.agentId) return false;
  return text.slice(first.start, first.end) === MENTION_SIGIL + first.name;
}

/**
 * THE decision. Total, deterministic, and cheap — no model is asked, because nothing here is a guess.
 *
 * Order is precedence, highest first:
 *   1. a LEADING `@Sparkle`     → the concierge. The escape hatch beats the mount, which is the
 *                                 entire point of it: it is the only way to reach the concierge while
 *                                 every other word you type is going to a terminal.
 *   2. a LEADING `@Other Agent` → that agent. Beats the mount too — an explicit destination overrules
 *                                 an implicit one — and leaves the mount exactly where it was.
 *   3. a MOUNT                  → the mounted agent's terminal.
 *   4. otherwise                → the concierge.
 */
export function classifyComposerRoute(i: ComposerRouteInput): ComposerRoute {
  const address = addressingSpan(i.text, i.mentions, i.spans);
  if (address) {
    return address.agentId === SPARKLE_MENTION_ID
      ? { kind: "sparkle", via: "address" }
      : { kind: "agent", agentId: address.agentId, via: "address" };
  }
  if (i.mountedAgentId) return { kind: "agent", agentId: i.mountedAgentId, via: "mount" };
  return { kind: "sparkle", via: "default" };
}

/**
 * Does this message reach a terminal with its sigils intact?
 *
 * A guard for the ONE rendering that must never carry an `@`: the agent on the far end is a Claude
 * Code CLI, where a leading `@` on a token opens its file-reference autocomplete and strands the
 * instruction behind a picker nobody asked for. `mentionFreeText` is what removes them, and the host
 * already applies it — this exists so a test can state the invariant against the wire itself rather
 * than against the call that was supposed to produce it.
 */
export function carriesSigil(wire: string): boolean {
  return wire.includes(MENTION_SIGIL);
}
