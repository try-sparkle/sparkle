import { useEffect, type CSSProperties } from "react";
import { FiCloud, FiMonitor } from "react-icons/fi";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { FONT_WEIGHT } from "@sparkle/ui";
import { useUiStore } from "../stores/uiStore";
import { useCloudAgentsEnabled } from "../hooks/useCloudAgents";
import { FONT_UI } from "../theme/scale";

// The Local / Cloud runtime toggle at agent creation (Service B, spec §"One toggle at agent
// creation: Local (free) vs Cloud (credits)"). It renders NOTHING unless the server has advertised
// the cloud capability for this account — a local-only user sees exactly the UI they saw before.
//
// It also self-heals: if the capability disappears while "Cloud" is selected (sign-out, the flag
// flipped off, a /me that no longer advertises it), the selection snaps back to Local so the next
// "+ New Build Agent" click can't fire a cloud action the account no longer has.

export function NewAgentRuntimeToggle() {
  const enabled = useCloudAgentsEnabled();
  const runtime = useUiStore((s) => s.newAgentRuntime);
  const setRuntime = useUiStore((s) => s.setNewAgentRuntime);

  useEffect(() => {
    if (!enabled && runtime !== "local") setRuntime("local");
  }, [enabled, runtime, setRuntime]);

  if (!enabled) return null;

  return (
    <div role="radiogroup" aria-label="Where new agents run" style={wrap} data-testid="runtime-toggle">
      <Option
        selected={runtime === "local"}
        onSelect={() => setRuntime("local")}
        label="Local"
        title="Run the agent on this Mac (free)"
        icon={<FiMonitor size={12} />}
      />
      <Option
        selected={runtime === "cloud"}
        onSelect={() => setRuntime("cloud")}
        label="Cloud"
        title="Run the agent in a Sparkle sandbox — keeps going with your laptop closed. Billed in credits per running minute."
        icon={<FiCloud size={12} />}
      />
    </div>
  );
}

function Option({
  selected,
  onSelect,
  label,
  title,
  icon,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  title: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      title={title}
      onClick={onSelect}
      style={{
        ...option,
        background: selected ? C.teal : "transparent",
        color: selected ? ON_BRAND_FILL : C.muted,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

const wrap: CSSProperties = {
  display: "flex",
  gap: 2,
  padding: 2,
  borderRadius: 6,
  background: C.deepForest,
  alignSelf: "stretch",
};

const option: CSSProperties = {
  flex: 1,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 5,
  border: "none",
  borderRadius: 6,
  padding: "4px 8px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: FONT_UI,
};
