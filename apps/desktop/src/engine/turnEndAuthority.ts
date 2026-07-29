// turnEndAuthority — does this window have a TRUSTWORTHY signal for "the agent's turn ended"?
//
// Three status sources feed a row (see statusRouter): Claude Code's hook stream, the spinner in the
// rendered screen, and — when neither exists — a time heuristic over raw PTY output. Only the first
// two can actually witness a turn ENDING. The third cannot: silence is equally consistent with "the
// turn finished" and "a six-minute `pnpm test` is running", and no timer separates them.
//
// That ambiguity is real and unavoidable, so the app must resolve it PER CONSUMER rather than bake
// one answer into the status:
//
//   • An ALARM ("needs you", a notification, a red dot) must read a guess as "finished" — paging a
//     human off a quiet terminal is the false alarm this module's sibling fix exists to kill.
//   • A DESTRUCTIVE GATE (land / rebase / delete this agent's branch) must read the same guess as
//     "still live" — acting on a half-written worktree is unrecoverable, and refusing is cheap.
//
// Coupling those two through a single status is what broke: `blocked` was the engine's "quiet for
// 25s" guess, and it served BOTH as the busy-gate's liveness proof (conciergeTools/workflow.ts) and
// as a red needs-you alarm. Removing the false alarm therefore silently widened the gate. This
// module is the seam: the alarm path reads the status, and the gate additionally asks here whether
// that status is a fact or a guess.
//
// Window-local and non-reactive by design. It is written from the pane that owns the agent's PTY,
// read imperatively by gates, and holds no React state — a Map keyed by agent id, cleared when the
// pane goes away. An agent with NO record is one this window isn't driving; callers must fall back
// to their own reading rather than treat the absence as either answer.

/** Which authoritative turn-end witnesses this window has seen for an agent. */
interface Authority {
  /** Claude Code's hook stream is live — `Stop` is an explicit, deterministic end-of-turn event.
   *  NOT a one-way latch: the router expires hook authority when the stream dies (see
   *  `noteHooksDead`), and an expired stream witnesses nothing. */
  hooks: boolean;
  /** The engine has latched Claude's spinner, so the spinner STOPPING marks the end of a turn. */
  spinner: boolean;
  /** The PTY exited. The strongest witness there is — a dead process cannot still be writing the
   *  worktree — and unlike the other two it is permanent, because nothing un-exits. */
  exited: boolean;
  /** The StatusEngine that owns this record. Only that engine may drop it; see `forgetAgent`. */
  owner: unknown;
}

const byAgent = new Map<string, Authority>();

function entry(agentId: string): Authority {
  const found = byAgent.get(agentId);
  if (found) return found;
  const fresh: Authority = { hooks: false, spinner: false, exited: false, owner: null };
  byAgent.set(agentId, fresh);
  return fresh;
}

/** Begin tracking an agent this window drives (called when its status engine is created). Idempotent;
 *  creates the record with NO authority yet, which is what makes `isTracked` meaningful.
 *
 *  `owner` is the engine instance, recorded so a LATER engine for the same id takes ownership and an
 *  earlier one can no longer delete the record — see `forgetAgent`. */
export function trackAgent(agentId: string, owner?: unknown): void {
  const e = entry(agentId);
  if (owner === undefined || e.owner === owner) return;
  // A DIFFERENT engine is taking over this id, so every witness the previous one recorded is about a
  // previous process. Reset them (roborev 55041): a late `pty:exit` can land after the old engine's
  // dispose and leave `exited: true` behind, and without this the next engine — a "Start again", or a
  // reopened tab — would inherit that flag for a process that is very much alive, silently disabling
  // the busy gate's guess-protection for the whole new session.
  e.hooks = false;
  e.spinner = false;
  e.exited = false;
  e.owner = owner;
}

/** A real hook event arrived — `Stop` will witness the end of every turn from here. */
export function noteHooksLive(agentId: string): void {
  entry(agentId).hooks = true;
}

/**
 * The router has declared the hook stream DEAD (its staleness watchdog fired) and handed the row
 * back to the screen scraper. The stream is no longer witnessing anything, so the authority must go
 * with it — otherwise a guessed `idle` from the time heuristic reads as a witnessed turn end, which
 * is the exact ambiguity this module exists to resolve, re-opened by any hook-stream death.
 *
 * Not merged into `noteHooksLive(false)`: the two are called from different places for different
 * reasons, and a single setter invites passing a stale boolean on a path that meant to assert
 * nothing. Re-activation calls `noteHooksLive` again, so recovery is automatic.
 */
export function noteHooksDead(agentId: string): void {
  const found = byAgent.get(agentId);
  if (found) found.hooks = false;
}

/** The agent's PTY exited (StatusEngine.exit). The process is gone, so the turn is over by
 *  construction — `done`/`errored` are observations, never guesses. */
export function noteProcessExit(agentId: string, owner?: unknown): void {
  // NON-CREATING **and** OWNERSHIP-SCOPED, mirroring `forgetAgent` (roborev 55041, then 55076).
  //
  // Terminal's cleanup detaches (kills) the PTY, then disposes the engine; Tauri's unlisten is
  // genuinely async, so the `pty:exit` caused by that very kill round-trips from Rust AFTER the
  // teardown. Two orderings follow, and only one is closed by being non-creating:
  //
  //   • record ABSENT — the exit lands after `forgetAgent` and before anything re-tracks. Creating
  //     one here would strand `{exited: true, owner: null}` that nothing deletes.
  //   • record PRESENT but owned by a NEWER engine — the likelier one. On "Start again" React runs
  //     the cleanup and then re-runs the effect synchronously, so the new StatusEngine's ctor has
  //     already called `trackAgent(id, this)` by the time the old PTY's exit arrives. Without the
  //     owner check this marks a LIVE process as exited, silently disabling the busy gate's
  //     guess-protection for the entire new session — the exact failure this was meant to close.
  const found = byAgent.get(agentId);
  if (found === undefined) return;
  if (owner !== undefined && found.owner !== null && found.owner !== owner) return;
  found.exited = true;
}
/** The status engine latched Claude's spinner; its disappearance now marks turn end. */
export function noteSpinnerSeen(agentId: string, owner?: unknown): void {
  // Same non-creating, ownership-scoped shape as `noteProcessExit`, and for the same race (roborev
  // 55094). `pty:data` is unlistened over the same async round-trip as `pty:exit`, so a late spinner
  // frame from a DEAD PTY can reach the old engine's ingest after the pane remounted. Creating or
  // blindly setting here would grant `spinner: true` on the record the new engine just reset —
  // converting the live agent's GUESSED idle into a witnessed turn end, which is exactly the
  // protection this module exists to provide, defeated through a second door.
  const found = byAgent.get(agentId);
  if (found === undefined) return;
  if (owner !== undefined && found.owner !== null && found.owner !== owner) return;
  found.spinner = true;
}

/** Is this window driving the agent at all? False for an agent whose pane lives elsewhere (or not at
 *  all), where this module knows nothing and callers must not read an answer into the silence. */
export function isTracked(agentId: string): boolean {
  return byAgent.has(agentId);
}

/** True when SOME source can witness the end of a turn, so a settled status is a fact rather than a
 *  guess. False on the time-heuristic fallback path — where `idle` means "quiet", not "finished". */
export function hasTurnEndAuthority(agentId: string): boolean {
  const a = byAgent.get(agentId);
  return a !== undefined && (a.hooks || a.spinner || a.exited);
}

/**
 * Drop an agent's record — its pane unmounted, so this window no longer witnesses anything.
 *
 * OWNERSHIP-GUARDED, mirroring `unregisterStatusEngine` in engine/engineRegistry and for the same
 * documented race: a remount can register a NEWER engine for the same id before the OLD terminal's
 * cleanup runs. An unguarded delete there wipes the record the live engine just created, leaving a
 * driven agent untracked — at which point the busy gate falls back to the status alone and a guessed
 * `idle` mid-tool-call passes it. Pass the disposing engine; a non-owner call is a no-op.
 */
export function forgetAgent(agentId: string, owner?: unknown): void {
  const found = byAgent.get(agentId);
  if (found === undefined) return;
  if (owner !== undefined && found.owner !== null && found.owner !== owner) return;
  byAgent.delete(agentId);
}

/** Test seam only: wipe every record. */
export function resetTurnEndAuthority(): void {
  byAgent.clear();
}
