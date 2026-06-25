// Pure decision for "the user picked a folder — which project does it map to?". Returns a
// descriptor (not a created project) so the caller defers persisting a NEW project until the
// user actually commits an open target — cancelling must not leave an orphan in Recent.
// No Tauri import → unit-testable in node.

export type OpenTarget =
  | { kind: "existing"; id: string }
  | { kind: "new"; name: string; path: string };

/** Drop a trailing separator and NFC-normalize so the same folder compares equal regardless of
 *  how the picker returned it. */
export function normalizeProjectPath(p: string): string {
  return p.replace(/[/\\]+$/, "").normalize("NFC");
}

/**
 * Map a freshly-picked folder to an existing project (reuse) or a not-yet-created one. Dedup is
 * case-folded for the default case-insensitive macOS volume. `basename` is injected to keep this
 * free of the Tauri-importing dialog module.
 */
export function resolveOpenTarget(
  pickedPath: string,
  projects: ReadonlyArray<{ id: string; rootPath: string }>,
  basename: (p: string) => string,
): OpenTarget {
  const norm = normalizeProjectPath(pickedPath);
  const key = norm.toLowerCase();
  const existing = projects.find((p) => normalizeProjectPath(p.rootPath).toLowerCase() === key);
  return existing
    ? { kind: "existing", id: existing.id }
    : { kind: "new", name: basename(norm), path: norm };
}
