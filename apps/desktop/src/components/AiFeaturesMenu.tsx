import { Fragment, type CSSProperties } from "react";
import { FiAlertTriangle } from "react-icons/fi";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { SettingCheckbox } from "./SettingCheckbox";
import {
  useSettingsStore,
  aiFeatureMode,
  type AiFeatureKey,
  type AiMode,
} from "../stores/settingsStore";
// Toggles write to config.toml (the source of truth) via these actions, which also update the
// store optimistically; the resulting config-changed event re-hydrates the store.
import { setAiFeature, setAllAiFeatures, setAutoApprovePreset } from "../services/configActions";
import { autoApprovePresetOf } from "../services/autoApprovePreset";

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
  { key: "composer", label: "Use AI-enhanced composer" },
  { key: "suggestedActions", label: "Suggested actions" },
  { key: "autoApprove", label: "Auto-answer Claude Code permission prompts (uncheck to be asked each time)" },
];

const row: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

// The nested Auto-approve scope sub-control. Indented under the checkbox so it reads as "part of"
// the yes, with a left rule to make the nesting obvious.
const scopeBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  margin: "2px 0 6px 24px",
  paddingLeft: 10,
  borderLeft: `2px solid ${C.forest}`,
};

const scopeRow: CSSProperties = { display: "flex", gap: 6 };

function scopeBtn(active: boolean): CSSProperties {
  return {
    flex: 1,
    background: active ? C.teal : "transparent",
    color: active ? ON_BRAND_FILL : C.cream,
    border: `1px solid ${active ? C.teal : C.muted}`,
    borderRadius: 6,
    padding: "5px 8px",
    fontSize: 12,
    fontFamily: '"IBM Plex Sans", sans-serif',
    cursor: "pointer",
    lineHeight: 1.2,
  };
}

const scopeHint: CSSProperties = { color: C.muted, fontSize: 11, lineHeight: 1.4 };

const scopeWarn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  color: C.amber,
  fontSize: 11,
  lineHeight: 1.4,
};

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

export function AiFeaturesMenu() {
  const aiAutoRename = useSettingsStore((s) => s.aiAutoRename);
  const cloudDictation = useSettingsStore((s) => s.cloudDictation);
  const aiComposer = useSettingsStore((s) => s.aiComposer);
  const aiSuggestedActions = useSettingsStore((s) => s.aiSuggestedActions);
  const aiAutoApprove = useSettingsStore((s) => s.aiAutoApprove);

  const flags = {
    aiAutoRename,
    cloudDictation,
    aiComposer,
    aiSuggestedActions,
    aiAutoApprove,
  };
  const mode = aiFeatureMode(flags);
  const valueByKey: Record<AiFeatureKey, boolean> = {
    autoRename: aiAutoRename,
    voiceDictation: cloudDictation,
    composer: aiComposer,
    suggestedActions: aiSuggestedActions,
    autoApprove: aiAutoApprove,
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
          <Fragment key={key}>
            <SettingCheckbox
              label={label}
              checked={valueByKey[key]}
              onToggle={() => setAiFeature(key, !valueByKey[key])}
            />
            {/* "Auto-answer" is a yes/no; once yes, the nested scope decides HOW much it auto-answers.
                Only rendered when the checkbox is on — an off master answers nothing regardless. */}
            {key === "autoApprove" && aiAutoApprove && <AutoApproveScope />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** The nested "how much to auto-answer" sub-choice shown under the (checked) Auto-answer toggle. Two
 *  presets over the [approvals] rules: commands (bash) excluded, or everything. The active one is
 *  DERIVED from the global approvals map, so it also reflects rules set in the granular Auto-approve
 *  pane — an unrecognized (custom) combination highlights neither and shows the "asking each time"
 *  hint. */
function AutoApproveScope() {
  const preset = autoApprovePresetOf(useSettingsStore((s) => s.approvals));
  return (
    <div style={scopeBox} role="group" aria-label="How much to auto-approve">
      <div style={scopeRow}>
        <button
          type="button"
          aria-pressed={preset === "except-bash"}
          style={scopeBtn(preset === "except-bash")}
          onClick={() => void setAutoApprovePreset("except-bash")}
        >
          Everything except commands
        </button>
        <button
          type="button"
          aria-pressed={preset === "full"}
          style={scopeBtn(preset === "full")}
          onClick={() => void setAutoApprovePreset("full")}
        >
          Everything, including commands
        </button>
      </div>
      {preset === "full" && (
        <span style={scopeWarn}>
          <FiAlertTriangle size={11} /> Commands run without asking — including destructive ones.
        </span>
      )}
      {preset === null && (
        <span style={scopeHint}>
          Asking each time. Pick one to auto-approve, or fine-tune per category in the Auto-approve
          settings.
        </span>
      )}
    </div>
  );
}
