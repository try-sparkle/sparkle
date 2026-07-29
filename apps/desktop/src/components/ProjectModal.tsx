import { useMemo, useState } from "react";
import { C, FONT_WEIGHT, MODAL_SHADOW, ON_BRAND_FILL, SCRIM } from "../theme/colors";
import { FONT_UI, RADIUS } from "../theme/scale";
import type { Project } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { moveProjectFolder } from "../services/worktree";
import { resolveDefaultBranch } from "../services/branchStatus";
import { killPty } from "../pty";
import { pickProjectFolder } from "../services/dialog";
import { ModalLayer } from "./ModalLayer";

function dirname(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i > 0 ? trimmed.slice(0, i) : "/";
}

/**
 * Rename / relocate a project. Renaming changes the folder name on disk; "Move to…" picks
 * a new parent folder. On save we stop the project's agents (their PTYs hold the old cwd),
 * move+rename the folder, repair the git worktrees, and update the store.
 */
export function ProjectModal({ project, onClose }: { project: Project; onClose: () => void }) {
  const relocateProject = useProjectStore((s) => s.relocateProject);
  const setDefaultBranch = useProjectStore((s) => s.setDefaultBranch);
  const closeAgent = useRuntimeStore((s) => s.close);
  const [name, setName] = useState(project.name);
  const [parent, setParent] = useState(dirname(project.rootPath));
  const [branch, setBranch] = useState(project.defaultBranch ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const newRootPath = useMemo(
    () => `${parent.replace(/[/\\]+$/, "")}/${name.trim()}`,
    [parent, name],
  );
  // A project name becomes the folder name on disk — reject path separators and . / ..
  // so it can't escape to an unintended location.
  const nameValid =
    name.trim().length > 0 && !/[/\\]/.test(name) && !/^\.\.?$/.test(name.trim());
  const changed = newRootPath !== project.rootPath && nameValid;

  const chooseLocation = async () => {
    const picked = await pickProjectFolder();
    if (picked) setParent(picked);
  };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      // Persist the integration branch: a typed value wins; cleared → re-auto-detect.
      const trimmed = branch.trim();
      if (trimmed) {
        setDefaultBranch(project.id, trimmed);
      } else if (project.defaultBranch) {
        setDefaultBranch(project.id, await resolveDefaultBranch(project.rootPath));
      }

      if (changed) {
        // Stop the project's agents (best effort) so no orphaned Claude keeps writing to the
        // old location. On macOS std::fs::rename moves the directory even while file handles
        // are open, so the move itself doesn't depend on this — no fixed delay needed.
        await Promise.all(project.agents.map((a) => killPty(a.id).catch(() => {})));
        for (const a of project.agents) closeAgent(a.id);
        await moveProjectFolder(project.rootPath, newRootPath);
        relocateProject(project.id, name, newRootPath);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // `zIndex: 100` is a ROOT-layer number and only behaves like one because ModalLayer portals this
  // out of whatever lifted ancestor rendered it — see ./ModalLayer for why the number alone is not
  // enough.
  return (
    <ModalLayer>
      <div
        data-testid="project-modal-backdrop"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: SCRIM,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: 520,
            maxWidth: "90vw",
            background: C.dialogSurface,
            border: `1px solid ${C.dialogEdge}`,
            borderRadius: RADIUS.modal,
            padding: 22,
            color: C.cream,
            fontFamily: FONT_UI,
            boxShadow: MODAL_SHADOW,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: FONT_WEIGHT.semibold, marginBottom: 16 }}>
            Project settings
          </div>

          <label style={{ display: "block", color: C.muted, fontSize: 12, marginBottom: 6 }}>
            Project name
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              width: "100%",
              background: C.forest,
              color: C.cream,
              border: `1px solid ${C.muted}`,
              borderRadius: RADIUS.input,
              padding: "9px 11px",
              fontSize: 13,
              outline: "none",
              marginBottom: 16,
            }}
          />

          <label style={{ display: "block", color: C.muted, fontSize: 12, marginBottom: 6 }}>
            Lives in
          </label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
            <div
              title={parent}
              style={{
                flex: 1,
                background: C.forest,
                borderRadius: RADIUS.input,
                padding: "9px 11px",
                fontSize: 13,
                color: C.cream,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {parent}
            </div>
            <button
              onClick={() => void chooseLocation()}
              style={{
                background: "transparent",
                color: C.accentInk,
                border: `1px solid ${C.muted}`,
                borderRadius: RADIUS.input,
                padding: "8px 12px",
                cursor: "pointer",
                fontSize: 13,
                whiteSpace: "nowrap",
              }}
            >
              Move to…
            </button>
          </div>
          <div style={{ color: C.muted, fontSize: 12, marginBottom: 18 }}>
            {nameValid ? (
              <>
                Full path: <span style={{ color: C.cream }}>{newRootPath}</span>
                {changed && <span> · renaming/moving the folder on disk</span>}
              </>
            ) : (
              <span style={{ color: C.sienna }}>
                Name can't contain “/”, “\”, or be “.”/“..”.
              </span>
            )}
          </div>

          <label style={{ display: "block", color: C.muted, fontSize: 12, marginBottom: 6 }}>
            Integration branch
          </label>
          <input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="auto-detected (main)"
            style={{
              width: "100%",
              background: C.forest,
              color: C.cream,
              border: `1px solid ${C.muted}`,
              borderRadius: RADIUS.input,
              padding: "9px 11px",
              fontSize: 13,
              outline: "none",
              marginBottom: 6,
              boxSizing: "border-box",
            }}
          />
          <div style={{ color: C.muted, fontSize: 12, marginBottom: 18 }}>
            New agents are branched from this. Leave blank to auto-detect.
          </div>

          {error && (
            <div style={{ color: C.sienna, fontSize: 13, marginBottom: 14 }}>{error}</div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              onClick={onClose}
              disabled={busy}
              style={{
                background: "transparent",
                color: C.muted,
                border: `1px solid ${C.muted}`,
                borderRadius: RADIUS.input,
                padding: "9px 16px",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={busy || !nameValid}
              style={{
                background: C.teal,
                color: ON_BRAND_FILL,
                border: "none",
                borderRadius: RADIUS.input,
                padding: "9px 18px",
                fontWeight: FONT_WEIGHT.semibold,
                cursor: busy ? "wait" : !nameValid ? "not-allowed" : "pointer",
                opacity: !nameValid ? 0.6 : 1,
              }}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </ModalLayer>
  );
}
