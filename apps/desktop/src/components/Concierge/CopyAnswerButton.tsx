// The copy affordance under a concierge ANSWER (PRD 1 §2) — bottom-left, on the message's own left
// text edge, so it reads as belonging to the paragraph above it rather than floating in the column.
//
// IT SERVES BOTH SIDES OF THE CONVERSATION. The founder asked for "a copy button like we do for the
// concierge's responses" on his OWN messages, and the operative word is *like*: one component with a
// `kind`, not a second control that would drift a shade apart from this one the first time either
// was touched. `kind` changes exactly three things — the label, the test id, and which edge the
// glyph is pulled onto — because a user bubble is RIGHT-aligned and a button mirrored to the left
// edge of a right-aligned bubble floats in the middle of the column and reads as unrelated chrome.
//
// IT COPIES THE MARKDOWN SOURCE, not the rendered text, and that is the whole point of it existing
// alongside copy-on-selection. The brain answers in GitHub-flavored markdown, so an answer's value
// is often in its STRUCTURE: a table is a grid, a code block is a fenced block. Copying the rendered
// `innerText` flattens both — the table becomes a run of cells with no columns and the code loses
// its fence — and what the user wanted was the thing they could paste back into a doc or an editor.
// The selection path copies plain text for the opposite reason: a partial selection has no markdown
// source (see useCopyOnSelection's header).
//
// ALWAYS RENDERED, never hover-mounted. Two reasons, one visual and one mechanical:
//   • An affordance you have to hover to discover is an affordance most people never find.
//   • The thread AUTO-FOLLOWS on a content key (ConciergeThread), and a footer that appears on
//     hover changes the message's height mid-stream — nudging the scroll position under a reader
//     who is doing nothing but moving the mouse. Reserving the height costs one row and cannot.
// So hover/focus change OPACITY only. Nothing about the layout moves.
import { useEffect, useRef, useState } from "react";
import { FiCheck, FiCopy } from "react-icons/fi";
import { C } from "../../theme/colors";
import { copyToClipboard } from "../../clipboard";
import { stripAgentRefs } from "./agentRefs";
import { stripBeadRefs } from "./beadRefs";
import { COPY_TOAST_MS } from "./useCopyOnSelection";

/** Resting opacity — present, findable, and quiet enough not to compete with the answer. */
const RESTING_OPACITY = 0.45;

/** WHOSE words this button copies. Drives the label, the test id and the alignment — see below. */
export type CopyButtonKind = "answer" | "message";

/**
 * The wording, per kind.
 *
 * THE LABEL STATES WHAT IS COPIED, and that reasoning doubled the moment the user's own bubbles got
 * one too. "Copy" alone, repeated once per message down a thread, was already a screen-reader list
 * of identical buttons; now that BOTH sides of the conversation carry one, a blind reader also has
 * to be able to tell "copy the answer Sparkle gave me" from "copy the thing I said". Two labels,
 * one per kind, is the cheapest way that stays true.
 *
 * `title` is deliberately NOT the same string in the copied state — a tooltip is transient and
 * pointer-only, so the bare "Copied" reads better there, while the aria-label has to remain
 * self-describing for a reader tabbing through a settled thread.
 */
const LABELS: Record<CopyButtonKind, { idle: string; copied: string; testid: string }> = {
  answer: { idle: "Copy answer", copied: "Answer copied", testid: "concierge-copy-answer" },
  message: { idle: "Copy message", copied: "Message copied", testid: "concierge-copy-message" },
};

export function CopyAnswerButton({
  text,
  kind = "answer",
  onCopied,
}: {
  /** The RAW markdown source of the answer (`m.text`), not its rendered form. */
  text: string;
  /** Whose words these are. Defaults to `"answer"`, so every call site that predates the user
   *  variant is unchanged and cannot have been silently relabelled. */
  kind?: CopyButtonKind;
  /** Copied. Announced by the integration layer through the column's ONE live region — this
   *  component adds no `aria-live` node of its own (see ConciergeColumnProps.announcement). */
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // Hover and keyboard focus are tracked separately on purpose: they can be true at the same time,
  // and folding them into one flag makes a blur turn the button dim while the pointer is still on it.
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  // Unmount-safe: the thread is CAPPED (stores/conciergeThreadStore evicts the oldest bubbles), so a
  // message really can disappear inside the confirmation window.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  const lit = hover || focus || copied;
  const label = LABELS[kind];
  // A user bubble is `alignSelf: "flex-end"` inside a right-aligned block; an answer is left-aligned
  // prose. So the glyph mirrors, or it sits under the middle of the column attached to nothing.
  const mirrored = kind === "message";

  return (
    <div style={{ display: "flex", marginTop: 2, justifyContent: mirrored ? "flex-end" : undefined }}>
      <button
        type="button"
        data-testid={label.testid}
        data-copied={copied ? "true" : "false"}
        // The label states WHAT is copied — see LABELS above for why that matters more, not less,
        // now that the user's own messages carry one of these too.
        aria-label={copied ? label.copied : label.idle}
        title={copied ? "Copied" : label.idle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onClick={() => {
          // AGENT REFERENCES ARE FLATTENED FIRST, and this is the one place that can be relied on
          // to do it — here rather than at the call sites, so a third `<CopyAnswerButton …>` cannot
          // forget. The source of an answer naming an agent contains
          // `[@Kraken Auth](sparkle-agent:9f3c…)`; copying that verbatim pastes a dead link around
          // an internal uuid into someone's PR or Slack thread. The pill reads `@Kraken Auth` and
          // the selection path already yields `@Kraken Auth`; this is what makes the third path
          // agree. Ordinary markdown — tables, fences, real links — is untouched, which is the
          // reason this button copies source at all (see the header).
          //
          // IT RUNS FOR `kind: "message"` TOO, and that is a backstop rather than a live need. A
          // user's mention is DERIVED from the literal `@Name` and recorded out-of-band in
          // `ConciergeUserMessage.mentions`, never encoded into the text — ./agentRefs' header
          // explains why that asymmetry exists — so `m.text` is plain and this is a no-op on it
          // today. Running it anyway costs one parse of a short string and means the day a fourth
          // consumer starts encoding into user text, an internal uuid still cannot reach the
          // clipboard by way of the one path that copies source verbatim.
          // BEAD REFERENCES ARE FLATTENED TOO, on the same terms — `./beadRefs`' header explains why
          // this consumer is charged twice rather than once. Two passes rather than one combined
          // walk because each is a parse of a short string and keeping them separate means neither
          // module has to know the other exists.
          //
          // AUTO-LINKIFIED IDS NEED NOTHING HERE and get nothing: `remarkBeadRefs` transforms the
          // parsed TREE, so `text` still holds the bare `sparkle-17hm1` the model wrote and it
          // copies through untouched. This is for the EXPLICIT `[…](sparkle-bead:…)` form, which
          // `conciergeLine.bead()` composes and which model-authored text can carry verbatim.
          void copyToClipboard(stripBeadRefs(stripAgentRefs(text))).then((ok) => {
            // Never claim a copy that didn't happen — no check mark, no announcement.
            if (!ok || !alive.current) return;
            setCopied(true);
            onCopied?.();
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              timer.current = null;
              if (alive.current) setCopied(false);
            }, COPY_TOAST_MS);
          });
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          background: "transparent",
          border: "none",
          // Pulled back by its own padding so the GLYPH — not the button box — lines up with the
          // message's own text edge. Which edge depends on the kind: an answer's is on the left, a
          // user bubble's is on the right (and its routing receipt is right-justified against the
          // same edge), so the negative margin swaps sides with it.
          padding: 2,
          ...(mirrored ? { marginRight: -2 } : { marginLeft: -2 }),
          cursor: "pointer",
          color: copied ? C.teal : C.conciergeMuted,
          opacity: lit ? 1 : RESTING_OPACITY,
          // Opacity only. See this file's header: nothing here may change the message's height.
          transition: "opacity 120ms ease",
          lineHeight: 0,
        }}
      >
        {copied ? <FiCheck size={13} aria-hidden /> : <FiCopy size={13} aria-hidden />}
      </button>
    </div>
  );
}
