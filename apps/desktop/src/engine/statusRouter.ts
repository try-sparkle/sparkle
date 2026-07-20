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

export function createStatusRouter(
  emit: (s: AgentTabStatus) => void,
  // Injected so tests are deterministic without fake timers.
  now: () => number = () => Date.now(),
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
    if (hook !== "idle") return hook;
    if (screenAwaits()) return lastScreen!;
    if (judgeAwaits()) return lastJudge!;
    return hook;
  };

  // Dedup: only forward a genuine change. The router re-resolves on every event from either
  // source, so without this an unchanged value (e.g. a repeat idle hook during an active
  // escalation) would re-emit redundantly. `lastEmitted` is cleared by reset().
  let lastEmitted: AgentTabStatus | null = null;
  const out = (s: AgentTabStatus): void => {
    if (s !== lastEmitted) {
      lastEmitted = s;
      emit(s);
    }
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
      lastHookAt = null;
    },
    fromHook: (s) => {
      lastHook = s;
      lastHookAt = now();
      // Any non-idle hook status means the turn the judge spoke about is over — the agent is
      // working again, exited, etc. Drop the verdict so it can't escalate a LATER idle (a stale
      // verdict re-redding the next genuinely-done turn). The judge re-runs on each new Stop.
      if (s !== "idle") lastJudge = null;
      if (hooksLive) out(resolve(s));
    },
    fromScreen: (s) => {
      lastScreen = s;
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
      }
      if (!hooksLive) {
        out(s);
        return;
      }
      // Hooks own the status; the screen can only ESCALATE a hook-idle turn to red. Re-resolving
      // against the current hook on EVERY screen change (not just when a prompt appears) is what
      // makes the escalation self-correcting: when the screen later reports the prompt is gone
      // (StatusEngine emits working/idle once a menu is answered), a stale `waiting` can no longer
      // re-red the next genuinely-done turn — the escalation depends on the screen source emitting
      // a terminal non-prompt status to clear, which it does. `resolve` keeps the screen from ever
      // overriding a hook working/done, so this never regresses hook authority.
      if (lastHook !== null) out(resolve(lastHook));
    },
    fromJudge: (s) => {
      // Symmetric to fromScreen's escalation: record the verdict and re-resolve against the current
      // hook. resolve() only lifts a hook-`idle` to red, so a verdict that lands while the agent is
      // working/done is remembered but has no effect until (and unless) the hook is idle. Suppressed
      // entirely before hooks are live (a judge can only run off a real Stop event, so this is
      // defensive).
      lastJudge = s;
      if (hooksLive && lastHook !== null) out(resolve(lastHook));
    },
  };
}
