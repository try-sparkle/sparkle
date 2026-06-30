// Frontend bridge to the headless Claude Code chat engine (src-tauri/src/claude_chat.rs).
// Powers the Think tab's chat surface: it talks to the user's OWN `claude` binary headlessly
// (NOT the Anthropic API), reusing their existing Claude Code auth exactly like the Build
// terminal — Sparkle never handles the auth token (bead ). Mirrors pty.ts's style.
//
// The Rust command streams three Tauri events keyed by the per-Think-agent `id`:
//   claude_chat:delta  {id, text}             — incremental assistant markdown
//   claude_chat:done   {id, sessionId, text}  — final text + session id (persist for --resume)
//   claude_chat:error  {id, message}          — failure / non-zero exit
// We listen for all three, filter by id, and hand the payloads to the supplied callbacks.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { checkClaude } from "../preflight";

export interface ClaudeChatDelta {
  id: string;
  text: string;
}
export interface ClaudeChatDone {
  id: string;
  sessionId: string;
  text: string;
}
export interface ClaudeChatError {
  id: string;
  message: string;
}

export interface SendClaudeChatOptions {
  /** Per-Think-agent id; the same id is echoed on every event so callbacks can filter. */
  id: string;
  /** The user's message for this turn. */
  prompt: string;
  /** Working dir — the project root, so CLAUDE.md/AGENTS.md + skills load like the terminal. */
  cwd: string;
  /** Absolute path to the user's claude binary, resolved via {@link resolveClaudePath}. */
  claudePath: string;
  /** Prior turn's session id → `claude --resume <sid>` for a continuous conversation. */
  resumeSessionId?: string;
  /** Incremental assistant text as it streams in. */
  onDelta: (text: string) => void;
  /** Final assistant text + the session id to persist for the next turn's resume. */
  onDone: (done: { sessionId: string; text: string }) => void;
  /** A failure message (spawn failure, non-zero exit, or stderr). */
  onError: (message: string) => void;
}

/** Send one Think turn to the user's headless Claude Code. Listeners are wired BEFORE the
 *  command is invoked so no early delta is missed. Resolves to a cleanup function that
 *  unsubscribes all three event listeners — call it when the turn is done or the UI unmounts.
 *  A synchronous invoke failure (bad cwd/path, spawn error) is routed to `onError` and the
 *  listeners are torn down so a half-wired turn can't leak. */
export async function sendClaudeChat(opts: SendClaudeChatOptions): Promise<() => void> {
  const unlistens: UnlistenFn[] = [];
  const cleanup = () => {
    for (const u of unlistens) u();
    unlistens.length = 0;
  };

  unlistens.push(
    await listen<ClaudeChatDelta>("claude_chat:delta", (ev) => {
      if (ev.payload.id === opts.id) opts.onDelta(ev.payload.text);
    }),
  );
  unlistens.push(
    await listen<ClaudeChatDone>("claude_chat:done", (ev) => {
      if (ev.payload.id === opts.id) {
        opts.onDone({ sessionId: ev.payload.sessionId, text: ev.payload.text });
      }
    }),
  );
  unlistens.push(
    await listen<ClaudeChatError>("claude_chat:error", (ev) => {
      if (ev.payload.id === opts.id) opts.onError(ev.payload.message);
    }),
  );

  try {
    await invoke("claude_chat_send", {
      id: opts.id,
      prompt: opts.prompt,
      cwd: opts.cwd,
      claudePath: opts.claudePath,
      resumeSessionId: opts.resumeSessionId ?? null,
    });
  } catch (e) {
    // The command spawned synchronously failed (validation/spawn). Surface it and tear the
    // half-wired listeners down — no done/error event will ever arrive for this turn.
    cleanup();
    opts.onError(toMessage(e));
  }

  return cleanup;
}

/** Cancel an in-flight Think turn, killing the headless `claude` child (claude_chat_cancel). */
export function cancelClaudeChat(id: string): Promise<void> {
  return invoke("claude_chat_cancel", { id });
}

/** Resolve the absolute path to the user's own `claude` binary via the existing preflight
 *  (`checkClaude` → `claude_preflight`). Throws if Claude Code isn't installed, so callers can
 *  show the connect/install prompt instead of spawning into a missing binary. */
export async function resolveClaudePath(): Promise<string> {
  const status = await checkClaude();
  if (!status.installed || !status.path) {
    throw new Error("Claude Code is not installed (the `claude` binary was not found)");
  }
  return status.path;
}

/** Best-effort extraction of a human-readable message from an unknown thrown value. */
function toMessage(e: unknown): string {
  if (typeof e === "string") return e;
  const m = (e as { message?: unknown })?.message;
  return typeof m === "string" ? m : String(e);
}
