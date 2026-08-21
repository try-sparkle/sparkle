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
import { StatusEngine, screenShowsLiveSpinner } from "./statusEngine";
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

  it("REJECTS a spinner left in the scrollback above a settled prompt", () => {
    // The paired case, and the one that makes the rule safe. A whole-viewport scan would report
    // `true` here and latch every finished agent green.
    expect(screenShowsLiveSpinner(STALE_SPINNER_IN_SCROLLBACK)).toBe(false);
  });

  it("sees it through the trailing blank rows a fixed-height grid pads with", () => {
    expect(screenShowsLiveSpinner(`${KNEADING_SCREEN}\n\n\n\n`)).toBe(true);
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

describe("the matcher's known false positives cannot latch a row green", () => {
  // `isSpinnerFrame` was tuned for redraw FRAMES and is applied here to rendered transcript rows,
  // where `SPINNER_GLYPH` admits `*`/`+`/`·` and the tails include `esc to interrupt` and a bare
  // token counter. These are the shapes that match but are not a live turn.
  const settledWith = (tail: string) =>
    ["● Done. Opened PR #2355.", "", tail, "╭────────────────╮", "│ >              │", "╰────────────────╯"].join("\n");

  it.each([
    ["a wrapped persistent footer stranded in the tail", "· bypass permissions on · esc to interrupt"],
    ["a markdown bullet that looks like a frame", "* rerun the suite for 30s"],
    ["a bare token counter in prose", "· wrote 1.2k tokens to the log"],
  ])("settles to gray anyway: %s", (_label, tail) => {
    const { engine, last } = engineOn(() => settledWith(tail));
    engine.ingest(SPINNER_CHUNK);
    vi.advanceTimersByTime(60_000);
    expect(last()).toBe("idle");
  });
});

describe("teardown", () => {
  it("stops writing status once disposed mid-hold", () => {
    // The hold RE-ARMS ITSELF, so an orphaned chain would keep calling `onStatus` on a torn-down
    // engine indefinitely. Asserts the SIDE EFFECT — no further writes — not that a flag was set.
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
