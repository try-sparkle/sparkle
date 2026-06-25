// Claude Code PreToolUse guard: refuse any file-write whose resolved path escapes the agent's
// worktree. Invoked as `node worktree-guard.mjs <worktree-root>` with the tool payload on stdin.
//
// NOTE: this is a best-effort guardrail, NOT a security sandbox. It only inspects Edit/Write/
// NotebookEdit file paths — it does NOT constrain the Bash tool, which can write anywhere the
// user can. True isolation comes from the per-agent worktree+branch model; this hook just
// stops a well-behaved agent from accidentally editing outside its lane.
import { relative, sep, isAbsolute, dirname } from "node:path";
import { lstatSync, readlinkSync } from "node:fs";

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
