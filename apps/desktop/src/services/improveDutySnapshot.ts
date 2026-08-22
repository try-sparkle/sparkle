// THE FACTS BEHIND THE PINNED "IMPROVE SPARKLE" DOT, READ ONCE.
//
// Same split this codebase uses everywhere else: this module READS (the gate, the clock, the live
// pass), `engine/sparkleDutyPaint` DECIDES, and `AgentSidebar` renders. Nothing here decides
// anything about colour, and nothing in the engine touches a store.
//
// ── ONE GATE ASSEMBLY, WHICH IS THE POINT OF THE EXPORTED READER ───────────────────────────────
// `services/pusherMount`'s `duties()` states the problem this closes, in its own words:
// `passHoldReason(gate)` needs a `PassGate` assembled from the consent setting, the in-flight flag,
// the Sparkle pane's live status and connectivity — "the scheduler's own decision inputs, which are
// not reachable from a background sweep without duplicating that assembly and risking A SECOND,
// DISAGREEING OPINION", and wiring it "means lifting the gate assembly into a shared reader, which
// belongs with the scheduler". {@link readPassGate} is that reader. `useImprovementScheduler` now
// uses it INSTEAD of its inline copy, so the sentence a surface renders and the decision the
// scheduler actually takes cannot drift apart — two copies of a six-arm gate only stay correct
// while they stay identical.
//
// ⚠️ IT READS `paneBusySinceAt()`, NEVER `notePaneStatus()`. That is not a style preference: the
// scheduler's tick must remain the ONLY sampler of the pane's `working` run. `notePaneStatus` is a
// LATCH WRITER — it starts the clock on the first `working` it sees and clears it on anything else
// — so a second caller on a different interval would restart the wedge clock every time it observed
// a non-working blip, and `pane-wedged` (three whole slots) could then never be reached. The
// docstring on `paneBusySinceAt` says exactly what it is for: "for surfaces that render the hold but
// do not sample". This is that surface, and it is the production caller that function has lacked
// since the "Across the fleet" card was deleted (bead sparkle-yo08a).
import { create } from "zustand";

import {
  IMPROVEMENT_INTERVAL_MS,
  isPassRunning,
  paneBusySinceAt,
  passHoldReason,
  passRetryDueAt,
  type PassGate,
  type PassHoldReason,
} from "./improvementPass";
import { PASS_HOLD_TEXT } from "./pusherSnapshots";
import { SPARKLE_AGENT_ID } from "./sparkleAgent";
import { useConnectionStore } from "../stores/connectionStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useSettingsStore } from "../stores/settingsStore";

/** Everything the dot's hover text is allowed to know. Plain data, so the paint engine that
 *  consumes it needs no store, no clock and no Tauri. */
export type ImproveDutySnapshot = {
  /** WHY no pass is running right now, or `null` when one is due/running. */
  hold: PassHoldReason | null;
  /** `PASS_HOLD_TEXT[hold]`, or `null`. Rendered verbatim — the sentences live in
   *  `pusherSnapshots` and are typed on `PassHoldReason` precisely so a new arm is a compile error,
   *  so they are never restated here. */
  holdText: string | null;
  /** Epoch ms the next hourly slot comes due, or `null` when the clock is unseeded. */
  nextPassAt: number | null;
  /** How long the CURRENT pass child has been running, or `null` when none is live. Written by
   *  {@link noteImprovePassElapsed} from the process poll, NOT recomputed here. */
  passElapsedMs: number | null;
  /** When this snapshot was taken. The paint engine subtracts against it rather than reading a
   *  clock of its own, which is what makes every countdown assertion a seeded, deterministic one. */
  at: number;
};

/** A snapshot that knows nothing — what a window that has never ticked reports. Every field null
 *  means the paint engine falls through to its "the taxonomy label stands" arm, i.e. TODAY'S
 *  BEHAVIOUR. The overlay can only ever add fidelity it has actually observed. */
export const IDLE_IMPROVE_DUTY: ImproveDutySnapshot = {
  hold: null,
  holdText: null,
  nextPassAt: null,
  passElapsedMs: null,
  at: 0,
};

export const useImproveDutyStore = create<ImproveDutySnapshot>(() => IDLE_IMPROVE_DUTY);

/**
 * THE ONE ASSEMBLY of the improvement pass's gate inputs — see the header.
 *
 * Every input is read FRESH on the call, like the scheduler's tick has always read them, so a
 * consent change or a network flap takes effect on the next read without anything re-mounting.
 */
export function readPassGate(now: number): PassGate {
  const settings = useSettingsStore.getState();
  return {
    consent: settings.sparkleImprovementConsent,
    lastRunAt: settings.improvementLastRunAt,
    now,
    passRunning: isPassRunning(),
    paneStatus: useRuntimeStore.getState().status[SPARKLE_AGENT_ID],
    // READ, never sampled. See the header.
    paneBusySince: paneBusySinceAt(),
    retryDueAt: passRetryDueAt(),
    isOnline: useConnectionStore.getState().isOnline,
  };
}

/** Take one reading of the standing duty and publish it for the dot.
 *
 *  `passElapsedMs` is deliberately CARRIED FORWARD rather than recomputed: it is the process's own
 *  answer (`sparkle_improve_active`), owned by {@link noteImprovePassElapsed}, and nothing reachable
 *  from here could produce it. Clobbering it to `null` on every tick would make the elapsed label
 *  flicker on and off at whatever rate the two callers happen to interleave. */
export function refreshImproveDuty(now: number): void {
  const gate = readPassGate(now);
  const hold = passHoldReason(gate);
  const next: ImproveDutySnapshot = {
    hold,
    holdText: hold ? PASS_HOLD_TEXT[hold] : null,
    // Null when the clock is unseeded — there is no next slot to name yet, and inventing one from
    // `now` would promise a pass at a time nothing has scheduled.
    // ⚠️ THE EARLIER OF THE HOURLY SLOT AND AN ARMED RETRY (roborev 67801). `shouldRunImprovementPass`
    // already honours `retryDueAt` — a transient connectivity failure earns ONE re-attempt about five
    // minutes later — so publishing only `lastRunAt + INTERVAL` made the dot hover
    // "Resting — next pass in ~55m" while the next pass was actually minutes away. Wrong by up to a
    // full hour, in precisely the situation this label exists to make honest.
    nextPassAt: nextPassAtFrom(gate),
    passElapsedMs: useImproveDutyStore.getState().passElapsedMs,
    at: now,
  };
  useImproveDutyStore.setState(next);
}

/** Record how long the live pass child has been running — `null` when none is.
 *
 *  Bails out on an unchanged value so a 10s poll on a resting app writes nothing: `zustand` notifies
 *  on every `setState` regardless of equality, and a fresh object every ten seconds would re-render
 *  the whole sidebar forever for a value that never moved. */
export function noteImprovePassElapsed(ms: number | null): void {
  const cur = useImproveDutyStore.getState();
  if (cur.passElapsedMs === ms) return;
  useImproveDutyStore.setState({ ...cur, passElapsedMs: ms });
}

/** Test seam: forget everything observed, as a freshly-launched window would. */
export function resetImproveDutyForTests(): void {
  useImproveDutyStore.setState(IDLE_IMPROVE_DUTY);
}

/** When the next pass is actually due: the hourly slot, or an armed connectivity retry if sooner.
 *
 *  Both inputs come from the SAME `PassGate` the scheduler weighs, so the label cannot disagree with
 *  the decision. Null only when the clock has never been seeded and nothing is armed. */
function nextPassAtFrom(gate: PassGate): number | null {
  const hourly = gate.lastRunAt === null ? null : gate.lastRunAt + IMPROVEMENT_INTERVAL_MS;
  if (gate.retryDueAt == null) return hourly;
  return hourly === null ? gate.retryDueAt : Math.min(gate.retryDueAt, hourly);
}
