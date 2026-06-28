// formatElapsed: the pure helper behind the sidebar row's "elapsed since last prompt" timer.
// Integer seconds under 100s, then minutes / hours / days each to one decimal with a trailing
// ".0" stripped. Mock the Tauri opener so importing the component module doesn't fail in node.
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

import { formatElapsed } from "./AgentSidebar";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("formatElapsed", () => {
  it("shows integer seconds under 100s", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(1 * SEC)).toBe("1s");
    expect(formatElapsed(99 * SEC)).toBe("99s");
    expect(formatElapsed(99.9 * SEC)).toBe("99s"); // floors, never rounds up to 100s
  });

  it("switches to minutes (1dp, .0 stripped) from 100s through <100min", () => {
    expect(formatElapsed(102 * SEC)).toBe("1.7m");
    expect(formatElapsed(120 * SEC)).toBe("2m"); // 2.0m → "2m"
    expect(formatElapsed(90 * MIN)).toBe("90m");
  });

  it("switches to hours (1dp, .0 stripped) from 100min through <24h", () => {
    expect(formatElapsed(100 * MIN)).toBe("1.7h"); // 6,000,000ms
    expect(formatElapsed(2 * HOUR)).toBe("2h");
  });

  it("switches to days (1dp, .0 stripped) at 24h and beyond", () => {
    expect(formatElapsed(24 * HOUR)).toBe("1d"); // 86,400,000ms → "1d"
    expect(formatElapsed(25 * HOUR)).toBe("1d"); // 90,000,000ms → 1.04d → "1d"
    expect(formatElapsed(2.5 * DAY)).toBe("2.5d");
  });
});
