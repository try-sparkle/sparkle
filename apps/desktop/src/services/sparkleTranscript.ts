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
// WHY A REGISTRATION AND NOT A LOOKUP INSIDE THE READ. The read path deliberately refuses to turn an
// agent id into a filesystem path: its options interface is a TOOL ARGUMENT SURFACE, and a
// caller-supplied `transcriptPath` was removed precisely because it made `read_transcript_last_assistant`
// an arbitrary-file read driven by a model. That constraint is intact here. The path is resolved in
// APP CODE, from a worktree the app itself created, by a Rust command that owns the
// `<projects-root>/<slug>/` layout — no id-to-path guessing anywhere, and nothing a model says
// influences which file is opened.
import { claudeLatestSessionPath } from "../preflight";
import { noteAgentTranscriptPath } from "./conciergeTools/terminal";
import { log } from "../logger";

/**
 * Resolve the newest transcript for `worktreePath` and register it as `agentId`'s, enabling tier (d).
 *
 * BEST-EFFORT BY CONSTRUCTION, and every caller is on a hot path that must not fail for this: the
 * interactive pane's `prepare()` and the hourly pass's startup. A missing transcript (the very first
 * run, before Claude has written one) is the normal case, not an error — the read simply keeps
 * reporting that it has nothing, exactly as it did before.
 *
 * Re-resolved on every call rather than cached. A worktree accrues one transcript per session — a
 * fresh start, and each `--resume` — so the newest file changes over the agent's life, and a path
 * pinned at first launch would quietly serve a stale conversation forever. The registry is
 * last-write-wins, which is what makes re-registering the correction rather than a duplicate.
 */
export async function registerSparkleTranscript(
  agentId: string,
  worktreePath: string,
): Promise<string | null> {
  try {
    const path = await claudeLatestSessionPath(worktreePath);
    if (!path) return null;
    noteAgentTranscriptPath(agentId, path);
    // No path in the log line: this runs for the app-owned worktree, but the helper is generic and a
    // path is the one field here that could carry user content if it is ever pointed elsewhere.
    log.debug("concierge", "registered a transcript for reading", { agentId });
    return path;
  } catch (e) {
    log.debug("concierge", "could not resolve a transcript to register", {
      agentId,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
