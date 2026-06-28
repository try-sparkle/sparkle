// Pure helpers for a window's entry URL / params. Window labels are OPAQUE and decoupled from
// the project id (a window's project can change via "Replace", and a label can't), so the
// project↔window lookup goes through the registry, not the label. Kept free of any Tauri import
// so they unit-test without a webview.

/** Entry URL for a new project window — carries the initial project, the window's own opaque
 *  label, and (optionally) the agent to deep-link to on mount, so the app can read them
 *  synchronously when it boots. */
export function projectWindowUrl(projectId: string, label: string, agentId?: string): string {
  const params: Record<string, string> = { project: projectId, label };
  if (agentId) params.agent = agentId;
  const qs = new URLSearchParams(params);
  return `index.html?${qs.toString()}`;
}

/** Extract the project id a window was opened for, or null. */
export function parseProjectIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("project");
  return id && id.trim() ? id : null;
}

/** Extract the agent id a window should deep-link to on open (history-search "jump to agent"
 *  into a fresh window), or null. */
export function parseAgentIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("agent");
  return id && id.trim() ? id : null;
}

/** Extract the window's own opaque label, or null for the initial ("main") window. */
export function parseWindowLabelFromSearch(search: string): string | null {
  const label = new URLSearchParams(search).get("label");
  return label && label.trim() ? label : null;
}

/** Pure window-startup decision: which project should this window show?
 *  The `?project=` param (secondary windows) wins; otherwise (the initial "main"
 *  window) fall back to the restore hint. Kept pure so it unit-tests in node. */
export function computeInitialProjectId(
  search: string,
  hint: { selectedProjectId: string | null; firstProjectId: string | null },
): string | null {
  const param = parseProjectIdFromSearch(search);
  if (param) return param;
  return hint.selectedProjectId ?? hint.firstProjectId ?? null;
}
