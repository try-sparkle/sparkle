// Which dead agents the resurrector has decided may come back.
//
// ── WHY A SET AND NOT A SPAWN CALL ────────────────────────────────────────────────────────────
// Resurrection is ADMISSION TO THE MOUNT SET, not a new spawn path, and that is a deliberate
// refusal rather than an economy. The resume primitive already exists — `claudeSpawn.buildClaudeExec`
// emits `claude --resume <sessionId>` and `AgentPane` derives it from `claudeSessionInfo` — and
// `AgentPane.prepare` is where the worktree prep, the write-guard install, the hook install, the
// account selection and the resume detection all happen. A headless respawn would have to
// re-implement every one of them, and would then stall anyway: `pty.rs` holds a 256 KiB inflight
// high-water mark that only xterm clears, because only xterm emits `pty_ack`.
//
// So the whole side effect is "let this agent's pane mount", and this module is the one bit of state
// that says so.
//
// ── SHAPED EXACTLY LIKE `sessionProjects.ts`, INCLUDING THE PART THAT LOOKS LIKE A LEAK ───────
// Private Set + version counter + listener set + `useSyncExternalStore` consumers. The set only ever
// GROWS within a session and is NOT persisted, and that is the same decision `sessionProjects` makes
// for the same hard reason: **a Terminal unmount KILLS its PTY.**
//
// Concretely, if this set could shrink: the resurrected agent lives in a project the user never
// opened this session, so the ONLY thing letting that project past `Workspace`'s visited gate is an
// entry here. Remove it while the agent is running and every pane in that project unmounts, every
// one of those PTYs dies, and the resurrector's own recovery is what killed them. A stale entry, by
// contrast, costs nothing measurable: `Workspace` iterates `projects`, so an id naming no agent
// matches nothing, and the ceiling is one string per agent this window resurrected.
//
// ── IT GATES THE PROJECT, NOT THE AGENT ──────────────────────────────────────────────────────
// This is the division of labour that makes closing an agent still work. `openAgentIds` in the
// runtime store is the app's real, persisted, multi-window-aware answer to "is this agent's pane
// mounted", and `runtimeStore.close()` removes an id from it. If admission ALSO gated the agent
// itself, an admitted agent could never be closed — the user would click close, the store would drop
// it, and this set would put it straight back.
//
// So the runner does both: it calls `runtimeStore.open(agentId)` (the ordinary mount signal, which
// close undoes) and `admitAgent(agentId)` (which only unlocks the project's visited gate). The
// second is needed because the first cannot reach: `wasProjectVisited` is checked per PROJECT and
// answers false for a project nobody has looked at, and `markProjectVisited` is NOT an option — that
// set feeds the tray and the phone roster publisher, so forcing a mount through it would publish a
// project the user never opened.

const admitted = new Set<string>();
const listeners = new Set<() => void>();
// Bumped on every real change so `useSyncExternalStore` consumers can take a cheap snapshot without
// materializing (or diffing) the set.
let version = 0;

/** Tell every subscriber the set moved. A listener's failure must never break the caller — nor
 *  starve the listeners after it. */
function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // Swallowed by design; see above.
    }
  }
}

/**
 * Admit one dead agent back to the mount set. Idempotent; notifies only on a real change.
 *
 * Returns whether this call was the one that admitted it, so a caller can tell a fresh admission
 * from a repeat without reading the set back — which is what stops a re-entrant sweep spending a
 * respawn attempt on an agent it already admitted.
 */
export function admitAgent(agentId: string | null | undefined): boolean {
  if (!agentId || admitted.has(agentId)) return false;
  admitted.add(agentId);
  version += 1;
  notify();
  return true;
}

/** Has this agent been admitted by the resurrector this session? */
export function isAgentAdmitted(agentId: string): boolean {
  return admitted.has(agentId);
}

/** The admitted set. Read-only by type: a caller that could mutate this could unmount a live PTY. */
export function admittedAgents(): ReadonlySet<string> {
  return admitted;
}

/** A monotonically increasing token that changes whenever the admitted set grows. */
export function admittedAgentsVersion(): number {
  return version;
}

/** Subscribe to growth of the admitted set. Returns an unsubscribe fn. */
export function onAdmittedAgentsChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Tests only: forget everything (module state outlives a component tree). Notifies, like every
 *  other writer — a mounted `useSyncExternalStore` consumer that isn't told keeps rendering the
 *  pre-reset snapshot until some unrelated re-render happens to correct it. */
export function resetAdmittedAgents(): void {
  admitted.clear();
  version += 1;
  notify();
}
