import { useMemo, useState } from "react";
import { C, FONT_WEIGHT } from "../theme/colors";
import type { Project } from "../types";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { moveProjectFolder } from "../services/worktree";
import { resolveDefaultBranch } from "../services/branchStatus";
import { killPty } from "../pty";
import { pickProjectFolder } from "../services/dialog";

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

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
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
          background: C.deepForest,
          border: `1px solid ${C.forest}`,
          borderRadius: 12,
          padding: 22,
          color: C.cream,
          fontFamily: '"IBM Plex Sans", sans-serif',
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ fontSize: 16, fontWeight: FONT_WEIGHT.semibold, marginBottom: 16 }}>
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
            borderRadius: 8,
            padding: "9px 11px",
            fontSize: 14,
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
              borderRadius: 8,
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
              borderRadius: 8,
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
            borderRadius: 8,
            padding: "9px 11px",
            fontSize: 14,
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
              borderRadius: 8,
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
              color: C.cream,
              border: "none",
              borderRadius: 8,
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
  );
}
