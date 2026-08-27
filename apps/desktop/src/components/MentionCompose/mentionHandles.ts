// THE TWO AGENTS THE FOUNDER CAN PING FROM THE COMPOSE WINDOW — and how a typed line names one.
//
// This is the PARSE half of the compose-window @mention feature (bead sparkle-hdlhox). The founder
// wants to ping the two Sparkle-side agents himself rather than only have them talk to each other:
//
//   • @improve — the Improve-Sparkle agent, which improves Sparkle itself. It runs in a SEPARATE
//     agent namespace from the fleet the concierge controls, so it is not an ordinary build-agent
//     row and cannot be resolved against the live roster.
//   • @sparkle — the concierge, the fleet hub.
//
// It deliberately mirrors the concierge's own reserved-address idea (`Concierge/mentions.ts`'s
// `SPARKLE_MENTION_ID`) but stays its own small, PURE module, for one reason: the concierge roster
// resolves @-mentions against the LIVE fleet and hands back a build-agent uuid, whereas these two
// are FIXED reserved handles that are always addressable and never a uuid. Keeping the parse pure
// (no React, no store, no Tauri) is the same convention `mentions`/`composerRoute` follow, and it is
// what lets the routing be unit-tested without a rendered tree.

/** The wire handle passed to the backend `mention_send` command. Closed set — these are the only
 *  two reserved addresses, and a value outside it can never reach the backend. */
export type MentionHandle = "improve" | "sparkle";

export interface MentionTarget {
  /** The wire handle passed to the backend `mention_send` command. */
  handle: MentionHandle;
  /** The `@word` the founder types, lowercase and without the sigil. */
  token: string;
  /** How the agent is named to the founder — on the pill, and in "…is thinking". */
  displayName: string;
  /** One line naming who answers, shown as the target hint under the box. */
  blurb: string;
}

/** The sigil that opens a handle. Its own constant so the picker and the parser cannot disagree. */
export const MENTION_SIGIL = "@";

/**
 * The reserved targets, in the order the picker offers them.
 *
 * A module CONSTANT rather than a factory: the panel memoizes on it, and a fresh array per render
 * would defeat that. Frozen so nothing downstream can reorder the picker by sorting in place.
 */
export const MENTION_TARGETS: readonly MentionTarget[] = Object.freeze([
  {
    handle: "improve",
    token: "improve",
    displayName: "Improve Sparkle",
    blurb: "The agent that improves Sparkle itself",
  },
  {
    handle: "sparkle",
    token: "sparkle",
    displayName: "Sparkle",
    blurb: "The concierge — the fleet hub",
  },
] as const);

/** The target for a handle, or undefined. The one place a handle string is matched to its target,
 *  so no consumer has to re-spell the table. */
export function targetOf(handle: string): MentionTarget | undefined {
  return MENTION_TARGETS.find((t) => t.token === handle.toLowerCase());
}

export interface ParsedMention {
  /** Which reserved agent this line addresses. */
  target: MentionTarget;
  /** The message with the leading `@handle` removed and trimmed. May be empty — the caller decides
   *  whether an empty body is sendable (it is not: there is nothing to ask). */
  body: string;
}

/** The token an unrecognized leading `@word` carried, so the panel can say WHICH handle it did not
 *  know rather than a generic miss. Distinct from `null` (no leading `@word` at all). */
export interface UnknownHandle {
  token: string;
}

/** Anchored at the START, because ADDRESSING is positional — the same rule `composerRoute` uses.
 *  "@improve why is CI red?" addresses improve; "ask @improve about it" NAMES it as a subject and
 *  does not address it, exactly as a mid-sentence `@Sparkle` is a subject and not a redirect. */
const LEADING_HANDLE = /^\s*@([A-Za-z][A-Za-z0-9_-]*)/;

/**
 * Resolve the line the founder typed to a target + body, or explain why it did not resolve.
 *
 * Returns:
 *   • `{ target, body }`      — a recognized leading handle.
 *   • `{ token }`             — a leading `@word` that is not one of the two handles.
 *   • `null`                  — no leading `@word` at all (plain prose).
 *
 * Pure and total. The routing decision — which backend agent a send reaches — is THIS function's
 * `target.handle`, so it is the line a mutation test flips to prove the routing is load-bearing.
 */
export function parseMention(text: string): ParsedMention | UnknownHandle | null {
  const m = LEADING_HANDLE.exec(text);
  if (!m) return null;
  const token = m[1]!.toLowerCase();
  const target = targetOf(token);
  if (!target) return { token };
  const body = text.slice(m.index + m[0].length).trim();
  return { target, body };
}

/** Type guard: did the line address a known handle? */
export function isResolved(p: ParsedMention | UnknownHandle | null): p is ParsedMention {
  return p !== null && "target" in p;
}

/** Type guard: was the leading `@word` an unrecognized handle? */
export function isUnknownHandle(p: ParsedMention | UnknownHandle | null): p is UnknownHandle {
  return p !== null && "token" in p;
}

/**
 * The handle token being typed at the very START of the draft when the user has opened a `@…` but
 * not yet typed a space — the trigger for the typeahead. Returns `""` for a bare leading `@`, and
 * `null` when the caret's leading word is not an in-progress handle (so the picker closes).
 *
 * A SPACE ends the query: once "@improve " is typed the handle is committed and the picker must
 * close, or it would hover over the message body the founder is now writing.
 */
export function leadingHandleQuery(text: string): string | null {
  const m = /^\s*@([A-Za-z0-9_-]*)$/.exec(text);
  return m ? m[1]!.toLowerCase() : null;
}

/** The targets whose token starts with `query` (for the typeahead). An empty query offers both. */
export function candidateTargets(query: string): MentionTarget[] {
  const q = query.toLowerCase();
  return MENTION_TARGETS.filter((t) => t.token.startsWith(q));
}
