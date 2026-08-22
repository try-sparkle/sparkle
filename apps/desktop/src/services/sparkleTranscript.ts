// Make the Improve Sparkle agent READABLE when nothing is rendering it.
//
// THE GAP THIS CLOSES. The concierge's read chain (services/conciergeTools/terminal) has four tiers,
// and for the app-owned Sparkle agent three of them are usually empty at exactly the moment someone
// asks about it:
//
//   (a) scrollback       — needs a MOUNTED xterm. The hourly headless pass has no PTY at all, and
//                          the interactive pane is unmounted whenever the user is looking elsewhere.
//   (b) attention-screen — only written when the agent stops to ask something.
//   (c) history-search   — query-driven, and the FTS index is over message text, so it cannot list
//                          one agent's rows.
//   (d) transcript       — the last thing the agent SAID. Fed by a registry that only app code
//                          writes, and NOTHING wrote it for this agent.
//
// So a read returned `source: "none"` and the human copy-pasted the agent's analysis by hand. Tier
// (d) is the one that can work with no pane, because Claude Code writes the transcript to disk
// regardless of who is watching — it just needed someone to say where it is.
//
// WHY A WORKTREE AND NOT A FILE. This registered a resolved `<uuid>.jsonl` at first cut, and that was
// WRONG in a way the tests hid (roborev 55363): `build_improve_exec` passes no `--resume`, so every
// hourly pass starts a fresh session and writes a NEW transcript, while the registration happened
// before the spawn. The newest file at that instant is the PREVIOUS pass's, and nothing re-registered
// — so asked "what is Improve Sparkle doing?" mid-pass, the read confidently returned last hour's
// final message. Wrong conversation, not a stale view of the right one. Registering the DIRECTORY
// moves the choice of file to read time, where "newest" means the session actually being written.
//
// WHY A REGISTRATION AND NOT A LOOKUP FROM THE AGENT ID. The read path deliberately refuses to turn
// an agent id into a filesystem path: its options interface is a TOOL ARGUMENT SURFACE, and a
// caller-supplied `transcriptPath` was removed precisely because it made
// `read_transcript_last_assistant` an arbitrary-file read driven by a model. That constraint is intact
// here. The worktree is one the app itself created, the `<projects-root>/<slug>/` layout stays owned
// by Rust (`claude_latest_session_path`), and nothing a model says influences which file is opened.
//
// ── AND WHY THIS MODULE NOW ALSO BINDS A SESSION ID ──────────────────────────────────────────────
//
// The mounted-transcript pane keys its reads on `agentTranscriptRegistry`'s writer (3) — the set of
// Claude session ids known to be this agent's — and FAILS CLOSED when that set is unknown, because
// the fallback it would otherwise take ("the newest file in the directory") is the wrong-attribution
// bug it exists to fix. That is right, and it had one consequence nobody costed (roborev 63133 /
// 63135): writer (3)'s only production writer is `AgentPane`'s gated hook handler, and THE AGENT
// THIS MODULE IS ABOUT HAS NO `AgentPane`. `SparkleAgentPane` mirrors the pane and wires no hook
// handler; the hourly pass is headless, which is the entire reason this file exists. So
// `agentSessionIds(SPARKLE_AGENT_ID)` was permanently `undefined`, the fail-closed branch fired
// forever, and mounting the very agent in the founder's bug report rendered an EMPTY transcript —
// no reads, no tail, no error. The wrong-conversation defect had been fixed by switching the
// feature off for its primary target.
//
// So a pane-less agent needs a binding source that is not a hook event, and this module is it:
// `bindWorktreeSession` resolves the worktree's live session through Rust and records its STEM (the
// file stem IS the session id) as writer (3).
//
// ── THE SAFETY PROPERTY, STATED EXACTLY, BECAUSE IT IS WEAKER THAN A HOOK EVENT ──────────────────
//
// THIS IS NOT A READER FALLBACK AND MUST NEVER BECOME ONE. The reader still fails closed on an
// unknown binding; nothing here changes that. What this does is a deliberate, one-off WRITE by app
// code that already knows which worktree it created for which agent — the same knowledge writer (2)
// is built on, at writer (2)-grade evidence:
//
//   • It is scoped to worktrees the APP ITSELF CUT for ONE agent. Both callers are Sparkle's own
//     (`SparkleAgentPane.prepare()` and the hourly pass), and both cut that worktree for exactly
//     this agent id. It is deliberately NOT wired to `projectStore.setAgentWorktree`, which
//     registers a worktree for every build agent: those agents DO get a session-gated binding the
//     moment their pane mounts, so seeding them from a directory scan would trade real evidence for
//     a guess — the original bug, re-entered through the back door.
//   • It inherits writer (2)'s residual race, unchanged and no wider: a DIFFERENT `claude` invoked
//     with this same cwd writes into the same project dir and can hold the newest mtime. There is
//     no session gate to reject it. The exposure is bounded the same way — it requires something to
//     spawn its own `claude` in the app's own worktree, and the result is a session id added to a
//     set that is only ever consulted for THIS agent's own pane.
//   • It ACCUMULATES rather than replaces (writer (3)'s rule), which is what makes calling it
//     repeatedly correct rather than merely tolerable: every hourly pass opens a NEW session, so
//     each refresh adds this pass's id while the previous passes stay readable. A resolution that
//     lands on the previous pass's file is therefore not a wrong answer, just an incomplete one that
//     the next refresh completes.
//
// The authoritative binding for the headless pass is the session id Claude Code itself reports on
// the pass's own stream (`sparkle_improve:session` -> services/improvementPass) — the app spawned
// that process, so that id needs no directory scan at all. This resolution is the backstop for
// everything that is not mid-pass: a pane mounted between passes, and the first read after a
// restart.
import { invoke } from "@tauri-apps/api/core";

// THE LEAF REGISTRY, NOT the `conciergeTools/terminal` re-export it used to import. That module
// pulls in the terminal snapshot machinery, the dispatcher and the suggestion heuristics, and this
// module is now imported by a mount path (ConciergeHost) — see the registry's own header for the
// 16-file collection failure that edge caused the last time a writer dragged that graph along.
import {
  noteAgentConfigDir,
  noteAgentSessionId,
  noteAgentTranscriptWorktree,
} from "./agentTranscriptRegistry";

/**
 * Register `worktreePath` as where `agentId` runs, enabling tier (d) of the concierge's read chain,
 * and start resolving which Claude session in it is this agent's (writer (3), for the mounted pane).
 *
 * Synchronous and infallible on purpose. Both callers — the interactive pane's `prepare()` and the
 * hourly pass's startup — are on a spawn path that must not be delayed or failed for a read
 * convenience. The worktree half is effective the moment this returns, exactly as before; the
 * session-id half is fire-and-forget because it costs an IPC round trip and NOTHING depends on it
 * having landed. The mounted pane subscribes to the binding, so an id that arrives later re-pages
 * the pane on its own — the same self-healing path a hook-driven binding takes.
 *
 * A worktree Claude has never run in (the very first pass) simply resolves to nothing and leaves the
 * read reporting that it has nothing, exactly as before.
 */
export function registerSparkleTranscript(
  agentId: string,
  worktreePath: string,
  configDir?: string | null,
): void {
  noteAgentTranscriptWorktree(agentId, worktreePath);
  // WRITER (4) — RECORDED, not merely forwarded. `bindWorktreeSession` uses the config dir for its
  // own one-shot resolve and then it is gone, but the mounted pane's page and tail reads need it on
  // every read for the life of the mount, and they get it from the registry. This agent has no
  // `AgentPane` and therefore no hook events (see this module's header), so if the registration does
  // not record it, nothing else ever will: its pane would resolve a session id correctly and then
  // read for it in `$HOME/.claude`, where the file is not.
  noteAgentConfigDir(agentId, configDir);
  void bindWorktreeSession(agentId, worktreePath, configDir);
}

/**
 * Resolve the live Claude session in `worktreePath` and record it as one of `agentId`'s own.
 *
 * FOR APP-CUT, SINGLE-AGENT WORKTREES ONLY — read the safety block in this module's header before
 * adding a caller. Returns the session id it bound, or `null` when the worktree has no transcript
 * yet (the first-ever run) or the resolve failed. Never throws: a binding that cannot be established
 * leaves the reader in its fail-closed state, which is the correct degradation.
 *
 * IDEMPOTENT AND CHEAP TO REPEAT, which is what lets a mount call it every time: `noteAgentSessionId`
 * no-ops on an id it already holds, so a refresh that resolves the same session neither re-renders
 * the pane nor re-fetches its first page.
 */
export async function bindWorktreeSession(
  agentId: string,
  worktreePath: string,
  configDir?: string | null,
): Promise<string | null> {
  try {
    const path = await invoke<string | null>("claude_latest_session_path", {
      worktreePath,
      ...(configDir ? { configDir } : {}),
    });
    const id = sessionIdOf(path);
    if (!id) return null;
    noteAgentSessionId(agentId, id);
    return id;
  } catch {
    // Best-effort by contract. The command can be missing (a stale webview against a new binary) or
    // the directory unreadable; either way the pane stays in its honest empty state rather than
    // failing a spawn path for a read convenience.
    return null;
  }
}

/** The session id a Claude Code transcript path belongs to: its file STEM, since Claude names each
 *  session's log `<session-id>.jsonl`. Mirrors `transcript.rs`'s `session_id_of` — the stem is what
 *  the Rust filter matches file names against, so the two have to agree on it or the binding names a
 *  session the reader can never match.
 *
 *  REQUIRES the `.jsonl` extension rather than stripping whatever extension it finds. Anything else
 *  is not a transcript, and binding its name would put an id in the set that matches no file — an
 *  agent that reads as BOUND while rendering nothing, which is strictly worse than reading as
 *  unknown. Both separators are handled so a Windows-shaped path cannot bind a whole directory. */
function sessionIdOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = (path.split(/[/\\]/).pop() ?? "").trim();
  if (!/\.jsonl$/i.test(base)) return null;
  const stem = base.slice(0, -".jsonl".length).trim();
  return stem === "" ? null : stem;
}
