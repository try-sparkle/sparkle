// subagentTranscripts — WHERE AN ORPHANED SUBAGENT'S PARTIAL WORK ACTUALLY SURVIVED ON DISK.
//
// ── THE BUG THIS EXISTS FOR (bead sparkle-y5dk8x, the half PR #2613 left open) ─────────────────────
// A build agent's session exited mid-task three times; each time every background research SUBAGENT
// it had dispatched died with the parent and produced nothing. Eight across two batches were lost,
// and every finding was re-derived by hand. `orphanedSubagentRegistry` (PR #2613) closed the bead's
// "at minimum" ask — the mid-task-exit notice now NAMES how many were orphaned. What it could not do
// is give the parent back the work, and the work is not gone: Claude Code writes each subagent's
// transcript to its own file, incrementally, while the subagent is still running. This module is the
// address of that file.
//
// ── THE PREVIOUS NOTICE POINTED AT THE WRONG FILE, AND THAT IS THE DEFECT THIS FIXES ──────────────
// PR #2613's copy said the partial work was recoverable "from this agent's own session transcript,
// where the subagents' turns were interleaved (`isSidechain` records) before the exit". MEASURED ON
// DISK, that is false: across 120 recent parent session transcripts there are ZERO `isSidechain:true`
// records — every `isSidechain` field in a PARENT file is `false`. A subagent's turns are never
// interleaved into its parent's transcript. They are written to a SEPARATE file, in a `subagents/`
// directory beside the parent's own transcript.
//
// That distinction is the whole value of the notice. AGENTS.md states the rule it broke: "A refusal
// or remedy message is an instruction the user will follow." A remedy naming a file where the work
// demonstrably is not sends the reader to an empty search and costs exactly the re-derivation the
// bead was filed about — worse than silence, because it looks like an answer.
//
// ── THE LAYOUT, MEASURED ACROSS 128 SESSIONS ──────────────────────────────────────────────────────
//   <claude-config>/projects/<project-slug>/<sessionId>.jsonl          ← the PARENT's own transcript
//   <claude-config>/projects/<project-slug>/<sessionId>/subagents/
//       agent-<subagentId>.jsonl        ← the subagent's OWN transcript (`isSidechain:true` records)
//       agent-<subagentId>.meta.json    ← {agentType, description, toolUseId, spawnDepth}
//
// So the directory is the parent transcript path with its `.jsonl` suffix replaced by `/subagents`.
// That derivation is the only thing this module does, and it is why the module is pure: given the
// parent path this window already holds (`agentTranscriptRegistry.agentTranscriptPath`, writer 1 —
// the session-gated EXACT file), the orphans' partial work needs no lookup at all.
//
// ── IS THE PARTIAL TRANSCRIPT REALLY THERE MID-FLIGHT? MEASURED: YES ──────────────────────────────
// The premise had to be checked rather than assumed, because a reader for a file that is empty when
// it matters is worth less than nothing. Polled while a dispatched subagent was still running and had
// reported NOTHING to its parent, its `agent-<id>.jsonl` already held 187,424 bytes across 16 JSONL
// records. The file is appended turn by turn, not flushed on completion. A subagent killed at that
// instant leaves all 16 records behind.
//
// ── WHY A PATH AND NOT AN EXCERPT (the deliberate scope line) ─────────────────────────────────────
// The notice's recipient is the CONCIERGE (`conciergeNotifier`), a `claude -p` child with its own
// tools — so a precise path plus a bounded read command is something it can act on directly, and the
// content arrives on demand rather than being copied through a notification string. Quoting an
// excerpt into the notice would also need the renderer to read an arbitrary file, and the desktop app
// ships no filesystem plugin (`@tauri-apps/plugin-fs` is not a dependency) and no general read
// command; the existing `agent_transcript_*` commands resolve only a session file directly inside the
// project directory, never a `subagents/` child. An excerpt is therefore a Rust change, and a
// separate one — see the PRD.
//
// PURE: string derivation only. No clock, no I/O, no registry. One function, one predicate.

/** The filename shape of a single subagent's transcript inside {@link subagentTranscriptDirFor}. */
export const SUBAGENT_TRANSCRIPT_GLOB = "agent-*.jsonl";

/** The `.jsonl` suffix a parent session transcript must carry for the derivation to be sound. */
const PARENT_TRANSCRIPT_SUFFIX = ".jsonl";

/**
 * The directory holding the per-subagent transcripts written under `parentTranscriptPath`'s session.
 *
 * FAILS CLOSED, and that is the load-bearing property rather than defensive habit. The one thing this
 * function must never do is name a directory that does not hold the work, because its whole output is
 * an instruction a reader will follow — the exact failure PR #2613's copy shipped. So anything that
 * is not recognisably a parent session transcript yields `undefined`, and the caller says nothing
 * about a path instead of saying something false:
 *
 *   • `undefined`/empty — this window never recorded an exact transcript file for the agent. Writer 1
 *     of `agentTranscriptRegistry` only fires on Claude Code's own Stop event, so an agent that died
 *     before its first turn ended genuinely has no known session file.
 *   • a path not ending `.jsonl` — the registry's contract is an exact session FILE. A directory (the
 *     weaker writer-2 worktree reading) resolves to its newest transcript only at read time, and
 *     appending `/subagents` to a worktree would name a path in the user's source tree.
 *
 * A trailing-suffix replacement, never a `dirname` + rebuild: the session id is the file's stem, so
 * the stem is exactly the directory name, and slicing keeps whatever separators the host uses.
 */
export function subagentTranscriptDirFor(
  parentTranscriptPath: string | null | undefined,
): string | undefined {
  if (!parentTranscriptPath) return undefined;
  if (!parentTranscriptPath.endsWith(PARENT_TRANSCRIPT_SUFFIX)) return undefined;
  const stem = parentTranscriptPath.slice(0, -PARENT_TRANSCRIPT_SUFFIX.length);
  // A path that is nothing BUT the suffix (`".jsonl"`) leaves an empty stem, which would derive the
  // relative directory `"/subagents"` — an absolute path at the filesystem root. Refuse it.
  if (stem.length === 0) return undefined;
  return `${stem}/subagents`;
}

/**
 * The sentence naming where an orphaned fan-out's partial work survived, or `undefined` when this
 * window cannot name a directory it is sure of.
 *
 * Split out from the notice copy so the path derivation and the words carrying it are asserted
 * separately, and so the "we do not know" branch is a single explicit `undefined` rather than a
 * conditional buried in string concatenation.
 *
 * Names the `.meta.json` sibling as well as the transcript: it holds `{agentType, description}`, so
 * it is what tells a reader WHICH orphan a given `agent-<id>.jsonl` was — the question a parent that
 * dispatched a batch of eight has to answer before any of the transcripts are usable.
 */
export function subagentRecoverySentence(
  parentTranscriptPath: string | null | undefined,
): string | undefined {
  const dir = subagentTranscriptDirFor(parentTranscriptPath);
  if (!dir) return undefined;
  return (
    `Their partial transcripts ARE on disk and are recoverable: ${dir}/${SUBAGENT_TRANSCRIPT_GLOB} ` +
    "(one JSONL file per subagent, appended turn by turn while it ran, so a subagent that never " +
    "reported still left everything it had done; the sibling `agent-<id>.meta.json` names which " +
    "task each one was). Read those rather than re-deriving the work or re-dispatching blind."
  );
}
