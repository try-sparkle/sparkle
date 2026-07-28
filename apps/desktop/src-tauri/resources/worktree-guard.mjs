// Claude Code PreToolUse guard: refuse any file-write whose resolved path escapes the agent's
// worktree. Invoked as `node worktree-guard.mjs <worktree-root>` with the tool payload on stdin.
//
// NOTE: this is a best-effort guardrail, NOT a security sandbox. Its file-path containment check
// only inspects Edit/Write/MultiEdit/NotebookEdit paths — it does NOT otherwise constrain the Bash
// tool, which can write anywhere the user can. True isolation comes from the per-agent worktree+branch
// model; this hook just stops a well-behaved agent from accidentally editing outside its lane.
//
// It ALSO carries one narrow Bash guard (sparkle-0ezz): it blocks a `security`-CLI invocation against
// the app's `ai.sparkle.desktop` keychain item. Workers auto-approve their own shell commands, so an
// agent shelling out to `security find-generic-password -s ai.sparkle.desktop` would pop a scary
// "security wants to use your confidential information" OS prompt at the user. The app never shells out
// (it reads that item in-process via keyring); only an agent does, so we stop the command from running.
import { relative, sep, isAbsolute, dirname } from "node:path";
import { lstatSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";

// Canonicalize `p` by resolving symlinks one path segment at a time — a from-scratch realpath
// that also tolerates not-yet-existing trailing segments (the file a Write is about to create).
// This is the load-bearing part of the containment check: without full canonicalization an agent
// escapes its worktree by creating a symlink inside it that points outward (e.g. `ln -s ~/.ssh
// evil` then writing `<worktree>/evil/authorized_keys`).
//
// Why hand-rolled instead of fs.realpathSync: realpathSync throws on a DANGLING symlink (a link
// whose target doesn't exist yet — the `ln -s ~/.ssh/authorized_keys evil` injection), so it
// can't be used for a pre-write check. But getting this right is subtle; the walk MUST:
//   - resolve `..` against the *symlink-resolved* parent, never collapse it lexically up front
//     (path.resolve would turn `link/../x` into `x` before noticing `link` is a symlink), and
//   - re-walk EVERY segment of a symlink's target, including the target's own intermediate
//     symlinks (`a -> b/c`, `b -> /outside`), not just chain on the final component.
// So we process a growable segment QUEUE: a symlink's target is spliced back to the FRONT of the
// queue, so each of its components is itself re-checked for symlink-ness. A not-yet-existing
// component is accepted literally (a new file/dir). Returns null if a symlink loop blows the hop
// cap, so the caller fails closed.
function realResolve(p) {
  const startAbs = isAbsolute(p) ? p : `${process.cwd()}${sep}${p}`;
  const queue = startAbs.split(sep).filter((s) => s.length > 0);
  let resolved = sep; // POSIX filesystem root
  let hops = 0;
  while (queue.length > 0) {
    const seg = queue.shift();
    if (seg === ".") continue;
    if (seg === "..") {
      resolved = dirname(resolved); // pop against the RESOLVED parent, never lexically
      continue;
    }
    const next = resolved === sep ? sep + seg : `${resolved}${sep}${seg}`;
    let st;
    try {
      st = lstatSync(next);
    } catch {
      resolved = next; // doesn't exist yet — a new file/dir; accept literally
      continue;
    }
    if (!st.isSymbolicLink()) {
      resolved = next;
      continue;
    }
    // `hops` is a whole-path budget on TOTAL symlink resolutions (not a per-component chain
    // limit). Exceeding it — a cycle, or a pathological symlink farm — returns null → fail closed.
    if (++hops > 256) return null;
    let target;
    try {
      target = readlinkSync(next);
    } catch {
      // The link was deleted/replaced between the lstat above and here (a TOCTOU race). Don't
      // throw — that would escape to main() and (since only exit 2 blocks) fail OPEN; return
      // null so the caller fails closed instead.
      return null;
    }
    if (isAbsolute(target)) resolved = sep; // absolute target: restart from root
    // else the target is relative to the link's directory, which is the current `resolved`.
    queue.unshift(...target.split(sep).filter((s) => s.length > 0));
  }
  return resolved;
}

/** True iff `target` is `root` or a descendant of it, with BOTH sides canonicalized through
 *  symlinks (and `.`/`..`) so no symlinked or `..`-laden path component can escape the worktree.
 *  Fails closed (returns false) if either path can't be resolved (symlink loop). */
export function isInside(root, target) {
  const r = realResolve(root);
  // Join root+target WITHOUT lexical `..` collapse (realResolve handles `..` against resolved
  // parents); an absolute target is used as-is.
  const t = realResolve(isAbsolute(target) ? target : `${root}${sep}${target}`);
  if (r === null || t === null) return false;
  const rel = relative(r, t);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

/** True iff `command` (a Bash tool's command string) shells out to the macOS `security` CLI against
 *  the app's generic-password keychain item. We require ALL THREE signals so we block the confidential
 *  `ai.sparkle.desktop` access without snagging unrelated commands: (a) the `security` binary is invoked
 *  as a command word (bare or via an absolute path, not merely the substring "security" inside another
 *  word like "security-review"); (b) a `*-generic-password` subcommand; (c) the `ai.sparkle.desktop`
 *  service name. Apple's OS dialog can't be suppressed, so the goal is to stop the command from running. */
export function blocksKeychainCommand(command) {
  if (typeof command !== "string") return false;
  // (a) `security` invoked as a command word: at a start/separator boundary, optionally path-prefixed
  // (e.g. `/usr/bin/security`), followed by whitespace or end — so "insecurity"/"security-scan" miss.
  const invokesSecurity = /(^|[\s;&|()`'"])([^\s;&|()`'"]*\/)?security(\s|$)/.test(command);
  if (!invokesSecurity) return false;
  // (b) any *-generic-password subcommand (find/add/delete/set-generic-password).
  const genericPassword = /generic-password/.test(command);
  // (c) targeting the app's keychain service.
  const appService = /ai\.sparkle\.desktop/.test(command);
  return genericPassword && appService;
}

/** True iff target resolves into one of the two NARROW append-only per-agent note dirs we allow
 *  writes to even though they live outside every worktree by design (item 1j):
 *    - $HOME/.claude/plans/                  plan files, and
 *    - $HOME/.claude/projects/<any>/memory/  per-agent cross-session memory.
 *  These are append-only NOTES, not code, so allowing them does not undermine the guard job of
 *  stopping an agent editing another agent code, and the header above already states this is
 *  "NOT a security sandbox". Both checks canonicalize through symlinks via the same
 *  realResolve/isInside machinery the containment check uses, so a symlink planted inside an
 *  allow-listed dir that points elsewhere does NOT tunnel a write out: the RESOLVED target simply
 *  will not be inside the allow-listed root. Kept deliberately narrow: ONLY these two dir classes,
 *  never all of ~/.claude/. Fails closed (false) on any unresolvable path. */
export function isAllowlistedNoteDir(homeDir, target) {
  if (typeof homeDir !== "string" || homeDir.length === 0) return false;
  if (typeof target !== "string" || target.length === 0) return false;
  const claudeRoot = `${homeDir}${sep}.claude`;
  // (1) Plan files: anywhere at/under $HOME/.claude/plans/ (reuse the symlink-safe isInside).
  if (isInside(`${claudeRoot}${sep}plans`, target)) return true;
  // (2) Per-agent memory: $HOME/.claude/projects/<anything>/memory/ and descendants. We cannot
  // express the <anything> wildcard through one isInside root, so canonicalize both the projects
  // root and the target, confirm the target is inside projects/, then require the resolved path to
  // be <projectId>/memory[/...]. Canonicalizing the target FIRST is what makes this symlink-safe:
  // an escaping symlink resolves OUT of projectsRoot and is rejected below.
  const projectsRoot = realResolve(`${claudeRoot}${sep}projects`);
  const t = realResolve(isAbsolute(target) ? target : `${process.cwd()}${sep}${target}`);
  if (projectsRoot === null || t === null) return false;
  const rel = relative(projectsRoot, t);
  if (rel === "" || rel.startsWith("..")) return false; // not inside projects/
  const parts = rel.split(sep);
  // parts[0] = the project id; the very next segment must be the memory dir itself.
  return parts.length >= 2 && parts[1] === "memory";
}

async function main() {
  const root = process.argv[2];
  if (!root) process.exit(0); // misconfigured guard must not block work
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const input = payload?.tool_input ?? {};
  // Keychain guard (sparkle-0ezz): a Bash command that runs the `security` CLI against the
  // ai.sparkle.desktop keychain item is refused outright — exit 2 blocks the tool call before it runs.
  if (blocksKeychainCommand(input.command)) {
    process.stderr.write(
      "Blocked: refusing to run the macOS `security` CLI against the ai.sparkle.desktop keychain. " +
        "Sparkle stores its desktop-token / trial-device-token there and reads them in-process via " +
        "keyring; shelling out to `security` triggers a scary OS confidential-information prompt and " +
        "is never necessary. Do not touch this keychain item.\n",
    );
    process.exit(2); // exit code 2 → Claude Code blocks the tool call
  }
  const target = input.file_path ?? input.notebook_path;
  if (!target) process.exit(0); // nothing path-like to guard
  // Fail CLOSED on any unexpected error: only exit code 2 blocks the tool, so an exception that
  // escaped here would let the write proceed (fail open). Treat "couldn't decide" as "block".
  let inside;
  try {
    inside = isInside(root, target);
  } catch {
    inside = false;
  }
  if (inside) process.exit(0);
  // Narrow allow-list (item 1j): permit writes to the two append-only per-agent note dirs that
  // live OUTSIDE every worktree by design (plan files and cross-session memory) so an agent can
  // record what it learned for the next agent. Safe because these are notes, not code, and
  // isAllowlistedNoteDir canonicalizes through symlinks (same fail-closed machinery as above).
  let allowedNoteDir = false;
  try {
    allowedNoteDir = isAllowlistedNoteDir(homedir(), target);
  } catch {
    allowedNoteDir = false;
  }
  if (allowedNoteDir) process.exit(0);
  process.stderr.write(
    `Blocked: ${target} is outside this agent's worktree (${root}). ` +
      `Edit only files inside your worktree.\n`,
  );
  process.exit(2); // exit code 2 → Claude Code blocks the tool call
}

// Only run main() when executed as a script, not when imported by a test.
// The top-level `.catch` is the real fail-closed backstop: ANY uncaught error anywhere in main()
// — a stdin stream error, a future code path, etc. — exits 2 (block) rather than escaping as an
// unhandled rejection (which exits 1, and since only exit 2 blocks the tool, would fail OPEN).
if (process.argv[1] && process.argv[1].endsWith("worktree-guard.mjs")) {
  main().catch(() => process.exit(2));
}
