// requery — ask an agent what is BLOCKING it, in a form something else can read.
//
// PTY (build/worker) agents get the ask typed into their terminal. Driven by connectionMonitor on
// the offline→online edge () — and, since sparkle-4cd0x, that is no longer the only
// trigger; see below.
//
// ── WHY THE QUESTION CHANGED ─────────────────────────────────────────────────────────────────────
// This used to send "I'm back online. Can you give me a brief status update on where things stand?"
// Four agents answered it, verbatim and well: each wrote a paragraph about what it had read and what
// remained, and then STOPPED — several ending by asking the founder a question back. The prompt asks
// for a report, so it gets a report. An agent that answers it CORRECTLY ends its turn more stuck
// than it started, because it has now spent a turn narrating instead of merging, and one that ends
// by asking a question has converted itself from idle into genuinely waiting on a human.
//
// The ask asks the two questions that move work instead, and requires a fenced block with a
// five-word vocabulary so the answer is parsed rather than read. The wording, the vocabulary, the
// parser and the composer all live together in `@sparkle/core/pusherBlocker`; this module is a
// delivery path and a source of measurements, and decides nothing about what to say.
//
// ── AND IT IS NOT ALWAYS ASKED AT ALL ────────────────────────────────────────────────────────────
// `buildAsk` gets the agent's own previous answer (read back out of its terminal) and what has moved
// since, and may answer with SILENCE. That arm is the point rather than an optimisation: an agent
// that had already reported done-and-landed used to be asked for a status update anyway and spent a
// whole turn saying "same as last check". At fleet scale that is the dominant cost of asking.
//
// ── THE TRIGGER IS NO LONGER JUST THE CONNECTIVITY EDGE ──────────────────────────────────────────
// A stuck agent is stuck whether or not the network blinked, and the case this was rebuilt for — an
// agent dead on an Anthropic 529 — crosses no connectivity edge at all. So the reconnect edge is one
// of two callers: `services/pusherMount` appends `BLOCKER_ASK` to the challenge the Pusher sweep
// sends a partner it has independently measured as stalled, and that sweep is what runs
// continuously. The edge below is kept because a reconnect genuinely is a moment when every agent's
// picture may have gone stale at once, which no per-agent measurement notices.
//
// ── SAFE_TO_REQUERY IS UNCHANGED, AND DELIBERATELY SO ────────────────────────────────────────────
// The exclusions below are MORE important now, not less. The old prompt was a generic status line; a
// blocker-asking prompt is longer and carries an instruction to act, so misdelivering it into a
// `waiting`/`approval` screen — where it would be read as the answer to an on-screen prompt — is
// worse than it was. Nothing about the new wording relaxes any of it.
import type { AgentTabStatus } from "@sparkle/ui";
import { BLOCKER_ASK, buildAsk, parseBlockerReport } from "@sparkle/core";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { submitPrompt, PtyGoneError } from "../pty";
import { defaultStore, type KV } from "./windowRegistry";
import { log } from "../logger";
import { getAgentScrollback } from "./terminalScrollback";

/**
 * What we send each agent. One shared constant so the wording lives in one place — and that place is
 * `@sparkle/core`, because the Pusher sends the same text and the parser that reads the answer has
 * to be pinned to the same vocabulary the ask advertises.
 */
export const REQUERY_PROMPT = BLOCKER_ASK;

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

/**
 * What we knew about an agent the last time we asked it anything — the other half of `buildAsk`.
 *
 * Module-level and deliberately NOT persisted: it exists to suppress a redundant question, and the
 * safe direction on a cold start is to ask once. A restored map could suppress the first ask of a
 * session against a picture taken before the app was closed.
 */
const lastSeen = new Map<string, AgentFingerprint>();

/**
 * When we last asked each agent anything, epoch ms.
 *
 * Separate from {@link lastSeen} because it answers a different question and must survive a pass
 * that observed the agent and said nothing: `lastSeen` advances every pass, this one only when a
 * message actually goes out. Feeds `buildAsk`'s expiry, which is what stops a wrong `terminal`
 * reading silencing an agent forever.
 */
const lastAskedAt = new Map<string, number>();

/**
 * Test seam: forget both per-agent maps.
 *
 * REQUIRED IN `beforeEach`, not optional hygiene. These maps are module-level and outlive a test, so
 * without this a case inherits another's stamps — and the failure is not a red test, it is a GREEN
 * one passing for the wrong reason: a stamp taken with the real clock makes `now - askedAt` hugely
 * negative under a faked clock, and an assertion about first contact then holds only because leaked
 * fingerprint state happened to manufacture a "change" (roborev 57711).
 */
export function _resetRequeryMemoryForTests(): void {
  lastSeen.clear();
  lastAskedAt.clear();
}

interface AgentFingerprint {
  status: AgentTabStatus;
  goalMetAt: number | undefined;
  ahead: number | undefined;
  behind: number | undefined;
  dirty: boolean | undefined;
}

function fingerprint(agentId: string, status: AgentTabStatus): AgentFingerprint {
  const agent = useProjectStore
    .getState()
    .projects.flatMap((p) => p.agents)
    .find((a) => a.id === agentId);
  const branch = useRuntimeStore.getState().branchStatus[agentId];
  return {
    status,
    goalMetAt: agent?.goal?.metAt,
    ahead: branch?.ahead,
    behind: branch?.behind,
    dirty: branch?.dirty,
  };
}

/**
 * What moved since the last ask, as digit-free sentences.
 *
 * DIGIT-FREE IS A CONSTRAINT, NOT A STYLE — see `AskInput.changes`. "main moved 12 commits" would
 * fail `checkCitations` if this text ever rides a Pusher challenge, and the agent would receive
 * nothing at all. The count is also the least useful part: what an agent does about a moved main is
 * the same whether it moved by one commit or forty.
 *
 * An UNKNOWN reading on either side yields no sentence. A branch poll that has not run is not
 * evidence of movement, and manufacturing a change out of missing data is how a nudge becomes noise
 * — the same fail-closed rule `pusherSnapshots` applies to `hasUnlandedWork`.
 */
function changesSince(prev: AgentFingerprint, now: AgentFingerprint): string[] {
  const out: string[] = [];
  const moved = (a: number | undefined, b: number | undefined) =>
    a !== undefined && b !== undefined && a !== b;

  if (moved(prev.behind, now.behind)) out.push("main has moved since you last looked");
  if (moved(prev.ahead, now.ahead)) out.push("your branch has new commits since you last looked");
  if (prev.dirty === true && now.dirty === false) out.push("your worktree is clean now");
  if (prev.goalMetAt === undefined && now.goalMetAt !== undefined) out.push("your goal is marked met");
  if (prev.status !== now.status) out.push(`your pane went from ${prev.status} to ${now.status}`);
  return out;
}

/**
 * Was this agent, as far as we can tell, FINISHED — goal met and nothing unlanded?
 *
 * FAIL-CLOSED TOWARD ASKING. Every `undefined` reads as "not terminal", so an agent we cannot see
 * clearly is asked rather than silently skipped. The cost of a wrong `true` is the founder's own
 * failure mode inverted: an agent that is genuinely stuck is never spoken to again, which is far
 * worse than the wasted turn this suppression exists to save.
 */
function looksTerminal(f: AgentFingerprint): boolean {
  return f.goalMetAt !== undefined && f.ahead === 0 && f.dirty === false;
}

/**
 * Ask every open agent what is blocking it — but only where the question is worth a turn.
 *
 * ── THE SUPPRESSION IS THE FEATURE (sparkle-4cd0x) ───────────────────────────────────────────────
 * Founder, on a real exchange: an agent that had already reported done-and-landed was asked for a
 * status update anyway, and spent a whole turn saying *"same as last check: everything is done and
 * landed."* His reading is the right one — *"The second is not a bad ANSWER; it is a bad QUESTION."*
 * At fleet scale, re-asking finished agents is the dominant cost of asking at all, and it buys
 * nothing.
 *
 * So each agent's own previous answer is READ BACK out of its terminal and diffed against what we
 * knew, and `buildAsk` decides between three outcomes: say nothing, name the blocker it already
 * gave us, or lead with what changed. All of it is arithmetic and string comparison — no model call,
 * which is what keeps this working during the outages it most needs to survive.
 */
export async function requeryOpenAgents(): Promise<void> {
  const { projects } = useProjectStore.getState();

  for (const project of projects) {
    for (const agent of project.agents) {
      // Re-read liveness + status from the LIVE store immediately before each write, never from a
      // snapshot captured at the top of the pass. `submitPrompt` awaits, so the loop yields between
      // agents; a window close / worktree removal / spin-down that lands in that gap tears the PTY
      // down (runtimeStore.close() drops the id from openAgentIds), and the not-yet-sent re-queries
      // for that agent must be CANCELLED rather than fired into a dead PTY (sparkle-rsx4).
      const rt = useRuntimeStore.getState();
      if (!rt.isOpen(agent.id)) continue;
      const st = rt.status[agent.id];
      if (!st || !SAFE_TO_REQUERY.has(st)) continue;

      // COMPOSE THE ASK, OR DECIDE NOT TO ASK. Read after the status gate, so nothing is computed
      // for an agent we were never going to write to.
      const now = fingerprint(agent.id, st);
      const prev = lastSeen.get(agent.id);
      const scrollback = getAgentScrollback(agent.id);
      const previous = scrollback === null ? undefined : parseBlockerReport(scrollback, Date.now());
      const askedAt = lastAskedAt.get(agent.id);
      const prompt = buildAsk({
        ...(previous !== undefined ? { previous } : {}),
        terminal: looksTerminal(now),
        changes: prev === undefined ? [] : changesSince(prev, now),
        // Absent until we have actually asked once — `buildAsk` treats unknown as "never asked" and
        // declines to go silent, which is the direction that cannot strand an agent.
        ...(askedAt !== undefined ? { msSinceLastAsk: Date.now() - askedAt } : {}),
      });

      // THE PICTURE ADVANCES EVEN WHEN WE SAY NOTHING, and getting this backwards is the subtle
      // failure: leaving the old fingerprint in place would make the NEXT pass diff against a stale
      // reading and report the same "main has moved" forever. What we saw is a fact about this
      // moment regardless of whether it earned a message — the same rule the Pusher's
      // two-observation memory applies when it stays quiet.
      lastSeen.set(agent.id, now);

      if (prompt === undefined) {
        log.debug(
          "connectivity",
          `no ask for agent ${agent.id} — it reported finished and nothing has changed`,
        );
        continue;
      }
      // Isolate each agent: a single dead PTY (a "done"/exited process whose write rejects)
      // must not abort the loop and strand every later agent's re-query.
      try {
        // `machine: true` — NOBODY TYPED THIS. A re-query is fired automatically on an offline→online
        // transition, and SAFE_TO_REQUERY deliberately includes `blocked`, so this lands on exactly
        // the quota-walled rows. Claiming human presence here cleared the wall and repainted the row
        // green — the self-concealing loop, re-entered through a different door.
        await submitPrompt(agent.id, prompt, { machine: true });
        // Stamped only on a write that did not throw, so a dead PTY does not start the silence
        // clock for an agent that was never actually asked.
        lastAskedAt.set(agent.id, Date.now());
      } catch (e) {
        if (e instanceof PtyGoneError) {
          // Expected lifecycle race, not a failure: the agent's PTY was reaped between the status
          // read and the write — a "done"/idle pane whose process has already exited. Treat it as
          // TERMINAL. Mark the agent `stopped` (a calm, GRAY, non-red state — the process simply
          // isn't running) so it drops out of SAFE_TO_REQUERY and no later reconnect re-queries the
          // dead PTY again, and log at DEBUG so this expected race stays out of the ERROR stream
          // (it was spamming one ERROR per gone agent per reconnect — sparkle-rsx4).
          useRuntimeStore.getState().setStatus(agent.id, "stopped");
          log.debug("connectivity", `re-query skipped — agent ${agent.id}'s PTY is already gone`);
        } else {
          // A genuine, unexpected write failure — still worth the ERROR stream.
          log.error("connectivity", `re-query failed for agent ${agent.id}`, e);
        }
      }
    }
  }
}
