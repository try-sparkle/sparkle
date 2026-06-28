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
}

export function createStatusRouter(emit: (s: AgentTabStatus) => void): StatusRouter {
  let hooksLive = false;
  // Remember the latest of each source so the screen can ESCALATE a hook-idle turn to red.
  let lastHook: AgentTabStatus | null = null;
  let lastScreen: AgentTabStatus | null = null;

  // The one case the hook stream genuinely can't see: Claude fires the same `Stop` (→ idle)
  // whether a turn ended *done* or ended sitting at its own interactive selection menu
  // (the ❯ "1. … 2. …" prompt). The rendered screen CAN tell — `screenAwaitsInput` keys off the
  // ❯ cursor / classic shell prompts (markers, never prose), so a screen `waiting`/`approval` is
  // a real "answer me". When hooks say idle but the screen shows such a prompt, the screen wins
  // (red). This is escalation-only: the screen may lift idle→waiting/approval, never override a
  // hook `working`/`done`/etc., so the deterministic hook signal still owns every other state and
  // the prose-question false-red the hook migration killed stays dead.
  const screenAwaits = () => lastScreen === "waiting" || lastScreen === "approval";
  // Fold the two sources into one status: hooks own it, but a live on-screen prompt escalates a
  // hook-`idle` turn to red. Always computed from the LATEST of each source, so it re-resolves
  // cleanly whenever either side changes.
  const resolve = (hook: AgentTabStatus): AgentTabStatus =>
    hook === "idle" && screenAwaits() ? lastScreen! : hook;

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
      lastEmitted = null;
    },
    fromHook: (s) => {
      lastHook = s;
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
  };
}
