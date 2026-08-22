// @vitest-environment jsdom
//
// GRAY MEANS INACTIVE — the founder's rule, asserted at the one place that could paint gray over a
// live agent.
//
// THE REPORT. The Improve Sparkle row showed a GRAY dot while its pane, open beside it, rendered
// "✻ Kneading… (13m 56s · ↓ 42.7k tokens)" and "esc to interrupt". His words: "If it's still active
// … it should be green if it's happy, it should be amber if it's got issues, red if it's blocked,
// etc., but not gray." And: "GRAY MEANS IT'S INACTIVE."
//
// THE MECHANISM. `settle()` is armed by two seconds of silence on the INGEST path, and silence
// there is not the same fact as an idle agent — PTY read backpressure pauses the reader past its
// high-water mark, so a verbose shell command stops chunks arriving while the spinner stays painted
// on the grid. `settle` read the viewport ONLY to ask `screenAwaitsInput`, never "is it still
// working", so it emitted `idle`.
//
// WHY THE IMPROVE SPARKLE ROW SPECIFICALLY. Every build row is defended twice over and that row is
// defended not at all: `AgentPane` builds a `createStatusRouter` whose `hook !== "idle"` rule lets a
// hook `working` outrank a screen guess, and installs hooks to feed it. `SparkleAgentPane` does
// neither — `onStatus={(s) => setStatus(agentId, s)}` writes the raw screen verdict straight to the
// store. So the same false `idle` that a build row swallows lands on that dot. And it STICKS:
// `set()` dedups on its own field, so a steadily-working pane emits nothing further and never
// re-asserts `working`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusEngine, isSpinnerFrame, screenShowsLiveSpinner } from "./statusEngine";
import { AGENT_STATUS } from "@sparkle/ui/tokens";
import { log } from "../logger";
import type { AgentTabStatus } from "../types";

let logInfo: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  logInfo = vi.spyOn(log, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  logInfo.mockRestore();
});

/** The founder's screen, as a REAL turn-in-flight viewport reads: the spinner is NOT the last row —
 *  the input box and the persistent footer sit below it. That stack is what `LIVE_TAIL_ROWS` has to
 *  reach, so the fixture pins the tail depth rather than assuming it. */
const kneading = (elapsed: string) =>
  [
    "● Committed. Now close the two reviews on merged #2340 and run the PR gates:",
    "",
    "  Ran 1 shell command",
    "",
    `✻ Kneading… (${elapsed} · ↓ 42.7k tokens)`,
    "╭──────────────────────────────────────────╮",
    "│ >                                        │",
    "╰──────────────────────────────────────────╯",
    "  ▶▶ bypass permissions on (shift+tab to cycle) · esc to interrupt",
  ].join("\n");

/** A LIVE spinner: its clock advances between reads, which is what distinguishes it from a frozen
 *  one. Every hold below is driven through this, because holding on presence alone is the defect. */
const advancing = () => {
  let n = 0;
  return () => kneading(`${(n += 7)}s`);
};

const KNEADING_SCREEN = kneading("13m 56s");

/** The same session a moment later: the turn ended, the status line is gone. */
const SETTLED_SCREEN = [
  "● Committed. Now close the two reviews on merged #2340 and run the PR gates:",
  "",
  "  Ran 1 shell command",
  "",
  "╭──────────────────────────────────────────╮",
  "│ >                                        │",
  "╰──────────────────────────────────────────╯",
].join("\n");

/** A finished turn whose spinner line is still in the SCROLLBACK, well above the input box. This is
 *  the false positive the tail-anchoring exists to reject — without it, every settled agent that
 *  ever spun would latch green forever. */
const STALE_SPINNER_IN_SCROLLBACK = [
  "✻ Kneading… (13m 56s · ↓ 42.7k tokens)",
  "",
  "● Done. Opened PR #2355.",
  "",
  "  Ran 1 shell command",
  "",
  "● All gates clean; the branch is pushed and the review is drained.",
  "",
  "  Ran 2 shell commands",
  "",
  "● Nothing further — let me know if you want anything else.",
  "",
  "╭──────────────────────────────────────────╮",
  "│ >                                        │",
  "╰──────────────────────────────────────────╯",
].join("\n");

const PROMPT_SCREEN = [
  "│ Do you want to make this edit to foo.ts?           │",
  "│ ❯ 1. Yes                                           │",
  "│   2. No                                            │",
].join("\n");

/** One spinner redraw frame, as `ingest` sees it on the stream. */
const SPINNER_CHUNK = "✻ Kneading… (12s · ↓ 1.2k tokens)\r";

function engineOn(screen: () => string) {
  const statuses: AgentTabStatus[] = [];
  const engine = new StatusEngine({
    agentId: "improve-sparkle",
    onStatus: (s) => statuses.push(s),
    getScreen: screen,
  });
  return { engine, statuses, last: () => statuses[statuses.length - 1] };
}

const isGray = (s: AgentTabStatus) => AGENT_STATUS[s].color === AGENT_STATUS.stopped.color;

describe("screenShowsLiveSpinner — bottom-anchored, because scrollback has no bottom", () => {
  it("sees the live status line at the foot of the viewport", () => {
    expect(screenShowsLiveSpinner(KNEADING_SCREEN)).toBe(true);
  });

  it("REJECTS a spinner far enough up the scrollback", () => {
    // Distance is the FIRST line of defence, not the only one — see the settle test below for the
    // one that matters once the window is wide enough to admit some transcript.
    expect(screenShowsLiveSpinner(STALE_SPINNER_IN_SCROLLBACK)).toBe(false);
  });

  it("sees it through the trailing blank rows a fixed-height grid pads with", () => {
    expect(screenShowsLiveSpinner(`${KNEADING_SCREEN}\n\n\n\n`)).toBe(true);
  });

  it("sees a spinner sitting exactly at the tail boundary", () => {
    // The boundary, pinned in both directions, because the failure past it is SILENT and total: the
    // spinner falls out of the tail, no hold happens, and a live agent goes straight to gray with
    // every test still green. That is the founder's original bug returning.
    const atEdge = ["✻ Kneading… (1s · ↓ 1k tokens)", ...Array(11).fill("filler")].join("\n");
    expect(screenShowsLiveSpinner(atEdge)).toBe(true);
  });

  it("does NOT see one sitting one row beyond it", () => {
    const pastEdge = ["✻ Kneading… (1s · ↓ 1k tokens)", ...Array(12).fill("filler")].join("\n");
    expect(screenShowsLiveSpinner(pastEdge)).toBe(false);
  });

  it("clears the real turn-in-flight stack with headroom to spare", () => {
    // spinner → three-row input box → footer is already 5 rows, and a wrapped footer, a
    // `? for shortcuts` hint or a two-line composer each add one. This asserts the margin exists
    // rather than trusting the constant.
    const crowded = [
      "✻ Kneading… (13m 56s · ↓ 42.7k tokens)",
      "╭──────────────────────────────────────────╮",
      "│ >                                        │",
      "│                                          │",
      "╰──────────────────────────────────────────╯",
      "  ▶▶ bypass permissions on (shift+tab to cycle) ·",
      "     esc to interrupt",
      "  ? for shortcuts",
      "  1 message queued",
    ].join("\n");
    expect(screenShowsLiveSpinner(crowded)).toBe(true);
  });

  it.each([["a settled screen", SETTLED_SCREEN], ["nothing", ""], ["blank rows", "\n\n\n"]])(
    "reports no live spinner for %s",
    (_label, screen) => {
      expect(screenShowsLiveSpinner(screen)).toBe(false);
    },
  );
});

describe("a visibly-working agent never settles to GRAY", () => {
  it("holds `working` while the spinner is still advancing and ingest has gone quiet", () => {
    const { engine, last, statuses } = engineOn(advancing());
    engine.ingest(SPINNER_CHUNK);
    expect(last()).toBe("working"); // non-vacuity: it IS green before the settle timer fires

    vi.advanceTimersByTime(2000); // SPINNER_GRACE_MS — the settle that used to paint gray

    expect(last()).toBe("working");
    expect(isGray(last()!)).toBe(false);
    expect(statuses.some(isGray)).toBe(false);
  });

  it("stays out of gray across many settles, not just the first", () => {
    // `set()` dedups, so one gray write pins the row for the rest of the turn — a fix that only
    // survived the first timer would still lose the row a few seconds later.
    const { engine, statuses } = engineOn(advancing());
    engine.ingest(SPINNER_CHUNK);
    vi.advanceTimersByTime(30_000);
    expect(statuses.some(isGray)).toBe(false);
  });

  it("A FROZEN SPINNER EVENTUALLY SETTLES — presence is not evidence of life", () => {
    // The High finding. A backpressured reader that never resumes, a hung TUI, or a false match in
    // the tail all present as a spinner that is THERE but never redraws. Holding on presence alone
    // pins `working` forever with no path back — and `working` is not a resting status, so
    // auto-continue dies, `sawRecentError` is never cleared, and the background-task and
    // session-limit reads never run again.
    const { engine, last } = engineOn(() => KNEADING_SCREEN); // static: the clock never moves
    engine.ingest(SPINNER_CHUNK);
    vi.advanceTimersByTime(60_000);
    expect(last()).toBe("idle");
    expect(isGray(last()!)).toBe(true);
  });

  it("a LONG turn with many stalls never exhausts the hold budget", () => {
    // `MAX_SPINNER_HOLDS` bounds ONE pathological run. Without a reset on the ingest path the budget
    // accrued across every stall in a turn, so a long turn would exhaust it while the spinner was
    // still ticking — and the single `idle` that follows is pinned by `set()`'s dedup for the rest
    // of the turn. 400 stalls is well past the 150 cap.
    const { engine, statuses } = engineOn(advancing());
    for (let i = 0; i < 400; i++) {
      engine.ingest(SPINNER_CHUNK); // a real frame arrives — forward progress
      vi.advanceTimersByTime(2000); // …then ingest stalls long enough to settle
    }
    expect(statuses.some(isGray)).toBe(false);
  });

  it("SPINNER CHUNKS OVER A STATIC SCREEN still settle — arrival is not movement", () => {
    // The latch reintroduced through the budget reset (roborev 67297). A rate-limit retry loop
    // re-emits IDENTICAL spinner frames, and a hung TUI or a glyph-led false match on the stream
    // does the same. If ingest cleared the movement baseline, each arrival would re-null it, every
    // settle would re-hold, and the row would latch `working` with no path back — while the screen
    // never changed. Chunks keep coming here; only the SCREEN is static.
    const { engine, last, statuses } = engineOn(() => KNEADING_SCREEN);
    for (let i = 0; i < 40; i++) {
      engine.ingest(SPINNER_CHUNK);
      vi.advanceTimersByTime(2000);
    }
    expect(last()).toBe("idle");
    expect(statuses.some(isGray)).toBe(true);
  });

  it("THE PAIRED CASE — it DOES settle to gray once the spinner is really gone", () => {
    // Without this, "never gray" would also pass for an engine that had stopped settling at all,
    // which is the opposite bug: a permanently green fleet.
    const tick = advancing();
    let ended = false;
    const { engine, last } = engineOn(() => (ended ? SETTLED_SCREEN : tick()));
    engine.ingest(SPINNER_CHUNK);
    vi.advanceTimersByTime(2000);
    expect(last()).toBe("working");

    ended = true; // the turn ended
    vi.advanceTimersByTime(4000); // the re-armed settle re-reads the screen

    expect(last()).toBe("idle");
    expect(isGray(last()!)).toBe(true);
  });

  it("NEVER SUPPRESSES A RED — a prompt on screen still settles to `waiting`", () => {
    // The one outcome that would make this fix worse than the bug. The gate is `!screenAwaitsInput`
    // precisely so the live-spinner rule can only ever prevent GRAY, never an alarm.
    const { engine, last } = engineOn(() => PROMPT_SCREEN);
    engine.ingest(SPINNER_CHUNK);
    vi.advanceTimersByTime(2000);
    expect(last()).toBe("waiting");
  });

  it("a screen carrying BOTH a live spinner and a prompt resolves to the prompt", () => {
    const both = `${PROMPT_SCREEN}\n✻ Kneading… (13m 56s · ↓ 42.7k tokens)`;
    const { engine, last } = engineOn(() => both);
    engine.ingest(SPINNER_CHUNK);
    vi.advanceTimersByTime(2000);
    expect(last()).toBe("waiting");
  });
});

describe("a stale spinner INSIDE the tail still cannot latch a row green", () => {
  // THE PROPERTY THAT CARRIES THE WEIGHT once `LIVE_TAIL_ROWS` is wide enough to admit some
  // transcript. Distance alone was the whole guarantee when the window was 6 rows, and that made
  // the window a tightrope: too narrow and a live spinner falls outside it (silent, total, the
  // founder's original bug); too wide and scrollback matches. Requiring the tail to have CHANGED
  // removes the trade — a spinner that is present but not redrawing cannot hold anything, wherever
  // it sits — so the window can be sized for headroom instead.
  it("settles to gray even with a finished turn's spinner still visible in the tail", () => {
    const withStaleSpinner = [
      "✻ Kneading… (13m 56s · ↓ 42.7k tokens)",
      "● Done. Opened PR #2355.",
      "╭────────────────╮",
      "│ >              │",
      "╰────────────────╯",
    ].join("\n");
    // Non-vacuity: the matcher really does see it, so this pins the progress rule rather than
    // distance quietly doing the work.
    expect(screenShowsLiveSpinner(withStaleSpinner)).toBe(true);

    const { engine, last } = engineOn(() => withStaleSpinner);
    engine.ingest(SPINNER_CHUNK);
    vi.advanceTimersByTime(60_000);
    expect(last()).toBe("idle");
  });
});

describe("the matcher's known false positives cannot latch a row green", () => {
  // `isSpinnerFrame` was tuned for redraw FRAMES and is applied here to rendered transcript rows,
  // where `SPINNER_GLYPH` admits `*`/`+`/`·` and the tails include `esc to interrupt` and a bare
  // token counter. These are the shapes that match but are not a live turn.
  const settledWith = (tail: string) =>
    ["● Done. Opened PR #2355.", "", tail, "╭────────────────╮", "│ >              │", "╰────────────────╯"].join("\n");

  it.each([
    ["a wrapped persistent footer stranded in the tail", "· bypass permissions on · esc to interrupt"],
    ["a markdown bullet quoting a token count", "* Rerun the suite (30s · 1.2k tokens)"],
    ["a bare token counter in prose", "· wrote 1.2k tokens to the log"],
  ])("settles to gray anyway: %s", (_label, tail) => {
    // ⚠️ NON-VACUITY FIRST. Each row must actually MATCH the spinner matcher, or the assertion
    // below passes because nothing ever fired — which is what happened to an earlier version of
    // this table: `* rerun the suite for 30s` does not match (`SPINNER_BARE_FRAME` needs the tail
    // to follow the word immediately, and lower-case fails its `[A-Z]`), so that case proved
    // nothing at all (roborev 67258).
    expect(isSpinnerFrame(tail), `row does not match the matcher, so this case is vacuous: ${tail}`)
      .toBe(true);

    const { engine, last } = engineOn(() => settledWith(tail));
    engine.ingest(SPINNER_CHUNK);
    vi.advanceTimersByTime(60_000);
    expect(last()).toBe("idle");
  });
});

describe("teardown", () => {
  it("stops writing status once disposed mid-hold", () => {
    // WHAT THIS DOES AND DOES NOT COVER, stated because an earlier comment here claimed more.
    //
    // It pins a REAL property — a disposed engine writes no further status while a hold is in
    // flight — and that property is delivered by `dispose()` cancelling the pending timer, not by
    // `settle`'s `disposed` guard. Mutating that guard leaves this test green, because `dispose()`
    // already stopped the timer from firing (roborev 67258). The guard remains as defence in depth
    // for a future path that could re-enter `settle` after teardown; it is deliberately NOT claimed
    // as covered here. Asserts the SIDE EFFECT — no further writes — not that a flag was set.
    const { engine, statuses } = engineOn(advancing());
    engine.ingest(SPINNER_CHUNK);
    vi.advanceTimersByTime(4000);
    const before = statuses.length;
    engine.dispose();
    vi.advanceTimersByTime(60_000);
    expect(statuses.length).toBe(before);
  });
});

describe("the Improve Sparkle row — the raw-verdict path, with no router to save it", () => {
  it("the status the app-owned pane would write is not gray while the agent is live", () => {
    // `SparkleAgentPane` has no `createStatusRouter` and installs no hooks, so whatever this engine
    // emits IS what reaches `runtimeStore.status["__sparkle_self__"]` and therefore the dot. This
    // asserts the colour the row would paint, which is the founder's actual complaint.
    const written: AgentTabStatus[] = [];
    const engine = new StatusEngine({
      agentId: "__sparkle_self__",
      onStatus: (s) => written.push(s), // exactly SparkleAgentPane.tsx's `onStatus`
      getScreen: advancing(),
    });
    engine.ingest(SPINNER_CHUNK);
    vi.advanceTimersByTime(15_000);

    const painted = written[written.length - 1]!;
    expect(AGENT_STATUS[painted].color).toBe(AGENT_STATUS.working.color);
    expect(AGENT_STATUS[painted].color).not.toBe(AGENT_STATUS.idle.color);
    expect(AGENT_STATUS[painted].color).not.toBe(AGENT_STATUS.stopped.color);
  });
});
