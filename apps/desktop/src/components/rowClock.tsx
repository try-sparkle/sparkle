import { useState, useEffect } from "react";
import { AGENT_STATUS, C } from "../theme/colors";
import { FONT_MONO, TYPE } from "../theme/scale";
import { GLYPH_SLOT_H } from "../engine/rowGeometry";
import type { RollupDot } from "../engine/workerRollup";
import type { AgentTabStatus } from "../types";
import type { BuildSectionId } from "../engine/buildSections";
import { displayStatusFor } from "../engine/stallEscalation";
import { formatElapsed } from "../engine/elapsed";

/**
 * The build row's ticking clock and the two presentational leaves that read it — moved verbatim
 * out of AgentSidebar.tsx, no logic change.
 *
 * `useRowClock` is owned once per row and shared by BOTH of that row's ElapsedTimer render sites
 * (collapsed and hover overlay), which is the whole reason it is a hook and not two intervals.
 * `AgentRow` and `SparkleAgentRow` both consume it, so it could not stay inside either of them.
 */

// Format an elapsed duration (ms) for the sidebar timer: integer seconds while under 100s (each
// second is visible there), then minutes / hours / days each to one decimal with a trailing ".0"
// stripped (so 2 minutes reads "2m", 1.5 reads "1.5m"). Pure + exported for testing.
//
// It LIVES in `engine/elapsed`, so the concierge's RESOLVED nudge card can spell a duration the
// same way this row does. Re-exported from here (and, in turn, from AgentSidebar.tsx) rather than
// relocated outright, because `AgentSidebar.elapsedTimer.test` names that import path.
//
// Imported above AND re-exported here, not `export { … } from "…"`: the bare re-export form
// creates no LOCAL binding, so ElapsedTimer's own call site below would have stopped resolving —
// a compile error, but only for this file, which is the sort of thing a re-export looks like it
// handles and does not.
export { formatElapsed };

// What a rolled-up disc is painted. The four definite marks reuse the AGENT_STATUS tier colors
// straight (NOT statusInk — that resolves a color to a legible TEXT ink, and this is a filled
// shape), so a rolled-up green is pixel-identical to a working agent's own dot rather than a near
// miss. `mixed` is the one color with no status behind it; see theme/colors mixedInk.
export const ROLLUP_DOT_COLOR: Record<RollupDot, string> = {
  green: AGENT_STATUS.working.color,
  red: AGENT_STATUS.waiting.color,
  // Raw brand azure, for the same reason the other three are raw: this is a FILL. The themed
  // `questionsInk` twin is for the word "Questions" as text, not for the disc.
  blue: AGENT_STATUS.questions.color,
  gray: AGENT_STATUS.idle.color,
  orange: C.mixedInk,
};

/**
 * What a build row's DISC is filled with, or `undefined` to let `StatusDot` use the status's own
 * tier colour.
 *
 * ══ WHY THIS IS A FUNCTION AND NOT THREE LINES AT THE CALL SITE ══════════════════════════════════
 * Because the call site is the thing that was wrong, twice. `StatusDot` computes `ink = color ??
 * meta.color`, so a row that passes `undefined` here is painted from its RAW status — and the first
 * attempt at the founder's terminal-gray rule passed the floored status to `AgentRow` as
 * `statusColor`, which feeds only the founder-ask chip, the kind glyph and the alert toggle
 * (`AgentRow.tsx:813` says so outright). The disc never saw it, so an ordinary `unmerged` row in a
 * pre-terminal section went on rendering gray — the exact case the rule exists for — while a test
 * that re-implemented the expression locally stayed green. Exporting the decision means the test
 * and the row read the SAME code.
 *
 * ── THE RULE (the founder, 2026-08-19) ──────────────────────────────────────────────────────────
 * *"Nothing should ever be gray unless it has been effectively finished ... a remote merge domain or
 * shipped status."* A row short of those paints AMBER (`lapsed`, "Unfinished, not yours").
 *
 * ── RAW COLOUR, NOT `statusInk` ─────────────────────────────────────────────────────────────────
 * Same reasoning as {@link ROLLUP_DOT_COLOR} above: this is a FILLED SHAPE, not text, so it takes
 * the tier colour straight. `statusInk` resolves a colour to a legible text ink and would leave the
 * amber disc a near-miss of the rolled-up amber rather than pixel-identical to it.
 *
 * ── EVIDENCE, NOT INFERENCE ─────────────────────────────────────────────────────────────────────
 * `section === undefined` means this window never read the row's git state, and then nothing is
 * repainted. Deriving a section through `resolveStage` instead would floor at the first rung and
 * manufacture a pre-terminal section for every unpolled row.
 */
export function dotFillFor(
  status: AgentTabStatus,
  section: BuildSectionId | undefined,
  rollup: RollupDot,
  rollupOverrides: boolean,
): string | undefined {
  // A rolled-up subtree speaks for the row, and its gray obeys the same rule.
  if (rollupOverrides) {
    const repaint = displayStatusFor("idle", section);
    return rollup === "gray" && repaint !== undefined
      ? AGENT_STATUS[repaint].color
      : ROLLUP_DOT_COLOR[rollup];
  }
  // Otherwise the row's OWN status paints the disc. Return a colour ONLY when the rule actually
  // repaints it, so every unaffected row keeps `StatusDot`'s own fallback and this cannot become a
  // second, drifting source of truth for ordinary colours.
  const repaint = displayStatusFor(status, section);
  return repaint === undefined ? undefined : AGENT_STATUS[repaint].color;
}

/**
 * One ticking clock per agent row. Returns a `now` (epoch ms) that advances every 1s while the
 * agent has been idle under 100s (where each second matters) and relaxes to a 5s beat after that.
 * Owned ONCE by the row and shared by BOTH the collapsed and the hover-overlay ElapsedTimer, so the
 * elapsed count is identical in both — going on/off hover never swaps to a second timer with its own
 * out-of-phase clock, which previously made the count visibly jump backward (read as a spurious
 * "reset"). `since` is the user's last interaction; null means no timer, so the interval is skipped.
 */
/** The row clock's two cadences. Fast for the first 100s after an interaction, where every second
 *  is visible in the counter; relaxed afterwards, where the display is minutes to one decimal. */
const ROW_CLOCK_FAST_MS = 1000;
const ROW_CLOCK_SLOW_MS = 5000;

interface RowClockSub {
  /** How often THIS row wants waking — {@link ROW_CLOCK_FAST_MS} or {@link ROW_CLOCK_SLOW_MS}. */
  cadence: number;
  /** Epoch ms this row was last notified; the ticker uses it to decide whether the row is due. */
  last: number;
  notify: (now: number) => void;
}

// ── ONE TICKER FOR THE WHOLE COLUMN ─────────────────────────────────────────────────────────────
// `useRowClock` used to own a `setInterval` PER ROW. At the founder's 60 agents that is 60
// independent timers, 60 independent wakeups and 60 independent `visibilitychange` listeners, each
// firing a `setNow` that re-renders that row's whole (unmemoized, ~2,200-line) body. The timers are
// the part that is pure waste: the renders are the feature, sixty scheduler entries to produce them
// are not.
//
// So the rows subscribe to a module-level clock instead, and it runs exactly one interval.
//
// ⚠️ THE TRAP THIS SHAPE AVOIDS. A single 1s ticker that woke every subscriber each second would be
// WORSE than sixty timers, not better: it would quintuple the re-renders of every relaxed row. The
// two rates are therefore preserved PER SUBSCRIBER — the interval runs at the fastest cadence
// anyone currently wants, and each tick notifies only the subscribers whose own cadence is due.
// With no fast row mounted the interval itself relaxes to 5s, so an all-relaxed column wakes at the
// same rate it did before.
const rowClockSubs = new Set<RowClockSub>();
let rowClockInterval: ReturnType<typeof setInterval> | undefined;
/** The cadence `rowClockInterval` was started at, so a re-evaluation can tell "already right". */
let rowClockCadence = 0;
let rowClockListening = false;

const rowClockVisible = (): boolean =>
  typeof document === "undefined" || document.visibilityState === "visible";

function rowClockTick(): void {
  const now = Date.now();
  for (const sub of rowClockSubs) {
    // HALF THE TICK OF SLACK, because a real `setInterval` does not fire on the exact millisecond.
    // Without it a 1s subscriber on a 1s ticker that fires at 999ms elapsed is judged not-due and
    // skips to the NEXT tick — a visible stutter in a counter whose whole job is to show seconds.
    // With it, a 5s subscriber still cannot fire at 4s (4000 < 4500).
    if (now - sub.last >= sub.cadence - rowClockCadence / 2) {
      sub.last = now;
      sub.notify(now);
    }
  }
  // RELAX HERE, NOT ON UNSUBSCRIBE — see rowClockStart's warning. A tick has just fired, so
  // replacing the interval now cannot starve anyone; doing it during subscription churn can.
  if (rowClockSubs.size > 0 && rowClockDesiredCadence() > rowClockCadence) {
    rowClockRestart(rowClockDesiredCadence());
  }
}

function rowClockStop(): void {
  if (rowClockInterval !== undefined) {
    clearInterval(rowClockInterval);
    rowClockInterval = undefined;
  }
  rowClockCadence = 0;
}

/** The fastest cadence any currently-mounted row wants. */
function rowClockDesiredCadence(): number {
  let cadence = ROW_CLOCK_SLOW_MS;
  for (const sub of rowClockSubs) if (sub.cadence < cadence) cadence = sub.cadence;
  return cadence;
}

function rowClockRestart(cadence: number): void {
  rowClockStop();
  rowClockCadence = cadence;
  rowClockInterval = setInterval(rowClockTick, cadence);
}

/**
 * Start the shared interval, or TIGHTEN it if someone now wants a faster beat than it is running
 * at. No-op when nobody is subscribed or the window is hidden — both mean there is nothing to tick
 * for — and, critically, a no-op when the running cadence is already fast enough.
 *
 * ⚠️ TIGHTEN-ONLY, AND WHY IT MUST NOT ALSO RELAX HERE (roborev 60545). Replacing the interval
 * discards a PENDING fire, and with one shared timer that starves EVERY row rather than one. The
 * hook resubscribes on every change to `since`, and `since` is `interactionStore.lastAt`, which is
 * rewritten every `TOUCH_THROTTLE_MS` (900ms) for as long as the user types into a terminal. So on
 * a realistic column — one fast row, the rest relaxed — an earlier version restarted twice per
 * keystroke window: unsubscribing the only fast row relaxed the timer to 5s, and the immediate
 * resubscribe tightened it back to 1s. The 1s interval was destroyed every ~900ms and never
 * reached its first fire, so the whole column's clock froze for as long as typing continued.
 *
 * With tighten-only, a fast→fast resubscribe finds 1000 already running and leaves it completely
 * alone, so the churn costs nothing. Relaxation is genuinely wanted, just not urgently, and it
 * happens in {@link rowClockTick} — after a fire, where it can starve nobody. The cost is at most
 * one extra wakeup at the old rate before it settles.
 */
function rowClockStart(): void {
  if (rowClockSubs.size === 0 || !rowClockVisible()) return;
  const desired = rowClockDesiredCadence();
  if (rowClockInterval !== undefined && desired >= rowClockCadence) return;
  rowClockRestart(desired);
}

function onRowClockVisibility(): void {
  if (rowClockVisible()) {
    // Catch every subscriber up to real elapsed time the instant we are shown, then resume. Same
    // contract the per-row version had — the clock froze while hidden, so it must not come back
    // holding a stale reading and then advance from it.
    const now = Date.now();
    for (const sub of rowClockSubs) {
      sub.last = now;
      sub.notify(now);
    }
    rowClockStart();
  } else {
    // Nobody is watching a backgrounded window's elapsed counter, so the wakeups are pure waste.
    rowClockStop();
  }
}

function rowClockSubscribe(cadence: number, notify: (now: number) => void): () => void {
  const sub: RowClockSub = { cadence, last: Date.now(), notify };
  rowClockSubs.add(sub);
  if (!rowClockListening && typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onRowClockVisibility);
    rowClockListening = true;
  }
  rowClockStart();
  return () => {
    rowClockSubs.delete(sub);
    if (rowClockSubs.size === 0) {
      rowClockStop();
      if (rowClockListening && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onRowClockVisibility);
        rowClockListening = false;
      }
    } else {
      // DELIBERATELY NOTHING. The departing row may have been the only fast one, but relaxing the
      // ticker here is exactly the restart that starves the column during `since` churn — see
      // rowClockStart. `rowClockTick` relaxes it after the next fire instead.
    }
  };
}

export function useRowClock(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const fast = since != null && now - since < 100_000;
  useEffect(() => {
    // `since == null` means the agent has never been touched, so there is no duration to count and
    // this row registers NOTHING — not a slow subscription, not a timer.
    if (since == null) return;
    return rowClockSubscribe(fast ? ROW_CLOCK_FAST_MS : ROW_CLOCK_SLOW_MS, setNow);
  }, [fast, since]);
  return now;
}

/**
 * Presentational elapsed counter: shows how long since `since` (the user's last interaction with the
 * agent — a composer Send or terminal keystroke) given the row's shared `now`. The value resets only
 * when `since` advances (a new prompt/keystroke), never on hover. Takes the agent's status color so
 * the counter matches the name (green / red / gray); tabular-nums so it never jitters as digits
 * change. Stateless by design — the ticking clock lives in useRowClock so both render sites agree.
 */
export function ElapsedTimer({ since, now, color }: { since: number; now: number; color: string }) {
  return (
    <div
      data-testid="row-elapsed"
      style={{
        flex: "0 0 auto",
        height: GLYPH_SLOT_H,
        display: "flex",
        alignItems: "center",
        // `.row .el{font:var(--t-micro) var(--k-mono);color:var(--k-faint)}` — the mock's own rule.
        // It was 12px system-ui, i.e. the same face and nearly the same size as the NAME beside it,
        // so the row's two spans read as one run of text with a number in front. Mono at 10px is
        // what makes the elapsed value read as an instrument reading rather than as part of the
        // title, and it is the same treatment the stage chip and the group headers take.
        fontFamily: FONT_MONO,
        fontSize: TYPE.micro,
        color,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {formatElapsed(Math.max(0, now - since))}
    </div>
  );
}
