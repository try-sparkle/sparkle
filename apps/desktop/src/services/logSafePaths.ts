// Describe a batch of user file paths for the log WITHOUT writing the paths themselves.
//
// The persistent log is not a private artifact: SupportModal ships a tail of it with every
// ticket, and the crash pipeline attaches one for consenting users. `redact_secrets`
// (src-tauri/src/support.rs) deliberately redacts by SHAPE — keys, bearers, tokens — and says so:
// it removes secrets, not general PII. A filesystem path is neither key- nor token-shaped, so
// anything we log verbatim leaves the device verbatim. An absolute path is about as identifying
// as a log line gets: it carries the account name in `/Users/<name>/…`, plus the file's own name,
// which is routinely a client, project, or screenshot title.
//
// So the drop paths never enter the log at all. What a debugger actually needs from an
// attachment drop is "how many, and what kind" — enough to correlate the drop with the
// attachment tiles that did or didn't appear. That is what this returns.

/** Longest run after the final `.` we'll still treat as a file extension. Past this the "extension"
 *  is really part of a name (`report.2026-07-21-final`), which is exactly the identifying text we
 *  are trying not to write down. */
const MAX_EXT_LEN = 12;

/** The file kind of one path: its lowercased extension, or `"none"` when it doesn't have one we
 *  can safely name. Deliberately narrow — letters and digits only, so a "kind" can never carry a
 *  date, a version string, or any other free-form fragment of the user's filename. */
export function pathKind(path: string): string {
  const name = path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  // `dot <= 0` covers both "no dot" and a leading-dot dotfile (`.env`), whose name is not an
  // extension and is itself identifying.
  if (dot <= 0) return "none";
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext.length === 0 || ext.length > MAX_EXT_LEN || !/^[a-z0-9]+$/.test(ext)) return "none";
  return ext;
}

/** A log-safe summary of a batch of dropped paths: how many, and a count per file kind
 *  (`{ count: 3, kinds: { png: 2, pdf: 1 } }`). Carries no path, no filename, no account name. */
export function describePaths(paths: string[]): { count: number; kinds: Record<string, number> } {
  const kinds: Record<string, number> = {};
  for (const p of paths) {
    const k = pathKind(p);
    kinds[k] = (kinds[k] ?? 0) + 1;
  }
  return { count: paths.length, kinds };
}

const PATH_PLACEHOLDER = "«path»";

/** Strip filesystem paths out of an error MESSAGE so the reason stays loggable while the path
 *  doesn't. Not redundant with `describePaths`: the failure text comes back from Rust, and
 *  `load_attachment`'s messages interpolate the path we handed it (`cannot access <path>: …`,
 *  `stat <path>: …`, `refusing to read a path outside allowed directories: <path>`). Logging the
 *  raw rejection would put back exactly what the caller just took out.
 *
 *  `known` are paths the caller already has in hand — substring-replaced, so they're removed
 *  exactly, spaces in the filename and all (a regex can't delimit `…/Acme Corp/Q3 revenue.xlsx`).
 *  The regex pass afterwards is the backstop that keeps the invariant from depending on message
 *  shapes this side of the IPC boundary can't see: a Rust-side wording change must not be able to
 *  reopen the leak silently. It only catches space-free absolute runs, which is why the literal
 *  pass comes first and does the real work. */
export function scrubPaths(text: string, ...known: string[]): string {
  let out = text;
  for (const p of known) {
    if (!p) continue;
    // Full path first. If it matched we're done with this one: the basename was inside it, and
    // sweeping the basename again would only find collisions in the reason text — an extensionless
    // file named `error` would turn the errno tail `(os error 2)` into `(os «path» 2)`, corrupting
    // the one thing this function exists to preserve. The basename pass is the fallback for a
    // message that names the file WITHOUT its directory, which is the only case it can help.
    const withoutPath = out.split(p).join(PATH_PLACEHOLDER);
    if (withoutPath !== out) {
      out = withoutPath;
      continue;
    }
    const base = p.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
    if (base) out = out.split(base).join(PATH_PLACEHOLDER);
  }
  // POSIX absolute runs (`/a/b`) and Windows drive-rooted runs (`C:\a\b`), anchored to start or
  // whitespace so an ordinary `and/or` in prose isn't mistaken for a path. A `:` ends a segment:
  // it is the delimiter these messages use before the reason (`stat <path>: <errno text>`), and
  // eating it would take the reason's leading punctuation with it. A path that genuinely contains
  // a colon is handled by the literal pass above, which runs first.
  out = out.replace(/(^|\s)\/(?:[^\s/:]+\/)+[^\s/:]*/g, `$1${PATH_PLACEHOLDER}`);
  out = out.replace(/(^|\s)[A-Za-z]:\\(?:[^\s\\:]+\\)*[^\s\\:]*/g, `$1${PATH_PLACEHOLDER}`);
  return out;
}
