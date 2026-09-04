// Mounts the hourly improvement-pass scheduler (bead sparkle-4xwk.2) — the clock behind the
// consent banner's "once per hour" promise. One instance per app: Workspace mounts it only in
// the MAIN window, so tray/secondary windows never race a duplicate scheduler. The tick is
// deliberately slow (IMPROVEMENT_TICK_MS) and every decision input is read fresh from the
// stores inside the tick, so consent changes take effect on the next tick without re-mounting.
import { useEffect } from "react";
import {
  hourlySlotStamp,
  IMPROVEMENT_TICK_MS,
  isHourlySlotDue,
  isPassRunning,
  notePaneStatus,
  passRetryDueAt,
  runImprovementPass,
  shouldRunImprovementPass,
} from "./services/improvementPass";
import {
  LIVENESS_POLL_MS,
  pollImprovePassLiveness,
  resetImprovePassLiveness,
} from "./services/improvePassLiveness";
import { readPassGate, refreshImproveDuty } from "./services/improveDutySnapshot";
import { SPARKLE_AGENT_ID, SPARKLE_PROJECT_ID } from "./services/sparkleAgent";
import { humanBlockFor } from "./services/humanBlockFor";
import { runIdleReEngage } from "./improvementReadiness";
import { useBeadsStore } from "./stores/beadsStore";
import { useConnectionStore } from "./stores/connectionStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSettingsStore, type SparkleImprovementConsent } from "./stores/settingsStore";

/**
 * NEVER-IDLE ENFORCEMENT (bead sparkle-hrzitj, P0). Bind the live stores to the pure re-engage
 * decision and, on a re-engage verdict, start a pass with the SAME mechanism the hourly path uses —
 * `runImprovementPass`. Called only when the hourly slot is NOT due (the agent is between passes), so
 * it never races or double-runs the hourly pass.
 *
 * The re-engage uses the ordinary DISCOVERY mission (`runImprovementPass(consent, false)`), NOT the
 * claimed-drain (`focusBead`) path: the drain mission's prompt asserts the target bead is already
 * CLAIMED (labelled `draining`) by the backlog-drainer supervisor, which is untrue for a bead the
 * scheduler picked itself — telling the agent that would risk two agents on one bead. The discovery
 * mission instead drains the inbox and pulls the highest-value ready item, CLAIMING as it goes, which
 * is the safe way to re-dispatch onto the top actionable item. The chosen `focus` is logged so the
 * verdict is legible; the mission finds and claims it.
 *
 * `freshSlot: false` and no `focusBead` means the pass does NOT touch the hourly connectivity-retry
 * latch beyond the ordinary reset — and the decision additionally stands down entirely when a retry is
 * armed (`retryArmed`), so the hourly slot's one re-attempt is never disturbed.
 *
 * `unstaffedEpicCount` is passed as 0: the robust "buildable epic with no live orchestrator" reading
 * needs the orchestrator-liveness join that lives in `services/pusherMount.improveUnstaffedEpics`,
 * which this scheduler does not own. Clause B of the founder's rule (no unstaffed epics) is therefore
 * covered by the pusher's existing unstaffed-epic three-alarm nudge; this scheduler enforces clause A
 * (no actionable P0/P1 ready work), which is the half the never-idle watcher did not previously verify
 * against the human-gated distinction. The orchestrator can later feed a real count here (see report).
 */
function maybeReEngageWhenIdle(consent: SparkleImprovementConsent): void {
  runIdleReEngage({
    now: () => Date.now(),
    consent: () => consent,
    paneStatus: () => useRuntimeStore.getState().status[SPARKLE_AGENT_ID],
    // The self-report the founder distrusts, read live so it cannot go stale (humanBlockFor re-reads
    // the flag table on every call, and Rust clears the flag the instant the agent moves).
    selfReportedBlockedOnHuman: () => humanBlockFor(SPARKLE_AGENT_ID) !== undefined,
    passRunning: () => isPassRunning(),
    retryArmed: () => passRetryDueAt() !== null,
    online: () => useConnectionStore.getState().isOnline,
    readyBacklog: () => {
      const snap = useBeadsStore.getState().byProject[SPARKLE_PROJECT_ID];
      // An absent snapshot is UNREADABLE, never an empty board (bead sparkle-hrzitj): the poll is gated
      // on this window owning the project and can fail to start, so `undefined` is routine. The decision
      // stands down on `boardReadable: false` rather than reading it as "nothing to do".
      return { boardReadable: snap !== undefined, readyBeads: snap?.board.backlog ?? [] };
    },
    unstaffedEpicCount: () => 0,
    reEngage: (focus) => {
      if (focus) {
        console.warn(
          "improvement scheduler: auto-re-engaging idle agent — top actionable bead",
          focus.id,
          `(P${focus.priority})`,
        );
      } else {
        console.warn("improvement scheduler: auto-re-engaging idle agent against actionable backlog");
      }
      void runImprovementPass(consent, false);
    },
  });
}

export function useImprovementScheduler(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      const settings = useSettingsStore.getState();
      // Sample the pane BEFORE any early return: this tick is the only regular observer of the
      // pane's status, and a latch that only advanced on ticks that got as far as the gate would
      // never age past the first hold — which is the one measurement the wedge bound needs.
      const paneStatus = useRuntimeStore.getState().status[SPARKLE_AGENT_ID];
      notePaneStatus(paneStatus, Date.now());
      const consent = settings.sparkleImprovementConsent;
      if (consent === "never") return;
      // First-ever tick with consent active: seed the clock instead of running, so the first
      // pass lands ~an hour later rather than ambushing a fresh launch (see settingsStore).
      if (settings.improvementLastRunAt === null) {
        settings.setImprovementLastRunAt(Date.now());
        return;
      }
      const now = Date.now();
      // ONE GATE ASSEMBLY, SHARED — `services/improveDutySnapshot.readPassGate`. It used to be
      // written out inline here, which made this tick the only place in the app that could say WHY
      // the hourly duty was holding; `services/pusherMount`'s `duties()` documents what that cost
      // ("a second, disagreeing opinion") and names the fix as lifting the assembly into a shared
      // reader that "belongs with the scheduler". This is that call site. Every input is still read
      // FRESH inside the tick — the reader reads the stores, it does not cache — so a consent change
      // or a network flap still takes effect on the next tick without re-mounting.
      //
      // Order matters by one line: `notePaneStatus` above is the SAMPLER (this tick is the only
      // one), and the reader consumes the latch it just advanced via the read-only `paneBusySinceAt`.
      const due = shouldRunImprovementPass(readPassGate(now));
      if (!due) {
        // NEVER-IDLE ENFORCEMENT (bead sparkle-hrzitj, P0). The hourly slot is not due, so the agent is
        // resting between passes. The founder's standing rule is that it must NOT rest while there is
        // actionable P0/P1 work or an unstaffed epic — and today the only thing deciding whether it may
        // rest is the agent's own `blocked-on-human` self-report, which nothing checks against the real
        // backlog. `maybeReEngageWhenIdle` verifies that self-report against the ready column and, when
        // the idle is illegitimate, AUTO-RE-ENGAGES a pass. Every safety guard (working pane, a pass
        // already running, an armed connectivity retry, an unreadable board, the cooldown) lives inside
        // `runIdleReEngage`/`decideReEngage`, so this call is safe on every tick.
        maybeReEngageWhenIdle(consent);
        return;
      }
      // Which kind of run this is, read BEFORE the stamp below overwrites the clock: the hourly
      // slot coming due (re-earns the one retry) or the early re-attempt (spends it).
      const freshSlot = isHourlySlotDue(settings.improvementLastRunAt, now);
      // Stamp at ATTEMPT time (not completion) so a slow or failing pass still waits a full
      // hour before the next one — no hot-looping a broken setup. Same `now` the gate weighed,
      // so the reading above and the stamp can't straddle a clock tick.
      //
      // The stamp is the slot BOUNDARY, not this tick: ticks are always a little late (and a lot
      // late when the window is backgrounded and timers throttle), and recording the tick time
      // folds that lateness into the phase forever. See `hourlySlotStamp` for the measurement.
      settings.setImprovementLastRunAt(hourlySlotStamp(settings.improvementLastRunAt, now));
      void runImprovementPass(consent, freshSlot);
    };
    // A short first check (not immediate — let startup I/O settle), then the slow tick.
    const first = setTimeout(tick, 15_000);
    const id = setInterval(tick, IMPROVEMENT_TICK_MS);

    // ── THE ROW'S THIRD, PROCESS-DRIVEN STATUS WRITER ────────────────────────────────────────────
    //
    // Rides this hook rather than getting a mount of its own, and that is the point: this is
    // already the one place the app mounts exactly once, in the MAIN window only — which is also
    // the only window whose Sparkle id is the canonical `SPARKLE_AGENT_ID` this writer keys on
    // (`sparkleAgentIdFor`). A second mount site would be a second thing to forget to wire.
    //
    // Its OWN interval, not a line inside `tick`: the scheduler ticks every five minutes, and five
    // minutes of a GRAY dot on a plainly working agent is the symptom this fixes, not the fix. It
    // is also deliberately outside the tick's consent/due gating — a pass child that is alive is
    // alive whatever the clock thinks, which is exactly the case (a webview reload lost the latch)
    // that leaves the row stranded. See services/improvePassLiveness.
    //
    // ── AND THE DOT'S FACTS, ON THE SAME 10s BEAT ────────────────────────────────────────────────
    // `refreshImproveDuty` publishes the standing duty — which gate is holding, when the next slot
    // is due — for `engine/sparkleDutyPaint` to turn into hover text. It rides THIS interval and not
    // `tick` for the reason stated above in this file's own words: the scheduler ticks every five
    // minutes, and five minutes of a stale dot on a row whose state has already changed is the
    // symptom, not the fix. It only READS (`readPassGate` → `paneBusySinceAt`), so putting it on a
    // second beat cannot disturb the wedge clock the tick above samples.
    //
    // AFTER the poll, not beside it: the poll is what writes `passElapsedMs` and may raise the row's
    // status, so refreshing first would publish a snapshot describing the state one beat ago.
    const livenessTick = async () => {
      await pollImprovePassLiveness();
      refreshImproveDuty(Date.now());
    };
    const livenessFirst = setTimeout(() => void livenessTick(), 1_000);
    const liveness = setInterval(() => void livenessTick(), LIVENESS_POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
      clearTimeout(livenessFirst);
      clearInterval(liveness);
      // Drop the hold without writing — an unmount is not evidence about the child.
      resetImprovePassLiveness();
    };
  }, [enabled]);
}
