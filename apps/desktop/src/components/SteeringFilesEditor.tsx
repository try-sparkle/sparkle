import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { FiAlertTriangle, FiFileText, FiLayers, FiRefreshCw, FiSave } from "react-icons/fi";
import { C } from "../theme/colors";
import { FONT_MONO, FONT_UI, PILL, RADIUS, TYPE, WEIGHT } from "../theme/scale";
import {
  fetchSteeringStatus,
  layerLabel,
  seedSteeringTemplates,
  writeSteeringFile,
  type SteeringFile,
  type SteeringStatus,
} from "../services/steeringFiles";

// STEERING FILES EDITOR — view and edit this project's architecture map and standards, and see
// WHICH LAYER each one came from (bead .3).
//
// The layer badge is not decoration. These documents are injected into every agent's opening
// context as hard constraints, so "why is the agent doing that" is answered by "which file is it
// reading" — and with three layers stacked, a user editing the project copy while a local override
// silently wins would be editing a file nothing reads. Every row says where its content came from,
// and an edit is always written to a layer the user PICKED rather than to whichever one happened to
// supply the text.
//
// An UNREADABLE layer is rendered as its own state, never as "empty". Rust fails closed and reports
// it; collapsing that back into "no file here" in the UI would undo the whole point.

const help: CSSProperties = {
  color: C.muted,
  fontSize: TYPE.small,
  lineHeight: 1.45,
  margin: "2px 0 8px",
};

const btn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: RADIUS.modal,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: TYPE.body,
  fontFamily: FONT_UI,
  whiteSpace: "nowrap",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const badge: CSSProperties = {
  // `micro` + `PILL`: this is a tracked badge, and PILL is the named capsule token rather than a
  // literal 999 (theme/scale — a fixed radius cannot express "fully rounded on a wide box").
  fontSize: TYPE.micro,
  fontFamily: FONT_UI,
  padding: "1px 7px",
  borderRadius: PILL,
  background: C.pillFill,
  color: C.pillInk,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

const area: CSSProperties = {
  width: "100%",
  minHeight: 220,
  resize: "vertical",
  background: C.inputSurface,
  color: C.cream,
  border: `1px solid ${C.inputEdge}`,
  borderRadius: RADIUS.modal,
  padding: 10,
  fontFamily: FONT_MONO,
  fontSize: TYPE.small,
  lineHeight: 1.5,
};

/** Where an edit will be written. `global` is deliberately absent — see `writeSteeringFile`. */
type WritableLayer = "project" | "local";

/** One steering document's editor row. */
function FileEditor({
  file,
  root,
  onSaved,
}: {
  file: SteeringFile;
  root: string;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(file.content ?? "");
  const [target, setTarget] = useState<WritableLayer>(
    // Default the destination to the layer that SUPPLIED the text, so the obvious gesture — open,
    // edit, save — writes back to the file the user is looking at rather than shadowing it.
    file.layer === "local" ? "local" : "project",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Re-seed the draft when the resolved content changes underneath us (a refresh, a seed).
  useEffect(() => {
    setDraft(file.content ?? "");
  }, [file.content]);

  const onSave = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const path = await writeSteeringFile(root, file.name, draft, target);
      setStatus(`Saved to ${path}`);
      onSaved();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ marginBottom: 18 }} data-testid={`steering-file-${file.name}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <FiFileText size={13} color={C.muted} aria-hidden />
        <span style={{ fontSize: TYPE.body, fontWeight: WEIGHT.bold, color: C.cream }}>
          {file.name}
        </span>
        <span style={badge} data-testid={`steering-layer-${file.name}`}>
          <FiLayers size={10} aria-hidden />
          {layerLabel(file.layer)}
        </span>
        {file.path && (
          <span style={{ color: C.muted, fontSize: TYPE.micro, fontFamily: FONT_MONO }}>
            {file.path}
          </span>
        )}
      </div>

      {/* UNREADABLE ≠ ABSENT. Rust stopped the search here rather than serving a lower layer's
          content, so the editor says so instead of showing a reassuring empty box. */}
      {file.error && (
        <p
          style={{ ...help, color: C.dangerInk, display: "flex", alignItems: "center", gap: 6 }}
          role="alert"
        >
          <FiAlertTriangle size={12} aria-hidden />
          {file.error}
        </p>
      )}

      <textarea
        style={area}
        value={draft}
        spellCheck={false}
        aria-label={`${file.name} contents`}
        onChange={(e) => setDraft(e.target.value)}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 6 }}>
        <label style={{ color: C.muted, fontSize: TYPE.small, fontFamily: FONT_UI }}>
          Save to{" "}
          <select
            value={target}
            aria-label={`Layer to save ${file.name} to`}
            onChange={(e) => setTarget(e.target.value as WritableLayer)}
            style={{
              background: C.inputSurface,
              color: C.cream,
              border: `1px solid ${C.inputEdge}`,
              borderRadius: RADIUS.input,
              fontSize: TYPE.small,
              padding: "2px 4px",
            }}
          >
            <option value="project">project (.sparkle/steering)</option>
            <option value="local">local override (.sparkle/steering.local)</option>
          </select>
        </label>
        <button type="button" style={btn} onClick={() => void onSave()} disabled={saving}>
          <FiSave size={12} aria-hidden />
          {saving ? "Saving…" : "Save"}
        </button>
        {status && <span style={{ color: C.successInk, fontSize: TYPE.small }}>{status}</span>}
        {error && (
          <span style={{ color: C.dangerInk, fontSize: TYPE.small }} role="alert">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The steering-files pane for one project.
 *
 * `root` is the project's repo root — every command is scoped to it, and there is no "current
 * project" fallback on purpose: a pane that guessed which repo it was editing would write one
 * project's house rules into another's.
 */
export function SteeringFilesEditor({ root }: { root: string }) {
  const [status, setStatus] = useState<SteeringStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [seedNote, setSeedNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await fetchSteeringStatus(root));
      setLoadError(null);
    } catch (e) {
      setLoadError(String(e));
    }
  }, [root]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSeed = async () => {
    setBusy(true);
    setSeedNote(null);
    try {
      const report = await seedSteeringTemplates(root);
      setSeedNote(
        report.created.length > 0
          ? `Created ${report.created.join(", ")}.`
          : "Nothing to create — every steering file already exists.",
      );
      await load();
    } catch (e) {
      setSeedNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="steering-files-editor">
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
        <FiLayers size={13} color={C.muted} aria-hidden />
        <span style={{ fontSize: TYPE.body, fontWeight: WEIGHT.bold, color: C.cream }}>
          Steering files
        </span>
      </div>
      <p style={help}>
        This project&apos;s architecture map and standards. They are copied into every new agent
        worktree and injected into a spawning agent&apos;s context as hard constraints, so an agent
        starts out knowing where code lives and how work is done here. Resolution runs local
        override → project → global; the badge on each file says which one it came from.
      </p>

      {status && !status.enabled && (
        <p style={{ ...help, color: C.amberInk }} data-testid="steering-disabled">
          Steering is off for this project. Set <code>enabled = true</code> under{" "}
          <code>[steering]</code> in the project&apos;s <code>.sparkle/config.toml</code> to inject
          these files. You can still edit them here.
        </p>
      )}

      {loadError && (
        <p style={{ ...help, color: C.dangerInk }} role="alert">
          {loadError}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button type="button" style={btn} onClick={() => void onSeed()} disabled={busy}>
          <FiFileText size={12} aria-hidden />
          Create missing files from templates
        </button>
        <button type="button" style={btn} onClick={() => void load()}>
          <FiRefreshCw size={12} aria-hidden />
          Refresh
        </button>
      </div>
      {seedNote && (
        <p style={{ ...help, color: C.cream }} data-testid="steering-seed-note">
          {seedNote}
        </p>
      )}

      {status?.files.map((f) => (
        <FileEditor key={f.name} file={f} root={root} onSaved={() => void load()} />
      ))}

      {status && status.files.length === 0 && (
        <p style={help}>
          No steering files are configured. Add names to <code>[steering].files</code> in{" "}
          <code>.sparkle/config.toml</code>.
        </p>
      )}
    </div>
  );
}
