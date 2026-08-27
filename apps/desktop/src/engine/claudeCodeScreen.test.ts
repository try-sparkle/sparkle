// Telling a BUSY CLAUDE CODE apart from an actual full-screen app (bead sparkle-v7k3y).
//
// The pair that matters is the whole test: Claude Code busy must be recognised, and `vim`/`less`/
// `htop`/`lazygit` must NOT be — including a pager displaying a file that talks ABOUT Claude Code,
// which is the content-heuristic fool `dictationTerminalRoute`'s header was right to worry about.
import { describe, expect, it } from "vitest";
import {
  chromeBarTailBelow,
  claudeCodeMarkerFamilies,
  isClaudeCodeScreen,
  liveBackgroundSubagentCount,
} from "./claudeCodeScreen";
import { screenBlocksWrite } from "../voice/dictationTerminalRoute";
import {
  APPROVAL_2_1_220,
  IDLE_AFTER_TURN_2_1_220,
  NON_PICKER_HINT_LINES_2_1_220,
} from "./capturedScreens.fixture";

// ══ THE FOUNDER'S SECOND SCREEN (bead sparkle-tbsvf) ═══════════════════════════════════════════
// RECONSTRUCTED from the concierge's own read of the Improve Sparkle pane, not a captured viewport
// — same provenance rule BUSY_RUNNING_COMMAND above follows and the same reason it lives here
// rather than in capturedScreens.fixture.ts. Claude Code's live roster of its own background
// subagents, drawn in place of the ordinary composer the same way a permission dialog is.
const BACKGROUND_TASK_LIST = [
  "⏺ main",
  "◯ general-purpose  Concierge agents as clickable rows  21m 55s",
  "◯ general-purpose  Trustworthy status dot: bg-task si… 10m 29s",
].join("\n");

// ══ THE FOUNDER'S SCREEN ════════════════════════════════════════════════════════════════════════
// RECONSTRUCTED from the screenshot in sparkle-v7k3y — NOT a captured viewport, which is why it
// lives here and not in `capturedScreens.fixture.ts` (that file's provenance note is a promise that
// every fixture in it came out of a real PTY capture, and quietly adding a hand-written screen would
// break it). The lines are transcribed from the screenshot; the surrounding chrome is taken from the
// captured IDLE_AFTER_TURN_2_1_220, which is a real capture of the same TUI.
const BUSY_RUNNING_COMMAND = [
  "⏺ I'll run the test suite and commit.",
  "",
  "  Running 1 shell command · 1m 24s",
  '  ⎿  $ cd ".../worktrees/.../pr1104" && bash scripts/tests/run.sh 2>&1 | tail -2 && git add … (1m 23s)',
  "     (ctrl+b to run in background)",
  "",
  "────────────────────────────────────────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────────────────────────────────────────",
  "  ⏸ manual mode on · ? for shortcuts",
].join("\n");

describe("isClaudeCodeScreen — the founder's busy agent is not an editor", () => {
  // THE HEADLINE ROW. This exact screen produced "Babysit PR 1104 has a full-screen app open, so
  // the keys would have run as commands" and bounced his message.
  it("recognises Claude Code running a shell command", () => {
    expect(isClaudeCodeScreen(BUSY_RUNNING_COMMAND)).toBe(true);
  });

  // Not on one lucky marker. Four families are present here; asserting the COUNT is what stops a
  // later edit from collapsing them into a single over-broad pattern that still returns true.
  it("recognises it on several independent families, not one", () => {
    expect(claudeCodeMarkerFamilies(BUSY_RUNNING_COMMAND)).toBeGreaterThanOrEqual(3);
  });

  it("recognises a real captured idle Claude Code screen", () => {
    expect(isClaudeCodeScreen(IDLE_AFTER_TURN_2_1_220)).toBe(true);
  });

  // ══ A PERMISSION DIALOG *IS* RECOGNISED NOW — AND THE WRITE IS STILL REFUSED ══════════════════
  //
  // THE DELIBERATE CHANGE THIS ROW ASKED FOR (bead sparkle-v7k3y, second occurrence). The previous
  // version asserted `families === 1` and `false`, reasoning that both roads lead to a refusal so
  // the wrong road costs nothing. It cost a great deal: the two roads produce DIFFERENT REFUSAL
  // CODES, and the code is what the human is shown. `alternate-screen` renders as "has a full-screen
  // app open — quit it", which on a permission dialog is both false and unfollowable. One afternoon
  // of it: nine consecutive refusals to one agent, four other agents blocked, and a fleet-wide
  // escalation storm telling the founder to quit editors that were never running.
  //
  // The old comment named the exact condition for making this deliberate — "relying entirely on
  // `screenBlocksWrite` to catch it, one guard deep instead of two" — so here is that check, made
  // explicit rather than assumed: `terminalWriteRefusal` runs `screenBlocksWrite` on the same text
  // immediately after this predicate, and it returns `awaiting-input` for this screen. Free text is
  // therefore STILL refused. What changes is only which refusal fires, and so what the human is
  // told: "answer the prompt on screen", which is true and actionable, instead of "quit vim", which
  // is neither.
  it("recognises a permission dialog as Claude Code", () => {
    expect(claudeCodeMarkerFamilies(APPROVAL_2_1_220)).toBeGreaterThanOrEqual(2);
    expect(isClaudeCodeScreen(APPROVAL_2_1_220)).toBe(true);
  });

  // THE GUARD THAT NOW CARRIES THE REFUSAL. If this ever goes false, the change above becomes a
  // hole rather than a correction — a submitted message would press the highlighted button.
  it("...and the write is still refused, by the guard that names the real obstacle", () => {
    expect(screenBlocksWrite(APPROVAL_2_1_220)).toBe(true);
  });

  // ══ THE BACKGROUND-TASK LIST IS ALSO NOT AN EDITOR (bead sparkle-tbsvf) ═════════════════════════
  // THE HEADLINE ROW. This exact screen produced four consecutive "has a full-screen app open"
  // refusals against `__sparkle_self__` while the pane was doing nothing but listing its own
  // background subagents — no editor, no pager, ordinary busy Claude Code.
  it("recognises Claude Code showing its own background-task list", () => {
    expect(isClaudeCodeScreen(BACKGROUND_TASK_LIST)).toBe(true);
  });

  // The list replaces the composer box (family D) the same way a permission dialog does, so it must
  // stand on its own rather than needing a corroborating family — pinning the count keeps a later
  // edit from silently making this depend on the composer box being present too.
  it("recognises it from the task-list family alone, with no composer box on screen", () => {
    expect(claudeCodeMarkerFamilies(BACKGROUND_TASK_LIST)).toBeGreaterThanOrEqual(1);
    expect(isClaudeCodeScreen(BACKGROUND_TASK_LIST)).toBe(true);
  });
});

// ══ THE REFUSAL THE BEAD REQUIRES US TO KEEP ════════════════════════════════════════════════════
// "KEEP the refusal for genuine full-screen programs (vim, less, htop, lazygit). That guard is
// correct and must not be weakened to fix this."
describe("isClaudeCodeScreen — genuine full-screen apps are not Claude Code", () => {
  it("rejects a vim session", () => {
    const vim = ["~", "~", "~", '"notes.md" 12L, 340B', ":"].join("\n");
    expect(isClaudeCodeScreen(vim)).toBe(false);
  });

  it("rejects a less pager", () => {
    const less = ["some file contents", "more contents", ":"].join("\n");
    expect(isClaudeCodeScreen(less)).toBe(false);
  });

  it("rejects htop", () => {
    const htop = [
      "  1  [||||||     30.0%]   Tasks: 210, 900 thr; 2 running",
      "  Mem[|||||||    5.2G/16G]  Load average: 1.20 0.98 0.84",
      "  PID USER      PRI  NI  VIRT   RES   CPU% MEM%   TIME+  Command",
      " F1Help  F2Setup  F3Search  F9Kill  F10Quit",
    ].join("\n");
    expect(isClaudeCodeScreen(htop)).toBe(false);
  });

  it("rejects lazygit", () => {
    const lazygit = [
      "┌─Status──────────┐┌─Files───────────────────────────┐",
      "│ repo → main     ││ M apps/desktop/src/App.tsx      │",
      "└─────────────────┘└─────────────────────────────────┘",
    ].join("\n");
    expect(isClaudeCodeScreen(lazygit)).toBe(false);
  });

  // ══ THE CONTENT-HEURISTIC FOOL, STATED AS A TEST ══════════════════════════════════════════════
  // A pager showing THIS VERY BEAD, or any doc quoting Claude's status bar, trips exactly one family
  // and must not be enough. This is the case the two-family rule exists for — a single-marker
  // implementation passes every other test in this file and fails here.
  it("rejects a pager displaying a document that quotes Claude Code's status bar", () => {
    const paging = [
      "The guard sees the alternate screen and refuses. Claude Code draws",
      '"esc to interrupt" while it works, and offers ctrl+b to run in background.',
      "That is why the refusal fires on the most common state in the app.",
      ":",
    ].join("\n");
    expect(claudeCodeMarkerFamilies(paging)).toBeLessThan(2);
    expect(isClaudeCodeScreen(paging)).toBe(false);
  });

  // The mirror of the row above: prose bullets must not be read as Claude's gutter glyphs.
  it("rejects a document containing a mid-line tool glyph", () => {
    const doc = ["We saw ⏺ in the output and then ⎿ appeared.", "Nothing else happened.", ":"].join(
      "\n",
    );
    expect(isClaudeCodeScreen(doc)).toBe(false);
  });

  // ══ THE BACKGROUND-TASK LIST HAS THE SAME QUOTING HAZARD FAMILY D/E ALREADY GUARD AGAINST ══════
  // (bead sparkle-tbsvf). A pager showing a document that quotes the founder's screenshot — this
  // bead itself is exactly such a document — must not be read as a LIVE task list. Position is the
  // discriminator: the pager keeps its own trailing prompt below the quoted rows, which is neither
  // blank nor Claude's ambient chrome, so `hasBackgroundTaskList`'s below-footer walk rejects it.
  it("rejects a pager showing a document that quotes the background-task list", () => {
    const paging = [
      "⏺ main",
      "◯ general-purpose  Concierge agents as clickable rows  21m 55s",
      "That screen produced four consecutive refusals.",
      ":",
    ].join("\n");
    // Family B still fires on the line-start `⏺` — one family, same as the status-bar fool above —
    // proving family F's rejection is doing real positional work rather than the glyph simply
    // failing to match at all.
    expect(claudeCodeMarkerFamilies(paging)).toBe(1);
    expect(isClaudeCodeScreen(paging)).toBe(false);
  });

  // ══ THE TWO-FAMILY DOCUMENT FOOL (roborev 57704) ═════════════════════════════════════════════
  // The rows above each trip ONE family, which a flat "any two of four" rule would also have caught.
  // THIS one trips TWO — line-start ⏺/⎿ glyphs AND a quoted status bar — and it is a pager showing a
  // pasted Claude Code transcript, not Claude Code. It is why the composer box is mandatory rather
  // than merely one vote: a document reproduces Claude's output easily and its live input box not at
  // all. A build that dropped the box requirement passes every other test here and fails this one.
  it("rejects a pager showing a pasted Claude Code transcript", () => {
    const transcript = [
      "⏺ I'll run the test suite.",
      "  ⎿  $ bash scripts/tests/run.sh",
      "     … esc to interrupt",
      "notes.md (END)",
      ":",
    ].join("\n");
    expect(claudeCodeMarkerFamilies(transcript)).toBeGreaterThanOrEqual(2);
    expect(isClaudeCodeScreen(transcript)).toBe(false);
  });

  // ══ ONE NARROWING PER TEST (roborev 57718) ═══════════════════════════════════════════════════
  // These were ONE test, and it was vacuous in the exact way this repo keeps finding: it combined
  // underscore rules with a `> quoted` middle line, so reverting EITHER pattern alone still left no
  // box and the test stayed green. It only failed if both were reverted at once — an assertion that
  // passes against the code as it was before the change. Split so each narrowing is ratcheted by a
  // fixture that isolates it.

  // (a) Underscore rules around a LONE `>` — the middle line matches PROMPT_LINE's bare arm, so the
  // only thing standing between this and a false positive is `_` being absent from RULE_LINE.
  it("rejects a document whose underscore separators imitate the composer rules", () => {
    const doc = [
      "⏺ quoted from a transcript",
      "________________________________________",
      ">",
      "________________________________________",
      ":",
    ].join("\n");
    expect(isClaudeCodeScreen(doc)).toBe(false);
  });

  // (b) REAL box-drawing rules around a markdown blockquote — the rules are genuine, so the only
  // thing standing between this and a false positive is bare `>` being absent from PROMPT_LINE's
  // with-text arm.
  it("rejects a document whose blockquote sits between real box rules", () => {
    const doc = [
      "⏺ quoted from a transcript",
      "────────────────────────────────────────",
      "> quoted advice from the manual",
      "────────────────────────────────────────",
      ":",
    ].join("\n");
    expect(isClaudeCodeScreen(doc)).toBe(false);
  });

  it("rejects an empty screen", () => {
    expect(isClaudeCodeScreen("")).toBe(false);
  });
});

// ══ FAMILY F AUTHORIZES A WRITE, SO IT KEEPS THE STRICT WALK (roborev 68294, High) ══════════════
//
// `isClaudeCodeScreen` returns true on family F STANDING ALONE — no corroborating family, no
// composer box — and `screenBlocksWrite` reads it, so a false positive here is not a wrong colour,
// it is "a line pasted AND SUBMITTED" into whatever is really on screen.
//
// The wrapped-status-bar accommodation added for the ATTENTION reader is strictly weaker than the
// line-anchored walk: it constrains where the rejoined tail STARTS. Routing it into family F would
// let a pager showing a document that quotes a roster row and a status bar be written into. The two
// questions are therefore asked separately — `liveBackgroundSubagentCount` takes the looser test,
// `hasBackgroundTaskList` does not — and these pin that split from the side that matters.
describe("family F keeps the strict walk while the attention reader takes the loose one", () => {
  // THE SCREEN WHERE THE TWO READERS LEGITIMATELY DISAGREE, which is the only shape that can prove
  // the split. Its tail is a genuinely wrapped status bar — short, anchored, indistinguishable from
  // a live one — so the loose test ACCEPTS it and must: refusing it is the narrow-pane gray row.
  // Family F cannot afford the same benefit of the doubt, because it authorizes a keystroke.
  const ROSTER_UNDER_A_WRAPPED_BAR = [
    "  ◯ general-purpose  Draining roborev findings  3m 04s",
    "⏸ manual",
    "mode on · ?",
    "for shortcuts",
  ].join("\n");

  it("the ATTENTION reader counts it — that is the narrow-pane fix", () => {
    expect(liveBackgroundSubagentCount(ROSTER_UNDER_A_WRAPPED_BAR)).toBe(1);
  });

  it("…and family F still does NOT fire on it, so no write is authorized", () => {
    // `dictationTerminalRoute:403` is the consumer: `viewport.alternateBuffer &&
    // !isClaudeCodeScreen(text)` is what refuses an alternate-buffer write. A true here would let a
    // pager showing this be typed into — "a line pasted AND SUBMITTED", per this file's own header.
    expect(isClaudeCodeScreen(ROSTER_UNDER_A_WRAPPED_BAR)).toBe(false);
  });

  // NON-VACUITY: the real roster DOES satisfy family F, so the assertions above are about the tail
  // rather than about the roster pattern never matching anything.
  it("…while the real roster, terminating the grid, still does", () => {
    expect(isClaudeCodeScreen(BACKGROUND_TASK_LIST)).toBe(true);
  });

  // The longer document tail is rejected by BOTH readers — the join bound catches it before the
  // split ever matters. Kept so the two mechanisms are visibly separate.
  it("a document that opens its tail with a bar and keeps going is rejected by both", () => {
    const document = [
      "  ◯ general-purpose  Draining roborev findings  3m 04s",
      "⏸ manual mode on · ? for shortcuts",
      "and the row must go green while that is on screen.",
    ].join("\n");
    expect(liveBackgroundSubagentCount(document)).toBeNull();
    expect(isClaudeCodeScreen(document)).toBe(false);
  });
});


// ══ THE CHROME TAIL IS SEGMENTED PER LOGICAL BAR (roborev 68308, High) ═════════════════════════
//
// The bound this replaces was applied to the WHOLE rejoined tail and sized from a bar that is not
// the longest one. Both errors point the same way — toward a FALSE NEGATIVE — and a false negative
// here is the exact bug this surface exists to fix: a narrow pane takes its row GRAY while its
// subagents are visibly listed on it.
//
// These drive `chromeBarTailBelow` itself, and every case is a tail under a real roster row, so
// what is asserted is the thing the row's colour actually depends on.
describe("chromeBarTailBelow — a tail is one or more logical status bars", () => {
  const ROSTER = ["⏺ main", "  ◯ general-purpose  Draining roborev findings  3m 04s"];
  const ROW = 1;
  const tail = (...rows: string[]): boolean => chromeBarTailBelow([...ROSTER, ...rows], ROW);

  const SHORT_BAR = "⏸ manual mode on · ? for shortcuts";
  const LONG_BAR = NON_PICKER_HINT_LINES_2_1_220[0]!;

  // ══ THE GUARD ON THE GUARD (bead sparkle-lmpbuj) ═══════════════════════════════════════════
  //
  // The replaced constant's comment asserted "the longest bar Claude draws is 48 characters" and
  // cited THIS list as its authority. The list's own first entry is 74. A number sized from a
  // measured maximum and then QUOTED in prose cannot notice when the measurement stops being true,
  // which is how a bound shipped that rejected a real, captured, unwrapped bar.
  //
  // The first repair recomputed the maximum here and then asserted only `> 64` against it — the
  // computation was decoration, because the assertion it fed could never fail for the reason the
  // comment claimed it would. Adding a 200-character sample left this green. What follows compares
  // the fixture against the BOUND ITSELF, so a longer sample reds the suite.

  /** The longest single-row tail `chromeBarTailBelow` accepts — MEASURED from the code, not read
   *  off the constant.
   *
   *  ⚠️ DELIBERATELY NOT AN IMPORT. `MAX_BAR_CHARS` is module-private, and exporting it so a test
   *  could compare it against itself would prove nothing (and would strand an export whose only
   *  importer is a test). Probing the real function instead means this measures the bound that is
   *  actually IN FORCE, including anything else in the path that shortens it.
   *
   *  The stem is a real captured bar, so `BAR_OPENS_STRICT` matches the join by construction and
   *  LENGTH is the only thing left that can decide acceptance. Padding is `x` — one segment, so no
   *  continuation row exists for `looksLikeProse` to judge. */
  const MEASURED_BAR_BOUND = ((): number => {
    const base = [...SHORT_BAR].length;
    for (let n = base; n <= 2000; n += 1) {
      if (!tail(SHORT_BAR + "x".repeat(n - base))) return n - 1;
    }
    throw new Error("chromeBarTailBelow accepted a 2000-character bar: the per-bar bound is gone");
  })();

  it("every captured bar clears the bound — the maximum COMPUTED from the fixture, never quoted", () => {
    // A rejected line is not automatically a violation: most entries in this list are hint lines
    // rather than status bars, and the bound never applies to them. Truncating a rejected line to
    // the bound is what separates the two causes. Every `BAR_OPENS_STRICT` pattern is anchored and
    // decides inside the first few words, so truncation cannot destroy a match that was there —
    // which means a truncated line that IS accepted proves the full line is a real bar the LENGTH
    // turned away. That is the failure this test exists to catch.
    const rejectedBars: string[] = [];
    const acceptedBars: string[] = [];
    for (const raw of NON_PICKER_HINT_LINES_2_1_220) {
      const line = raw.trim();
      if (tail(line)) acceptedBars.push(line);
      else if (tail([...line].slice(0, MEASURED_BAR_BOUND).join(""))) rejectedBars.push(line);
    }
    expect(rejectedBars).toEqual([]);
    expect(acceptedBars.length).toBeGreaterThan(0);

    const longestBar = Math.max(...acceptedBars.map((l) => [...l].length));
    expect(longestBar).toBeLessThanOrEqual(MEASURED_BAR_BOUND);
    // …and the number the REPLACED bound used could never have held it. Kept as a computed fact
    // about the past rather than a sentence claiming one.
    expect(longestBar).toBeGreaterThan(64);
  });

  it("no captured hint line ends in a full stop — the OTHER claim this file makes in prose", () => {
    // `looksLikeProse` is justified by "no entry in `capturedScreens.fixture.ts` ends in a full
    // stop". Same class of claim as the one above, same failure mode if a later capture breaks it:
    // the prose-vs-wrapped-fragment split silently stops separating anything.
    expect(NON_PICKER_HINT_LINES_2_1_220.filter((l) => /\.\s*$/.test(l))).toEqual([]);
  });

  it("accepts a short bar — the only shape the previous tests covered", () => {
    expect(tail(SHORT_BAR)).toBe(true);
  });

  it("accepts the real 74-character captured bar, which the 64-char bound REJECTED", () => {
    expect(tail(LONG_BAR)).toBe(true);
  });

  it("accepts TWO stacked bars — MAX_NARROW_CHROME_ROWS exists because there are two of them", () => {
    expect(tail(SHORT_BAR, SHORT_BAR)).toBe(true);
    expect(tail(LONG_BAR, SHORT_BAR)).toBe(true);
  });

  it("accepts a bar WRAPPED across rows, which is why the loose arm exists at all", () => {
    expect(tail("▶▶ bypass", "permissions on", "(shift+tab to", "cycle) · PR", "#730 · esc to", "interrupt")).toBe(true);
  });

  it("still REJECTS a bar followed by prose — the document case the bound was added for", () => {
    expect(tail(SHORT_BAR, "and the row must go green while that is on screen.")).toBe(false);
  });

  it("still REJECTS a tail that opens with an unanchored fragment", () => {
    expect(tail("and the row must go green while that is on screen.", SHORT_BAR)).toBe(false);
  });

  it("still REJECTS one absurdly long run that no real bar reaches", () => {
    expect(tail(`${SHORT_BAR} ${"x".repeat(120)}`)).toBe(false);
  });
});
