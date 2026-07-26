// Lets non-React code re-spawn a specific agent's PTY.
//
// Same tiny-registry shape as paneReadiness / terminalScrollback: each AgentPane registers while
// mounted and unregisters on unmount. The account-switch path needs this because a switch is
// decided globally (an ACCOUNT is running out) but executed per pane, and the pane that must act
// is usually not the one the user is looking at.
//
// Restarting is safe by construction here: the spawn path resumes the agent's Claude session
// (`--resume <id>`), so a re-spawn continues the conversation rather than starting over. Choosing a
// moment when that costs nothing is accountSwitch's job, not this registry's.

const restarts = new Map<string, () => void>();

/** Publish this pane's re-spawn lever. Called by AgentPane while mounted. */
export function registerPaneRestart(agentId: string, restart: () => void): void {
  restarts.set(agentId, restart);
}

/** Drop this pane's entry (unmount). */
export function unregisterPaneRestart(agentId: string): void {
  restarts.delete(agentId);
}

/** Re-spawn an agent's PTY. Returns false when no pane is mounted for it — a closed agent simply
 *  picks up its new account the next time it spawns, so this is a no-op, never an error. */
export function restartPane(agentId: string): boolean {
  const fn = restarts.get(agentId);
  if (!fn) return false;
  try {
    fn();
    return true;
  } catch (e) {
    console.warn("restartPane failed for", agentId, e);
    return false;
  }
}

// ---- which account each live agent is running under -------------------------------------------
//
// The switch path needs this to know WHICH agents have to move. It can't be derived from the pin
// map: most agents auto-pick, so they have no pin, yet they're still running under some account.
// Only the pane knows the account its PTY was actually spawned with.

const paneAccounts = new Map<string, string>();

/** Publish the account this pane's PTY is running under. Called by AgentPane once the account is
 *  chosen for a spawn. */
export function registerPaneAccount(agentId: string, accountId: string): void {
  paneAccounts.set(agentId, accountId);
}

/** Drop this pane's account entry (unmount). */
export function unregisterPaneAccount(agentId: string): void {
  paneAccounts.delete(agentId);
}

/** agentId → accountId for every live pane — the input to `planSwitch`. */
export function paneAccountMap(): Record<string, string | undefined> {
  return Object.fromEntries(paneAccounts);
}

/** The account the most agents are currently running under, or null when nothing is running.
 *  This is the account a switch recommendation is about: switching one nobody uses achieves
 *  nothing, and the busiest one is what's actually consuming the quota. Ties break on the
 *  lexicographically smaller id purely for determinism. */
export function busiestPaneAccount(): string | null {
  const counts = new Map<string, number>();
  for (const accountId of paneAccounts.values()) {
    counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [id, n] of counts) {
    if (n > bestN || (n === bestN && best != null && id < best)) {
      best = id;
      bestN = n;
    }
  }
  return best;
}

/** Test/teardown helper. */
export function clearPaneRestarts(): void {
  restarts.clear();
  paneAccounts.clear();
}
