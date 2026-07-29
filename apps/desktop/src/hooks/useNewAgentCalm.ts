// The `new` overlay, WITH a clock that can release it.
//
// `engine/newAgentAttention.withNewAgentCalm` is pure and takes `now` as an argument, which is right
// for the rule and insufficient for the UI: a pure overlay only recomputes when its caller
// re-renders, and the 5-minute backstop is a deadline nothing else is watching. The one status that
// branch actually governs is `errored`, and an errored agent produces no further status writes —
// `runtimeStore.setStatus` skips an unchanged value — so the memo's inputs (`agents`, `statusMap`,
// `interaction`) never change again and the window never lapses. The row would sit gray `new`
// indefinitely while `get_agent_status`, which samples the clock on every call, reported `errored` /
// `needsYou: true`. Three surfaces had the identical defect (roborev 54743, finding 1).
//
// So the wake-up lives here, once, and all three call sites take the overlay from this hook rather
// than each running their own `useMemo(… Date.now() …)`. A shared deadline implemented three times
// is three chances to implement it differently.
import { useEffect, useMemo, useState } from "react";

import {
  nextGraceExpiry,
  withNewAgentCalm,
  type BriefableAgent,
} from "../engine/newAgentAttention";
import type { AgentTabStatus } from "../types";

/** Never sleep for less than this. A deadline that has already passed (or passes within a tick)
 *  would otherwise arm a 0ms timer that re-renders, recomputes an unchanged map, and arms another —
 *  a spin. One coarse floor is enough because the window it guards is five minutes. */
const MIN_WAKE_MS = 250;

/**
 * `statusMap` with `new` overlaid onto briefless freshly-spawned agents, re-evaluated when the
 * earliest held red is due to surface.
 *
 * Returns the SAME reference as `statusMap` when nothing is corrected, exactly as the pure overlay
 * does, so this does not introduce render churn at any call site.
 */
export function useNewAgentCalm<T extends BriefableAgent>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  interaction: Record<string, number> = {},
): Record<string, AgentTabStatus> {
  const tick = useNewAgentGraceTick(agents, statusMap, interaction);
  return useMemo(
    () => withNewAgentCalm(agents, statusMap, Date.now(), interaction),
    // `tick` is deliberate and is the whole point of this hook: it is the only input that changes
    // when a grace window closes with nothing else happening in the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [agents, statusMap, interaction, tick],
  );
}

/**
 * A counter that increments when the soonest held red is due to surface — nothing more.
 *
 * Split out because not every consumer of the rule wants a status MAP. `useRosterPublisher` calls
 * `calmNewAgent` per agent while building a multi-project payload, and it publishes from an effect
 * keyed on its inputs, so it has exactly the same never-wakes-up problem and none of the same
 * shape. It takes this and adds it to its dependency list.
 *
 * ONE timer, aimed at the SOONEST pending deadline rather than a polling interval. When it fires the
 * caller recomputes; if another agent is still being held, this re-runs and arms the next one.
 * `nextGraceExpiry` returns null once nothing is on a clock, and then no timer exists at all.
 */
export function useNewAgentGraceTick<T extends BriefableAgent>(
  agents: readonly T[],
  statusMap: Record<string, AgentTabStatus>,
  interaction: Record<string, number> = {},
): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const due = nextGraceExpiry(agents, statusMap, Date.now(), interaction);
    if (due === null) return;
    const h = setTimeout(() => setTick((t) => t + 1), Math.max(MIN_WAKE_MS, due - Date.now()));
    return () => clearTimeout(h);
  }, [agents, statusMap, interaction, tick]);
  return tick;
}
