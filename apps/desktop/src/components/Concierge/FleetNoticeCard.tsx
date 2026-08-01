// THE FLEET NOTICE CARD — what the founder was finding by screenshot, on screen instead.
//
// ══ WHAT THIS IS FOR ═══════════════════════════════════════════════════════════════════════════
// Every condition it renders was already DETECTED somewhere: `agentStall` returns the quota verdict
// with the verbatim banner, `goalStateOf` returns `escalated`, `statusEngine` retains the failure
// banner, `improvementPass` knows its own clock. None of it was AGGREGATED, so answering "which
// agents are stuck" meant a human reading rows one at a time — three times in one day, by the
// founder, before this existed.
//
// ══ NOT AN ALARM — DELIBERATELY THE SAME CYAN AS RecapCard ═════════════════════════════════════
// The obvious choice is the nudge sienna, because "5 agents are quota-blocked" sounds like an
// alarm. It is the wrong one, for the reason RecapCard already settled: the alarm colour belongs to
// the per-agent cards that carry an ACTION (Approve, the pill that navigates). This card carries a
// summary — often about agents nobody can do anything for until a clock rolls over — and painting
// it red would make it compete with the cards that need a hand right now. It is a briefing that may
// contain alarms, not an alarm.
//
// ══ NON-INTERACTIVE, FOR THE SAME REASON RecapCard IS ══════════════════════════════════════════
// Anything actionable here already has a live surface: an agent that needs you is a nudge card with
// its own buttons, one scroll away. Duplicating those controls would give the same agent two action
// surfaces, which is how a user approves the same thing twice. This card says what is true; the
// nudge cards act.
//
// ══ NO LIVE REGION ═════════════════════════════════════════════════════════════════════════════
// The concierge column has ONE `role="status"` node fed by the host. A second would double-announce
// — learned and fixed once already during the auto-routing work.
//
// ══ THE TEXT IS NOT REWRITTEN HERE ═════════════════════════════════════════════════════════════
// `pusherFleet` composes each sentence from measured values and verbatim quotes, and `pusherGate`'s
// citation rule is what makes those sentences trustworthy. This component SPLITS the text into rows
// for layout and changes not one character otherwise. Re-phrasing anything here would put prose
// outside the rule that the rest of the feature is built on.
import type { CSSProperties } from "react";
import { FiActivity } from "react-icons/fi";
import type { FleetCondition } from "@sparkle/core";
import { C, CARD_WASH_PCT, FONT_WEIGHT } from "../../theme/colors";

/** Brand cyan, matching RecapCard — see the header for why this is not the nudge sienna. */
const accent = C.accentInk;

const headingStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  color: C.cream,
};

const leadStyle: CSSProperties = {
  fontSize: 12,
  color: C.cream,
  marginTop: 6,
  // The conditions quote agent-produced text (a limit banner, an error), which has no spaces to
  // break on. Without this a long banner pushes the column's own width out.
  overflowWrap: "anywhere",
};

const bulletStyle: CSSProperties = {
  ...leadStyle,
  marginTop: 2,
  paddingLeft: 10,
  color: C.conciergeMuted,
};

/**
 * One condition's text, split for layout only.
 *
 * `pusherFleet` writes a lead sentence and then `  - ` rows. Splitting on that prefix is a rendering
 * concern; the STRINGS are reproduced exactly, because they are what the citation rule vouched for.
 */
export function splitNoticeText(text: string): { lead: string; bullets: string[] } {
  const lines = text.split("\n");
  const lead = lines[0] ?? "";
  const bullets = lines.slice(1).map((l) => l.replace(/^\s*-\s?/, "")).filter((l) => l !== "");
  return { lead, bullets };
}

/**
 * The card. Renders nothing at all when there is nothing wrong — an empty card is a permanent
 * "everything is fine" box, which is the thing a reader stops seeing.
 */
export function FleetNoticeCard({ conditions }: { conditions: readonly FleetCondition[] }) {
  if (conditions.length === 0) return null;

  return (
    <div
      data-testid="fleet-notice"
      style={{
        alignSelf: "stretch",
        maxWidth: "100%",
        // `flex: "0 0 auto"` LIKE EVERY SIBLING IN THIS STACK, and this is a layout bug rather than
        // a style preference (roborev 57483). `ConciergeThread` is `flex: 1` with a `0%` basis,
        // which gives it a scaled shrink factor of ZERO, and the other rows are all explicitly
        // `0 0 auto` — so a card left at the default `0 1 auto` is the ONLY shrinkable item in the
        // column and absorbs 100% of any vertical overflow.
        flex: "0 0 auto",
        // ...and its content is uncapped BY DESIGN: the escalation, retire, shared-failure and duty
        // conditions each emit one bullet PER AGENT, because naming them is the whole point of a
        // batch ("one glance clears eight"). On a fleet of a dozen-plus — the normal case in this
        // repo — that exceeds any sensible box. Capping the LIST would drop agents; capping the BOX
        // and scrolling keeps every one of them reachable, which is the right side to err on for a
        // card whose job is that nothing goes unnoticed.
        maxHeight: "32vh",
        overflowY: "auto",
        background: `color-mix(in srgb, ${accent} ${CARD_WASH_PCT}%, transparent)`,
        border: `1px solid color-mix(in srgb, ${accent} 32%, transparent)`,
        borderRadius: 6,
        padding: "12px 13px",
      }}
    >
      <div style={headingStyle}>
        <FiActivity aria-hidden size={13} style={{ flex: "none", color: accent }} />
        <span>Across the fleet</span>
      </div>

      {conditions.map((c) => {
        const { lead, bullets } = splitNoticeText(c.text);
        return (
          <div key={c.id} data-testid="fleet-notice-condition" data-condition={c.id}>
            <div style={leadStyle}>{lead}</div>
            {bullets.map((b, i) => (
              <div key={i} style={bulletStyle}>
                {b}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
