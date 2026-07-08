import { useState, type CSSProperties } from "react";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { SettingCheckbox } from "./SettingCheckbox";
import { useSettingsStore } from "../stores/settingsStore";
import { useDictationStore } from "../stores/dictationStore";
import {
  setWakeWord,
  setStopWord,
  setPauseOnSubmit,
  resetVoiceSettings,
} from "../services/configActions";
import {
  DEFAULT_WAKE_WORD,
  DEFAULT_STOP_WORD,
} from "../voice/voiceDefaults";

// "Voice controls" pane for the ⋯ settings dialog. Surfaces the always-listening mic toggle
// (dictationStore.enabled — the same master used everywhere else), lets the user remap the wake
// and stop words, and pick whether submitting a prompt keeps or pauses listening. Writes go to
// config.toml via configActions (optimistic store update → file write → hydrate), matching the
// other config-backed panes. The mic toggle stays in dictationStore (localStorage), not [voice].

const label: CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  color: C.cream,
  marginBottom: 4,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const caption: CSSProperties = {
  fontSize: 11,
  color: C.muted,
  marginTop: 4,
  lineHeight: 1.35,
  fontFamily: '"IBM Plex Sans", sans-serif',
};

const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "transparent",
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "6px 8px",
  color: C.cream,
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
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
  cursor: "pointer",
};

/** A labeled word field that edits a LOCAL draft and only persists on blur, snapping back to the
 *  resolved (default-on-empty) value so the box never shows a blank the matcher wouldn't honor. */
function WordField({
  fieldLabel,
  value,
  fallback,
  onCommit,
  hint,
}: {
  fieldLabel: string;
  value: string;
  fallback: string;
  onCommit: (word: string) => void;
  hint?: string;
}) {
  const [draft, setDraft] = useState(value);
  // Keep the draft in sync when the store value changes underneath us (e.g. Reset, live config edit).
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value);
  }
  const commit = () => {
    const resolved = draft.trim() || fallback;
    setDraft(resolved);
    onCommit(resolved);
  };
  const id = `voice-${fieldLabel.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div style={{ marginTop: 12 }}>
      <label htmlFor={id} style={label}>
        {fieldLabel}
      </label>
      <input
        id={id}
        aria-label={fieldLabel}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        style={input}
        spellCheck={false}
      />
      {hint ? <div style={caption}>{hint}</div> : null}
    </div>
  );
}

/** The Keep listening | Pause listening segmented control. Pause (true) is the default. */
function SubmitModeSegment({ pause, onChange }: { pause: boolean; onChange: (pause: boolean) => void }) {
  const segStyle = (active: boolean): CSSProperties => ({
    ...seg,
    background: active ? C.teal : "transparent",
    color: active ? ON_BRAND_FILL : C.muted,
    borderColor: active ? C.teal : C.muted,
  });
  return (
    <div role="group" aria-label="On submit" style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <button
        type="button"
        aria-pressed={!pause}
        onClick={() => onChange(false)}
        style={segStyle(!pause)}
      >
        Keep listening
      </button>
      <button
        type="button"
        aria-pressed={pause}
        onClick={() => onChange(true)}
        style={segStyle(pause)}
      >
        Pause listening
      </button>
    </div>
  );
}

export function VoiceControlsMenu() {
  const enabled = useDictationStore((s) => s.enabled);
  const setEnabled = useDictationStore((s) => s.setEnabled);
  const wakeWord = useSettingsStore((s) => s.wakeWord);
  const stopWord = useSettingsStore((s) => s.stopWord);
  const pauseOnSubmit = useSettingsStore((s) => s.pauseOnSubmit);

  return (
    <div>
      <SettingCheckbox
        label="Voice dictation (always-listening mic)"
        checked={enabled}
        onToggle={() => setEnabled(!enabled)}
      />
      <div style={caption}>
        When on, Sparkle listens for your wake word on-device and starts dictating when it hears it.
      </div>

      <WordField
        fieldLabel="Wake word"
        value={wakeWord}
        fallback={DEFAULT_WAKE_WORD}
        onCommit={setWakeWord}
        hint="What you say to start talking to Sparkle. A distinctive, multi-syllable phrase is recognized most reliably; very short words work less well."
      />
      <WordField
        fieldLabel="Stop word"
        value={stopWord}
        fallback={DEFAULT_STOP_WORD}
        onCommit={setStopWord}
        hint="What you say to stop active dictation."
      />

      <div style={{ marginTop: 14 }}>
        <span style={label}>When you submit a prompt</span>
        <SubmitModeSegment pause={pauseOnSubmit} onChange={setPauseOnSubmit} />
        <div style={caption}>
          {pauseOnSubmit
            ? "Sparkle stops dictating after you submit and waits for your wake word again."
            : "Sparkle keeps listening after you submit, so you can keep talking."}
        </div>
      </div>

      <button
        type="button"
        onClick={() => void resetVoiceSettings()}
        style={{
          marginTop: 16,
          background: "transparent",
          border: `1px solid ${C.muted}`,
          borderRadius: 6,
          padding: "6px 10px",
          color: C.muted,
          fontSize: 12,
          fontFamily: '"IBM Plex Sans", sans-serif',
          cursor: "pointer",
        }}
      >
        Reset voice settings to defaults
      </button>
    </div>
  );
}
