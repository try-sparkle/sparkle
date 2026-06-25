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
  return {
    activate: () => {
      hooksLive = true;
    },
    reset: () => {
      hooksLive = false;
    },
    fromHook: (s) => {
      if (hooksLive) emit(s);
    },
    fromScreen: (s) => {
      if (!hooksLive) emit(s);
    },
  };
}
