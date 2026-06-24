// Claude Code PreToolUse guard: refuse any file-write whose resolved path escapes the agent's
// worktree. Invoked as `node worktree-guard.mjs <worktree-root>` with the tool payload on stdin.
import { resolve, relative, sep } from "node:path";

/** True iff `target` is `root` or a descendant of it, after normalizing `.`/`..`. */
export function isInside(root, target) {
  const r = resolve(root);
  const t = resolve(root, target); // resolve target relative to root, collapsing ../
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
  if (isInside(root, target)) process.exit(0);
  process.stderr.write(
    `Blocked: ${target} is outside this agent's worktree (${root}). ` +
      `Edit only files inside your worktree.\n`,
  );
  process.exit(2); // exit code 2 → Claude Code blocks the tool call
}

// Only run main() when executed as a script, not when imported by a test.
if (process.argv[1] && process.argv[1].endsWith("worktree-guard.mjs")) main();
