import { useEffect, useRef, useState, type CSSProperties } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { useSettingsStore } from "../stores/settingsStore";
import {
  configFilePaths,
  readConfigText,
  resetConfig,
  writeConfigText,
} from "../services/config";

// "Advanced configuration" section for the TopBar ⋯ menu — the editable TOML config file surfaced
// for advanced users. It edits the GLOBAL config.toml (the source of truth); per-project files are
// edited in the repo. Saving validates the TOML in Rust (write_config_text) and rejects invalid
// input without touching the live config; the file watcher then live-reloads the rest of the app.

const btn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  whiteSpace: "nowrap",
};

const help: CSSProperties = { color: C.muted, fontSize: 12, lineHeight: 1.45, margin: "2px 0 8px" };

export function AdvancedConfigMenu() {
  const warnings = useSettingsStore((s) => s.configWarnings);

  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const globalPath = useRef<string | null>(null);

  // Load the raw file text + resolve the file path once when the section mounts.
  useEffect(() => {
    let cancelled = false;
    void readConfigText()
      .then((t) => {
        if (!cancelled) {
          setText(t);
          setLoaded(true);
        }
      })
      .catch((e) => !cancelled && setError(String(e)));
    void configFilePaths()
      .then((p) => (globalPath.current = p.global))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = async () => {
    setError(null);
    setStatus(null);
    try {
      await writeConfigText(text);
      setStatus("Saved. Changes applied.");
    } catch (e) {
      // Rust rejected invalid TOML; the live config and file are untouched.
      setError(String(e));
    }
  };

  const onReset = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setConfirmReset(false);
    setError(null);
    try {
      await resetConfig();
      const t = await readConfigText();
      setText(t);
      setStatus("Reset to defaults.");
    } catch (e) {
      setError(String(e));
    }
  };

  const onReveal = () => {
    if (globalPath.current) {
      revealItemInDir(globalPath.current).catch((e) => console.error("reveal config failed", e));
    }
  };

  return (
    <div>
      <p style={help}>
        Edit the configuration file directly (advanced). This is the source of truth for workflow
        rules, worker concurrency, and AI features. Comments you add are preserved. Saving validates
        the file and applies changes live; invalid TOML is rejected without changing anything.
      </p>

      {/* Non-fatal load warnings (malformed layer fell back, per-project keys ignored, clamped). */}
      {warnings.length > 0 && (
        <ul
          style={{
            margin: "0 0 8px",
            padding: "8px 10px 8px 24px",
            background: "rgba(220,160,40,0.12)",
            border: `1px solid ${C.muted}`,
            borderRadius: 6,
            color: C.cream,
            fontSize: 12,
          }}
        >
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setStatus(null);
          setError(null);
        }}
        spellCheck={false}
        aria-label="Configuration file (TOML)"
        readOnly={!loaded}
        style={{
          width: "100%",
          minHeight: 280,
          resize: "vertical",
          background: C.deepForest,
          color: C.cream,
          border: `1px solid ${error ? "#d66" : C.muted}`,
          borderRadius: 6,
          padding: 10,
          fontSize: 12.5,
          lineHeight: 1.5,
          fontFamily: '"IBM Plex Mono", monospace',
          whiteSpace: "pre",
          overflowWrap: "normal",
          overflowX: "auto",
        }}
      />

      {error && (
        <div style={{ color: "#e88", fontSize: 12.5, marginTop: 6, fontFamily: '"IBM Plex Mono", monospace' }}>
          {error}
        </div>
      )}
      {status && !error && (
        <div style={{ color: C.teal, fontSize: 12.5, marginTop: 6 }}>{status}</div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!loaded}
          style={{ ...btn, borderColor: C.teal, background: C.teal, color: ON_BRAND_FILL }}
        >
          Save
        </button>
        <button type="button" onClick={() => void onReset()} style={btn}>
          {confirmReset ? "Click again to confirm reset" : "Reset to defaults"}
        </button>
        {confirmReset && (
          <button type="button" onClick={() => setConfirmReset(false)} style={btn}>
            Cancel
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onReveal} style={btn}>
          Reveal in Finder
        </button>
      </div>
    </div>
  );
}
