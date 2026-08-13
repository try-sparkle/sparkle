// Agent-to-agent peer messaging — the limits, the sender label, and the one hop into Rust.
//
// WHY THIS EXISTS AT ALL (bead `sparkle-0vl92` and nine siblings). Two agents told to co-design one
// document could not reach each other in either direction. `ListAgents`/`SendMessage` are Claude Code
// HARNESS tools with no Sparkle implementation: the harness's own peer mesh registers Sparkle agents
// but never binds their socket, and its discovery is scoped to the Claude ACCOUNT rather than the
// project — so even working it would make every agent in every project mutually addressable, which is
// the opposite of the boundary this feature is for. Sparkle therefore supplies its own channel.
//
// Delivery rides the inbox that already exists (`src-tauri/src/inbox.rs`): durable per-agent JSONL,
// `O_EXCL` claim dedupe, capped at 50/agent with a 12h TTL, drained at the recipient's next turn
// boundary. Nothing about that transport changes here. What is new is that a SIBLING may put
// something in it, and that the sender is named on the way out.
//
// Split out of `controlListener` deliberately: the limits are the part of this feature most likely to
// be wrong, and they are far easier to drive directly than through the dispatch surface.
import { invoke } from "@tauri-apps/api/core";
import { PEER_MESSAGE_MAX_CHARS } from "@sparkle/core";

/** A peer message is coordination ("I am taking the Rust half"), not a document handoff.
 *
 * Re-exported from `@sparkle/core` rather than declared here, because this package ENFORCES the cap
 * while `apps/mcp-control` DESCRIBES it to every agent. Two literals in two packages are two numbers
 * that look like one, and the drift is silent: the tool keeps advertising a limit the enforcer no
 * longer has. See `packages/core/peerMessageLimits.ts`. */
export const MESSAGE_MAX_CHARS = PEER_MESSAGE_MAX_CHARS;

/** Sends allowed from one agent to ONE OTHER agent inside {@link PAIR_WINDOW_MS}. Bounds a reply
 *  loop: without it, two agents that each answer the other run until something else stops them. */
export const PAIR_LIMIT = 5;
export const PAIR_WINDOW_MS = 10 * 60 * 1000;

/** Sends allowed from one agent to ANYONE inside {@link SENDER_WINDOW_MS}. Bounds the other shape:
 *  one agent spraying the whole fleet, which the pair limit alone would happily permit. */
export const SENDER_LIMIT = 20;
export const SENDER_WINDOW_MS = 60 * 60 * 1000;

/**
 * How a peer is named in the recipient's inbox: `"<displayName> [<agentId>]"`.
 *
 * ONE STRING RATHER THAN A SECOND FIELD, and that is a wire decision rather than a formatting one. An
 * added `Option<String>` on the Rust struct crosses the wire as `null`, and a TypeScript `field?: T`
 * does not include `null` — the silent seam `AGENTS.md` documents, where both halves are green and
 * the feature is dead in production. Reusing the `from` field that already exists avoids it outright,
 * keeps the delivery renderer a pure string formatter that needs no roster, and gives the recipient
 * both the name to reply with and the exact id to address.
 */
export function peerLabel(displayName: string, agentId: string): string {
  return `${displayName} [${agentId}]`;
}

/** Queue one peer message. Always `fyi`: a peer is not the human and cannot place an obligation on
 *  another agent — see the provenance banner in the delivery renderers. */
export function sendPeerInboxMessage(
  agentId: string,
  text: string,
  from: string,
): Promise<string> {
  return invoke<string>("inbox_send", { agentId, text, severity: "fyi", from });
}

/** Why a send was refused by the limits, or `ok` if it was not. */
export type RateVerdict = "ok" | "pair" | "sender";

/** One recorded send. Kept in memory only: the limits bound a live conversation, and a fresh app is
 *  a fresh conversation — persisting them would carry a stale budget across a restart. */
interface PeerSend {
  to: string;
  at: number;
}

/** sender agent id → its recent sends, pruned on every read. */
const recentSends = new Map<string, PeerSend[]>();

/** Sends by `from` still inside the wider window, pruned in place so the map cannot grow forever. */
function liveSends(from: string, now: number): PeerSend[] {
  const kept = (recentSends.get(from) ?? []).filter((s) => now - s.at < SENDER_WINDOW_MS);
  if (kept.length === 0) recentSends.delete(from);
  else recentSends.set(from, kept);
  return kept;
}

/**
 * Would this send be allowed right now? Pure — it records nothing.
 *
 * `now` is REQUIRED rather than defaulted to `Date.now()`. A defaulted clock that every test
 * overrides leaves the production call site covered by nothing: delete it and the suite stays green
 * while the bug returns (bead `sparkle-lgbwf`). Callers pass a real clock and tests move the fake
 * one, so the line that actually ships is the line under test.
 */
export function checkPeerRateLimit(from: string, to: string, now: number): RateVerdict {
  const live = liveSends(from, now);
  if (live.length >= SENDER_LIMIT) return "sender";
  const pair = live.filter((s) => s.to === to && now - s.at < PAIR_WINDOW_MS);
  if (pair.length >= PAIR_LIMIT) return "pair";
  return "ok";
}

/**
 * Reserve a send. Separate from the check on purpose: a refused send must not spend the sender's
 * budget, or a run of bad target names would lock it out of a channel it never successfully used.
 *
 * RESERVE, NOT RECORD-AFTERWARDS — and that word is the whole point. The caller holds this on the
 * near side of its `await`, because checking here and recording after the hop leaves a window in
 * which every concurrent request observes the same pre-send counts and every one of them passes.
 * That is not a rare interleaving: it is what an ordinary turn looks like when a model emits several
 * `tool_use` blocks at once and dispatch is fire-and-forget. Roll it back with
 * {@link releasePeerSend} on the paths where the send did not happen.
 */
export function recordPeerSend(from: string, to: string, now: number): void {
  recentSends.set(from, [...liveSends(from, now), { to, at: now }]);
}

/** Give back a reservation whose send then failed. Removes ONE entry matching `to` and `at`, so two
 *  reservations made in the same millisecond cannot both be cancelled by one rollback. */
export function releasePeerSend(from: string, to: string, at: number): void {
  const live = liveSends(from, at);
  const i = live.findIndex((s) => s.to === to && s.at === at);
  if (i === -1) return;
  const kept = [...live.slice(0, i), ...live.slice(i + 1)];
  if (kept.length === 0) recentSends.delete(from);
  else recentSends.set(from, kept);
}

/** Test hook — the module-level budget outlives an individual test otherwise. */
export function _resetPeerRateLimitsForTests(): void {
  recentSends.clear();
}
