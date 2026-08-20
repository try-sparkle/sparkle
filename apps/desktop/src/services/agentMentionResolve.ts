// Resolve one addressee TOKEN — an id or a display name — against a candidate list.
//
// This is the resolver `send_peer_message` has always had, lifted out of `controlListener.ts` so a
// second caller can share it rather than copy it. The second caller is the @mention in a bead
// comment that doorbells the mentioned agent; the two features must agree on what "@Rust Half"
// means, and two copies of these five lines would disagree on the first edit either one made.
//
// THE CALLER SUPPLIES THE CANDIDATES, and that is load-bearing rather than stylistic. In
// `send_peer_message` the candidate list is the caller's OWN project's agents and nothing else, so
// the resolution cannot see — let alone name — a row outside that project. A helper that reached
// into a store to build its own list would move that decision in here, where it has no idea which
// boundary applies, and turn every caller's scoping into something enforced by a late filter. So
// this is PURE and SYNCHRONOUS: no store, no clock, no I/O. Scope is the caller's to decide, and
// the helper cannot widen it.
//
// AN `unknown` RESULT SAYS NOTHING ABOUT WHY. There is deliberately no "exists but out of scope"
// variant: `send_peer_message` merges "wrong project" and "does not exist" into one refusal string
// precisely so the op cannot be swept as a roster-enumeration oracle, and a helper that
// distinguished them would hand every future caller a way to leak that back out.

/** One addressable agent, as the caller sees it. `name` is whatever the caller's roster PRINTS —
 *  for the desktop app that is `agentDisplayName(a)`, not the raw `a.name`. */
export interface MentionCandidate {
  id: string;
  name: string;
}

/** What a token resolved to. `ambiguous` and `unknown` both carry the token back so a caller can
 *  quote it in a refusal without re-trimming it. */
export type MentionResolution =
  | { kind: "ok"; id: string; name: string }
  | { kind: "ambiguous"; token: string; ids: string[] }
  | { kind: "unknown"; token: string };

/**
 * Resolve `token` against `candidates`.
 *
 * Exact `id` wins first, then exact-equality on `name`. There is NO case folding and NO fuzzy
 * matching — that is today's shipped behaviour and this lift must not change it. Loosening the
 * match is a real product question (it makes previously-`unknown` tokens deliver a message to
 * somebody), so it belongs in its own change with its own tests, not smuggled in under a refactor.
 *
 * Two or more names colliding resolves `ambiguous` listing EVERY colliding id in candidate order,
 * because the caller's remedy is to re-address one of them by id and it can only do that if it is
 * told all of them.
 *
 * `token` is the caller's to trim; an empty token resolves `unknown` rather than matching a
 * candidate whose name happens to be empty.
 */
export function resolveAgentMention(
  candidates: readonly MentionCandidate[],
  token: string,
): MentionResolution {
  if (!token) return { kind: "unknown", token };

  const byId = candidates.find((c) => c.id === token);
  if (byId) return { kind: "ok", id: byId.id, name: byId.name };

  const byName = candidates.filter((c) => c.name === token);
  if (byName.length > 1) {
    // A loop rather than `.map((c) => c.id)` so this line is MUTATION-CHECKABLE: the checker's
    // comparison swap rewrites an inline `=>` to `=<`, which breaks parsing rather than behaviour,
    // so an arrow here would leave the id-collection unjudged — unproven, on the one branch whose
    // whole value is naming every colliding id.
    const ids: string[] = [];
    for (const c of byName) ids.push(c.id);
    return { kind: "ambiguous", token, ids };
  }
  const hit = byName[0];
  if (hit) return { kind: "ok", id: hit.id, name: hit.name };

  return { kind: "unknown", token };
}
