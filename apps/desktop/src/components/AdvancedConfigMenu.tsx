import { useEffect, useRef, useState, type CSSProperties } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FiActivity } from "react-icons/fi";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { SettingCheckbox } from "./SettingCheckbox";
import { useSettingsStore } from "../stores/settingsStore";
import {
  attentionCoverage,
  namingCoverage,
  useSelfReportMetrics,
} from "../stores/selfReportMetrics";
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

/** Format a coverage ratio for display: em-dash until there's any signal, else a whole percent. */
function pct(p: number | null): string {
  return p == null ? "—" : `${Math.round(p * 100)}%`;
}

/**
 * Read-only "Self-report observability (Phase 2c gate)" readout. Shows THIS SESSION's counts (from
 * the in-memory useSelfReportMetrics store — resets on relaunch, never persisted, never networked)
 * so the founder can eyeball how reliably in-app Claude agents self-report versus falling back to the
 * paid Haiku paths, with no PostHog dashboard. Displays COUNTS + derived coverage only — no agent
 * names, activity text, or any identifying data ever reaches this store.
 */
function SelfReportObservability() {
  const controlOps = useSelfReportMetrics((s) => s.controlOps);
  const namingOutcomes = useSelfReportMetrics((s) => s.namingOutcomes);
  const attentionSources = useSelfReportMetrics((s) => s.attentionSources);

  const naming = namingCoverage(namingOutcomes);
  const attention = attentionCoverage(attentionSources);

  const box: CSSProperties = {
    marginTop: 8,
    padding: "10px 12px",
    background: C.deepForest,
    border: `1px solid ${C.muted}`,
    borderRadius: 6,
    fontSize: 12.5,
    lineHeight: 1.6,
    color: C.cream,
    fontFamily: '"IBM Plex Mono", monospace',
  };
  const label: CSSProperties = { color: C.muted };

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <FiActivity size={13} color={C.muted} aria-hidden />
        <span style={{ fontSize: 13, fontWeight: 600, color: C.cream }}>
          Self-report observability (Phase 2c gate)
        </span>
      </div>
      <p style={help}>
        How often in-app Claude agents self-report (via the sparkle-control tools + their own titles)
        versus falling back to the paid Haiku paths. This session only — resets on relaunch.
      </p>
      <div style={box}>
        <div>
          <span style={label}>Naming</span> — self-report/aiTitle {naming.covered} · paid Haiku{" "}
          {naming.paid} → coverage {pct(naming.pct)}
        </div>
        <div style={{ ...label, fontSize: 11.5, marginBottom: 6 }}>
          deferred {namingOutcomes.deferred_first_turn} · skipped {namingOutcomes.skipped_thin}
        </div>
        <div style={{ marginBottom: 6 }}>
          <span style={label}>Attention</span> — self-report {attention.selfReport} · paid Haiku{" "}
          {attention.paid} · generic {attentionSources.generic_fallback} → coverage{" "}
          {pct(attention.pct)}
        </div>
        <div>
          <span style={label}>Control-tool calls</span> — rename_agent {controlOps.rename_agent} ·
          set_agent_activity {controlOps.set_agent_activity} · get_state {controlOps.get_state} ·
          get_config {controlOps.get_config} · set_config {controlOps.set_config} · set_theme{" "}
          {controlOps.set_theme}
        </div>
      </div>
    </div>
  );
}

export function AdvancedConfigMenu() {
  const warnings = useSettingsStore((s) => s.configWarnings);
  const autoApplyUpdates = useSettingsStore((s) => s.autoApplyUpdates);
  const setAutoApplyUpdates = useSettingsStore((s) => s.setAutoApplyUpdates);

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
      {/* Silent auto-apply of desktop updates (default on). Off → the updater shows a
          "Restart to apply" prompt instead; see services/updaterService. Unlike the AI feature
          flags, this persists in the app settings store (localStorage), NOT in the config.toml
          edited below. */}
      <div style={{ marginBottom: 10 }}>
        <SettingCheckbox
          label="Automatically apply updates"
          checked={autoApplyUpdates}
          onToggle={() => setAutoApplyUpdates(!autoApplyUpdates)}
        />
      </div>

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

      <SelfReportObservability />
    </div>
  );
}
