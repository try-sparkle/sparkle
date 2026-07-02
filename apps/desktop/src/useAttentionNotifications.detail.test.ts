import { describe, it, expect } from "vitest";
import { truncateDetail, DETAIL_MAX } from "./useAttentionNotifications";

// truncateDetail produces the `detail` field the desktop relays to the phone: the exact terminal
// text that triggered the attention, capped and tail-preserved (the trigger sits at the bottom).
describe("truncateDetail", () => {
  it("passes a short snapshot through unchanged (only trailing blank lines trimmed)", () => {
    const screen = "● Bash(rm -rf build)\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No";
    expect(truncateDetail(screen)).toBe(screen);
  });

  it("strips the trailing blank-line padding a terminal snapshot leaves", () => {
    expect(truncateDetail("Proceed?\n❯ 1. Yes\n\n   \n\n")).toBe("Proceed?\n❯ 1. Yes");
  });

  it("keeps the TAIL when longer than the cap (the trigger is at the bottom)", () => {
    const raw = "HEAD-" + "x".repeat(DETAIL_MAX) + "-TAIL";
    const out = truncateDetail(raw);
    expect(out.startsWith("…\n")).toBe(true);
    expect(out.endsWith("-TAIL")).toBe(true);
    expect(out).not.toContain("HEAD-");
    // ellipsis marker + exactly the last DETAIL_MAX chars.
    expect(out.length).toBe(DETAIL_MAX + 2);
  });

  it("returns empty string for empty input (send site omits the field)", () => {
    expect(truncateDetail("")).toBe("");
    expect(truncateDetail("\n\n  \n")).toBe("");
  });
});
