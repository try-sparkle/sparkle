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
import { noteAgentTranscriptWorktree } from "./conciergeTools/terminal";

/**
 * Register `worktreePath` as where `agentId` runs, enabling tier (d) of the concierge's read chain.
 *
 * Synchronous and infallible on purpose. Both callers — the interactive pane's `prepare()` and the
 * hourly pass's startup — are on a spawn path that must not be delayed or failed for a read
 * convenience, and there is no longer anything to await: resolving which file to read is tier (d)'s
 * job now, not this one's. A worktree Claude has never run in (the very first pass) simply leaves the
 * read reporting that it has nothing, exactly as before.
 */
export function registerSparkleTranscript(agentId: string, worktreePath: string): void {
  noteAgentTranscriptWorktree(agentId, worktreePath);
}
