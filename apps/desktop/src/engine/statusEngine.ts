// statusEngine (spec §6): turns a raw PTY stream into the agent tab status taxonomy,
// which the UI collapses to three colors (green=working, red=needs-you, gray=inactive).
//
// GREEN (working) comes from Claude Code's own "working" indicator: while it is actually
// busy (thinking or running a tool) it prints a live status line — "… esc to interrupt" —
// re-drawn about once a second. We treat that spinner as the authoritative working signal
// so a long, quiet tool run never looks stalled, and its disappearance means the turn
// ended. When the spinner stops (the turn settles), we read the RENDERED screen snapshot
// and ask `screenAwaitsInput`: a question/approval menu on screen → red (it needs your
// answer), anything else → gray (the turn is simply done). Classifying the clean rendered
// screen — not the ANSI-noisy raw stream — is what makes red-vs-gray reliable. Heuristic +
// retrainable: if the spinner is never seen we fall back to legacy time-based stall timers
// (which also settle through the screen check), so nothing regresses.
//
// Transitions:
//   spawn                         -> working
//   spinner present               -> working   (re-arm the "spinner gone" settle timer)
//   spinner gone > SPINNER_GRACE  -> settle: waiting/approval if a question is on screen,
//                                              else idle (turn done — gray)
//   a prompt appears mid-stream   -> waiting    (or approval, if a risky action was seen)
//   process exits                 -> done       (or errored, if errors were seen)
// Fallback when the spinner is never observed (TUI drift / non-Claude program):
//   output flowing                -> working
//   quiet > IDLE_MS               -> settle (screen check, as above)
//   quiet > SCREEN_RECHECK_MS     -> re-read the screen; red only if a prompt is NOW on it
// Note what is NOT in that list: quiet alone never produces a red. It used to produce `blocked`,
// and that single line was responsible for a fleet of false "needs you" alarms — see
// SCREEN_RECHECK_MS for the case history.
//
// EVERY transition above is logged, once, from `set()` — the single funnel they all pass through.
// See ./statusTransitionLog for the line format and the one grep that replays an agent's history;
// `set` takes the TRIGGER as a required argument, so a transition added here later cannot reach the
// UI without saying why it fired.
import { classifyLine } from "@sparkle/core";
import type { AgentTabStatus } from "@sparkle/ui";
import { isSessionLimitPicker, screenAwaitsInput } from "./screenClassifier";
import { screenOffersAnswer, streamOffersAnswer } from "./screenAnswerable";
import { withScreenReason, type StatusReason } from "./statusRouter";
import { forgetAgent, noteProcessExit, noteSpinnerSeen, trackAgent } from "./turnEndAuthority";
import { StreamFailureDetector, apiErrorFramesIn, countApiErrorFrames } from "./streamFailure";
import type { Terminator } from "./deathRecord";
import { type QuotaBlock, isQuotaBlocked, quotaBlockIn, quotaBlocksIn } from "./quotaBlock";
import {
  logStatusTransition,
  monotonicNow,
  type ScreenVerdict,
  type StatusTransitionTrigger,
} from "./statusTransitionLog";

// Strip ANSI/control sequences before classifying (xterm still renders the raw bytes).
// Built from a string with \u escapes so the source stays paste-safe (no literal ESC).
// Matches CSI/OSC-style sequences introduced by ESC, plus any stray ESC chars.
// eslint-disable-next-line no-control-regex
const ANSI = new RegExp("\\u001b[\\[\\]()#;?]*[0-9;]*[@-~]|\\u001b", "g");
function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}


// Mid-stream input detection flips to red the instant a prompt streams past, ~2s before
// the settle screen-check would. It runs the SAME classifier as settle (`screenAwaitsInput`
// — one source of truth, zero duplicated markers), so it keys only off true interactive
// prompts (the ❯ menu, (y/n), passphrase…). It deliberately does NOT match conversational
// prose like "Do you want to proceed?": Claude ends think turns with exactly that
// phrasing, and treating it as a blocking prompt is the false-red this whole change exists
// to kill. A real prompt always carries an interactive marker, which we do catch.
const ERROR_PATTERNS: RegExp[] = [
  /\bpanic\b/i,
  /fatal error/i,
  /command not found/i,
  /\bEACCES\b/i,
  /unhandled exception/i,
  // Narrow: only a line that BEGINS with an error marker. Claude prints "Error:"
  // conversationally mid-sentence; matching that would mislabel clean sessions.
  // `m` so `^` anchors at each line start (ingest tests per-line, but this is robust
  // if ever run against a multi-line chunk).
  /^\s*error[:\s]/im,
  /^\s*(uncaught )?(type|reference|syntax|range)error\b/im,
  /traceback \(most recent call last\)/i,
];

// Claude Code's live "working" status line, re-drawn ~once a second while a turn is running. Two
// shapes have shipped, and BOTH must read as working:
//
//   today (>= ~2.1.218):  "✢ Metamorphosing… (40m 17s · ↓ 66.9k tokens)"
//   legacy:               "✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)"
//
// This was `[/esc to interrupt/i]` alone, tested against the WHOLE chunk. Claude Code then moved
// that hint off the status line and into the persistent footer bar, which broke the signal in both
// directions at once — and the suite stayed green, because every fixture here carried the old fused
// shape (2026-07-28).
//
//   * FALSE GRAY: once spinner mode is latched, only a marker frame re-arms the settle timer. The
//     status line redraws every second carrying no marker, so ~2s into every turn the engine
//     recorded `idle` — a gray dot on a plainly working agent. That `idle` also opens the CTA gate
//     (useSuggestions' YOUR_TURN set), which is how "Merge PR"/"Close Build Agent" came to be
//     offered over live work, and it pins `isInMotion` false, which removes the in-motion
//     suppression on the worker-red bubble in workerAttention.ts.
//   * FALSE GREEN, the more dangerous one: the footer carries the hint whether or not a turn is
//     running, so a whole-chunk match reads persistent chrome as proof of work and would pin every
//     agent green forever — hiding a real question behind a healthy-looking dot.
//
// So the marker is now the SHAPE OF THE STATUS LINE, matched per redraw frame (see isSpinnerFrame):
// the leading spinner glyph, plus a parenthetical carrying an elapsed clock and/or the token
// counter. "esc to interrupt" survives as one accepted tail so older Claude builds keep working,
// but it only counts ON a glyph-led frame — never on its own, which is what keeps the footer out.
//
// Retune point, like screenClassifier's markers: this tracks a Claude Code TUI detail that drifts.
// Add a fixture in TODAY's shape whenever it moves, or a green suite will again say nothing.

/** The rotating glyphs Claude leads its transient status line with. Kept in step with
 *  engine/composerOcclusion.ts's SPINNER_GLYPH — the two answer the same question about the same
 *  line, and letting them drift apart is how one of them silently stops matching. */
const SPINNER_GLYPH = /^\s*[✻✽✢✶✳·*∗+]\s/;

/** The parenthetical the status line carries: an elapsed clock ("(12s", "(40m 17s", "(3m"). */
const SPINNER_ELAPSED = /\(\s*(?:\d+\s*h\s*)?(?:\d+\s*m\s*)?\d+\s*s\b|\(\s*\d+\s*m\b/;

/** Accepted tails for a glyph-led frame. The token counter is the strongest of these — it only
 *  climbs while the model is generating — and `esc to interrupt` is the legacy shape. */
const WORKING_PATTERNS: RegExp[] = [SPINNER_ELAPSED, /\d+(?:\.\d+)?\s*[km]?\s*tokens/i, /esc to interrupt/i];

/** Is ONE redraw frame Claude's live status line? Glyph-led AND carrying a clock/counter/legacy
 *  tail. Feed it a single frame — never a whole chunk: the glyph is anchored, so a chunk whose
 *  FIRST line happens to start with "* " (a markdown bullet, a diff line) would otherwise license
 *  every tail match anywhere in it. `hasSpinnerFrame` does the splitting for you. */
export function isSpinnerFrame(frame: string): boolean {
  return SPINNER_GLYPH.test(frame) && WORKING_PATTERNS.some((re) => re.test(frame));
}

/** Does this cleaned chunk contain a live status-line redraw? The spinner redraws in place with
 *  carriage returns, so one chunk holds several frames plus ordinary prose; we split and ask
 *  per-frame rather than testing the whole chunk, which is what keeps the persistent footer — and
 *  prose that merely mentions "12s" or "30k tokens" — from reading as a running turn. */
function hasSpinnerFrame(chunk: string): boolean {
  return chunk.split(/[\r\n]/).some(isSpinnerFrame);
}

// The spinner also carries a live token counter — "↑ 1.2k tokens", "↓ 2.1k tokens" — that only
// climbs while the model is ACTIVELY GENERATING. Parse the number (k → ×1000, m → ×1000000) so a
// strictly-higher count between frames can serve as positive proof of forward progress (see the
// token-advance recovery in ingest). Returns null when the frame carries no token figure (some
// spinners omit it), in which case the token signal simply doesn't apply and the other recovery
// paths still hold. Feed it ONE spinner frame — never a whole chunk: the pattern is unanchored, so
// prose that merely mentions "30k tokens" would otherwise read as the counter and could clear a
// sticky failure (roborev on da7c80c). `latestSpinnerTokens` below is the live path; it does the
// frame-splitting for you.
// Retune point: like WORKING_PATTERNS, this tracks a Claude Code TUI detail that may drift.
const SPINNER_TOKENS = /(?:↑|↓)?\s*(\d+(?:\.\d+)?)\s*([km])?\s*tokens/i;
// `| undefined` is deliberate: under noUncheckedIndexedAccess an unknown suffix reads as undefined,
// and the `?? 1` below turns that into "no scaling" rather than a silent NaN that would compare false
// in every advance check and quietly disable the recovery (roborev 46783).
const TOKEN_SUFFIX_SCALE: Record<string, number | undefined> = { k: 1_000, m: 1_000_000 };
export function parseSpinnerTokens(spinnerFrame: string): number | null {
  const m = SPINNER_TOKENS.exec(spinnerFrame);
  if (!m?.[1]) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const scaled = n * (TOKEN_SUFFIX_SCALE[m[2]?.toLowerCase() ?? ""] ?? 1);
  return Number.isFinite(scaled) ? Math.round(scaled) : null;
}

// The token figure from the NEWEST spinner frame in a cleaned chunk that actually carries one. The
// spinner redraws in place with carriage returns, so one chunk can hold several frames AND ordinary
// prose: walking BACK over the frames means (a) the count we read is the most recent one, not a stale
// earlier redraw, and (b) prose is never mistaken for a spinner frame, so "compacted 30k tokens" in
// the same chunk can't be read as the counter (roborev on da7c80c). Walking PAST figure-less frames
// matters because Claude drops the counter from some redraws: stopping at the newest marker frame
// alone would read null and skip both the comparison AND the baseline update for that chunk, silently
// delaying recovery (roborev 46783).
export function latestSpinnerTokens(chunk: string): number | null {
  const frames = chunk.split(/[\r\n]/);
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i] ?? "";
    if (!isSpinnerFrame(frame)) continue;
    const tokens = parseSpinnerTokens(frame);
    if (tokens !== null) return tokens;
  }
  return null;
}

const IDLE_MS = 2500;
// A LATE SECOND LOOK AT THE SCREEN — not a stall verdict. This used to be BLOCKED_MS: 25s of PTY
// silence flipped the row to `blocked`, which is RED and captioned "Blocked / stalled — needs you"
// (engine/attention.notificationFor), bubbled to the parent row (engine/workerAttention) and pushed
// as a needs-you card by the concierge (services/conciergeRecap). Silence is not evidence of ANY of
// that. A long `pnpm test`, a `roborev wait`, a CI poll and a model thinking between tool calls are
// all silent, and so is a finished agent parked at its idle prompt — which is how a fleet of healthy
// agents came to raise a needs-you alarm apiece (2026-07-28: an agent observed flapping
// working↔blocked while it was demonstrably running shell commands with an empty prompt on screen,
// and every alarm cleared the moment the pane was clicked — the reveal resizes the PTY, Claude
// redraws, and fresh output re-classified the row).
//
// The screen-check at settle had ALREADY answered the question 22.5s earlier ("no prompt is on
// screen → gray"), and nothing new is observed in between, so escalating that same unchanged screen
// to red was incoherent as well as wrong. What remains worth doing at this mark is re-READING the
// screen: xterm renders asynchronously, so a prompt that streamed in just before settle can paint
// after it, and that is a real red this catches late rather than never. `blocked` is therefore no
// longer inferred here at all — a genuine mid-stream wedge still goes red via the evidence-based
// StreamFailureDetector (`errored`), which keys off API banners and self-prompt churn rather than
// off a quiet terminal.
const SCREEN_RECHECK_MS = 25000;
// Spinner ticks ~1/s; if we don't see it for this long the turn has ended.
const SPINNER_GRACE_MS = 2000;
// How many ingested lines the "the user just submitted a message" echo-suppression window lasts
// (Fix 2). Bounded so it can't permanently mask a LATER genuine wedge: after this many lines with
// no further user input (and no progress event, which also clears it), detection re-arms fully.
const USER_INPUT_ECHO_WINDOW_LINES = 200;
// Below this noted-text length, echo suppression uses exact line equality only — a 1-2 char user
// message must not broadly suppress detection via a bare substring match (roborev).
const ECHO_SUBSTRING_MIN_CHARS = 8;
// Cap the unterminated-line buffer. The spinner redraws without a trailing newline, so
// `partial` would otherwise grow for the whole turn (memory + O(n^2) prompt scans). Prompt
// and spinner markers are short, so a bounded tail keeps detection intact.
const MAX_PARTIAL = 4096;

// ── The session-limit picker announcement ───────────────────────────────────────────────────────
//
// The RECOVERY side of this (W-RESUME) needs to know which agent is parked on Claude Code's
// session-limit dialog, and it must learn that WITHOUT importing `screenClassifier` — the two units
// are deliberately disjoint, and a recovery service that reached into the classifier would couple
// its safety analysis to a matcher it does not own. So detection announces, and recovery listens.
//
// TWO EQUIVALENT CHANNELS, one announcement:
//   - `sparkle://session-limit-picker` on `window`, the contract's named event (PRD §6c);
//   - `onSessionLimitPicker`, an in-process subscription, because most of this engine's tests (and
//     any non-DOM caller) run under vitest's default `node` environment where `window` is absent.
// Both carry the same detail. Guarded so a node context announces to subscribers and simply skips
// the DOM half rather than throwing on a hot path.
//
// EDGE-TRIGGERED. It fires when a screen read first sees the picker, not on every settle, so a
// listener gets one event per episode. The screen going quiet re-arms it, so a picker that comes
// back after a failed resume announces again — which is exactly the signal a verify loop needs.

/** DOM event name for "this agent is parked on Claude Code's session-limit picker".
 *
 *  RE-EXPORTED, not re-declared: `services/sessionLimitScreen.ts` owns the string, because that is
 *  the module `nudge_gate.rs` reads at `cargo test` time. Two `const`s that happen to spell the
 *  same event are two things to keep in step, and this one is observable from the DOM. */
export { SESSION_LIMIT_PICKER_EVENT } from "../services/sessionLimitScreen";
import { SESSION_LIMIT_PICKER_EVENT as PICKER_EVENT } from "../services/sessionLimitScreen";

/** Payload of {@link SESSION_LIMIT_PICKER_EVENT} and of {@link onSessionLimitPicker}. */
export interface SessionLimitPickerDetail {
  agentId: string;
  /** Epoch ms the screen read that saw it. */
  at: number;
}

const sessionLimitPickerSubs = new Set<(d: SessionLimitPickerDetail) => void>();

/** Subscribe to session-limit-picker detections. Returns an unsubscribe. */
export function onSessionLimitPicker(fn: (d: SessionLimitPickerDetail) => void): () => void {
  sessionLimitPickerSubs.add(fn);
  return () => {
    sessionLimitPickerSubs.delete(fn);
  };
}

function announceSessionLimitPicker(detail: SessionLimitPickerDetail): void {
  // Snapshot the set: a listener that unsubscribes itself must not perturb this iteration, and one
  // that throws must not silence the rest (or the DOM half below).
  for (const fn of [...sessionLimitPickerSubs]) {
    try {
      fn(detail);
    } catch {
      /* a listener's failure is not this engine's news */
    }
  }
  if (typeof window !== "undefined" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent(PICKER_EVENT, { detail }));
  }
}

export interface StatusEngineOpts {
  agentId: string;
  onStatus: (s: AgentTabStatus) => void;
  // Returns a plain-text snapshot of the *rendered* terminal screen (the visible xterm
  // grid). Read on settle to decide red (a question is on screen) vs gray (a finished
  // turn). Optional: without it, settle falls back to gray/idle.
  getScreen?: () => string;
  /**
   * Something happened that ENDS this agent's session, as far as the transport can tell.
   *
   * THE ENGINE REPORTS THE TERMINATOR AND NOTHING ELSE. It does not classify the death, and it
   * emphatically does not reach into a store to find out — `services/deathRecordWriter` gathers the
   * observation and `engine/deathRecord.classifyDeath` decides. That split is not tidiness: this
   * engine is constructed per pane with a live `xterm` in its closure and is unit-tested by feeding
   * it bytes, so a store read here would make every one of those tests depend on app state, and
   * `classifyDeath`'s Gate 0 (the one that stops "no pane in this window" being written down as
   * "healthy") only works because the caller is forced to state the liveness it observed.
   *
   * EDGE-TRIGGERED for `quota-trip`, level-triggered for `pty-exit`. A wall matches on every line
   * the agent reprints it on, and firing per line would rewrite the durable record dozens of times
   * for one incident; a PTY exits once.
   */
  onDeath?: (o: { terminator: Terminator }) => void;
}

// `approval` PROMISES A BUTTON — so it may only be claimed when one is actually on screen.
//
// The band `approval` renders as "Approve?" and points the human at a dialog. `screenAwaitsInput`
// cannot support that claim on its own: it is true on THREE signals (the `❯ 1.` cursor, the picker
// FOOTER ALONE, or a bare shell prompt like `(y/n)`), and only the first implies pressable options.
// A footer whose option block has scrolled out of the parse window satisfies it while the option
// parser returns [] — precisely the state the founder hit on two agents at once: `status:
// "approval"` with `read_picker_options` answering `present: false, options: []`. A row that looks
// actionable and is not is worse than a plain red — the human taps it, finds nothing, and stops
// trusting the dot.
//
// The predicate lives in `engine/screenAnswerable.ts`. It IS the canonical footer-anchored option
// parser (`heuristics.pickerBlockBounds`), plus the two checks that parser does not make: the run
// must belong to THIS footer (carry the cursor or abut it) and the footer must still be live. Its
// own module because heuristics imports PICKER_FOOTER from screenClassifier, so reusing the parser
// inside screenClassifier would be an import cycle.
//
// DIRECTION OF THE DOWNGRADE: `approval` → `waiting`, NEVER → calm. Both bands are red and both are
// covered by `attention.needsAttention()`, so the agent still pages the human and no question is
// silenced. screenClassifier's header calls an unrecognized prompt (a blocked agent nobody is told
// about) strictly worse than a false red; that ordering is preserved here, because this narrows
// WHICH red is claimed, never whether one is.
function offersPressableOptions(snapshot: string | undefined): boolean {
  return screenOffersAnswer(snapshot ?? "");
}

export class StatusEngine {
  private partial = "";
  private status: AgentTabStatus = "working";
  // The reason accompanying `status`, part of `set`'s dedup key — see set().
  private statusReason: StatusReason | null = null;
  // Was the session-limit picker on the LAST screen this engine read? Edge-detection state for the
  // announcement only (see announceSessionLimitPicker): the row's own persistence is the router's
  // latch, which holds past the picker leaving the screen. This one tracks the screen itself, so a
  // picker that returns after a failed resume announces again.
  private sawSessionLimitPicker = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;
  // Latched by dispose(). A disposed engine must go completely silent: its PTY listener is torn
  // down over an ASYNC Tauri unlisten, so a `pty:exit` from its own kill can still arrive after the
  // pane remounted — and this engine's `set()` would then overwrite the LIVE agent's status with a
  // terminal `done`/`errored`, which opens the destructive-op gate on its own (roborev 55076).
  private disposed = false;
  private sawRecentRisk = false;
  // STREAM-SIDE evidence that a menu is painting: an option row ("❯ 1. Yes") went past in the
  // ingested lines. Parallel to `sawRecentRisk` and consumed on the same boundaries, because the
  // mid-stream prompt path detects its prompt in the STREAM and so must read its option evidence
  // there too. The viewport check cannot serve that path: rows arrive one at a time and a completed
  // line has already left `this.partial`, so there is nothing left to count by the time the band is
  // chosen. Requires the CURSOR form (`❯ 1. …`), not any numbered row, so ordinary markdown list
  // items streaming past cannot arm the approval band. CLEARED AT EVERY SITE `sawRecentRisk` is
  // cleared — settle, the late re-check, noteUserInput, and the mid-stream path — because a single
  // missed site lets stale evidence re-pin `approval` through the carry branch, which does not
  // itself require risk. That asymmetry was the bug in the first draft of this change.
  private sawRecentOptionRow = false;
  // The risk flag as it stood at the LAST settle, kept alive for `recheckScreen` alone — settle
  // consumes `sawRecentRisk`, so the re-check 22.5s later has nothing left to read. See settle().
  private settledTurnRisk = false;
  private sawRecentError = false;
  // Sticky: once we've seen Claude's spinner we trust it over the time heuristic.
  private sawSpinner = false;
  // Sticky (sparkle-pqxh): the stream is mid-stream FAILED/STALLED — an API-error banner the agent
  // kept churning under, or a self-prompt loop. Unlike `sawRecentError` (a one-shot flag consumed at
  // exit/settle), this drives a live RED `errored` WHILE the process is alive, and it OVERRIDES the
  // spinner: the bug is precisely that the spinner keeps ticking while the agent is wedged. Cleared
  // only by real forward progress (a classified tool/file event) or a real interactive prompt.
  private sawStreamFailure = false;
  // WHICH shape of failure latched `sawStreamFailure`, because only one of them is safe to clear on
  // token progress (roborev on da7c80c):
  //   "api"   — a transient API/server banner. The request failed; nothing was generated under it, so
  //             a climbing token counter is genuine proof the agent recovered and is generating again.
  //   "churn" — a self-prompt loop or a repeating-line churn wedge. A wedged agent GENERATES its own
  //             pings, so its token counter climbs too; token progress here proves nothing and must
  //             NEVER clear the red. Only real progress (a classified tool event), a real prompt, or
  //             user input clears a churn wedge — the original sparkle-pqxh contract.
  //   "quota" — an ACCOUNT limit (session window or spend cap). Like churn it is NOT token-clearable
  //             — the never-idle auto-resume types a goal banner, the agent re-hits the wall, and the
  //             spinner counts the tokens that produced the refusal — but unlike either of the others
  //             it is not an ERROR: nothing crashed and nothing needs debugging, the agent is barred
  //             until a stated wall-clock time. So it paints `blocked` ("needs you to unstick it")
  //             rather than `errored`, which is the honest band and the one the founder asked for.
  // "quota" outranks BOTH: it is the most specific reading available and the only one carrying an
  // actionable time, so a later generic banner must never overwrite it with a vaguer verdict.
  private failureKind: "api" | "churn" | "quota" | null = null;
  // The account-limit evidence itself (message verbatim + reset instant), so the surfaces that answer
  // "why" — get_agent_status, the stall report, the auto-resume backoff — read ONE observation rather
  // than each re-deriving it from text. Outlives the sticky red on purpose: the red clears on real
  // progress, whereas the WALL is a fact about the clock and expires only when `resetAt` passes.
  private quotaBlock: QuotaBlock | null = null;
  /**
   * The API-error banner this agent is CURRENTLY sitting in, verbatim, and when it arrived.
   *
   * Mirrors {@link quotaBlock} deliberately — same capture points, same verbatim rule — because it
   * answers the same shape of question for a different wall. `pusherFleet.sharedFailureCohorts`
   * groups agents by this exact string to recognise that one host event killed several of them at
   * once, which only works if nothing here normalises it.
   *
   * UNLIKE the quota block, this CLEARS on ordinary recovery ({@link clearStreamFailure}), and that
   * asymmetry is the point. A quota wall is a claim about the ACCOUNT that outlives the red, so only
   * positive evidence retires it early. This is a claim about a turn that died — the moment the
   * agent classifies a tool event, prompts, or takes user input, it is demonstrably not sitting in
   * that failure any more. Without that, the field would be a permanent stamp of the last bad turn,
   * and every consumer would keep reporting a dead agent that had been working for hours.
   */
  private lastFailure: { message: string; at: number } | null = null;
  // Fires at the wall's stated reset. See armQuotaRelease for why a timer and not a check-on-ingest.
  private quotaTimer: ReturnType<typeof setTimeout> | null = null;
  // The token count from the most recent spinner frame that carried one, so a strictly-higher count
  // on a later frame proves the model is still GENERATING (forward progress) and clears a sticky
  // mid-stream failure — the healthy-but-transiently-blipped case (see the recovery in ingest). Null
  // until the first spinner frame with a token figure; a lone frame only sets the baseline (a frozen
  // count must never read as progress), so recovery needs a genuine frame-to-frame increase.
  // RESET AT EVERY TURN BOUNDARY (settle, noteUserInput — NOT a mid-turn prompt): Claude's counter is PER-TURN and
  // restarts low, so a stale high-water mark from a long previous turn would make the whole recovery
  // a silent no-op until the new turn out-grew it (roborev on da7c80c).
  private lastSpinnerTokens: number | null = null;
  private readonly failure = new StreamFailureDetector();
  // Fix 2 (Bug B): the normalized text of the message the user MOST RECENTLY submitted to this
  // agent, set by noteUserInput(). The TUI echoes the user's own input back into pty:output, so an
  // echo of "hey Sparkler" or "Are you there? Give me an update." would otherwise trip the
  // self-prompt/churn detector and paint a healthy, resuming agent RED. While this is set, any
  // ingested line that IS that echo is skipped for failure detection. Bounded by a line countdown
  // (and cleared on real progress) so it can never mask a later genuine wedge.
  private notedUserText = "";
  private notedUserLinesLeft = 0;

  constructor(private readonly opts: StatusEngineOpts) {
    // Start tracking before the first emit: from here this window is driving the agent, and until a
    // spinner (or a hook, noted by the router) is seen, every settled status it publishes is a GUESS
    // that destructive gates must not read as "finished". See engine/turnEndAuthority.
    trackAgent(opts.agentId, this);
    // Log the starting status too: a history that begins at the first FLIP can't tell you what the
    // agent flipped away from, and "spawned green then went red immediately" is itself a finding.
    logStatusTransition({
      agentId: this.opts.agentId,
      from: null,
      to: this.status,
      trigger: "spawn",
      monotonicMs: monotonicNow(),
    });
    this.opts.onStatus(this.status);
  }

  /**
   * The ONE way the status ever changes — every path in this file funnels through here, which is
   * why the transition log lives here and not at the call sites: a path added later cannot escape
   * it, and the compiler makes it name its `trigger`.
   *
   * Hot path: this runs per PTY chunk for every live agent, and the overwhelmingly common case is
   * "no change". That case returns on the first line, before any string is built and before
   * `monotonicNow()` is read, so instrumentation costs one comparison when nothing happened.
   *
   * @param trigger  WHY this fired — a discrete enum, never prose.
   * @param screen   The verdict `screenAwaitsInput` returned, when a screen classification is what
   *                 decided this transition. The verdict ONLY: terminal content is user data and
   *                 never reaches the log.
   */
  private set(
    s: AgentTabStatus,
    trigger: StatusTransitionTrigger,
    screen?: ScreenVerdict,
    // WHY, when the band alone is too broad for a consumer to act on — today only the session-limit
    // picker. Part of the dedup key, deliberately: the picker can appear on an agent this engine has
    // ALREADY painted `waiting` (its footer streams past mid-turn, so `prompt-detected-midstream`
    // fires ~2s before settle reads the screen). Keyed on the status alone, that settle would dedup
    // to a no-op and the reason would never reach the router — the row would stay green and the whole
    // fix would be inert on its most common path.
    reason: StatusReason | null = null,
  ): void {
    if (s === this.status && reason === this.statusReason) return;
    const from = this.status;
    const statusChanged = s !== this.status;
    this.status = s;
    this.statusReason = reason;
    // Logged BEFORE the listener runs, so the record survives a throwing subscriber. Only a real
    // status CHANGE is logged: a reason-only refresh is not a transition, and the router's own
    // transition record (which does carry the reason) is where that shows up.
    if (statusChanged)
      logStatusTransition({ agentId: this.opts.agentId, from, to: s, trigger, screen, monotonicMs: monotonicNow() });
    // The reason rides beside the call for its synchronous duration — the emit chain to the router
    // runs through two components whose callbacks are typed `(s: AgentTabStatus) => void`.
    withScreenReason(reason, () => this.opts.onStatus(s));
  }

  private clearTimers(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.idleTimer = null;
    this.recheckTimer = null;
  }

  // The ONE way into the sticky mid-stream failure, so the flag and the kind that governs its
  // recovery can never drift apart. "churn" outranks "api" (see failureKind).
  /**
   * Release the wall when the stated reset arrives.
   *
   * A TIMER IS REQUIRED, NOT AN OPPORTUNISTIC CHECK ON THE NEXT CHUNK, and that is the whole point:
   * a walled agent is SILENT. It runs no tools and prints nothing, so there is no next chunk to
   * re-classify it on. The first cut of this feature had no timer, and the consequence was that
   * `blocked` was terminal — `clearTimers()` had removed the settle timer, `blocked` is not a resting
   * status so auto-continue refused it as `not-idle`, and nothing else could clear the sticky red.
   * The agent sat dead past its own reset time until a human typed "try again", which is verbatim the
   * failure this whole branch exists to remove.
   *
   * Kept OUT of `clearTimers()` deliberately: that runs on every classification (including the
   * `blocked` arm that trips this), so clearing the release there would cancel it immediately.
   */
  private armQuotaRelease(resetAt: number): void {
    if (this.quotaTimer) clearTimeout(this.quotaTimer);
    this.quotaTimer = setTimeout(
      () => {
        this.quotaTimer = null;
        if (this.disposed || this.failureKind !== "quota") return;
        this.clearStreamFailure();
        this.quotaBlock = null;
        // Settle rather than forcing a colour: the wall is down, but whether the agent is working or
        // resting is a question for the ordinary classifier, not for this timer to assert.
        this.settle("quiet-settle");
      },
      Math.max(0, resetAt - Date.now()),
    );
  }

  // The ONE way into the sticky mid-stream failure, so the flag and the kind that governs its
  // recovery can never drift apart. "churn" outranks "api" (see failureKind).
  private tripStreamFailure(kind: "api" | "churn" | "quota"): void {
    // Read BEFORE the assignment below, because that assignment is what destroys the edge.
    const alreadyWalled = this.failureKind === "quota";
    this.sawStreamFailure = true;
    // Precedence, strongest first: quota beats everything (it is the most specific reading and the
    // only one that names a time), then churn, then api.
    if (kind === "quota" || this.failureKind === null) this.failureKind = kind;
    else if (kind === "churn" && this.failureKind !== "quota") this.failureKind = kind;
    // ONLY the quota arm reports a death, and only on the EDGE into it.
    //
    // Why quota and not "api": an API banner is the transport failing, and `apiRecoveryRunner`
    // already owns that case by typing a retry into the still-LIVING PTY. A wall is different in
    // kind — the account is shut, no keystroke opens it, and the agent will sit there until either
    // the window resets or a human pays. That is a death this app has to write down while it can
    // still see it, because the app quitting is what usually happens next.
    //
    // EDGE-TRIGGERED. `quotaBlocksIn` matches every time the agent reprints the banner (and Claude
    // reprints it on each retry), so a level trigger would rewrite the durable record dozens of
    // times for ONE incident. `clearStreamFailure` nulls `failureKind`, so a wall that returns after
    // a genuine recovery does fire again — which is right: that is a second incident.
    if (kind === "quota" && !alreadyWalled) this.reportDeath("quota-trip");
  }

  /** Hand the terminator to whoever is recording deaths. NEVER lets a listener's failure escape:
   *  this is called from `exit()` and from the middle of stream classification, and a throw there
   *  would strand the agent's status mid-transition — a recovery mechanism must not be able to break
   *  the thing it is trying to recover. */
  private reportDeath(terminator: Terminator): void {
    try {
      this.opts.onDeath?.({ terminator });
    } catch {
      // Swallowed by design; see above.
    }
  }

  /** The account-limit wall this agent last reported, if any. Read by the surfaces that must explain
   *  WHY it is blocked and how long for. Not cleared by ordinary recovery — see {@link quotaBlock}. */
  quotaBlockNow(now: number): QuotaBlock | undefined {
    const b = this.quotaBlock;
    return b !== null && isQuotaBlocked(b, now) ? b : undefined;
  }

  /** The API-error banner this agent is currently sitting in, verbatim. See {@link lastFailure}. */
  lastFailureNow(): { message: string; at: number } | undefined {
    return this.lastFailure ?? undefined;
  }

  // The ONE way out of it: every recovery path (a classified tool event, a real prompt, user input, a
  // token advance) must drop the flag, the kind AND the churn counters together — a leftover kind or
  // a half-counted repeat re-arms red on the next line.
  private clearStreamFailure(): void {
    this.sawStreamFailure = false;
    this.failureKind = null;
    this.failure.reset();
    // Dropped WITH the red, unlike `quotaBlock` — see the field's own note for why the two differ.
    this.lastFailure = null;
  }

  /**
   * The wall is gone EARLY — the account is demonstrably serving requests again.
   *
   * Separate from `clearStreamFailure` because the two answer different questions and the observation
   * must outlive the colour: the red clears on any recovery signal, but the WALL is a claim about the
   * account, and only positive evidence retires it before its stated time.
   *
   * Without this, a wall observed at 3pm kept every consumer wrong until 4pm even after the human
   * switched accounts and the agent ran tools and committed for twenty minutes: `get_agent_status`
   * printed `status: "working"` beside "Not working — it is behind an account limit", and
   * auto-continue stayed suppressed the whole time (by which point the 4h goal TTL could expire).
   * A stale block is not the safe direction — it strands a working agent.
   */
  private releaseQuotaBlock(): void {
    this.quotaBlock = null;
    if (this.quotaTimer) clearTimeout(this.quotaTimer);
    this.quotaTimer = null;
  }

  // A turn boundary (the turn settling, or the user submitting the next message — an approval prompt
  // is asked MID-turn and is deliberately NOT one): forget the spinner token baseline. Claude's
  // counter is per-turn and restarts low, so carrying a previous turn's high-water mark into the next
  // turn would silently disable the token-advance recovery (roborev on da7c80c).
  private resetSpinnerTokens(): void {
    this.lastSpinnerTokens = null;
  }

  /**
   * The user just submitted a message to this agent (Fix B / Bug B). Their presence is the
   * STRONGEST recovery signal: a NEW turn is starting and any prior stall/error latched from earlier
   * output is, by definition, stale — the user is here and driving. So:
   *   1. Clear the sticky/one-shot failure+error+risk flags and reset the churn detector, so a
   *      resuming spinner is no longer OVERRIDDEN by a dead `sawStreamFailure` and can go green. We
   *      do NOT force a color here — the next ingest/spinner tick classifies — we only lift the
   *      override so the real signal wins. (A genuine wedge with NO user input still goes red; the
   *      spinner alone never clears a stall — see sparkle-pqxh.)
   *   2. Record the submitted text (normalized) so its ECHO in the ingested output is not mistaken
   *      for a self-prompt/churn ping (Fix 2). Bounded to a line window so a LATER genuine wedge is
   *      still caught.
   */
  noteUserInput(text: string, opts?: { machine?: boolean }): void {
    // Same latch: the engine registry only guards by identity at UNREGISTER time, so a submit path
    // holding a stale reference could still reach a disposed engine.
    if (this.disposed) return;
    // A MACHINE SEND IS NOT A USER, AND MUST NOT SPEAK FOR ONE.
    //
    // Every send reaches here — `pty.deliverSubmit` calls `noteUserInputForAgent` unconditionally —
    // so the never-idle auto-resume was claiming the recovery signal reserved for "a person is here
    // and driving". Against a quota wall that made the loop self-concealing: the resume cleared the
    // red, the next spinner tick repainted the row green, and the agent looked busy while it was
    // barred from acting. The recovery mechanism was erasing the evidence of the condition it was
    // failing to recover from, once per settle window.
    //
    // NARROWED TO THE QUOTA KIND ON PURPOSE. `apiRecoveryRunner` documents that its own ping clears
    // `errored` and depends on it — that is how it observes whether a retry worked, and a transient
    // 5xx really can be gone by the next request. A quota wall cannot: it clears at a stated time and
    // nothing a machine types moves it. So `api` and `churn` keep today's behaviour exactly, and only
    // the verdict that a resume cannot possibly change survives a resume.
    const keepQuota = opts?.machine === true && this.failureKind === "quota";
    if (!keepQuota) this.clearStreamFailure();
    else this.failure.reset(); // the churn counters are still stale; the WALL is what persists

    // THE WALL IS RELEASED ON HUMAN PRESENCE ALONE — deliberately NOT gated on `failureKind`.
    //
    // A HUMAN is here. They are the ones who switch accounts or raise the cap, so their arrival is
    // the strongest available evidence that the wall may already be gone, and holding a stale block
    // against a present human is strictly worse than re-detecting it if it is still up (the banner
    // simply arrives again).
    //
    // COUPLING THIS TO `failureKind` WAS A BUG, and a subtle one, because the wall is designed to
    // OUTLIVE the sticky red: the red clears on any recovery signal, the wall expires on a clock.
    // While the release sat inside the `!keepQuota` branch it therefore fired for a MACHINE send as
    // soon as the red had been dropped for any unrelated reason — and dropping it is routine: a real
    // interactive prompt calls `clearStreamFailure()`, which is exactly what happens when Claude
    // prints the limit banner and then asks the human something. From that point requery (whose
    // SAFE_TO_REQUERY includes `blocked`), fleetWatch, apiRecoveryRunner or a machine dispatch each
    // nulled a LIVE wall, `decideContinuation` stopped returning `quota-blocked`, and auto-resume
    // fired into the wall again — the self-concealing loop, re-entered through the door this change
    // had just claimed to close. Asking only "was a person here?" cannot drift that way.
    if (opts?.machine !== true) this.releaseQuotaBlock();
    this.sawRecentError = false;
    this.sawRecentRisk = false;
    this.sawRecentOptionRow = false;
    // Re-arm the picker announcement. Whatever this send does to the dialog, a picker that is on
    // screen AFTER it is fresh news to a recovery listener — that is precisely how "the resume did
    // not take" becomes observable rather than assumed.
    this.sawSessionLimitPicker = false;
    // A new turn starts here, and its token counter restarts from zero.
    this.resetSpinnerTokens();
    // stripAnsi also strips the bracketed-paste ESC[200~/ESC[201~ wrappers submitPrompt adds (they
    // are CSI sequences), so this normalizes both raw text and paste-wrapped payloads the same way.
    const norm = stripAnsi(text).trim().toLowerCase();
    this.notedUserText = norm;
    this.notedUserLinesLeft = norm ? USER_INPUT_ECHO_WINDOW_LINES : 0;
  }

  // True when `lowerLine` (an already-lowercased, trimmed ingested line) is an echo of the message
  // the user just submitted — so it must not be read as a self-prompt/churn wedge (Fix 2). Matches
  // when the line equals the noted text, is a fragment OF it (a multi-line message echoes line by
  // line), or contains it (an echo decorated with a prompt marker). The two SUBSTRING directions are
  // gated on a minimum noted-text length: a tiny submission ("ok", "go") must fall back to
  // exact-equality only, or `lowerLine.includes("go")` would suppress detection on any line that
  // merely contains that token for the whole window (roborev). Only meaningful while the window is open.
  private isUserEchoLine(lowerLine: string): boolean {
    if (this.notedUserLinesLeft <= 0 || !this.notedUserText || !lowerLine) return false;
    if (this.notedUserText === lowerLine) return true;
    if (this.notedUserText.length < ECHO_SUBSTRING_MIN_CHARS) return false;
    return this.notedUserText.includes(lowerLine) || lowerLine.includes(this.notedUserText);
  }

  // The turn has gone quiet (spinner stopped, or the legacy timer fired). Decide red vs
  // gray from the *rendered* screen: if Claude is showing a question/approval menu, the
  // user is on the hook (waiting/approval, red); otherwise the turn simply ended (idle,
  // gray). Reaching a calm settle means the session didn't crash — clear the error flag
  // so a later clean exit isn't mislabeled `errored`.
  //
  // `trigger` says WHICH quiet brought us here — the spinner ceasing to re-draw, or the legacy
  // IDLE_MS stall timer — because in the log those two are very different stories about the same
  // resulting status. It defaults to the legacy one: `armLegacyTimers` is the only caller that
  // doesn't pass it, and leaving that line untouched keeps this instrumentation out of the way of
  // the SCREEN_RECHECK_MS work landing on a sibling branch, which rewrites that method.
  private settle(trigger: StatusTransitionTrigger = "quiet-settle"): void {
    this.idleTimer = null;
    this.sawRecentError = false;
    // The turn is over; the next one's spinner counter starts from zero, so drop the baseline rather
    // than carry this turn's high-water mark into it (roborev on da7c80c).
    this.resetSpinnerTokens();
    // Distinguish "no screen to read" from "screen read, calm" (roborev 54741). `getScreen` is
    // absent on plenty of constructions, and snapshotScreen returns blank lines for an empty
    // viewport; screenAwaitsInput short-circuits false on both without examining anything. Reporting
    // that as `calm` made the log unable to show the very case — a blank snapshot — most likely to
    // be behind a false GRAY. The STATUS is unchanged (nothing on screen still settles to idle);
    // only the logged verdict distinguishes them.
    const snapshot = this.opts.getScreen?.();
    const blank = snapshot === undefined || !snapshot.trim();
    const awaiting = blank ? false : screenAwaitsInput(snapshot);
    // The VIEWPORT is the only surface this question may be asked of — never the streamed lines
    // `ingest` scans. See isSessionLimitPicker's header: bottom-anchoring is what keeps prose that
    // quotes the screen out, and scrollback has no bottom.
    const picker = blank ? false : this.noteSessionLimitPicker(snapshot);
    // Consume the risk flag on every settle, not just the red branch: a non-blocking
    // turn that ends idle must not carry a stale risk into the next turn's question.
    const risky = this.sawRecentRisk;
    this.sawRecentRisk = false;
    this.sawRecentOptionRow = false;
    // REMEMBER what we just consumed, for the late screen re-check only (roborev on 95013a2f1).
    // `recheckScreen` runs 22.5s AFTER this, by which point `sawRecentRisk` is always false — so
    // reading that flag there made its `approval` branch unreachable, and a dangerous-action prompt
    // that painted late would be mislabeled a plain question. This copy is scoped to that one use
    // and is cleared whenever the risk flag itself is re-armed or the re-check consumes it.
    this.settledTurnRisk = risky;
    this.set(
      // `waiting`, never `approval`, when it is the session-limit picker: nothing dangerous is being
      // approved, and the recovery path keys off the reason code below rather than off the band.
      awaiting ? (risky && !picker && offersPressableOptions(snapshot) ? "approval" : "waiting") : "idle",
      trigger,
      blank ? "blank" : awaiting ? "awaiting" : "calm",
      // `awaiting` here is a VIEWPORT verdict — `screenAwaitsInput` ran against the snapshot read a
      // few lines up, not against streamed scrollback — so it is exactly the evidence the router's
      // approval pierce requires. Tagging it is what keeps a settle from silently DROPPING a pierce
      // the late re-check already raised: the reason is part of `set`'s dedup key, so a bare
      // `waiting` here would count as a change, reach the router, and clear the pierce — handing the
      // row straight back to a frozen `working` hook. Every viewport-confirmed awaiting emit must
      // carry a reason for that reason.
      picker ? "session-limit-picker" : awaiting ? "tool-approval-prompt" : null,
    );
  }

  /**
   * Record whether the just-read viewport is the session-limit picker, announcing on the RISING edge.
   *
   * Deliberately NOT a quota-band trip. `failureKind` stays untouched: `noteUserInput` computes
   * `keepQuota = machine && failureKind === "quota"` and reaches `releaseQuotaBlock` only for a
   * HUMAN, a guard whose whole rationale is that a machine release re-opens the self-concealing
   * resume loop. Routing the picker into that band would leave a machine resume either unable to
   * clear it — agents pinned red forever — or forced to bypass the guard and resurrect the bug
   * `quotaBlock` exists to kill. A screen-sourced reason needs no release path at all.
   */
  private noteSessionLimitPicker(snapshot: string): boolean {
    const picker = isSessionLimitPicker(snapshot);
    if (picker && !this.sawSessionLimitPicker) {
      announceSessionLimitPicker({ agentId: this.opts.agentId, at: Date.now() });
    }
    this.sawSessionLimitPicker = picker;
    return picker;
  }

  // A LATE re-read of the rendered screen, armed alongside the settle timer on the fallback path.
  // Promotes to red ONLY on the same evidence settle uses — a prompt actually on screen — which is
  // why this can no longer manufacture a needs-you out of a quiet terminal (see SCREEN_RECHECK_MS).
  // It exists for the async-render race: xterm paints on its own schedule, so a picker that streamed
  // in just before settle can reach the grid after settle read it. Silence with a calm screen leaves
  // the status exactly where settle put it.
  private recheckScreen(): void {
    this.recheckTimer = null;
    // REASON-ONLY UPGRADE, and the one path that is not about red-vs-gray at all.
    //
    // The mid-stream prompt path (see ingest) paints `waiting` off the STREAM and returns without
    // arming a settle — so on a session limit, which streams its picker in and then goes completely
    // silent, the viewport would never be read again and the reason would never attach. The row
    // would stay green behind a frozen `working` hook: the founder's exact bug, relocated. It also
    // cannot be answered synchronously at that moment, because xterm paints on its own schedule and
    // the dialog may not be on the grid yet when its footer streams past.
    //
    // So: re-read the viewport, and if it IS the session-limit picker, re-emit the same `waiting`
    // carrying the reason. Raises the reason, never lowers the status.
    // The SAME hole exists for an ordinary permission dialog, and it is the one the founder hit: an
    // MCP tool-approval box ("Approve rename_agent?") opens mid-turn exactly like a session limit,
    // so no `Stop` fires and the hook freezes at `working`. Before this branch also handled the
    // non-picker case it read the viewport, asked only "is it the session limit?", and returned —
    // so an approval prompt left `statusReason` null, the router had nothing to pierce with, and the
    // row stayed GREEN on an agent that was stopped waiting for a human.
    //
    // `approval` as well as `waiting`: the mid-stream path picks the band from `sawRecentRisk`, so a
    // DANGEROUS-action prompt arrives here as `approval`. Matching only `waiting` left exactly the
    // riskiest dialog unable to reach a reason — it fell past this branch into the calm-states guard
    // below and returned. The re-emit keeps whichever band is already set; this raises the reason and
    // never changes the status.
    if ((this.status === "waiting" || this.status === "approval") && this.statusReason === null) {
      const snapshot = this.opts.getScreen?.() ?? "";
      if (this.noteSessionLimitPicker(snapshot))
        this.set("waiting", "screen-recheck", undefined, "session-limit-picker");
      else if (screenAwaitsInput(snapshot))
        this.set(this.status, "screen-recheck", undefined, "tool-approval-prompt");
      return;
    }
    // Only from the two calm states. Anything else is either already red (nothing to promote) or a
    // terminal state (done/stopped), and a screen read must not resurrect it.
    if (this.status !== "working" && this.status !== "idle") return;
    const snapshot = this.opts.getScreen?.() ?? "";
    if (!screenAwaitsInput(snapshot)) return;
    // Same viewport, same question as settle — a session-limit picker that painted late is exactly
    // the case this re-read exists for, and it must arrive carrying its reason or the router has
    // nothing to pierce with.
    const picker = this.noteSessionLimitPicker(snapshot);
    // `settledTurnRisk`, not `sawRecentRisk`: settle already consumed the live flag, so reading it
    // here always saw `false` and could never say `approval`. The prompt this re-check exists to
    // catch is precisely the one that painted late — including a dangerous-action one.
    const risky = this.sawRecentRisk || this.settledTurnRisk;
    this.sawRecentRisk = false;
    this.sawRecentOptionRow = false;
    this.settledTurnRisk = false;
    // `screenAwaitsInput(snapshot)` returned true a few lines up, so this emit is viewport-confirmed
    // and carries a reason either way — the pierce works from here too, for a dialog that painted
    // late enough to miss settle entirely.
    this.set(
      risky && !picker && offersPressableOptions(snapshot) ? "approval" : "waiting",
      "screen-recheck",
      undefined,
      picker ? "session-limit-picker" : "tool-approval-prompt",
    );
  }

  // Fallback path only: arm the legacy time-based settle timer plus the late screen re-check (used
  // when Claude's spinner has never been observed, e.g. a non-Claude program or TUI drift).
  private armLegacyTimers(): void {
    this.clearTimers();
    this.idleTimer = setTimeout(() => this.settle(), IDLE_MS);
    this.recheckTimer = setTimeout(() => this.recheckScreen(), SCREEN_RECHECK_MS);
  }

  /** Feed a raw PTY chunk. Splits into lines, classifies, updates status. */
  ingest(chunk: string): void {
    // A disposed engine must go COMPLETELY silent, and ingest is the loudest path there is: it
    // writes statuses onto what is now a DIFFERENT agent's row, snapshots a dead xterm buffer, and
    // re-arms the very timers dispose() just cleared — so a torn-down engine would keep writing for
    // another SCREEN_RECHECK_MS. `pty:data` is unlistened over the same async round-trip as
    // `pty:exit`, so this window is real, not theoretical (roborev 55094).
    if (this.disposed) return;
    const clean = stripAnsi(chunk);
    // The frame that was still being drawn before this chunk landed (everything after the partial's
    // last \r). Joined with the incoming text below, it is how the partial-banner check counts what
    // ARRIVED in this chunk without ever re-scanning the whole buffer — see that check for why.
    const carry = this.partial.slice(this.partial.lastIndexOf("\r") + 1);
    this.partial += clean;
    const lines = this.partial.split(/\r?\n/);
    this.partial = lines.pop() ?? "";
    // The spinner redraws in place without a trailing newline, so an unterminated line can
    // accumulate for a whole turn. Keep only the tail: prompt/spinner markers are short and
    // land at the end, so a bounded buffer preserves detection while bounding memory + scan cost.
    if (this.partial.length > MAX_PARTIAL) this.partial = this.partial.slice(-MAX_PARTIAL);

    let prompt = false;
    // Whether THIS chunk freshly observed a failure line (an API banner, a self-prompt/churn repeat).
    // The token-advance recovery below is suppressed when true, so a churn/self-prompt chunk that
    // happens to also carry an advancing spinner can never clear the very failure it just tripped —
    // the repeated bad lines keep re-arming red, which is the intended sticky behavior.
    let trippedThisChunk = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (ERROR_PATTERNS.some((re) => re.test(line))) this.sawRecentError = true;
      const ev = classifyLine(line, { sessionId: this.opts.agentId });
      if (ev) {
        // A classified tool/file event is genuine forward progress — the agent is doing real work
        // again, not churning on a dead API call. Clear any sticky mid-stream failure (sparkle-pqxh)
        // and reset the churn counter so post-recovery output starts fresh. Real progress also ends
        // the user-input echo window (Fix 2): from here a repeated self-ping is a fresh wedge again.
        this.clearStreamFailure();
        // THE WALL IS DELIBERATELY *NOT* RELEASED HERE, and four rounds of review are why.
        //
        // The idea was that a classified line proves the account is serving requests again, so an
        // out-of-band cap raise would not leave every surface insisting "behind an account limit"
        // until `resetAt`. Each attempt to build that signal from terminal text was wrong, and each
        // failure was a FALSE RELEASE — the direction that re-opens the self-concealing resume loop:
        //
        //   • Any classified event: `classifyLine` is a RISK classifier, so the agent's own recap
        //     prose ("Done: ran vitest and committed") classifies exactly like a tool line.
        //   • Excluding `approval_needed`: that only drops CAUTION/DANGEROUS, while the SAFE class
        //     *is* the prose surface.
        //   • A leading shell prompt: `SHELL_PROMPT` is `/^\s*[$#>]\s+/`, so a markdown heading
        //     ("# Summary"), a Makefile comment or a diff hunk scrolling past all qualify. And the
        //     `$` shape is not evidence of execution at all — `capturedScreens.fixture`'s
        //     `⎿  $ touch probe_ok.txt` sits INSIDE the permission dialog, above "Do you want to
        //     proceed?", so it is a PROPOSAL awaiting a human. An earlier version of this comment
        //     cited that fixture as proof of execution; that citation was simply wrong.
        //
        // The conclusion is not "guard it harder" but that the PTY carries no sound execution signal
        // at this layer: every candidate is confusable with a proposal or with prose. So the wall
        // falls only to the two signals that ARE sound — its stated reset (armQuotaRelease) and a
        // HUMAN send (noteUserInput). The cost is bounded and one-directional: if someone raises the
        // cap out of band and never types to the agent, the wall stands until `resetAt`. Any
        // interaction clears it, and a wrong hold only delays an auto-resume, where a wrong release
        // resurrects the bug this whole module exists to kill.
        // THE ECHO WINDOW MUST NOT BE CONSUMED BY THE ECHO ITSELF. `notedUserText` holds the whole
        // normalized message and `isUserEchoLine` matches a single line as a FRAGMENT of it —
        // precisely because a multi-line message echoes line by line. Clearing unconditionally ended
        // the window on the echo's OWN first line, so line 2 of the same relay was no longer
        // recognised and fell through to the false-red guards this window exists to feed.
        if (!this.isUserEchoLine(line.toLowerCase())) {
          this.notedUserText = "";
          this.notedUserLinesLeft = 0;
        }
      }
      if (ev?.event_type === "approval_needed") this.sawRecentRisk = true;
      // Mid-stream failure/stall while the process is alive (sparkle-pqxh). Only observed when this
      // line did NOT classify as a tool/file event — a classified line is unambiguous progress, and
      // `if (ev)` above just reset the detector, so re-observing it (a tool arg/path that happens to
      // contain "api error") must not re-trip the failure (roborev 16153). The detector keys off the
      // visible \r-frame, so a banner fused onto a spinner redraw is still caught. Sticky once
      // tripped; only the recovery paths (a real tool event above, a real prompt below, or
      // noteUserInput) clear it. Fix 2: an echo of the user's own just-submitted message is NOT a
      // wedge — skip it entirely so it neither trips a self-prompt nor accrues churn.
      else if (!ev && !this.isUserEchoLine(line.toLowerCase()) && this.failure.observe(line)) {
        // A banner is an "api" failure (clearable by token progress); ANY other trip is a
        // self-prompt/churn wedge, which generates its own tokens and so is NEVER token-clearable.
        // A banner that REPEATS stays "api" on purpose: a long turn can survive several transient
        // blips while genuinely generating, and escalating repeats to "churn" would pin exactly that
        // healthy agent red — the false-red this whole line of work exists to kill. A retry loop with
        // no generation is still caught, by the frozen-counter rule.
        // THE SAME EXTRACTOR AS THE TAIL PATH BELOW, and that is load-bearing rather than tidy
        // (roborev 57313). `line` here is `raw.trim()` — NOT marker-stripped and NOT \r-split — so
        // storing it directly yielded "⏺ API Error: …" where the tail path yields "API Error: …",
        // and for the documented fused shape the whole spinner frame. `sharedFailureCohorts` keys a
        // Map on this string by EXACT equality, so two agents killed by one host event — one whose
        // banner flushed with a trailing newline and one whose did not — landed in different cohorts
        // and the shared outage was never reported. A spinner-fused capture is worse: it carries the
        // elapsed seconds and token count, so it is unique per agent and can never group at all,
        // and the report would quote it and whitelist those numbers as if they were measured.
        //
        // It fails OPEN, which is the direction that looks like "no outage". Using one extractor on
        // both paths makes the bytes identical by construction rather than by two rules agreeing.
        //
        // `apiErrorFramesIn(line).length > 0` is equivalent to the `isApiErrorLine(line)` this
        // replaced: `line` came from a \n-split, so only the \r split matters, and `frames()` does
        // exactly that plus the same `stripMarkers`. The RED behaviour is unchanged.
        const apiFrames = apiErrorFramesIn(line);
        if (apiFrames.length > 0) {
          this.lastFailure = { message: apiFrames[apiFrames.length - 1]!, at: Date.now() };
        }
        this.tripStreamFailure(apiFrames.length > 0 ? "api" : "churn");
        trippedThisChunk = true;
      }
      // ACCOUNT LIMIT, checked SEPARATELY from `this.failure.observe` above and not folded into it.
      // Two reasons it cannot ride that path: `StreamFailureDetector` answers a boolean, so it cannot
      // carry the message and reset instant this band exists to report; and it is reached only in the
      // `else if` arm above, so a chunk that also classified as a tool event would skip the wall
      // entirely. A quota banner is unambiguous on sight — like an API banner, a single occurrence
      // trips — so it needs no repetition gate.
      const wall = quotaBlockIn(line, Date.now());
      if (wall !== undefined && !this.isUserEchoLine(line.toLowerCase())) {
        this.quotaBlock = wall;
        this.armQuotaRelease(wall.resetAt);
        this.tripStreamFailure("quota");
        trippedThisChunk = true;
      }
      if (screenAwaitsInput(line)) prompt = true;
      if (streamOffersAnswer(line)) this.sawRecentOptionRow = true;
      // Spend one tick of the user-input echo window per non-empty line, so it can't mask a later
      // genuine wedge (Fix 2). Decremented AFTER this line's echo check so the final in-window line
      // is still covered (no boundary off-by-one). When it runs out, drop the noted text so
      // detection re-arms fully. A classified tool event above already cleared it (real progress).
      if (this.notedUserLinesLeft > 0 && --this.notedUserLinesLeft === 0) this.notedUserText = "";
    }
    // Claude prints its input prompt without a trailing newline — check the partial too.
    if (screenAwaitsInput(this.partial)) prompt = true;

    // An API-error banner can also sit in the still-unterminated partial: the spinner redraws without
    // a newline, so a fused banner may not have flushed as a completed line yet. This catches it so
    // detection isn't one missing '\n' away from silently not firing (roborev 16152). The banner-count
    // history that forced the current shape: keying on banner TEXT missed a verbatim-repeated banner
    // (a retry loop re-emits the same string — fail-OPEN, 46783/46899); a whole-partial COUNT stalled
    // once the MAX_PARTIAL trim started evicting one banner per arrival (fail-OPEN again, 46920). So
    // we diff banner frames to isolate ARRIVALS. Full rationale on `apiErrorFramesIn`.
    //
    // Scope: the UNTERMINATED TAIL ONLY, with the SAME user-echo guard the loop applies. Completed
    // lines are the loop's job; scanning them here re-counted a pasted "API Error: …" report the loop
    // deliberately skips (Fix 2), false-redding a healthy agent (47232/47233). Scoping to the tail
    // fixed the '\n'-terminated shape but not the common one — a TUI input-box redraw echoes with NO
    // trailing '\n', landing the echo entirely in the tail — so the guard must apply here too
    // (47981/47996). `base` is the already-flushed prefix (empty when this chunk had a '\n'; else
    // `carry`), so `arrived` is exactly the banner frames the tail ADDED; we then drop any that are an
    // echo of the user's own just-submitted message. The tool-event exemption (16153) needs no guard
    // here: a frame that later completes as a classified line hits the `if (ev)` clear above, and no
    // real tool-event line begins with "api error:" anyway.
    const nl = clean.lastIndexOf("\n");
    const base = nl >= 0 ? "" : carry; // a '\n' flushed carry + everything before it through the loop
    const tail = nl >= 0 ? clean.slice(nl + 1) : clean;
    const arrived = apiErrorFramesIn(base + tail)
      .slice(countApiErrorFrames(base))
      .filter((f) => !this.isUserEchoLine(f.toLowerCase()));
    if (arrived.length > 0) {
      // The LAST arrival, matching how `wallInTail` takes the last wall: within one chunk the most
      // recent banner is the current state of the turn.
      this.lastFailure = { message: arrived[arrived.length - 1]!, at: Date.now() };
      this.tripStreamFailure("api");
      trippedThisChunk = true;
    }

    // THE SAME CHECK ON THE UNTERMINATED TAIL, and this is the arm that actually catches a live
    // agent: the observed banner arrived with NO trailing newline (the founder's screenshot), so the
    // completed-line loop above never saw it.
    //
    // ARRIVAL-DIFFED, exactly like the API banners above, and this is not optional. A banner in the
    // tail stays in `carry` and is re-read on every subsequent chunk, so a whole-buffer check answers
    // "blocked" forever — no human, no tool event, nothing could ever clear it, and the row would be
    // pinned red long after the limit reset. `base` is the already-seen prefix, so slicing past its
    // count leaves exactly the walls this chunk ADDED. Same user-echo guard, so a human pasting the
    // banner into the composer does not paint their own agent blocked.
    const wallsArrived = quotaBlocksIn(base + tail, Date.now())
      .slice(quotaBlocksIn(base, Date.now()).length)
      .filter((w) => !this.isUserEchoLine(w.message.toLowerCase()));
    const wallInTail = wallsArrived[wallsArrived.length - 1];
    if (wallInTail !== undefined) {
      this.quotaBlock = wallInTail;
      this.armQuotaRelease(wallInTail.resetAt);
      this.tripStreamFailure("quota");
      trippedThisChunk = true;
    }

    // The spinner status line is re-drawn in place (often no trailing newline), so scan the whole
    // cleaned chunk rather than only completed lines — but FRAME BY FRAME, so the persistent footer
    // bar can't be mistaken for a running turn. See the WORKING_PATTERNS header.
    const hasSpinner = hasSpinnerFrame(clean);
    if (hasSpinner && !this.sawSpinner) {
      this.sawSpinner = true;
      // The spinner is now a witness to turn END (its disappearance), so this agent's settled
      // statuses stop being guesses — which is what re-closes the destructive-op gate's escape
      // hatch. Published once, on the latch.
      noteSpinnerSeen(this.opts.agentId, this);
    }

    // Token-advance recovery (sparkle-pqxh follow-up): after an API BANNER the request that failed
    // generated nothing, so a strictly-higher spinner token count is positive proof the agent is
    // generating again — the same thing a classified tool event proves. This rescues the false-red
    // where a HEALTHY agent hit a transient API blip early in a long turn and kept streaming tokens
    // with no tool event yet ("Incubating… ↓ 2.1k tokens"): without it the sticky flag pinned the row
    // red for the rest of the turn. Guards, each one load-bearing:
    //   (a) `failureKind === "api"` — a self-prompt/churn wedge GENERATES its own pings, so its
    //       counter climbs too; letting tokens clear it would make the pqxh wedge flap red↔green
    //       (roborev on da7c80c). Churn only clears on real progress / a prompt / user input.
    //   (b) only a genuine frame-to-frame INCREASE clears — a repeated/frozen count (the rate-limit
    //       retry loop, and the tests' static spinner) does not, preserving "sticky until progress".
    //   (c) `!trippedThisChunk` so a chunk that itself observed a failure line can't self-clear.
    //   (d) the figure is read from the NEWEST SPINNER FRAME only, so prose in the same chunk that
    //       mentions "30k tokens" is neither mistaken for the counter nor able to poison the baseline.
    // The baseline is tracked regardless of failure state (and reset at every turn boundary) so the
    // first frame after a blip already has something real to compare against.
    if (hasSpinner && !trippedThisChunk) {
      const tokens = latestSpinnerTokens(clean);
      if (tokens !== null) {
        if (
          this.sawStreamFailure &&
          this.failureKind === "api" &&
          this.lastSpinnerTokens !== null &&
          tokens > this.lastSpinnerTokens
        ) {
          this.clearStreamFailure();
          // Token progress is real progress, so — like a classified tool event — it also closes the
          // user-input echo window: from here a repeated self-ping is a fresh wedge again.
          this.notedUserText = "";
          this.notedUserLinesLeft = 0;
        }
        this.lastSpinnerTokens = tokens;
      }
    }

    // 1. An input prompt always wins: the agent is asking for you.
    if (prompt) {
      this.clearTimers();
      // WHICH prompt it is has to come from the VIEWPORT — the stream can say "a picker opened" but
      // not "it is the session-limit one", and that distinction is what pierces a frozen hook. Read
      // it now (usually already painted), and arm ONE late re-read for the async-render race, since
      // this path returns without arming a settle and a walled agent emits nothing further.
      const snapshot = this.opts.getScreen?.() ?? "";
      const picker = this.noteSessionLimitPicker(snapshot);
      // CARRY the viewport-confirmed reason forward, but ONLY while the viewport still shows a
      // prompt. Keying the carry off `this.statusReason` alone (as this first shipped) re-latched the
      // pierce: `prompt` is sticky across chunks — `screenAwaitsInput(this.partial)` scans the whole
      // unterminated tail — so after the human answers, spinner frames appended to a partial still
      // holding the pre-answer `❯ 1.` line re-trip this path, re-carry the reason, and `clearTimers()`
      // kills the settle that would have corrected it. The row then sits on "Needs you" while the
      // agent is demonstrably generating: exactly the un-retractable red `approvalPrompt`'s
      // declaration in statusRouter says this design exists to avoid.
      //
      // Reusing the snapshot read above keeps the boundary intact — this path still never RAISES a
      // reason from stream-only evidence — while giving the carry the same viewport evidence that
      // settle and the late re-check use, so an answered dialog retracts on its own.
      // The VIEWPORT still shows a prompt. This — not the carried reason — is what the BAND is gated
      // on, because the reason is only ever raised by the late re-check ~2s later: gating the band on
      // `carried` protected a redraw AFTER the reason existed and left the ordinary ordering (a redraw
      // inside that 2s window) demoting `approval` to `waiting` exactly as before, permanently, since
      // the re-check then re-emits the CURRENT band and never re-consults risk.
      const stillOnScreen = !picker && screenAwaitsInput(snapshot);
      const carried = stillOnScreen && this.statusReason === "tool-approval-prompt";
      // The prompt was detected in the STREAM, not on the rendered screen, so there is no screen
      // verdict to record here — `screenAwaitsInput` ran against the ingested lines, not a snapshot.
      this.set(
        // The BAND is carried with the reason, not just the reason. `sawRecentRisk` is consumed by
        // this very path, so on the SECOND detection of the same dialog it always reads false — a
        // redraw would silently demote a live `approval` to `waiting`, relabelling a
        // destructive-action prompt as an ordinary question for the life of the dialog (and it never
        // recovers, since the re-check's reason-only branch is gated on a null reason). Narrower than
        // the green flash, since the row stays red, but it is the same class of lie.
        // Gates the CARRY too, not just the fresh raise: the carry exists so a redraw can't demote a
        // live `approval`, but a dialog whose options have scrolled away is no longer answerable, and
        // carrying the band there would re-pin the exact dead end.
        //
        // EITHER SOURCE COUNTS HERE, unlike settle and the late re-check. This path detected the
        // prompt in the STREAM, so the stream is where its evidence lives — a construction with no
        // `getScreen` wired reads an empty viewport, and requiring the viewport alone would silently
        // demote every stream-only detection to `waiting`. The dead end is unaffected: it is defined
        // by options being absent from BOTH, and in the real app the viewport is always readable.
        !picker &&
        (offersPressableOptions(snapshot) || this.sawRecentOptionRow) &&
        (this.sawRecentRisk || (stillOnScreen && this.status === "approval"))
          ? "approval"
          : "waiting",
        "prompt-detected-midstream",
        undefined,
        // NEVER LOWERS AN ALREADY-RAISED REASON. This path may not RAISE `tool-approval-prompt` — it
        // read the stream, not the viewport, and that boundary is what keeps a menu still sitting in
        // scrollback from piercing a healthy agent. But writing a bare `null` here would be worse
        // than not raising it: the reason is part of `set`'s dedup key, so once the late re-check has
        // confirmed a dialog on the rendered grid, a subsequent mid-stream prompt detection (the
        // dialog redrawing, or a second prompt streaming past) would emit `waiting` with no reason,
        // the router would drop the pierce, and the row would fall straight back to the frozen
        // `working` hook — green again, on an agent still parked on the dialog. So carry the
        // viewport-confirmed reason forward and let only real progress clear it.
        picker ? "session-limit-picker" : carried ? "tool-approval-prompt" : null,
      );
      if (!picker) this.recheckTimer = setTimeout(() => this.recheckScreen(), SPINNER_GRACE_MS);
      this.sawRecentRisk = false;
      this.sawRecentOptionRow = false;
      // A calm prompt means the agent recovered and is awaiting you — not a crash or a stall. The
      // token baseline deliberately SURVIVES here: an approval question is asked MID-turn and the
      // counter keeps climbing from where it was once you answer, so dropping it would throw away a
      // still-valid high-water mark. The true boundaries — the turn settling, and the user submitting
      // the next message — reset it (roborev 46783).
      this.sawRecentError = false;
      this.clearStreamFailure();
      return;
    }

    // 1b. Mid-stream failure/stall (sparkle-pqxh): the agent printed an API-error banner and kept
    //     churning, or fell into a self-prompt loop, all while its process stays alive. Fail CLOSED
    //     to red `errored` and OVERRIDE the spinner below — the whole bug is that the spinner keeps
    //     ticking (so it looked "working") while the agent is wedged. The router lifts this to red
    //     even over a hook `working`. Recovery clears it above (a real tool event / a real prompt).
    if (this.sawStreamFailure) {
      this.clearTimers();
      // An ACCOUNT limit is not an error and must not be reported as one. Nothing crashed, nothing
      // needs debugging, and there is no retry that helps — the agent is barred until a stated time.
      // `blocked` is the band whose own definition is "needs you to unstick it": still RED (so
      // `isRedStatus` makes `get_agent_status` report `needsYou: true`, which is the point), but it
      // deliberately raises no banner and no dock badge, which is right for a condition that clears
      // on its own clock rather than one demanding an answer right now.
      if (this.failureKind === "quota") {
        this.set("blocked", "quota-limit");
        return;
      }
      this.set("errored", "stream-failure");
      return;
    }

    // 2. Spinner visible → actively working. Re-arm the "spinner gone" settle timer so
    //    the turn settles to idle only after the spinner truly stops re-drawing.
    if (hasSpinner) {
      this.clearTimers();
      this.set("working", "spinner-seen");
      this.idleTimer = setTimeout(() => this.settle("spinner-gone-settle"), SPINNER_GRACE_MS);
      return;
    }

    // 3. Spinner mode, but no spinner in this chunk: either a frame between ticks or the
    //    post-turn idle screen. Don't force-flip — let the settle timer from the last
    //    spinner sighting decide. If none is pending (idle screen drew first), arm one.
    if (this.sawSpinner) {
      if (!this.idleTimer) this.idleTimer = setTimeout(() => this.settle("spinner-gone-settle"), SPINNER_GRACE_MS);
      return;
    }

    // 4. Fallback (spinner never seen): legacy output-flow + stall heuristic.
    this.set("working", "output-flowing");
    this.armLegacyTimers();
  }

  /** Call when the PTY exits. */
  exit(): void {
    // A late exit from a PTY this engine no longer owns is not this agent's news — see `disposed`.
    if (this.disposed) return;
    this.clearTimers();
    // A dead process is the strongest turn-end witness there is: nothing can still be writing the
    // worktree. Without this, an agent that exited on the fallback path (no hooks, no spinner) would
    // be refused every destructive op FOREVER — a dead PTY never emits the spinner frame or hook
    // event that would grant authority (roborev 54815).
    noteProcessExit(this.opts.agentId, this);
    // A process that dies mid-stream-failure (an API error / self-prompt wedge that never recovered)
    // must read `errored`, not gray `done`: sawStreamFailure counts the same as a pre-exit error
    // marker here, so a wedged-then-killed agent doesn't settle green-gray (roborev 16152).
    this.set(this.sawRecentError || this.sawStreamFailure ? "errored" : "done", "process-exit");
    // AFTER the status is set, so a listener that reads the row sees the terminal value rather than
    // the pre-exit one. The PTY closing is the strongest death signal there is, and it carries NO
    // exit code — `pty.rs` emits none — so it names the terminator and lets `classifyDeath` decide
    // what, if anything, it means. Most of the time the answer is `unknown`, which is deliberately
    // NOT resurrectable: a human clicking stop produces exactly this observation.
    this.reportDeath("pty-exit");
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    // The quota release timer is kept OUT of `clearTimers()` on purpose (that runs on every
    // classification, including the `blocked` arm that arms it), so it has to be dropped here
    // explicitly. Its callback already checks `disposed`, but the timer itself can be up to 5h out
    // and retains the engine and its closure for that whole time — once per open/close cycle of a
    // walled agent. A torn-down engine "must go completely silent", and a pending multi-hour timer
    // is neither silent nor free.
    this.releaseQuotaBlock();
    // This window stops witnessing the agent when its pane goes away, so drop the record rather than
    // leave a stale "no authority" entry that would keep a destructive gate refusing forever.
    forgetAgent(this.opts.agentId, this);
  }
}
