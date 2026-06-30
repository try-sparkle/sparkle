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

  it("flags a sign-off ask buried above a long forward-looking tail (real screenshot-2: 'for your sign-off' / 'Once you confirm…')", () => {
    // The Menu-Bar Agent Monitor design: the ask sits near the TOP ("present it in sections for
    // your sign-off", "Does this overall shape look right…?"), then a long tail enumerates the
    // work still to come, pushing the question out of TAIL_CHARS. The whole-message GATING scan
    // ("for your sign-off" / "Once you confirm…") must still take this red. (tune-coloring)
    const msg =
      "I have everything I need to design this. Let me present it in sections for your sign-off.\n\n" +
      "Design — Sparkle Menu-Bar Agent Monitor\n\n" +
      "A new macOS menu-bar extra plus a borderless popover window that mirrors the mobile " +
      "Dashboard. " +
      "Does this overall shape look right before I detail the pieces?\n\n" +
      "Once you confirm, the remaining sections I'll lay out are: (2) the menu-bar image rendering " +
      "+ counts, (3) the popover window (positioning, show/hide-on-blur, capabilities), (4) the " +
      "mobile-faithful panel UI reusing the existing desktop StatusDot/workflow/elapsed pieces, " +
      "and (5) the cross-window aggregation + click-to-open flow and how I'll test each layer.";
    expect(mightNeedFollowup(msg)).toBe(true);
  });

  it("flags a gated hand-back even when the tail is a pure work-to-come list with no '?'", () => {
    const lead = "Here's the architecture. ";
    const body = "It merges every window's roster slice into one global roster. ".repeat(30);
    // Tail has NO question mark and NO tail proposal phrase — only the gating phrase up top saves it.
    const tail = "Once you approve, I'll detail sections two through five and write the spec.";
    expect(mightNeedFollowup("It looks ready for your sign-off. " + lead + body + tail)).toBe(true);
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

  it("FAILS CLOSED to waiting when the judge can't run (no key/offline) on an ask (sparkle-blpf)", async () => {
    // The norm for every user without a BYOK judge key: the judge throws, but the fast-path matched
    // (the turn ends with a '?'), so we escalate to red rather than silently swallow the ask to gray.
    invokeMock.mockRejectedValueOnce(new Error("no Anthropic API key"));
    const result = await judgeNeedsFollowup({
      task: "Ship the release",
      response: "Want me to land it now?",
    });
    expect(result).toBe(true);
  });

  it("still stays gray when the judge can't run on a turn the fast-path did NOT flag", async () => {
    // No '?' / proposal in the tail → mightNeedFollowup is false → we never call (or trust) the
    // judge, so a plain completion report stays gray even with no key.
    const result = await judgeNeedsFollowup({
      task: "Ship the release",
      response: "Done. Shipped and verified the suite passes.",
    });
    expect(result).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
