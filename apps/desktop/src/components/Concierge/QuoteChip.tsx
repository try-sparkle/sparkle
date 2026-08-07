// The staged quote, drawn above the draft — the founder's answer to "it puts it into the compose box
// as a…", the sentence he never finished. He chose a removable chip over inline blockquote text so
// the draft stays clean prose: he types his reply, and what he is replying to sits above it as an
// object rather than as characters he has to edit around.
//
// THE SAME LEFT BAR the concierge's own reply stubs use (see ReplyAnchorViews' `stubStyle`), because
// this is deliberately the same idiom pointed the other way — his message quoting the concierge,
// where `ReplyAnchorStubs` is the concierge quoting him. A box would read as a card, i.e. another
// thing in the column; a bar reads as a margin note, which is what a quote is.
import { FiX } from "react-icons/fi";
import { C } from "../../theme/colors";
import { TYPE } from "../../theme/scale";
import { quoteFace, type ComposeQuote } from "./composeQuote";

export const QUOTE_CHIP_TESTID = "concierge-quote-chip";
export const QUOTE_CHIP_REMOVE_TESTID = "concierge-quote-chip-remove";

export function QuoteChip({ quote, onRemove }: { quote: ComposeQuote; onRemove?: () => void }) {
  return (
    <div
      data-testid={QUOTE_CHIP_TESTID}
      // The id the brain resolves against, on the DOM too — it is what the integration test asserts
      // reached the composer, and asserting it here is what makes that test about the invisible ref
      // rather than merely about the words.
      data-quote-source-id={quote.sourceId}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 6,
        marginBottom: 8,
        minWidth: 0,
        borderLeft: `2px solid color-mix(in srgb, ${C.muted} 45%, transparent)`,
        padding: "0 0 0 7px",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: TYPE.small, color: C.conciergeMuted, fontWeight: 600 }}>
          {quote.label}
        </div>
        <div
          // ONE LINE, always. `quoteFace` has already collapsed and capped the string; this is the
          // second half of that promise, for a quote short enough to store but still wider than the
          // column.
          style={{
            fontSize: TYPE.small,
            color: C.conciergeMuted,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          // The face is capped at 120 chars, so the title is the recoverable half of a quote the
          // column was too narrow to show.
          title={quote.text}
        >
          {quoteFace(quote)}
        </div>
      </div>
      {onRemove && (
        <button
          type="button"
          data-testid={QUOTE_CHIP_REMOVE_TESTID}
          onClick={onRemove}
          aria-label="Remove quote"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "0 0 auto",
            background: "transparent",
            border: "none",
            padding: 2,
            cursor: "pointer",
            color: C.conciergeMuted,
          }}
        >
          <FiX size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}
