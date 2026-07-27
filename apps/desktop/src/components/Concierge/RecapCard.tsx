// The return-from-Away card: "here's what happened while you were gone."
//
// DELIBERATELY NOT INTERACTIVE, which is the design decision most likely to look like an omission.
// Every agent this card names as needing you is ALREADY in the thread as a nudge card, with its own
// "Show me" / "Approve" buttons (ConciergeHost.surfacedAgents). Duplicating those buttons here would
// give the same agent two live action surfaces one scroll apart, which is how a user ends up
// approving the same thing twice. So this card summarises and the nudge cards act.
//
// NO LIVE REGION HERE. The summary is announced through the concierge column's existing single
// `role="status"` node, fed by the host (`announce`). A second region would double-announce — that
// was learned and fixed once already during the auto-routing work.
//
// Accent is the brand cyan rather than the nudge sienna: this is not itself an alarm. It is a
// briefing that may CONTAIN alarms, and painting it red would make every return from lunch look
// like an incident.
import type { CSSProperties } from "react";
import { C, CARD_WASH_PCT, FONT_WEIGHT } from "../../theme/colors";
import {
  recapSummary,
  type ConciergeRecapMessage,
  type GateDecision,
  type RecapChange,
} from "../../services/conciergeRecap";

const accent = C.accentInk;

const sectionLabel: CSSProperties = {
  fontSize: 9.5,
  fontWeight: FONT_WEIGHT.bold,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: C.conciergeMuted,
  marginTop: 10,
  marginBottom: 4,
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 6,
  fontSize: 12.5,
  color: C.cream,
  padding: "2px 0",
};

// The project name, at the smallest type on the card. INK IS `conciergeMuted`, NOT `C.amber`
// (roborev 53631-M4): amber is brand-constant across themes, and as 9.5px text on this card — an
// accent wash over `conciergeSurface` — it lands at 1.8:1 light / 3.3:1 dark against a 4.5:1
// requirement. `conciergeMuted` is the ink tuned for this column (theme/colors.ts, roborev
// 46254-L). Amber survives as the BORDER, which is a fill and legible as one — the same ink/fill
// split this card's sibling PresenceSlider now makes explicit. NudgeCard's identical chip moved
// with it, so the two cards don't disagree one scroll apart.
//
// KNOWN RESIDUAL: muted lands at 4.34:1 dark / 4.08:1 light on this card — better than amber by
// far, still shy of AA — because the wash moves the surface off the shade conciergeMuted was tuned
// against. That is true of every muted string on the card, not just this chip, so it belongs to the
// card's surface. Measured in theme/amberInk.test.ts; tracked in PRD/sparkle/concierge-presence.md.
const projectChip: CSSProperties = {
  fontSize: 9.5,
  color: C.conciergeMuted,
  border: `1px solid color-mix(in srgb, ${C.amber} 40%, transparent)`,
  borderRadius: 5,
  padding: "1px 5px",
  flex: "none",
};

/** What the concierge did on your behalf, in the user's words. The `kind` is the whole point of the
 *  line — "I sent this" and "I held this back" are opposite facts — so it leads. */
function decisionVerb(kind: GateDecision["kind"]): string {
  switch (kind) {
    case "sent":
      return "Sent";
    case "queued":
      return "Held for you";
    case "cancelled":
      return "Cancelled";
    default: {
      // Exhaustiveness guard, matching the pattern the dispatch refusal taxonomy uses: a new
      // decision kind on the sibling branch must fail to compile here rather than render blank.
      const unhandled: never = kind;
      void unhandled;
      return "Did";
    }
  }
}

/**
 * Rows per section before the rest collapse into a count.
 *
 * Returning after a night on a large fleet is exactly when this card has the most to say and the
 * least room to say it: uncapped, thirty changed agents push the chat off screen above the compose
 * box — the same failure `buildDigest` exists to prevent on the nudge side. Nothing is lost by
 * capping, because the summary sentence already carries the totals; the rows are the detail, and
 * five of them is enough to recognise WHICH fleet moved.
 */
const SECTION_CAP = 5;

/** The overflow line. Muted and inert — it is a count, not a control; opening the rest is what the
 *  agent list itself is for, and the card is deliberately non-interactive (see the header).
 *
 *  The night-away case this cap exists for overflows ALL THREE sections at once, so three bare
 *  "+7 more" lines need telling apart TWICE OVER, by two different readers (roborev 53655-M /
 *  53665-M / 53674-M): `data-section` is for the tests, and the section name is spoken via a
 *  VISUALLY HIDDEN span — not `aria-label`, which was the first attempt and does nothing here. A
 *  bare `div` maps to ARIA's `generic` role, where name-from-author is PROHIBITED: conforming
 *  browsers drop the author name and screen readers read the text content instead, so the label
 *  was invisible to exactly the users it was for. Content is the reliable carrier. Sighted users
 *  get the same fact from the heading directly above. */
function MoreLine({
  n,
  word,
  section,
  label,
}: {
  n: number;
  word: string;
  section: string;
  label: string;
}) {
  return (
    <div
      style={{ ...rowStyle, color: C.conciergeMuted }}
      data-testid="recap-more"
      data-section={section}
    >
      <span>
        +{n} {word}
      </span>
      {/* Same clip-rect shape as the column's announcer (ConciergeColumn) — this codebase has no
          sr-only utility, and inventing a second one would be the thing that drifts. */}
      <span
        data-testid="recap-more-section"
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {" "}
        in {label}
      </span>
    </div>
  );
}

function ChangeSection({
  label,
  changes,
  section,
}: {
  label: string;
  changes: RecapChange[];
  section: string;
}) {
  if (changes.length === 0) return null; // a section with nothing in it is a heading and a gap
  const shown = changes.slice(0, SECTION_CAP);
  return (
    <>
      <div style={sectionLabel}>{label}</div>
      {shown.map((c) => (
        <ChangeRow key={c.agentId} change={c} />
      ))}
      {changes.length > shown.length && (
        <MoreLine n={changes.length - shown.length} word="more" section={section} label={label} />
      )}
    </>
  );
}

function ChangeRow({ change }: { change: RecapChange }) {
  return (
    <div style={rowStyle} data-testid="recap-change" data-status={change.status}>
      <span style={projectChip}>{change.projectName}</span>
      <span style={{ fontWeight: FONT_WEIGHT.semibold }}>{change.agentName}</span>
      <span style={{ color: C.conciergeMuted }}>{change.statusLabel}</span>
    </div>
  );
}

export function RecapCard({ recap }: { recap: ConciergeRecapMessage }) {
  return (
    <div
      data-testid="concierge-recap"
      style={{
        alignSelf: "stretch",
        maxWidth: "100%",
        background: `color-mix(in srgb, ${accent} ${CARD_WASH_PCT}%, transparent)`,
        border: `1px solid color-mix(in srgb, ${accent} 32%, transparent)`,
        borderRadius: 12,
        padding: "12px 13px",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: FONT_WEIGHT.semibold, color: C.cream }}>
        {recapSummary(recap)}
      </div>

      <ChangeSection label="Wants you" changes={recap.needsYou} section="needsYou" />
      <ChangeSection label="Finished" changes={recap.finished} section="finished" />

      {recap.decisions.length > 0 && (
        <>
          <div style={sectionLabel}>What I did</div>
          {/* Capped from the OTHER end than the change sections, and the marker leads rather than
              trails. Decisions arrive oldest-first because the card reads as a narrative, but the
              ones you can still do something about are the most RECENT — a cancelled deploy from
              two minutes ago must not be the line that got dropped. */}
          {recap.decisions.length > SECTION_CAP && (
            <MoreLine
              n={recap.decisions.length - SECTION_CAP}
              word="earlier"
              section="decisions"
              label="What I did"
            />
          )}
          {recap.decisions.slice(-SECTION_CAP).map((d) => (
            <div key={d.id} style={rowStyle} data-testid="recap-decision" data-kind={d.kind}>
              <span style={{ fontWeight: FONT_WEIGHT.semibold, flex: "none" }}>
                {decisionVerb(d.kind)}
              </span>
              <span style={{ color: C.conciergeMuted }}>
                {d.summary} — {d.agentName}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
