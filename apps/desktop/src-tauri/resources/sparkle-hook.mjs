// Claude Code event emitter (): append one normalized JSON line per hook event to
// Sparkle's per-agent event log, so the app can derive agent status from Claude's own
// lifecycle instead of scraping its TUI. Invoked as `node sparkle-hook.mjs <log-path>` with
// the hook payload (including hook_event_name) on stdin. Registered for PreToolUse,
// PostToolUse, UserPromptSubmit, Notification, Stop, SessionEnd, … in the worktree's
// .claude/settings.local.json. Must NEVER block or slow Claude — it always exits 0 and
// swallows any logging error.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Pure: project Claude Code's hook stdin payload to the compact shape parseHookLine() reads
 *  (see src/engine/hookEvents.ts). `ts` is the wall-clock the emitter observed the event. */
export function normalize(payload, ts) {
  const p = payload && typeof payload === "object" ? payload : {};
  const out = { ts, event: typeof p.hook_event_name === "string" ? p.hook_event_name : "" };
  if (typeof p.tool_name === "string") out.tool = p.tool_name;
  if (typeof p.message === "string") out.message = p.message;
  if (typeof p.session_id === "string") out.session_id = p.session_id;
  return out;
}

async function main() {
  const logPath = process.argv[2];
  if (!logPath) process.exit(0); // misconfigured emitter must not block work
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const line = normalize(payload, Date.now());
  if (!line.event) process.exit(0); // nothing meaningful to record
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    // O_APPEND keeps concurrent hook writes line-atomic, so events never interleave.
    appendFileSync(logPath, `${JSON.stringify(line)}\n`);
  } catch {
    // A logging failure must never surface to Claude — drop it.
  }
  process.exit(0);
}

// Only run main() when executed as a script, not when imported by a test.
if (process.argv[1] && process.argv[1].endsWith("sparkle-hook.mjs")) main();
