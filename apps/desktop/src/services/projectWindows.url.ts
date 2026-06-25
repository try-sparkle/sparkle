// Pure helpers for a window's entry URL / params. Window labels are OPAQUE and decoupled from
// the project id (a window's project can change via "Replace", and a label can't), so the
// project↔window lookup goes through the registry, not the label. Kept free of any Tauri import
// so they unit-test without a webview.

/** Entry URL for a new project window — carries both the initial project and the window's own
 *  opaque label so the app can read them synchronously on mount. */
export function projectWindowUrl(projectId: string, label: string): string {
  const qs = new URLSearchParams({ project: projectId, label });
  return `index.html?${qs.toString()}`;
}

/** Extract the project id a window was opened for, or null. */
export function parseProjectIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("project");
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
