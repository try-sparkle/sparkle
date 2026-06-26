import { type CSSProperties } from "react";
import { C, ON_BRAND_FILL } from "../theme/colors";
import {
  useSettingsStore,
  aiFeatureMode,
  type AiFeatureKey,
  type AiMode,
} from "../stores/settingsStore";

// "Use AI Features" control for the TopBar ⋯ menu. A segmented All | Some | Off master plus a
// checkbox per feature. The master is DERIVED from the four feature flags (aiFeatureMode):
//   - clicking All / Off bulk-sets every feature on / off,
//   - "Some" is status-only (not clickable) — it simply lights up when the flags are mixed,
//   - toggling any checkbox re-derives the master (uncheck one from All → snaps to Some).
// Each feature degrades to a non-AI baseline when off; see the gates in AgentPane / AgentSidebar /
// useDictation.

const FEATURES: Array<{ key: AiFeatureKey; label: string }> = [
  { key: "autoRename", label: "Auto-rename workers based on the work they're doing" },
  { key: "voiceDictation", label: "Use AI-enhanced voice dictation for much better accuracy" },
  { key: "brainstorm", label: "Enable the AI Think agent (chat with Chief)" },
  { key: "composer", label: "Use AI-enhanced composer" },
];

const row: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

const seg: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "6px 0",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const checkboxRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  width: "100%",
  background: "transparent",
  border: "none",
  padding: "6px 4px",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  color: C.cream,
};

/** The All | Some | Off master segment. All/Off are actions; Some is a derived status only. */
function MasterSegment({ mode, onAll, onOff }: { mode: AiMode; onAll: () => void; onOff: () => void }) {
  const segStyle = (active: boolean): CSSProperties => ({
    ...seg,
    background: active ? C.teal : "transparent",
    color: active ? ON_BRAND_FILL : C.muted,
    borderColor: active ? C.teal : C.muted,
  });
  return (
    <div role="group" aria-label="Use AI features" style={row}>
      <button
        type="button"
        aria-pressed={mode === "all"}
        onClick={onAll}
        style={{ ...segStyle(mode === "all"), cursor: "pointer" }}
      >
        All
      </button>
      {/* Status-only: reflects a mixed selection, but the user sets subsets via the checkboxes.
          Not a button (nothing to press) — convey the derived "current" state with aria-current
          (valid on any element) rather than aria-pressed, which is only valid on toggle buttons.
          The descriptive aria-label is applied ONLY when this is the current mode; otherwise the
          accessible name is just the visible "Some" text, so a screen reader doesn't announce
          "Some AI features enabled" while the master is actually All or Off. */}
      <div
        aria-label={mode === "some" ? "Some AI features enabled" : undefined}
        aria-current={mode === "some" ? true : undefined}
        style={{ ...segStyle(mode === "some"), cursor: "default" }}
      >
        Some
      </div>
      <button
        type="button"
        aria-pressed={mode === "off"}
        onClick={onOff}
        style={{ ...segStyle(mode === "off"), cursor: "pointer" }}
      >
        Off
      </button>
    </div>
  );
}

/** A single feature checkbox row. */
function FeatureCheckbox({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} onClick={onToggle} style={checkboxRow}>
      <span
        aria-hidden
        style={{
          flex: "0 0 auto",
          width: 16,
          height: 16,
          marginTop: 1,
          borderRadius: 4,
          border: `1px solid ${checked ? C.teal : C.muted}`,
          background: checked ? C.teal : "transparent",
          color: ON_BRAND_FILL,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          lineHeight: 1,
        }}
      >
        {checked ? "✓" : ""}
      </span>
      <span style={{ color: checked ? C.cream : C.muted, lineHeight: 1.35 }}>{label}</span>
    </button>
  );
}

export function AiFeaturesMenu() {
  const aiAutoRename = useSettingsStore((s) => s.aiAutoRename);
  const cloudDictation = useSettingsStore((s) => s.cloudDictation);
  const aiBrainstorm = useSettingsStore((s) => s.aiBrainstorm);
  const aiComposer = useSettingsStore((s) => s.aiComposer);
  const setAiFeature = useSettingsStore((s) => s.setAiFeature);
  const setAllAiFeatures = useSettingsStore((s) => s.setAllAiFeatures);

  const flags = { aiAutoRename, cloudDictation, aiBrainstorm, aiComposer };
  const mode = aiFeatureMode(flags);
  const valueByKey: Record<AiFeatureKey, boolean> = {
    autoRename: aiAutoRename,
    voiceDictation: cloudDictation,
    brainstorm: aiBrainstorm,
    composer: aiComposer,
  };

  return (
    <div>
      <MasterSegment
        mode={mode}
        onAll={() => setAllAiFeatures(true)}
        onOff={() => setAllAiFeatures(false)}
      />
      <div style={{ marginTop: 6 }}>
        {FEATURES.map(({ key, label }) => (
          <FeatureCheckbox
            key={key}
            label={label}
            checked={valueByKey[key]}
            onToggle={() => setAiFeature(key, !valueByKey[key])}
          />
        ))}
      </div>
    </div>
  );
}
