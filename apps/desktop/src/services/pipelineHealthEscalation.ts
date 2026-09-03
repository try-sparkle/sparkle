// pipelineHealthEscalation — REAL-TIME escalation of a pipeline component crossing INTO a bad state.
//
// ── WHY THIS EXISTS (the founder, verbatim) ──────────────────────────────────────────────────────
// "So this is the last time you have to paste me a pipeline warning." The hourly `pipeline-health-
// scan.sh` already files a deduped bead per non-green component — durable, but up to an HOUR late,
// and it does not wake anyone. The gap it leaves is the EDGE: the moment roborev wedges, or the CI
// pool stocks out, or the release runner drops offline, nobody is told until either the next hourly
// scan or the founder himself notices and pastes the warning in. This module closes that gap by
// escalating the TRANSITION the instant the store's 60s poll observes it.
//
// ── EDGE-TRIGGERED, NEVER STEADY-STATE ───────────────────────────────────────────────────────────
// The store keeps the PRIOR snapshot (its header: "A FAILED POLL NEVER CLEARS WHAT IS KNOWN"), so
// each poll gives us prev→next. We escalate only when a component crosses INTO a worse alarm state
// (green→warning/blocking, or warning→blocking) — the EDGE. A component that is bad and STAYS bad
// moves no edge and fires nothing, so a wedged daemon does not re-page every 60s. A bad→green
// crossing fires a RECOVERY notice so the founder/agent knows it cleared. The very first poll has no
// prior (prev === null) and so establishes a baseline WITHOUT alerting — an already-bad component at
// startup is a steady state, not a transition.
//
// ── SEVERITY GATING (cost-insensitive to tokens, allergic to noise) ──────────────────────────────
//   • BLOCKING — always escalates immediately (a deployment is prevented).
//   • WARNING  — escalates, but DEBOUNCED per component: a second warning edge for the same
//                component within WARNING_DEBOUNCE_MS is suppressed, so a flapping warning cannot
//                spam. (A steady warning is already silent via the edge rule; the debounce guards
//                the flap green→warning→green→warning.) The window is measured from the last
//                warning DELIVERED and an intervening recovery does not reset it — otherwise the
//                debounce is vacuous for the exact flap it names, since that flap crosses a
//                recovery every cycle. `passesGate` carries the measurement.
//   • RECOVERY — fires for an alarm that was ANNOUNCED. One whose warning the debounce swallowed is
//                swallowed too: an all-clear for an alarm the reader never heard is pure noise, and
//                delivering it would leave the flap half-loud.
//   • UNKNOWN  — NEVER alarms. "I could not read this meter" is not a proven outage (the same rule
//                the chip paints amber, not red, and pipeline_health.rs classifies an unreadable
//                source UNKNOWN not blocking). A crossing INTO unknown produces no event at all.
//   • HEALTHY / NOT_APPLICABLE — a good state never alarms; crossing into it from an alarm state is
//                the RECOVERY notice.
//
// ── ROUTING: a HUMAN does not have to ────────────────────────────────────────────────────────────
// Two channels, so both the concierge (visible) and the Improve-Sparkle agent (can ACT) learn of it:
//   • CONCIERGE FEED — `notifyConcierge`, the sanctioned "push the concierge from outside its mount"
//     seam (conciergeNotifier.ts). Best-effort VISIBILITY: it fails when no concierge window is
//     mounted, which is a real state, not a defect.
//   • IMPROVE-SPARKLE WAKE — a content-carrying doorbell into the `__sparkle_self__` inbox
//     (`inbox_send`, severity `act`), which the hourly improvement pass drains and can act on. This
//     is BOTH the wake AND a DURABLE record (the inbox is on disk, survives worker spin-down).
//
// ── FAIL-SAFE: the durable bead is the floor, the real-time push is on top ────────────────────────
// `inbox_send` and `notifyConcierge` have both been caught reporting success they did not observe
// (sparkle-bbghz, sparkle-qogah), so neither return value is trusted as delivery. The push is
// BEST-EFFORT. Durability comes from the bead: the hourly `pipeline-health-scan.sh` files a deduped
// `phc-<id>` bead regardless of anything here. And when the DURABLE real-time channel (the improve
// inbox) itself fails for an ALARM event, this module files that same deduped bead NOW rather than
// waiting up to an hour — so a failed real-time delivery still leaves a durable record. Recovery
// notices never file a bead (nothing is wrong to record).
//
// THE SAME DISTRUST APPLIES TO THE FLOOR. `create_bead_full` RESOLVES with bd's caught-error JSON on
// a refused write, so awaiting it proves nothing; the fail-safe confirms a new bead id before it
// claims one was filed (`assertBeadWasCreated`). Without that, a store that refuses every write
// makes the last sink report success and the "this alarm is LOST" line unreachable.
import { invoke } from "@tauri-apps/api/core";

import { log } from "../logger";
import type { HealthState, PipelineHealth } from "../stores/pipelineHealthStore";
import { notifyConcierge } from "./conciergeNotifier";
import { SPARKLE_AGENT_ID } from "./sparkleAgent";

/** The three kinds of escalation this module emits. `blocking`/`warning` are alarms; `recovery` is
 *  the all-clear when a component returns from an alarm state to a good one. */
export type EscalationSeverity = "blocking" | "warning" | "recovery";

/** One escalation-worthy transition, resolved from a prev→next snapshot pair. */
export interface EscalationEvent {
  componentId: string;
  name: string;
  from: HealthState;
  to: HealthState;
  severity: EscalationSeverity;
  /** The component's `detail` in the NEW reading — the "why" the chip shows. */
  detail: string;
  /** The known remediation for this component, or null when none is codified. */
  remediation: string | null;
}

/**
 * How long a component's WARNING alarm is debounced. A second warning EDGE for the same component
 * within this window is suppressed. THIRTY MINUTES — long enough that a component flapping
 * green↔warning on the 60s poll cannot spam, short enough that a genuinely new warning after the
 * situation has settled is not swallowed. BLOCKING is never debounced; RECOVERY is never debounced.
 */
export const WARNING_DEBOUNCE_MS = 30 * 60 * 1000;

/** Severity ordering, so "worse" is a comparison rather than a table of pairs.
 *  good (healthy / not_applicable) < unknown < warning < blocking. */
function severityRank(s: HealthState): number {
  switch (s) {
    case "blocking":
      return 3;
    case "warning":
      return 2;
    case "unknown":
      return 1;
    case "healthy":
    case "not_applicable":
      return 0;
  }
}

/** An ALARM state is one we would page about: warning or blocking. Unknown is deliberately NOT an
 *  alarm (an unreadable meter is not a failure), and neither good state is. */
function isAlarmState(s: HealthState): boolean {
  return s === "warning" || s === "blocking";
}

/** A GOOD state is one a recovery lands in: healthy or deliberately-off. */
function isGoodState(s: HealthState): boolean {
  return s === "healthy" || s === "not_applicable";
}

/**
 * THE ROBOREV REMEDY MUST AGREE WITH THE VERDICT IT IS APPENDED TO (bead `sparkle-ifs2cj`).
 *
 * This used to be one constant string — "run `scripts/roborev-maintenance.sh --watchdog` to
 * restart/compact the wedged daemon" — returned for EVERY roborev reading. The classifier in
 * `scripts/lib/pipeline-health.sh` distinguishes five cases, and that one string CONTRADICTS FOUR
 * OF THEM. Measured on this machine, in a single alert:
 *
 *   body:   "the daemon process is ALIVE and ~/.roborev/reviews.db is 975 MB — this is SLOW, not
 *            wedged: a store that size takes longer to open than the 8s probe waits, so the probe
 *            is reporting its own timeout"
 *   remedy: "... to restart/compact the WEDGED daemon."
 *
 * The body correctly diagnoses "slow, not wedged" and the very next line prescribes the wedge
 * remedy, using the word its own body just disproved. AGENTS.md's rule is that a remedy is an
 * instruction someone will follow — and following this one restarts a HEALTHY daemon. On this
 * machine that is actively harmful: launchd restarts whatever you stop, and the failed start
 * orphans a process holding 127.0.0.1:7373, which is the state that then blocks `--compact`
 * entirely (bead `sparkle-t9b3k6`). So a correct verdict with a wrong remedy has fixed nothing for
 * the human reading it; the COULD-NOT-LOOK / IS-DOWN split has to reach the REMEDY, not just the
 * state.
 *
 * Keyed on stable phrases the classifier's own arms emit. `roborevRemediation` is exported so the
 * suite can assert the one invariant that matters: NO restart/watchdog language on any arm that is
 * not a proven wedge or a proven absence.
 *
 * THE DEFAULT IS THE SAFETY PROPERTY, not a fallback. An absent or unrecognised detail returns the
 * DIAGNOSE-FIRST text, never the restart text, because the harm is asymmetric: withholding a
 * restart from a genuinely wedged daemon costs a diagnostic round trip, while prescribing one for a
 * merely-slow daemon orphans the port. A new classifier arm this function has never seen therefore
 * degrades to "go and look", which is always safe to follow.
 */
export function roborevRemediation(detail?: string): string {
  const d = detail ?? "";

  // A PROVEN WEDGE is the ONE case a restart is right — and it is `launchctl kickstart`, never
  // `--watchdog`, and never `roborev daemon stop && start`, which is broken on this machine.
  if (/genuine WEDGE/i.test(d)) {
    return (
      "Code review is WEDGED (the store is small, so this is the daemon itself, not store slowness) — " +
      "restart it with `launchctl kickstart -k gui/$(id -u)/co.plow.roborev-daemon`. " +
      "NOT `roborev daemon stop && roborev daemon start`: it is broken on this machine and each failed " +
      "start orphans a process holding 127.0.0.1:7373."
    );
  }

  // ABSENT — nothing to restart; it has to be started, and only launchd can do it correctly.
  if (/no roborev daemon process/i.test(d)) {
    return (
      "The review daemon is NOT RUNNING — start it with " +
      "`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/co.plow.roborev-daemon.plist` " +
      "(or `launchctl kickstart -k gui/$(id -u)/co.plow.roborev-daemon` if it is already loaded). " +
      "`roborev daemon start` is broken here — it needs setsid, and each failed attempt orphans a " +
      "process holding 127.0.0.1:7373."
    );
  }

  // SLOW — the store is the disease. NOTE WHAT THIS RECOMMENDS FIRST: the retention sweep's
  // RETENTION half is an online UPDATE that needs NO quiet window and NO daemon downtime, and
  // measured end to end on a copy of the real store it took the file from 955.7 MB to 264.1 MB
  // (72.4%) in six seconds while keeping every one of 19,870 verdicts. That is the whole reason to
  // lead with it rather than with `--compact`: compaction needs the fleet quiet and the daemon
  // down, and on a busy machine that window may simply not exist.
  if (/SLOW, not wedged/i.test(d)) {
    return (
      "Code review is SLOW, not wedged — the daemon is alive and the probe is reporting its own " +
      "timeout against a bloated store. DO NOT RESTART IT. The store size is the disease: " +
      "`scripts/roborev-retention-sweep.sh --report` (read-only) shows what is reclaimable, and its " +
      "retention pass is an ONLINE update that needs no downtime and no quiet fleet. Only the " +
      "VACUUM half needs the daemon stopped, and the sweep refuses cleanly when the queue is not idle."
    );
  }

  // CONTENDED — a restart provably does not clear lock contention; it just re-contends within the hour.
  if (/THROTTLED by lock contention/i.test(d)) {
    return (
      "Code review is THROTTLED by SQLite write-lock contention, not wedged — review is slowed, not " +
      "stopped. A restart does NOT clear contention (the workers re-contend within the hour). Shrink " +
      "the store instead: `scripts/roborev-retention-sweep.sh --report`, whose retention pass runs " +
      "online against a live daemon."
    );
  }

  // UNDETERMINED — the probe could not look. Say exactly that, and prescribe looking.
  if (/UNDETERMINED/i.test(d)) {
    return (
      "The cause is UNDETERMINED — a daemon that is merely slow behind a bloated store and one that " +
      "is genuinely wedged look identical from here and need OPPOSITE remedies. Do not restart blind. " +
      "Diagnose first: `scripts/roborev-maintenance.sh --status` and `pgrep -fl \"roborev daemon\"`."
    );
  }

  // DEFAULT — see the block comment: diagnose-first, never restart-first.
  return (
    "Code review is degraded — diagnose before acting, because slow and wedged look identical from " +
    "the probe and need opposite remedies: `scripts/roborev-maintenance.sh --status`, and " +
    "`scripts/roborev-retention-sweep.sh --report` for the store size. Do not restart blind."
  );
}

/**
 * The codified remediation per component id (mirrors the ids in `pipeline_health.rs`). Returns the
 * concrete next action so the alert is actionable, not just a notification. `null` for an unknown id
 * — the message still names the component and severity, it simply has no canned fix to append.
 */
export function remediationFor(componentId: string, detail?: string): string | null {
  switch (componentId) {
    case "roborev":
      return roborevRemediation(detail);
    case "ci_runners":
      // DO NOT PROMISE THE AUTOSCALER WILL ADD CAPACITY (bead `sparkle-ot4dxb`). This alarm now only
      // fires on a genuine backlog free runners are not draining, and the measured cause of that is a
      // pool already HELD at its GCP quota ceiling (CPUS_ALL_REGIONS) with all Spot regions stocked
      // out — a condition under which `ci-autoscale-tick.sh` correctly declines and adds nothing.
      // AGENTS.md's rule is that a remedy string is an instruction someone will follow, so pointing
      // at a script that no-ops under exactly the condition that triggered the alert is worse than
      // no remedy: it burns the reader's trust in the line. Name the real blocker instead.
      return (
        "CI test capacity is short — a real backlog is queued that free runners are not draining. " +
        "Check the autoscaler's verdict with `scripts/runner/ci-autoscale-tick.sh` (dry run): if it " +
        "reports HOLD because the pool is ceiling-clamped (CPUS_ALL_REGIONS) or every Spot region is " +
        "stocked out, it is already at the GCP quota ceiling and re-running it adds nothing — the ONLY " +
        "remediation is raising that quota, which is a founder spend decision tracked on sparkle-skcxyj."
      );
    case "release_runner":
      return "The release runner (DMG build) is offline — wake the founder's Mac, and repair the runner with `sudo scripts/runner/setup-self-hosted-runner.sh` if it does not re-register.";
    case "knightwatch":
      // TWO THINGS WERE WRONG WITH THE PREVIOUS STRING, and both are the kind AGENTS.md warns about
      // (a remedy is an instruction someone will follow).
      //
      //   1. IT NAMED A DEAD PATH. It said "reprovision it with `scripts/knightwatch/provision-vm.sh`",
      //      but the configured reviewer is `sparkle-reviewer` — a local `claude` call dispatched per
      //      push by the app's babysit sweep, not a VM. `pipeline_health.rs`'s own RESTART constant,
      //      attached to the very detail this remedy is appended to, says `scripts/pr-review.sh
      //      <PR#> --post`. The alert contradicted its own evidence.
      //   2. IT OVERCLAIMED. "is unavailable" is an ABSENCE CLAIM (bead `sparkle-gazo4a`), and the
      //      reading behind this component is a freshness heuristic over a comment window — it can
      //      say the reviewer has not posted lately, never that it is down. It said "unavailable" at
      //      the exact moment the reviewer was posting a substantive review on a live PR.
      //
      // Note the component now reports `unknown` rather than `warning` whenever that window could
      // not be read back far enough to judge, so this string is only reached on a reading that DID
      // cover the question — and it still only claims what such a reading supports.
      return "The PR reviewer (sparkle-reviewer) has not posted a review recently while PRs are waiting — it is dispatched by the app's babysit sweep, so review one manually with `scripts/pr-review.sh <PR#> --post` and check why the sweep is not dispatching.";
    case "release_publication":
      // NEVER SAY "RE-DISPATCH" HERE. This string used to end "…and the tagged commit's CI gate
      // before re-dispatching", and re-dispatching a HELD tag is the one action release.yml
      // explicitly forbids. Its own error text (.github/workflows/release.yml, the CI-RED branch)
      // reads: "Fix the tree and cut a NEW version; re-dispatching this tag re-hits the same red
      // run." AGENTS.md's rule is that a remedy string is an instruction someone will follow, so a
      // remedy that burns a full signed, notarized build (~27 minutes on the founder's own Mac) to
      // land back on the identical red gate is worse than no remedy at all.
      //
      // The two remedies below are the ones that actually terminate. Cutting a new version from
      // green main is the fix when the work should ship; recording the tag in the baseline is the
      // fix when it should not — and that file is the same one the probe reads to decide whether
      // an orphan is accepted, so writing to it also stops this alarm recurring.
      return (
        "Release publication is stuck — read the latest `release.yml` run (`gh run list --workflow release.yml`) " +
        "and the tagged commit's CI gate (`scripts/lib/ci-gate.sh`) to see WHY. Do NOT re-dispatch a held tag: " +
        "release.yml refuses it and it re-hits the same red run. Either cut a NEW version from green main " +
        "(`scripts/cut-dmg.sh --yes`), or record the tag as abandoned in `.github/release-orphan-baseline.txt`."
      );
    default:
      return null;
  }
}

/** The human severity word for an alarm state, used in the alert's first line. */
function severityWord(state: HealthState): string {
  return state === "blocking" ? "BLOCKING" : state === "warning" ? "WARNING" : state;
}

/**
 * Compose the alert text — deterministic so callers (and tests) can assert it names the component,
 * the new severity, and the remediation. This is the body both the concierge feed and the improve
 * inbox doorbell carry, and the body the fail-safe bead records.
 */
export function composeEscalationMessage(ev: EscalationEvent): string {
  if (ev.severity === "recovery") {
    // THE READING, THEN THE CONCLUSION — and never an unconditional "no action needed".
    //
    // This message used to end "No action needed; close the pipeline-health bead for this
    // component if one is open." It was measured announcing "CI test runners RECOVERED — 1 of 21
    // idle and ready" at an instant when 43 runs were queued, 20 of 21 runners were busy, and
    // main's three newest CI runs were all sitting queued. A wrong verdict that ALSO instructs the
    // reader to stop tracking the thing it was wrong about erases its own evidence, which is the
    // single most expensive shape this module can produce.
    //
    // The predicate that produced that verdict is fixed upstream (classify_ci_pool now reads queue
    // depth, so "idle > 0" alone can no longer mean healthy). This half is the belt: an all-clear
    // is derived from ONE poll of ONE component, which is never by itself grounds to close a
    // durable finding, so it hands over the reading it was computed from and asks the reader to
    // confirm rather than asserting there is nothing left to do.
    return (
      `Pipeline health — ${ev.name} RECOVERED (was ${severityWord(ev.from)}, now ${ev.to}).\n` +
      `${ev.detail}\n` +
      `This is one poll of one component. Confirm against that reading before closing any ` +
      `pipeline-health bead for it.`
    );
  }
  const head = `Pipeline health — ${ev.name} just went ${severityWord(ev.to)} (was ${ev.from}).`;
  const why = ev.detail ? `\n${ev.detail}` : "";
  const fix = ev.remediation ? `\nRemediation: ${ev.remediation}` : "";
  return `${head}${why}${fix}`;
}

/**
 * PURE transition detection: given the prior and current snapshots, return every escalation-worthy
 * crossing (worse-edge alarms + recoveries), WITHOUT any debounce gating. Gating and delivery are
 * `escalatePipelineHealth`'s job.
 *
 *   • prev === null → first reading, establish baseline, emit nothing (a bad component at startup is
 *     a steady state, not a transition).
 *   • A component absent from prev → no baseline for it → skip (never alarm on first sighting).
 *   • rank(next) > rank(prev) AND next is an alarm state → a worse edge → blocking|warning event.
 *   • prev is an alarm state AND next is a good state → recovery event.
 *   • Everything else (steady state, crossing into/out of unknown, blocking→warning partial thaw) →
 *     no event.
 */
export function detectEscalations(
  prev: PipelineHealth | null,
  next: PipelineHealth,
): EscalationEvent[] {
  if (prev === null) return [];
  const prevById = new Map(prev.components.map((c) => [c.id, c]));
  const out: EscalationEvent[] = [];
  for (const cur of next.components) {
    const before = prevById.get(cur.id);
    if (before === undefined) continue; // no baseline for this component
    const from = before.state;
    const to = cur.state;
    if (from === to) continue;

    if (severityRank(to) > severityRank(from) && isAlarmState(to)) {
      out.push({
        componentId: cur.id,
        name: cur.name,
        from,
        to,
        severity: to === "blocking" ? "blocking" : "warning",
        detail: cur.detail,
        // The DETAIL is passed so the remedy can agree with the verdict — see roborevRemediation.
        remediation: remediationFor(cur.id, cur.detail),
      });
    } else if (isAlarmState(from) && isGoodState(to)) {
      out.push({
        componentId: cur.id,
        name: cur.name,
        from,
        to,
        severity: "recovery",
        detail: cur.detail,
        remediation: null,
      });
    }
  }
  return out;
}

/** The delivery + durability seams, injected so the whole gate→route→fail-safe flow is testable by
 *  asserting the CALLS (not just that a handler exists). Production wiring is `liveEscalationDeps`. */
export interface EscalationDeps {
  now: () => number;
  /** Push to the concierge feed (visibility). Returns whether it was ACCEPTED — see conciergeNotifier. */
  notifyConcierge: (text: string) => boolean;
  /** Wake the Improve-Sparkle agent via a durable inbox doorbell. Resolves true only if it landed. */
  wakeImprove: (text: string) => Promise<boolean>;
  /** LAST-RESORT durability: file the same deduped pipeline-health bead NOW. Called only for an
   *  ALARM event whose durable inbox channel failed, so a failed real-time push still leaves a bead. */
  fileDurableBead: (ev: EscalationEvent, text: string) => Promise<void>;
}

/** Per-component timestamp of the last WARNING alarm actually delivered, for the debounce. Module
 *  scope so it persists across polls; reset for tests via `__resetPipelineEscalationForTests`. */
const lastWarningAt = new Map<string, number>();

/**
 * Components whose most recent WARNING edge was SUPPRESSED by the debounce — i.e. an alarm is
 * outstanding that nobody was ever told about. The recovery that clears such an alarm is suppressed
 * too, and consumes the flag. See `passesGate` for why both halves are needed.
 */
const unannouncedAlarm = new Set<string>();

/**
 * Should this event be delivered right now? Applies the severity gate:
 *   • blocking → always.
 *   • warning  → only outside the per-component debounce window; records the time when it passes.
 *   • recovery → unless it clears an alarm that was itself suppressed (see below).
 * (Unknown never reaches here — `detectEscalations` emits no event for it.)
 *
 * ── THE DEBOUNCE MUST SURVIVE THE RECOVERY, or it cannot guard the flap it exists for ────────────
 * This gate used to `lastWarningAt.delete(...)` on every recovery, on the reasoning that a settled
 * component's next warning should not be swallowed. That reasoning defeats the debounce ENTIRELY,
 * because the flap this module's header names — green→warning→green→warning — *necessarily passes
 * through a recovery on each cycle*. Every recovery re-armed the component, so the very next warning
 * edge always found an empty map and always delivered. The 30-minute window could never elapse
 * during the one condition it was written for; a steady warning was already silent via the edge
 * rule, so the debounce guarded nothing at all.
 *
 * Observed: one component crossing warning↔green on the 60s poll produced an unbroken alternating
 * stream of alarm and recovery escalations 61 SECONDS apart, every one delivered to both channels,
 * each waking a full agent turn — inside a window advertised as suppressing exactly that.
 *
 * So the warning timestamp is now measured from the last warning actually DELIVERED and nothing
 * clears it early. That alone would leave the flap half-loud: warnings would fall silent while their
 * recoveries kept firing, announcing the all-clear for alarms the reader never heard. Hence the
 * second half — a recovery is delivered only when the alarm it clears WAS announced. Net effect per
 * component per window: at most one warning and one recovery.
 *
 * A recovery with no suppressed warning behind it still always fires. That is the case that matters
 * on startup: the first poll establishes a baseline without alerting, so a component already warning
 * at launch has no delivered alarm — and its recovery is what tells a reader (and the improvement
 * pass) that an open pipeline-health bead can be closed.
 */
function passesGate(ev: EscalationEvent, now: number): boolean {
  if (ev.severity === "recovery") {
    // Consume the flag either way: the outstanding alarm is over, announced or not.
    return !unannouncedAlarm.delete(ev.componentId);
  }
  if (ev.severity === "blocking") {
    // CLEAR THE FLAG — a blocking alarm is an ANNOUNCED one, and returning early without saying so
    // is what let a flap eat its all-clear. The suppression rule is "do not announce the clearing of
    // an alarm nobody was told about"; blocking is never debounced, so the reader was always told.
    // Leaving a debounced WARNING's flag standing meant the next recovery consumed it and fell
    // silent — for the blocking alarm, not the warning that raised it. The component then reads
    // BLOCKED with no all-clear ever issued, and since the recovery is what tells the improvement
    // pass its P1 pipeline-health bead can be closed, a green deployment stays reported as blocked.
    unannouncedAlarm.delete(ev.componentId);
    return true;
  }
  // warning
  const last = lastWarningAt.get(ev.componentId);
  if (last !== undefined && now - last < WARNING_DEBOUNCE_MS) {
    unannouncedAlarm.add(ev.componentId);
    return false;
  }
  lastWarningAt.set(ev.componentId, now);
  unannouncedAlarm.delete(ev.componentId);
  return true;
}

/** The outcome of one escalation sweep, returned for logging/testing. */
export interface EscalationResult {
  /** Events that passed the gate and reached AT LEAST ONE sink (concierge, inbox, or fail-safe bead). */
  delivered: EscalationEvent[];
  /** Warning events suppressed by the debounce this sweep. */
  debounced: EscalationEvent[];
  /**
   * Events that passed the gate and reached NO sink at all — every channel refused or threw.
   *
   * This is NOT a subset of `delivered`; the two partition the gated events. It exists because
   * `passesGate` CONSUMES the alarm (it clears `unannouncedAlarm` for the component), so an event
   * that routed nowhere is not retried on the next sweep — it is simply gone. Counting such an
   * event as `delivered` reported a lost alarm as a handled one, which is the one shape a watchdog
   * must never produce.
   */
  undelivered: EscalationEvent[];
}

/**
 * Detect, gate, and route every escalation between two snapshots. Never throws — a watchdog that
 * takes the poll down with it is worse than useless.
 *
 * For each gated ALARM event: push to the concierge (visibility) AND wake Improve-Sparkle (durable
 * doorbell). If the durable channel FAILED, file the deduped bead now (fail-safe). For a RECOVERY:
 * push to the concierge and wake Improve-Sparkle (so it can close the bead); never file a bead.
 */
export async function escalatePipelineHealth(
  prev: PipelineHealth | null,
  next: PipelineHealth,
  deps: EscalationDeps,
): Promise<EscalationResult> {
  const now = deps.now();
  const candidates = detectEscalations(prev, next);
  const delivered: EscalationEvent[] = [];
  const debounced: EscalationEvent[] = [];
  const undelivered: EscalationEvent[] = [];

  for (const ev of candidates) {
    if (!passesGate(ev, now)) {
      debounced.push(ev);
      log.debug("pipeline-health", "escalation debounced", {
        component: ev.componentId,
        severity: ev.severity,
      });
      continue;
    }
    const text = composeEscalationMessage(ev);

    // Concierge feed — best-effort visibility.
    let conciergeOk = false;
    try {
      conciergeOk = deps.notifyConcierge(text);
    } catch (e) {
      log.warn("pipeline-health", "concierge escalation threw", { error: String(e) });
    }

    // Improve-Sparkle wake — the durable doorbell.
    let improveOk = false;
    try {
      improveOk = await deps.wakeImprove(text);
    } catch (e) {
      log.warn("pipeline-health", "improve wake threw", { error: String(e) });
    }

    // FAIL-SAFE. Only for ALARM events, and only when the DURABLE channel failed: the concierge feed
    // is ephemeral, so an alarm whose inbox doorbell did not land has no durable real-time record.
    // File the same deduped bead now rather than waiting for the hourly scan.
    let beadOk = false;
    if (ev.severity !== "recovery" && !improveOk) {
      try {
        await deps.fileDurableBead(ev, text);
        beadOk = true;
        log.info("pipeline-health", "real-time wake failed; durable bead filed as fail-safe", {
          component: ev.componentId,
          severity: ev.severity,
        });
      } catch (e) {
        // The hourly pipeline-health-scan.sh is the intended floor — but it files through the SAME
        // `bd` this throw usually means is unreachable, so it is not a floor that can be assumed.
        log.warn("pipeline-health", "fail-safe bead filing threw; hourly scan is the floor", {
          component: ev.componentId,
          error: String(e),
        });
      }
    }

    // ZERO-SINK IS NOT DELIVERY. Every channel is independently best-effort and each already logs
    // its own failure, so the three warnings above can all fire and still leave no line saying the
    // alarm itself was lost — a reader has to notice an ABSENCE across three messages to work it
    // out. Measured on a machine where the improve inbox sat at its 50-message cap (so `inbox_send`
    // refused every alarm) and `bd` was not installed (so the fail-safe throw), a blocking alarm
    // reached nothing at all and was still logged as an escalated transition and returned as
    // `delivered`. Decide it here, once, from the sink results rather than from having reached the
    // end of the loop body.
    if (conciergeOk || improveOk || beadOk) {
      log.info("pipeline-health", "escalated pipeline transition", {
        component: ev.componentId,
        severity: ev.severity,
        concierge: conciergeOk,
        improve: improveOk,
        bead: beadOk,
      });
      delivered.push(ev);
    } else {
      log.error("pipeline-health", "escalation reached NO sink; this alarm is LOST", {
        component: ev.componentId,
        severity: ev.severity,
      });
      undelivered.push(ev);
    }
  }

  return { delivered, debounced, undelivered };
}

/**
 * Production delivery seams, bound to the real transports for a given project root.
 *   • concierge  → `notifyConcierge` (the registered proactive sink).
 *   • wakeImprove → `inbox_send` into the `__sparkle_self__` inbox at severity `act` — the doorbell
 *     the hourly improvement pass drains. A throw/reject is a failed (non-durable) delivery.
 *   • fileDurableBead → `create_bead_full` with the SAME `phc-<id>` + `pipeline-health` labels the
 *     hourly scan dedups on, so the fail-safe bead folds into the scan's rather than duplicating it,
 *     and carries `agent-feedback` so retro-inbox-triage ranks it.
 */
export function liveEscalationDeps(projectPath: string): EscalationDeps {
  return {
    now: () => Date.now(),
    notifyConcierge: (text) => notifyConcierge(text),
    wakeImprove: async (text) => {
      try {
        await invoke<string>("inbox_send", {
          agentId: SPARKLE_AGENT_ID,
          text,
          severity: "act",
          from: "pipeline-health",
        });
        return true;
      } catch (e) {
        log.warn("pipeline-health", "improve inbox_send refused", { error: String(e) });
        return false;
      }
    },
    fileDurableBead: async (ev, text) => {
      const priority = ev.severity === "blocking" ? "1" : "3";
      const title = `Pipeline health: ${ev.name} (${ev.to})`;
      const body =
        `${text}\n\n` +
        `Filed in real time when a ${ev.severity} transition's inbox doorbell could not be delivered. ` +
        `Deduped by label phc-${ev.componentId}; the hourly pipeline-health-scan.sh enriches this same bead.`;
      const raw = await invoke<string>("create_bead_full", {
        projectPath,
        title,
        body,
        issueType: "task",
        parent: "",
        deps: "",
        labels: `pipeline-health,phc-${ev.componentId},agent-feedback`,
        // priority is seeded via the body/label; create_bead_full has no priority arg, and the
        // hourly scan owns priority after filing (never re-driven here).
      });
      assertBeadWasCreated(raw);
      void priority;
    },
  };
}

/**
 * A RESOLVED `create_bead_full` IS NOT A FILED BEAD — throw unless the payload names a new id.
 *
 * `notes.rs::select_bd_result` returns bd's caught-error JSON as `Ok("{\"error\":…}")` **on a
 * non-zero exit**, by design and with its own test (`select_bd_result_prefers_json_stdout_even_on_
 * nonzero_exit`), so the frontend can surface the structured message. A caller that awaits the
 * invoke and discards the payload therefore reads EVERY refused write as a success.
 *
 * That mattered here more than anywhere else, because this is the FLOOR. The module header above
 * distrusts `inbox_send` and `notifyConcierge` precisely because they were caught reporting
 * unobserved success — and then the bead, the sink both of them fall back to, trusted a resolved
 * promise. Measured on one machine: the improve inbox sat at its 50-message cap so `wakeImprove`
 * returned false, and the beads store was schema-degraded (reads served, EVERY WRITE REFUSED), so
 * bd exited non-zero with `{"error":…}`. The old code set `beadOk = true`, logged `durable bead
 * filed as fail-safe`, and returned the event as `delivered`. The alarm reached no sink at all and
 * the one line that says so — `escalation reached NO sink; this alarm is LOST` — could not fire.
 *
 * Same contract as `tasks.ts::createBeadFull`; kept local rather than imported so this watchdog
 * does not take on that module's store graph for one parse.
 */
function assertBeadWasCreated(raw: string): void {
  let obj: { id?: string; error?: string };
  try {
    obj = JSON.parse(raw) as { id?: string; error?: string };
  } catch {
    // Non-JSON stdout on a clean exit reaches us verbatim. We cannot confirm an id from it, and an
    // unconfirmed write is not a floor — fail closed.
    throw new Error(`bd returned unparseable output: ${raw.slice(0, 200)}`);
  }
  if (obj.error) throw new Error(obj.error);
  if (!obj.id) throw new Error(`bd returned no id: ${raw.slice(0, 200)}`);
}

// ── The store's entry point + test seams ────────────────────────────────────────────────────────
// The store calls `runPipelineEscalation(prev, next, root)` after each successful poll. It uses the
// live deps by default; tests override them to assert the routing without a live transport.

let depsOverride: EscalationDeps | null = null;

/** TEST SEAM. Swap the delivery deps used by `runPipelineEscalation`. */
export function __setPipelineEscalationDepsForTests(deps: EscalationDeps): void {
  depsOverride = deps;
}

/** TEST SEAM. Forget the override AND the debounce state so one test cannot leak into the next. */
export function __resetPipelineEscalationForTests(): void {
  depsOverride = null;
  lastWarningAt.clear();
  unannouncedAlarm.clear();
}

/**
 * The store's hook: escalate the prev→next transition, fire-and-forget. Never rejects — a rejected
 * promise here must not surface as a poll error. Uses the test override when set, else the live deps
 * bound to the polled root.
 */
export async function runPipelineEscalation(
  prev: PipelineHealth | null,
  next: PipelineHealth,
  projectPath: string,
): Promise<EscalationResult> {
  const deps = depsOverride ?? liveEscalationDeps(projectPath);
  try {
    return await escalatePipelineHealth(prev, next, deps);
  } catch (e) {
    log.warn("pipeline-health", "escalation sweep threw", { error: String(e) });
    // `undelivered: []` here means UNKNOWN, not zero. `escalatePipelineHealth` is documented never
    // to throw, so this is a defensive backstop; if it ever does throw, the throw happened INSIDE
    // the per-event loop and no partition survived it, so there is no event list to attribute. The
    // `log.warn` above is the only record in that case.
    //
    // Worth stating because it is the one gap this partition does not close: `passesGate` CONSUMES
    // the alarm, so events gated before the throw are already gone and are reported here as neither
    // delivered nor undelivered. Narrowing that would mean returning the partial partition from
    // inside the sweep rather than losing it to the catch — a change to the sweep's shape, not to
    // this backstop, and deliberately not folded into a merge fix.
    return { delivered: [], debounced: [], undelivered: [] };
  }
}
