import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GOAL_EXPIRY_PROMPT_MARKER,
  NUDGE_PROMPT_MARKER,
  EPIC_RESUME_PROMPT_MARKER,
  RESUME_PROMPT_MARKER,
  TASK_NOTIFICATION_MARKER,
  isSystemAuthoredPrompt,
} from "./agentOriginated";
import type { AgentGoal } from "./agentGoal";
import { continuePrompt } from "./goalContinuation";
import { isHumanAuthored } from "../services/dispatchAuthority";
import { resumeInstruction } from "../services/sendToBuild";

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

  // Sparkle BUILDS this one too, so it gets the same anti-drift round trip as `continuePrompt`
  // rather than a copied literal. It matters more here than almost anywhere: the epic sweep only
  // ever writes this to an agent already suspected of being stuck, so if the detector went blind
  // Sparkle's own prose would be counted as that agent's activity — progress it did not make, and,
  // on a second restart, a `repeating-command` verdict earned entirely by Sparkle repeating itself.
  it("recognises the REAL epic-sweep resume instruction, not an approximation of it", () => {
    expect(
      isSystemAuthoredPrompt(
        resumeInstruction({ projectId: "p1", epicId: "sparkle-e1", prdPath: "PRD/plan.md" }),
      ),
    ).toBe(true);
  });

  it("recognises it for a PRD-less epic too — both wordings share the prefix", () => {
    expect(
      isSystemAuthoredPrompt(
        resumeInstruction({ projectId: "p1", epicId: "sparkle-e1", prdPath: null }),
      ),
    ).toBe(true);
  });

  // ── THE NEGATIVE THAT MATTERS MOST ────────────────────────────────────────────────────────────
  // The tests above only prove the marker matches OUR output. On its own that is satisfied by a
  // marker so broad it also matches the founder's. This is the case that forbids it.
  it("does NOT suppress a HUMAN who types the same instruction in their own words", () => {
    // The notice and the audit note both name the epic id, so this is the natural reply to compose
    // into that agent's box — which is exactly why a bare "Resume epic " prefix was unsafe. A false
    // match SUPPRESSES a real turn from both tallies: it stops counting as progress (so a
    // genuinely-worked agent reads as stalled and gets auto-restarted) and stops counting as a
    // command in the thrash detector. That is the expensive direction of this module's trade.
    for (const human of [
      "Resume epic sparkle-e1",
      "Resume epic sparkle-e1 — the PRD is at PRD/plan.md",
      "resume epic sparkle-e1 please",
    ]) {
      expect(isSystemAuthoredPrompt(human)).toBe(false);
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
      NUDGE_PROMPT_MARKER,
      EPIC_RESUME_PROMPT_MARKER,
    ]) {
      expect(isSystemAuthoredPrompt(`\n  ${marker} …`)).toBe(true);
    }
  });
});

// ── THE NUDGE (bead sparkle-hpbkw) ───────────────────────────────────────────────────────────────
//
// The founder, 2026-08-09: *"Why are agents like @Preview Work In A Browser and @Typing Never
// Wedges red dots? they don't seem to be blocked by me"*. He was right about the second one for
// this exact reason.
//
// Agent 6d644864 read status `waiting`, `needsYou` TRUE, goal `met` — and thrash `repeating-command`,
// because it had submitted SPARKLE'S OWN AUTOMATED PING four times in a row. The app nudged it, the
// nudge produced no progress, the app nudged again, and the resulting wedge was reported to the
// founder as though HE were the blocker. He was not. The nudger was arguing with itself.
//
// This is the module's own stated failure mode, third instance — see the header's "A status surface
// asserting a conclusion it never observed is the bug." Consecutive nudges are byte-identical BY
// CONSTRUCTION (the text is a pure function of a counter and a duration), so three of them trip
// REPEAT_LIMIT with no agent behaviour involved at all.
describe("the NUDGE — Sparkle's own automated ping is not the agent talking", () => {
  // WHAT THE FOUNDER QUOTED, and no more than that. His message elided the tail ("Resume your
  // goal..."), so anything past the ellipsis would be INVENTED — and an earlier draft of this file
  // invented it, reconstructing a five-token reply list that the shipping `nudge_text` has not
  // emitted since bead sparkle-afi6u added `blocked-on-another-agent` and changed the closing
  // clause. It passed anyway, because the predicate matches a 16-character prefix.
  //
  // That is worth more than a corrected string: a fixture labelled "real" that the app cannot emit
  // is a trap for the next person, who reaches for it to build a reply-parsing or truncation test
  // and pins behaviour against a message that does not exist. So this fixture is now only the part
  // actually observed, and the full frame is asserted against the Rust source below rather than
  // retyped here.
  const FOUNDER_QUOTED =
    "[sparkle-nudge #1 · no output for 4m 5s] Automated ping, not a new task. Resume your goal...";

  it("recognises the ping the founder actually saw", () => {
    expect(isSystemAuthoredPrompt(FOUNDER_QUOTED)).toBe(true);
  });

  it("recognises it at every rung — the counter and the duration both vary", () => {
    for (const line of [
      "[sparkle-nudge #1 · no output for 4m 5s] Automated ping, not a new task.",
      "[sparkle-nudge #3 · no output for 15m] Automated ping, not a new task.",
      "[sparkle-nudge #14 · no output for 2h 30m] Automated ping, not a new task.",
    ]) {
      expect(isSystemAuthoredPrompt(line)).toBe(true);
    }
  });

  it("still recognises a payload truncated mid-line — the hook log elides long prompts", () => {
    // Measured shape: nudge_ladder.rs's own test fixture truncates at exactly this point.
    expect(
      isSystemAuthoredPrompt("[sparkle-nudge #4 · no output for 10m] Automated ping, not a"),
    ).toBe(true);
  });

  it("applies the PREFIX discipline — an agent QUOTING the ping is the agent talking", () => {
    expect(isSystemAuthoredPrompt(`why did I get "${NUDGE_PROMPT_MARKER}1 …]"?`)).toBe(false);
  });

  // THE CROSS-LANGUAGE PIN, and the reason this marker needs one where the resume marker does not.
  //
  // `RESUME_PROMPT_MARKER` is safe because `continuePrompt` BUILDS from it — one string, round
  // -tripped by the first describe block above. This marker has no such luck: the authoring side is
  // RUST (`nudge_ladder.rs`), so the two literals live in different languages, in different test
  // suites, that cannot see each other. That is precisely the seam AGENTS.md warns about — both
  // suites green, the merge textually clean, and the feature inert forever because the recogniser is
  // matching a string nobody sends any more.
  //
  // So: read the Rust source and assert the two agree. A reword on either side fails HERE.
  it("agrees, character for character, with the Rust literal that authors the ping", () => {
    const rs = nudgeLadderSource();
    const decl = /const\s+NUDGE_MARKER:\s*&str\s*=\s*"((?:[^"\\]|\\.)*)"\s*;/.exec(rs);
    // A miss here means the declaration was renamed or restyled — fail loudly rather than silently
    // skip the comparison, which would make this test vacuous exactly when it is needed.
    expect(decl, "could not find `const NUDGE_MARKER: &str = \"…\";` in nudge_ladder.rs").not.toBe(
      null,
    );
    expect(decl?.[1]).toBe(NUDGE_PROMPT_MARKER);
  });

  it("recognises the ping REBUILT from the Rust format string, not a retyped copy of it", () => {
    // ⚠️ THIS TEST USED TO PROVE ALMOST NOTHING, and the way it failed is worth keeping. It took
    // `split("{")[0]` of the format string — but the first `{` sits immediately after `#`, so the
    // "fixed prefix" it recovered was exactly `NUDGE_PROMPT_MARKER` and the assertion was a
    // duplicate of the test above it, with the interesting half of the line hand-written. The
    // comment claimed it was "about the SENT bytes"; it was about the same 16 characters.
    //
    // Now it actually reconstructs `nudge_text`'s output: un-continue the Rust string literal,
    // substitute the two placeholders, and assert the predicate accepts the RESULT. So a reword
    // anywhere in the frame — not just its opening — reaches this file.
    const nudgeText = rustNudgeText(7, "9m");
    expect(isSystemAuthoredPrompt(nudgeText)).toBe(true);

    // And the frame really is the whole message, not a prefix that happens to match: these are the
    // segments a reader of `nudge_ladder.rs` would recognise, asserted so a rewrite that keeps the
    // marker but guts the sentence still fails here.
    expect(nudgeText).toContain("· no output for 9m]");
    expect(nudgeText).toContain("Automated ping, not a new task.");
    expect(nudgeText).toContain("Resume your goal.");
    // The reply vocabulary the ladder's own `parse_reply` searches for. `blocked-on-another-agent`
    // is in this list because bead sparkle-afi6u added it; a fixture retyped from memory omitted it
    // for a while and nothing noticed, which is exactly what this assertion is for.
    for (const token of [
      "blocked-on-human",
      "blocked-on-ci",
      "blocked-on-another-agent",
      "blocked-on-quota",
      "not-blocked",
    ]) {
      expect(nudgeText, `nudge_text must still offer "${token}"`).toContain(token);
    }
  });
});

/** Read `nudge_ladder.rs` once. */
function nudgeLadderSource(): string {
  return readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/nudge_ladder.rs"),
    "utf8",
  );
}

/**
 * Rebuild what `nudge_ladder.rs::nudge_text(n, …)` writes, from the Rust source itself.
 *
 * Rust's `format!` literal is split across lines with `\` continuations, which swallow the newline
 * AND the leading whitespace of the next line — so the reconstruction has to do the same, or every
 * assertion against the result is really an assertion about the source file's indentation.
 */
function rustNudgeText(n: number, duration: string): string {
  const rs = nudgeLadderSource();
  const fmt = /"(\[sparkle-nudge #\{n\}(?:[^"\\]|\\[\s\S])*)"/.exec(rs);
  expect(fmt, "could not find the nudge format string in nudge_ladder.rs").not.toBe(null);
  return (fmt?.[1] ?? "")
    // A backslash at end-of-line continues the literal: drop it and the following indentation.
    .replace(/\\\s*\n\s*/g, "")
    .replace("{n}", String(n))
    .replace("{}", duration);
}

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
