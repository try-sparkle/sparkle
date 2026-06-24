import { type CSSProperties } from "react";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { useUiStore, type AgentOrdering } from "../stores/uiStore";

// Two-option control for the TopBar ⋯ menu: how the sidebar orders agents.
// "attention" floats the agents that need you to the top; "manual" keeps insertion
// order. Reads/writes `agentOrdering` from uiStore, which AgentSidebar applies live.
// Stacked (not segmented) because the labels are full phrases.
const OPTIONS: Array<{ value: AgentOrdering; label: string; aria: string }> = [
  {
    value: "attention",
    label: "Agents need attention",
    aria: "Reorder agents so the ones needing attention are on top",
  },
  { value: "manual", label: "Do not reorder agents", aria: "Keep agents in their original order" },
];

const opt: CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "7px 10px",
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
  fontFamily: '"IBM Plex Sans", sans-serif',
};

export function AgentOrderToggle() {
  const agentOrdering = useUiStore((s) => s.agentOrdering);
  const setAgentOrdering = useUiStore((s) => s.setAgentOrdering);
  return (
    <div role="group" aria-label="Agent order" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {OPTIONS.map(({ value, label, aria }) => {
        const selected = agentOrdering === value;
        return (
          <button
            key={value}
            type="button"
            aria-label={aria}
            aria-pressed={selected}
            onClick={() => setAgentOrdering(value)}
            style={{
              ...opt,
              background: selected ? C.teal : "transparent",
              // On-teal foreground stays light in both themes (C.cream flips to navy in light).
              color: selected ? ON_BRAND_FILL : C.muted,
              borderColor: selected ? C.teal : C.muted,
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
