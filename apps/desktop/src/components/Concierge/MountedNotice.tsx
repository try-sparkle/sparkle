// A ONE-LINE OUTCOME THAT SURVIVES THE MOUNT SWAP.
//
// ══ THE HOLE THIS FILLS (roborev 57360, High) ═══════════════════════════════════════════════════
// While the concierge is mounted, `ConciergeColumn` renders `MountedAgentThread` and does NOT render
// `ConciergeThread` at all. So every explanation the send path produces with `postSparkle` — which is
// all of them — is written into a component that is not on screen, in exactly the state the
// mounted-composer feature exists for. Three things went invisible at once:
//
//   • a terminal REFUSAL ("that agent has a full-screen app open"). The founder types, the send is
//     declined before it arms, the words reappear in the box, and nothing says why. A refusal the
//     user cannot see is indistinguishable from the feature being broken — the exact dead-affordance
//     failure the receipt rules in ConciergeHost are written against.
//   • "isn't open any more" / "can't take a message right now".
//   • the `@Sparkle` ESCAPE HATCH's own answer, which is the worst of the three: the documented way
//     out of a mount produced no visible reply.
//
// ══ WHY A SIBLING ROW AND NOT A THREAD ENTRY ════════════════════════════════════════════════════
// `MountedAgentThread` renders a projection of DISK (services/agentTranscript) and says so in its
// header — injecting app-authored lines into it would put the founder's Sparkle history and a
// transcript read back on one code path, which is precisely the coupling that component exists to
// avoid. This renders in the column's own layout, outside the swap, beside `CountdownBanner` and the
// unmount hint — the two other things that are already true of a mounted column.
//
// It is deliberately ONE LINE. The design doc's receipt row (`>_ Sent to [@Agent]  ⌘⇧U to unmount`)
// is the surface this is a down payment on; a full transcript of concierge prose does not belong in a
// banner, so an @Sparkle ANSWER is announced here and read by unmounting, while a REFUSAL — short,
// actionable, and the safety-critical one — is stated in full.
import type { CSSProperties } from "react";

import { C } from "../../theme/colors";
import { TYPE } from "../../theme/scale";

export const MOUNTED_NOTICE_TESTID = "mounted-notice";

/** What happened, in the one register a mounted column can show it in. */
export interface MountedNoticeModel {
  /** The sentence. Already user-facing copy — this component never composes prose of its own. */
  text: string;
  /** `warn` for a refusal (nothing was sent, and the words are back in the box); `info` for an
   *  outcome that merely happened elsewhere. Drives the accent only — the words carry the meaning,
   *  because a colour alone is not a message. */
  tone: "warn" | "info";
  /** Bumped on every write, so an IDENTICAL repeat is still a distinct notice.
   *
   *  Same reason `ConciergeAnnouncement` carries one (roborev 53392): refusing twice for the same
   *  reason is the COMMON case here — the founder retypes and hits the same `vim` — and a component
   *  keyed on text alone would render the second refusal as no change at all. */
  seq: number;
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  padding: "5px 8px",
  margin: "0 0 6px",
  borderRadius: 4,
  // `TYPE.small` is a NUMBER (the scale's px value), not a style object — theme/scale's ratchet holds
  // the off-scale `fontSize` count at zero, so this must read from the scale rather than say 12.
  fontSize: TYPE.small,
  // Structure is DRAWN, not filled — the direction's rule, and the same treatment the unmount hint
  // beside this row uses. A filled banner here would read as a modal interruption over a column that
  // has just flooded to the terminal plane.
  border: `1px solid color-mix(in srgb, currentColor 30%, transparent)`,
  background: "transparent",
};

/**
 * Render the latest mounted-path outcome, or nothing.
 *
 * NULL WHEN THERE IS NOTHING TO SAY, rather than an empty reserved row: the column's compose box
 * auto-grows against the space above it, and a permanent empty strip would take that space from the
 * thread for a message that is not there.
 *
 * `role="status"` — not `aria-hidden` decoration and not `alert`. The refusal is information the
 * founder needs and did not ask for at this instant, which is exactly what `status` is for; `alert`
 * interrupts, and a declined message is not an emergency.
 */
export function MountedNotice({ notice }: { notice: MountedNoticeModel | null }) {
  if (!notice) return null;
  return (
    <div
      key={notice.seq}
      data-testid={MOUNTED_NOTICE_TESTID}
      role="status"
      style={{
        ...rowStyle,
        // A refusal reads at the column's OWN ink because it is the one the founder must not miss;
        // an outcome that merely happened elsewhere sits in the muted register the unmount hint
        // beside it uses. `inherit` rather than a named token: the column flips its ink wholesale
        // when the cable is patched (it takes the terminal's material), and a concrete colour here
        // would be the one line that did not follow it.
        color: notice.tone === "warn" ? "inherit" : C.conciergeMuted,
      }}
    >
      {/* The terminal register's prompt mark, matching the activity line directly below this row —
          it says "this is about the terminal you are patched into" without a word of chrome. */}
      <span aria-hidden style={{ opacity: 0.6 }}>{">_"}</span>
      <span>{notice.text}</span>
    </div>
  );
}
