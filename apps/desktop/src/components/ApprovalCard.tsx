import type { CSSProperties } from "react";
import { C, FONT_WEIGHT } from "@sparkle/ui";
import type { Approval } from "../types";

interface Props {
  approval: Approval;
  onApprove: () => void;
  onDeny: () => void;
  onAskMore: () => void;
}

const ICON = { pass: "✅", warn: "⚠️", info: "ℹ️" } as const;

// §10.3 — replaces an AgentCard when the agent is waiting on a decision.
export function ApprovalCard({ approval, onApprove, onDeny, onAskMore }: Props) {
  const dangerous = approval.riskClass === "dangerous";
  const badge = dangerous ? C.sienna : C.amber;

  return (
    <div style={{ ...card, border: `1px solid ${badge}` }}>
      <div style={{ color: badge, fontWeight: FONT_WEIGHT.bold, fontSize: 12, letterSpacing: 1 }}>
        {dangerous ? "🚨 DANGEROUS" : "⚠️ CAUTION"}
      </div>

      <div style={{ color: C.cream, fontSize: 15, fontWeight: FONT_WEIGHT.medium }}>
        {approval.description}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ color: C.muted, fontSize: 12 }}>Chief:</span>
        {approval.chiefSignals.map((s, i) => (
          <div key={i} style={{ color: C.cream, fontSize: 13 }}>
            {ICON[s.type]} {s.label}
          </div>
        ))}
      </div>

      <div style={{ color: C.muted, fontStyle: "italic", fontSize: 13 }}>
        Recommendation: {approval.chiefRecommendation}
      </div>

      <div style={{ marginTop: "auto", display: "flex", gap: 8 }}>
        <button onClick={onApprove} style={solid(C.teal)}>
          ✓ Approve
        </button>
        <button onClick={onAskMore} style={outline}>
          Ask More
        </button>
        <button onClick={onDeny} style={solid(C.sienna)}>
          ✗ Deny
        </button>
      </div>
    </div>
  );
}

const card: CSSProperties = {
  width: 370,
  minHeight: 160,
  background: C.deepForest,
  borderRadius: 12,
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const solid = (bg: string): CSSProperties => ({
  background: bg,
  color: C.cream,
  border: "none",
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
});
const outline: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "6px 12px",
  fontSize: 13,
  cursor: "pointer",
};
