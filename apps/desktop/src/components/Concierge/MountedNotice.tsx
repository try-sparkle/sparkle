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

// Shared layout for BOTH tones: the row's flow, spacing, and type size. Neither the box nor the
// colour lives here, because the two tones no longer share them (see below).
const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  margin: "0 0 6px",
  // `TYPE.small` is a NUMBER (the scale's px value), not a style object — theme/scale's ratchet holds
  // the off-scale `fontSize` count at zero, so this must read from the scale rather than say 12.
  fontSize: TYPE.small,
};

// The INFO box only. An outcome that merely happened elsewhere keeps the drawn-not-filled frame —
// the same treatment the unmount hint beside this row uses; a filled banner would read as a modal
// interruption over a column that has just flooded to the terminal plane.
//
// A REFUSAL is deliberately NOT boxed. The founder asked for the error variant to read as inline red
// text, not as a bordered container wider than the composer: nothing was sent, and a frame around
// that sentence made it look like a filled modal over the very box the words just reappeared in. So
// the box (padding + radius + border) is reserved for `info`, and `warn` inherits only the shared
// layout above.
const infoBoxStyle: CSSProperties = {
  padding: "5px 8px",
  borderRadius: 4,
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
  const isWarn = notice.tone === "warn";
  return (
    <div
      key={notice.seq}
      data-testid={MOUNTED_NOTICE_TESTID}
      role="status"
      style={{
        ...rowStyle,
        // Only the INFO tone is boxed (see `infoBoxStyle`); a refusal is bare inline text.
        ...(isWarn ? null : infoBoxStyle),
        // A refusal reads in ALARM RED — `dangerInk`, the themed alarm-red-as-text token that
        // clears AA on every plane in both themes (see theme/colors) — because it is the one the
        // founder must not miss and must read as an error at a glance. An outcome that merely
        // happened elsewhere sits in the muted register the unmount hint beside it uses.
        color: isWarn ? C.dangerInk : C.conciergeMuted,
      }}
    >
      {/* The terminal register's prompt mark, on the INFO tone only. A refusal is stripped of chrome
          — no `>_`, no frame — so it reads as a plain red sentence rather than terminal output. */}
      {!isWarn && (
        <span aria-hidden style={{ opacity: 0.6 }}>
          {">_"}
        </span>
      )}
      <span>{notice.text}</span>
    </div>
  );
}
