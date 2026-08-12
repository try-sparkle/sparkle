// The blocked-prompt grace overlay, WITH a clock that can release it.
//
// `engine/blockedPromptGrace` is pure and takes `now` as an argument — right for the rule, and by
// itself not enough for the UI. A pure overlay only recomputes when its caller re-renders, and the
// 30-second ceiling is a deadline NOTHING ELSE IN THE APP WATCHES. That matters more here than it
// does for the `new` window this hook is modelled on, because of what the ceiling is FOR: it exists
// precisely for the case where the automated answerer is wedged, crashed, or was never invoked for
// this agent at all. In every one of those cases the answerer emits no outcome, the agent emits no
// further status write (`runtimeStore.setStatus` skips an unchanged value), and the pane produces no
// event — so the feed memo's inputs never change again and the held prompt sits CALM FOREVER while
// the founder never learns a question was asked. The hold would have become permanent suppression:
// the exact inversion of "hold it briefly, then surface it".
//
// So the wake-up lives here, once, and every consumer of the rule takes its tick from this hook
// rather than each running its own `useMemo(… Date.now() …)`. A shared deadline implemented twice is
// two chances to implement it differently — see `hooks/useNewAgentCalm`, whose header documents the
// same defect for the `new` overlay (roborev 54743, finding 1) and whose shape this mirrors
// deliberately.
//
// ONLY THE TICK IS EXPORTED, no `useBlockedPromptGrace(...)` status-map sibling. `useNewAgentCalm`
// has both because three surfaces wanted the MAP; here the overlay is applied inside
// `buildConciergeFeed`, in the middle of a composition (after movement-retraction, before
// `publishedStatusFor`) that no hook can wrap. A map-returning hook would have to duplicate that
// placement to be useful, which is how the ordering contract would come to exist in two places. If a
// second consumer ever does want the map, add the sibling here — do not re-derive the order.
import { useEffect, useState } from "react";

import {
  nextPromptGraceExpiry,
  onPromptGraceChanged,
  type PromptGraceLedger,
} from "../engine/blockedPromptGrace";
import type { AgentTabStatus } from "../types";

/** Never sleep for less than this. A deadline that has already passed (or passes within a tick)
 *  would otherwise arm a 0ms timer that re-renders, recomputes an unchanged map, and arms another —
 *  a spin.
 *
 *  The same 250ms floor `hooks/useNewAgentCalm` uses, and it is still coarse enough to be safe
 *  against a window that is 30 seconds rather than five minutes: the worst case is surfacing a
 *  prompt 250ms late, i.e. under 1% of the window, against a spin that would burn a render loop for
 *  as long as the prompt is on screen. Erring late here is also the harmless direction — the rule's
 *  whole risk budget is on the other side, hiding something too long. */
const MIN_WAKE_MS = 250;

/**
 * A counter that increments when the soonest held prompt is due to surface — nothing more.
 *
 * ONE timer, aimed at the SOONEST pending deadline rather than a polling interval. When it fires the
 * caller recomputes; if another agent is still being held, this re-runs and arms the next one.
 * `nextPromptGraceExpiry` returns null once nothing is on a clock, and then NO TIMER EXISTS AT ALL —
 * an idle fleet costs nothing, which is what makes a per-deadline timer preferable to a poll.
 *
 * The caller adds the returned number to the dependency list of whatever it needs re-run (a memo, an
 * effect) WITHOUT referencing it in the body. That is deliberate and is the whole point of the hook:
 * it is the only input that changes when a grace window closes with nothing else happening in the
 * app. See `useConciergeFeed`, which does exactly this for both grace windows.
 *
 * ── WHY THE ASK MAPS ARE PARAMETERS ──────────────────────────────────────────────────────────────
 *
 * The deadline this arms for lives in a MUTABLE ledger whose identity never changes (it is the
 * window singleton), so the effect cannot see a hold begin unless something it *does* track changed.
 * Depending on `agents` + `status` alone is not enough, and the gap is on the ordinary path rather
 * than in a corner: `runtimeStore.setStatus` returns the state unchanged when the value is unchanged,
 * while `setAttentionScreen` always writes fresh maps. So a hold that begins when the capture lands
 * in a LATER render than the status write — which `Terminal.tsx` documents as common, since the
 * scraper's emit is often suppressed by the statusRouter — armed NO timer, and with `tick` unable to
 * move the effect never ran again. The prompt sat calm forever: the exact inversion of "hold it
 * briefly, then surface it" that this hook exists to prevent (roborev 62851, High).
 *
 * The two capture maps change identity on exactly the events that can open an episode, and the feed
 * memo already depends on both, so listing them here costs nothing and closes that hole.
 */
export function usePromptGraceTick<T extends { id: string }>(
  agents: readonly T[],
  ledger: PromptGraceLedger,
  /** runtimeStore.attentionScreen — see the note above. A fresh object on every capture. */
  attentionScreen: Record<string, string>,
  /** runtimeStore.attentionScreenAt — written in lockstep with the map above. */
  attentionScreenAt: Record<string, number>,
  /**
   * runtimeStore.status — A DEPENDENCY ONLY. It is deliberately not read in the body, and must not
   * be "tidied away" for looking unused (roborev 62861).
   *
   * The status map opens eligible episodes by routes the capture maps cannot see, because the
   * capture is deliberately KEPT across them: `setStatus` preserves the snapshot through a
   * `waiting → blocked/errored → waiting` slide, and `Terminal.onStatusWithCapture` only recaptures
   * when the SCRAPER emits — which the statusRouter suppresses once hook events own the status. So
   * the episode is deleted on the way in and re-opened on the way out with both capture maps
   * identity-unchanged. `withMovementRetraction` is the second route: the map
   * `notePromptEpisodes` reads is the RETRACTED one, so an agent can enter or leave a demonstrated
   * ask from elapsed time alone. Either way a hold would begin with nothing to arm its ceiling.
   *
   * This is separate from `nextPromptGraceExpiry` no longer RE-TESTING the status map, which is
   * still right: that call has only the local map while episodes are opened against the merged one.
   * Dropping the re-test was correct; dropping the dependency was not.
   */
  statusMap: Record<string, AgentTabStatus>,
): number {
  const [tick, setTick] = useState(0);
  // THE OTHER HALF OF THE SAME HOLE. An answerer reporting `declined` / `unreachable` mutates a plain
  // Map with no React input behind it, and those two are documented as surfacing IMMEDIATELY — so
  // without a subscription they would wait for an unrelated render, or for the ceiling they exist to
  // pre-empt. The engine fires this only from the outcome path, never from episode maintenance (that
  // runs inside a render).
  //
  // Written as a block with the subscribe on its OWN line rather than the concise
  // `useEffect(() => onPromptGraceChanged(…), [])`. That one-liner cannot be mutation-checked — a
  // mutator commenting it out leaves an unparseable file, so the site is unjudgeable and the
  // subscription could be deleted with the suite still green. Do not tidy it back.
  useEffect(() => {
    const bump = (): void => setTick((t) => t + 1);
    return onPromptGraceChanged(bump);
  }, []);
  useEffect(() => {
    const due = nextPromptGraceExpiry(agents, ledger, Date.now());
    // Nothing held → nothing to wake for. Returning before `setTimeout` is what keeps a quiet fleet
    // at zero timers instead of one no-op timer per render.
    if (due === null) return;
    const wake = Math.max(MIN_WAKE_MS, due - Date.now());
    const h = setTimeout(() => setTick((t) => t + 1), wake);
    return () => clearTimeout(h);
    // `tick` is in the list on purpose: firing has to RE-ARM. When the soonest deadline lapses and a
    // second agent is still inside its own window, this effect must run again to aim at that one —
    // and none of the other inputs changed (the ledger is a mutated singleton, so its identity never
    // changes either). Without `tick` the second prompt would never surface.
  }, [agents, ledger, attentionScreen, attentionScreenAt, statusMap, tick]);
  return tick;
}
