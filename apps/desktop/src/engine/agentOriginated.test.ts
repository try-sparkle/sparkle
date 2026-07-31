import { describe, expect, it } from "vitest";
import {
  GOAL_EXPIRY_PROMPT_MARKER,
  RESUME_PROMPT_MARKER,
  TASK_NOTIFICATION_MARKER,
  isSystemAuthoredPrompt,
} from "./agentOriginated";
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

// THE FIXTURES BELOW ARE REAL, not invented. Each is the opening of an actual record measured in a
// build agent's own `~/.claude/projects/<slug>/*.jsonl` transcripts (agent 61a5332f, 20 newest
// sessions). That matters because the whole family of bugs here is a marker that looks right and
// matches nothing — the auto-resume banner was recognised for a year while three other classes of
// system-authored prompt went straight into the tallies.
//
// Measured distribution of `type:"user"` records that survive the tool_result filter, by prefix:
//
//   29  something a human plausibly typed  ("try again")
//   20  an injected agent prompt           ("You are a code reviewer. Review the code changes…")
//   12  <task-notification>                (a background-task event)
//    3  the auto-resume banner             (already recognised)
//    3  <command-name>                     (a slash command the HUMAN ran)
//    1  the goal-expiry banner
//    1  <command-message>                  (the same slash command, other field order)
describe("the OTHER system-authored prompts — measured, not guessed", () => {
  it("recognises the goal-expiry banner, which no constant in this repo builds", () => {
    // Sparkle's `continuePrompt` is the only resume string this repo authors; THIS one is written
    // outside it (it appears in live transcripts and `grep` finds it nowhere in the tree, including
    // origin/main). So unlike RESUME_PROMPT_MARKER there is no round trip to pin it — the literal
    // IS the contract, which is exactly why it gets a real fixture rather than a paraphrase.
    const real =
      "Your goal expired unmet and you are resting with work unfinished — nothing is coming to " +
      "finish this for you.";
    expect(isSystemAuthoredPrompt(real)).toBe(true);
  });

  it("recognises a background-task notification", () => {
    const real =
      '<task-notification> <task-id>b4shdddfs</task-id> <summary>Monitor event: "CI checks on ' +
      "PR #939 completed</summary></task-notification>";
    expect(isSystemAuthoredPrompt(real)).toBe(true);
  });

  it("applies the same PREFIX discipline to the new markers — a quote is the agent talking", () => {
    // Same rule the auto-resume marker has always had, restated for each new marker so a future
    // change to substring-matching fails here rather than silently suppressing a real loop.
    for (const marker of [GOAL_EXPIRY_PROMPT_MARKER, TASK_NOTIFICATION_MARKER]) {
      expect(isSystemAuthoredPrompt(`why did it say "${marker}"?`)).toBe(false);
    }
  });

  it("tolerates the leading whitespace the PTY write path can add, for every marker", () => {
    for (const marker of [
      RESUME_PROMPT_MARKER,
      GOAL_EXPIRY_PROMPT_MARKER,
      TASK_NOTIFICATION_MARKER,
    ]) {
      expect(isSystemAuthoredPrompt(`\n  ${marker} …`)).toBe(true);
    }
  });
});

describe("what this predicate must NOT swallow — the deliberate exclusions", () => {
  // Every one of these was MEASURED in the same transcripts and deliberately left counting. The
  // module's own asymmetry governs: a false match SUPPRESSES a real loop, which is worse than
  // failing to catch one. So a class only joins the list with evidence that it is system-authored
  // AND that it reaches this predicate at all.

  it("does NOT swallow a slash command — the human ran it, so it is their action", () => {
    // The same rule `nudge-approve` settles: the GESTURE is the origination. A human typing
    // `/compact` three times is a real loop and the existing suite already asserts the bare
    // `/compact` form stays countable — filtering the expanded form would blind the detector to
    // exactly the case it was built for, through the back door.
    const real =
      "<command-name>/compact</command-name>            <command-message>compact</command-message>";
    expect(isSystemAuthoredPrompt(real)).toBe(false);
    expect(
      isSystemAuthoredPrompt("<command-message>goal</command-message> <command-name>/goal</command-name>"),
    ).toBe(false);
  });

  it("does NOT swallow an injected agent prompt — it never reaches this predicate", () => {
    // 20 of these were measured, and they are the biggest single class of non-human records. They
    // are NOT this agent's prompts: they belong to a DIFFERENT `claude` process (roborev) that ran
    // with the same cwd, which is the residual race documented in services/conciergeTools/terminal.ts.
    // They therefore never arrive on this agent's hook stream, so suppressing them here would buy
    // nothing — while "You are a…" is a broad enough opening to catch real prompts. Filtering them
    // is the TRANSCRIPT READER's job, where records carry the session id that tells them apart.
    const real = "You are a code reviewer. Review the code changes shown below.";
    expect(isSystemAuthoredPrompt(real)).toBe(false);
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
