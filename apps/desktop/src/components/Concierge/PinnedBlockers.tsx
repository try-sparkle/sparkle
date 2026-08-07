// LIVE BLOCKERS ARE PINNED ABOVE THE COMPOSER. They are not chat messages and they do not scroll.
//
// ══ THE REPORT ═══════════════════════════════════════════════════════════════════════════════════
// Founder, 2026-08-07, verbatim: *"I want any sort of blocked notices to be right above the compose
// window. And not in line in the chat thread. So they should not flow upwards with the chat thread.
// If there is any real block notices, they should stay persistently above the composed window so
// that I see them regardless of how much the chat thread moves."*
//
// ══ WHY A CHAT MESSAGE WAS THE WRONG SHAPE ═══════════════════════════════════════════════════════
// A chat message is IMMUTABLE HISTORY AT A FIXED POSITION. A blocker is neither: it is live, and it
// stays relevant until it is resolved. Rendering it inline gave it both wrong properties at once —
// it went stale AND it scrolled out of sight. `engine/resolvedNudges` fixed the staleness half (bead
// `sparkle-9adzg`); this is the visibility half, and they are the same root error.
//
// So the split is now by KIND OF FACT, not by kind of item:
//   • a LIVE blocker  → pinned here, above the composer, never scrolls          (this file)
//   • a RESOLVED one  → a grey receipt in the transcript, where history belongs (NudgeCard)
//
// ══ WHAT MAY NOT REGRESS ═════════════════════════════════════════════════════════════════════════
// Sparkle's standing rule is that nothing which needs the founder may be hidden, and MOVING alerts
// is the gesture most likely to break it by accident. Two consequences are load-bearing here:
//
//   • THE STACK NEVER SWALLOWS THE COMPOSER. Several blockers at once is the normal case on a busy
//     fleet — the card wall that created `conciergeDigest` was twenty-seven of them. The zone is
//     height-capped and scrolls INSIDE itself, so the composer keeps its position no matter how many
//     are live. A pinned region that grew without bound would take the input surface off screen,
//     which is a worse failure than the one this fixes.
//   • [x] ACKNOWLEDGES **AND** LEAVES A CHIP. The founder's own answer: a dismissed-but-still-live
//     blocker "collapses to a quiet chip, never vanishes". Both halves are load-bearing and they
//     used to be in tension. `[x]` is still the app's per-episode acknowledgement — the same
//     transitive `dismissAlert` the inline card wrote, which is what calms the Build row and stops
//     the whack-a-mole where each dismissed rollup re-raised as its descendants (roborev
//     55986/56000). But acknowledging de-escalates the published band, so the agent falls out of
//     the live set and the row would simply VANISH from the one surface built so it cannot. The
//     chip is what closes that: the host keeps a snapshot of what was acknowledged and renders it
//     quietly here until the agent leaves the fleet or goes red again.
import type { CSSProperties } from "react";
import { FiBellOff, FiX } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../../theme/colors";
import { RADIUS, TYPE } from "../../theme/scale";
import { AgentPill } from "./AgentPill";
import { NUDGE_DISMISS_ACTION, NUDGE_MUTE_ACTION } from "./NudgeCard";
import type { ConciergeNudge } from "./types";

/** How a test finds the pinned zone. */
export const PINNED_BLOCKERS_TESTID = "concierge-pinned-blockers";
/** One entry, expanded — the full "BLOCKED: @agent in project" line. */
export const PINNED_BLOCKER_TESTID = "concierge-pinned-blocker";
/** One entry, ACKNOWLEDGED — the quiet chip a [x] leaves behind. Still names its agent. */
export const PINNED_BLOCKER_CHIP_TESTID = "concierge-pinned-blocker-chip";
/** Clear an acknowledged chip off the strip. The LAST removal gesture, and the only one that takes
 *  a blocker off this surface on purpose — see the header for why [x] is not it. */
export const PINNED_CLEAR_ACTION = "pinned-clear";

/** The lead word, identical to the inline card's so the two read as one vocabulary. */
const LEAD = "BLOCKED:";

/** Roughly three expanded rows. Past that the zone scrolls rather than grows — see the header: the
 *  composer's position is not negotiable, and a busy fleet can produce a dozen of these at once. */
const MAX_ZONE_HEIGHT = 132;

const row = (): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
  padding: "5px 9px",
  borderRadius: RADIUS.sm,
  border: `1px solid ${C.sienna}`,
  // NO GLOW, unlike the inline card. The card needed one to stand out from a scrolling transcript;
  // a pinned row is already the only thing that never moves, and a glow on a permanently-visible
  // strip reads as alarm fatigue rather than as urgency.
  background: "transparent",
  cursor: "pointer",
});

const chip = (): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  minWidth: 0,
  maxWidth: "100%",
  padding: "2px 7px",
  borderRadius: RADIUS.sm,
  // MUTED, not sienna: the reader has said "I have seen this one". It stays legible and it stays
  // present — it just stops competing with the blockers they have not looked at yet.
  border: `1px solid ${C.muted}`,
  background: "transparent",
  cursor: "pointer",
  fontSize: TYPE.small,
  color: C.conciergeMuted,
});

const iconButton = (): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
  width: 18,
  height: 18,
  padding: 0,
  border: "none",
  background: "transparent",
  color: C.conciergeMuted,
  cursor: "pointer",
});

/**
 * The pinned zone. Renders nothing at all when there is nothing live — an empty bordered strip
 * above the composer would be permanent furniture claiming the fleet is fine, which is a statement,
 * not a container.
 *
 * `acknowledged` is what `[x]` left behind — snapshots, not live feed items, because an acknowledged
 * agent has been de-escalated out of the live set and so is no longer derivable from the feed at
 * all. The host holds them for the same reason it holds the resolved ledger: the moment a card stops
 * being derivable, a card nobody remembered is a card that is gone.
 */
export function PinnedBlockers({
  blockers,
  acknowledged,
  onNudgeClick,
  onNudgeAction,
}: {
  blockers: ConciergeNudge[];
  acknowledged: readonly ConciergeNudge[];
  onNudgeClick: (nudge: ConciergeNudge) => void;
  onNudgeAction: (nudge: ConciergeNudge, actionId: string) => void;
}) {
  // A LIVE ENTRY WINS over its own acknowledged snapshot. An agent that went red again is loud
  // again — rendering both would state the opposite fact about one agent twice, and would duplicate
  // its React key.
  const live = new Set(blockers.map((b) => b.id));
  const shut = acknowledged.filter((a) => !live.has(a.id));
  const open = blockers;
  if (open.length === 0 && shut.length === 0) return null;

  return (
    <div
      data-testid={PINNED_BLOCKERS_TESTID}
      // A LANDMARK, not a log. `role="region"` with a name is what lets a screen-reader user jump to
      // it deliberately; `aria-live` would be wrong — this content persists rather than arriving,
      // and the column already has exactly one live region (see ConciergeColumn's announcer).
      role="region"
      aria-label={`${open.length} blocked`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "0 12px 6px",
        // THE CAP AND THE SCROLL ARE ONE MECHANISM — see the header. `maxHeight` alone would clip
        // the overflow silently, which hides a blocker rather than moving it.
        maxHeight: MAX_ZONE_HEIGHT,
        overflowY: "auto",
        flex: "0 0 auto",
      }}
    >
      {open.map((b) => (
        <div
          key={b.id}
          data-testid={PINNED_BLOCKER_TESTID}
          data-agent-id={b.id}
          role="button"
          tabIndex={0}
          aria-label={`${LEAD} ${b.agentName} in ${b.projectName}`}
          onClick={() => onNudgeClick(b)}
          onKeyDown={(e) => {
            // ONLY THE ROW ITSELF, matching NudgeCard: a keydown on the nested fold button bubbles
            // here, and preventDefault would cancel the button's own Enter/Space activation.
            if (e.target !== e.currentTarget) return;
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onNudgeClick(b);
          }}
          style={row()}
        >
          <span
            style={{ flex: "0 0 auto", width: 7, height: 7, borderRadius: "50%", background: C.sienna }}
            aria-hidden
          />
          {/* THE THEMED ink, not raw sienna: the accent is under the AA floor as TEXT on this
              column. Same split, and same reason, as the inline card's. */}
          <strong
            style={{ color: C.dangerInk, fontWeight: FONT_WEIGHT.bold, letterSpacing: "0.02em" }}
          >
            {LEAD}
          </strong>
          {/* A FENCE around the pill's own click, exactly as the inline card does it — without it
              one click runs the reveal twice. */}
          <span
            style={{ display: "inline-flex", minWidth: 0 }}
            onClick={(e) => e.stopPropagation()}
            role="presentation"
          >
            <AgentPill agentId={b.id} fallbackName={b.agentName} onOpen={() => onNudgeClick(b)} />
          </span>
          <span
            style={{
              color: C.conciergeMuted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            in {b.projectName}
          </span>
          {/* EVERY AFFORDANCE THE INLINE CARD CARRIED COMES WITH IT. Moving a surface must not
              quietly drop what could be done from it: Approve is a one-tap relay into a live
              terminal with no other home in the app, and Open is the cloud agent's substitute for
              it (`services/nudgeActions` picks which). A blocker you can see but no longer act on
              is a worse surface than the scrolling one it replaced. */}
          {b.actions.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onNudgeAction(b, a.id);
              }}
              style={{
                flex: "0 0 auto",
                padding: "2px 8px",
                borderRadius: RADIUS.sm,
                border: `1px solid ${C.sienna}`,
                background: "transparent",
                color: C.dangerInk,
                fontSize: TYPE.small,
                fontWeight: FONT_WEIGHT.bold,
                cursor: "pointer",
              }}
            >
              {a.label}
            </button>
          ))}
          {/* MUTE, on the same handle as before. A durable preference about the AGENT rather than
              about this episode, and this strip is now its only call site — dropping it here would
              delete do-not-interrupt from the app. */}
          <button
            type="button"
            data-testid="concierge-nudge-mute"
            aria-label={`Mute alerts about ${b.agentName}`}
            title="Don't interrupt me about this agent"
            onClick={(e) => {
              e.stopPropagation();
              onNudgeAction(b, NUDGE_MUTE_ACTION);
            }}
            style={{ ...iconButton(), marginLeft: "auto" }}
          >
            <FiBellOff size={12} />
          </button>
          {/* THE SAME TESTID THE INLINE CARD USED, because it is the SAME GESTURE — the app's
              per-episode acknowledgement, writing the same transitive `dismissAlert`. Keeping the
              handle stable is what lets the cases that pin the rollup/subtree dismissal keep
              working across the move; a new id would have quietly orphaned them. */}
          <button
            type="button"
            data-testid="concierge-nudge-dismiss"
            aria-label={`Dismiss this alert about ${b.agentName}`}
            title="Acknowledge — it stays here as a chip"
            onClick={(e) => {
              e.stopPropagation();
              onNudgeAction(b, NUDGE_DISMISS_ACTION);
            }}
            style={{ ...iconButton() }}
          >
            <FiX size={12} />
          </button>
        </div>
      ))}
      {shut.length > 0 && (
        // The acknowledged ones share ONE wrapping row: a dozen of them should cost a line or two,
        // not a dozen. They stay in DOM order beneath the loud ones, so what the reader has NOT
        // looked at is always nearest the composer.
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {shut.map((b) => (
            <span
              key={b.id}
              data-testid={PINNED_BLOCKER_CHIP_TESTID}
              data-agent-id={b.id}
              // STILL SAYS BLOCKED. The chip is quieter, not vaguer — a reader scanning the strip
              // must be able to tell an acknowledged blocker from any other chip without opening it.
              aria-label={`${LEAD} ${b.agentName} in ${b.projectName} (acknowledged)`}
              style={chip()}
            >
              <span
                style={{
                  flex: "0 0 auto",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  // HOLLOW, like the resolved card's dot — the redundant signal for a reader who
                  // cannot separate two greys, or who has the two states in different themes.
                  boxSizing: "border-box",
                  background: "transparent",
                  borderStyle: "solid",
                  borderWidth: 1,
                  borderColor: C.muted,
                }}
                aria-hidden
              />
              {/* THE NAME STILL OPENS THE AGENT. Acknowledging says "I have seen this", not "I have
                  dealt with it" — the way to deal with it is to go there, and that has to stay one
                  click away or the chip is a dead end. */}
              <button
                type="button"
                onClick={() => onNudgeClick(b)}
                title={`Open ${b.agentName}`}
                style={{
                  border: "none",
                  background: "transparent",
                  padding: 0,
                  font: "inherit",
                  color: "inherit",
                  cursor: "pointer",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {b.agentName}
              </button>
              <button
                type="button"
                data-testid="concierge-pinned-clear"
                aria-label={`Clear ${b.agentName}`}
                title="Clear from this strip"
                onClick={() => onNudgeAction(b, PINNED_CLEAR_ACTION)}
                style={{ ...iconButton(), width: 14, height: 14 }}
              >
                <FiX size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
