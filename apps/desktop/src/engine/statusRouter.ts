// statusRouter (): arbitrate between the two status sources during the migration off
// screen-scraping. Claude Code's hook events are authoritative, but they only start flowing once
// the agent's first hook fires — and non-Claude programs never emit them at all. So the screen
// scraper (statusEngine.ts) drives until the first real hook event arrives; from that moment
// hooks own the status and the scraper's guesses are suppressed. This keeps the deterministic
// hook signal in charge whenever it exists, with zero regression in the window (or programs)
// where it doesn't.
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

export function createStatusRouter(emit: (s: AgentTabStatus) => void): StatusRouter {
  let hooksLive = false;
  // Remember the latest of each source so the screen OR the followup judge can ESCALATE a
  // hook-idle turn to red.
  let lastHook: AgentTabStatus | null = null;
  let lastScreen: AgentTabStatus | null = null;
  // The async followup judge's verdict for the CURRENT finished turn: `waiting` when it decided
  // the agent is blocked on the user (a finished-turn ask like "want me to land it?"), else null.
  // Unlike the screen, the judge can't self-clear (it only fires once per Stop), so a new turn
  // opening — any non-idle hook status — drops it (see fromHook). AgentPane additionally tags each
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
    },
    reset: () => {
      hooksLive = false;
      lastHook = null;
      lastScreen = null;
      lastJudge = null;
      lastEmitted = null;
    },
    fromHook: (s) => {
      lastHook = s;
      // Any non-idle hook status means the turn the judge spoke about is over — the agent is
      // working again, exited, etc. Drop the verdict so it can't escalate a LATER idle (a stale
      // verdict re-redding the next genuinely-done turn). The judge re-runs on each new Stop.
      if (s !== "idle") lastJudge = null;
      if (hooksLive) out(resolve(s));
    },
    fromScreen: (s) => {
      lastScreen = s;
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
