// "Sparkle wants to discard Kraken Auth. [Approve] [Decline]" — the prompt the per-tool policy has
// been promising since it shipped.
//
// The policy layer could already say `ask`, and dispatchAuthority already refused to authorize an
// ask-tier call without `approvedByUser === true`. Nothing could produce that `true`, so every tool
// the human set to "Ask first" was dead and the refusal named a prompt that did not exist. This is
// that prompt. Pressing Approve here is the ONLY thing in the app that turns an `ask` into a grant
// (stores/conciergeApprovals) — a `confirm: true` in the model's own arguments never does.
//
// Structurally a sibling of CountdownBanner: purely presentational, no store reads, no live region.
// It sits directly above the compose box for the same reason the countdown does — it is the last
// thing between the concierge's intent and the world, so it belongs where the eye already is. The
// column owns ONE `role="status"` announcer and the host feeds it; a second live region here would
// make a screen reader read every request twice (learned once already, roborev 52648/53010).
//
// The card states three things, because a permission prompt nobody can reason about gets answered
// reflexively: WHAT the tool does, HOW risky its own domain says it is, and exactly WHICH arguments
// it would run with. All of that prose comes from `policy.ts`'s tables by way of the ledger entry —
// nothing is written here, so the card cannot drift from the classification it is quoting.
import type { CSSProperties } from "react";
import { FiAlertTriangle, FiCheck, FiRepeat, FiSettings, FiX } from "react-icons/fi";

import { C, CHAT_USER_BUBBLE, FONT_WEIGHT } from "../../theme/colors";
import type { ConciergeApproval } from "../../stores/conciergeApprovals";

import { FONT_MONO, RADIUS, TYPE } from "../../theme/scale";
export interface ApprovalPromptProps {
  /** Every unanswered request, oldest first (stores/conciergeApprovals.pendingApprovals). */
  approvals: readonly ConciergeApproval[];
  /** Takes the whole entry, not just its id, because approving now RUNS the call and the runner
   *  replays it from the entry's own stored arguments (services/conciergeApprovalResume). */
  onApprove: (approval: ConciergeApproval) => void;
  onDecline: (id: string) => void;
  /**
   * "Don't ask me about this again." Writes the SETTINGS override
   * (`configActions.setConciergeToolPolicy`), never an invisible session grant — the whole point is
   * that a standing permission is visible and revocable in Settings → Concierge tools rather than
   * being something the human granted once in a card and can never find again.
   */
  onAlwaysAllow: (approval: ConciergeApproval) => void;
}

/** The card's accent — the same brand sienna a nudge uses. A request to do something irreversible
 *  is the other thing in this column that means "this one is on you". */
const ACCENT = C.sienna;

export function ApprovalPrompt({
  approvals,
  onApprove,
  onDecline,
  onAlwaysAllow,
}: ApprovalPromptProps) {
  if (approvals.length === 0) return null;
  return (
    <div data-testid="approval-prompts" style={{ flex: "none", padding: "0 12px 8px" }}>
      {/* ALL of them, not just the newest. A pending request the human can't see is a tool call
          that will never resolve — the failure this whole round-trip exists to remove. */}
      {approvals.map((a) => (
        <ApprovalCard
          key={a.id}
          approval={a}
          onApprove={onApprove}
          onDecline={onDecline}
          onAlwaysAllow={onAlwaysAllow}
        />
      ))}
    </div>
  );
}

function ApprovalCard({
  approval,
  onApprove,
  onDecline,
  onAlwaysAllow,
}: { approval: ConciergeApproval } & Omit<ApprovalPromptProps, "approvals">) {
  return (
    <div
      data-testid="approval-card"
      data-approval-id={approval.id}
      data-op={approval.op}
      style={card}
    >
      <div style={metaRow}>
        <span style={askBadge}>
          {/* Feather, not an emoji — repo rule. */}
          <FiAlertTriangle size={11} aria-hidden />
          Needs you
        </span>
        {approval.riskClass && <span style={riskPill}>{approval.riskClass}</span>}
        <span style={opName}>{`${approval.domain}.${approval.op}`}</span>
      </div>

      {/* ALREADY RAN? Say it before anything else on the card. The commonest way to arrive here is
          a human who approved this a moment ago, was asked to say "go ahead", and did — so the
          honest reading of a second identical card is "you have already done this", and without
          that line the card is indistinguishable from the first one. Deliberate repeats are
          legitimate and still one click away; this only makes sure the click is informed. */}
      {approval.ranRecently && (
        <div data-testid="approval-ran-recently" style={ranNote}>
          <FiRepeat size={11} aria-hidden />
          <span>This already ran a moment ago. Approving runs it again.</span>
        </div>
      )}

      {/* WHAT IT WILL DO — the catalog's own one-liner, then the risk map's own note. */}
      <div style={{ fontSize: TYPE.body, color: C.cream }}>{approval.summary}</div>
      {approval.riskNote && (
        <div style={{ fontSize: TYPE.small, color: C.conciergeMuted, marginTop: 3 }}>
          {approval.riskNote}
        </div>
      )}

      {/* WHAT IT WILL DO IT TO. Without this the human is approving a verb with no object, and the
          approval is scoped to these exact arguments — so they are the thing being agreed to. */}
      {approval.args.length > 0 && (
        <dl data-testid="approval-args" style={argsBlock}>
          {approval.args.map((line) => (
            <div key={line.key} style={{ display: "flex", gap: 6, minWidth: 0 }}>
              <dt style={argKey}>{line.key}</dt>
              <dd style={argValue}>{line.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          // Names the TOOL, not just "Approve": with two cards stacked, a screen-reader user
          // tabbing through identical buttons has no way to tell which call each one answers.
          aria-label={`Approve ${approval.domain}.${approval.op}`}
          onClick={() => onApprove(approval)}
          style={approveBtn}
        >
          <FiCheck size={12} aria-hidden /> Approve once
        </button>
        <button
          type="button"
          aria-label={`Decline ${approval.domain}.${approval.op}`}
          onClick={() => onDecline(approval.id)}
          style={declineBtn}
        >
          <FiX size={12} aria-hidden /> Decline
        </button>
      </div>

      {/* The escape hatch, deliberately understated and deliberately NOT a session grant: it writes
          `concierge.tools.<op>` so the standing permission shows up in Settings with a Reset beside
          it. The title names the exact key, so "where did I agree to that?" has an answer. */}
      <button
        type="button"
        aria-label={`Always allow ${approval.op} without asking`}
        title={`Sets ${approval.configPath} to "Allow" — change it back any time in Settings → Concierge tools.`}
        onClick={() => onAlwaysAllow(approval)}
        style={alwaysBtn}
      >
        <FiSettings size={11} aria-hidden /> Always allow {approval.op}
      </button>
    </div>
  );
}

// --- styles (matched to NudgeCard / CountdownBanner, the column's other two card surfaces) -----

const card: CSSProperties = {
  background: `linear-gradient(180deg, color-mix(in srgb, ${ACCENT} 9%, transparent), color-mix(in srgb, ${ACCENT} 3%, transparent))`,
  border: `1px solid color-mix(in srgb, ${ACCENT} 40%, transparent)`,
  borderRadius: 6,
  padding: "12px 13px",
  marginTop: 6,
  boxShadow: `0 0 26px color-mix(in srgb, ${ACCENT} 10%, transparent)`,
};

const metaRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexWrap: "wrap",
  fontSize: 12,
  color: C.conciergeMuted,
  marginBottom: 6,
};

function pill(fill: string, ink: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontSize: TYPE.micro,
    fontWeight: FONT_WEIGHT.bold,
    letterSpacing: "0.04em",
    padding: "2px 6px",
    borderRadius: RADIUS.sm,
    color: ink,
    background: `color-mix(in srgb, ${fill} 16%, transparent)`,
    border: `1px solid color-mix(in srgb, ${fill} 60%, transparent)`,
    whiteSpace: "nowrap",
  };
}

// The literal accent paints the fill (color-mix needs a literal); the LABEL reads `dangerInk` —
// the same red, themed — because raw sienna is under the AA floor as text here. Same split, and
// the same reason, as NudgeCard's badge.
const askBadge = pill(ACCENT, C.dangerInk);
const riskPill: CSSProperties = {
  ...pill(C.muted, C.conciergeMuted),
  fontWeight: FONT_WEIGHT.semibold,
};

const opName: CSSProperties = {
  fontFamily: FONT_MONO,
  fontSize: TYPE.micro,
  color: C.conciergeMuted,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// Deliberately louder than the risk note and quieter than the buttons: it is a correction to the
// reader's assumption, not a new risk. Same sienna the card already uses.
const ranNote: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 5,
  marginBottom: 6,
  padding: "5px 7px",
  borderRadius: RADIUS.sm,
  fontSize: TYPE.small,
  color: C.dangerInk,
  background: `color-mix(in srgb, ${ACCENT} 14%, transparent)`,
  border: `1px solid color-mix(in srgb, ${ACCENT} 45%, transparent)`,
};

const argsBlock: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  margin: "8px 0 0",
  padding: "6px 8px",
  borderRadius: 6,
  background: CHAT_USER_BUBBLE,
  fontSize: 12,
  fontFamily: FONT_MONO,
};

const argKey: CSSProperties = { flex: "none", color: C.conciergeMuted, margin: 0 };

const argValue: CSSProperties = {
  flex: 1,
  minWidth: 0,
  margin: 0,
  color: C.cream,
  // A path or a prompt can be long; wrap it rather than blowing out the 380px column.
  overflowWrap: "anywhere",
};

function actionBtn(): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 12,
    fontWeight: FONT_WEIGHT.bold,
    borderRadius: 999,
    padding: "6px 11px",
    cursor: "pointer",
    font: "inherit",
  };
}

// THE SPEC'S PRIMARY PAIR — opaque, same as a nudge's primary action.
// This was a `goldHotInk` label over a 16% BRAND-GOLD wash, and the comment above it used to say
// "gold on gold". That stopped being true at the repaint: every gold token moved to the
// Blueprint's primary BLUE while this plate stayed gold, so the label went blue on gold and
// measured ~4.2-4.5 in dark — under AA. It is byte-for-byte the stack NudgeCard carried, and it
// has to move with it or the defect simply relocates.
const approveBtn: CSSProperties = {
  ...actionBtn(),
  color: C.onGoldFill,
  background: C.goldFill,
  border: `1px solid ${C.goldFill}`,
};

const declineBtn: CSSProperties = {
  ...actionBtn(),
  color: C.cream,
  background: CHAT_USER_BUBBLE,
  border: `1px solid color-mix(in srgb, ${C.muted} 30%, transparent)`,
};

// Quieter than both, on its own line: a standing permission should be a considered choice, not the
// most obvious way to make the card go away.
const alwaysBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  marginTop: 8,
  padding: 0,
  background: "transparent",
  border: "none",
  color: C.conciergeMuted,
  fontSize: TYPE.micro,
  textDecoration: "underline",
  cursor: "pointer",
};
