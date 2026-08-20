// The exact text this router writes — the doorbell it queues, and the two kinds of comment it posts
// back onto the bead. Pure string builders, kept in one file so the WRITER and the READER of each
// marker cannot drift apart.
//
// ── THE LOOP THE MARKER EXISTS TO PREVENT ────────────────────────────────────────────────────────
// This router READS bead comments and WRITES bead comments. A refusal that names the handle it could
// not resolve is therefore a comment containing an unresolvable handle — which the next tick reads as
// a fresh mention, refuses, and posts again, forever, on a store the whole fleet shares and a board
// that repaints every five seconds. Two independent guards, because one silent failure here is
// unbounded:
//
//   1. Every comment this module writes carries `ROUTER_MARKER`, and the router SKIPS any comment
//      carrying it (`isRouterAuthored`). This is the load-bearing one.
//   2. No comment this module writes contains an `@`. A handle is quoted bare — `"foo"`, never
//      `"@foo"` — so even a comment that somehow evaded guard 1 yields no token to route.
//
// Guard 2 alone would be enough for the refusal path and guard 1 alone would be enough for all of
// them, which is the point: they fail independently.

/** Stamped into every comment this router writes, and the thing `isRouterAuthored` looks for. */
export const ROUTER_MARKER = "[mention-router]";

/** Was this comment written by us? Such a comment is never scanned for mentions — see the loop note
 *  above.
 *
 *  THE CONTRACT IS THAT OUR COMMENTS *LEAD* WITH THE MARKER — do NOT prepend anything to it. This
 *  check is anchored, so a future build that prefixes a timestamp or an author tag would make it
 *  return `false` for the router's own comments and silently re-open the refusal loop the file
 *  header calls unbounded. `every_comment_we_write_leads_with_the_marker` in the test file exists to
 *  turn that edit into a red test rather than a live comment storm. */
export function isRouterAuthored(commentText: string): boolean {
  // ANCHORED, not a substring test. A substring match drops the WHOLE comment on a marker hit, so a
  // human who quotes a refusal and replies to it — the natural response, and the one our own copy
  // invites by saying "re-comment naming an agent id" — would have their reply silently skipped,
  // mentions included. That is a strictly worse failure than the loop this guard prevents: a mention
  // that reaches nobody AND is never reported. Our own comments always LEAD with the marker, so
  // anchoring costs nothing and a quoted marker mid-body no longer swallows the comment.
  return commentText.trimStart().startsWith(ROUTER_MARKER);
}

/** Strip an `@` from a handle so a quoted handle in our own comment can never be re-parsed as a
 *  mention (guard 2). Also collapses whitespace, so a multi-word display name stays on one line. */
function quoteHandle(token: string): string {
  return `"${token.replace(/@/g, "").replace(/\s+/g, " ").trim()}"`;
}

/**
 * THE DOORBELL — the inbox message. Content-FREE, exactly as `mention.rs` rule 1 requires: it names
 * who mentioned you and which bead, and points there. The comment body is deliberately NOT copied in.
 *
 * WHY THE BODY MUST NOT RIDE ALONG. The bead is the founder-visible record of the conversation; the
 * inbox is a private per-agent queue. The moment the text lives in both, the two can disagree — an
 * edited or superseded comment leaves an agent acting on a copy nobody else can see. Pointing at the
 * bead means the agent reads whatever is CURRENTLY true.
 *
 * It also never injects itself into a terminal: this string is queued, and the agent meets it at a
 * turn boundary. Chat text never reaches an agent's stdin (bead sparkle-xnjil.13).
 */
export function buildDoorbell(from: string, beadId: string): string {
  // NO `ROUTER_MARKER` HERE, deliberately. This is an inbox message, not a bead comment, and nothing
  // ever scans it for mentions — so the marker bought nothing, while making the doorbell's own text
  // (which tells the agent to "reply on the bead") a phrase that could silence a comment quoting it.
  return (
    `${from} mentioned you in a comment on bead ${beadId}. ` +
    `Read the comment there — nothing actionable is in this notice, and it is not an instruction ` +
    `from your human. If it changes what you are doing, reply on the bead so the record is one thread.`
  );
}

/** One handle that did not produce a doorbell, and why. `token` is quoted WITHOUT its `@` (guard 2). */
export interface UnresolvedHandle {
  token: string;
  /** `unknown` — nothing by that name; `ambiguous` — two or more agents answer to it;
   *  `enqueue-failed` — it resolved FINE and the inbox refused the message.
   *
   *  THE THIRD ONE IS NOT A REFINEMENT, it is a correctness fix. Reporting a failed enqueue as
   *  `unknown` tells the writer the handle names nobody and to "re-comment naming an agent id" —
   *  and both halves are false: the agent resolved, its INBOX refused, so the suggested remedy
   *  hits the identical failure. A remedy string is an instruction the reader will follow, so it
   *  needs the same analysis as the code path it replaces. */
  reason: "unknown" | "ambiguous" | "enqueue-failed" | "shadowed" | "capped";
  /** For `ambiguous`, the colliding agent ids, so the writer can address one directly. */
  ids?: readonly string[];
  /** For `enqueue-failed` and `shadowed`, the id involved — so the report can name it. */
  resolvedId?: string;
}

/**
 * The refusal posted back onto the SAME bead, so a mention that reached nobody is visible to whoever
 * wrote it — agent or human — rather than failing silently.
 *
 * ONE COMMENT PER SOURCE COMMENT, never one per handle: a comment naming four dead handles must not
 * become four comments on a shared board. Returns null when there is nothing to report, so the caller
 * cannot post an empty comment.
 */
export function buildUnresolvedComment(
  beadId: string,
  unresolved: readonly UnresolvedHandle[],
  /** How many doorbells this comment ACTUALLY queued. The heading is derived from this and nothing
   *  else — see the note on `heading` below. */
  deliveredCount = 0,
): string | null {
  if (unresolved.length === 0) return null;
  const lines = unresolved.map((u) => {
    if (u.reason === "ambiguous") {
      return `  - ${quoteHandle(u.token)} matches ${u.ids?.length ?? 0} agents (${(u.ids ?? []).join(
        ", ",
      )}) — name one of those ids instead.`;
    }
    if (u.reason === "shadowed") {
      return (
        `  - ${quoteHandle(u.token)} is a RESERVED handle, so the notice went there — but a live ` +
        `agent in this project answers to that name too. To reach that agent, name its id ` +
        `(${u.resolvedId ?? "unknown"}).`
      );
    }
    if (u.reason === "capped") {
      return (
        `  - ${quoteHandle(u.token)} was NOT woken: this bead's @mention exchange has hit its ` +
        `anti-loop round cap, so nothing further is posted, queued or woken on it. Start a new ` +
        `thread, or reach ${u.resolvedId ?? "them"} another way.`
      );
    }
    if (u.reason === "enqueue-failed") {
      return (
        `  - ${quoteHandle(u.token)} resolved to ${u.resolvedId ?? "an agent"}, but the notice ` +
        `could NOT be queued — that agent's inbox refused it. Re-commenting will hit the same ` +
        `refusal; reach them another way.`
      );
    }
    return `  - ${quoteHandle(u.token)} matches no agent that can be addressed right now.`;
  });
  // The closing remedy speaks only to the handles it is actually true for. An `enqueue-failed`
  // entry carries its own remedy above, because "name an agent id" is guaranteed to fail for it.
  const anyResolvable = unresolved.some(
    (u) => u.reason !== "enqueue-failed" && u.reason !== "shadowed",
  );
  const remedy = anyResolvable
    ? "\nRe-comment naming an agent id to reach someone."
    : "";
  // A `shadowed` entry rides along with a SUCCESSFUL delivery, so the headline must not claim the
  // mention reached nobody — that would be false, and a report people learn to distrust is worse
  // than none. Only a report made up entirely of shadow notes gets the softer heading.
  // THE HEADING FOLLOWS THE ACTUAL DELIVERY COUNT, and nothing else.
  //
  // Inferring it from the PRESENCE of a `shadowed` entry was wrong in both directions, and the
  // comment that used to sit here claimed the property the code lacked — so a reader would not have
  // gone looking. Over-claiming: a shadow note is recorded beside a doorbell that can still fail to
  // queue, and the pair then read as "partially delivered" when nothing was. Under-claiming: a
  // comment naming five live agents plus one typo has no shadow at all, so it was headed "reached
  // nobody" while five doorbells went out. Both write a false statement into a shared,
  // founder-visible, non-revertible store, which is the failure this whole report exists to avoid.
  const allShadows = unresolved.every((u) => u.reason === "shadowed");
  const heading =
    deliveredCount === 0
      ? `${ROUTER_MARKER} NOT DELIVERED — a mention in the comment above reached nobody:`
      : allShadows
        ? `${ROUTER_MARKER} DELIVERED, with a caveat — a handle in the comment above is ambiguous ` +
          `between a reserved address and a live agent:`
        : `${ROUTER_MARKER} PARTIALLY DELIVERED — some handles in the comment above went nowhere:`;
  return `${heading}\n${lines.join("\n")}${remedy}`;
}

/**
 * The UNDELIVERED report, posted when a doorbell that WAS queued has still not been handed to the
 * agent past the deadline.
 *
 * THIS IS THE POINT OF THE WHOLE FEATURE, so it is worth stating why it is a bead comment rather than
 * a return value. On 2026-08-14 a send returned `{ok:true, messageId}` for four messages the agent
 * never saw — and `inbox_status` then reported them ACKNOWLEDGED, because a different `claude` in the
 * same worktree had drained and acked them. The receipt was real and attributable to nobody. So a
 * queued doorbell is NOT a delivered doorbell, and the only honest thing to do with silence is to say
 * so, out loud, on the record the sender is already reading.
 *
 * `state` is the queue's own word for where the message actually got to — never a guess.
 */
export function buildUndeliveredComment(
  targetName: string,
  beadId: string,
  state: "pending" | "missing" | "unacked" | "superseded" | "unmatched" | "unjudgeable",
  waitedMs: number,
): string {
  const mins = Math.max(1, Math.round(waitedMs / 60000));
  // `missing` is NOT a weaker `pending` — it is the queue saying it has no record of this notice at
  // all (expired, compacted, or the agent's queue torn down). Treating it as success would be a
  // fail-OPEN in the one direction this whole feature claims to be closed, so it gets its own,
  // blunter sentence rather than sharing the reassuring one.
  // `unacked` is the MENTION-CHANNEL verdict, and it is the strongest of the three: the recipient
  // was woken and has still not posted an ACK comment on this thread. Deliberately worded as
  // "not confirmed" rather than "not delivered" — the wake demonstrably fired, so claiming
  // non-delivery would be its own false statement.
  // `untracked` MUST NOT ASSERT NON-DELIVERY, and that is the whole reason it is its own state.
  // A thread tracks ONE round's ACK — the latest — so once a later mention lands on the same bead,
  // an earlier notice's acknowledgement stops being reported even though the recipient may well
  // have acked its own round (the responder is instructed to, and `thread_has_ack` is per-round;
  // only `status_of` is not). Saying "it has not acknowledged this thread / treat as unread" there
  // is a categorically FALSE statement about an agent that read and answered — written onto a
  // shared, founder-visible, non-revertible store, with a remedy the author would act on. So this
  // one reports UNKNOWN, and says where to look.
  // TWO CAUSES, TWO SENTENCES. Collapsing them onto one line that asserted supersession made the
  // notice wrong about WHY even once it was right about delivery: on a bead carrying exactly one
  // mention, a lost thread state would tell the author a later exchange had occurred, sending them
  // to look for a second mention that does not exist. Same store, same non-revertible record, same
  // class of false claim as the "unread" wording this replaced.
  if (state === "superseded") {
    return (
      `${ROUTER_MARKER} UNCONFIRMED after ${mins}m — the notice for ${quoteHandle(targetName)} ` +
      `about bead ${beadId} was queued and that agent was woken, but this thread has since moved ` +
      `on to a later exchange, so only the latest one's acknowledgement is tracked. Whether this ` +
      `notice was read is UNKNOWN — it may well have been. Check this bead's ACK comments before ` +
      `assuming either way.`
    );
  }
  if (state === "unmatched") {
    // The state READ FINE; it simply does not line up with this notice — either the notice predates
    // round tracking, or the thread's round sits behind it (a restored/rolled-back state file).
    // Telling the author the state was unreadable would send them to inspect app data that is
    // healthy, and denying a later exchange that demonstrably happened is its own false claim.
    return (
      `${ROUTER_MARKER} UNCONFIRMED after ${mins}m — the notice for ${quoteHandle(targetName)} ` +
      `about bead ${beadId} was queued and that agent was woken, but this thread's @mention rounds ` +
      `no longer line up with it, so its acknowledgement cannot be matched to it. Whether it was ` +
      `read is UNKNOWN — it may well have been. Check this bead's ACK comments before assuming ` +
      `either way.`
    );
  }
  if (state === "unjudgeable") {
    return (
      `${ROUTER_MARKER} UNCONFIRMED after ${mins}m — the notice for ${quoteHandle(targetName)} ` +
      `about bead ${beadId} was queued and that agent was woken, but this thread's @mention state ` +
      `could no longer be read, so its acknowledgement cannot be checked. Nothing here says a ` +
      `later exchange occurred, and nothing says the notice failed — whether it was read is ` +
      `UNKNOWN. Check this bead's ACK comments before assuming either way.`
    );
  }
  const detail =
    state === "missing"
      ? `the queue no longer has any record of it, so it will NOT arrive.`
      : state === "unacked"
        ? `it was queued and that agent was woken, but it has not acknowledged this thread. Reading ` +
          `is NOT confirmed.`
        : `it is queued but has not been handed to that agent yet. It is NOT lost: it delivers when ` +
          `the agent next reaches a turn boundary.`;
  return (
    `${ROUTER_MARKER} UNDELIVERED after ${mins}m — the notice for ${quoteHandle(targetName)} about ` +
    `bead ${beadId} (state: ${state}): ${detail} Treat this as unread, not as agreement — if it ` +
    `matters now, reach that agent another way.`
  );
}
