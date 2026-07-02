// Records this window's project as the last-focused one (localStorage, spec §3 cross-worker
// contract) so the capture modal's project switcher defaults to wherever the user was working.
// Every project-bearing window renders this — the main window's context project IS its active
// project, so no special-casing. MUST render inside CurrentProjectProvider (same constraint as
// RosterPublisher in App.tsx). Paints no UI.
import { useEffect } from "react";
import { useCurrentProjectId } from "../windowContext";
import { writeLastFocusedProject } from "./lastFocusedProject";

export function LastFocusedProjectTracker() {
  const projectId = useCurrentProjectId();
  useEffect(() => {
    if (!projectId) return;
    const write = () => writeLastFocusedProject(projectId);
    // The window is usually already focused when its project mounts/changes (picking a project
    // IS an interaction with this window) — record that immediately, then follow OS focus. The
    // DOM `focus` event fires on the webview whenever its OS window becomes key.
    if (document.hasFocus()) write();
    window.addEventListener("focus", write);
    return () => window.removeEventListener("focus", write);
  }, [projectId]);
  return null;
}
