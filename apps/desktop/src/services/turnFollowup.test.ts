import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import {
  mightNeedFollowup,
  classifyFollowupSignal,
  interpretVerdict,
  judgeNeedsFollowup,
} from "./turnFollowup";

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

describe("classifyFollowupSignal (fast-path strength)", () => {
  it("classifies a plain completion report as 'none'", () => {
    expect(
      classifyFollowupSignal("Done. Built the card, removed the tooltip, suite is 1123 passing."),
    ).toBe("none");
  });

  it("classifies a concrete action-proposal ('want me to land it?') as 'strong'", () => {
    expect(classifyFollowupSignal("All secrets are in. Want me to land it now?")).toBe("strong");
  });

  it("classifies a whole-message gate ('for your sign-off') as 'strong'", () => {
    const msg =
      "It looks ready for your sign-off. " +
      "It merges every window's roster into one. ".repeat(30) +
      "Once you approve, I'll write the spec.";
    expect(classifyFollowupSignal(msg)).toBe("strong");
  });

  it("classifies an open-ended 'what would you like to pick up next?' recap as 'weak' (real screenshot-1)", () => {
    // The exact false-red the user reported: a status recap that finished the task and asks,
    // open-endedly, what to do next. Bare trailing '?' with NO proposal/gating phrase → weak.
    expect(
      classifyFollowupSignal(
        "So: nothing in flight, nothing stuck, and no findings waiting on you. What would you like to pick up next?",
      ),
    ).toBe("weak");
  });

  it("does NOT treat the negated 'nothing waiting on you' recap as a strong ask", () => {
    // The benign inverse of a real "waiting on you" ask — the substring matches, but it's negated,
    // so the waiting-family guard must keep it out of 'strong'. Only the bare '?' remains → weak.
    expect(classifyFollowupSignal("Nothing is waiting on you right now. What's next?")).toBe("weak");
    expect(classifyFollowupSignal("There are no findings waiting on you. All clear.")).toBe("none");
  });

  it("still treats a genuine 'I'm waiting on you to run it' ask as 'strong'", () => {
    expect(
      classifyFollowupSignal(
        "Neither diagnostic has fired yet — I'm waiting on you to run the terminal test in the live app.",
      ),
    ).toBe("strong");
  });

  it("lets a genuine first-person ask win over a negator earlier in the SAME sentence (roborev #1)", () => {
    // "nothing … waiting on you" substring is present AND unbroken by punctuation, but the real
    // subject is "I'm" — a genuine hand-back. GENUINE must beat NEGATED so this stays red.
    expect(
      classifyFollowupSignal("There's nothing else for me to do until you run it — I'm waiting on you."),
    ).toBe("strong");
  });

  it("keeps a genuine ask strong when a negator sits in a PRIOR sentence (sentence-boundary guard)", () => {
    // The '.' after "failed" blocks NEGATED_WAITING_RE from reaching back to "Nothing"; the ask is
    // its own sentence. Load-bearing behavior of the [^.?!\\n] sentence scope.
    expect(classifyFollowupSignal("Nothing failed. I'm waiting on you to run it.")).toBe("strong");
  });

  it("does NOT fire GENUINE when a first-person token heads a DIFFERENT verb (roborev #44374)", () => {
    // "I'm" governs "glad", not "waiting" — immediate governance must be required so this benign
    // "nothing is waiting on you" recap is not forced strong. No '?' → none.
    expect(classifyFollowupSignal("I'm glad nothing is waiting on you.")).toBe("none");
    // "still" as an adverb after a negator is NOT a genuine subject.
    expect(classifyFollowupSignal("There's nothing still waiting on you.")).toBe("none");
  });

  it("recognizes the 'I've been waiting on you' contraction as genuine, even past a negator (roborev #44378)", () => {
    // 've + been must be in the genuine copula/adverb groups, so this beats the "nothing" negator.
    expect(
      classifyFollowupSignal("Nothing else blocked me — I've been waiting on you to run it."),
    ).toBe("strong");
  });

  it("judges only the CLOSING waiting phrase, not an earlier genuine one (multi-occurrence, roborev #44374)", () => {
    // A genuine "I'm waiting on you to review" earlier, but the turn CLOSES on a benign "nothing is
    // waiting on you". Only the closing sentence is judged → benign → not strong (bare '?' → weak).
    expect(
      classifyFollowupSignal(
        "I'm waiting on you to review the plan. But right now nothing is waiting on you — what next?",
      ),
    ).toBe("weak");
  });

  it("suppresses a benign 'waiting on you' even when the negator falls OUTSIDE the 600-char tail (roborev #2)", () => {
    // One long sentence whose ONLY negator ("Nothing") sits far above the 600-char tail; the filler
    // in between is deliberately negator-free, and the phrase "waiting on you" closes the turn. A
    // tail-only negation scan would miss "Nothing" and wrongly go strong (a false red on a long
    // recap); scanning NEGATED over the WHOLE message catches it → weak.
    const filler = "the queue is clear and every branch is green and the roster is calm, ".repeat(12);
    const msg = "Nothing is pending — " + filler + "and the board is waiting on you? ";
    expect(msg.length).toBeGreaterThan(700); // "Nothing" is well beyond TAIL_CHARS (600) from the tail
    expect(classifyFollowupSignal(msg)).toBe("weak"); // bare '?' remains → weak, not strong
  });

  it("treats a proposal phrase in the tail as 'strong' even though the turn also ends in '?'", () => {
    // "want me to" must win over the bare '?' so the release-land ask stays strong (keyless red).
    expect(classifyFollowupSignal("Ready. Want me to land it and cut the release?")).toBe("strong");
  });

  it("classifies empty / whitespace as 'none'", () => {
    expect(classifyFollowupSignal("")).toBe("none");
    expect(classifyFollowupSignal("   \n ")).toBe("none");
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

  it("FAILS OPEN to gray when the judge can't run on a WEAK (open-ended '?') recap (real screenshot-1)", async () => {
    // The user's reported false-red: a finished status recap ending "What would you like to pick up
    // next?" — a bare '?' with no proposal/gating phrase. mightNeedFollowup still flags it (consult
    // the judge), but with no key the judge throws, and a WEAK signal must fall OPEN to gray rather
    // than manufacture a red on a turn the user isn't actually being asked to unblock.
    invokeMock.mockRejectedValueOnce(new Error("no Anthropic API key"));
    const result = await judgeNeedsFollowup({
      task: "Give me a brief status update",
      response:
        "So: nothing in flight, nothing stuck, and no findings waiting on you. What would you like to pick up next?",
    });
    expect(result).toBe(false);
    expect(invokeMock).toHaveBeenCalled(); // it DID consult the judge; only the fallback grays it
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
