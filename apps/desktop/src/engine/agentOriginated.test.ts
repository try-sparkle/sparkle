import { describe, expect, it } from "vitest";
import { RESUME_PROMPT_MARKER, isSystemAuthoredPrompt } from "./agentOriginated";
import type { AgentGoal } from "./agentGoal";
import { continuePrompt } from "./goalContinuation";
import { isHumanAuthored } from "../services/dispatchAuthority";

const goal = (text: string): AgentGoal => ({
  text,
  setAt: 0,
  ttlMs: 4 * 3_600_000,
  continues: 0,
  totalContinues: 0,
});

describe("the round trip — the sender and the recogniser cannot drift apart", () => {
  // THE ANTI-DRIFT GUARD, and the reason this module can safely match on text at all. The detector
  // recognises Sparkle's own send by its opening; if `continuePrompt` were reworded without this
  // constant (or vice versa) the detector would go silently blind and the 2026-07-30 false positive
  // would come straight back — a badge saying "It is looping, not working" over an agent that is
  // working. This test fails instead.
  it("recognises the REAL continuePrompt output, not an approximation of it", () => {
    expect(isSystemAuthoredPrompt(continuePrompt(goal("land the retry PR")))).toBe(true);
  });

  it("recognises it whatever the goal text is — the marker is the invariant prefix", () => {
    for (const text of ["a", "ship the thing", "GOAL: nested goal text", RESUME_PROMPT_MARKER]) {
      expect(isSystemAuthoredPrompt(continuePrompt(goal(text)))).toBe(true);
    }
  });

  it("still recognises a payload truncated after the marker — older hook logs elide", () => {
    expect(isSystemAuthoredPrompt(`${RESUME_PROMPT_MARKER}...`)).toBe(true);
  });

  it("tolerates the leading whitespace the PTY write path can add", () => {
    expect(isSystemAuthoredPrompt(`\n  ${continuePrompt(goal("x"))}`)).toBe(true);
  });
});

describe("ONE definition — this module and dispatchAuthority must not drift apart", () => {
  // The two halves of the same fact, known at different moments. `isHumanAuthored` decides it at
  // SEND time from the authority; this module recovers it at DETECT time from the text, because the
  // hook stream does not carry the authority. If they ever disagree, one of the two detectors is
  // acting on a different notion of "the agent did this" than the other — which is precisely the
  // seam the 2026-07-30 false positive came through.
  it("agrees with isHumanAuthored that a goal-continue is not the human's words", () => {
    expect(isHumanAuthored({ kind: "goal-continue", agentId: "a" })).toBe(false);
    expect(isSystemAuthoredPrompt(continuePrompt(goal("x")))).toBe(true);
  });

  it("agrees that a nudge-approve IS the human's — the click is the origination", () => {
    // Both must let it through: a human clicking Approve three times is a real action carrying real
    // information, and suppressing it would blind the loop detector to a genuine case.
    expect(isHumanAuthored({ kind: "nudge-approve", agentId: "a" })).toBe(true);
    expect(isSystemAuthoredPrompt("approve")).toBe(false);
  });
});

describe("what is NOT system-authored", () => {
  // The cost of a false match here is SUPPRESSING a real loop, which is worse than failing to catch
  // one — so the match has to stay tight. Each of these is something a human or an agent actually
  // originated, and every one must keep counting.
  it.each([
    ["a human typing continue", "continue"],
    ["the observed /compact loop", "/compact"],
    ["a human paraphrasing the banner", "your turn ended, keep going"],
    ["prose that merely mentions resuming", "I am being resumed automatically, apparently"],
    ["the nudge-card approve (a human clicked it)", "approve"],
    ["empty", ""],
  ])("%s is not system-authored", (_label, text) => {
    expect(isSystemAuthoredPrompt(text)).toBe(false);
  });

  it("does not match the marker appearing MID-prompt — an agent quoting it is the agent talking", () => {
    // e.g. an agent asking the concierge about the banner it just received. That is an agent action
    // and carries real information; only a prompt that BEGINS with the marker is Sparkle's own send.
    expect(isSystemAuthoredPrompt(`why does it say "${RESUME_PROMPT_MARKER} automatically"?`)).toBe(
      false,
    );
  });
});
