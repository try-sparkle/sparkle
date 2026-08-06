// ONE ANSWER TO "IS THE IMPROVE-SPARKLE AGENT MID-PASS", for every surface that must not step on it.
//
// WHY THIS EXISTS. The concierge can now address the app-owned Improve Sparkle agent the way it
// addresses a build agent (bead sparkle-x0pvw). That access is additive on top of a RUNNING system,
// and the system it runs on has an invariant a build agent does not: the interactive pane and the
// hourly HEADLESS pass share ONE worktree, and the app enforces one `claude` per worktree. A
// concierge write delivered while a pass is in flight puts a second mutator in that tree — which is
// exactly the thing the founder asked not to break ("I don't want you to break anything the agent is
// currently doing").
//
// TWO CONSUMERS, ONE RULE, and that is the whole point of the module:
//
//   • the WRITE gate — `sendToAgentTerminal` (conciergeTools/terminal) and the restart/stop
//     lifecycle ops refuse while this returns non-null; and
//   • the READ surface — the Improve Sparkle row `handleGetState` publishes carries this as its
//     `activity`, so the concierge can SEE the agent is busy before it tries.
//
// Split across two call sites these would drift, and the drift is silent in the worst direction: a
// gate that refuses while the roster says "idle" reads to a model as a malfunctioning tool rather
// than a busy agent, and it retries. `hooks/useEffectiveWired` is in this repo for the same reason,
// and the bug THIS module ships alongside is what happens when one of two copies gets a fix.
//
// ── THE ONE-WINDOW ASSUMPTION, STATED RATHER THAN LEFT TO BE DISCOVERED ────────────────────────
// `improvementPass`'s latches are MODULE state, so they describe THIS webview's own in-flight pass
// (the module says so: "it guards a real child process in THIS webview, and must reset with the
// page"). `control:request` is broadcast to EVERY window and whichever replies first answers. There
// is exactly one app window today — `AgentSidebar` spells the Sparkle id through the constant
// `APP_WINDOW_LABEL` for that reason — so the window that answers is the window that runs the pass,
// and this is correct. IF A SECOND WINDOW EVER RETURNS, this reads as "not busy" whenever the
// answering window is not the one passing, and the gate below silently stops gating. The fix then is
// a shared/persisted latch, not a second copy of this predicate.
//
// ── THE LEAF, NOT `improvementPass` ────────────────────────────────────────────────────────────
// This imports the LATCH module, never the pass. `conciergeTools/lifecycle` reads this file,
// `conciergeTools/policy` reads that, and `stores/settingsStore` reads THAT — so anything this file
// imports is acquired by every UI component whose graph reaches the settings store. Importing
// `improvementPass` for the boolean did exactly that, and dragged `sparkleTranscript` and
// `conciergeTools/terminal` in behind it; the header of `improvementPassLatch` records what broke.
import { isPassRunning } from "./improvementPassLatch";

/** Why a write to the Improve Sparkle agent is being held off, or `null` when it is free.
 *
 *  `kind` is the machine-readable half and `detail` the sentence a caller relays to a human. Both
 *  are carried because the concierge is a language model: a code alone gives it nothing to say, and
 *  a sentence alone gives it nothing to branch on. */
export interface SparkleBusy {
  kind: "improvement-pass-running";
  detail: string;
}

/**
 * Is a headless improvement pass mutating the shared worktree right now?
 *
 * ── WHY THIS IS THE ONLY HOLD, AND "THE PANE IS MID-TURN" IS NOT ────────────────────────────────
 * The first cut of this held a send whenever the interactive pane's status read `working` too. That
 * was over-reach, and a pre-existing test said so out loud: "delivers a message to it, exactly as it
 * would to a build agent", seeding the pane as `working` and asserting the message LANDS. Making
 * Improve Sparkle the one agent you cannot type at while it thinks would have been a regression in
 * the parity the reachability work (462c32f79) established, not a safety feature — every other agent
 * in this app accepts a send mid-turn, and there is a queue for exactly that.
 *
 * The invariant is about TWO PROCESSES, not about busy-ness: the pane and the hourly `claude -p`
 * pass share ONE worktree under one-claude-per-worktree. A pane mid-turn is the SAME claude the
 * write is addressed to; a pass in flight is a second one. Only the second is a collision.
 *
 * Dropping the pane arm also retires a staleness bug roborev 58865 found in it: `paneBusySince` has
 * exactly one writer — the improvement scheduler's tick, every five minutes — so a gate built on it
 * refused sends for up to five minutes AFTER a turn ended, with a sentence that told the caller not
 * to retry and elapsed minutes that kept growing off the stale start. `isPassRunning` has no such
 * problem: it is a real in-flight latch, set and cleared around the child process itself.
 *
 * `now` is accepted (and currently unused) so callers can hand this the same clock they use for the
 * fields they render beside it, rather than each reading `Date.now()` independently.
 */
export function sparkleBusyNow(_now: number): SparkleBusy | null {
  if (!isPassRunning()) return null;
  return {
    kind: "improvement-pass-running",
    detail:
      "The Improve Sparkle agent is running its hourly improvement pass, which is mutating its " +
      "worktree. Its interactive pane shares that worktree, so sending now would put a second " +
      "writer in it. The pass stops itself after about 30 minutes; wait for it rather than " +
      "retrying.",
  };
}

/** The `activity` line for the Improve Sparkle row in `get_state`'s roster, or `null` when it has
 *  nothing to say. Deliberately SHORTER than `detail`: the roster is the index, not the article
 *  (`handleGetState` documents that budget), and a caller that wants the full sentence gets it from
 *  the refusal it would otherwise have earned.
 *
 *  It says nothing about the pane being mid-turn, because the row already carries that in `status`
 *  — repeating it here would be a second, staler copy of a fact the row states properly. */
export function sparkleActivityLine(now: number): string | null {
  return sparkleBusyNow(now) ? "running its hourly improvement pass" : null;
}
