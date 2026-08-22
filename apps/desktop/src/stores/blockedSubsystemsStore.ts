// blockedSubsystemsStore — the current list of subsystems that are COMPLETELY BLOCKED (session/usage
// limit exhausted), shared by the two banners that must agree on it.
//
// ONE POLLER, TWO READERS. `BlockedAgentsBanner` owns the poll (it reads the observable account +
// binding seams and calls `engine/blockedSubsystems.computeBlockedSubsystems`) and writes the result
// here. `AiServiceBanner` READS it, so the mild amber "AI-Enhanced features are paused" bar can step
// aside whenever the worse red "Blocked due to session limits …" bar is showing — the founder's rule
// that the banner must say the WORST condition, not the mildest. Keeping the list in a store rather
// than recomputing it in both places means the two bars can never disagree about whether anything is
// blocked, and the amber bar pays nothing (no second poll) to honour the precedence.
//
// DEFAULT EMPTY IS LOAD-BEARING. When `BlockedAgentsBanner` is not mounted (its own isolated tests,
// or any surface that renders `AiServiceBanner` alone) this stays `[]`, so the amber bar behaves
// exactly as it did before this store existed. Nothing here polls on its own.
import { create } from "zustand";
import { AI_ENHANCED_KEY, type BlockedSubsystem } from "../engine/blockedSubsystems";

interface BlockedSubsystemsState {
  /** The subsystems blocked right now, in the deterministic order the engine produced. Empty when
   *  nothing is blocked. */
  blocked: BlockedSubsystem[];
  /** Replace the whole list from one poll tick. Returns without notifying when the list is unchanged
   *  (same length, same keys in the same order), so a steady-state poll can't churn subscribers into
   *  a re-render loop. */
  setBlocked: (next: BlockedSubsystem[]) => void;
}

/** Are two blocked lists the same reading? Order-sensitive on keys — the engine's order is stable, so
 *  a genuine change (a subsystem blocked/cleared, or the overflow set shifting) always differs. */
function sameList(a: readonly BlockedSubsystem[], b: readonly BlockedSubsystem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.key !== y.key || x.label !== y.label) return false;
  }
  return true;
}

export const useBlockedSubsystemsStore = create<BlockedSubsystemsState>((set, get) => ({
  blocked: [],
  setBlocked: (next) => {
    if (sameList(get().blocked, next)) return;
    set({ blocked: next });
  },
}));

/** True when at least one subsystem is currently blocked. Exported so a consumer can subscribe to the
 *  boolean alone without re-rendering on label-only changes. */
export function selectAnyBlocked(state: BlockedSubsystemsState): boolean {
  return state.blocked.length > 0;
}

/** True when AI Enhancement Features specifically are in the blocked list.
 *
 *  This is the ONLY correct suppressor for the amber `AiServiceBanner`, which is about AI-Enhanced
 *  features on the DEFAULT account. Suppressing on `selectAnyBlocked` would hide that bar whenever an
 *  UNRELATED build agent on a different pool account is benched — a multi-account fleet would then
 *  lose a real, separate AI-Enhanced outage entirely. The red bar and the amber bar must only trade
 *  places when they are about the SAME thing, which is exactly when AI-Enhanced is itself blocked. */
export function selectAiEnhancedBlocked(state: BlockedSubsystemsState): boolean {
  return state.blocked.some((b) => b.key === AI_ENHANCED_KEY);
}
