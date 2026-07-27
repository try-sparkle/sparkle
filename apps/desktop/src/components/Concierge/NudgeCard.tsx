// A cross-project nudge card in the concierge thread: ONE red treatment, with a band badge +
// project chip naming where it came from. The WHOLE card is a click target ("take me to the
// source"); its action buttons stopPropagation so an action never doubles as a card click. A div
// with role="button" (not <button>) because buttons can't nest.
import type { CSSProperties, KeyboardEvent } from "react";
import { bandLabel } from "../../engine/statusBandLabels";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT } from "../../theme/colors";
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

const badgeStyle = (accent: string): CSSProperties => ({
  fontSize: 9.5,
  fontWeight: FONT_WEIGHT.bold,
  letterSpacing: "0.04em",
  padding: "2px 6px",
  borderRadius: 5,
  color: accent,
  background: `color-mix(in srgb, ${accent} 16%, transparent)`,
  border: `1px solid color-mix(in srgb, ${accent} 60%, transparent)`,
});

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
  const label = bandLabel(nudge.band);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onNudgeClick(nudge);
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      data-band={nudge.band}
      aria-label={`${label} — ${nudge.agentName} (${nudge.projectName})`}
      onClick={() => onNudgeClick(nudge)}
      onKeyDown={onKeyDown}
      style={{
        alignSelf: "stretch",
        maxWidth: "100%",
        background: `linear-gradient(180deg, color-mix(in srgb, ${accent} 9%, transparent), color-mix(in srgb, ${accent} 3%, transparent))`,
        // Priority color reads from the badge, the tint, and the border — but NOT as a left-edge
        // stripe (founder, 2026-07-24: keeps the orange/red, doesn't want the left-side shading).
        // Deliberately a uniform 1px border so the card sits symmetrically once the bar is gone.
        border: `1px solid color-mix(in srgb, ${accent} 40%, transparent)`,
        borderRadius: 12,
        padding: "12px 13px",
        boxShadow: `0 0 26px color-mix(in srgb, ${accent} 10%, transparent)`,
        cursor: "pointer",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          color: C.conciergeMuted,
          marginBottom: 6,
        }}
      >
        <span style={badgeStyle(accent)}>{label}</span>
        <span
          style={{
            fontSize: 9.5,
            color: C.amber,
            border: `1px solid color-mix(in srgb, ${C.amber} 40%, transparent)`,
            borderRadius: 5,
            padding: "1px 5px",
          }}
        >
          {nudge.projectName}
        </span>
        {nudge.agentName}
      </div>
      <div style={{ fontSize: 13.5, color: C.cream }}>{nudge.text}</div>
      {nudge.actions.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          {nudge.actions.map((act) => (
            <button
              key={act.id}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onNudgeAction(nudge, act.id);
              }}
              style={{
                fontSize: 11,
                fontWeight: FONT_WEIGHT.bold,
                borderRadius: 999,
                padding: "6px 11px",
                cursor: "pointer",
                ...(act.kind === "primary"
                  ? {
                      color: C.cream,
                      background: `color-mix(in srgb, ${C.amber} 16%, transparent)`,
                      border: `1px solid color-mix(in srgb, ${C.amber} 50%, transparent)`,
                    }
                  : act.kind === "ghost"
                    ? {
                        color: C.conciergeMuted,
                        background: "transparent",
                        border: `1px solid color-mix(in srgb, ${C.muted} 30%, transparent)`,
                      }
                    : {
                        color: C.cream,
                        background: CHAT_USER_BUBBLE,
                        border: `1px solid color-mix(in srgb, ${C.muted} 30%, transparent)`,
                      }),
              }}
            >
              {act.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
