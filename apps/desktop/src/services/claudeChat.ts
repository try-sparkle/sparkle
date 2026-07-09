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
import { safeUnlisten } from "./safeUnlisten";

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
    // Route each unlisten through safeUnlisten: on a rapid unmount / window close the caller can
    // fire this AFTER Tauri has torn down its internal listeners map, and a bare `u()` then throws
    // the "handlerId" teardown race as an UNHANDLED rejection (ThinkPanel calls cleanup directly
    // from effect teardown and Stop handlers, so it surfaces app-level). safeUnlisten swallows only
    // that benign race; fire-and-forget keeps this a synchronous `() => void`.
    for (const u of unlistens) void safeUnlisten(u);
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

/** How a failed Claude Code turn should be presented to a Think-tab user. */
export type ClaudeErrorKind = "auth" | "usageLimit" | "other";

export interface ClassifiedClaudeError {
  kind: ClaudeErrorKind;
  /** The message to show. For `auth`/`usageLimit` it's already humanized for a Sparkle user; for
   *  `other` it's the raw text (claude's own diagnostics) unchanged. */
  message: string;
  /** True only for `auth`: the user must (re)sign-in to Claude Code, so the caller shows the
   *  inline "Reconnect Claude Code" affordance. */
  needsLogin: boolean;
}

// Claude Code's own auth failures. The Think tab runs the user's OWN `claude` binary under THEIR
// login (Sparkle never holds the token), so "Not logged in · Please run /login" et al. mean the
// user's Claude Code sign-in is missing/expired — NOT that Sparkle is out of credits. The remedy
// is to reconnect Claude Code, so we translate the raw CLI text (which tells them to run `/login`,
// a terminal command with no home in the Think tab) into a Sparkle-native message + a reconnect
// button. Kept broad but specific: real Claude auth-error phrasings, not generic words like "token".
const CLAUDE_AUTH_RE =
  /\bnot logged in\b|please run \/login|please log ?in|\blog in to claude\b|invalid api key|invalid x-api-key|authentication_error|authentication failed|\bunauthorized\b|oauth[^.]*expired|credentials?[^.]*(expired|invalid|missing)|no api key|missing api key/i;

// Claude subscription/usage-limit exhaustion — the closest thing to "out of credits" on the Claude
// side. Claude's own text carries the reset time ("Claude usage limit reached. Your limit resets at
// 5:00pm."), so we surface it VERBATIM rather than replacing it; only the classification changes.
// Bare numeric HTTP codes are intentionally NOT matched (a stray "401"/"429" in unrelated
// diagnostics — "Processed 429 items" — must not trip these); we key on the named phrasings instead.
const CLAUDE_USAGE_RE = /usage limit|rate limit|too many requests|\bquota\b|usage cap|credit balance (is )?too low/i;

/**
 * Classify a raw Claude Code failure message (as delivered on `claude_chat:error` or a thrown
 * spawn error) into a Sparkle-user-facing presentation. Pure so it can be unit-tested and reused.
 *
 *  - `auth`       → the user's Claude Code sign-in is missing/expired. We show a clear reconnect
 *                   message and flag `needsLogin` so the caller renders the reconnect affordance.
 *  - `usageLimit` → Claude's usage limit was hit. We keep claude's OWN text (it has the reset time).
 *  - `other`      → anything else: surface the raw diagnostics unchanged (the historical behavior).
 */
export function classifyClaudeChatError(raw: string): ClassifiedClaudeError {
  const text = (raw ?? "").trim();
  if (CLAUDE_AUTH_RE.test(text)) {
    return {
      kind: "auth",
      message:
        "Your Claude Code sign-in isn't active (Sparkle runs Claude under your own login and never sees your credentials). Reconnect Claude Code to keep thinking.",
      needsLogin: true,
    };
  }
  if (CLAUDE_USAGE_RE.test(text)) {
    // Keep claude's own message when it said something (it carries the reset time); otherwise a
    // clean fallback so the user still learns the real reason.
    return {
      kind: "usageLimit",
      message: text || "Claude usage limit reached. Please try again later.",
      needsLogin: false,
    };
  }
  return { kind: "other", message: text, needsLogin: false };
}
