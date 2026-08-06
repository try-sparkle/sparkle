// A folded run of concierge receipts: one line, an honest count, the agent pills, and every original
// row one click away.
//
// Follows `ActivityChip`'s idiom deliberately rather than inventing a second disclosure convention —
// same chevron, same "compressed, not deleted" contract, same muted weight so a fold reads as a beat
// in the conversation rather than a card competing with the prose either side of it. The rule about
// WHICH receipts may fold lives in ./receiptRuns; this component only draws what that decided.
//
// ══ THE CHEVRON IS ITS OWN CONTROL, AND THAT IS STRUCTURAL ══════════════════════════════════════
// `ActivityChip` makes the whole summary one big `<button>`. This one cannot: the summary CONTAINS
// the agent pills, and those pills are how the founder navigates to an agent — the entire reason the
// brief says not to flatten them into plain text. A pill inside the toggle would have its click
// eaten by the disclosure (or, worse, do both), so the disclosure is a small button beside the
// sentence and the sentence is ordinary markdown. Nothing about the pills changes: they are the same
// `[@Name](sparkle-agent:<id>)` references `<Markdown>` already turns into `<AgentPill>`, so they
// resolve, they open, and they carry the live name — exactly as they did unfolded.
import { useState } from "react";
import { FiChevronDown, FiChevronRight } from "react-icons/fi";

import { Markdown } from "../Markdown";
import { C } from "../../theme/colors";
import { TYPE } from "../../theme/scale";
import { receiptRunLine, type ReceiptRun } from "./receiptRuns";

export const RECEIPT_RUN_TESTID = "concierge-receipt-run";
export const RECEIPT_RUN_MEMBERS_TESTID = "concierge-receipt-run-members";
export const RECEIPT_RUN_TOGGLE_TESTID = "concierge-receipt-run-toggle";

export function ReceiptRunRow({
  run,
  children,
}: {
  run: ReceiptRun;
  /** The member rows, rendered by the thread so this component never has to know how a message is
   *  drawn. Shown only when expanded — but always PASSED, because folding is a display decision and
   *  the messages themselves are untouched. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const summary = receiptRunLine(run);

  return (
    <div
      data-testid={RECEIPT_RUN_TESTID}
      // The count, on the element, so a test can assert what the row CLAIMS without parsing the
      // sentence — and so the two can be pinned equal to the members actually rendered.
      data-count={run.members.length}
      data-run-key={run.key}
      data-open={open ? "yes" : "no"}
      style={{ maxWidth: "92%", alignSelf: "flex-start", minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <button
          type="button"
          data-testid={RECEIPT_RUN_TOGGLE_TESTID}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          // Named for what opening REVEALS, not for the glyph. A screen-reader user gets "Show the
          // 16 individual receipts" rather than "chevron".
          aria-label={
            open
              ? `Hide the ${run.members.length} individual receipts`
              : `Show the ${run.members.length} individual receipts`
          }
          style={{
            display: "flex",
            alignItems: "center",
            background: "none",
            border: "none",
            padding: 0,
            marginTop: 3,
            cursor: "pointer",
            color: C.conciergeMuted,
            flexShrink: 0,
          }}
        >
          {open ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
        </button>
        {/* The sentence and its pills. `<Markdown>` is what turns the references into `<AgentPill>`,
            so this is the same rendering path the individual rows use — a fold cannot quietly
            downgrade a pill to text. */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Markdown text={summary.md} mergeQuotes />
        </div>
      </div>
      {/* NO COPY GLYPH ON THE FOLD. `ConciergeMessageRow`'s sparkle arm reserves that affordance for
          PROSE — answers and pushes — and explicitly not for the app's own cards about state; the
          negative assertions in ConciergeThread.copy.test are what keep it from spreading. A folded
          run is that kind of card. The individual receipts keep theirs, one click away. */}
      {open && (
        <div
          data-testid={RECEIPT_RUN_MEMBERS_TESTID}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "8px 0 2px 18px",
            fontSize: TYPE.small,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
