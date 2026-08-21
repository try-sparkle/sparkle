// "Sent to: ● @Agent" — the destination, drawn INSIDE the user's own bubble.
//
// WHY THIS EXISTS. The founder spent a minute working out, after the fact, which of his messages had
// left the concierge and gone to a build agent. Nothing on the bubble said so: a forwarded message
// and one the concierge answered itself were the same blue box, separated only by a grey line
// hanging OUTSIDE and BELOW it (./RoutingReceipt) whose agent name was dead text — not clickable, no
// status dot, no way to get to the agent it named.
//
// His instruction: *"it would be inside the card with the black background and it would say sent to
// colon, and then it would have the agent as a clickable link. And it would have a color of the
// pill. So just like when you're giving me alerts, it would be that same kind of thing."*
//
// So this row answers BOTH halves of his question at a glance while scrolling: the card's black
// ground says THIS LEFT THE ROOM (theme/colors CHAT_SENT_BUBBLE), and the pill says WHERE IT WENT —
// and being a real `AgentPill`, clicking it goes there. That last part is the whole point: the dead
// label is what made him work it out by hand.
//
// THE PILL IS REUSED, NEVER RESTYLED. `AgentPill` is the same component the nudge cards and the
// concierge's own replies draw ("● @Drodio Booking Manage Link" in his screenshot) — it carries the
// live status dot, it tracks a rename, and it is already wired to open the agent. Anything here that
// merely LOOKED like a pill would be a dead link in a new costume, which is the bug being fixed.
//
// NO PROVIDER PLUMBING: the row renders inside ConciergeMessageRow, which is inside ConciergeThread,
// which ConciergeColumn wraps in `AgentPillProvider`. Same reasoning already recorded at
// MessageStatus.tsx:236 — the pill resolves its roster from context, so it costs no new props.
import type { CSSProperties } from "react";
import {
  C,
  CHAT_SENT_FILL,
  CHAT_SENT_INK,
  CHAT_SENT_MUTED,
} from "../../theme/colors";
import { TYPE } from "../../theme/scale";
import { AgentPill } from "./AgentPill";
import type { ConciergeReceipt } from "./types";

export const SENT_TO_AGENT_TESTID = "sent-to-agent";

/**
 * THE INK PINNING, and it is what makes a black card possible at all rather than a nicety.
 *
 * `C.cream` is not a colour, it is the string `var(--c-cream)` — and that token is the app's INK:
 * #dce8fc in dark, but **#0a1b33 in light**. So a card that is black in BOTH themes cannot use the
 * themed ink. Paint one and light mode renders near-black on black: the message text, the agent
 * pill's own label (AgentPill.tsx:353,685 / MentionPill.tsx:37), and every collapsed-paste pill go
 * invisible together. A fixed-luminance surface needs fixed inks.
 *
 * Applied by REDEFINING the custom properties on the card element itself, so the whole subtree —
 * AgentPill, MentionPill, TextPill, CopyAnswerButton, AttachmentStrip — resolves to the pinned
 * values. That is the entire mechanism: no component below knows this card exists, no prop is
 * threaded, and nothing can drift out of sync because there is only one definition.
 *
 * The alternative was a `variant` prop on each of those components, which is four files changed, four
 * more call sites to keep honest, and a fifth one forgotten the next time something is added to a
 * bubble. The token layer already solves this; it just had to be used at a smaller scope than :root.
 *
 * THE CAST IS UNAVOIDABLE: `CSSProperties` has no index signature for custom properties, and React
 * has passed `--*` keys straight through to the style attribute since 16. Kept here, once, with this
 * reasoning attached, rather than repeated at the call site.
 */
export const SENT_CARD_INK_VARS = {
  "--c-cream": CHAT_SENT_INK,
  // ⚠ PINNED TOO, AND FOR THIS CARD ONLY. `--c-pill-ink` is what a clickable pill's LABEL resolves
  // (see C.pillInk); it was split off `--c-cream` so that the OTHER row which re-inks its subtree —
  // NoticeAttribution's NOTICE_INK_VARS — could stop greying pills. This card wants the opposite,
  // because it changes the GROUND rather than the emphasis: it is black in both themes, so a pill
  // left on the themed ink is near-black on black in light mode — exactly the failure the rest of
  // this object exists to prevent. A ground change pins this token; a de-emphasis must not.
  "--c-pill-ink": CHAT_SENT_INK,
  "--c-concierge-muted": CHAT_SENT_MUTED,
  "--c-muted": CHAT_SENT_MUTED,
  // THE ONE FILL THE SUBTREE PAINTS FOR ITSELF, pinned for the same reason and by the same
  // mechanism. A non-thumbnail attachment chip (AttachmentStrip) draws a GROUND of its own inside
  // this bubble; pinning only the ink left that ground themed, so light mode put fixed-dark ink on
  // a pale chip — ~1.07:1, the label invisible inside its own tile. Declaring `color` on the card
  // cannot reach it, because the chip declares its own background.
  //
  // The collapsed-paste pill is NOT pinned and does not need to be — it is translucent and
  // composites over the card's black. See CHAT_SENT_FILL in theme/colors for that and for sienna.
  "--c-chat-bubble": CHAT_SENT_FILL,
  // ⚠ THE VARS ALONE ARE NOT ENOUGH, AND THIS LINE IS WHY. Redefining a custom property only
  // affects elements that RESOLVE it at or below this one. The message body resolves nothing: it
  // has no `color` of its own and inherits a COMPUTED one from the COLUMN — ConciergeColumn.tsx:335,
  // `color: isWired ? BLUEPRINT[mode].termInk : C.cream`, set on the section precisely so everything
  // beneath it follows in one place. That was resolved against the THEME's `--c-cream` far above the
  // card and is inherited as a finished rgb value; redefining the token here cannot reach back and
  // re-resolve it. (The `isWired` arm is why the card is suppressed in a mounted column: there the
  // inherited ink is the terminal's, not the shell's.)
  //
  // So in light mode the pinned inks fixed the "Sent to:" label and the pill — both of which name
  // `var(--c-*)` themselves — while the founder's own words stayed #0a1b33 on black. That is the
  // exact bug this object exists to prevent, surviving in the one place nothing looked, because the
  // parts that were checked were the parts that resolve the var.
  //
  // Declaring `color` HERE re-resolves it on the card itself, against the pinned value defined in
  // this same object, and the whole subtree inherits that instead. Written as the token rather than
  // CHAT_SENT_INK directly so there is still exactly ONE definition of the card's ink.
  color: "var(--c-cream)",
} as CSSProperties;

/** What this row draws, or `null` when the message never reached an agent and the row must not
 *  render at all.
 *
 *  Pure and exported because WHICH MESSAGES GET THE BLACK CARD is a correctness question, not a
 *  styling one — the same reasoning that made `receiptText` pure in ./RoutingReceipt. A card that
 *  claims a delivery which did not happen is worse than no card, because the founder is about to
 *  start trusting the colour to answer "did this leave the room" without reading anything. */
export function sentToAgent(
  r: ConciergeReceipt,
): { agentId?: string; agentName: string; thenHere: boolean } | null {
  // A REFUSED MESSAGE WENT NOWHERE — the target terminal declined it and the text went back to the
  // composer. It is the one case that must NOT get the card, and the founder chose this himself when
  // asked: black means "it went", so a message that bounced has to stay visibly different or the
  // colour stops being a signal he can trust. Its wording keeps its existing home below the bubble.
  if (r.refused) return null;
  // Both orderings count as "it reached an agent". `target` is the first delivery; `alsoSentTo` is a
  // second one from the redirect path that has since been removed, and which still exists on
  // rehydrated threads (see ./RoutingReceipt's header).
  const reached = r.target === "agent" || r.alsoSentTo === "agent";
  if (!reached) return null;
  return {
    agentId: r.agentId,
    // The receipt's own fallback, matching `place()` in ./RoutingReceipt so the two surfaces cannot
    // name the same message's destination differently.
    agentName: r.agentName ?? "the agent",
    // ONLY the agent-first ordering says anything more. Sparkle-first already drops "here" in the
    // line below the bubble (founder, 2026-08-04: the concierge answering IN PLACE is self-evident
    // from the reply appearing underneath), so repeating it here would reintroduce the noise that
    // removal was about. Agent-first keeps its sequence because the order is real content.
    thenHere: r.target === "agent" && r.alsoSentTo === "sparkle",
  };
}

/**
 * The row. Renders nothing for a message that did not reach an agent.
 *
 * SEPARATED BY A DRAWN RULE, NOT A SECOND FILL. The destination is a different KIND of fact from the
 * words above it, so it needs a boundary — but a tinted strip inside an already-filled card is two
 * shapes saying one thing. A hairline is the direction's own answer (theme/blueprintSpec: *structure
 * is drawn, not filled*), and it is the one piece of chrome this row adds.
 *
 * LEFT-ALIGNED, unlike the right-aligned line it replaces. That line was a margin annotation and sat
 * where annotations sit; this is the card's own content and reads with the message text above it.
 *
 * NO ARROW. The old "→" pointed AWAY from the bubble, which was its job while the label floated
 * outside one. Inside the card it points at nothing.
 */
export function SentToAgentRow({ receipt }: { receipt: ConciergeReceipt }) {
  const sent = sentToAgent(receipt);
  if (!sent) return null;
  return (
    <div
      data-testid={SENT_TO_AGENT_TESTID}
      data-agent-id={sent.agentId ?? ""}
      style={{
        marginTop: 8,
        paddingTop: 7,
        // The ink is PINNED rather than themed — see CHAT_SENT_INK. `C.hairline` would be wrong
        // here twice over: it is a themed pair (so it inverts under a card that does not), and it is
        // tuned against the column's planes rather than against black.
        borderTop: `1px solid color-mix(in srgb, ${CHAT_SENT_INK} 14%, transparent)`,
        display: "flex",
        alignItems: "center",
        gap: 6,
        fontSize: TYPE.small,
        // Resolves to CHAT_SENT_MUTED, because the card redefines `--c-concierge-muted` on itself.
        // Written as the token rather than the constant so this row stays correct if it is ever
        // drawn somewhere that is not the black card.
        color: C.conciergeMuted,
        // A long agent name wraps to its own line rather than pushing the pill out of the card.
        flexWrap: "wrap",
        // The label is scaffolding; the pill is the content. Left-aligned per the note above.
        textAlign: "left",
      }}
    >
      <span>Sent to:</span>
      {sent.agentId ? (
        <AgentPill agentId={sent.agentId} fallbackName={sent.agentName} />
      ) : (
        // NO PILL WITHOUT AN ID. A pill is a promise that clicking it goes somewhere, and a receipt
        // with no `agentId` has nowhere to go — so this degrades to the name as plain words rather
        // than drawing a button wired to nothing.
        <span>{sent.agentName}</span>
      )}
      {sent.thenHere && <span>, then here</span>}
    </div>
  );
}
