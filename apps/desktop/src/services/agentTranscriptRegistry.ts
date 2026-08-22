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
// FOUR WRITERS, FOUR DIFFERENT SAFETY PROPERTIES — the reasoning for the first two lives with the
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
//  4. `noteAgentConfigDir` — WHICH ACCOUNT'S `CLAUDE_CONFIG_DIR` this agent's `claude` was spawned
//     under, so a read looks in the right `projects/` root at all. Orthogonal to all three above and
//     to the wrong-attribution question entirely: writers (1)-(3) answer *whose* conversation and
//     *where in a tree*, and none of them help when the tree we scan is the wrong ACCOUNT's. See its
//     own block below for why its `undefined` is NOT writer (3)'s fail-closed UNKNOWN.
//
// Writer (1) WINS wherever both are registered, which is what keeps the weaker resolution off any
// agent the founder is actually looking at. Writer (3) is orthogonal to both — it constrains what a
// directory read may return rather than naming a path.
//
// NOTHING CLEARS ANY OF THESE MAPS in production. `forgetAgentTranscriptPath` is for a caller that genuinely
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

// ── WRITER (3b): A PROVISIONAL SESSION ID, RECOVERED WITHOUT THE SESSION GATE ────────────────────
//
// Writer (3) above carries a promise its docstring states plainly: THE CALLER HAS ESTABLISHED THAT
// THE SESSION IS THIS AGENT'S, because its one caller sits behind `createHookEventHandler`'s session
// gate. `services/sessionBindingRecovery` cannot make that promise — it reads a log keyed by
// WORKTREE, so the newest turn-opener in it can belong to a background one-shot `claude` that ran in
// the same tree. It verifies the transcript exists, which is a real check, but existence is not
// ownership.
//
// Writing that weaker evidence into writer (3) would have been durable in the one way that matters:
// that map ACCUMULATES and never replaces, and it PERSISTS. A single mis-lock would therefore
// survive restarts with no revision path, and would keep rendering the one-shot's conversation under
// the agent's name even after the agent's real, gated binding arrived. `HookStatusEngine` takes a
// comparable risk deliberately, but its mis-lock is self-correcting — a fresh spawn re-creates the
// engine and re-locks. Ours would not have been.
//
// So a recovered id lives HERE instead, with two properties that make the risk recoverable:
//   • MEMORY ONLY — never persisted, so it cannot outlive the session that guessed it.
//   • SUPERSEDED — the first GATED id for that agent drops it (see `noteAgentSessionId`), so real
//     evidence always wins and the guess is retired rather than accumulated beside it.
// `agentSessionIds` returns the union, so the pane reads a recovered binding exactly as it reads a
// gated one; only its lifetime differs.
const provisionalSessionIds = new Map<string, readonly string[]>();

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

/** How long a mere RE-SEEING may sit unwritten before it reaches disk.
 *
 *  A touch is not worth a `JSON.stringify` of up to 400 entries: hook events arrive continuously and
 *  most of them re-see an id we already hold. A genuine CHANGE still writes immediately (`persist()`
 *  cancels any pending flush and writes the whole map, reordering included), so this timer only ever
 *  has to cover the case where nothing else writes for a while. */
const PERSIST_DEBOUNCE_MS = 1000;

let persistPending: ReturnType<typeof setTimeout> | null = null;

/** Mark the session blob dirty without writing it. See `PERSIST_DEBOUNCE_MS`. */
function persistSoon(): void {
  if (persistPending !== null) return;
  persistPending = setTimeout(() => {
    persistPending = null;
    persist();
  }, PERSIST_DEBOUNCE_MS);
  // A pending flush must not keep a Node process alive on its own; the blob is a convenience, not
  // state anything is waiting for. `unref` exists only on Node's Timeout.
  (persistPending as unknown as { unref?: () => void }).unref?.();
}

function persist(): void {
  if (persistPending !== null) {
    clearTimeout(persistPending);
    persistPending = null;
  }
  const s = store();
  if (!s) return;
  // Keep the most recently SEEN agents. `Map` preserves insertion order, and every write path below
  // re-inserts — a change through `noteAgentSessionId`'s main body, and a mere re-sighting through
  // its touch branch — so the tail is the recently-active set.
  //
  // ══ THE TAIL USED TO MEAN "RECENTLY CHANGED", AND THAT SILENTLY EVICTED WORKING AGENTS ═════════
  // `noteAgentSessionId` returns EARLY on an id it already holds, so before the touch branch existed
  // an entry only moved to the tail when it CHANGED. A busy, stable agent — one session id, hundreds
  // of hook events, working right now — therefore never refreshed its recency and was pushed out by
  // every newly-created agent. Measured on the founder's machine: this blob saturated at exactly
  // MAX_AGENTS_PERSISTED (400) and the agent he was looking at was NOT in it, despite having emitted
  // 110 hook events. Its mounted pane then read "No conversation with <name> yet." forever, because
  // the reader fails closed on an unknown binding and hydration had dropped the one it had learned.
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
  // ── ALREADY KNOWN: TOUCH THE RECENCY, CHANGE NOTHING ELSE ────────────────────────────────────
  //
  // No new array and NO NOTIFICATION, both load-bearing. Hook events arrive continuously and almost
  // all of them carry a session id we already have; re-notifying would re-render the pane on every
  // event and, worse, hand `useSyncExternalStore` a new snapshot identity each time — which React
  // treats as an infinite loop.
  //
  // But this branch used to return outright, and THAT was the eviction bug (see `persist`): an entry
  // only reached the tail when it CHANGED, so a stable agent working flat out never refreshed its
  // recency and was trimmed away by agents created after it. Re-inserting the SAME frozen array
  // costs two O(1) Map operations, keeps the snapshot identity byte-for-byte, and is invisible to
  // every subscriber — it only moves this agent to the end of the insertion order `persist` trims on.
  if (current !== undefined && current.includes(id)) {
    sessionIds.delete(agentId);
    sessionIds.set(agentId, current);
    persistSoon();
    return;
  }
  const next = Object.freeze([...(current ?? []), id].slice(-MAX_SESSIONS_PER_AGENT));
  // Delete-then-set so the Map's insertion order tracks recency, which is what `persist` trims on.
  sessionIds.delete(agentId);
  sessionIds.set(agentId, next);
  // GATED EVIDENCE RETIRES THE GUESS. Anything writer (3b) recovered for this agent was a best
  // effort made in the absence of exactly this; keeping it beside a gated id is how a background
  // one-shot's conversation would stay merged into the pane forever.
  provisionalSessionIds.delete(agentId);
  persist();
  for (const listener of sessionListeners) listener();
}

/**
 * Record a session id recovered WITHOUT the session gate — writer (3b). See the block above
 * `provisionalSessionIds` for why this is not `noteAgentSessionId`.
 *
 * Idempotent and quiet on a repeat, for the same reason writer (3) is: the caller may retry.
 * A no-op once a GATED id is known for this agent — real evidence is never displaced by a guess.
 */
export function noteRecoveredSessionId(agentId: string, sessionId: string): void {
  const id = sessionId.trim();
  if (id === "" || agentId.trim() === "") return;
  ensureHydrated();
  if (sessionIds.has(agentId)) return;
  const current = provisionalSessionIds.get(agentId);
  if (current?.includes(id)) return;
  provisionalSessionIds.set(
    agentId,
    Object.freeze([...(current ?? []), id].slice(-MAX_SESSIONS_PER_AGENT)),
  );
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
  const gated = sessionIds.get(agentId);
  const provisional = provisionalSessionIds.get(agentId);
  // UNION, gated first, and `undefined` only when NEITHER has anything — the reader's fail-closed
  // branch must still fire for an agent nothing has established at all. Returning the stored array
  // itself in the common single-source case keeps the snapshot identity stable for
  // `useSyncExternalStore`; a fresh array on every call would make React throw.
  if (gated && !provisional) return gated;
  if (provisional && !gated) return provisional;
  if (!gated && !provisional) return undefined;
  return Object.freeze([...gated!, ...provisional!.filter((i) => !gated!.includes(i))]);
}

// ── WRITER (4): WHICH ACCOUNT'S CONFIG DIRECTORY THIS AGENT'S CLAUDE RUNS UNDER ──────────────────
//
// Sparkle spawns each build agent's `claude` with a per-account `CLAUDE_CONFIG_DIR` (Multi Claude
// Max), exported onto the CHILD only — never onto Sparkle's own process env. Claude Code then writes
// that agent's transcript under `<accountConfigDir>/projects/<slug>/<session>.jsonl`, NOT under
// `$HOME/.claude/projects/<slug>/`.
//
// Every read in this feature omitted it. `useAgentTranscript` had a `configDir` parameter that NO
// caller — production or test — ever supplied, so `agent_transcript_page` and `agent_transcript_tail`
// were invoked with `configDir: null`, Rust fell back to `$HOME/.claude/projects/<slug>`, that
// directory DOES NOT EXIST for an account-spawned agent, `own_session_files` returned an empty list,
// and the pane rendered "No conversation with <name> yet." over a 1.4 MB transcript that was being
// written at that exact moment. Measured on the founder's machine: 29 of 30 live worktrees in one
// project were account-scoped like this. The parameter is gone now — see `useAgentTranscript`'s own
// note on why supplying it would have left the same seam open for the next person.
//
// ══ ITS `undefined` IS NOT WRITER (3)'S `undefined`, AND CONFLATING THEM WOULD BE A REGRESSION ═══
// For SESSION IDS, `undefined` means UNKNOWN and the reader MUST fail closed: guessing whose
// conversation this is renders a stranger's words under this agent's name.
// For a CONFIG DIR there is nothing to guess and nobody to misattribute. `undefined` means "no
// account override was ever recorded", and the correct behaviour is to pass `null` and let Rust fall
// back to `$HOME/.claude` — which is exactly what happens today and is exactly right for a legacy
// agent spawned under the default config. So this map can only ever widen where we look; it can
// never make a currently-working pane worse.
//
// OBSERVABLE, for the same reason writer (3) is: a RENDER depends on it. The binding lands on the
// agent's first hook event (or at spawn), routinely after the mounted pane's first render, so a
// plain `agentConfigDir()` read at render time would capture `undefined`, never see the real value
// arrive, and leave the pane reading the wrong account's directory for the life of the mount — the
// subscribe-vs-getState mistake this module already documents twice.
const configDirs = new Map<string, string>();
const configListeners = new Set<() => void>();

/** Where the account binding is persisted. Its OWN versioned key, so a shape change in either map is
 *  a clean miss for that map alone rather than a parse failure that takes both down. */
const CONFIG_STORE_KEY = "sparkle.agentConfigDirs.v1";

let configHydrated = false;
let configPersistPending: ReturnType<typeof setTimeout> | null = null;

/** Same hydrate-before-read-AND-write discipline as the session map, and the same care around
 *  `getItem`: the accessor itself can throw in a sandboxed frame, and this is a leaf module whose
 *  module-load failure would take down every importer. Latched before the read so a throwing store
 *  cannot make every later call retry it. */
function ensureConfigHydrated(): void {
  if (configHydrated) return;
  configHydrated = true;
  try {
    const raw = store()?.getItem(CONFIG_STORE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    for (const [agentId, dir] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof dir !== "string") continue;
      const trimmed = dir.trim();
      if (agentId.trim() !== "" && trimmed !== "") configDirs.set(agentId, trimmed);
    }
  } catch {
    // A malformed blob is a miss, not a crash — and a miss here costs nothing but a fallback to the
    // default config dir, which is the pre-existing behaviour.
  }
}

function persistConfigDirs(): void {
  if (configPersistPending !== null) {
    clearTimeout(configPersistPending);
    configPersistPending = null;
  }
  const s = store();
  if (!s) return;
  // Capped and trimmed exactly like the session map, and on the same last-SEEN recency rule — the
  // touch branch in `noteAgentConfigDir` re-inserts on an unchanged value so a long-lived agent is
  // not evicted by newly-created ones. (That is `persist`'s bug, not repeated here.)
  const entries = [...configDirs.entries()].slice(-MAX_AGENTS_PERSISTED);
  try {
    s.setItem(CONFIG_STORE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Quota or a disabled store. In-memory continues to work for this session.
  }
}

function persistConfigDirsSoon(): void {
  if (configPersistPending !== null) return;
  configPersistPending = setTimeout(() => {
    configPersistPending = null;
    persistConfigDirs();
  }, PERSIST_DEBOUNCE_MS);
  (configPersistPending as unknown as { unref?: () => void }).unref?.();
}

/** Subscribe to changes in the CONFIG-DIR map (writer 4). Returns an unsubscribe fn.
 *  `useSyncExternalStore`-shaped, for the reason stated in this map's block above. */
export function subscribeAgentConfigDirs(onChange: () => void): () => void {
  configListeners.add(onChange);
  return () => {
    configListeners.delete(onChange);
  };
}

/**
 * Record which account config directory `agentId`'s `claude` was spawned under — writer (4).
 *
 * An EMPTY `configDir` is ignored rather than stored, because empty already MEANS "the default", and
 * the default is what every reader falls back to when this map has nothing. Storing `""` would only
 * create a second spelling of the same state that readers would have to learn about.
 *
 * Notifies only on a CHANGE. An unchanged re-registration still TOUCHES the recency (see
 * `noteAgentSessionId`'s touch branch for the eviction bug that rule exists for): the spawn path and
 * every hook event call this, so a busy agent must not be trimmed out of the persisted blob by
 * agents created after it.
 */
export function noteAgentConfigDir(agentId: string, configDir: string | null | undefined): void {
  const id = agentId.trim();
  const dir = (configDir ?? "").trim();
  if (id === "" || dir === "") return;
  ensureConfigHydrated();
  const current = configDirs.get(id);
  if (current === dir) {
    configDirs.delete(id);
    configDirs.set(id, dir);
    persistConfigDirsSoon();
    return;
  }
  configDirs.delete(id);
  configDirs.set(id, dir);
  persistConfigDirs();
  for (const listener of configListeners) listener();
}

/** The account config directory recorded for this agent, or `undefined` for "no override recorded".
 *
 *  READ THE MAP'S BLOCK ABOVE BEFORE TREATING THIS LIKE `agentSessionIds`. `undefined` here is NOT
 *  the fail-closed UNKNOWN: pass `null` to Rust and let it fall back to `$HOME/.claude`, which is
 *  both today's behaviour and the right answer for an agent with no account override. */
export function agentConfigDir(agentId: string): string | undefined {
  ensureConfigHydrated();
  return configDirs.get(agentId);
}

/**
 * The config directory a Claude Code transcript path implies — PURE, no I/O, no guessing.
 *
 * Claude writes `<configDir>/projects/<slug>/<session-id>.jsonl`, so the config dir is the path with
 * its last three segments removed. Both separators are handled so a Windows-shaped path cannot be
 * mis-sliced.
 *
 * FAILS CLOSED, and deliberately hard: the grandparent segment must be exactly `projects` AND the
 * leaf must end `.jsonl`, or this returns `undefined`. A WRONG config dir is worse than none —
 * `undefined` leaves the reader on `$HOME/.claude`, which is today's behaviour and correct for a
 * default-config agent, whereas a fabricated one points every read at a directory that does not
 * exist and turns a working pane into an empty one. A short path (no room for the three segments)
 * and a root-level result are both `undefined` for the same reason.
 */
export function configDirFromTranscriptPath(path: string | null | undefined): string | undefined {
  const p = (path ?? "").trim();
  if (!/\.jsonl$/i.test(p)) return undefined;
  const sepBeforeLeaf = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (sepBeforeLeaf <= 0) return undefined;
  const slugDir = p.slice(0, sepBeforeLeaf); // <configDir>/projects/<slug>
  const sepBeforeSlug = Math.max(slugDir.lastIndexOf("/"), slugDir.lastIndexOf("\\"));
  if (sepBeforeSlug <= 0) return undefined;
  const projectsDir = slugDir.slice(0, sepBeforeSlug); // <configDir>/projects
  const sepBeforeProjects = Math.max(
    projectsDir.lastIndexOf("/"),
    projectsDir.lastIndexOf("\\"),
  );
  if (sepBeforeProjects <= 0) return undefined;
  // The layout, asserted rather than assumed. Anything else is not a Claude session path and its
  // "config dir" would be an invention.
  if (projectsDir.slice(sepBeforeProjects + 1) !== "projects") return undefined;
  const configDir = projectsDir.slice(0, sepBeforeProjects);
  return configDir === "" ? undefined : configDir;
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

/** Forget an agent's transcript path, worktree, session binding AND account config dir. No
 *  production caller today (see the header); used by tests resetting between cases, and available
 *  for a real agent-close seam when one exists.
 *
 *  Clears all FOUR writers. A partial forget would be the worst of both: the pane would keep a
 *  session binding for an agent whose worktree it no longer knows, or vice versa — or, since writer
 *  (4) joined, keep pointing at an account directory for an agent it has otherwise forgotten. */
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
  // Writer (3b) too. A partial forget is the worst of both: the pane would keep a PROVISIONAL
  // binding for an agent whose gated binding, worktree and config dir it had just dropped — and
  // because that map is memory-only, nothing else would ever clear it.
  if (provisionalSessionIds.delete(agentId)) {
    for (const listener of sessionListeners) listener();
  }
  ensureConfigHydrated();
  if (configDirs.delete(agentId)) {
    persistConfigDirs();
    for (const listener of configListeners) listener();
  }
}
