// Vault item TITLES — the identity that pairs a file on disk with its 1Password item.
//
// A LEAF module on purpose. Both the drift engine (`engine/envBackup.ts`) and the IPC boundary
// (`services/onepassword.ts`) have to derive titles the same way, and if either imported the other
// for it there would be an import cycle waiting to happen: the engine keeps its edge to the IPC
// module type-only so it stays runnable without the Tauri runtime, and a value edge back the other
// way would become a real cycle the moment anyone added a value import in the other direction —
// surfacing as `normalizeProjectName === undefined` at module-init under one resolution order,
// i.e. a silently unnormalized name that seeds nothing. Nothing is imported here, so neither
// direction can ever cycle.

/** Replace every backslash with a forward slash and collapse runs of slashes.
 *  Windows-style separators can reach us through a project root typed by hand; the vault title
 *  must be one canonical string or the same file backs up twice under two titles. */
export function toPosix(segment: string): string {
  return segment.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/** Normalize a project-relative path for use in a title: POSIX separators, no `./` prefix, no
 *  leading or trailing slash. `.env.local`, `./.env.local` and `/.env.local` are the same file.
 *
 *  `.` segments are dropped. A `..` segment makes the path UNUSABLE and yields `""` — see
 *  {@link isTraversal}. */
export function normalizeRelPath(relPath: string): string {
  let p = toPosix(relPath.trim());
  while (p.startsWith("./")) p = p.slice(2);
  p = p.replace(/^\/+/, "").replace(/\/+$/, "");
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((s) => s === "..")) return "";
  return parts.join("/");
}

/** Whether a title's path component tries to escape its project directory.
 *
 *  Vault item titles are free text a human can rename inside 1Password, and per the contract
 *  `op_seed_worktree` recreates the layout a title encodes UNDER a destination root — so a title
 *  like `proj/../../../.ssh/config` is a request to write a secret outside the worktree. The Rust
 *  side independently rejects any non-normal path component, but this module declares itself the
 *  single place titles are derived and parsed, so the guard belongs here too rather than being
 *  assumed elsewhere: two independent checks, neither relying on the other. */
export function isTraversal(relPath: string): boolean {
  return toPosix(relPath)
    .split("/")
    .some((s) => s === "..");
}

/** Sanitize a project name for use as the FIRST segment of a title.
 *
 *  DELIBERATE CHOICE — a slash in the project name is replaced with `-`, not preserved.
 *  The title is a structured key, not free text: everything before the first `/` is the project and
 *  everything after is the path within it. `op_seed_worktree` relies on exactly that split to
 *  recreate the relative layout under a fresh worktree root, so a project literally named
 *  `acme/web` would make `acme/web/.env.local` ambiguous — is it project `acme` holding
 *  `web/.env.local`, or project `acme/web` holding `.env.local`? Both readings are plausible and
 *  the wrong one restores the file to the wrong place. Flattening to `acme-web` keeps the split
 *  unambiguous and keeps the title stable across backups, which is all identity has to do here.
 *  The cost is a collision if two projects differ only by `/` vs `-`; that is far rarer, and far
 *  less destructive, than restoring a secret into the wrong directory.
 *
 *  Leading/trailing whitespace is trimmed for the same reason: a title is compared by exact string
 *  on both sides, so invisible drift in the name would silently orphan a backup. */
export function normalizeProjectName(projectName: string): string {
  return toPosix(projectName.trim()).replace(/\//g, "-");
}

/** The vault item title for a file: `<projectName>/<relPath>`, e.g. `sparkle/apps/web/.env.local`.
 *
 *  This is the stable identity that pairs an on-disk file with its 1Password item across backups —
 *  it must be derived the same way every time, from the same two inputs, which is why nothing else
 *  in the feature is allowed to build a title by hand. */
export function backupTitle(projectName: string, relPath: string): string {
  return `${normalizeProjectName(projectName)}/${normalizeRelPath(relPath)}`;
}

/** Split a title back into its project name and relative path. The inverse of {@link backupTitle}
 *  for titles Sparkle wrote — used for vault records whose local file we never saw, where the
 *  title is the ONLY thing we know about them. A title with no `/` (hand-edited in 1Password) is
 *  read as a project with an empty path rather than being dropped, so it still shows up. */
export function parseBackupTitle(title: string): { projectName: string; relPath: string } {
  const t = toPosix(title.trim());
  const slash = t.indexOf("/");
  if (slash === -1) return { projectName: t, relPath: "" };
  return { projectName: t.slice(0, slash), relPath: t.slice(slash + 1) };
}

