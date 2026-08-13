import { describe, it, expect } from "vitest";
import { parseBackgroundTaskCount, hasLiveBackgroundTasks } from "./backgroundTaskFooter";

// The footer wording is verbatim from the shipped claude 2.1.231 binary (` background task(s) live
// [`). These assert the COUNT extracted from a rendered viewport, which is the whole signal the
// green-while-delegating fix rides on (bead sparkle-262p7).

// A realistic idle viewport with the live-background-task footer under the composer box.
const withFooter = (footer: string): string =>
  ["╭───────────────────────────╮", "│ >                         │", "╰───────────────────────────╯", footer].join(
    "\n",
  );

describe("parseBackgroundTaskCount", () => {
  it("reads the singular form", () => {
    expect(parseBackgroundTaskCount(withFooter("1 background task live [ctrl+b to manage]"))).toBe(1);
  });

  it("reads the plural form", () => {
    expect(parseBackgroundTaskCount(withFooter("3 background tasks live [ctrl+b to manage]"))).toBe(3);
  });

  it("tolerates a leading glyph/indent on the footer line", () => {
    expect(parseBackgroundTaskCount(withFooter("  ⏵ 2 background tasks live"))).toBe(2);
  });

  it("returns null when there is no footer (a plain idle screen)", () => {
    expect(parseBackgroundTaskCount(withFooter("? for shortcuts"))).toBeNull();
  });

  it("returns null for an empty screen", () => {
    expect(parseBackgroundTaskCount("")).toBeNull();
  });

  it("normalizes a zero count to null — 0 live tasks is an ABSENCE, not motion", () => {
    expect(parseBackgroundTaskCount(withFooter("0 background tasks live"))).toBeNull();
  });

  it("does NOT match the FOREGROUND running status line (no 'live')", () => {
    // This is the spinner's job, and it carries no "live" — matching it here would double-count a
    // turn that is already green via WORKING_PATTERNS.
    expect(parseBackgroundTaskCount(withFooter("Running 1 shell command… (1m 24s)"))).toBeNull();
  });

  it("takes the last footer when the phrase appears twice (bottom-anchored)", () => {
    const screen = ["1 background task live", "boxed content", "4 background tasks live"].join("\n");
    expect(parseBackgroundTaskCount(screen)).toBe(4);
  });
});

describe("hasLiveBackgroundTasks", () => {
  it("is true when a positive footer is present", () => {
    expect(hasLiveBackgroundTasks(withFooter("2 background tasks live"))).toBe(true);
  });
  it("is false when absent", () => {
    expect(hasLiveBackgroundTasks(withFooter("? for shortcuts"))).toBe(false);
  });
});
