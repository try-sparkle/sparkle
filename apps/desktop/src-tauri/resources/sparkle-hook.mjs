// Claude Code event emitter (): append one normalized JSON line per hook event to
// Sparkle's per-agent event log, so the app can derive agent status from Claude's own
// lifecycle instead of scraping its TUI. Invoked as `node sparkle-hook.mjs <log-path>` with
// the hook payload (including hook_event_name) on stdin. Registered for PreToolUse,
// PostToolUse, UserPromptSubmit, Notification, Stop, SessionEnd, … in the worktree's
// .claude/settings.local.json. Must NEVER block or slow Claude — it always exits 0 and
// swallows any logging error.
import { appendFileSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Messages older than this are not worth delivering. Mirrors `inbox.rs::MAX_AGE_MS`. */
const INBOX_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Cap on how many messages one turn boundary delivers, so a backlog cannot bury the agent. */
const INBOX_MAX_PER_DRAIN = 10;

/**
 * Pure: derive the Level 2 inbox paths from the event-log path we are already given.
 *
 * Deriving rather than taking another argv slot is deliberate — it means every ALREADY-INSTALLED
 * agent gains inbox delivery the moment this script is restaged, with no change to any worktree's
 * `.claude/settings.local.json` and no migration to get wrong. The log path is always
 * `<app_data>/hook-events/<agentId>.jsonl`, so `<app_data>` and the agent id both fall out of it.
 */
export function inboxPaths(logPath) {
  const agentId = basename(logPath, ".jsonl");
  const appData = dirname(dirname(logPath));
  const inbox = join(appData, "inbox");
  return {
    agentId,
    messages: join(inbox, `${agentId}.jsonl`),
    acks: join(inbox, `${agentId}.acks.jsonl`),
    claims: join(inbox, "claims", agentId),
  };
}

/**
 * Pure: parse a JSONL inbox and return the messages still worth delivering.
 * Malformed lines are skipped — a torn write must not make the whole inbox unreadable.
 */
export function pendingMessages(raw, now, isClaimed) {
  const out = [];
  for (const line of String(raw ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let m;
    try {
      m = JSON.parse(t);
    } catch {
      continue;
    }
    if (!m || typeof m.id !== "string" || typeof m.text !== "string") continue;
    if (typeof m.ts === "number" && now - m.ts > INBOX_MAX_AGE_MS) continue;
    if (isClaimed(m.id)) continue;
    out.push(m);
    if (out.length >= INBOX_MAX_PER_DRAIN) break;
  }
  return out;
}

/**
 * Pure: the text injected back into the agent at its turn boundary.
 *
 * THIS IS COPY THE AGENT WILL ACT ON, so it is held to the same bar as code. Two properties matter:
 * it states plainly which items need action before continuing and which are context only, and the
 * acknowledgement it asks for is a single append to a file under the app's own data dir — it never
 * asks the agent to touch its repo, its branch, or anything a half-followed instruction could
 * damage. An agent that ignores the ack instruction entirely loses nothing but the ack.
 */
export function draftDelivery(messages, acksPath, now) {
  const lines = [
    `Sparkle concierge — ${messages.length} message(s) queued for you, delivered now because you reached a turn boundary.`,
    "",
  ];
  messages.forEach((m, i) => {
    const sev = m.severity === "act" ? "ACT" : "FYI";
    lines.push(`[${i + 1}] (${sev}) ${m.text}`);
  });
  lines.push(
    "",
    "Anything marked ACT should be handled before you continue. FYI is context only — note it and carry on.",
    "",
    "Acknowledge each message by appending one line per id to:",
    `  ${acksPath}`,
    "For example:",
    ...messages.map(
      (m) => `  printf '%s\\n' '{"id":"${m.id}","ts":${now},"note":"read"}' >> '${acksPath}'`,
    ),
    "",
    "An unacknowledged message tells the concierge you are not reaching turn boundaries.",
  );
  return lines.join("\n");
}

/**
 * Claim a message for delivery. `wx` maps to O_CREAT|O_EXCL, which the kernel makes atomic — so
 * when this hook and the app's idle-delivery path race for the same message, exactly one wins.
 *
 * Claiming happens BEFORE we ask Claude to continue, and that ordering is the loop guard: the next
 * `Stop` finds the message already claimed, has nothing to deliver, and does not block again.
 */
function claim(claimsDir, id) {
  try {
    mkdirSync(claimsDir, { recursive: true });
    closeSync(openSync(join(claimsDir, id), "wx"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Drain the inbox at a turn boundary. Returns the text to inject, or "" when there is nothing to
 * deliver.
 *
 * Every failure path returns "" — a broken inbox must never stop an agent from finishing its turn.
 */
function drainInbox(logPath, now) {
  try {
    const paths = inboxPaths(logPath);
    let raw;
    try {
      raw = readFileSync(paths.messages, "utf8");
    } catch {
      return ""; // no inbox for this agent — by far the common case
    }
    const candidates = pendingMessages(raw, now, (id) => {
      try {
        readFileSync(join(paths.claims, id));
        return true;
      } catch {
        return false;
      }
    });
    const won = candidates.filter((m) => claim(paths.claims, m.id));
    if (won.length === 0) return "";
    return draftDelivery(won, paths.acks, now);
  } catch {
    return "";
  }
}

/** Pure: project Claude Code's hook stdin payload to the compact shape parseHookLine() reads
 *  (see src/engine/hookEvents.ts). `ts` is the wall-clock the emitter observed the event. */
export function normalize(payload, ts) {
  const p = payload && typeof payload === "object" ? payload : {};
  const out = { ts, event: typeof p.hook_event_name === "string" ? p.hook_event_name : "" };
  if (typeof p.tool_name === "string") out.tool = p.tool_name;
  if (typeof p.message === "string") out.message = p.message;
  if (typeof p.session_id === "string") out.session_id = p.session_id;
  // History capture (): UserPromptSubmit carries the user's `prompt`; Stop carries the
  // `transcript_path` of the session JSONL. Pass both through when present so the app can persist
  // prompts/responses to the searchable history store. Defensive: only string values survive.
  if (typeof p.prompt === "string") out.prompt = p.prompt;
  if (typeof p.transcript_path === "string") out.transcript_path = p.transcript_path;
  // SessionStart's `source` — one of startup|resume|clear|compact. WITHOUT THIS the app cannot tell
  // a human restarting an agent from Claude Code compacting it, and those demand opposite handling:
  // a restart means "forget what you knew", a compaction is EVIDENCE OF CONTEXT PRESSURE and must
  // not erase the pressure history that proves it (engine/agentThrash).
  if (typeof p.source === "string") out.source = p.source;
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
  const now = Date.now();
  const line = normalize(payload, now);
  if (!line.event) process.exit(0); // nothing meaningful to record
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    // O_APPEND keeps concurrent hook writes line-atomic, so events never interleave.
    appendFileSync(logPath, `${JSON.stringify(line)}\n`);
  } catch {
    // A logging failure must never surface to Claude — drop it.
  }

  // Level 2 delivery. `Stop` is the agent's natural turn boundary: it has finished a piece of work
  // and has not started the next, so injecting here costs nothing and interrupts nothing. Every
  // other event returns immediately.
  //
  // `decision: "block"` tells Claude Code not to end the turn and to continue with `reason` as
  // context. That is the whole mechanism — no PTY write, no keystroke injection, no race with
  // whatever the agent was doing, because by definition it is not doing anything right now.
  if (line.event === "Stop") {
    const delivery = drainInbox(logPath, now);
    if (delivery) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: delivery }));
    }
  }
  process.exit(0);
}

// Only run main() when executed as a script, not when imported by a test.
if (process.argv[1] && process.argv[1].endsWith("sparkle-hook.mjs")) main();
