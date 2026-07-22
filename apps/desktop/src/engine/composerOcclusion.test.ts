import { describe, it, expect } from "vitest";
import {
  occludedRowCount,
  classifyOccludedRows,
  shouldAutoYield,
  shouldShowHiddenChip,
  resolveAutoYield,
  bottomRowIndices,
  measuredComposerHeight,
  sameOcclusion,
} from "./composerOcclusion";

// The real shapes Claude Code draws in the live bottom region, mirrored from the fixtures already
// used by screenClassifier.test.ts / statusEngine.test.ts so this stays honest to actual bytes.
const INPUT_BOX = [
  "╭────────────────────────────────────────────────────╮",
  "│ >                                                  │",
  "╰────────────────────────────────────────────────────╯",
  "  ? for shortcuts",
];

const RESUME_MENU = [
  "❯ 1. Resume from summary (recommended)",
  "  2. Resume full session as-is",
  "  3. Don't ask me again",
];

const PERMISSION_BOX = [
  "│ Do you want to make this edit to foo.ts?           │",
  "│ ❯ 1. Yes                                           │",
  "│   2. No, and tell Claude what to do differently    │",
  "╰────────────────────────────────────────────────────╯",
];

describe("occludedRowCount", () => {
  it("converts the composer's pixel height into covered terminal rows", () => {
    // 72px composer over 18px cells = 4 rows fully or partially covered.
    expect(occludedRowCount({ composerHeight: 72, cellHeight: 18, rows: 30 })).toBe(4);
  });

  it("rounds a partially covered row UP (a half-hidden row is still unreadable)", () => {
    expect(occludedRowCount({ composerHeight: 40, cellHeight: 18, rows: 30 })).toBe(3);
  });

  it("subtracts the terminal's bottom inset — the stage pads the terminal above the stage floor", () => {
    // AgentPane wraps the terminal in `padding: 6`, so the composer's first 6px cover padding,
    // not text. 72 - 6 = 66 → ceil(66/18) = 4.
    expect(occludedRowCount({ composerHeight: 72, cellHeight: 18, rows: 30, bottomInset: 6 })).toBe(
      4,
    );
    expect(occludedRowCount({ composerHeight: 24, cellHeight: 18, rows: 30, bottomInset: 6 })).toBe(
      1,
    );
  });

  it("returns 0 for an unmeasured cell height rather than guessing (mirrors terminalSize's guard)", () => {
    expect(occludedRowCount({ composerHeight: 72, cellHeight: 0, rows: 30 })).toBe(0);
    expect(occludedRowCount({ composerHeight: 72, cellHeight: -1, rows: 30 })).toBe(0);
  });

  it("never claims to cover more rows than the terminal has", () => {
    expect(occludedRowCount({ composerHeight: 5000, cellHeight: 18, rows: 30 })).toBe(30);
  });

  it("returns 0 when the composer is minimized to nothing", () => {
    expect(occludedRowCount({ composerHeight: 0, cellHeight: 18, rows: 30 })).toBe(0);
  });
});

describe("bottomRowIndices", () => {
  // xterm buffer indices are absolute (scrollback + screen); viewportY is the buffer index of the
  // TOP visible row. The bottom row on screen is therefore viewportY + rows - 1, NOT buffer.length.
  it("returns the last N on-screen rows for a terminal scrolled to the bottom", () => {
    // viewportY 100, 30 rows → rows occupy 100..129; the last 3 are 127,128,129.
    expect(bottomRowIndices({ viewportY: 100, rows: 30, count: 3 })).toEqual([127, 128, 129]);
  });

  it("follows the VIEWPORT when the user has scrolled back through history", () => {
    // Scrolled up: the composer covers the bottom of what's VISIBLE, not the end of the buffer.
    expect(bottomRowIndices({ viewportY: 10, rows: 30, count: 2 })).toEqual([38, 39]);
  });

  it("returns nothing for a non-positive count", () => {
    expect(bottomRowIndices({ viewportY: 100, rows: 30, count: 0 })).toEqual([]);
    expect(bottomRowIndices({ viewportY: 100, rows: 30, count: -2 })).toEqual([]);
  });

  it("never asks for more rows than the screen has", () => {
    expect(bottomRowIndices({ viewportY: 0, rows: 3, count: 99 })).toEqual([0, 1, 2]);
  });

  it("clamps negative indices away on a screen taller than the buffer so far", () => {
    // Fresh terminal: viewportY 0, 30 rows, asking for 5 — indices must stay >= 0.
    expect(bottomRowIndices({ viewportY: 0, rows: 2, count: 5 })).toEqual([0, 1]);
  });
});

describe("classifyOccludedRows", () => {
  it("reports `empty` when nothing is hidden", () => {
    expect(classifyOccludedRows(["", "   ", ""])).toEqual({ kind: "empty", hiddenLines: 0 });
  });

  it("reports `chrome` for Claude's idle input box — what the composer covers BY DESIGN", () => {
    // This is the whole reason the overlay exists; it must never trigger a chip or a yield.
    expect(classifyOccludedRows(INPUT_BOX)).toEqual({ kind: "chrome", hiddenLines: 0 });
  });

  it("treats a half-typed terminal input line as chrome (the composer covers it deliberately)", () => {
    expect(classifyOccludedRows(["│ > some text I typed in the terminal │"]).kind).toBe("chrome");
  });

  it("treats the working spinner as chrome so the chip stays quiet during a normal turn", () => {
    expect(classifyOccludedRows(["✽ Baked for 2m 24s"]).kind).toBe("chrome");
    expect(classifyOccludedRows(["· Thinking… (esc to interrupt)"]).kind).toBe("chrome");
  });

  it("reports `prompt` for the session-resume menu — the reported bug", () => {
    const got = classifyOccludedRows(RESUME_MENU);
    expect(got.kind).toBe("prompt");
    expect(got.hiddenLines).toBe(3);
  });

  it("reports `prompt` for a bordered permission menu", () => {
    expect(classifyOccludedRows(PERMISSION_BOX).kind).toBe("prompt");
  });

  it("reports `prompt` for a shell (y/n) prompt, not just Claude menus", () => {
    expect(classifyOccludedRows(["Overwrite existing file? (y/n)"]).kind).toBe("prompt");
  });

  it("reports `content` for real hidden text that is not an actionable prompt", () => {
    const got = classifyOccludedRows(["This session is 2d 23h old and 354.1k tokens.", ""]);
    expect(got.kind).toBe("content");
    expect(got.hiddenLines).toBe(1);
  });

  it("counts only the non-chrome lines as hidden", () => {
    const got = classifyOccludedRows([...INPUT_BOX, "a real hidden line"]);
    expect(got.hiddenLines).toBe(1);
  });
});

describe("shouldAutoYield", () => {
  it("yields the composer only for an actionable prompt — precision over recall", () => {
    // A spurious jump is worse than a missed one: the composer moving on its own while the user
    // is mid-sentence is far more disruptive than a chip they can click.
    expect(shouldAutoYield(classifyOccludedRows(RESUME_MENU))).toBe(true);
    expect(shouldAutoYield(classifyOccludedRows(PERMISSION_BOX))).toBe(true);
    expect(shouldAutoYield(classifyOccludedRows(INPUT_BOX))).toBe(false);
    expect(shouldAutoYield(classifyOccludedRows(["This session is 2d 23h old."]))).toBe(false);
    expect(shouldAutoYield(classifyOccludedRows([]))).toBe(false);
  });
});

describe("shouldShowHiddenChip", () => {
  it("shows for any real hidden content — the backstop when auto-yield stays its hand", () => {
    expect(shouldShowHiddenChip(classifyOccludedRows(["This session is 2d 23h old."]))).toBe(true);
    expect(shouldShowHiddenChip(classifyOccludedRows(RESUME_MENU))).toBe(true);
  });

  it("stays quiet for the input box and the spinner, so it isn't noise during normal work", () => {
    expect(shouldShowHiddenChip(classifyOccludedRows(INPUT_BOX))).toBe(false);
    expect(shouldShowHiddenChip(classifyOccludedRows(["✽ Baked for 2m 24s"]))).toBe(false);
    expect(shouldShowHiddenChip(classifyOccludedRows([]))).toBe(false);
  });
});

describe("resolveAutoYield", () => {
  const prompt = classifyOccludedRows(RESUME_MENU);
  const inert = classifyOccludedRows(INPUT_BOX);

  it("minimizes an open composer when a prompt appears underneath it", () => {
    expect(resolveAutoYield({ occlusion: prompt, minimized: false, state: "idle" })).toEqual({
      minimized: true,
      state: "yielded",
    });
  });

  it("restores the composer once the prompt is answered", () => {
    expect(resolveAutoYield({ occlusion: inert, minimized: true, state: "yielded" })).toEqual({
      minimized: false,
      state: "idle",
    });
  });

  it("leaves a composer the USER minimized alone — we only give back what we took", () => {
    // state stays "idle" because we never yielded; restoring here would undo a deliberate choice.
    expect(resolveAutoYield({ occlusion: inert, minimized: true, state: "idle" })).toBeNull();
  });

  it("does nothing when a prompt is showing and the composer is already out of the way", () => {
    expect(resolveAutoYield({ occlusion: prompt, minimized: true, state: "yielded" })).toBeNull();
  });

  it("suppresses re-yielding when the user restores the composer over our yield", () => {
    // The user pulled the composer back up while the prompt is still on screen — they want to type,
    // not answer. Re-minimizing would rip the box away mid-keystroke and loop forever.
    expect(resolveAutoYield({ occlusion: prompt, minimized: false, state: "yielded" })).toEqual({
      minimized: false,
      state: "suppressed",
    });
  });

  it("stays suppressed for as long as that same prompt is up", () => {
    expect(
      resolveAutoYield({ occlusion: prompt, minimized: false, state: "suppressed" }),
    ).toBeNull();
  });

  it("re-arms once the prompt clears, so the NEXT prompt yields again", () => {
    expect(resolveAutoYield({ occlusion: inert, minimized: false, state: "suppressed" })).toEqual({
      minimized: false,
      state: "idle",
    });
    // Re-armed: a fresh prompt now yields.
    expect(resolveAutoYield({ occlusion: prompt, minimized: false, state: "idle" })).toEqual({
      minimized: true,
      state: "yielded",
    });
  });

  it("never yields for merely hidden content — only for something to answer", () => {
    const content = classifyOccludedRows(["This session is 2d 23h old."]);
    expect(resolveAutoYield({ occlusion: content, minimized: false, state: "idle" })).toBeNull();
  });
});

// Regression: the yield must be latched on whether the prompt would STILL be covered if the
// composer were open — not on what the slim bar happens to cover once we've already moved. Measured
// naively, minimizing succeeds (prompt revealed) → the covered rows no longer hold the prompt →
// "prompt resolved" → restore → prompt re-covered → yield again, at the 250ms poll rate. That
// oscillation is the exact "fight the user in a loop" failure this module exists to prevent.
describe("measuredComposerHeight (oscillation latch)", () => {
  const OPEN = 72;
  const BAR = 22;

  it("measures the open height while yielded, so a REVEALED prompt still counts as covered", () => {
    expect(
      measuredComposerHeight({ minimized: true, openHeight: OPEN, barHeight: BAR, state: "yielded" }),
    ).toBe(OPEN);
  });

  it("measures what is actually covered when we have not yielded", () => {
    expect(
      measuredComposerHeight({ minimized: true, openHeight: OPEN, barHeight: BAR, state: "idle" }),
    ).toBe(BAR);
    expect(
      measuredComposerHeight({ minimized: false, openHeight: OPEN, barHeight: BAR, state: "idle" }),
    ).toBe(OPEN);
    // Suppressed means hands-off; measure reality, not the hypothetical.
    expect(
      measuredComposerHeight({ minimized: true, openHeight: OPEN, barHeight: BAR, state: "suppressed" }),
    ).toBe(BAR);
  });

  it("does not oscillate: a revealed-but-unanswered prompt stays yielded across ticks", () => {
    // Full-fidelity replay of the sampling loop against a fixed screen whose LAST 4 rows are the
    // menu. Row height 18px, 6px stage padding — the real geometry.
    const screen = ["...scrollback...", ...RESUME_MENU, "  (nothing below)"];
    const readBottom = (n: number) => (n <= 0 ? [] : screen.slice(Math.max(0, screen.length - n)));

    let minimized = false;
    let state: import("./composerOcclusion").YieldState = "idle";
    const seen: boolean[] = [];

    for (let tick = 0; tick < 8; tick++) {
      const h = measuredComposerHeight({
        minimized,
        openHeight: OPEN,
        barHeight: BAR,
        state,
      });
      const covered = occludedRowCount({
        composerHeight: h,
        cellHeight: 18,
        rows: 30,
        bottomInset: 6,
      });
      const move = resolveAutoYield({
        occlusion: classifyOccludedRows(readBottom(covered)),
        minimized,
        state,
      });
      if (move) {
        minimized = move.minimized;
        state = move.state;
      }
      seen.push(minimized);
    }

    // Yields once on the first tick, then holds — no flapping while the prompt is unanswered.
    expect(seen).toEqual([true, true, true, true, true, true, true, true]);
    expect(state).toBe("yielded");
  });
});

describe("sameOcclusion", () => {
  it("treats two classifications of the same screen as equal despite fresh object identity", () => {
    const a = classifyOccludedRows(INPUT_BOX);
    const b = classifyOccludedRows(INPUT_BOX);
    expect(a).not.toBe(b); // the allocation that drove the render loop
    expect(sameOcclusion(a, b)).toBe(true);
  });

  it("separates verdicts that differ in kind or in hidden-line count", () => {
    expect(sameOcclusion(classifyOccludedRows(INPUT_BOX), classifyOccludedRows([]))).toBe(false);
    // A menu appearing over what was an idle input box: the transition the poll exists to catch.
    expect(
      sameOcclusion(classifyOccludedRows(INPUT_BOX), classifyOccludedRows(PERMISSION_BOX)),
    ).toBe(false);
    // Same kind, different count — the chip's number changed, so the render must happen.
    expect(
      sameOcclusion(classifyOccludedRows(RESUME_MENU), classifyOccludedRows(RESUME_MENU.slice(1))),
    ).toBe(false);
    expect(sameOcclusion({ kind: "content", hiddenLines: 2 }, { kind: "content", hiddenLines: 3 })).toBe(
      false,
    );
  });

  it("holds the first object across a steady poll, so an idle screen stops re-rendering the pane", () => {
    // What the poll actually does: re-classify an unchanging screen every OCCLUSION_POLL_MS and
    // keep `prev` whenever the verdict matches. Identity must survive all 20 ticks — each change
    // of identity is one full AgentPane render.
    let stored = classifyOccludedRows(INPUT_BOX);
    const first = stored;
    let writes = 0;
    for (let i = 0; i < 20; i++) {
      const next = classifyOccludedRows(INPUT_BOX);
      if (!sameOcclusion(stored, next)) {
        stored = next;
        writes++;
      }
    }
    expect(writes).toBe(0);
    expect(stored).toBe(first);
  });
});
