import { describe, expect, it } from "vitest";

import {
  LADDER_RETIREMENT_EXPLANATION,
  countLadderEscalateIt,
  PRIORITY_PROHIBITION,
  RETIRED_PRIORITY_LADDER_INSTRUCTION as PAT,
} from "./retiredLadderWordingTestUtils";
import { AGENT_FEEDBACK_DRAIN_STEP, sparklePersona } from "./sparkleAgent";
import { hourlyMissionPrompt } from "./improvementPass";

// A guard used by two prompt suites is itself load-bearing: if it silently matches nothing, both
// suites go green while the retired instruction walks back into production copy. So the pattern
// gets its own tests, on both sides.
describe("RETIRED_PRIORITY_LADDER_INSTRUCTION", () => {
  // Every phrasing below was ACTUALLY FOUND in this repo and removed by the ten-pass sweep for
  // bead sparkle-mzgqt. They are not invented variations — a guard written against only the one
  // phrasing that happened to be in front of the author is how the tenth site survived nine passes.
  it.each([
    "enrich it with the new evidence and BUMP its priority",
    "file a new bead or enrich an existing one (bumping its priority on recurrence)",
    "a repeated signal bumps priority one step toward P1",
    "comment, recurrence counter, priority bump",
    "its recurrence CLIMBS and its priority climbs with it",
    "it comments, bumps seen-<N> and steps priority on the same bead",
    "no comment, no seen-<N> bump, no priority step",
    "escalate its priority",
    // Synonyms nobody has written yet. The retired forms above are history; these are how the
    // instruction would plausibly come BACK, and a verb list closed at the four phrasings that
    // happened to exist is a guard against the past only.
    "raise its priority one step",
    "increase the priority on every recurrence",
    "elevate its priority toward P1",
    "nudge priority up as the count grows",
    // ...and the form that never says the word "priority" at all.
    "a repeated signal promotes it to P1",
    "bumped to P1 automatically once it reaches seen-5",
  ])("catches the retired instruction: %s", (retired) => {
    expect(retired).toMatch(PAT);
  });

  // The other half, and the one that costs more when it is wrong: a guard that fires on correct
  // copy gets loosened or deleted by the next agent, taking the real coverage with it.
  it.each([
    // Bumping the SEEN COUNTER is the replacement mechanism, not the retired one.
    "file new beads, enrich/bump recurring ones, and fix the highest-value item",
    "adds a comment and swaps the seen-<N> label; nothing else is written",
    // The prompts explain the retirement in prose, several words away from the word "priority".
    "do NOT move its priority: priority is set by a human",
    "the ladder that let a sighting count escalate it was retired 2026-08-09",
    "a comment count silently driving priority is exactly what the founder ruled out",
    "triage ranks by (priority, recurrence), and priority no longer moves",
  ])("does not fire on correct copy: %s", (ok) => {
    expect(ok).not.toMatch(PAT);
  });

  // THE PRODUCTION STRINGS THEMSELVES, not paraphrases of them. This is what makes the two
  // suites' negative assertions meaningful: it proves the guard is compatible with the copy those
  // prompts actually ship today, so a red there is a real regression rather than the guard being
  // mis-tuned. `AGENT_FEEDBACK_DRAIN_STEP` is the specific line that broke the first attempt.
  it("is compatible with the live copy both prompts ship today", () => {
    expect(AGENT_FEEDBACK_DRAIN_STEP).not.toMatch(PAT);
    for (const mode of ["always", "case_by_case"] as const) {
      expect(hourlyMissionPrompt(mode)).not.toMatch(PAT);
    }
    for (const mode of ["always", "case_by_case"] as const) {
      expect(
        sparklePersona("/tmp/logs", "/tmp/repo", mode, "unknown", { attended: false }),
      ).not.toMatch(PAT);
    }
  });

  // THE THREE BARRED PHRASINGS, asserted as barred. The module header claims `move` and
  // `escalate it` cannot be admitted to the pattern because each would fire on copy the prompts are
  // REQUIRED to carry; that claim is the reason two separate positives exist, so it is worth
  // holding still. If a future widening quietly admitted either verb, these go red and point at the
  // header rather than at a mysterious failure in two unrelated prompt suites.
  it.each([
    ["move — the prohibition itself", "Do NOT move its priority: priority is set by a human"],
    ["escalate it — the explanatory clause", "the ladder that let a sighting count escalate it was retired"],
  ])("stays barred from %s, which is why a positive covers it instead", (_label, required) => {
    expect(required).not.toMatch(PAT);
  });

  // And the positives themselves match the copy they are meant to pin — a shared constant that
  // matched nothing would take BOTH prompt suites green with it, the same failure mode the pattern
  // above has its own compatibility test for.
  it("the two positives match the live copy they pin", () => {
    for (const mode of ["always", "case_by_case"] as const) {
      const hourly = hourlyMissionPrompt(mode);
      expect(hourly).toMatch(PRIORITY_PROHIBITION);
      expect(hourly).toMatch(LADDER_RETIREMENT_EXPLANATION);
      const persona = sparklePersona("/tmp/logs", "/tmp/repo", mode, "unknown", { attended: false });
      expect(persona).toMatch(PRIORITY_PROHIBITION);
      expect(persona).toMatch(LADDER_RETIREMENT_EXPLANATION);
    }
  });

  // COUNTING, which is the only assertion in this set that constrains what may be ADDED. A positive
  // proves presence and a negative is barred from `escalate it` by construction, so an "escalate it
  // when the count grows" dropped BESIDE the explanatory clause is invisible to both. The phrase is
  // licensed exactly once per prompt; the helper is here rather than inline so the two prompt suites
  // and this one cannot disagree about what "once" means.
  //
  // The title says what it ENFORCES, not what it wishes it enforced: only `escalate it` in a
  // retired-ladder context is counted, and it is that subset which is licensed once. The earlier
  // title ("licenses the phrase `escalate it` exactly once") was contradicted by the `it.each`
  // three tests below, which pins ordinary escalation prose at 0.
  it("counts `escalate it` only in retired-ladder context, and licenses that exactly once", () => {
    for (const mode of ["always", "case_by_case"] as const) {
      expect(countLadderEscalateIt(hourlyMissionPrompt(mode))).toBe(1);
      expect(
        countLadderEscalateIt(sparklePersona("/tmp/logs", "/tmp/repo", mode, "unknown", { attended: false })),
      ).toBe(1);
    }
    // Non-vacuous in the direction that matters: a second occurrence is what it must be able to see.
    expect(
      countLadderEscalateIt("…count escalate it was retired… — and escalate it when the count grows"),
    ).toBe(2);
    expect(countLadderEscalateIt("no such phrase here")).toBe(0);
  });

  // THE FALSE POSITIVE THIS COUNTER IS SCOPED TO AVOID, pinned as correct copy. "Escalate" is an
  // ordinary word in these prompts about something else: `sparkleAgent.ts` already says "stop and
  // escalate to the user in chat instead", and rewording it to the equally natural "escalate IT to
  // the user in chat" is the kind of edit nobody would think twice about. A bare `/escalate it/g`
  // would take the count to 2 and red a test whose name blames the retired priority ladder — the
  // shape this suite warns about above, where a misleading diagnosis makes deleting the guard the
  // likely outcome. So the counter requires the retired-ladder context, and that is asserted here
  // rather than left as a property of a regex nobody re-reads.
  it.each([
    "stop and escalate it to the user in chat instead",
    "escalate items you cannot resolve",
    "escalate it in chat rather than guessing",
    // THE TRAILING-WORD BOUNDARY. Without a `\b` closing the alternation each alternative matches
    // as a PREFIX: `on` matches "only", `as` matches "aside"/"assign". These two are the cases the
    // three above cannot reach — they all fail on the FIRST token, so they return 0 whether or not
    // the boundary is there, leaving the suite blind to exactly this defect. "escalate it only to
    // the user in chat" is a reword of the line this scoping exists to protect, so the missing
    // boundary would have reintroduced the false positive inside the narrowing that removed it.
    "escalate it only to the user in chat instead",
    "escalate it onto the board",
  ])("does not count unrelated escalation prose: %s", (innocent) => {
    expect(countLadderEscalateIt(innocent)).toBe(0);
  });

  // INFLECTIONS OF THE LISTED WORDS, which the closing `\b` would otherwise exclude. `when` alone
  // does not match "whenever" — the boundary fails between `when` and `ever` — so the single most
  // natural phrasing of this instruction counted 0 until the list carried `(?:ever)?` explicitly.
  // Before the boundary existed these matched by accident, via prefix; the boundary that removed
  // the "only"/"onto" false positives took them with it, which is the trade this pins.
  it.each([
    "— escalate it whenever the count grows",
    "escalate it afterwards, once the count is up",
  ])("counts the natural inflections too: %s", (sibling) => {
    expect(countLadderEscalateIt(sibling)).toBe(1);
  });
});
