// resurrectableDeadStore — THE DURABLE HALF of "which agents are dead in a way the app will recover
// from", so the row-colour pipeline can de-red a resurrectable death it did NOT observe locally.
//
// ── THE GAP THIS CLOSES (bead sparkle-nu7gd9, Defect #1) ──────────────────────────────────────────
// `services/deadSessionRegistry` is WINDOW-LOCAL: it learns a death only from `recordDeath`, which
// `classifyDeath`'s Gate 0 refuses to run unless a pane was MOUNTED in this window at death
// (`liveness === "local"`). The common ENOTFOUND / 529 / connection-lost death — the one the founder
// reported as a red row nobody could act on — kills an agent whose pane this window never mounted, or
// kills the whole fleet at once so no surviving pane records anything. Those deaths are sealed only by
// the Rust reaper in the DURABLE `agent-life` ledger (`revival.rs`), which `revival_due` republishes
// every scan and whose every entry is, by construction, dead-AND-resurrectable (`due_at` skips a
// non-resurrectable cause). The app is ALREADY restarting them — but the window-local registry never
// learns the cause, so `engine/deadSessionAttention.withDeadSessionCalm` demotes nothing and the row
// stays RED against the founder's own rule: red means only a human can unblock it.
//
// This store is the seam the registry's own header points at ("the durable ledger lives in Rust
// behind a `revival_due` invoke on a 15-second sweep"). `services/resurrectionRunner` already reads
// that list every sweep to decide restarts; it now also publishes the list HERE, and
// `deadSessionRegistry.deathCauseForAgent` falls back to it. So a death this window never observed is
// still recognised as resurrectable and rendered amber `lapsed` on every surface that shares
// `deathCauseForAgent` — the sidebar dot (`hooks/useOverlaidStatus`) AND the epic square
// (`useAttentionNotifications.composeRollup`, via `useEpicHealthOf`), which is the "epic squares and
// build-agent dots share one colour source" the bead demanded be cross-checked.
//
// ── IT IS A STORE, NOT A MODULE MAP, FOR ONE REASON: REACTIVITY ──────────────────────────────────
// The window-local `deadSessionRegistry` is a plain Map and needs `useOverlaidStatus`'s bounded
// wake-up ladder to be re-read, because its writer (`noteAgentDeath`) fires within ~one IPC of the
// status write that arms the ladder. This durable list arrives on a DIFFERENT clock — the 15s
// resurrection sweep, with no status write behind it — and in the exact case it exists for (a
// fleet-wide wave) there is no surviving agent left to move any other input. So it MUST be able to
// trigger a render on its own; a zustand slice can, a module Map cannot.
//
// WHOLESALE REPLACE, NOT ACCUMULATE. `syncDurable` mirrors the CURRENT due list exactly: an agent
// that has been claimed+respawned drops out of `revival_due` and must drop out here too, or a working
// agent would keep rendering amber — the one direction this signal must never fail in. A no-op guard
// keeps an unchanged list from churning renders, which on a quiet machine is every 15s forever.
import { create } from "zustand";
import type { DeathCause } from "../engine/deathTypes";

/** One dead-and-resurrectable agent as the durable ledger reports it. */
export interface ResurrectableDead {
  agentId: string;
  /** The ledger's cause. Always resurrectable — `revival::due_at` never emits a non-resurrectable
   *  one — but carried verbatim so a reader can see WHICH recovery is coming, not merely that one is. */
  cause: DeathCause;
}

/** True when the new list is identical (same ids, same causes) to what is stored — so `syncDurable`
 *  can bail out without a state write. Pure and exported for the test that pins the no-op guard: a
 *  guard that never fires would re-render the whole sidebar every sweep, and a guard that fired when
 *  it should not would drop a real update. */
export function sameCauses(
  prev: Record<string, DeathCause>,
  next: ReadonlyArray<ResurrectableDead>,
): boolean {
  const prevKeys = Object.keys(prev);
  if (prevKeys.length !== next.length) return false;
  for (const { agentId, cause } of next) {
    if (prev[agentId] !== cause) return false;
  }
  // Lengths match and every incoming entry agrees with `prev`; with equal counts that also rules out
  // a `prev` key missing from `next` (that would need a `next` entry `prev` lacks, caught above).
  return true;
}

interface ResurrectableDeadState {
  /** agentId → resurrectable death cause, mirroring the Rust `revival_due` list. `undefined` for an
   *  id means "the durable ledger does not list this agent as due" — never "it is alive". */
  causes: Record<string, DeathCause>;
  /** Replace the whole list with the ledger's current due set. No-op when unchanged. Called by the
   *  resurrection sweep once per pass, from the same `revival_due` read it already makes. */
  syncDurable: (due: ReadonlyArray<ResurrectableDead>) => void;
  /** Drop one agent — it is being (re)spawned. Called from `deadSessionRegistry.forgetAgentDeath`,
   *  which runs on every pane mount, so a respawn stops rendering amber HERE by the same act that
   *  reopens the durable record, rather than waiting up to a full sweep for the list to catch up. */
  forget: (agentId: string) => void;
}

export const useResurrectableDeadStore = create<ResurrectableDeadState>((set, get) => ({
  causes: {},
  syncDurable: (due) => {
    if (sameCauses(get().causes, due)) return; // unchanged — do not churn the sidebar
    const causes: Record<string, DeathCause> = {};
    for (const { agentId, cause } of due) causes[agentId] = cause;
    set({ causes });
  },
  forget: (agentId) =>
    set((s) => {
      if (!(agentId in s.causes)) return s; // nothing to drop — avoid a needless state write
      const { [agentId]: _removed, ...causes } = s.causes;
      return { causes };
    }),
}));

/** Non-reactive read for a synchronous caller that is not a component — `deathCauseForAgent`, which
 *  the row-colour overlays call while composing. The reactivity lives in the CONSUMERS subscribing to
 *  `causes`; this only has to return the current value when one of them re-renders. */
export function durableDeadCauseForAgent(agentId: string): DeathCause | undefined {
  return useResurrectableDeadStore.getState().causes[agentId];
}

/** Test seam: empty the durable list so one suite's deaths cannot leak into the next. */
export function _resetResurrectableDeadStoreForTests(): void {
  useResurrectableDeadStore.setState({ causes: {} });
}
