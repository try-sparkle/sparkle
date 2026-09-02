// WHERE A THREAD ARTIFACT SITS IN THE TRANSCRIPT — the rule, as a pure function.
//
// A thread artifact is something drawn between two bubbles that is not itself a bubble: today the
// live preview card and its notice twin (`PreviewCards.PreviewThreadArtifacts`, which is the only
// caller and whose header carries the founder's ask and the design). The rule lives HERE rather
// than beside that component for the same reason `replyAnchors` and `lintMarks` live apart from the
// store that applies them: it is a decision about data, it has nothing React in it, and a rule that
// can only be exercised by mounting a column is a rule nobody exercises.
//
// Split out under bead sparkle-75fbot, when the rule stopped being "the last message in the array"
// and became a comparison against `ConciergeMessage.arrivedAt`.
import type { ConciergeMessage } from "./types";

/**
 * MESSAGE KINDS THAT ARE PROJECTIONS RATHER THAN CONVERSATION, and therefore cannot hold an anchor.
 *
 * `ConciergeHost` builds `messages` in ARRIVAL order out of chat, digests and resolved cards, so
 * the newest entry is genuinely the newest thing that happened — which is what an anchor wants. But
 * a digest or a nudge is a projection of live fleet state: it RETIRES when the agents behind it
 * stand down, and an anchor pointing at a retired card resolves to nothing, which would send the
 * preview card jumping to the top of the transcript for a reason the reader cannot see.
 *
 * A chat bubble is only ever appended and trimmed from the FRONT, so anchoring to the newest one is
 * stable — and when it does eventually age out of the 200-entry window, "above everything on
 * screen" is the honest position rather than a glitch.
 *
 * These two kinds are also the ones that never carry an `arrivedAt`: they never enter
 * `conciergeThreadStore`'s `chat` at all (the host concatenates them in at the view model), so the
 * stamper never sees them. The two facts agree, and neither is load-bearing for the other — this
 * set is checked FIRST, so a projection is refused whether or not anything ever stamps it.
 */
export const VOLATILE_ANCHOR_KINDS = new Set<ConciergeMessage["kind"]>(["nudge", "digest"]);

/**
 * The message an artifact that arrived at `at` belongs under: the NEWEST anchorable message that
 * arrived at or before that instant, or `null` when the thread holds none — see
 * {@link VOLATILE_ANCHOR_KINDS}. An artifact that arrives into an empty conversation anchors to
 * nothing, which draws it at the top: correct, because there is nothing for it to be under.
 *
 * ══ DERIVED FROM DATA, WHICH IS THE POINT (bead sparkle-75fbot) ═════════════════════════════════
 * `at` is the artifact's own arrival instant — a preview card's `surfacedAt`, a notice's
 * `startedAt` — and `arrivedAt` is the message's (see `ConciergeMessageArrival`). Both are facts
 * about when something HAPPENED rather than about who rendered first, so this answers the same way
 * on every later render: a remount, a restored thread, a different session. Before it, the position
 * lived only in a ref captured the first time the component rendered — and that ref dies more often
 * than it looks, because mounting a build agent swaps the concierge transcript out entirely, so
 * coming back re-anchored the card at the bottom of the conversation.
 *
 * ══ AN UNSTAMPED MESSAGE READS AS OLDER, AND THAT IS THE FALLBACK ══════════════════════════════
 * A thread persisted by a build that predates `arrivedAt` restores with no stamps, and a fixture
 * need not carry any. Those are treated as "arrived at an unknown time, therefore before this" —
 * true of the only population that has it, since `persistableThread` keeps the OLDEST turns at the
 * front. With NOTHING stamped this collapses exactly to the pre-existing rule (the newest anchorable
 * message, whatever `at` says), so an older thread gets the behaviour it always had.
 */
export function anchorableIdAt(messages: ConciergeMessage[], at: number): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (VOLATILE_ANCHOR_KINDS.has(m.kind)) continue;
    if (m.arrivedAt !== undefined && m.arrivedAt > at) continue;
    return m.id;
  }
  return null;
}
