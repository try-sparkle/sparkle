// THE COMPOSER'S PILLS. A completed `@Kraken Auth` reads as a pill while you are still writing the
// message, not only after you press Send.
//
// ══ THE DEFECT THIS FIXES ═══════════════════════════════════════════════════════════════════════
// The founder: a completed @-mention "renders as PLAIN TEXT in the compose window. It must render as
// a PILL in the composer." It already did in the sent bubble, so the address was legible everywhere
// except the one surface where the user can still change it. That is backwards: the composer is where
// an aim is reviewable, and under a mount (plain text goes to the patched terminal, `@Sparkle` reaches
// the concierge) the pill is the ONLY thing on screen that says where this message is about to go.
//
// ══ WHY A MIRROR, AND NOT A CONTENTEDITABLE ═════════════════════════════════════════════════════
// A `<textarea>` cannot contain elements, so the obvious fix is to stop being one — swap in a
// contenteditable and render real pill nodes. That was rejected, and not on effort:
//
//   • ComposeBox's height engine measures `textarea.scrollHeight` against a placeholder floor and a
//     drag-overridable, PERSISTED user height (engine/composeBoxHeight). All of it is specified in
//     textarea terms.
//   • The rich placeholder overlay is positioned against the textarea's own border + padding, and
//     ComposeBox.tsx's header records that getting that geometry wrong clips the copy SILENTLY.
//   • Every caret rule in this feature — `mentionQuery` reading `selectionStart`, `backspaceMention`
//     at a token's trailing edge, `restoreCaret` writing an offset back after a pick — is expressed
//     as an integer offset into a plain string. A contenteditable replaces that with DOM ranges.
//   • IME composition, spellcheck, and undo/redo all behave in a textarea and all need re-solving in
//     a contenteditable.
//
// So the textarea stays exactly what it was, and this paints UNDER it: the same string, same type
// ramp, same padding, with the mention spans wrapped in the shared pill. The textarea is transparent
// (`background: transparent`, zIndex 1) and this sits at zIndex 0, so the fills show through behind
// real, selectable, caret-bearing text. The user reads one thing; the caret never learns anything new.
//
// Everything visible in here EXCEPT the fills is therefore a duplicate of what the textarea already
// draws, which is why the mirrored text is `transparent`: it exists to put the pills in the right
// place, not to be read. Doubling the glyphs is how you get the fringing that makes this technique
// look broken.
import { useEffect, useRef, type CSSProperties, type RefObject } from "react";
import { mentionsIn, splitMentionText, type MentionAgent } from "./mentions";
import { MentionPill, MENTION_PILL_FILL } from "./MentionPill";

/** The composer's own pill id. Distinct from the sent bubble's on purpose — both are on screen at
 *  once (a draft under a thread), so one shared id would make `getByTestId` ambiguous exactly when a
 *  test is asking about one of them. Same component, same fill; different surface. */
export const COMPOSE_MENTION_PILL_TESTID = "concierge-compose-mention-pill";

export const MENTION_MIRROR_TESTID = "concierge-compose-mention-mirror";

/**
 * The marker that keeps this layer OUT of the placeholder-height measurement.
 *
 * ComposeBox's layout effect walks every non-textarea child of the overlay wrapper and takes the
 * tallest as `placeholderH`, a FLOOR under auto-grow. That rule was written when every such child was
 * a placeholder overlay, and it is stated in ComposeBox as "no marker attribute is needed".
 *
 * This layer breaks that premise: it mirrors the text, so its natural height tracks the CONTENT, and
 * feeding it in as a floor would add the textarea's chrome (~22px) on top of a height that already
 * includes the padding — growing the box by about a line for every draft that has any text in it, and
 * fighting a persisted drag height while doing so. It is not a placeholder, so it is not measured.
 * The attribute is exported rather than spelled twice; ComposeBox skips exactly this value.
 */
export const MENTION_MIRROR_SKIP_ATTR = "data-compose-skip-measure";

/**
 * What the shared pill has to give up to be a MIRRORED pill: ALL of its layout footprint.
 *
 * ══ THE BUG THIS EXISTS TO PREVENT (roborev 55574, High) ════════════════════════════════════════
 * The whole technique rests on one property: every glyph in this layer sits at the same x,y as the
 * same glyph in the textarea. `COMPOSE_TEXT_METRICS` buys that for the BOX — the type ramp, the
 * padding, the border — and is silent about INLINE content, which is where it was being lost:
 *
 *   • `padding: "1px 4px"` from MENTION_PILL_STYLE is 8px of horizontal ADVANCE that the textarea's
 *     text does not have. So the fill started at the right place and ran 8px long, and every glyph
 *     after the pill was pushed right — accumulating 8px per pill, so with two mentions the second
 *     fill sat a character and a half off the words it was supposed to be behind.
 *   • `whiteSpace: "nowrap"` is right for a sent bubble (an address should not break across lines)
 *     and WRONG here for the same reason: the textarea DOES wrap `@Blueprint UI/UX` at its internal
 *     space, so refusing to wrap made whole lines diverge past that point and a fill could land on a
 *     different row than its words.
 *
 * So the mirrored pill takes ZERO space: no padding, and it wraps exactly as the textarea does. The
 * visual inset that made the pill look like a pill is repainted with `boxShadow`'s spread, which is
 * the point of using it here — a shadow is not in the layout flow, so it can extend the fill past the
 * glyphs without moving a single one of them. `boxDecorationBreak: clone` keeps both halves filled
 * when a wrap does split a pill.
 *
 * The shared MENTION_PILL_STYLE keeps its real padding — the sent bubble and the concierge's own
 * agent pill both need it, and they are not mirroring anything.
 */
const MIRRORED_PILL: CSSProperties = {
  // The real glyphs come from the textarea sitting on top of this; painting them here as well would
  // double every letter inside a pill.
  color: "transparent",
  padding: 0,
  whiteSpace: "inherit",
  boxShadow: `0 0 0 3px ${MENTION_PILL_FILL}`,
  boxDecorationBreak: "clone",
};

export function MentionMirror({
  text,
  agents,
  /** The typography and box metrics of the textarea this sits behind. Passed in rather than
   *  re-declared, because they must MATCH EXACTLY: a pixel of difference in padding, font size or
   *  line height and the fills slide off the words they are supposed to be behind. Sharing the
   *  object is what makes that structural instead of a comment asking two files to agree. */
  metrics,
  /** The textarea, so this layer can follow it when the content scrolls past the ten-line cap. */
  textareaRef,
}: {
  text: string;
  /** The LIVE roster — the same one the picker offers from and a send resolves against, so a pill
   *  appears exactly when the text would actually address someone. An agent that leaves the fleet
   *  takes its pill with it, which is the whole point of deriving mentions from the text. */
  agents: readonly MentionAgent[];
  metrics: CSSProperties;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);

  // FOLLOW THE TEXTAREA'S SCROLL. Past the auto-grow cap the textarea scrolls its own overflow
  // (`overflowY: auto`), and a fixed mirror would leave the pills stranded at the top of the box,
  // painted behind whatever lines happen to be in view. Wired as a real listener rather than through
  // React's onScroll on the textarea, so this component owns the whole of its own alignment and
  // ComposeBox does not have to remember to forward an event for it.
  useEffect(() => {
    const ta = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    const sync = () => {
      mirror.scrollTop = ta.scrollTop;
      mirror.scrollLeft = ta.scrollLeft;
    };
    sync(); // catch up on mount, and after any re-render that changed the text
    ta.addEventListener("scroll", sync);
    return () => ta.removeEventListener("scroll", sync);
  });

  // The SAME splitter the sent bubble uses, fed the mentions this text currently resolves to. Going
  // through `mentionsIn` → `splitMentionText` rather than calling `findMentionSpans` directly keeps
  // one notion of where a mention starts and ends: the composer's pills and the bubble's pills are
  // produced by the same code, so they cannot come to disagree about what counts as a mention.
  const parts = splitMentionText(text, mentionsIn(text, agents));

  return (
    <div
      ref={mirrorRef}
      data-testid={MENTION_MIRROR_TESTID}
      {...{ [MENTION_MIRROR_SKIP_ATTR]: "true" }}
      // Decorative in the strictest sense: the textarea holds the real text and carries the
      // accessible name, so announcing these words again would read the draft twice.
      aria-hidden
      style={{
        ...metrics,
        position: "absolute",
        inset: 0,
        // Never take a click or a drag-select — the textarea underneath owns every gesture.
        pointerEvents: "none",
        // Below the textarea (zIndex 1), which is transparent, so only the fills read through.
        zIndex: 0,
        overflow: "hidden",
        // Wrap like a textarea does, and preserve the user's own runs of spaces and newlines: with
        // `pre-wrap` the mirrored string breaks at the same points the real one does, which is what
        // keeps a pill on the same line as the words it belongs to.
        whiteSpace: "pre-wrap",
        overflowWrap: "break-word",
        // The glyphs are the textarea's job; this layer contributes the pill fills only. The pill
        // sets its own `color`, so its text would otherwise print on top of the real text.
        color: "transparent",
      }}
    >
      {parts.map((part, i) =>
        part.kind === "text" ? (
          // The index IS the identity: these are positional slices of one string, re-derived
          // wholesale on every edit, so there is no element to preserve across renders.
          <span key={i}>{part.text}</span>
        ) : (
          <MentionPill
            key={i}
            agentId={part.agentId}
            testId={COMPOSE_MENTION_PILL_TESTID}
            style={MIRRORED_PILL}
          >
            {part.text}
          </MentionPill>
        ),
      )}
    </div>
  );
}
