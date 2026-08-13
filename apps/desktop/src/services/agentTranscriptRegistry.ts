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
// THREE WRITERS, THREE DIFFERENT SAFETY PROPERTIES — the reasoning for the first two lives with the
// READER (`conciergeTools/terminal`, "Transcript paths — the seam for tier (d)"), because it is about
// how much a given path can be trusted, not about how it is stored. In short:
//
//  1. `noteAgentTranscriptPath` — an EXACT session file, from Claude Code's own Stop event. The
//     handler's session gate rejects a background `claude` sharing the worktree.
//  2. `noteAgentTranscriptWorktree` — a WORKTREE, resolved to its newest transcript at READ time.
//     Weaker: no session gate, so a different `claude` running in the same directory can hold the
//     newest mtime. Bounded by the fact that the directory is one the app itself created.
//  3. `noteAgentSessionId` — the agent's own Claude SESSION IDS, a set. This is what makes writer
//     (2)'s directory safe to read: it names WHOSE files in that directory are this agent's, so
//     "newest mtime" is chosen among the agent's own sessions instead of among every `claude` that
//     ever ran in the tree. Session-gated like writer (1). See its own block below.
//
//     THAT SENTENCE DESCRIBES BOTH READERS OF WRITER (2) — checked, because for one commit it did
//     not (roborev 63135). The mounted pane got the filter; the concierge's tool read
//     (`conciergeTools/terminal`'s tier (d)) kept resolving through the unfiltered
//     `claude_latest_session_path` and could still quote a stranger's last turn as this agent's. A
//     comment asserting a guarantee the code does not provide is worse than no comment, and this
//     repo has paid for that twice — so if you add a THIRD reader of writer (2), it takes the filter
//     or this paragraph stops being true. The readers are: `hooks/useAgentTranscript` (page + tail,
//     via `agent_transcript_page`/`agent_transcript_tail`) and `conciergeTools/terminal`'s
//     `resolveWorktreeTranscript` (via `agent_own_session_path`). All three commands fail closed on
//     an unknown binding.
//
// Writer (1) WINS wherever both are registered, which is what keeps the weaker resolution off any
// agent the founder is actually looking at. Writer (3) is orthogonal to both — it constrains what a
// directory read may return rather than naming a path.
//
// NOTHING CLEARS EITHER MAP in production. `forgetAgentTranscriptPath` is for a caller that genuinely
// knows an agent is gone, and there isn't one — the pane's unmount cleanup is the wrong place twice
// over (it fires on a project switch, and the registry exists to serve UNMOUNTED agents). The cost is
// one short string per agent id opened this process. Stated here so nobody reads the export as
// evidence of a lifecycle that does not exist.

// ── WRITER (3): WHICH CLAUDE SESSIONS ARE THIS AGENT'S ───────────────────────────────────────────
//
// The two writers above answer "where do I look" — a directory, or a file. Neither answers "WHOSE
// conversation is in it", and that gap was a live wrong-attribution bug: a session DIRECTORY belongs
// to a WORKTREE, so it holds a `*.jsonl` for every `claude` that ever ran there. The mounted
// concierge pane read the newest one by mtime, so its footer said "Chatting with Sparkle" while its
// body rendered an unrelated agent's roborev review. Measured directory sizes: 1,172 files in the
// Improve Sparkle worktree, 98 in the main checkout, 41 in a busy agent worktree — any directory with
// more than one file could render the wrong conversation.
//
// A SET, NOT A VALUE, and this is the requirement that rules out the cheaper approximations. An agent
// spans MORE THAN ONE session id over its life: every resume (`--continue`, `--resume`, a restart
// after a crash) opens a fresh session with a fresh id and a fresh file. Binding one id would render
// only the newest stretch and silently drop everything before the resume — the founder mounts the
// pane precisely to read that history. So ids ACCUMULATE and are never replaced.
//
// UNKNOWN IS A THIRD STATE, distinct from empty, and callers must fail closed on it: `undefined`
// means "we do not know which sessions are this agent's", and the reader must render nothing rather
// than fall back to the newest file in the directory — that fallback IS the defect. (Same convention
// as `agentId: null` in AGENTS.md: null is UNKNOWN, never "none".)
const transcriptPaths = new Map<string, string>();
const transcriptWorktrees = new Map<string, string>();

// agentId -> that agent's session ids, oldest first. FROZEN ARRAYS, not Sets, so a `useSyncExternalStore`
// snapshot has a stable identity between mutations — React throws if `getSnapshot` returns a fresh
// object every call, and a Set would force a copy on every read.
const sessionIds = new Map<string, readonly string[]>();
const sessionListeners = new Set<() => void>();

/** Where the binding is persisted. Versioned so a shape change is a clean miss, not a parse crash. */
const SESSION_STORE_KEY = "sparkle.agentSessionIds.v1";
/** Bounds on what we persist. Nothing clears this map (see the header), so it needs its own ceiling:
 *  agents accumulate for the life of the install, and a corrupted/huge blob must not be loaded back.
 *  A resumed agent rarely exceeds a handful of sessions; the oldest are dropped first because the
 *  live end is what a mounted pane is watching. */
const MAX_AGENTS_PERSISTED = 400;
const MAX_SESSIONS_PER_AGENT = 40;

let hydrated = false;

/** localStorage, or `null` where there isn't one. Read through a function rather than captured at
 *  module load: this module has no imports and must not assume a DOM to be importable. */
function store(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Access itself can throw (disabled storage, sandboxed frame). A registry that cannot persist
    // still works in memory; it must not fail to load.
    return null;
  }
}

/**
 * Load the persisted binding, once, before the first read OR write.
 *
 * BEFORE THE WRITE TOO, not just the read — a write that landed on an unhydrated map would create a
 * fresh single-id entry, and a later hydration would then have to choose between clobbering the live
 * id and discarding the history. Hydrating first makes the accumulate rule hold across restarts,
 * which is the whole reason this is persisted: after a restart the agent resumes under a NEW session
 * id, so without the prior ids on disk the pane would show only the post-restart stretch.
 */
function ensureHydrated(): void {
  if (hydrated) return;
  // Latched BEFORE the read, so a throwing store cannot make every subsequent call retry it.
  hydrated = true;
  // `getItem` is INSIDE the try, not just the `localStorage` lookup: in a sandboxed frame the property
  // resolves fine and the accessor throws. Outside, that would take down module load for every
  // importer of this leaf module — the failure it is least able to afford.
  try {
    const raw = store()?.getItem(SESSION_STORE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    for (const [agentId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const ids = list.filter((v): v is string => typeof v === "string" && v.trim() !== "");
      if (ids.length > 0) sessionIds.set(agentId, Object.freeze(ids.slice(-MAX_SESSIONS_PER_AGENT)));
    }
  } catch {
    // A malformed blob (or an unreadable store) is a miss, not a crash. The binding rebuilds from hook
    // events as the agent works; the cost is one pane that reads empty until its next SessionStart.
  }
}

function persist(): void {
  const s = store();
  if (!s) return;
  // Keep the most recently written agents. `Map` preserves insertion order and `noteAgentSessionId`
  // re-inserts on every change, so the tail is the recently-active set.
  const entries = [...sessionIds.entries()].slice(-MAX_AGENTS_PERSISTED);
  try {
    s.setItem(SESSION_STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota or a disabled store. In-memory continues to work for this session.
  }
}

/** Subscribe to changes in the SESSION-ID map (writer 3). Returns an unsubscribe fn.
 *  `useSyncExternalStore`-shaped, for the same reason the worktree map has one: a RENDER depends on
 *  it. The mounted pane reads the binding to decide what it may show, and the binding usually
 *  arrives AFTER the first render — the agent's first hook event lands milliseconds to seconds later
 *  — so a non-reactive read would leave the pane permanently empty for an agent whose session is
 *  perfectly well known by the time anyone looks at it. */
export function subscribeAgentSessionIds(onChange: () => void): () => void {
  sessionListeners.add(onChange);
  return () => {
    sessionListeners.delete(onChange);
  };
}

/**
 * Record that `sessionId` is one of `agentId`'s OWN Claude Code sessions — writer (3).
 *
 * ACCUMULATES; never replaces. See the header: an agent spans several session ids across resumes and
 * all of them are its history.
 *
 * THE CALLER MUST HAVE ESTABLISHED THAT THE SESSION IS THIS AGENT'S. The one production caller is
 * `AgentPane`'s hook handler, which sits behind `createHookEventHandler`'s session gate — the same
 * gate that keeps a background `claude` sharing the worktree from driving status, liveness and
 * history. Registering a foreign session here would point the pane at another agent's words with
 * full confidence, which is exactly the bug this map exists to fix.
 */
export function noteAgentSessionId(agentId: string, sessionId: string): void {
  const id = sessionId.trim();
  if (id === "" || agentId.trim() === "") return;
  ensureHydrated();
  const current = sessionIds.get(agentId);
  // Already known → no new array, no notification. Hook events arrive continuously and almost all
  // of them carry a session id we already have; re-notifying would re-render the pane on every event
  // and, worse, hand `useSyncExternalStore` a new snapshot identity each time.
  if (current?.includes(id)) return;
  const next = Object.freeze([...(current ?? []), id].slice(-MAX_SESSIONS_PER_AGENT));
  // Delete-then-set so the Map's insertion order tracks recency, which is what `persist` trims on.
  sessionIds.delete(agentId);
  sessionIds.set(agentId, next);
  persist();
  for (const listener of sessionListeners) listener();
}

/**
 * The Claude Code sessions known to be `agentId`'s, oldest first — or `undefined` when we do not
 * know.
 *
 * `undefined` IS THE LOAD-BEARING RETURN VALUE. It means UNKNOWN, and a reader must render nothing
 * rather than guess. The guess it would otherwise make — the newest session file in the worktree's
 * directory — is another agent's conversation whenever another agent has run there, which is the
 * common case, not the edge one.
 */
export function agentSessionIds(agentId: string): readonly string[] | undefined {
  ensureHydrated();
  return sessionIds.get(agentId);
}

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

/** Forget an agent's transcript path, worktree AND session binding. No production caller today (see
 *  the header); used by tests resetting between cases, and available for a real agent-close seam when
 *  one exists.
 *
 *  Clears all THREE writers. A partial forget would be the worst of both: the pane would keep a
 *  session binding for an agent whose worktree it no longer knows, or vice versa. */
export function forgetAgentTranscriptPath(agentId: string): void {
  transcriptPaths.delete(agentId);
  if (transcriptWorktrees.delete(agentId)) {
    for (const listener of worktreeListeners) listener();
  }
  ensureHydrated();
  if (sessionIds.delete(agentId)) {
    persist();
    for (const listener of sessionListeners) listener();
  }
}
