// THE LINT MARK: a quiet line under a reply saying what the linter caught in it (bead sparkle-kr2jz).
//
// The wording lives in ./lintMarks and is unit-tested as a function — see that module's header for
// why the split exists and why a mark is metadata only. This file is the paint.
//
// ══ WHAT IT IS DELIBERATELY NOT ═════════════════════════════════════════════════════════════════
// It does not block, hide the reply, or rewrite a word of it. `lintReply` computes `blocked` and no
// caller reads it, which means every `severity = "block"` in the shipped config is inert today —
// that is a real gap, and closing it is NOT this component's job. A check that misfires while it can
// suppress a reply makes the concierge unusable, and nothing here has earned that authority yet:
// the numbers that would justify it are exactly what this surface exists to produce. So the mark
// costs a false positive one glance, which is the bead's own constraint, and the severity is carried
// into the DOM (`data-severity`) so a later decision has the fact without a schema change.
//
// ══ WHY IT LOOKS LIKE THE ROUTING RECEIPT ═══════════════════════════════════════════════════════
// Same register, same 12px, same `conciergeMuted`, same flex row: ./RoutingReceipt is the app's one
// existing "annotation about the message above it" affordance, and a second visual language for the
// second one would read as two unrelated systems bolted to the same bubble. The receipt sits under a
// `you` bubble and this sits under a `sparkle` reply, so the two never share a row.
//
// NOT A LIVE REGION, for the reason RoutingReceipt states: the concierge column owns exactly ONE
// `aria-live` node, and a region inserted into the DOM together with its text is generally not
// announced anyway. This is plain visual text.
import { FiAlertCircle } from "react-icons/fi";

import { C } from "../../theme/colors";
import { lintMarkText, type MessageLintMark } from "./lintMarks";

export const LINT_MARK_TESTID = "concierge-lint-mark";

/**
 * Render this reply's findings as one line, or nothing.
 *
 * NULL ON A CLEAN REPLY rather than an empty reserved row — the overwhelmingly common case, and the
 * thread is a flex column where a permanent empty strip per message would space the conversation out
 * for something that is not there (the same call ./MountedNotice makes).
 *
 * `data-count` carries how many checks fired even though the line only words the first, so a test —
 * and anyone reading the DOM — can tell "one finding" from "one finding shown, four more behind it"
 * without parsing the sentence.
 */
export function LintMark({ marks }: { marks?: readonly MessageLintMark[] }) {
  const text = lintMarkText(marks);
  if (!text || !marks?.length) return null;
  return (
    <div
      data-testid={LINT_MARK_TESTID}
      data-count={marks.length}
      data-check={marks[0]!.check}
      data-severity={marks[0]!.severity}
      style={{
        marginTop: 4,
        fontSize: 12,
        color: C.conciergeMuted,
        display: "flex",
        gap: 6,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      {/* An icon rather than a coloured dot: the column flips its whole ink when the cable is
          patched, and a glyph reads at both ends of that where a tint would wash out at one. No
          emoji — the app's icons are react-icons/fi throughout. */}
      <FiAlertCircle size={11} aria-hidden style={{ flexShrink: 0 }} />
      <span>{text}</span>
    </div>
  );
}
