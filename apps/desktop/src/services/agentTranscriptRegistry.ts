// agentTranscriptRegistry — WHERE an agent's Claude Code session transcript can be found.
//
// Two maps and four functions, deliberately in a module of their own. The registry used to live
// inside `services/conciergeTools/terminal`, which is where it is READ — but that module imports the
// terminal snapshot machinery, the dispatcher and the suggestion heuristics, so every writer had to
// drag all of it in behind a two-line call.
//
// That is not a tidiness argument, it broke the build: `stores/projectStore` registers a worktree the
// moment one is cut, and importing `conciergeTools/terminal` to do it pulled `SNAPSHOT_MAX_LINES`
// (via services/terminalScrollback) into the module graph of every test that imports the project
// store. Those tests mock `terminalScrollback` with only the export they use, so vitest failed them
// at COLLECTION — 16 files, zero test failures, a red suite that pointed nowhere near the change.
// A leaf module with no imports of its own cannot do that to anyone.
//
// TWO WRITERS, TWO DIFFERENT SAFETY PROPERTIES — the reasoning lives with the READER
// (`conciergeTools/terminal`, "Transcript paths — the seam for tier (d)"), because it is about how
// much a given path can be trusted, not about how it is stored. In short:
//
//  1. `noteAgentTranscriptPath` — an EXACT session file, from Claude Code's own Stop event. The
//     handler's session gate rejects a background `claude` sharing the worktree.
//  2. `noteAgentTranscriptWorktree` — a WORKTREE, resolved to its newest transcript at READ time.
//     Weaker: no session gate, so a different `claude` running in the same directory can hold the
//     newest mtime. Bounded by the fact that the directory is one the app itself created.
//
// Writer (1) WINS wherever both are registered, which is what keeps the weaker resolution off any
// agent the founder is actually looking at.
//
// NOTHING CLEARS EITHER MAP in production. `forgetAgentTranscriptPath` is for a caller that genuinely
// knows an agent is gone, and there isn't one — the pane's unmount cleanup is the wrong place twice
// over (it fires on a project switch, and the registry exists to serve UNMOUNTED agents). The cost is
// one short string per agent id opened this process. Stated here so nobody reads the export as
// evidence of a lifecycle that does not exist.

const transcriptPaths = new Map<string, string>();
const transcriptWorktrees = new Map<string, string>();

// ── WHY THIS MAP IS OBSERVABLE AND THE OTHER IS NOT ──────────────────────────────────────────────
// A RENDER now depends on the worktree map. The concierge mounts to the app-owned Improve-Sparkle
// agent like any build row, and that agent has no `projectStore` row to read a `worktreePath` off
// (services/knownAgents' header: it is deliberately never a member of any project's `agents` array)
// — so this registry is the only place its worktree is written down, and the column's mounted view
// reads it here (see ConciergeHost's `mountedWorktreePath`).
//
// It is written by `SparkleAgentPane.prepare()`, which cuts the worktree BEFORE the pane can render
// a terminal — i.e. after the concierge has already rendered against an empty registry. A plain
// `getAgentTranscriptWorktree()` at memo time would therefore capture `undefined` and never see the
// path arrive, leaving that agent's transcript permanently unreadable in the mounted column until
// something unrelated re-rendered the host. That is precisely the subscribe-vs-getState mistake the
// `mountedRow` selector beside it already documents for ordinary agents.
//
// A LISTENER SET, NOT A STORE, so this module keeps the property its header is about: no imports of
// its own, hence nothing it can drag into anyone's module graph. `useSyncExternalStore` on the
// consumer side needs exactly this shape.
//
// The PATH map (writer 1) has no render consumer and so gets no notification — deliberately, rather
// than by omission. Add one here if that ever changes; do not let a reader poll it.
const worktreeListeners = new Set<() => void>();

/** Subscribe to changes in the WORKTREE map (writer 2). Returns an unsubscribe fn.
 *  `useSyncExternalStore`-shaped: the callback takes no arguments and re-reads for itself. */
export function subscribeAgentTranscriptWorktrees(onChange: () => void): () => void {
  worktreeListeners.add(onChange);
  return () => {
    worktreeListeners.delete(onChange);
  };
}

/** Remember where this agent's session transcript lives — writer (1), an exact session file. */
export function noteAgentTranscriptPath(agentId: string, path: string): void {
  if (path.trim() === "") return;
  transcriptPaths.set(agentId, path);
}

/**
 * Remember which WORKTREE an agent runs in — writer (2) — so a reader can resolve its newest
 * transcript at READ time.
 *
 * Deliberately stores the DIRECTORY and not a file: resolving once, at registration, is what made a
 * long-running agent permanently one session behind, because a fresh `claude` (no `--resume`) writes
 * a brand-new `<uuid>.jsonl` and the pinned path kept naming the previous one.
 */
export function noteAgentTranscriptWorktree(agentId: string, worktreePath: string): void {
  if (worktreePath.trim() === "") return;
  // Only a CHANGE notifies. Both writers are on hot-ish paths (`prepare()` re-runs on every retry,
  // and the project store registers on every worktree write), and a re-render per identical
  // re-registration would be a render loop dressed as a subscription.
  if (transcriptWorktrees.get(agentId) === worktreePath) return;
  transcriptWorktrees.set(agentId, worktreePath);
  for (const listener of worktreeListeners) listener();
}

/** The exact session file registered for this agent, if any. */
export function agentTranscriptPath(agentId: string): string | undefined {
  return transcriptPaths.get(agentId);
}

/** The worktree registered for this agent, if any. */
export function agentTranscriptWorktree(agentId: string): string | undefined {
  return transcriptWorktrees.get(agentId);
}

/** Forget an agent's transcript path AND worktree. No production caller today (see the header);
 *  used by tests resetting between cases, and available for a real agent-close seam when one exists. */
export function forgetAgentTranscriptPath(agentId: string): void {
  transcriptPaths.delete(agentId);
  if (transcriptWorktrees.delete(agentId)) {
    for (const listener of worktreeListeners) listener();
  }
}
