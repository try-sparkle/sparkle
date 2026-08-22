// ANSWER AN ANSWERABLE PROMPT WHEN IT APPEARS, NOT WHEN THE PANE IS CLICKED.
//
// ── THE REPORT (founder, P0) ────────────────────────────────────────────────────────────────────
// *"clicking an agent pane auto-runs a waiting bash command — a click may be silently answering
// permission prompts."* It is a real PTY write, not a repaint artefact. From one day of production
// logs: of 325 pane switches, 96 were followed within ONE second by an auto-approve keystroke (~24x
// the chance rate) and 151 within two — so 49% of that day's 310 auto-approve decisions landed in
// the window right after a click. The nudger's own writes showed no such enrichment (1.2x), which
// rules out "the app is just busy after a switch".
//
// ── WHY THE CLICK WAS THE TRIGGER ───────────────────────────────────────────────────────────────
// Auto-approve has only ever run inside `useSuggestions`, and the concierge mounts that hook for the
// SELECTED AGENT ONLY (`Concierge/ConciergeSuggestions`, keyed by agent id). Every other agent —
// including the ones whose terminal is mounted and whose scrollback is sitting right there in
// `terminalScrollback` — had nobody reading it. Selecting an agent mounts the hook, the hook reads a
// prompt that has been on screen for minutes, and answers it. The click is not racing the answer; it
// IS the answer's trigger. The gate is pinned by `autoApproveMountGate.test.tsx`.
//
// ── THE DECISION (founder, 2026-08-12) ──────────────────────────────────────────────────────────
// Chosen explicitly over a dwell-timer and over leaving it alone: let the auto-approver see agents
// whose pane is not open, so a prompt in an `always` category is answered the moment it appears,
// decoupled from the click entirely. He accepted the widened blast radius — the app now writes to
// PTYs he is not watching — on the strength of the four constraints below.
//
// ── WHAT THIS DOES AND DOES NOT REACH ───────────────────────────────────────────────────────────
// It reaches every agent this WINDOW is running: mounted-but-unselected (the population the founder
// measured, read from the live viewport) and unmounted-with-a-fresh-capture (read from
// `runtimeStore.attentionScreen`). It does NOT reach an agent in a project never visited this
// session, and that is not a gap left open: unmounting a Terminal kills its PTY and panes mount
// lazily per project (`Workspace`), so such an agent has no process in this window and therefore no
// prompt to answer.
//
// ── FOUR ANSWERERS RIDE THIS PATH, AND THE COUNT KEEPS BEING THE BUG ───────────────────────────
// `maybeAutoTrust` (Claude Code's folder-trust dialog, scoped to Sparkle's own worktrees),
// `maybeAutoPlan` (the plan-exit dialog, `[approvals].plan`), `maybeAutoResume` (the session-resume
// picker, `[approvals].resume`) and `maybeAutoApprove` (permission prompts, per-category rules), in
// that order — see `decide()` for why the order among the first three is a convention while being
// ahead of the fourth is not.
//
// THE FOURTH WAS ADDED WITH THIS PARAGRAPH IN FRONT OF IT, so it was wired into all three call
// sites (here, plus the live path AND the memo-hit fast path in `useSuggestions`) in the same
// commit. Its miss would have been the most expensive of the four: the trust dialog lands on an
// agent's FIRST FRAME, before it has run a single tool, so an unwired answerer means a fleet that
// spawns and does nothing at all.
//
// THE SAME OMISSION HAPPENED TWICE, WHICH IS WHY THIS PARAGRAPH EXISTS. The 2026-08-12 decision
// above ("let the auto-approver see agents whose pane is not open") was implemented for permission
// prompts alone. The plan-exit work later added its answerer here — and walked straight past the
// resume sibling, which still had the ONE `useSuggestions` call site it started with, inside a hook
// the concierge mounts for the SELECTED AGENT ONLY.
//
// IT IS INVISIBLE IN THE WORST WAY. Every other layer of each feature is correct — detector,
// per-project rule resolution, keystroke, unit tests — so the reachability hole presents as
// "configured and silently inert", never as broken: nothing logged, nothing red, no failing test.
// A reader checking whether auto-resume works finds a complete, well-tested implementation and
// concludes that it does. So when you add a FIFTH answerer, the question to ask is not "does my
// detector work" but "which of the two call sites did I wire it into" — the answer must be both,
// plus the memo-hit fast path in `useSuggestions`, which is a third place that is easy to miss
// because it looks like a cache read rather than a decision point.
//
// WHY THE RESUME MISS COST MORE THAN THE OTHERS. This prompt appears on RESTART, and restarts arrive
// in BURSTS. One measured night: every agent's PTY child died inside 150ms and 21 were respawned
// over 80 seconds, all 21 showing the picker, ZERO auto-answered — six pressed by hand, and one
// agent sat red for 35 minutes on a prompt nothing in the app could type into. A per-pane click is
// not a recovery path for a fleet-wide event, which is the same argument the header above already
// makes for permission prompts.
//
// IT IS STILL THE USER'S RULE THAT DECIDES. `maybeAutoResume` returns null for the default "ask",
// so an unconfigured install types nothing here — this widens WHERE a configured rule is honoured,
// never WHAT is authorised. `conciergeHandoff`'s exclusion of resume from the CONCIERGE tier is
// untouched and still correct: that tier answers prompts with no rule behind them, and this one
// answers only prompts that have one.
//
// ── THE FOUR CONSTRAINTS, AND WHERE EACH ONE LIVES ──────────────────────────────────────────────
//  1. STALENESS IS THE MAIN HAZARD. Answering off a stale snapshot types a digit into whatever
//     replaced the prompt. `approvalScreen.approvalScreenFor` is the single gate: its tier (a) reads
//     the LIVE VIEWPORT — never scrollback history (bead sparkle-af831) — refusing a null or
//     alternate-buffer screen, and its tier (b) snapshot path requires a stamp, an age ceiling and a
//     clean movement ledger, failing closed on every uncertain path. This module adds the two checks
//     a reader cannot make for itself: the agent must STILL be in an ask status at the moment of
//     decision (a viewport captured a beat before the human answered can still show the picker), and
//     the screen must be UNCHANGED across a settle window, so a half-painted picker is never decided
//     on.
//  2. NEVER DOUBLE-ANSWER. The de-dupe set is `handledSigs`, shared with the mounted hook — see that
//     module's header for why sharing it is the whole point rather than an optimisation. The click
//     that used to answer the prompt now mounts onto a screen this module already handled, and
//     `maybeAutoApprove` returns the category from its `handled.has(sig)` arm without re-typing, so
//     the pane still shows "Auto-approved …". roborev 53074 and 53159 stay closed.
//  3. THE WRITE DISCIPLINE IS UNCHANGED. This module does not write. It calls the same
//     `maybeAutoApprove`, which types through `pty.writePtyChainedStrict` so a keystroke cannot land
//     inside another writer's paste→CR window (roborev 54369/54375), and Rust's `pty_write` stamps
//     `note_foreign_write`, standing the nudger down for 5s.
//  4. THE MCP VETO STILL APPLIES. `mcpToolPolicy` refuses anything that spawns, discards, merges,
//     pushes or speaks as the founder EVEN IF `mcp = "always"`. It lives inside `maybeAutoApprove`,
//     ahead of the category branch, so it applies to this path by construction — which is the thing
//     standing between "answer prompts I did not read" and real harm.
import { useRuntimeStore } from "../../stores/runtimeStore";
import { maybeAutoApprove, maybeAutoPlan, maybeAutoResume, maybeAutoTrust } from "./approvalsRuntime";
import { approvalScreenFor } from "./approvalScreen";
import { handledSigsFor } from "./handledSigs";
import { log } from "../../logger";
import type { AgentTabStatus } from "../../types";

/**
 * The statuses at which an agent may be sitting on a prompt somebody could answer.
 *
 * DELIBERATELY NARROWER THAN `useSuggestions.YOUR_TURN`, which also carries `idle`, `done` and
 * `errored`. That set gates a set of BUTTONS being offered; this one gates a keystroke, and the two
 * extra statuses mean "this turn is over" — an agent that is done is not holding a picker, and a
 * scrollback tail still showing one is showing history. Narrow is the fail-closed direction: the
 * cost of leaving a status out is that the prompt waits for the click, which is today's behaviour.
 */
const ASK: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>(["waiting", "approval"]);

/**
 * How long a screen must hold still before it may be decided on.
 *
 * The same 1200ms `useSuggestions.SETTLE_TICK_MS` uses, for the same reason and against the same
 * hazard: a terminal repaints a picker over several frames, and "two consecutive identical reads =
 * the terminal has finished painting" is the app's existing definition of settled. Not imported from
 * that module — this one is started at boot from `App.tsx` and must not pull the metered suggestions
 * engine into the initial chunk — so `autoApproveWatch.test.ts` asserts the two constants are equal
 * rather than leaving a copied number to drift.
 */
export const SETTLE_MS = 1200;

/** Agents with a settle timer in flight, and the screen text that armed it. */
const pending = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>();

/** The last status we acted on per agent, so an unrelated store write does not re-serialize every
 *  red agent's 300-line buffer. `undefined` for an agent we have never seen, which schedules once —
 *  that first observation is what covers a prompt already on screen when the app started. */
const seenStatus = new Map<string, AgentTabStatus>();
/** The last capture text we saw per agent, for the same reason: a re-written capture is news, an
 *  identical one is not. */
const seenCapture = new Map<string, string | undefined>();

function cancel(agentId: string): void {
  const p = pending.get(agentId);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(agentId);
}

/**
 * Arm (or re-arm) the settle timer for `agentId`.
 *
 * Re-arming on a CHANGED screen rather than deciding on it is what makes the settle real: a picker
 * mid-paint reads differently each frame, so it keeps pushing the decision out until it stops
 * moving. An identical screen leaves the existing timer alone — otherwise a store that ticks faster
 * than the settle window would push the decision back forever and nothing would ever be answered.
 */
function schedule(agentId: string): void {
  const read = approvalScreenFor(agentId);
  if (read.text === null) {
    cancel(agentId);
    return;
  }
  const prev = pending.get(agentId);
  if (prev && prev.text === read.text) return; // already waiting out the settle on this exact screen
  if (prev) clearTimeout(prev.timer);
  const text = read.text;
  pending.set(agentId, {
    text,
    timer: setTimeout(() => {
      pending.delete(agentId);
      decide(agentId, text);
    }, SETTLE_MS),
  });
}

/**
 * The settle window elapsed. Re-read, and answer only if nothing has changed underneath us.
 *
 * THE STATUS RE-CHECK IS NOT REDUNDANT WITH THE SCREEN READ, and this is the subtlest thing in the
 * module. Tier (a) of the read is now the live VIEWPORT (bead sparkle-af831), which redraws — so the
 * old scrollback-history hazard, where a picker answered by hand seconds ago sat in the tail forever
 * and read as live, is gone from that tier. But the re-check still earns its place across the whole
 * arm→settle window: the tier (b) capture is a SNAPSHOT that can outlive the ask, and even a live
 * viewport read the instant before the human answered can still show the picker until the terminal
 * repaints. The status is the fact that says the agent is still STOPPED, so it is re-checked at the
 * moment of decision and not merely at the moment of arming. `handledSigs` would not save us either:
 * a hand-answered prompt was never added to it.
 */
function decide(agentId: string, textAtSchedule: string): void {
  if (!ASK.has(useRuntimeStore.getState().status[agentId] as AgentTabStatus)) return;
  const read = approvalScreenFor(agentId);
  if (read.text === null) return;
  if (read.text !== textAtSchedule) {
    // Still painting (or new output arrived). Start the settle over on what it says now.
    schedule(agentId);
    return;
  }
  // THE FOLDER-TRUST DIALOG GOES FIRST, and this call site is the one that matters most for it: the
  // dialog lands on an agent's FIRST FRAME, in a freshly-cut worktree, before it has run anything —
  // so there is by definition nobody looking at that pane yet. Wiring it only into the mounted,
  // selected-agent hook would mean a spawned fleet sits idle until each pane is clicked.
  //
  // AHEAD OF ALL THREE SIBLINGS, and that ordering is a safety requirement rather than a reading
  // convention. The dialog satisfies `looksLikePermission` and classifies as `bash`, so leaving it
  // to `maybeAutoApprove` means `bash = "always"` presses "Yes, I trust this folder" for ANY folder.
  // `maybeAutoTrust` claims it either way — answering it only for Sparkle's own managed worktrees,
  // and handing every other folder to the founder unanswered.
  const trust = maybeAutoTrust(agentId, read.text, handledSigsFor(agentId));
  if (trust) {
    log.info(
      "approvals",
      trust === "asked" ? "folder-trust dialog left for a human" : "auto-trusted a managed worktree off-pane",
      { agentId, source: read.source },
    );
    return;
  }
  // THE PLAN-EXIT PROMPT IS ANSWERED HERE TOO, and this is the call site that matters most for it.
  // The prompt lands precisely when an agent has finished thinking and nobody is looking at its
  // pane — the founder's report was an agent sitting on it for hours — so wiring it only into the
  // mounted, selected-agent hook would mean the answer waits for a click. It runs BEFORE
  // `maybeAutoApprove` for the same reason as in `useSuggestions`: that function hands screens it
  // cannot classify to the concierge, and this dialog is one of those by construction.
  const plan = maybeAutoPlan(agentId, read.text, handledSigsFor(agentId));
  if (plan) {
    // `"asked"` is a claim, not an answer: the plan path recognised the dialog and deliberately left
    // it for a human (an explicit `plan = "ask"`, or the founder-only escalation). Either way this
    // screen's fate is decided, so the fall-through to `maybeAutoApprove` — whose unclassified arm
    // would hand it to the concierge — must not happen. Hence the return covers both cases and the
    // log says which one it was.
    log.info("approvals", plan === "asked" ? "plan prompt left for a human" : "auto-answered plan prompt off-pane", {
      agentId,
      mode: plan,
      source: read.source,
    });
    return;
  }
  // THE RESUME SIBLING, AND IT WAS LEFT BEHIND TWICE. The 2026-08-12 decoupling in this module's
  // header was applied to `maybeAutoApprove`; the plan-exit work above then added a THIRD answerer
  // to this same function — and `maybeAutoResume` still had the ONE call site it started with,
  // inside a hook the concierge mounts for the SELECTED AGENT ONLY. Every other layer of auto-resume
  // was already correct (the detector, the per-project rule resolution, the keystroke, their tests),
  // so a configured `resume = "summary"` presented as silently inert rather than as broken: nothing
  // logged, nothing red, and the founder pressing pickers by hand.
  //
  // WHY IT COSTS MORE THAN THE OTHER TWO. This prompt appears on RESTART, and restarts arrive in
  // BURSTS. One measured night every agent's PTY child died inside 150ms and 21 were respawned over
  // 80 seconds, all 21 showing the picker, ZERO auto-answered — six pressed by hand, one agent red
  // for 35 minutes on a prompt nothing in the app could type into. A per-pane click is not a
  // recovery path for a fleet-wide event, which is the argument this module was built on.
  //
  // ORDER: after the plan arm and before `maybeAutoApprove`, matching `useSuggestions` exactly. The
  // first two can never both claim a screen (a resume picker has no Yes/No pair and is not the
  // plan dialog), so the order between them is a reading convention rather than a correctness one;
  // being ahead of `maybeAutoApprove` is NOT — its unclassified arm hands screens to the concierge.
  //
  // IT IS NOT A SECOND AUTHORISATION. `maybeAutoResume` re-reads `[approvals].resume` for this
  // agent's project on every call and returns null for the default "ask", so an unset rule types
  // nothing here just as it types nothing on-pane. This widens WHERE a configured rule is honoured,
  // never WHAT is authorised.
  const resumeMode = maybeAutoResume(agentId, read.text, handledSigsFor(agentId));
  if (resumeMode) {
    // Same audit line, same reason as the two around it: what only this call site knows is WHERE the
    // screen came from, which is the first question anyone reviewing an unwatched write asks. `mode`
    // is load-bearing the way `tool` is on the approve arm — "summary" and "full" have very
    // different costs, so a bare "auto-resumed" cannot answer the question that follows a usage spike.
    log.info("approvals", "auto-resumed off-pane", { agentId, mode: resumeMode, source: read.source });
    return;
  }
  const category = maybeAutoApprove(agentId, read.text, handledSigsFor(agentId));
  if (category) {
    // The audit line for an answer that happened with nobody looking at the pane. `maybeAutoApprove`
    // logs the category and the tool; what only this call site knows is WHERE the screen came from,
    // which is the difference between "read the live terminal" and "read a snapshot up to a minute
    // old" — the first question anyone reviewing an unwatched write will ask.
    log.info("approvals", "auto-approved off-pane", { agentId, category, source: read.source });
  }
}

/**
 * The subscription body, exported so a test can drive it directly — the same shape (and the same
 * reason) as `useSuggestions.onRuntimeStatusChange`.
 *
 * THIS RUNS ON EVERY STORE WRITE OF ANY KIND — a branch-status poll, a workflow stage, a roster
 * tick — so the per-agent change test is not a micro-optimisation. Arming is what READS the screen,
 * and reading the screen serializes up to 300 lines out of an xterm buffer; doing that for every red
 * agent on every unrelated write would put a fleet-sized cost on a store that ticks constantly. An
 * agent is only re-examined when its own status or its own captured screen has changed since we last
 * looked at it. A never-seen agent has `undefined` on both sides, so its first sighting always
 * counts as a change — which is what covers a prompt that was already on screen when we started.
 */
export function onRuntimeChange(state: {
  status: Record<string, AgentTabStatus>;
  attentionScreen: Record<string, string>;
}): void {
  for (const [id, status] of Object.entries(state.status)) {
    const capture = state.attentionScreen[id];
    const statusChanged = seenStatus.get(id) !== status;
    const captureChanged = seenCapture.get(id) !== capture;
    seenStatus.set(id, status);
    seenCapture.set(id, capture);
    // ON ONE LINE so `scripts/mutation-check.sh` can judge it: commenting out the head of a
    // multi-line `if` whose condition is a bare predicate call leaves a dangling block, so the
    // mutation cannot be applied and the guard is one no check can prove is live.
    if (!ASK.has(status)) { cancel(id); continue; }
    if (!statusChanged && !captureChanged) continue;
    schedule(id);
  }
}

let stop: (() => void) | null = null;

/**
 * Start watching every agent for an answerable prompt. Idempotent — StrictMode double-mounts and HMR
 * both call it twice, and two subscriptions would each schedule a settle for the same screen. The
 * de-dupe set makes that harmless rather than a double keystroke, but it is still two timers.
 */
export function startAutoApproveWatch(): () => void {
  if (stop) return stop;
  const unsubscribe = useRuntimeStore.subscribe((state) => onRuntimeChange(state));
  stop = () => {
    unsubscribe();
    for (const id of [...pending.keys()]) cancel(id);
    stop = null;
  };
  return stop;
}

/** Drop every in-flight timer and observation. Tests only — module state outlives a render, and a
 *  leaked settle timer would fire into the next case's stores. */
export function resetAutoApproveWatchForTests(): void {
  for (const id of [...pending.keys()]) cancel(id);
  seenStatus.clear();
  seenCapture.clear();
  if (stop) stop();
}
