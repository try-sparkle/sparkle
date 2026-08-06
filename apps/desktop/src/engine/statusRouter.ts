// statusRouter (): arbitrate between the two status sources during the migration off
// screen-scraping. Claude Code's hook events are authoritative, but they only start flowing once
// the agent's first hook fires — and non-Claude programs never emit them at all. So the screen
// scraper (statusEngine.ts) drives until the first real hook event arrives; from that moment
// hooks own the status and the scraper's guesses are suppressed. This keeps the deterministic
// hook signal in charge whenever it exists, with zero regression in the window (or programs)
// where it doesn't.
//
// Hook authority is not permanent, though: the stream can DIE mid-session (the emitter lives in the
// worktree's .claude/settings.local.json and anything rewriting that file drops it). Because
// activate() fires on every MAIN-SESSION event (createHookEventHandler gates it), a dead stream
// would otherwise leave hooksLive latched true and lastHook frozen forever. The staleness watchdog
// in fromScreen hands authority back to the scraper — see HOOK_STALE_MS.
//
// SCOPE, precisely: the watchdog recovers a stream that dies while the turn is CLOSED (lastHook
// "idle" — the reported bug: agent asks a question, user answers, row must go green). It does NOT
// recover a stream that dies MID-TURN: lastHook is then frozen at "working", no contradiction ever
// forms, and resolve() answers "working" for every screen report, so the row pins green until the
// next reset() (a re-prepare). That gap predates the watchdog and is NOT a regression from it — but
// it is real, and detecting it needs a signal this router does not have (silence cannot distinguish
// a dead stream from a long tool call; see HOOK_STALE_MS). `mid_turn_death_is_not_recovered` in the
// tests pins the current behavior so the gap stays explicit rather than latent. Tracked as
// sparkle-7wij.
import type { AgentTabStatus } from "@sparkle/ui";

/**
 * WHY a status is what it is, when the band alone is too broad to act on.
 *
 * `waiting` is the most common attention state in the app — a mid-stream question, a permission
 * dialog, an AskUserQuestion menu, a `/model` picker all land there — so a machine that triggered on
 * the BAND would send keystrokes at dialogs a human was about to answer. A reason code is what makes
 * one specific `waiting` safely actionable. It rides the transition record rather than the status,
 * precisely so nothing downstream has to widen `AgentTabStatus` to carry it.
 *
 *   session-limit-picker  Claude Code's account session-limit dialog is on the rendered screen and
 *                         the agent is parked on it. The ONE screen state that outranks a frozen
 *                         `working` hook (see `resolve`). This is W-RESUME's only safe trigger.
 *   tool-approval-prompt  A permission / tool-approval dialog is on the RENDERED VIEWPORT and the
 *                         agent is parked on it — an MCP "Approve?" box, an AskUserQuestion menu, a
 *                         `/model` picker. Like the session limit it opens MID-TURN, so it needs the
 *                         same pierce; unlike it, it is not latched (see `approvalPrompt`).
 *                         VIEWPORT-CONFIRMED is the load-bearing word: only statusEngine's re-read of
 *                         the rendered grid may raise this. A prompt seen in the streamed lines is
 *                         not enough, because scrollback has no bottom and an answered menu still
 *                         sits in it.
 */
export type StatusReason = "session-limit-picker" | "tool-approval-prompt";

// ── The screen-reason hand-off ──────────────────────────────────────────────────────────────────
//
// statusEngine reports to this router through a callback chain it does not own — `StatusEngine`'s
// `onStatus` → Terminal's `onStatusWithCapture` → AgentPane's `(s) => router.fromScreen(s)` — and
// every hop of it is typed `(s: AgentTabStatus) => void`. Widening that signature would mean editing
// two components to carry one field, so the reason travels beside the call instead of inside it.
//
// SAFE BECAUSE THE CHAIN IS SYNCHRONOUS. `withScreenReason` sets the slot, invokes the emit, and
// clears it in a `finally`; `fromScreen` reads it inside that window. JS is single-threaded, so no
// other agent's engine can be mid-emit at the same time, and nothing survives the call to be
// mis-attributed later. If a hop ever DEFERS, the slot reads null and the pierce simply doesn't
// happen — the failure direction is today's behaviour, never a wrong pierce on a healthy agent.
let deliveringScreenReason: StatusReason | null = null;

/** Publish `reason` as the evidence behind the status `emit` is about to report, for the duration of
 *  that one synchronous call. Used by statusEngine; see the block above for why it is a slot rather
 *  than a parameter. */
export function withScreenReason<T>(reason: StatusReason | null, emit: () => T): T {
  const prev = deliveringScreenReason;
  deliveringScreenReason = reason;
  try {
    return emit();
  } finally {
    deliveringScreenReason = prev;
  }
}

/** The reason accompanying the screen status currently being delivered, or null. */
export function currentScreenReason(): StatusReason | null {
  return deliveringScreenReason;
}

export interface StatusRouter {
  /** Mark that a real hook event has arrived; hooks own the status from here on. */
  activate: () => void;
  /** Hand authority back to the screen scraper (e.g. on a re-prepare / agent restart) until the
   *  next run's first real hook event re-activates hooks. */
  reset: () => void;
  /** Hook-derived status — emitted only once hooks are active (ignores the engine's
   *  pre-activation initial emit). */
  fromHook: (s: AgentTabStatus) => void;
  /** Screen-scraped status — the fallback, suppressed once hooks are active. */
  fromScreen: (s: AgentTabStatus) => void;
  /** Followup-judge verdict — like the screen, escalates a hook-`idle` turn to red (`waiting`)
   *  when the agent finished but is blocked on the user. See `fromJudge` in the factory. */
  fromJudge: (s: AgentTabStatus) => void;
}

/** How long the hook stream may be silent before a screen `working` is taken as proof it has died.
 *  Silence ALONE is not evidence of death — hooks are legitimately quiet for minutes during a single
 *  long tool call (a test suite, a build) or a long thinking block. The watchdog therefore also
 *  requires a CONTRADICTION (see fromScreen): hooks say the turn is closed while the screen says the
 *  agent is running. Those two states cannot both be true of a live stream, because whatever resumed
 *  the agent (UserPromptSubmit / PreToolUse) would itself have been an event.
 *
 *  Consequence, stated plainly: only a CLOSED-turn wedge is detectable this way. A stream that dies
 *  mid-turn is not recovered — see the module header and `mid_turn_death_is_not_recovered`. Raising
 *  this constant does not help: there is no duration that separates a dead stream from a slow build,
 *  so a longer window would only trade a false green for a false red on healthy sessions. */
export const HOOK_STALE_MS = 30_000;

/** One status change, with the evidence that drove it. Handed to the optional `onTransition` sink so
 *  the app can write a diagnosable trail: WHICH source spoke, what it said, and what the arbitration
 *  resolved to. Before this existed, a whole day of false "needs you" alarms left ZERO trace in the
 *  log — grepping for `blocked`, `needs_you` or `attention_screen` returned nothing — and the only
 *  way to tell why a row was red was to watch it happen. */
export interface StatusTransition {
  /** Which input spoke: the hook stream, the screen scraper, or the followup judge. */
  source: "hook" | "screen" | "judge";
  /** What that source reported, BEFORE arbitration. */
  input: AgentTabStatus;
  /** What the row read a moment ago (null before the first emit / after a reset). */
  from: AgentTabStatus | null;
  /** What arbitration resolved to — the value actually emitted. */
  to: AgentTabStatus;
  /** WHY, when the band alone is too broad to act on — see {@link StatusReason}. Null for every
   *  ordinary transition. This is the observable field a consumer reads to distinguish "parked on
   *  the session-limit picker" from the dozen other things `waiting` means, WITHOUT importing the
   *  screen classifier. AgentPane already forwards the whole record to the `agent-status` log line,
   *  so it needs no new plumbing to be greppable. */
  reason: StatusReason | null;
  /** The other sources' latest readings, so a surprising `to` can be explained from one line. */
  lastHook: AgentTabStatus | null;
  lastScreen: AgentTabStatus | null;
  lastJudge: AgentTabStatus | null;
  /** False once the hook stream has been declared dead by the watchdog. */
  hooksLive: boolean;
}

export function createStatusRouter(
  emit: (s: AgentTabStatus) => void,
  // Injected so tests are deterministic without fake timers.
  now: () => number = () => Date.now(),
  // Optional diagnostic sink — injected rather than imported so this module stays pure and its tests
  // stay silent. Called ONLY on a real change (same dedup as `emit`).
  onTransition?: (t: StatusTransition) => void,
  // Called when the staleness watchdog below declares the hook stream dead. Injected for the same
  // reason `onTransition` is — this module stays pure — and REQUIRED in spirit: hook authority is
  // not a one-way latch, and a consumer that treats it as one reads the time heuristic's guesses as
  // witnessed facts (roborev 54815).
  onHooksDead?: () => void,
): StatusRouter {
  let hooksLive = false;
  // When the last MAIN-SESSION hook event arrived, for the staleness watchdog in fromScreen.
  // Stamped in activate(), because arrival is the liveness signal, not status change:
  // HookStatusEngine dedups, so a long run of same-status events (PreToolUse → working, PostToolUse
  // → working, …) reaches fromHook exactly once, and keying off fromHook alone would let a busy
  // stream look "silent" for minutes. Main-session ONLY is the other half of what makes this
  // trustworthy — createHookEventHandler gates activate(), so a background `claude` sharing the
  // worktree's log cannot hold the clock open while this agent's own stream is dead. Null until the
  // run's first event (and again after reset()), which stops the watchdog firing off a prior run's
  // ghost.
  let lastHookAt: number | null = null;
  // Remember the latest of each source so the screen OR the followup judge can ESCALATE a
  // hook-idle turn to red.
  let lastHook: AgentTabStatus | null = null;
  let lastScreen: AgentTabStatus | null = null;
  // The async followup judge's verdict for the CURRENT finished turn: `waiting` when it decided
  // the agent is blocked on the user (a finished-turn ask like "want me to land it?"), else null.
  // The judge only fires once per Stop, so it can't retract its own verdict. Two things drop it:
  // a new turn opening (any non-idle hook status, see fromHook) and a screen `working` (see
  // fromScreen) — the latter matters because when the hook stream dies, the hook path can never
  // fire again and the screen is the only surviving witness. AgentPane additionally tags each
  // judge dispatch with a turn token and won't apply a verdict that arrives after the turn moved
  // on, so a late verdict never lands here against the wrong turn.
  let lastJudge: AgentTabStatus | null = null;
  // LATCHED (sparkle §6c): the screen reported Claude Code's session-limit picker. Latched rather
  // than read live, and that is the whole design — see the pierce in `resolve` and `clearedByProgress`
  // below for why "the picker is gone" is NOT allowed to retract it.
  let sessionLimitPicker = false;
  // The band a VIEWPORT-CONFIRMED approval/permission prompt is currently asking for ("approval" or
  // "waiting"), or null when the newest screen emit did not carry that reason.
  //
  // NOT LATCHED, and that asymmetry with `sessionLimitPicker` above is the whole design. The picker
  // must survive its own disappearance because a recovery service can press Esc without the wall
  // actually lifting, so "the dialog is gone" proves nothing about whether the agent can work. An
  // approval dialog has no such gap: the only thing that dismisses it is a human answering it, and
  // the agent then visibly resumes. Latching it anyway would buy nothing and cost the property this
  // family of bugs keeps re-learning — a red that cannot retract becomes a stale "Needs you" row
  // (the same defect as the errored dot that never retracts, sparkle PR #1325). Recomputing it from
  // the newest screen emit makes the pierce self-correcting for free, exactly like the idle-only
  // screen escalation below.
  //
  // This is safe ONLY because every viewport-confirmed awaiting emit carries the reason — settle and
  // the late re-check both tag it (statusEngine). If one of those paths ever emits a bare `waiting`
  // for a prompt that is genuinely on screen, the pierce drops and the row falls back to the frozen
  // hook. The `StatusEngine — a tool-approval prompt never reads green` suite in
  // `statusEngine.test.ts` pins that contract from the engine side, driving the real engine+router
  // pair rather than this module alone — a router-only test cannot catch a dropped reason.
  let approvalPrompt: AgentTabStatus | null = null;

  // The one case the hook stream genuinely can't see: Claude fires the same `Stop` (→ idle)
  // whether a turn ended *done* or ended sitting at its own interactive selection menu
  // (the ❯ "1. … 2. …" prompt). The rendered screen CAN tell — `screenAwaitsInput` keys off the
  // ❯ cursor / classic shell prompts (markers, never prose), so a screen `waiting`/`approval` is
  // a real "answer me". When hooks say idle but the screen shows such a prompt, the screen wins
  // (red). This is escalation-only: the screen may lift idle→waiting/approval, never override a
  // hook `working`/`done`/etc., so the deterministic hook signal still owns every other state and
  // the prose-question false-red the hook migration killed stays dead.
  const screenAwaits = () => lastScreen === "waiting" || lastScreen === "approval";
  const judgeAwaits = () => lastJudge === "waiting" || lastJudge === "approval";
  // Fold the sources into one status: hooks own it, but a live on-screen prompt OR a followup-judge
  // verdict escalates a hook-`idle` turn to red. Both escalations are idle-only — they never
  // override a hook `working`/`done`/etc. — so the deterministic hook signal still owns every other
  // state. Always computed from the LATEST of each source, so it re-resolves cleanly whenever any
  // side changes. (The two reds are interchangeable; screen wins ties, arbitrarily.)
  const resolve = (hook: AgentTabStatus): AgentTabStatus => {
    // FAIL-CLOSED override (sparkle-pqxh): a screen-detected mid-stream failure/stall (`errored`)
    // wins over EVERY hook status, including a hook `working`. This is the one escalation that must
    // pierce hook authority, because the bug is precisely that the hook stream stays stuck on
    // `working`/`idle` while the agent is wedged on an API error or self-prompt loop with its
    // process alive (so no Stop/SessionEnd ever fires). The scraper clears this the instant real
    // progress resumes — it emits a non-errored screen status — so it can't outlive recovery.
    if (lastScreen === "errored") return "errored";
    // SECOND FAIL-CLOSED OVERRIDE — the session-limit picker (PRD §6c). Ordered here deliberately:
    // AFTER `errored` (a crashed agent is the more urgent read of the same screen) and BEFORE hook
    // authority, because hook authority is exactly what is broken in this case. A session limit
    // lands MID-TURN, so no `Stop` ever fires, `lastHook` freezes at `working`, and the escalation
    // below — which only lifts a hook-IDLE turn — never gets a look. That is why the founder's whole
    // fleet read GREEN while every agent sat on an unanswered dialog.
    //
    // The band is `waiting`, NOT `blocked`, and that is not a cosmetic choice. `blocked` raises no
    // banner and no dock badge (statusEngine's own rationale: it is for a condition that clears on
    // its own clock), and `attention.needsAttention()` covers only waiting|approval|errored. Routing
    // here to `blocked` would turn the rows red and still page nobody — the letter of the report
    // with its reason dropped. `waiting` ("Needs you") already alerts.
    if (sessionLimitPicker) return "waiting";
    // THIRD FAIL-CLOSED OVERRIDE — a tool-approval / permission prompt on the rendered viewport.
    // Ordered directly under the session limit and for the identical reason, because it is the
    // identical bug one case over: an MCP "Approve?" dialog also opens MID-TURN, so no `Stop` fires,
    // `lastHook` freezes at `working`, and the idle-only escalation below never gets a look. The
    // founder found rows reading GREEN while their agents sat on an unanswered `rename_agent`
    // approval — the same invisible-green state, reached by a different dialog.
    //
    // BELOW the session limit: a walled agent is the more urgent read of the same screen, and a
    // session limit is not merely something to approve.
    //
    // The BAND is whatever statusEngine chose, not a flattened `waiting`. It decides
    // approval-vs-waiting from whether a dangerous action was seen, and collapsing that would report
    // a destructive-action prompt as an ordinary question. Both bands are covered by
    // `attention.needsAttention()`, so either way it pages — this is about the row telling the truth.
    // `hook !== "done"` makes the release DURABLE rather than momentary. Clearing `approvalPrompt`
    // when the `done` arrived was not enough: a dead session emits no further hook events, so
    // `lastHook` stays `done` while the SCREEN can still emit — statusEngine's armed re-check, or a
    // settle, will re-raise `tool-approval-prompt` off any viewport `screenAwaitsInput` still
    // matches (a leftover `❯` frame, or after `claude` exits, the bare shell prompt underneath).
    // That re-raise outranked the terminal `done` and pinned the row red again, permanently. Note
    // `sessionLimitPicker` is not exposed this way: only the actual picker text can re-set it,
    // whereas a plain shell prompt satisfies this reason.
    if (approvalPrompt && hook !== "done") return approvalPrompt;
    if (hook !== "idle") return hook;
    if (screenAwaits()) return lastScreen!;
    if (judgeAwaits()) return lastJudge!;
    return hook;
  };

  /** The reason behind whatever `resolve` just returned. Mirrors its precedence: an `errored` screen
   *  outranks the picker, so it must not be reported as one. */
  const resolveReason = (): StatusReason | null => {
    if (lastScreen === "errored") return null;
    if (sessionLimitPicker) return "session-limit-picker";
    if (approvalPrompt && lastHook !== "done") return "tool-approval-prompt";
    return null;
  };

  // POSITIVE PROGRESS retracts the picker pierce — nothing else does, and "the picker left the
  // screen" explicitly does NOT (PRD §6c). The weaker rule reverts straight to the bug: the instant a
  // recovery service sends `Esc` the latch would drop, `resolve` would fall through to the STILL
  // frozen `working` hook, and the row would go green whether or not the resume actually took —
  // landing back in the invisible-green state this whole change exists to end. So the row holds
  // `waiting` through the whole Esc → did-it-work window, and a recovery service has to VERIFY its
  // resume rather than assume it.
  //
  // What counts, precisely:
  //   - a screen `working` — new agent output. The spinner only redraws while a turn is running, and
  //     a walled agent prints nothing at all.
  //   - a hook `working` — a real tool event (Pre/PostToolUse). Note this is not the common path:
  //     HookStatusEngine dedups, so a resumed tool call under an already-frozen `working` never
  //     reaches fromHook. The screen is the witness that actually fires.
  //   - `done` — the SESSION ENDED (SessionEnd, or the PTY exited). Not progress, but a release all
  //     the same, and a REQUIRED one: a dead process can never emit the `working` the two clauses
  //     above wait for, so without this an agent that exits while parked on the picker resolves to
  //     `waiting` FOREVER and only a re-prepare clears it. That is a permanently red "Needs you" row
  //     on a session that is over — the inverse of the false-green defect this pierce exists to end,
  //     and worse, because a false green on a LIVE agent self-corrects the moment it speaks again
  //     while this never does. The `errored` override this is modelled on has no such hole: it
  //     self-clears on any non-errored screen.
  // What deliberately does NOT count: a hook `idle`. Claude fires a `Notification` idle ping ~60s
  // into any wait, including this one, and that is the picker being unanswered — not progress past it.
  const clearedByProgress = (s: AgentTabStatus): void => {
    if (s === "working" || s === "done") sessionLimitPicker = false;
    // BOTH halves are needed, and the gate in `resolve` does NOT subsume this clear — it only MASKS
    // the flag while `lastHook === "done"`. Without this line `approvalPrompt` survives the session
    // end (only reset() or a later fromScreen recomputes it), so the next non-`done` hook status —
    // a SessionStart after `/clear`, a trailing Notification, a UserPromptSubmit on a resumed
    // session — lifts the mask and resurrects the OLD band with no new screen evidence at all. That
    // is the "red that outlives its evidence" this flag's declaration says it must never be.
    // The clear makes the release stick; the gate makes it durable against a screen re-raise.
    if (s === "done") approvalPrompt = null;
  };

  // Dedup: only forward a genuine change. The router re-resolves on every event from either
  // source, so without this an unchanged value (e.g. a repeat idle hook during an active
  // escalation) would re-emit redundantly. `lastEmitted` is cleared by reset().
  let lastEmitted: AgentTabStatus | null = null;
  let lastReason: StatusReason | null = null;
  // `source`/`input` are what this call is REPORTING; everything else the transition record needs is
  // router state read at emit time. Threaded as parameters rather than module state so a nested
  // re-resolve can't attribute a change to the wrong source.
  //
  // The REASON is deduped alongside the status but does NOT re-emit one: a row already sitting at
  // `waiting` for an ordinary question, which then turns out to be parked on the session-limit
  // picker, is the same colour but a materially different fact — the consumer that acts on the
  // reason has to hear about it. `emit` stays keyed on the status alone so no redundant store write
  // reaches the UI.
  const out = (s: AgentTabStatus, source: StatusTransition["source"], input: AgentTabStatus): void => {
    const reason = resolveReason();
    if (s === lastEmitted && reason === lastReason) return;
    const from = lastEmitted;
    const statusChanged = s !== lastEmitted;
    lastEmitted = s;
    lastReason = reason;
    if (statusChanged) emit(s);
    onTransition?.({ source, input, from, to: s, reason, lastHook, lastScreen, lastJudge, hooksLive });
  };

  return {
    activate: () => {
      hooksLive = true;
      // A real event arrived — that IS the liveness signal, so stamp here rather than only on a
      // status change. Keeps hooksLive and lastHookAt tied to the same event, so they can't drift.
      lastHookAt = now();
    },
    reset: () => {
      hooksLive = false;
      lastHook = null;
      lastScreen = null;
      lastJudge = null;
      lastEmitted = null;
      lastReason = null;
      lastHookAt = null;
      // A re-prepare is a new run; whatever the previous one was parked on is not this one's news.
      sessionLimitPicker = false;
      approvalPrompt = null;
    },
    fromHook: (s) => {
      lastHook = s;
      lastHookAt = now();
      clearedByProgress(s);
      // Any non-idle hook status means the turn the judge spoke about is over — the agent is
      // working again, exited, etc. Drop the verdict so it can't escalate a LATER idle (a stale
      // verdict re-redding the next genuinely-done turn). The judge re-runs on each new Stop.
      if (s !== "idle") lastJudge = null;
      if (hooksLive) out(resolve(s), "hook", s);
    },
    fromScreen: (s) => {
      lastScreen = s;
      // Read the hand-off slot FIRST: statusEngine set it around this very call (see
      // `withScreenReason`), and it is gone the moment this returns. Latch before the progress
      // check, so a single call can never both raise and retract the pierce.
      const screenReason = currentScreenReason();
      if (screenReason === "session-limit-picker") sessionLimitPicker = true;
      else clearedByProgress(s);
      // Recomputed from THIS emit, never accumulated — see `approvalPrompt`'s declaration for why
      // this one is not latched. Any screen emit that does not carry the reason (a resumed spinner,
      // a quiet settle, an exit) drops the pierce in the same breath, so it cannot outlive the
      // evidence. `s` is normalised to the two bands `resolve` may return.
      approvalPrompt =
        screenReason === "tool-approval-prompt" ? (s === "approval" ? "approval" : "waiting") : null;
      // A screen `working` is positive evidence the agent is RUNNING, which disproves any live
      // judge verdict ("this turn is blocked on the user"). Without this the judge escalation had
      // exactly one clear path — a non-idle hook event (see fromHook) — so when the hook stream
      // died, the red outlived the very evidence that disproved it and only an agent reopen cleared
      // it. This gives the judge escalation the same self-correcting property the screen escalation
      // already has (lastScreen is overwritten on every emit; lastJudge had no such path).
      if (s === "working") lastJudge = null;
      // WATCHDOG: the hook stream is dead. Hand authority back to the scraper — exactly the
      // pre-activation state — until the next MAIN-SESSION hook event re-activates it. That
      // re-activation is conditional, deliberately: under a mis-locked session no main-session event
      // ever reaches activate(), so hooks simply never take over again and the scraper keeps the row
      // for the rest of the run. That is the safe outcome — the scraper is the only witness that can
      // still see the agent. Without this, `resolve` keeps returning the frozen hook `idle`
      // (it lets the screen escalate to red but never override to working, since a screen-guessed
      // `working` was the historical false-green source), so a dead stream pins the row gray forever.
      //
      // Death is inferred from a CONTRADICTION that has gone stale, never from silence alone:
      //   - `lastHook === "idle"` — hooks say the turn is CLOSED, but the screen says it's running.
      //     Whatever resumed the agent (UserPromptSubmit, or PreToolUse for its first tool call)
      //     would itself have been an event, so a live stream cannot sit in this state. Requiring it
      //     is what keeps the watchdog off healthy sessions: during a long tool call or a long
      //     thinking block hooks are legitimately silent for minutes, but `lastHook` is "working" —
      //     it AGREES with the screen, there is no wedge, and the row is already green.
      //   - stale past HOOK_STALE_MS — rides out the ordinary race where a screen tick lands just
      //     before the UserPromptSubmit that reopens the turn.
      if (
        hooksLive &&
        s === "working" &&
        lastHook === "idle" &&
        lastHookAt !== null &&
        now() - lastHookAt > HOOK_STALE_MS
      ) {
        hooksLive = false;
        onHooksDead?.();
      }
      if (!hooksLive) {
        // The pierce applies on the scraper-driven path too. Hook freeze is not what creates the
        // hole here, but the second half of it is identical: once `Esc` dismisses the picker the
        // screen is calm, the scraper reads a finished turn, and the row would go gray on an agent
        // that may still be walled. Held until the same progress signal.
        //
        // `errored` FIRST, mirroring `resolve`'s ordering exactly (roborev 58141). A crashed agent
        // is the more urgent read of the same screen, and `resolveReason()` already returns null
        // when `lastScreen === "errored"` — so without this the emitted transition would be a bare
        // `waiting` carrying NO reason: an agent that wedged on an API banner after hitting the
        // limit would be reported as merely needing an answer, with the one field a consumer acts
        // on stripped off.
        out(s === "errored" ? s : sessionLimitPicker ? "waiting" : s, "screen", s);
        return;
      }
      // Hooks own the status; the screen can only ESCALATE a hook-idle turn to red. Re-resolving
      // against the current hook on EVERY screen change (not just when a prompt appears) is what
      // makes the escalation self-correcting: when the screen later reports the prompt is gone
      // (StatusEngine emits working/idle once a menu is answered), a stale `waiting` can no longer
      // re-red the next genuinely-done turn — the escalation depends on the screen source emitting
      // a terminal non-prompt status to clear, which it does. `resolve` keeps the screen from ever
      // overriding a hook working/done, so this never regresses hook authority.
      if (lastHook !== null) out(resolve(lastHook), "screen", s);
    },
    fromJudge: (s) => {
      // Symmetric to fromScreen's escalation: record the verdict and re-resolve against the current
      // hook. resolve() only lifts a hook-`idle` to red, so a verdict that lands while the agent is
      // working/done is remembered but has no effect until (and unless) the hook is idle. Suppressed
      // entirely before hooks are live (a judge can only run off a real Stop event, so this is
      // defensive).
      lastJudge = s;
      if (hooksLive && lastHook !== null) out(resolve(lastHook), "judge", s);
    },
  };
}
