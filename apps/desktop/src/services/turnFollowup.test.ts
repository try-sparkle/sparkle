import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { mightNeedFollowup, interpretVerdict, judgeNeedsFollowup } from "./turnFollowup";

describe("mightNeedFollowup (local fast-path)", () => {
  it("skips a plain completion report with no question or proposal", () => {
    expect(
      mightNeedFollowup(
        "Done. Here's the consolidated outcome. I built the L-shaped card, removed the tooltip, and verified the suite is 1123 passing.",
      ),
    ).toBe(false);
  });

  it("flags a turn that ends with a question (real screenshots: 'land it now?')", () => {
    expect(
      mightNeedFollowup(
        "One thing stands between you and a notarized DMG. The pipeline has to be landed on main first. Want me to land it now?",
      ),
    ).toBe(true);
  });

  it("flags an explicit hand-back proposal even without a question mark", () => {
    expect(
      mightNeedFollowup("All secrets are in. Say the word and I'll land it and cut the release."),
    ).toBe(true);
  });

  it("flags a no-question ask via a kept high-signal phrase ('waiting on you')", () => {
    expect(
      mightNeedFollowup(
        "Neither diagnostic has fired yet — I'm waiting on you to run the terminal test in the live app.",
      ),
    ).toBe(true);
  });

  it("the real screenshot-1 ask (mixes a question into the body) still triggers via '?'", () => {
    expect(
      mightNeedFollowup(
        "I need two quick things from you in the live app. B) Naming: is it the agent you're talking to me through, or a separate build agent you created? Once you've done either, say 'done'.",
      ),
    ).toBe(true);
  });

  it("does NOT bill a judge call on a generic courtesy close ('let me know if you'd like…')", () => {
    // The lowest-signal courtesies are deliberately excluded from the pre-filter — they flood
    // genuinely-done turns. A plain report that ends with one stays gray with no model call.
    expect(
      mightNeedFollowup(
        "All committed and the suite is green. Let me know if you'd like anything else.",
      ),
    ).toBe(false);
  });

  it("does NOT fire on a question buried in the body when the tail is a clean report", () => {
    const lead = "Earlier I wondered: should we cache this? ";
    const body = "I cached it and verified the whole flow works end to end. ".repeat(40);
    const tail = "Verification: tsc clean, full suite passing. All committed.";
    expect(mightNeedFollowup(lead + body + tail)).toBe(false);
  });

  it("returns false for empty / whitespace", () => {
    expect(mightNeedFollowup("")).toBe(false);
    expect(mightNeedFollowup("   \n  ")).toBe(false);
  });
});

describe("interpretVerdict", () => {
  it("treats FOLLOWUP as needs-followup", () => {
    expect(interpretVerdict("FOLLOWUP")).toBe(true);
    expect(interpretVerdict(" followup \n")).toBe(true);
  });

  it("treats DONE (or anything not FOLLOWUP) as done", () => {
    expect(interpretVerdict("DONE")).toBe(false);
    expect(interpretVerdict("done.")).toBe(false);
  });

  it("treats an empty / garbled reply as done (degrade to gray)", () => {
    expect(interpretVerdict("")).toBe(false);
    expect(interpretVerdict("   ")).toBe(false);
  });

  it("matches FOLLOWUP even when the model adds chatter", () => {
    expect(interpretVerdict("Verdict: FOLLOWUP — it's asking to land")).toBe(true);
  });

  it("lets an explicit DONE win over an incidental 'followup' mention (no false red)", () => {
    expect(interpretVerdict("Not a followup — DONE")).toBe(false);
    expect(interpretVerdict("DONE (this is not a followup)")).toBe(false);
  });
});

describe("judgeNeedsFollowup (orchestration)", () => {
  beforeEach(() => invokeMock.mockReset());

  it("short-circuits on the local fast-path without calling the backend", async () => {
    const result = await judgeNeedsFollowup({
      task: "Fix the login loop",
      response: "Done. Fixed the loop and verified the suite passes.",
    });
    expect(result).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("calls the judge for an ambiguous turn and returns its verdict", async () => {
    invokeMock.mockResolvedValueOnce("FOLLOWUP");
    const result = await judgeNeedsFollowup({
      task: "Ship the release",
      response: "All secrets are in. Want me to land it now?",
    });
    expect(result).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("judge_turn_followup", {
      task: "Ship the release",
      response: "All secrets are in. Want me to land it now?",
    });
  });

  it("returns false when the judge says DONE", async () => {
    invokeMock.mockResolvedValueOnce("DONE");
    const result = await judgeNeedsFollowup({
      task: "Ship the release",
      response: "Shipped. Want me to also write release notes?",
    });
    expect(result).toBe(false);
  });

  it("degrades to gray (false) when the backend throws — never a false red", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no API key"));
    const result = await judgeNeedsFollowup({
      task: "Ship the release",
      response: "Want me to land it now?",
    });
    expect(result).toBe(false);
  });
});
