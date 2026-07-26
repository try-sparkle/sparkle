// requery — when connectivity returns, nudge every open agent so it reports where it stands.
// PTY (build/worker) agents get the prompt typed into their terminal. Driven by connectionMonitor
// on the offline→online edge. ()
import type { AgentTabStatus } from "@sparkle/ui";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { submitPrompt } from "../pty";
import { defaultStore, type KV } from "./windowRegistry";
import { log } from "../logger";

/** What we send each agent on reconnect. One shared constant so the wording lives in one place. */
export const REQUERY_PROMPT =
  "I'm back online. Can you give me a brief status update on where things stand?";

// PTY statuses where the agent is sitting at its prompt and it's safe to type a new message.
// Excluded on purpose:
//   • working — mid-task; injecting would interleave with its live output
//   • waiting / approval — it has drawn an on-screen prompt expecting a specific answer; a
//     generic status line would be mis-read as that answer (and approval may be a dangerous
//     y/n we must never auto-confirm)
//   • errored / stopped — the process isn't live, so there's nothing to answer
const SAFE_TO_REQUERY: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "idle",
  "blocked",
  "done",
]);

/** True only on a genuine offline→online transition (so re-query fires once, not on boot). */
export function shouldRequery(prev: boolean, next: boolean): boolean {
  return prev === false && next === true;
}

/** Shared-storage key holding the timestamp of the most recent reconnect re-query. */
export const REQUERY_CLAIM_KEY = "sparkle-requery-claim";

/** How long one reconnect re-query suppresses the next. `shouldRequery` makes the edge fire once
 *  PER WINDOW, but connectivity is a property of the machine and the prompt lands in a PTY every
 *  window shares — so the edge is really one event that N windows each observe. Two duplicate
 *  shapes follow, and this window covers both:
 *    • fan-out — every open window's monitor recovers within milliseconds of the others, so one
 *      reconnect types the same status prompt into each agent once per open window;
 *    • flap — a link that bounces crosses the offline→online edge repeatedly, and re-asking an
 *      agent where things stand several times in half a minute tells the user nothing the first
 *      answer didn't.
 *  A minute is far longer than either burst and far shorter than any outage a user would
 *  experience as a second, distinct reconnect worth re-querying for. */
export const REQUERY_CLAIM_WINDOW_MS = 60_000;

/**
 * Claim the right to re-query for this reconnect, machine-wide. Returns false when another window
 * — or an earlier flap in this one — already claimed it inside {@link REQUERY_CLAIM_WINDOW_MS}.
 *
 * Backed by the localStorage every webview shares, which has no compare-and-swap: two windows
 * reading in the same instant can both claim. That collapses the burst rather than eliminating it
 * outright, which is the right trade here — the prompt is a harmless duplicate, so erring toward
 * an occasional extra copy beats a lock that could swallow the re-query entirely.
 */
export function claimReconnectRequery(now: number, store: KV = defaultStore()): boolean {
  try {
    const raw = store.getItem(REQUERY_CLAIM_KEY);
    const at = raw ? Number(raw) : Number.NaN;
    // Compare on absolute distance: a stamp in the FUTURE (clock moved back, or a garbled value)
    // must not wedge re-query off until wall time catches up, so anything outside the window in
    // either direction counts as stale and is reclaimed.
    if (Number.isFinite(at) && Math.abs(now - at) < REQUERY_CLAIM_WINDOW_MS) return false;
    store.setItem(REQUERY_CLAIM_KEY, String(now));
    return true;
  } catch {
    // Storage unavailable (private mode, quota, a shim without the key): fall back to re-querying.
    // A duplicate prompt is recoverable; silently never reporting status on reconnect is not.
    return true;
  }
}

/**
 * The reconnect entry point: claim the machine-wide right to re-query, then do it. Split out of
 * `connectionMonitor`'s `onRecover` so the short-circuit is reachable from a test — the effect
 * that used to hold it needs React and Tauri to run, which is exactly how a fan-out regression
 * would sneak back in unnoticed. `store` is injectable for the same reason.
 */
export async function requeryOnReconnect(now: number, store?: KV): Promise<void> {
  if (!claimReconnectRequery(now, store)) {
    log.debug("connectivity", "back online — re-query already claimed, skipping");
    return;
  }
  log.info("connectivity", "back online — re-querying open agents");
  await requeryOpenAgents();
}

/** Send the status-update prompt to every open agent, gated by PTY status. */
export async function requeryOpenAgents(): Promise<void> {
  const { projects } = useProjectStore.getState();
  const { openAgentIds, status } = useRuntimeStore.getState();
  const open = new Set(openAgentIds);

  for (const project of projects) {
    for (const agent of project.agents) {
      if (!open.has(agent.id)) continue;
      // Isolate each agent: a single dead PTY (a "done"/exited process whose write rejects)
      // must not abort the loop and strand every later agent's re-query.
      try {
        const st = status[agent.id];
        if (st && SAFE_TO_REQUERY.has(st)) {
          await submitPrompt(agent.id, REQUERY_PROMPT);
        }
      } catch (e) {
        log.error("connectivity", `re-query failed for agent ${agent.id}`, e);
      }
    }
  }
}
