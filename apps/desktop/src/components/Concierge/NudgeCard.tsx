// A cross-project nudge card in the concierge thread: ONE red treatment, ONE line.
//
// ══ THE LINE, AND WHAT IT REPLACED ══════════════════════════════════════════════════════════════
// The founder's spec, verbatim (2026-07-30):
//
//     [red circle] BLOCKED: [@Agent name as clickable pill] in [project-name] [x]
//
// What it replaced said all of that THREE TIMES. Line one was a "Needs you" badge, a project chip
// and the agent name; line two repeated all three as prose ("Needs you — Cockpit Column Resize in
// sparkle-desktop."); line three carried Show me / Mute. Three rows of a narrow column to deliver
// one fact, in a stack whose whole purpose is that N alerts do not become N cards' worth of screen
// (the digest rule, bead sparkle-4562.4) — so the card was undoing in its own body what the digest
// does across the thread.
//
// ONE LINE IS THE TARGET, NOT AN ABSOLUTE — the founder said so, and the layout takes him at his
// word: the row WRAPS (`flexWrap`) rather than truncating, because a pill elided to "Cockpit Col…"
// stops doing the one job a pill has, which is telling you which agent this is. A long agent or
// project name costs a second line; nothing is ever cut.
//
// ══ WHAT HAPPENED TO THE TWO BUTTONS ════════════════════════════════════════════════════════════
//   • "Show me" is GONE. The pill navigates, so a button that also navigates is the same
//     affordance twice — the founder's own reasoning. The whole card stays clickable as well, so
//     the target did not shrink; it grew.
//   • "Mute" is NOT gone. It had exactly one call site in the entire app (`setInterruptPreference`
//     is called from nowhere else), so dropping it would have deleted the do-not-interrupt feature
//     rather than relocating it. It keeps its home on this line as an icon control that is always
//     in the DOM — tab-reachable, screen-reader reachable — and paints only on hover/focus-within,
//     so the RESTING card is exactly the founder's line and nothing was silently removed.
//   • APPROVE SURVIVES as a labelled button when the agent is blocked on an approval prompt. It is
//     a one-tap relay into that agent's terminal, not a navigation, and there is no second place to
//     do it from; collapsing it into [x] would have been the same silent deletion as Mute.
//
// ══ WHAT [x] MEANS ═════════════════════════════════════════════════════════════════════════════
// The app's existing per-EPISODE acknowledgement (`engine/alertDismissal`, the same mechanism the
// Build column's row control uses) — not a mute. It acknowledges this red without resolving it, it
// persists across relaunch, and a genuinely NEW red episode re-raises the card. That is the right
// default for a control the reader will reach for reflexively: the cost of a mis-click is one
// alarm, not a permanently silenced agent. Mute, one glyph to its left, is the durable one.
//
// A div with role="button" (not <button>) because buttons can't nest.
import type { CSSProperties, KeyboardEvent } from "react";
import { FiBellOff, FiX } from "react-icons/fi";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT } from "../../theme/colors";
import { AgentPill } from "./AgentPill";
import type { ConciergeNudge } from "./types";

/** The card's accent — brand sienna, for every nudge.
 *
 *  There used to be two: amber for the "wants you eventually" tier (`blocked`) and sienna for the
 *  asks. That split cost a second alarm color for a distinction nobody acted on differently — a gold
 *  card and a red card both mean "go look at this" — so the tiers merged into one `needs_you` band
 *  and the gold accent went with them. Kept as a function, not inlined at the three use sites, so
 *  the accent still has ONE named source and a test can pin it.
 *
 *  Deliberately takes no band: a card that isn't `needs_you` is never surfaced (see
 *  ConciergeHost.surfacedAgents), so a per-band mapping here would be untestable dead branches
 *  inviting the amber back. */
export function nudgeAccent(): string {
  return C.sienna;
}

/** How a test finds a nudge card. Paired with `data-agent-id` (the nudge's id IS its source agent
 *  id — see ConciergeHost.agentToNudge), so a case can assert WHICH agent a card is about without
 *  matching its prose. That matters more than it looks: the card's sentence is the thing most
 *  likely to be rewritten, and a suite that reads the alert's SUBJECT out of its copy silently
 *  stops testing the subject the moment the copy changes. */
export const NUDGE_CARD_TESTID = "concierge-nudge";

/** The action id the [x] fires. Not one of `nudge.actions` — those are things the AGENT can be told
 *  to do (Approve), while this is the reader acknowledging the ALARM, which every card has whatever
 *  its agent is doing. Exported so the host's handler and this component name it once. */
export const NUDGE_DISMISS_ACTION = "dismiss";

/** The action id the mute control fires — the durable do-not-interrupt rule. Same reasoning as
 *  {@link NUDGE_DISMISS_ACTION}: a property of the alarm, not of the agent's work. */
export const NUDGE_MUTE_ACTION = "mute";

/** The word the line leads with. The founder's, literally, and a CONSTANT rather than
 *  `bandLabel(nudge.band)` — every surfaced card is `needs_you` (that IS the surfacing gate), and
 *  reading a label through a mapping that has exactly one live entry only invites a second alarm
 *  vocabulary back. If a second surfaced band ever exists this is the line that has to change, and
 *  a grep for the constant finds it. */
const LEAD = "BLOCKED:";

/** The red circle. Decorative — the word beside it carries the meaning — so it is `aria-hidden`
 *  and exempt from the text-contrast floor the ink below is held to. */
const dot = (accent: string): CSSProperties => ({
  flex: "0 0 auto",
  width: 8,
  height: 8,
  borderRadius: "50%",
  background: accent,
});

/** The two icon controls. Identical here on purpose — the difference between them is ONE class.
 *
 *  NO `opacity` IN THIS OBJECT. It used to carry `opacity: visible ? 1 : 0`, and that made the quiet
 *  control permanently invisible: an inline style beats any selector, so `.nudge-card:hover
 *  .nudge-card-quiet { opacity: 1 }` could never win and Mute never painted — on hover, on focus, or
 *  at all. The control was in the DOM, tabbable and clickable, and no user could see it, which
 *  defeats the entire reason it was kept. (The `.settings-link-btn` precedent this pattern was copied
 *  from works because it does NOT set the hovered property inline.) Both the resting `opacity: 0` and
 *  the reveal now live in index.css, where they can actually cascade. */
const control: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
  width: 20,
  height: 20,
  padding: 0,
  borderRadius: 4,
  border: "none",
  background: "transparent",
  color: C.conciergeMuted,
  cursor: "pointer",
};

export function NudgeCard({
  nudge,
  onNudgeClick,
  onNudgeAction,
}: {
  nudge: ConciergeNudge;
  onNudgeClick: (nudge: ConciergeNudge) => void;
  onNudgeAction: (nudge: ConciergeNudge, actionId: string) => void;
}) {
  const accent = nudgeAccent();
  const label = `${LEAD} ${nudge.agentName} in ${nudge.projectName}`;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // ONLY THE CARD ITSELF. Without this guard a keydown on a nested control bubbles up here, and
    // `preventDefault()` below cancels the very thing it was: for a <button>, Enter/Space activation
    // IS the keydown default action. So a keyboard user who tabbed to Mute, [x] or Approve and
    // pressed Enter got NAVIGATED to the agent instead — the card's own gesture, silently replacing
    // theirs. Worst on the two icon controls, which the `:focus-within` reveal lights up for
    // precisely that user, and on Approve, whose one-tap relay has no other entry point.
    //
    // `stopPropagation` on each control would work too, and is what the CLICK handlers do; the guard
    // is here instead because it is one rule for every control the card will ever grow, and because
    // the failure it prevents is silent in both directions — nothing throws, the wrong thing simply
    // happens.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onNudgeClick(nudge);
    }
  };
  /** Fire an action without ALSO counting as a card click. */
  const act = (actionId: string) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    onNudgeAction(nudge, actionId);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid={NUDGE_CARD_TESTID}
      data-agent-id={nudge.id}
      data-band={nudge.band}
      aria-label={label}
      onClick={() => onNudgeClick(nudge)}
      onKeyDown={onKeyDown}
      style={{
        alignSelf: "stretch",
        maxWidth: "100%",
        // THE RED BOX TREATMENT IS UNCHANGED — the founder asked for the line, not for a different
        // card. Same gradient, same uniform border, same glow.
        background: `linear-gradient(180deg, color-mix(in srgb, ${accent} 9%, transparent), color-mix(in srgb, ${accent} 3%, transparent))`,
        // Priority color reads from the dot, the tint, and the border — but NOT as a left-edge
        // stripe (founder, 2026-07-24: keeps the orange/red, doesn't want the left-side shading).
        // Deliberately a uniform 1px border so the card sits symmetrically once the bar is gone.
        border: `1px solid color-mix(in srgb, ${accent} 40%, transparent)`,
        borderRadius: 6,
        // Tighter than the three-row card's `12px 13px`: a single row does not need the vertical
        // air three did, and the padding was a third of the old card's height.
        padding: "8px 11px",
        boxShadow: `0 0 26px color-mix(in srgb, ${accent} 10%, transparent)`,
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        // WRAP, NEVER TRUNCATE. See the header: a clipped pill stops identifying the agent, which
        // is the only thing this card exists to say.
        flexWrap: "wrap",
        gap: 6,
        fontSize: 13,
      }}
      // `:hover` and `:focus-within` cannot be expressed inline, so the quiet control's reveal is a
      // CSS rule keyed on this class. Hover alone would leave it keyboard-invisible, which is the
      // whole reason the control is rendered rather than conditionally mounted.
      className="nudge-card"
    >
      <span style={dot(accent)} aria-hidden />
      {/* THE THEMED ink, not the literal accent: raw sienna is under the AA floor as TEXT on the
          concierge column. Same split, and same reason, as the badge this replaced. */}
      <strong style={{ color: C.dangerInk, fontWeight: FONT_WEIGHT.bold, letterSpacing: "0.02em" }}>
        {LEAD}
      </strong>
      {/* THE REAL PILL — live status dot, live name (so a rename repaints in place), and a click
          that opens the agent. `onOpen` routes through the card's own reveal rather than the
          context's plain `openProjectTab`, because this card now usually names a WORKER and a
          worker's row has to be un-hidden and expanded before it can be seen. See AgentPill.onOpen.
          It returns nothing: `onNudgeClick` → `revealAgent` reports its own outcome, and the pill's
          "…is closed" retry state belongs to the weaker path (see AgentPill.onOpen). */}
      {/* WRAPPED so the pill's click does not ALSO bubble into the card's, exactly as the action
          buttons are. Without it one click on the pill ran the reveal TWICE — re-selecting the
          project tab and tearing down the Sparkle overlay a second time, which is the same
          double-navigation hazard AgentPill's own handler is written to avoid. A span with an
          onClick and no role: it is not a control, it is a fence around one. */}
      <span
        style={{ display: "inline-flex", minWidth: 0 }}
        onClick={(e) => e.stopPropagation()}
        role="presentation"
      >
        <AgentPill
          agentId={nudge.id}
          fallbackName={nudge.agentName}
          onOpen={() => onNudgeClick(nudge)}
        />
      </span>
      {/* Plain words, not the gold chip the old line one carried. The chip was a second bordered
          object sitting immediately beside a bordered pill, which is exactly the visual stutter the
          one-line rewrite is for; the project reads fine as the tail of a sentence. */}
      <span style={{ color: C.conciergeMuted }}>in {nudge.projectName}</span>
      {/* Everything the agent can be TOLD to do, inline. Today that is Approve and only Approve —
          Show me and Mute left `actionsFor` when this card became a line. */}
      {nudge.actions.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={act(a.id)}
          style={{
            fontSize: 12,
            fontWeight: FONT_WEIGHT.bold,
            borderRadius: 999,
            padding: "3px 10px",
            cursor: "pointer",
            flex: "0 0 auto",
            ...(a.kind === "primary"
              ? {
                  // THE BLUEPRINT'S PRIMARY ACTION IS A SOLID FILL, NOT A TINT. This was a 16%
                  // BRAND-GOLD wash under a `goldHotInk` label, which survived the repaint only as a
                  // mismatch: the repaint moved every gold token to the Blueprint's primary BLUE, so
                  // the label went blue while the plate it sits on stayed gold. Blue ink on a gold
                  // wash measured 4.48 in dark — under the AA floor, and unreachable by nudging the
                  // percentage, because the two colours no longer belong to the same family. The
                  // spec's primary button is `--k-primary` with `--k-on-primary`; that pair is opaque
                  // and clears AA by a wide margin in both themes.
                  color: C.onGoldFill,
                  background: C.goldFill,
                  border: `1px solid ${C.goldFill}`,
                }
              : {
                  color: C.cream,
                  background: CHAT_USER_BUBBLE,
                  border: `1px solid color-mix(in srgb, ${C.muted} 30%, transparent)`,
                }),
          }}
        >
          {a.label}
        </button>
      ))}
      {/* PUSHED TO THE END of whatever row they land on, so [x] is where the founder's spec puts it
          however the line wraps. */}
      <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 2 }}>
        <button
          type="button"
          data-testid="concierge-nudge-mute"
          className="nudge-card-quiet"
          aria-label={`Mute alerts about ${nudge.agentName}`}
          title={`Mute alerts about ${nudge.agentName}`}
          onClick={act(NUDGE_MUTE_ACTION)}
          style={control}
        >
          <FiBellOff size={13} aria-hidden />
        </button>
        <button
          type="button"
          data-testid="concierge-nudge-dismiss"
          aria-label={`Dismiss this alert about ${nudge.agentName}`}
          title="Dismiss this alert"
          onClick={act(NUDGE_DISMISS_ACTION)}
          style={control}
        >
          <FiX size={14} aria-hidden />
        </button>
      </span>
    </div>
  );
}
