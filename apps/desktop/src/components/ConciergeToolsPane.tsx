import { type CSSProperties } from "react";
import { FiAlertTriangle, FiRotateCcw, FiSlash } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { useSettingsStore } from "../stores/settingsStore";
import { setConciergeToolPolicy } from "../services/configActions";
import {
  useConciergeAiAccess,
  turnOnConciergeAi,
  type ConciergeAiRemedy,
} from "../services/conciergeAiAccess";
import { AI_ENHANCEMENTS_GRADIENT } from "./AiEnhancementsBadge";
import { AiLockedNotice } from "./AiLockedNotice";
import { RefillLink } from "./OutOfCreditsNotice";
import {
  CONCIERGE_TOOL_GROUPS,
  POLICY_DECISIONS,
  POLICY_DECISION_LABEL,
  evaluateToolPolicy,
  type ConciergeToolEntry,
  type PolicyDecision,
  type ToolPolicyEvaluation,
} from "../services/conciergeTools/policy";

import { RADIUS, TYPE } from "../theme/scale";
// The ⋯ Settings → "Concierge tools" pane: every tool the concierge can invoke, grouped by domain,
// each with an allow / ask first / never control.
//
// PER-TOOL IS THE POINT. There is deliberately no master autonomy slider at the top of this pane —
// one dial would have to be set to the strictness of the most dangerous tool it governs, which is
// how "let it read my terminals" and "never let it merge a PR" end up sharing a number. What plays
// that role instead is the DEFAULT column: every tool starts on a decision derived from the risk
// its tool domain already classifies it with, so the pane is usable without touching a single row.
//
// Every row states three things, because a permission control the user can't reason about gets set
// once and never revisited: what the tool DOES, how risky its domain says it is, and whether the
// current value is the derived default or something the user chose. Rows the user has set carry a
// "Set by you" pill and a reset control; the rest read "…by default".
//
// Reads come from the settings mirror of `[concierge.tools]`; every write goes through
// configActions (the TOML file is the source of truth) and clears the key rather than writing a
// value when the user resets a row — the default is derived, so freezing today's value into the
// file would quietly stop tracking a future reclassification.
//
// WITHOUT AI ENHANCEMENTS THE CONCIERGE CANNOT ACT AT ALL, and the pane says so ONCE. Every row
// still renders — greyed and read-only, but carrying its real name, risk and current value —
// because those rows ARE the argument for turning enhancements on: this is what you would be able
// to tune. Fifty per-row errors would bury that argument under noise about a single fact with a
// single remedy, which is why the policy layer reports one shared cause rather than fifty.
//
// AND THE SAVED RULES SURVIVE. Gating is a PRESENTATION state: nothing here writes, clears, or
// reinterprets `[concierge.tools]` while enhancements are off, so a row the human set still reads
// "set by you" and still shows their value. Switching enhancements off and back on restores their
// configuration exactly — a settings pane that silently resets someone's rules is the kind of bug
// people never forgive, and ConciergeToolsPane.test.tsx pins it.

export function ConciergeToolsPane() {
  const overrides = useSettingsStore((s) => s.conciergeToolPolicy);
  // ONE fact, from the one seam that also knows WHICH of the three remedies this user needs.
  const access = useConciergeAiAccess();
  const gated = !access.enabled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {gated && <AiEnhancementsGate remedy={access.remedy} />}
      <div style={noticeBox}>
        Each tool is set on its own. Anything left on its default is decided by how risky it is —
        reading and other reversible work happens silently, while anything irreversible,
        outward-facing, or metered stops to ask you first. Nothing defaults to “Never”.
      </div>
      {CONCIERGE_TOOL_GROUPS.map((group) => (
        <section
          key={group.domain}
          style={{ display: "flex", flexDirection: "column", gap: 12, opacity: gated ? 0.55 : 1 }}
        >
          <h3 style={groupHeading}>{group.label}</h3>
          {group.tools.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              evaluation={evaluateToolPolicy(tool.name, { overrides })}
              gated={gated}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/** The id the gated rows' controls point their `aria-describedby` at — so the reason a button is
 *  disabled is available on EVERY row without the sentence being repeated fifty times. */
const GATE_REASON_ID = "concierge-ai-gate-reason";

/**
 * The single banner. One headline, one sentence, one action — and the action is chosen by the
 * remedy, because there are three different reasons the concierge can be dark and telling a user
 * the wrong one is worse than telling them nothing:
 *
 *  • `enable-setting` — their own switch. Free and instant, so it gets a plain "Turn on".
 *  • `buy-app`        — the $99 has not been bought: the EXISTING AiLockedNotice paywall.
 *  • `top-up`         — bought, balance spent: the EXISTING refill seam. Deliberately NOT the $99
 *                       upsell — this user already owns the app.
 *
 * The ✦ and the brand gradient are the marketing badge's own (AI_ENHANCEMENTS_GRADIENT is imported
 * rather than re-declared). The badge COMPONENT isn't reused verbatim: it says "Sparkle + AI
 * enhancements" at 18px marketing scale, and this is a settings banner making a different sentence.
 */
function AiEnhancementsGate({ remedy }: { remedy: ConciergeAiRemedy }) {
  return (
    <div style={gateBox} role="note" data-testid="concierge-ai-gate">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ color: C.accent, fontSize: TYPE.body, lineHeight: 1 }}>
          ✦
        </span>
        <span style={gateHeadline}>Requires AI enhancements</span>
      </div>
      <p id={GATE_REASON_ID} style={gateBody}>
        Turn them on to let your concierge act — and to tune it per tool.
      </p>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10 }}>
        {remedy === "buy-app" ? (
          <AiLockedNotice
            label="Buy Sparkle to let your concierge act."
            style={{ background: "transparent", border: "none", padding: 0 }}
          />
        ) : remedy === "top-up" ? (
          <RefillLink label="Add credits" />
        ) : (
          <button type="button" style={turnOnBtn} onClick={turnOnConciergeAi}>
            Turn on
          </button>
        )}
      </div>
      <p style={gateFoot}>
        Your per-tool rules below are saved — turning enhancements back on restores them.
      </p>
    </div>
  );
}

/** One tool: what it does, how risky it is, where its current value came from, and the control.
 *
 *  `gated` greys the row and makes it READ-ONLY. It changes nothing else: the name, the risk, the
 *  "set by you" pill and the highlighted value are all still the truth about their configuration,
 *  which is both the point of showing the row and the promise that nothing was reset. */
function ToolRow({
  tool,
  evaluation,
  gated,
}: {
  tool: ConciergeToolEntry;
  evaluation: ToolPolicyEvaluation;
  gated: boolean;
}) {
  // An entry that isn't allow/ask/deny (a hand-edit typo) resolves to "ask" WITHOUT matching any
  // button — so highlight nothing and say why, rather than showing a value the file doesn't hold.
  const unreadable = evaluation.source === "unreadable-override";
  const selected: PolicyDecision | null = unreadable ? null : evaluation.decision;

  return (
    <div style={row} data-testid="concierge-tool-row">
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={toolName}>{tool.name}</span>
          <span style={riskPill} title={`Risk: ${tool.riskClass}`}>
            {tool.riskClass}
          </span>
          {evaluation.overridden ? (
            <span style={setByYouPill}>set by you</span>
          ) : (
            <span style={defaultPill}>default</span>
          )}
          {unreadable && (
            <span style={warnPill} title={evaluation.reason}>
              <FiAlertTriangle size={11} /> unreadable
            </span>
          )}
        </div>
        <span style={{ color: C.muted, fontSize: 12, lineHeight: 1.45 }}>{tool.summary}</span>
        <span style={{ color: unreadable ? C.amber : C.muted, fontSize: 11 }}>
          {statusText(tool, evaluation)}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center" }}>
        {POLICY_DECISIONS.map((decision) => (
          <button
            key={decision}
            type="button"
            aria-pressed={selected === decision}
            disabled={gated}
            aria-describedby={gated ? GATE_REASON_ID : undefined}
            style={btn(selected === decision)}
            // Belt and braces with `disabled`: a write while the concierge cannot act is not a
            // write we want to make, and the rules on this pane are the user's own.
            onClick={() => {
              if (gated) return;
              void setConciergeToolPolicy(tool.name, decision);
            }}
          >
            {POLICY_DECISION_LABEL[decision]}
          </button>
        ))}
        {evaluation.overridden && (
          <button
            type="button"
            aria-label={`Reset ${tool.name} to its default`}
            title={`Back to the default: ${POLICY_DECISION_LABEL[tool.defaultDecision ?? "ask"]}`}
            disabled={gated}
            aria-describedby={gated ? GATE_REASON_ID : undefined}
            style={btn(false)}
            onClick={() => {
              if (gated) return;
              void setConciergeToolPolicy(tool.name, null);
            }}
          >
            <FiRotateCcw size={11} /> Reset
          </button>
        )}
        {/* The read-only marker: one glyph, no words. The sentence lives in the banner, and the
            buttons' aria-describedby already points every screen reader at it. */}
        {gated && (
          <span
            data-testid="concierge-tool-readonly"
            aria-hidden
            style={{ color: C.muted, display: "inline-flex", alignItems: "center" }}
          >
            <FiSlash size={12} />
          </span>
        )}
      </div>
    </div>
  );
}

/** The one line under a row: what happens now, and — when the user has set it — what the default
 *  was, so reverting is an informed choice rather than a guess. */
function statusText(tool: ConciergeToolEntry, evaluation: ToolPolicyEvaluation): string {
  if (evaluation.source === "unreadable-override") {
    return "config.toml holds a value that isn't allow, ask, or deny — asking first until it's fixed.";
  }
  const now =
    evaluation.decision === "allow"
      ? "Runs without asking"
      : evaluation.decision === "ask"
        ? "Asks you first, every time"
        : "Never runs";
  if (!evaluation.overridden) {
    return `${now} — the default for ${tool.riskClass} tools.`;
  }
  return `${now}. Default: ${POLICY_DECISION_LABEL[tool.defaultDecision ?? "ask"]}.`;
}

/** Exported for the ⋯-dialog rail's keyword set, so the rail advertises the same words the pane
 *  actually contains rather than an approximation someone maintains by hand. */
export const CONCIERGE_TOOLS_SEARCH_TERMS: readonly string[] = [
  "concierge autonomy per-tool permission allow ask deny approve silently risk irreversible",
  ...CONCIERGE_TOOL_GROUPS.map((g) => `${g.label} ${g.tools.map((t) => t.name).join(" ")}`),
];

// --- styles (matched to the surrounding Settings panes; see ApprovalsMenu) --------------------

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  paddingBottom: 12,
  borderBottom: `1px solid ${C.hairline}`,
};

const groupHeading: CSSProperties = {
  margin: 0,
  fontSize: 11,
  fontWeight: FONT_WEIGHT.semibold,
  color: C.muted,
  textTransform: "uppercase",
  letterSpacing: 0.6,
};

const toolName: CSSProperties = {
  color: C.cream,
  fontWeight: FONT_WEIGHT.semibold,
  fontSize: 13,
  fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
};

// An inset well inside the SettingsDialog shell — same treatment (and same reasoning about which
// token carries the boundary) as ApprovalsMenu's notice.
const noticeBox: CSSProperties = {
  fontSize: 12,
  color: C.muted,
  lineHeight: 1.5,
  background: C.forest,
  border: `1px solid ${C.hairline}`,
  borderRadius: 8,
  padding: "8px 10px",
};

// The gate banner. Same inset-well geometry as `noticeBox` so it sits in the pane's rhythm, but the
// 1.5px stroke carries the brand gradient (the badge's double-background trick: a padding-box fill
// over a border-box gradient) — it is the app's mark for "this is an AI enhancement".
const gateBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  background: `linear-gradient(${C.forest}, ${C.forest}) padding-box, ${AI_ENHANCEMENTS_GRADIENT} border-box`,
  border: "1.5px solid transparent",
  borderRadius: 8,
  padding: "10px 12px",
};

const gateHeadline: CSSProperties = {
  fontSize: 13,
  fontWeight: FONT_WEIGHT.semibold,
  background: AI_ENHANCEMENTS_GRADIENT,
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

const gateBody: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.5,
  color: C.cream,
};

const gateFoot: CSSProperties = {
  margin: 0,
  fontSize: 11,
  lineHeight: 1.45,
  color: C.muted,
};

const turnOnBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 4,
  padding: "4px 12px",
  fontSize: 12,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: '"IBM Plex Sans", sans-serif',
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function pill(color: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontSize: 10,
    color,
    border: `1px solid ${color}`,
    borderRadius: 6,
    padding: "1px 5px",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    whiteSpace: "nowrap",
  };
}

const riskPill = pill(C.muted);
const defaultPill = pill(C.muted);
const setByYouPill = pill(C.teal);
const warnPill = pill(C.amber);

function btn(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    background: active ? C.teal : "transparent",
    // Text ON a brand-teal fill: the token for exactly that, which stays light in BOTH themes.
    color: active ? ON_BRAND_FILL : C.cream,
    border: `1px solid ${active ? C.teal : C.muted}`,
    borderRadius: RADIUS.md,
    padding: "5px 9px",
    fontSize: 12,
    fontFamily: '"IBM Plex Sans", sans-serif',
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}
