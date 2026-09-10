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
//   • BLOCKING — escalates, but only once CONFIRMED: the component must still read blocking on
//                BLOCKING_CONFIRMATIONS consecutive polls (default 2, the same confirmation the
//                hourly scan's `PH_HYSTERESIS_PASSES` already demanded before writing a bead). A
//                blocking reading that clears before then is a blip and is never announced, nor is
//                its recovery. This costs one poll of latency on a real outage and removes the
//                single-poll false alarm that shipped remediation which would have been wrong to
//                run (bead sparkle-00dmmc). Confirmation is a DEFERRAL, not a debounce — see
//                `pendingAlarm` for why a debounce could not work against an edge detector.
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

/**
 * How many CONSECUTIVE polls must report `blocking` before that alarm is ANNOUNCED (bead
 * sparkle-00dmmc). Mirrors `PH_HYSTERESIS_PASSES` (default 2) in scripts/pipeline-health-scan.sh so
 * the real-time path and the hourly scan demand the same confirmation before either acts.
 *
 * THE MEASURED INCIDENT. On 2026-09-08 the release runner crossed green->blocking on ONE poll and
 * was announced instantly with "Wake the release Mac and re-check". Nothing needed waking: the
 * classifier blocks on a REGISTERED-but-offline runner by design, which is how a Mac idling between
 * jobs presents, and the next poll was green. The scan filed no bead for the same reading because
 * its hysteresis held the write; only this path had no confirmation of any kind. A remedy is an
 * instruction the reader will follow (AGENTS.md, bead sparkle-8bvh), so shipping one for a reading
 * that clears itself a minute later is worse than staying quiet.
 *
 * Setting this to 1 restores the old announce-on-first-reading behaviour.
 */
export const BLOCKING_CONFIRMATIONS = 2;

/**
 * How many CONSECUTIVE polls must report `warning` before that alarm is ANNOUNCED (bead
 * sparkle-00dmmc, second half).
 *
 * THREE, and the number is measured rather than chosen. Across 2026-09-08/09 the roborev component
 * alarmed FIVE times; all five self-recovered unattended within roughly one poll interval and nobody
 * ran the remediation at any point. Five alarms, ZERO true positives. N=3 suppresses all five and
 * misses nothing, and it matches the `ROBOREV_WEDGE_CONFIRMATIONS` prior art already in the tree.
 *
 * WHY A WARNING NEEDS A HIGHER BAR THAN A BLOCKING. Both are deferrals of the same shape, but the
 * costs are asymmetric: holding a real outage one extra poll delays a page by a minute, while
 * announcing a transient degradation trains the reader to ignore the line. A warning is also the
 * severity that recurs — the measured roborev shape is hourly — so it has more chances to confirm.
 *
 * THIS IS NOT THE DEBOUNCE, and the two are not redundant. Confirmation asks "is this reading REAL?"
 * and runs first; `WARNING_DEBOUNCE_MS` asks "how often may a real one repeat?" and runs after. The
 * debounce could never have caught these five: it is measured from the last warning DELIVERED, and
 * hourly recurrence falls outside a 30-minute window, so every one was delivered exactly as designed.
 */
export const WARNING_CONFIRMATIONS = 3;

/** How many consecutive readings this severity costs before it may be announced. */
function confirmationsFor(severity: EscalationSeverity): number {
  return severity === "blocking" ? BLOCKING_CONFIRMATIONS : WARNING_CONFIRMATIONS;
}

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
 * The PR-reviewer remedy, DERIVED FROM THE READING rather than hard-coded (bead `sparkle-0wb6zp`).
 *
 * TWO THINGS WERE WRONG WITH THE PREVIOUS STRING, and both are the kind AGENTS.md warns about
 * (a remedy is an instruction someone will follow).
 *
 *   1. IT NAMED A RETIRED REVIEWER. It said "The PR reviewer (sparkle-reviewer) … review one
 *      manually with `scripts/pr-review.sh <PR#> --post`". `[review].pr_reviewer` flipped to
 *      `knightwatch` on 2026-09-03, and knightwatch runs on another machine — the babysit sweep
 *      does not dispatch it and `scripts/pr-review.sh` reviews nothing it is waiting on. The
 *      Rust side was keyed to the configured reviewer on 2026-09-08 (`restart_remedy` in
 *      `pipeline_health.rs`, bead `sparkle-9hs48d`) and so was `scripts/lib/pipeline-health.sh`;
 *      this string was left behind, so the alert CONTRADICTED ITS OWN EVIDENCE — the detail said
 *      knightwatch and `/srosro-update-review`, and the `Remediation:` line under it said
 *      sparkle-reviewer and the sweep.
 *   2. IT COULD NOT FOLLOW THE CONFIG. Swapping one hard-coded name for the other reintroduces the
 *      identical defect the next time `pr_reviewer` moves, which is exactly how this arrived.
 *
 * So it keys on the RESTART SENTENCE the classifier already put in the detail — the same
 * derive-from-detail shape `roborevRemediation` uses, and the only reviewer signal that reaches
 * this module (the component carries no reviewer field). Both phrases are owned by
 * `restart_remedy` in `pipeline_health.rs` and `restart` in `scripts/lib/pipeline-health.sh`, and
 * `pipelineHealthRemedyDrift.test.ts` pins them so a reword cannot silently fall through.
 *
 * THE DEFAULT IS THE SAFETY PROPERTY, exactly as in `roborevRemediation`: an unrecognised reading
 * names NEITHER reviewer and prescribes neither trigger. Naming the wrong one is worse than naming
 * none, because the reader acts on it and concludes the reviewer is fine.
 *
 * AND NO ARM DIAGNOSES A CAUSE THE READING CANNOT SUPPORT (bead `sparkle-gazo4a`). "its access is
 * gone" after a 15-minute non-observation is an ABSENCE CLAIM, and this component cannot make one:
 * a QUOTA-BLOCKED knightwatch is perfectly healthy and posts `\u23f8 knightwatch paused` every ~2
 * minutes, and those lifecycle posts are deliberately excluded from `last_review_age_secs` (see
 * the marker note in `pipeline_health.rs`) — so a paused reviewer is exactly what drives
 * `classify_knightwatch` into the Warning arm this remedy is appended to. An operator following an
 * unqualified "access is gone" repoints the repo's reviewer away from one that is fine, which is
 * the destructive direction. So the arm keeps the OBSERVATION and the TOOL and drops the verdict:
 * it says what would settle the question and conditions the config change on that read.
 */
export function knightwatchRemediation(detail?: string): string {
  const d = detail ?? "";

  // knightwatch — someone else's machine, reachable only over GitHub. NOTHING HERE TO RESTART, and
  // saying otherwise is what sent the reader to the babysit sweep for a reviewer it never drives.
  if (/srosro-update-review/i.test(d)) {
    return (
      "The PR reviewer (knightwatch) has not posted a review recently while PRs are waiting. It runs " +
      "on another machine and is reachable only through GitHub, so there is nothing on this side to " +
      "restart: comment `/srosro-update-review` on a waiting PR and watch for ~15 minutes. If no " +
      "review lands, this reading still cannot say whether it is paused, quota-blocked or has lost " +
      "access — `scripts/reviewer-liveness-check.sh` reports whether it has produced any review at " +
      "all, and knightwatch's own `\u23f8 knightwatch paused` posts on a waiting PR tell a pause " +
      "apart from silence. Repoint `[review].pr_reviewer` in `.sparkle/config.toml` only once that " +
      "read shows it is genuinely no longer posting."
    );
  }

  // The local reviewer, dispatched by the app's own sweep — here the sweep IS the thing to check.
  if (/pr-review\.sh/i.test(d)) {
    return (
      "The PR reviewer (sparkle-reviewer) has not posted a review recently while PRs are waiting — it " +
      "is dispatched by the app's babysit sweep, so review one manually with `scripts/pr-review.sh " +
      "<PR#> --post` and check why the sweep is not dispatching."
    );
  }

  // DEFAULT — see the block comment: name no reviewer, prescribe no trigger, point at the one tool
  // that resolves the reviewer from config itself.
  return (
    "The PR reviewer has not posted a review recently while PRs are waiting. The reading above names " +
    "the configured reviewer and how to trigger it — follow that, and confirm with " +
    "`scripts/reviewer-liveness-check.sh`, which resolves the reviewer from `[review].pr_reviewer` " +
    "and reports whether it has produced any review at all."
  );
}

/**
 * The codified remediation per component id (mirrors the ids in `pipeline_health.rs`). Returns the
 * concrete next action so the alert is actionable, not just a notification. `null` for an unknown id
 * — the message still names the component and severity, it simply has no canned fix to append.
 */
/**
 * The release runner's remedy, derived from the DETAIL rather than fixed per component — the same
 * shape as `roborevRemediation`, and for the same reason (bead sparkle-00dmmc).
 *
 * The single old string said "wake the founder's Mac, and repair the runner with `sudo
 * scripts/runner/setup-self-hosted-runner.sh` if it does not re-register", which conflates two
 * faults whose repairs run in OPPOSITE directions. A Mac that is merely asleep has an intact
 * registration, and re-running the setup script at it is a destructive answer to a non-problem; a
 * runner absent from the fleet cannot be woken at all. A remedy is an instruction the reader will
 * follow (AGENTS.md, bead sparkle-8bvh), so it has to name the one that applies.
 *
 * THE FALLBACK KEEPS THE OLD CONFLATED WORDING ON PURPOSE. It is reached only by a detail this
 * function does not recognise — an older build's string, or a shape added later — and there naming
 * BOTH actions is the conservative answer. Confidently naming the wrong one is the failure mode.
 */
export function releaseRunnerRemediation(detail?: string): string {
  const d = detail ?? "";
  if (d.includes("is REGISTERED but not online")) {
    return (
      "The release runner is REGISTERED but not online — its registration is intact, so this is the " +
      "asleep or stopped-service shape. Wake the founder's Mac (or start its runner service) and " +
      "re-check. Do NOT run `sudo scripts/runner/setup-self-hosted-runner.sh`: nothing needs " +
      "re-registering, and running it against a healthy registration is a destructive answer to a " +
      "machine that is merely asleep."
    );
  }
  if (d.includes("is registered at all")) {
    return (
      "NO runner carrying the release label is registered at all — it is ABSENT from the fleet, not " +
      "merely offline, so waking the Mac accomplishes nothing on its own. Re-register it with `sudo " +
      "scripts/runner/setup-self-hosted-runner.sh`."
    );
  }
  return "The release runner (DMG build) is offline — wake the founder's Mac, and repair the runner with `sudo scripts/runner/setup-self-hosted-runner.sh` if it does not re-register.";
}

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
      return releaseRunnerRemediation(detail);
    case "knightwatch":
      return knightwatchRemediation(detail);
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
 * Components carrying an alarm that is outstanding and that NOBODY WAS EVER TOLD ABOUT. The recovery
 * that clears such an alarm is suppressed too, and consumes the flag. See `passesGate` for why both
 * halves are needed.
 *
 * TWO WAYS IN, not one. It began as "suppressed by the debounce" and that is no longer the whole
 * meaning: an alarm that passed the gate and then reached NO SINK AT ALL is equally un-heard, and is
 * recorded here beside `undelivered` (roborev jobs 82210, 82211). Both entries mean the same thing to
 * the recovery gate, which is the point — it asks "was the reader told?", not "why not?".
 *
 * Entries are retired against the SNAPSHOT at the end of each sweep, not by a recovery event, because
 * an alarm can end without emitting one.
 */
const unannouncedAlarm = new Set<string>();

/**
 * Components whose alarm the reader HAS been told about — written by `passesGate` on every DELIVERED
 * warning or blocking, cleared on every recovery.
 *
 * WHY THIS IS RECORDED RATHER THAN INFERRED (roborev job 82208). The first version of the drop guard
 * asked `!isAlarmState(pending.ev.from)`, using the edge's origin as a proxy for "was anything
 * already announced underneath this streak". The proxy is wrong for `unknown`, which is neither a
 * good state nor an alarm state — and `unknown` is exactly where a component lands when its probe
 * times out. So `healthy→warning` (delivered) → `warning→unknown` (no event) → `unknown→blocking`
 * (held) → `blocking→healthy` still flagged the drop and still ate the announced warning's all-clear:
 * the same bug the guard was written to fix, surviving one hop through `unknown`.
 *
 * A proxy for a fact is only ever as good as the enumeration behind it. This set IS the fact.
 */
const announcedAlarm = new Set<string>();

/**
 * THE ONLY WRITER of `unannouncedAlarm` — record that an alarm on this component is outstanding and
 * UNHEARD, if and only if nothing was already announced underneath it.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE CALL SITES (roborev jobs 82211, 82212). The flag SUPPRESSES —
 * the recovery gate consumes it — so setting it when the reader HAS already been told eats that
 * alarm's all-clear, leaving a component reported degraded with no notice that it recovered and the
 * improvement pass never authorised to close its bead. There were three writers reaching this flag by
 * three different routes (the deferred-streak drop, the sink-result restore, and the warning
 * debounce), the conjunct was added to them ONE AT A TIME across three review rounds, and each round
 * missed that another site needed it. The predicate belongs in one place because forgetting it is the
 * failure mode, not writing it.
 *
 * Callers still decide WHETHER an alarm went unheard; this decides only whether recording that fact
 * would trample one that was heard.
 */
function markUnannounced(componentId: string): void {
  if (announcedAlarm.has(componentId)) return;
  unannouncedAlarm.add(componentId);
}

/**
 * Blocking alarms DETECTED but not yet CONFIRMED, keyed by component: the edge that opened the
 * streak, and how many consecutive polls have reported `blocking` since.
 *
 * WHY A DEFERRAL AND NOT A DEBOUNCE — the shape that makes this different from the warning gate.
 * Detection is EDGE-triggered, so a component that is blocking and STAYS blocking emits exactly ONE
 * event; there is no second event for a time window to suppress, and a count of EVENTS could never
 * reach two. Confirmation therefore has to be re-evaluated against each later SNAPSHOT, which is
 * what `advancePendingAlarm` does. A gate written as a debounce here would be silently inert.
 */
const pendingAlarm = new Map<string, { ev: EscalationEvent; streak: number }>();

/**
 * CONSECUTIVE POLLS THIS COMPONENT HAS BEEN IN *ANY* ALARM STATE — the evidence a thaw carries
 * forward, kept separately from `pendingAlarm` because it has to survive the streak (roborev job
 * 82758).
 *
 * `pendingAlarm`'s streak counts readings of ONE state, which is the right question for confirming
 * that state and the wrong one for confirming that the component is degraded at all. A component
 * that is in alarm on every single poll but alternates `warning`/`blocking` never accumulates three
 * consecutive warnings NOR two consecutive blockings, so with the streak as the only ledger it is
 * never announced — and the eventual recovery is suppressed on top, because each drop records it
 * unheard. That is the same permanent silence roborev job 82754 was about, reached by flickering
 * more than once: `W(s1) → B(s1) → W(s1) → W(s2) → B(s1) → W(s1) → …` forever.
 *
 * A BLOCKING READING IS ALSO EVIDENCE THAT A WARNING-LEVEL ALARM IS REAL, so on a thaw the milder
 * alarm inherits this count. The reverse does not hold — warning readings say nothing about whether
 * a blocking is real — so worsening still restarts at the stricter threshold, which is why only the
 * thaw arm reads this.
 *
 * `unknown` and both good states RESET it, keeping this module's standing rule that an unreadable
 * meter never alarms: a run broken by a timed-out probe starts over, which is the fail-safe
 * direction.
 */
const alarmRun = new Map<string, number>();

/**
 * Advance `alarmRun` against THIS snapshot. Runs once per sweep, unconditionally — including when
 * `pendingAlarm` is empty, because the run has to already be counting by the time a later thaw asks
 * for it, and a ledger maintained only while some streak happens to exist would read zero exactly
 * when it is needed.
 */
function advanceAlarmRun(next: PipelineHealth): void {
  const seen = new Set<string>();
  for (const c of next.components) {
    seen.add(c.id);
    if (isAlarmState(c.state)) alarmRun.set(c.id, (alarmRun.get(c.id) ?? 0) + 1);
    else alarmRun.delete(c.id);
  }
  // A component that has left the snapshot has no run: it is not reporting an alarm.
  for (const id of [...alarmRun.keys()]) if (!seen.has(id)) alarmRun.delete(id);
}

/**
 * Re-evaluate every deferred blocking alarm against THIS snapshot and return the ones now confirmed.
 *
 * MUST RUN BEFORE this sweep's edges are gated: an alarm dropped here records itself in
 * `unannouncedAlarm`, and that has to be in place before the matching recovery edge reaches
 * `passesGate`, or the all-clear for an alarm nobody heard is announced.
 *
 * A component that is no longer `blocking` — recovered, thawed to `warning`, gone `unknown`, or
 * absent from the snapshot altogether — drops its streak. `unknown` drops it rather than extending
 * it, which keeps this module's standing rule that an unreadable meter never alarms: a real outage
 * that flickers through `unknown` simply re-confirms, and that is the fail-safe direction.
 */
function advancePendingAlarm(next: PipelineHealth): EscalationEvent[] {
  if (pendingAlarm.size === 0) return [];
  const byId = new Map(next.components.map((c) => [c.id, c]));
  const confirmed: EscalationEvent[] = [];
  for (const [id, pending] of [...pendingAlarm]) {
    const cur = byId.get(id);
    // THE STREAK CONFIRMS ONLY WHILE THE COMPONENT HOLDS THE STATE IT WAS DEFERRED FOR. Anything
    // else ends THIS streak: recovered, gone `unknown`, absent from the snapshot, WORSENED, or
    // THAWED to a milder alarm. Ending the streak is not the same as ending the alarm, and the two
    // arms below say which happened — a component still in an alarm state re-opens on the state it
    // now holds, everything else drops and is recorded unheard. A warning on its way to blocking is
    // still never announced as a warning on the strength of readings that were about the blocking:
    // the worse edge is emitted by `detectEscalations` and opens its own streak at its own
    // threshold, overwriting the re-open below on that side.
    if (cur === undefined || cur.state !== pending.ev.to) {
      pendingAlarm.delete(id);
      // A THAW IS NOT AN END — RE-OPEN THE STREAK ON WHATEVER ALARM THE COMPONENT NOW HOLDS
      // (roborev job 82754). The "worsened is not a loss" claim above holds in exactly ONE
      // direction. Going UP the worse edge really is emitted, and the candidate loop below really
      // does open its own streak at its own threshold — which is why re-opening here is a no-op on
      // that side, immediately overwritten by the real edge. Coming back DOWN there is no edge at
      // all: `detectEscalations` documents `blocking→warning` as a partial thaw that emits NOTHING.
      // So deleting the streak left a component sitting in `warning` with nothing tracking it, never
      // announced — and the eventual recovery suppressed on top of that, because the drop had
      // flagged it unheard. One transient blocking reading inside a warning's confirmation window
      // was enough to silence a real, lasting warning permanently. Measured shape:
      // healthy→warning (streak 1) → warning→blocking (dropped, blocking held) →
      // blocking→warning (dropped, NO edge emitted) → warning forever, in silence.
      //
      // THE FLAG BELONGS TO THE END OF THE ALARM, NOT TO THE END OF THIS STREAK. A component still
      // in an alarm state has an alarm outstanding that the re-opened streak is still tracking, so
      // recording it as unheard here would consume the all-clear for an alarm that may yet be
      // announced. It is flagged on the sweep the component actually leaves the alarm states —
      // which is the drop below, reached with `cur` absent, good, or `unknown`.
      //
      // ONLY THE THAW RE-OPENS. Worsening needs nothing from here — `detectEscalations` emits that
      // edge and the candidate loop opens its own streak at the stricter threshold on the same
      // sweep, so re-opening it here would be written and immediately overwritten. The thaw is the
      // direction with no edge at all, and so the only one that can lose an alarm.
      if (cur !== undefined && severityRank(cur.state) < severityRank(pending.ev.to) && isAlarmState(cur.state)) {
        // DETAIL and remedy come from THIS snapshot for the same reason the confirming push does:
        // the reader is told about the reading that is true now, and a remedy must be safe under
        // the conditions that produced it (AGENTS.md, bead sparkle-8bvh).
        const thawed: EscalationEvent = {
          ...pending.ev,
          from: pending.ev.to,
          to: cur.state,
          severity: cur.state === "blocking" ? "blocking" : "warning",
          detail: cur.detail,
          remediation: remediationFor(id, cur.detail),
        };
        // EVERY READING OF THE RUN WAS AT LEAST THIS SEVERE, so all of them are evidence for the
        // milder alarm — the floor of 1 is this reading itself, for the case where nothing has been
        // counted yet. Resetting to 1 here instead is what let a REPEATING flicker silence a
        // component that was in alarm on every poll (roborev job 82758).
        const carried = Math.max(alarmRun.get(id) ?? 0, 1);
        if (carried < confirmationsFor(thawed.severity)) {
          pendingAlarm.set(id, { ev: thawed, streak: carried });
          continue;
        }
        // The run already satisfies the milder threshold, so the thaw itself is the confirming
        // reading. Waiting another poll would be asking for evidence we are already holding.
        confirmed.push(thawed);
        continue;
      }
      // FLAG THE DROP ONLY WHEN THIS STREAK WAS THE READER'S ONLY ALARM (roborev job 82171).
      // `unannouncedAlarm` means "an alarm is outstanding that nobody was told about", and the
      // recovery gate CONSUMES it — so setting it unconditionally eats the all-clear for a WARNING
      // that was already announced underneath this blocking. Measured sequence, all on the 60s poll:
      // healthy→warning (delivered, the reader HAS heard it) → warning→blocking (held) →
      // blocking→healthy (dropped here). Flagging that drop leaves the component reported degraded
      // with no all-clear ever issued — the identical harm the blocking branch of `passesGate`
      // documents, and the notice the improvement pass reads as permission to close its P1 bead.
      //
      // ASK WHAT WAS ACTUALLY ANNOUNCED, never what the edge rose FROM (roborev job 82208). `from`
      // has three shapes, not two — good, alarm, and `unknown` — and `unknown` is neither, so a proxy
      // built on `isAlarmState(from)` mis-flags a streak that reached blocking via a timed-out probe
      // and reproduces this very bug one hop away. A streak with nothing announced underneath it IS
      // the reader's only alarm and still flags; one sitting on a delivered warning must not, and one
      // sitting on a warning the debounce swallowed needs nothing from us — `passesGate` set the flag
      // itself when it suppressed that warning.
      markUnannounced(id);
      continue;
    }
    const streak = pending.streak + 1;
    if (streak < confirmationsFor(pending.ev.severity)) {
      pendingAlarm.set(id, { ev: pending.ev, streak });
      continue;
    }
    pendingAlarm.delete(id);
    // DETAIL and remedy are re-read from the CONFIRMING snapshot rather than kept from the opening
    // edge: the reader is told about the reading that is true NOW, and a remedy must be safe under
    // the conditions that actually produced it (AGENTS.md, bead sparkle-8bvh).
    confirmed.push({
      ...pending.ev,
      detail: cur.detail,
      remediation: remediationFor(cur.id, cur.detail),
    });
  }
  return confirmed;
}

/**
 * Should this event be delivered right now? Applies the severity gate:
 *   • blocking → only once CONFIRMED. A blocking edge does not reach this gate on its own reading;
 *                it is deferred by `advancePendingAlarm` and arrives here on the poll that
 *                confirms it, at which point it is always delivered.
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
    // The outstanding alarm is over either way, announced or not — so both records are cleared and
    // the flag is CONSUMED, which is what decides whether this all-clear is worth delivering.
    announcedAlarm.delete(ev.componentId);
    return !unannouncedAlarm.delete(ev.componentId);
  }
  if (ev.severity === "blocking") {
    // CLEAR THE FLAG — a blocking alarm that reaches this gate is an ANNOUNCED one, and returning
    // early without saying so is what let a flap eat its all-clear. The suppression rule is "do not
    // announce the clearing of an alarm nobody was told about"; an UNCONFIRMED blocking never gets
    // here (`advancePendingAlarm` sets the flag itself when it drops one), so everything that
    // does arrive here is about to be told to the reader.
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
    markUnannounced(ev.componentId);
    return false;
  }
  // NOTE WHAT IS *NOT* DONE HERE: the clock is NOT stamped (bead sparkle-l4bxty). See the
  // `lastWarningAt.set` beside `delivered.push` — a warning that passes this gate and then reaches
  // NO sink must not start the window, or it silences its component for half an hour having told
  // nobody anything.
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
   * Blocking edges DEFERRED this sweep pending confirmation — detected, not yet announced. Unlike
   * `debounced` these are not discarded: each is re-evaluated on the next poll and will either be
   * announced (still blocking) or dropped as a blip (anything else). A non-empty `held` means "an
   * alarm is being confirmed", never "an alarm was suppressed".
   */
  held: EscalationEvent[];
  /**
   * Events that passed the gate and reached NO sink at all — every channel refused or threw.
   *
   * This is NOT a subset of `delivered`; the two partition the gated events. It exists because the
   * event is not retried on the next sweep — it is simply gone. Counting such an event as
   * `delivered` reported a lost alarm as a handled one, which is the one shape a watchdog must
   * never produce.
   *
   * WHAT IT NO LONGER MEANS (roborev jobs 82209, 82210). This used to say `passesGate` CONSUMES the
   * alarm by clearing `unannouncedAlarm`, and that consumption was itself the bug: a lost alarm
   * cleared its own suppression flag and its later all-clear was announced to a reader who had never
   * heard the alarm. Both records are now decided by the SINK RESULT — `announcedAlarm` is set beside
   * `delivered`, `unannouncedAlarm` is restored beside `undelivered` — so a routed-nowhere event
   * leaves the same state as one that was never gated at all.
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
  // Deferred blocking alarms are re-evaluated FIRST, so one dropped for want of confirmation has
  // already marked itself unannounced by the time this sweep's recovery edge is gated below.
  // The alarm-run ledger is advanced BEFORE the streaks that read it, and unconditionally.
  advanceAlarmRun(next);
  const confirmedAlarms = advancePendingAlarm(next);
  const candidates = detectEscalations(prev, next);
  const delivered: EscalationEvent[] = [];
  const debounced: EscalationEvent[] = [];
  const held: EscalationEvent[] = [];
  const undelivered: EscalationEvent[] = [];

  // Gating is done for the whole sweep BEFORE any routing, so `passesGate` — which has side effects
  // (it stamps the warning clock and consumes the unannounced flag) — is called exactly once per
  // event.
  const gated: EscalationEvent[] = [];
  for (const ev of confirmedAlarms) {
    // A CONFIRMED ALARM CAN STILL BE REFUSED HERE, and it must be RECORDED when it is. For
    // `blocking` this gate is always true, so while blocking was the only severity that deferred,
    // dropping the false branch cost nothing. A confirmed WARNING can be debounced — confirmation
    // asks whether the reading is real, the debounce asks how often a real one may repeat — and
    // letting it fall out of the loop silently would lose it from BOTH partitions, reporting a
    // sweep that suppressed an alarm as one that saw none.
    if (passesGate(ev, now)) {
      gated.push(ev);
      continue;
    }
    debounced.push(ev);
    log.debug("pipeline-health", "confirmed alarm debounced", {
      component: ev.componentId,
      severity: ev.severity,
    });
  }
  for (const ev of candidates) {
    // A NEW blocking edge is never announced on its own reading — it opens a streak that a later
    // poll has to confirm. This is the half that stops a self-healing blip from paging with
    // remediation that would have been wrong to run (bead sparkle-00dmmc).
    if (ev.severity !== "recovery" && confirmationsFor(ev.severity) > 1) {
      pendingAlarm.set(ev.componentId, { ev, streak: 1 });
      held.push(ev);
      log.debug("pipeline-health", "alarm held pending confirmation", {
        component: ev.componentId,
        severity: ev.severity,
        needed: confirmationsFor(ev.severity),
      });
      continue;
    }
    if (!passesGate(ev, now)) {
      debounced.push(ev);
      log.debug("pipeline-health", "escalation debounced", {
        component: ev.componentId,
        severity: ev.severity,
      });
      continue;
    }
    gated.push(ev);
  }

  for (const ev of gated) {
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
      // "ANNOUNCED" IS RECORDED HERE, AT THE SINK RESULT — not in `passesGate` (roborev job 82209).
      // The gate runs BEFORE routing, so recording there counted an event that reached NO sink at
      // all as one the reader had been told about, which is the exact opposite of what `undelivered`
      // means. A recovery is not an alarm and records nothing.
      if (ev.severity !== "recovery") announcedAlarm.add(ev.componentId);
      // THE DEBOUNCE CLOCK STARTS HERE, not at the gate (bead sparkle-l4bxty). The module has always
      // said the window is "measured from the last warning actually DELIVERED"; stamping it in
      // `passesGate` — which runs BEFORE routing — made that false, so a warning that reached no sink
      // at all still silenced its component for the next 30 minutes. Same lesson as the two
      // announcement records beside it: bookkeeping that describes an OUTCOME must be written where
      // the outcome is known.
      if (ev.severity === "warning") lastWarningAt.set(ev.componentId, now);
      delivered.push(ev);
    } else {
      log.error("pipeline-health", "escalation reached NO sink; this alarm is LOST", {
        component: ev.componentId,
        severity: ev.severity,
      });
      // …AND THE SUPPRESSION FLAG IS RESTORED HERE, symmetrically (roborev job 82210). `passesGate`
      // clears `unannouncedAlarm` at GATE time, before routing — but that flag is the one that
      // decides whether a later all-clear is delivered, so an alarm that reached nobody would
      // otherwise buy itself a recovery notice for an alarm nobody heard, waking a full improvement
      // turn to close a bead that was never opened. Moving `announcedAlarm` to the sink result and
      // leaving this one at the gate fixed the record that is READ by the drop guard and left the
      // record that is read by the RECOVERY GATE untouched — half a fix. A recovery is not an alarm
      // and records nothing.
      // THE CONJUNCT IS NOT OPTIONAL, and the two sink-result writes are NOT symmetric (roborev job
      // 82211). `announcedAlarm.add` beside `delivered` is safe unconditionally because a SET record
      // can only broaden later delivery. This one SUPPRESSES, so it needs the same "was anything
      // announced underneath" test `advancePendingAlarm`'s drop branch carries — without it a LOST
      // alarm stacked on an ALREADY-DELIVERED one swallows that one's all-clear, which is bug 82171
      // arriving by a different route: the reader is told the component is degraded and never told it
      // recovered, and the improvement pass never sees the notice that authorises closing its bead.
      if (ev.severity !== "recovery") markUnannounced(ev.componentId);
      undelivered.push(ev);
    }
  }

  // RETIRE BOTH RECORDS AGAINST THE SNAPSHOT (roborev job 82209). Clearing them only on a recovery
  // EVENT leaves a permanently stale entry whenever an alarm ends without emitting one — and it can:
  // `detectEscalations` requires `isAlarmState(from) && isGoodState(to)`, so `alarm → unknown → good`
  // (a probe that times out and then comes back green, the shape this module's own header names)
  // emits nothing at either crossing. A component that vanishes from the snapshot and returns leaves
  // one the same way, since an absent baseline is skipped.
  //
  // A stale `announcedAlarm` entry then defeats the drop guard for a LATER, unrelated blip and
  // delivers an all-clear for an alarm nobody heard; a stale `unannouncedAlarm` entry is the
  // symmetric pre-existing bug in the suppression direction, and this cures it too.
  //
  // ORDER IS LOAD-BEARING, and it is safe: `advancePendingAlarm` and `passesGate` both READ these
  // sets earlier in this same sweep, so retiring here cannot affect a decision already taken — it
  // only stops the NEXT sweep deciding on stale evidence. A component that is good now has nothing
  // outstanding, whatever route it took to get there.
  for (const c of next.components) {
    if (isGoodState(c.state)) {
      announcedAlarm.delete(c.id);
      unannouncedAlarm.delete(c.id);
    }
  }

  return { delivered, debounced, held, undelivered };
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
  announcedAlarm.clear();
  pendingAlarm.clear();
  alarmRun.clear();
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
    return { delivered: [], debounced: [], held: [], undelivered: [] };
  }
}
