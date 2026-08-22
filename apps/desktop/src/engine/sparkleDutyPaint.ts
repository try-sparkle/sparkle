// THE PINNED "IMPROVE SPARKLE" DOT, MADE HONEST WHEN THE PANE IS CLOSED.
//
// ── THE MEASURED PROBLEM ───────────────────────────────────────────────────────────────────────
// With the pane CLOSED, `runtimeStore.status["__sparkle_self__"]` has only three producers
// (`services/improvePassLiveness`'s header names all three), and the whole reachable vocabulary is
// SIX states: `working`, `idle`, `stopped`, `approval`, `blocked`, `errored`. Three of those are
// gray and three are the same red. `questions` / `unmerged` / `new` are UNREACHABLE for this id,
// because the overlays that produce them iterate `project.agents` and this id is deliberately never
// in that array.
//
// ⚠️ `lapsed` WAS in that unreachable list and IS NOT ANY MORE (roborev 67802 flagged the stale
// claim). `services/improvementPass` now parks a failed hourly pass on whatever
// `engine/passFailureStatus` classifies it as, and every arm but the quota/auth ones is `lapsed` —
// so amber reaches this key through a producer, not through an overlay.
//
// ⚠️ THIS FILE'S `RESTING` AND `improvePassLiveness`'s DIFFER BY `lapsed`, DELIBERATELY. The
// liveness set is what a live child may be raised FROM, and amber belongs there: a row wearing
// "unfinished, not yours" while a pass child is demonstrably alive is describing the PREVIOUS pass.
// This set is what may be RE-LABELLED, and amber does not belong here — "Resting — next pass in
// ~48m" over a row that is unfinished would be the dishonest half of the same coin. The safe
// direction of divergence is paint ⊆ liveness, which is what holds; re-syncing them in either
// direction is the edit to refuse.
//
// So the founder, looking at the dot with no terminal open, sees GRAY for four genuinely different
// situations — "the pass is between slots and everything is fine", "the hourly duty has been off for
// three hours and only you can clear it", "consent is off", "this machine is offline" — and the
// hover text actively lies about two of them: `stopped` reads "Stopped" (factually false on EVERY
// app launch, because `runtimeStore.status` is live-only and never persisted) and `idle` reads
// "Done — your turn" (claims something is owed when nothing is and the next pass is up to an hour
// away).
//
// ── WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT ──────────────────────────────────────────────
// ⚠️ IT IS NOT A SECOND STATUS DERIVATION. `AgentSidebar`'s "ONE PIPELINE, NOT TWO" header explains
// at length what a private derivation cost the last time: this row rendered GREEN while sitting on
// an unanswered four-option picker. This is a pure OVERLAY composed ON TOP of that one pipeline —
// the same shape `withStallAttention` / `withUnmergedWork` already use for build rows — plus
// `StatusDot`'s EXISTING `label` prop.
//
// ⚠️ IT ADDS NO STATUS TIER AND NO COLOUR. The founder, on this, marked non-overridable: *"I do want
// it to work exactly like the build agents, so that's the hard rule. The colours work the same
// between the two, and don't let any instruction ever override that."* Rule 1 below reuses the
// EXISTING red `blocked`; rules 2-4 change only hover text. Every value this returns is a key of
// `AGENT_STATUS`, read from the one shared table like every build row, and nothing here supplies a
// colour override. `sparkleDutyPaint.test.ts` pins both halves.
//
// ⚠️ IT MAY ONLY EVER RAISE. A status this receives was STAMPED by a producer that knows something
// this overlay does not, and the recurring bug on this row — reported now across several different
// states — is a status stamped once and quietly re-derived into something calmer. So a red the row
// already carries is never painted over: see `ADDRESSED_TO_HUMAN` below.
//
// ── THE COPY RULES, BOTH FROM THE FOUNDER, BOTH NON-NEGOTIABLE ─────────────────────────────────
//   • RELATIVE time, never an absolute clock. An app-wide timezone setting is filed as an epic but
//     is NOT built, so "4:15 PM" has no configured timezone behind it and would be a guess
//     presented as a fact.
//   • The word "Resting", NEVER "Idle". He has complained repeatedly about rows that read as
//     nothing-happening when the work is fine.
import type { AgentTabStatus } from "../types";
import type { ImproveDutySnapshot } from "../services/improveDutySnapshot";

/** The statuses that mean "no turn is running", for this row. The same four
 *  `services/improvePassLiveness` raises FROM — kept in step deliberately: a row this overlay would
 *  call "Resting" is exactly a row the liveness writer is allowed to raise to `working`, so the two
 *  sets disagreeing would produce a dot labelled "Resting" while a child was live under it.
 *
 *  `lapsed` is NOT here. It is amber and it means "unfinished, not yours" — a real, if calm, piece
 *  of news that "Resting — next pass in ~48m" would paper over. */
const RESTING: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "stopped",
  "idle",
  "done",
  "new",
]);

/** The tiers whose meaning is ADDRESSED TO THE HUMAN, and which rule 1 therefore may not restate.
 *
 *  `blocked` is deliberately absent, and that asymmetry is the point of the set. Rule 1's whole job
 *  is to RAISE the row to `blocked`, so `blocked` arriving here is a no-op on colour and the label
 *  it gains ("Hourly pass held — …") is strictly more informative than the taxonomy's "Blocked".
 *  The four below are different: `errored` is in the notify set (`settingsStore`'s
 *  DEFAULT_NOTIFY_STATUSES) where `blocked` deliberately is not, and `waiting`/`approval`/
 *  `questions` are counted by `engine/attention.needsAttention`. Writing `blocked` over any of them
 *  would LOWER the row out of the attention set and silence a notification the human is owed —
 *  which is the opposite of what a fidelity change may do. */
const ADDRESSED_TO_HUMAN: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "questions",
  "waiting",
  "approval",
  "errored",
]);

/** A duration as a RELATIVE, human phrase — "~48m", "~1h 5m". Never an absolute clock time; see the
 *  copy rules in the header. Floored at one minute so a slot thirty seconds out reads "~1m" rather
 *  than "~0m" (the at-or-past case has its own sentence, "due now"). */
function inAbout(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `~${hours}h` : `~${hours}h ${rest}m`;
}

/** How far into the current pass we are, as hover copy. Whole minutes: the pass budget is 30
 *  minutes and the staleness ceiling 35, so a seconds counter would be noise on a dot nobody is
 *  stopwatching. Under a minute has no useful number to show and says so. */
function intoPass(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? "Working — just started" : `Working — ${minutes}m into this pass`;
}

const HELD = "Hourly pass held — ";

/** Compose the duty overlay onto the row's already-derived status.
 *
 *  Pure, and with no runtime imports at all beyond its own two type-only ones — so it can be
 *  exhaustively tested against a hand-built snapshot without a store, a clock or a Tauri stub.
 *
 *  The rules are ORDERED and the order is load-bearing: a wedge outranks a live pass (the pane can
 *  read `working` for three hours precisely because something is stuck in it), a live pass outranks
 *  a hold sentence, and a hold sentence outranks the countdown (naming WHY nothing is scheduled
 *  beats saying when the next one would have been). */
export function sparkleDutyPaint(
  status: AgentTabStatus,
  s: ImproveDutySnapshot,
): { status: AgentTabStatus; label: string | undefined } {
  // ── 1. THE WEDGE — RED, and the founder chose red explicitly when offered gray/amber/red ──────
  // `pane-wedged` means the hourly duty has been OFF for three hours or more AND WILL NOT CLEAR
  // ITSELF: `PASS_HOLD_TEXT` ends "interrupt or restart that pane", and the human is the only actor
  // who can do that. Red's own definition in `tokens.ts` is "you are the only one who can clear
  // this", so this is the tier, not a new one. `blocked` is already red and is already OUT of the
  // dock-badge/banner set (`engine/attention` covers waiting/approval/errored only), so this
  // recolours the dot and re-sorts the row WITHOUT firing a notification — which is what makes it
  // safe to reach for on a row the founder is otherwise happy with.
  if (s.hold === "pane-wedged" && !ADDRESSED_TO_HUMAN.has(status)) {
    return { status: "blocked", label: s.holdText ? HELD + s.holdText : "Hourly pass held" };
  }
  // ── 2. A LIVE PASS STAYS GREEN, and gains its elapsed time ────────────────────────────────────
  // WAITING ON SUB-AGENTS IS HEALTHY WORK, not a stall — the founder's ruling — and the improvement
  // pass does it constantly by design. So a pass child that is `active` but quiet keeps `working`;
  // this rule LABELS it rather than recolouring it. The number is what a hung pass otherwise lacks:
  // before it, a wedged child sat green with no indication at all until `STALE_PASS_MAX` (35 min).
  if (status === "working" && s.passElapsedMs != null) {
    return { status, label: intoPass(s.passElapsedMs) };
  }
  // ── 3. A HOLD, NAMED ──────────────────────────────────────────────────────────────────────────
  // Resting only. A non-resting status is a live producer's word about this agent and outranks a
  // sentence about the schedule.
  // ⚠️ `already-running` IS NOT A HOLD — the duty is not held, the pass is RUNNING (roborev 67801).
  // Routing it through the HELD prefix produced "Hourly pass held — a pass is already in flight",
  // which contradicts itself. And it is reachable for a long window rather than one tick:
  // `runImprovementPass` claims the latch at the very top and only spawns the child after the whole
  // networked preamble (clone / worktree / park), so throughout that preamble `passRunning` is true
  // while `sparkle_improve_active` still reports inactive — the liveness poller has not raised the
  // row yet and there is no elapsed time to show.
  if (RESTING.has(status) && s.hold === "already-running") {
    // ⚠️ RAISE THE STATUS, DO NOT JUST RELABEL IT (roborev 67831). Returning the resting status with
    // a label beginning "Working" produced a GRAY disc whose own hover text said the pass was
    // working — a disc and its label describing different situations, which is the mirror of the
    // defect this file's header is written against. The latch is claimed, so a pass genuinely IS in
    // flight; green is the honest disc and this is a raise off a resting value like every other.
    return {
      status: "working",
      label: s.passElapsedMs != null ? intoPass(s.passElapsedMs) : "Working — pass starting",
    };
  }
  if (RESTING.has(status) && s.holdText) {
    return { status, label: HELD + s.holdText };
  }
  // ── 4. RESTING, WITH THE NEXT SLOT NAMED ──────────────────────────────────────────────────────
  // This is the line that replaces the two dishonest ones: `stopped`'s "Stopped" and `idle`'s
  // "Done — your turn". Nothing is owed by the human here and nothing has stopped; the next pass is
  // simply not due yet.
  if (RESTING.has(status) && s.nextPassAt != null) {
    const label =
      s.nextPassAt <= s.at
        ? "Resting — next pass due now"
        : `Resting — next pass in ${inAbout(s.nextPassAt - s.at)}`;
    return { status, label };
  }
  // ── 5. NOTHING TO ADD — the taxonomy label stands ─────────────────────────────────────────────
  return { status, label: undefined };
}
