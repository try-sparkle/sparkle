// Peer traffic, written into the concierge log the founder is already reading.
//
// WHY THIS EXISTS. `send_peer_message` delivers into the recipient's INBOX (`src-tauri/src/inbox.rs`)
// and nowhere else, so every message one agent sent another was invisible to the human — he could
// see that two agents had converged on the same file, but never the sentence where one of them said
// so. His only view of cross-agent coordination was the concierge relaying it by hand, which means
// the traffic he could see was exactly the traffic that had already cost someone a turn to repeat.
// Nothing about the delivery changes here; this is a second, read-only reader of the same send.
//
// THE SHAPE LIVES BESIDE THE PRODUCER, not in `components/Concierge/types.ts`, following
// `ConciergeRecapMessage`: the row is built here and rendered there, and a shape declared on the
// rendering side is one the producer can drift away from without either side failing. types.ts
// re-exports it so consumers still get the union from one place.
//
// PURE, AND DELIBERATELY STORE-FREE ABOVE `logPeerMessage`. Which sends appear is a correctness
// question rather than a styling one — a row that is silently dropped is indistinguishable from two
// agents that never spoke, and the whole value of the column is that the founder can read it as
// complete. So the decision is a function that can be driven directly.
import { PEER_GIST_MAX_CHARS } from "@sparkle/core";
import { setConciergeChat } from "../stores/conciergeThreadStore";

/** The agent at one end of a peer message, as the row draws it. `id` is what the pill needs to be
 *  clickable; `name` is what it says when the roster can no longer resolve that id. */
export interface PeerParty {
  id: string;
  name: string;
  /**
   * This end is an APP-GLOBAL agent — the concierge, or Improve Sparkle — rather than a row in a
   * project's roster.
   *
   * IT EXISTS BECAUSE AN UNRESOLVED PILL MAKES A FALSE CLAIM (roborev 68628). `AgentPill` treats "I
   * was given a roster and this id is not in it" as evidence the agent is GONE, and renders
   * `"<name> is closed."` — correct for a worker that has been spun down, and a lie about the
   * assistant the human is talking to right now. The concierge's id is deliberately not a roster row
   * (`controlListener.CONCIERGE_CALLER_AGENT_ID`), so EVERY row where it is an end would say the
   * concierge is closed — and `logPeerMessage`'s own `appGlobal` rule guarantees those rows are
   * always drawn. It is the dead-label / false-closed claim `AgentPill.deadEnd.test.tsx` exists to
   * forbid, reintroduced from a new direction.
   *
   * CARRIED ON THE MODEL RATHER THAN DERIVED IN THE ROW, because the PRODUCER already knows: the
   * handler computes exactly this to decide whether the row is drawn at all. Re-deriving it in a
   * component would mean importing the id constants out of a 4,000-line service into the render
   * tree, and would give the two answers a way to disagree.
   */
  appGlobal?: boolean;
}

/**
 * One peer message, drawn inline in the concierge thread.
 *
 * NOT PERSISTED — the kind is absent from `conciergeThreadStore.PERSISTED_KINDS`, which is an
 * allow-list, so this is the default rather than an omission. The thread's saved half is the
 * CONVERSATION (`you` / `sparkle`); peer traffic is live coordination between machines, and a
 * restored "taking the parser" from a branch that landed last night is a claim about the present
 * that stopped being true while the app was closed.
 */
export interface ConciergePeerMessage {
  id: string;
  kind: "peer";
  /** Who sent it. */
  from: PeerParty;
  /** Who it was queued for. NOT who has read it — `send_peer_message` returns an enqueue receipt,
   *  and this row must not claim more than that receipt does. */
  to: PeerParty;
  /** The two-line clamp: the sender's own one-line summary, or the message's opening lines when it
   *  wrote none. Never empty — see {@link peerMessageEntry}. */
  gist: string;
  /** The message verbatim, revealed by expanding the row. Rendered as PLAIN TEXT, never through
   *  `<Markdown>`: it is a machine string written for another machine, where a `_` or a `*` is a
   *  character rather than a formatting instruction — the same contract the failure bubble's
   *  evidence follows. */
  text: string;
}

/**
 * Characters below which two clamped lines CANNOT have hidden anything.
 *
 * DELIBERATELY PESSIMISTIC, and that direction is the whole point (roborev 68628). Whether the clamp
 * actually hid text is a LAYOUT fact: it depends on the column's width, the reader's zoom and the
 * font, and nothing in JS can see it here — jsdom performs no layout at all, and a browser's own
 * answer only exists after paint. So the row cannot ask "did it overflow?"; it can only ask "is this
 * short enough that it could not have".
 *
 * The two ways to be wrong are not symmetric. Guessing too HIGH hides text behind a clamp with no
 * control to reveal it — the exact failure this file's header calls worse than the invisibility the
 * feature replaces. Guessing too LOW shows a control that occasionally reveals nothing new. Forty
 * characters per line is well under what the narrowest usable column fits, so the second is the only
 * mistake this number can make.
 */
export const PEER_CLAMP_SAFE_CHARS = 2 * 40;

/** Lines of the message used as the clamp when the sender wrote no gist.
 *
 *  TWO, matching the CSS clamp exactly. Handing the clamp more lines than it can draw and letting it
 *  hide the rest would make "expand" the only way to discover a third line exists — including for a
 *  message whose entire content is those three short lines, where expanding then adds nothing the
 *  reader could not have been shown outright. */
export const PEER_GIST_FALLBACK_LINES = 2;

/**
 * Does this send belong in the log the founder is looking at?
 *
 * SCOPED TO THE SELECTED PROJECT, plus the two app-global agents. The concierge and Improve Sparkle
 * are not rows in any project (`controlListener.resolveSpecialAddressee`), so a project comparison
 * can only ever exclude them — and the concierge's own traffic is a large part of what makes the
 * column readable as a conversation rather than as a log of strangers.
 *
 * `null === null` IS NOT A MATCH, and that line is the reason this is a function rather than a
 * comparison at the call site. A caller with no project and no project selected would otherwise
 * satisfy an `===` and put every projectless send on screen — "no project" widening to "all
 * projects" is the same failure `handleSendPeerMessage` fails closed on when resolving a recipient.
 */
export function peerRowBelongsInLog(opts: {
  callerProjectId: string | null;
  selectedProjectId: string | null;
  /** Either end of this message is an app-global agent (the concierge, or Improve Sparkle). */
  appGlobal: boolean;
}): boolean {
  if (opts.appGlobal) return true;
  if (!opts.selectedProjectId) return false;
  return opts.callerProjectId === opts.selectedProjectId;
}

/** The first {@link PEER_GIST_FALLBACK_LINES} non-empty-trimmed lines of a message, as the clamp. */
function openingLines(message: string): string {
  return message
    .split("\n")
    .slice(0, PEER_GIST_FALLBACK_LINES)
    .join("\n");
}

/**
 * Build the row.
 *
 * THE GIST IS OPTIONAL AT THE TOOL AND MANDATORY HERE. `send_peer_message` gained a `gist`
 * parameter for this feature, but a parameter every agent is asked to write is one some agents will
 * not write — and a row whose clamp is blank would announce that a message happened and then refuse
 * to say anything about it, which is a worse surface than the invisibility it replaces. So the
 * fallback is not a nicety: it is what lets the tool keep the parameter optional, which is what
 * keeps every agent already calling the tool working unchanged.
 *
 * A WHITESPACE-ONLY GIST IS NO GIST. `-m ""`-shaped arguments are ordinary from a model filling a
 * field it has nothing to say for, and `"   "` would otherwise draw an empty clamp while reporting
 * itself as sender-written.
 */
export function peerMessageEntry(opts: {
  id: string;
  from: PeerParty;
  to: PeerParty;
  message: string;
  gist?: string;
}): ConciergePeerMessage {
  // TRUNCATED, NEVER REFUSED — see PEER_GIST_MAX_CHARS. Counted in CHARACTERS rather than UTF-16
  // code units, the same correction `handleSendPeerMessage` makes for the message cap: `.slice`
  // would cut an astral character in half and leave a lone surrogate in the row.
  const chars = [...(opts.gist ?? "").trim()];
  const written =
    chars.length > PEER_GIST_MAX_CHARS
      ? chars.slice(0, PEER_GIST_MAX_CHARS).join("") + "…"
      : chars.join("");
  return {
    id: opts.id,
    kind: "peer",
    from: opts.from,
    to: opts.to,
    gist: written || openingLines(opts.message),
    text: opts.message,
  };
}

/**
 * Append one peer row to the concierge thread, if it belongs there.
 *
 * FIRE-AND-FORGET AND NEVER THROWS UPWARD BY DESIGN — its one caller is `handleSendPeerMessage`,
 * AFTER the message has been enqueued successfully. A message that was delivered but could not be
 * DRAWN must still report itself as delivered; making the send's reply depend on the log would let a
 * rendering concern turn a successful send into a refusal, which is the opposite of this feature's
 * whole point.
 */
export function logPeerMessage(
  entry: ConciergePeerMessage,
  scope: Parameters<typeof peerRowBelongsInLog>[0],
): void {
  if (!peerRowBelongsInLog(scope)) return;
  setConciergeChat((prev) => [...prev, entry]);
}
