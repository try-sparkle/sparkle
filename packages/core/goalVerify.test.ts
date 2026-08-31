// The ONE property: a goal's check is explicit, and a `human`-verified goal cannot be closed by the
// agent that claimed it.
//
// SCOPE, stated honestly because the first version of this header got it wrong: `canSelfMarkMet` is
// the rule `set_agent_goal_met` is INTENDED to gate on, and at the time of writing nothing outside
// this module calls it (roborev 55842 — the header claimed the wiring in the present tense while
// `.claude/commands/goal.md` in the same commit said the opposite). These tests pin the RULE. The
// commit that wires it is what makes the gate real; until then this is a rule with no enforcer.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseGoalVerify,
  agentClosableKind,
  verifyStrength,
  mayReplaceVerify,
  inferGoalVerify,
  canSelfMarkMet,
  selfMarkRefusal,
  describeGoalVerify,
  GOAL_VERIFY_KINDS,
  type GoalVerify,
  type GoalVerifyEvidence,
  type VerifyVerdict,
} from "./goalVerify";
import { auditLandedClaims } from "./testing/landedClaim";

function rejected(v: VerifyVerdict): Extract<VerifyVerdict, { ok: false }> {
  if (v.ok) throw new Error(`expected a rejection, got ${JSON.stringify(v)}`);
  return v;
}

describe("parseGoalVerify", () => {
  it("accepts each of the three kinds", () => {
    expect(parseGoalVerify({ kind: "landed" })).toEqual({ ok: true, verify: { kind: "landed" } });
    expect(parseGoalVerify({ kind: "human" })).toEqual({ ok: true, verify: { kind: "human" } });
    expect(parseGoalVerify({ kind: "command", cmd: "pnpm vitest run x.test.ts" })).toEqual({
      ok: true,
      verify: { kind: "command", cmd: "pnpm vitest run x.test.ts" },
    });
  });

  it("trims a command rather than persisting the caller's whitespace", () => {
    const v = parseGoalVerify({ kind: "command", cmd: "  cargo test goal  " });
    expect(v).toEqual({ ok: true, verify: { kind: "command", cmd: "cargo test goal" } });
  });

  it("refuses a MISSING verify rather than defaulting to one", () => {
    // A default would be a lie in either direction: `human` silently routes work to the founder,
    // `landed` claims a git proof nobody asked for. The caller must say which.
    for (const absent of [undefined, null]) {
      expect(rejected(parseGoalVerify(absent)).reason).toBe("verify-missing");
    }
    // The message must name all three options, or the caller cannot fix the call.
    const msg = rejected(parseGoalVerify(undefined)).message;
    for (const kind of GOAL_VERIFY_KINDS) expect(msg).toContain(kind);
  });

  it("refuses an unknown kind and names the legal ones", () => {
    const v = rejected(parseGoalVerify({ kind: "vibes" }));
    expect(v.reason).toBe("verify-unknown-kind");
    for (const kind of GOAL_VERIFY_KINDS) expect(v.message).toContain(kind);
    // A non-string kind is the same refusal, not a crash.
    expect(rejected(parseGoalVerify({ kind: 7 })).reason).toBe("verify-unknown-kind");
    expect(rejected(parseGoalVerify({})).reason).toBe("verify-unknown-kind");
  });

  it("refuses a command kind with no cmd", () => {
    expect(rejected(parseGoalVerify({ kind: "command" })).reason).toBe("verify-cmd-missing");
    expect(rejected(parseGoalVerify({ kind: "command", cmd: "   " })).reason).toBe("verify-cmd-missing");
  });

  it("refuses a NON-OBJECT with a message that says an object is required", () => {
    // `parseGoalVerify("human")` is what a caller following the `check: human` shorthand tries first.
    // The old code read `.kind` off the string, got undefined, and reported "unknown verify kind
    // undefined" — naming a value the caller never passed (roborev 55842).
    for (const bad of ["human", 7, true, ["human"]]) {
      const v = rejected(parseGoalVerify(bad));
      expect(v.reason).toBe("verify-not-an-object");
      expect(v.message).toMatch(/object/i);
      expect(v.message).not.toContain("undefined");
    }
  });

  it("accepts any non-blank command, including prose-shaped ones, by design", () => {
    // There is deliberately NO prose heuristic: no cheap rule separates "npm test" from "all tests
    // are green" without rejecting real two-word commands, and a false rejection blocks a legitimate
    // goal. A non-runnable cmd fails loudly at execution, which is better feedback than a guess.
    for (const cmd of [
      "pnpm --filter @sparkle/desktop exec vitest run src/x.test.ts",
      "cargo test goal_gate",
      "npm test",
      "make check",
      "make sure the tests pass",
    ]) {
      expect(parseGoalVerify({ kind: "command", cmd }).ok).toBe(true);
    }
  });
});

describe("canSelfMarkMet — the self-report gate", () => {
  it("REFUSES a human-verified goal to its own claimant", () => {
    // The whole reason the `human` kind exists. If this returns true the kind is decorative.
    expect(canSelfMarkMet({ kind: "human" })).toBe(false);
  });

  it("REFUSES a human-verified goal EVEN WHEN the work is landed", () => {
    // The half of sparkle-vfkqz that must NOT change. `landed` evidence is git answering the
    // question `landed` asks; it says nothing about whether a PERSON approved anything, so it must
    // not leak across kinds. If this ever returns true, ancestry has become a way to launder a
    // human sign-off, and the gate is gone for exactly the goals that most need it.
    expect(canSelfMarkMet({ kind: "human" }, { landed: true })).toBe(false);
    expect(canSelfMarkMet({ kind: "command", cmd: "npm test" }, { landed: true })).toBe(false);
  });

  it("REFUSES command and landed to their own claimant when there is NO evidence", () => {
    // These returned `true` in the first version, on the theory that such a claim was "admissible
    // pending a check". That does not survive contact with what it gates: set_agent_goal_met LATCHES
    // metAt and nothing re-verifies it, so an agent allowed to call it has self-reported "done"
    // whatever the kind said. "I ran the command and it passed" IS the self-report being replaced.
    //
    // `landed` is now the ONE exception, and only because a machine answers it — see below. With no
    // evidence in hand the answer is still no.
    expect(canSelfMarkMet({ kind: "command", cmd: "npm test" })).toBe(false);
    expect(canSelfMarkMet({ kind: "landed" })).toBe(false);
  });

  it("ALLOWS a landed goal once ANCESTRY CONFIRMS IT — that is git's word, not the agent's", () => {
    // sparkle-vfkqz. A goal provable from git was refused to the one party that could see the proof,
    // so a finished agent burned three auto-continues and escalated to the founder with nothing for
    // him to do. `landed: true` is computed from the branch's reachability into origin/main; the
    // agent cannot assert it, so honouring it is not a self-report.
    expect(canSelfMarkMet({ kind: "landed" }, { landed: true })).toBe(true);
  });

  it("REFUSES a landed goal when git says NOT landed, or when nobody looked", () => {
    // The gate's real job, intact: an agent whose work is still local cannot declare it shipped.
    // `undefined` is "not looked up" and must fail CLOSED — never be read as a yes.
    expect(canSelfMarkMet({ kind: "landed" }, { landed: false })).toBe(false);
    expect(canSelfMarkMet({ kind: "landed" }, {})).toBe(false);
    expect(canSelfMarkMet({ kind: "landed" }, { landed: undefined })).toBe(false);
  });

  it("names the specific check in each refusal, so the agent knows what would satisfy it", () => {
    // A generic "you cannot mark this met" leaves the agent with no next action — the refusal has to
    // say what WOULD close the goal.
    expect(selfMarkRefusal({ kind: "command", cmd: "cargo test goal_gate" })).toContain("cargo test goal_gate");
    expect(selfMarkRefusal({ kind: "landed" })).toContain("origin/main");
    expect(selfMarkRefusal({ kind: "human" })).toMatch(/person|human/i);
  });

  it("tells a landed-goal claimant WHICH way git answered, since the two need opposite actions", () => {
    // "your work is not on main yet" (go land it) and "nothing has read your branch" (wait for a
    // poll) are different instructions. Collapsing them into one sentence sends half the agents that
    // read it to do the wrong thing.
    // `landedSource: "git-probe"` is what makes this the "git answered no" population rather than
    // the watermark-miss one below — a `landed: false` alone no longer speaks for git.
    const notLanded = selfMarkRefusal(
      { kind: "landed" },
      { landed: false, landedSource: "git-probe" },
    );
    const unread = selfMarkRefusal({ kind: "landed" }, {});
    expect(notLanded).toMatch(/not (yet )?on origin\/main|is not on origin\/main/i);
    expect(unread).toMatch(/has not been read|not been polled|no reading/i);
    expect(notLanded).not.toEqual(unread);
  });

  it("does NOT assert a git verdict for a branch holding NOTHING BACK, and does not send it to open a PR", () => {
    // THE BUG THIS PINS. `landed: false` is a positive test FAILING, not git's no — so it is also
    // what an agent reads whose work MERGED and whose worktree was then parked or moved onto another
    // branch: the merge watermark belongs to the branch it left, and the branch it is on holds
    // nothing back. The old single sentence told that agent "git says it is not on origin/main yet …
    // Land it (open a PR and merge it)" — a false statement of fact, and an instruction to duplicate
    // work already on main.
    const nothingHeld = selfMarkRefusal({ kind: "landed" }, { landed: false, unlandedWork: false });
    const holding = selfMarkRefusal({ kind: "landed" }, { landed: false, unlandedWork: true });

    // The ACTION each one produces is what matters, so assert on that rather than on wording: only a
    // branch that IS holding commits may be sent, unconditionally, to open a PR.
    expect(holding).toMatch(/open a PR and merge it/i);
    expect(nothingHeld).not.toMatch(/Land it \(open a PR and merge it\)/i);
    // …and it must not restate the claim git can contradict.
    expect(nothingHeld).not.toMatch(/git says it is not on origin\/main/i);
    expect(nothingHeld).toMatch(/NOT git saying your work is unlanded/i);
    // It hands over the one check that settles it, and names the exit for the case where it IS
    // landed: the concierge, the surface that can close a goal its claimant may not.
    expect(nothingHeld).toMatch(/merge-base --is-ancestor/);
    expect(nothingHeld).toMatch(/concierge/i);
    expect(nothingHeld).not.toEqual(holding);
  });

  it("attributes the negative to GIT only when git actually answered — the PAIR (sparkle-2668a7)", () => {
    // THE BUG THIS PINS, and it is a PAIR on purpose. Asserting only that the new sentence appears
    // would be vacuous: before this change BOTH inputs below returned the "git says" string, so a
    // one-sided assertion is satisfied by code that simply deleted the true message along with the
    // false one. The property is that the two DIVERGE, and that each says the honest thing about
    // its own provenance.
    //
    // Identical in every other respect — a branch holding commits, `landed: false` — so the ONLY
    // difference between these two calls is WHERE the `false` came from.
    const fromGit = selfMarkRefusal(
      { kind: "landed" },
      { landed: false, unlandedWork: true, landedSource: "git-probe" },
    );
    const fromWatermark = selfMarkRefusal(
      { kind: "landed" },
      { landed: false, unlandedWork: true, landedSource: "window-local" },
    );
    expect(fromGit).not.toEqual(fromWatermark);

    // HALF ONE: a real ancestry verdict may STILL be quoted as one. This is the half a naive fix
    // breaks — strip "git says" everywhere and every assertion about the new copy still passes
    // while the one message that was true is gone.
    expect(fromGit).toMatch(/git says it is not on origin\/main yet/i);

    // HALF TWO: a watermark miss may not borrow git's authority. `landed: false` on that path is a
    // POSITIVE TEST FAILING — no merge watermark this window latched — and no ancestry question was
    // asked at all, which is why a provably-merged branch read git's no and was sent to open a
    // second PR.
    expect(fromWatermark).not.toMatch(/git says/i);
    expect(fromWatermark).toMatch(/merge watermark this window has not latched/i);
    // It must name the mechanism AND hand over the command that settles it…
    expect(fromWatermark).toMatch(/merge-base --is-ancestor/);
    // …and answer the ancestor case, the branch whose absence produced the duplicate PR.
    expect(fromWatermark).toMatch(/if it IS an ancestor/i);
    expect(fromWatermark).toMatch(/concierge/i);
    // …while still telling the genuinely-unlanded reader what to do, since this arm serves both.
    expect(fromWatermark).toMatch(/open a PR and merge it/i);

    // AN UNRECORDED SOURCE IS NOT A GIT SOURCE. A caller that never computed provenance gets the
    // honest copy, not one that speaks for a check it never ran.
    expect(selfMarkRefusal({ kind: "landed" }, { landed: false, unlandedWork: true })).toEqual(
      fromWatermark,
    );

    // No claim that the work is on main may stand unconditionally here either — same single owner
    // (`@sparkle/core/testing/landedClaim`) as the arm above, so the two cannot drift.
    const audit = auditLandedClaims(fromWatermark);
    expect(
      audit.candidates.length,
      `no landed-claim sentence found in: ${fromWatermark}`,
    ).toBeGreaterThan(0);
    expect(audit.violations, "an unconditional landed claim").toEqual([]);
  });

  it("PROVENANCE never unlocks the latch — it only picks the sentence", () => {
    // The gate is the half that must not move. `canSelfMarkMet` must not read `landedSource` at
    // all, asserted in BOTH directions: a `git-probe` stamp cannot add to a `false`, and a
    // `window-local` stamp cannot subtract from a genuine ancestry YES.
    expect(canSelfMarkMet({ kind: "landed" }, { landed: false, landedSource: "git-probe" })).toBe(
      false,
    );
    expect(canSelfMarkMet({ kind: "landed" }, { landed: true, landedSource: "window-local" })).toBe(
      true,
    );
    // …and a source with no reading behind it is still "nobody looked".
    expect(canSelfMarkMet({ kind: "landed" }, { landedSource: "git-probe" })).toBe(false);
  });

  it("speaks CONDITIONALLY, because `unlandedWork: false` is three populations and only git separates them", () => {
    // roborev 65742, and the reason this arm states nothing about what happened. `unlandedWork:
    // false` is ALSO what an agent that committed nothing reads, and what an agent holding only
    // uncommitted edits reads — `landedEvidenceFor`'s own docstring says as much. A sentence that
    // told any of them "your work may already have merged" would be affirmatively wrong for two of
    // three, would discourage the one correct action (commit it and land it), and would route a
    // no-op agent at the concierge — the single surface that bypasses the gate.
    const msg = selfMarkRefusal({ kind: "landed" }, { landed: false, unlandedWork: false });
    // Both branches present, each behind its own condition. The never-committed agent must find its
    // instruction here too, not only the landed-then-parked one.
    expect(msg).toMatch(/If you have not committed the work yet, commit it and land it/i);
    expect(msg).toMatch(/If you believe it is ALREADY on origin\/main/i);

    // No claim that the work is on main may stand unconditionally. The rule has ONE owner
    // (`@sparkle/core/testing/landedClaim`) so this layer and the desktop layer cannot drift apart —
    // duplicating it verbatim is how the weaker predicate ends up running at the layer that reaches
    // agents (roborev 65753).
    const audit = auditLandedClaims(msg);
    // Not a decoration: an empty candidate set means the audit examined nothing, which is the
    // vacuity this guard exists to remove.
    expect(audit.candidates.length, `no landed-claim sentence found in: ${msg}`).toBeGreaterThan(0);
    expect(audit.violations, "an unconditional landed claim").toEqual([]);

    // BOTH branches must name a door the reader can open (this case's own contract, and the
    // sparkle-vfkqz failure when it was omitted) — and the assertion is SCOPED TO THE CLAUSE
    // (roborev 65749). A message-wide `toMatch(/mark this met again/)` is satisfied by a self-close
    // path named only inside the landed-conditional clause, which leaves the commit-first reader
    // with no door again while every assertion still passes.
    const commitClause = msg
      .split(/(?<=[.;])\s+/)
      .find((t) => /commit it and land it/i.test(t));
    expect(commitClause, msg).toBeDefined();
    expect(commitClause!, "the commit-first branch names no self-close path").toMatch(
      /mark this met again/i,
    );
    // …and that door must be ITS OWN, not the landed branch's concierge instruction bleeding in.
    expect(commitClause!).not.toMatch(/concierge/i);
    // The landed branch keeps its own exit.
    expect(msg).toMatch(/concierge/i);
  });

  it("keeps the original sentence when the ahead-count was NOT looked up", () => {
    // `undefined` is "nobody looked", never "holding nothing" — the same discipline `landed` itself
    // is built on. A missing reading must not manufacture the parked advice, so the copy an existing
    // caller gets is unchanged until it supplies the bit.
    const unread = selfMarkRefusal({ kind: "landed" }, { landed: false });
    expect(unread).toMatch(/open a PR and merge it/i);
    expect(unread).toEqual(selfMarkRefusal({ kind: "landed" }, { landed: false, unlandedWork: undefined }));
  });

  it("the ahead-count NEVER unlocks the latch — it only picks the sentence", () => {
    // The gate is the half that must not move. `unlandedWork: false` is exactly the shape of the
    // agent the new copy speaks to, and it must still be REFUSED: "I am holding nothing back" is not
    // ancestry, and letting it close a goal would be the self-report the whole mechanism replaces.
    expect(canSelfMarkMet({ kind: "landed" }, { landed: false, unlandedWork: false })).toBe(false);
    expect(canSelfMarkMet({ kind: "landed" }, { unlandedWork: false })).toBe(false);
    // …and it cannot subtract from a genuine ancestry YES either.
    expect(canSelfMarkMet({ kind: "landed" }, { landed: true, unlandedWork: true })).toBe(true);
  });

  it("the HUMAN refusal has THREE arms — one per provenance population", () => {
    // roborev 57827, resolved by 57832. The arms differ in what each may honestly SAY, not in
    // whether the exit exists: chosen-here → nothing extra (a caller bound itself to THIS work);
    // carried → say a caller chose it for an EARLIER goal, and still name the exit; manufactured or
    // unknown → say nobody is recorded as choosing it, and name the exit. Only the first withholds,
    // because restatement-vs-unrelated is not recorded and withholding on that guess strands the
    // population the exit exists for.
    const here = selfMarkRefusal({ kind: "human" }, { stated: true, chosenHere: true });
    const carried = selfMarkRefusal({ kind: "human" }, { stated: true, chosenHere: false });
    const made = selfMarkRefusal({ kind: "human" }, { stated: false, chosenHere: false });

    // Only the check chosen for THIS goal withholds the exit — the one case where a caller
    // demonstrably bound itself to this work.
    expect(here).not.toMatch(/verify: null/);
    // The carried arm NAMES the exit (roborev 57832): nothing records whether the earlier goal was
    // a paraphrase or unrelated work, so withholding it on that guess swallows the population the
    // exit exists for. It also must not CLAIM a restatement it cannot know.
    expect(carried).toMatch(/verify: null/);
    expect(carried).toMatch(/carried over from an earlier goal/i);
    expect(carried).not.toMatch(/restates/i);
    // …but it is still distinguishable from the manufactured arm: a caller did choose it, once.
    expect(carried).not.toEqual(made);
    // NEVER "a person" — only `verifyStated` is recorded, and an agent may bind itself, so claiming
    // a human signed off is the same over-claim as "restates" one clause down (roborev 57840).
    expect(carried).not.toMatch(/a person chose/i);
    expect(made).not.toMatch(/a person chose/i);
    expect(made).toMatch(/verify: null/);

    // All three keep the ordinary path primary.
    for (const msg of [here, carried, made]) {
      expect(msg).toMatch(/leave it for the human to close/i);
      expect(msg).not.toMatch(/only way out/i);
    }
    // Legacy (nothing recorded) lands on the take-back arm, which is where it was before.
    expect(selfMarkRefusal({ kind: "human" })).toMatch(/verify: null/);
  });

  it("the HUMAN refusal does NOT offer a take-back on a check chosen for THIS goal", () => {
    // roborev 57819. The take-back sentence used to be gated on "if this check was not one you
    // chose" — a question the agent provably cannot answer, and true for every worker under a
    // concierge-set sign-off. A remedy string is an instruction the agent will follow, so that
    // wording routed a DELIBERATE founder approval toward its own removal. The app holds the
    // provenance, so it decides; and reporting completion stays the primary path either way.
    const chosen = selfMarkRefusal({ kind: "human" }, { stated: true, chosenHere: true });
    expect(chosen).not.toMatch(/verify: null/);
    expect(chosen).toMatch(/leave it for the human to close/i);
    // The "only way out" claim must be gone too: a person closing it on the report IS the way out.
    expect(chosen).not.toMatch(/only way out/i);
    expect(selfMarkRefusal({ kind: "human" }, { stated: false, chosenHere: false })).not.toMatch(
      /only way out/i,
    );
  });

  it("the HUMAN refusal names the take-back when the check was NOT caller-chosen", () => {
    // roborev 57816. An inherited `human` binds across every later goal, so this arm now carries
    // far more traffic than the design intended — including the whole installed base, whose checks
    // were manufactured. "Leave it for the human to close" left BOTH parties stuck: the agent
    // couldn't tell a chosen check from an inherited one, and the human who got the red row wasn't
    // told which door closes it. Same rule the `landed` arm was rewritten under: never misdescribe
    // the mechanism, always name the action that ends the state.
    const msg = selfMarkRefusal({ kind: "human" }, { stated: false, chosenHere: false });
    expect(msg).toMatch(/verify: null|verify:\s*null/);
    // …and unknown provenance (a check predating this bookkeeping) offers it too — the direction
    // that gives the agent a way forward rather than asserting a sign-off nobody can evidence.
    expect(selfMarkRefusal({ kind: "human" })).toMatch(/verify: null/);
    expect(msg).toMatch(/concierge/i);
    // …and it must say the check may not have been chosen, or an agent reads it as a real sign-off
    // requirement and never asks.
    expect(msg).toMatch(/not one you chose|inherit/i);
  });

  it("no longer claims a person must close a LANDED goal — code computes it now", () => {
    // This copy used to say "a person closes the goal … because no code computes `landed` today".
    // That WAS true and is now false, and it is the sentence that taught the agent in sparkle-vfkqz
    // it had no self-service path. A refusal that misdescribes the mechanism is worse than none:
    // the agent stops looking for the door that exists.
    const landed = selfMarkRefusal({ kind: "landed" }, { landed: false });
    expect(landed).not.toMatch(/no code computes/i);
    expect(landed).not.toMatch(/a person closes the goal/i);
    // The `command` arm has no executor still, so its caveat MUST survive.
    const cmd = selfMarkRefusal({ kind: "command", cmd: "cargo test goal_gate" });
    expect(cmd).toMatch(/a person closes the goal/i);
    expect(cmd).toMatch(/nothing runs the check for you today/i);
    expect(cmd).not.toMatch(/let the check .* close the goal/);
  });

  it("leaves legacy goals with no verify exactly as they were", () => {
    // Every goal that existed before this module has no `verify`. Refusing those would break
    // set_agent_goal_met for the whole installed base to enforce a rule they never opted into.
    expect(canSelfMarkMet(undefined)).toBe(true);
  });

  it("has a refusal sentence for every kind it refuses", () => {
    const msg = selfMarkRefusal({ kind: "human" });
    expect(msg).toMatch(/cannot mark it met/i);
    // Total, not partial: no kind yields an empty string a UI would render as a blank refusal.
    for (const kind of GOAL_VERIFY_KINDS) {
      const v: GoalVerify = kind === "command" ? { kind, cmd: "npm test" } : ({ kind } as GoalVerify);
      expect(selfMarkRefusal(v).length).toBeGreaterThan(0);
    }
  });
});

describe("the DOCS that quote these refusals — pinned to the strings actually returned", () => {
  // roborev 65746. `.claude/commands/goal.md` and the sparkle-control SKILL row both quote the
  // `landed` refusals verbatim, and nothing tied those quotes to `selfMarkRefusal`'s output — which
  // is how the SKILL row went on enumerating TWO arms after a third existed. That staleness is not
  // cosmetic: an agent reading a two-way list falls back to the only negative branch offered ("go
  // merge it") and opens the rival PR this whole change exists to prevent.
  //
  // Scoped to the ONE section / ONE row that makes the promise, never a body-wide grep, so a
  // narrative "an earlier version said…" line elsewhere cannot satisfy it.
  const repoFile = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

  const between = (haystack: string, from: string, to: string): string => {
    const start = haystack.indexOf(from);
    expect(start, `missing section start: ${from}`).toBeGreaterThanOrEqual(0);
    const end = haystack.indexOf(to, start);
    expect(end, `missing section end: ${to}`).toBeGreaterThan(start);
    // Normalised, because a markdown quote is WRAPPED: the same sentence arrives as
    // "…and it is holding no unlanded\n    commits either". Collapsing whitespace (and folding the
    // typographic apostrophe) compares the words the doc promises, not its line breaks.
    return haystack
      .slice(start, end)
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/\s+/g, " ")
      .toLowerCase();
  };

  // Each fragment, and the evidence shape whose refusal must contain it. Asserted from BOTH ends:
  // the code really returns it, and the doc really quotes it.
  //
  // ⚠️ A HAND-MAINTAINED LIST CANNOT SEE A NEW ARM (roborev 65752) — and a new undocumented arm is
  // exactly the drift that happened (the third arm shipped; the SKILL row kept enumerating two, for
  // two commits). A literal list only catches re-wording and deletion. So the list is COVERAGE-
  // CHECKED against the code below: every distinct string the `landed` case can return must be
  // claimed by some fragment here, which reds the moment a fourth branch is added and left unlisted.
  const ARMS: Array<{ fragment: string; evidence: GoalVerifyEvidence }> = [
    {
      fragment: "git says it is not on origin/main yet",
      // ONLY reachable with a real ancestry verdict behind it now (sparkle-2668a7).
      evidence: { landed: false, unlandedWork: true, landedSource: "git-probe" },
    },
    {
      fragment: "a merge watermark this window has not latched",
      evidence: { landed: false, unlandedWork: true, landedSource: "window-local" },
    },
    {
      fragment: "nothing has been observed reaching origin/main",
      evidence: { landed: false, unlandedWork: false },
    },
    {
      fragment: "it is holding no unlanded commits either",
      evidence: { landed: false, unlandedWork: false },
    },
    { fragment: "your branch's git state has not been read yet", evidence: {} },
  ];

  // Every evidence shape that reaches the `landed` case, so the distinct outputs below are the
  // code's own answer to "how many arms are there" rather than this file's opinion of it.
  //
  // ⚠️ THE INPUTS ARE HAND-MAINTAINED, so the case below ALSO derives the field names the code
  // branches on and asserts this list exercises each (roborev 65756). Without that, an arm keyed on
  // a NEW evidence field is reached by none of these shapes, the distinct outputs are unchanged, and
  // everything stays green — which is the incident this file cites: the third arm arrived in the
  // same commit as the `unlandedWork` field it reads, so a matrix written the day before could not
  // have seen it.
  const LANDED_EVIDENCE: Array<GoalVerifyEvidence | undefined> = [
    { landed: false, unlandedWork: true },
    { landed: false, unlandedWork: false },
    { landed: false },
    // BOTH SIDES OF `landedSource`, which is the field the newest arm keys on. The `git-probe` shape
    // is the ONLY one that can reach the "git says" arm, so without it that string is unreachable
    // and the coverage check below would report one arm short.
    { landed: false, unlandedWork: true, landedSource: "git-probe" },
    { landed: false, unlandedWork: true, landedSource: "window-local" },
    { landed: undefined, unlandedWork: false },
    // `landed: true` never reaches a refusal arm in production (the goal simply closes), but it is
    // the OTHER SIDE of a field the arms branch on, and the varies-each-field check below counts
    // only DEFINED values — so without it that check cannot tell "both sides covered" from "one
    // side plus absence", which is exactly how its first cut was silenceable.
    { landed: true, unlandedWork: true },
    {},
    undefined,
  ];

  it("the evidence matrix exercises every field the landed case actually branches on", () => {
    // Read from the SOURCE, not from this file's memory of it. `evidence?.<name>` inside the
    // `case "landed":` body is exactly the set of questions the arms ask; a new one means a new arm
    // this matrix cannot reach, and that must fail here rather than pass silently downstream.
    const source = repoFile("packages/core/goalVerify.ts");
    const start = source.indexOf('case "landed":');
    const end = source.indexOf('case "human":', start);
    expect(start, "the landed case moved").toBeGreaterThanOrEqual(0);
    expect(end, "the human case moved").toBeGreaterThan(start);
    // Optional-chained AND plain member reads. A field pulled through a local alias
    // (`const ev = evidence ?? {}`) still escapes this — said plainly rather than pretended away;
    // the coverage case below is the backstop for whatever this derivation misses.
    const fields = new Set(
      [...source.slice(start, end).matchAll(/evidence\s*\??\.\s*(\w+)/g)].map((m) => m[1]!),
    );
    expect(fields.size, "the landed arms read no evidence at all?").toBeGreaterThan(0);

    // VARIED, NOT MERELY PRESENT (roborev 65759). "this field is a key somewhere" is silenceable
    // without ever reaching the new arm: add `dirtyTree: false` and it goes green while the
    // `dirtyTree === true` branch stays unreachable, so the coverage case sees no new output and the
    // docs quietly enumerate three arms out of four. And DEFINED values only — counting `undefined`
    // reads "one side plus absence" as two sides, which is the same hole one layer down.
    for (const field of fields) {
      const values = new Set(
        LANDED_EVIDENCE.map((ev) => (ev === undefined ? undefined : ev[field as keyof typeof ev]))
          .filter((v) => v !== undefined)
          .map((v) => JSON.stringify(v)),
      );
      expect(
        values.size,
        `the landed case branches on \`${field}\`, and LANDED_EVIDENCE never varies it — add shapes ` +
          "covering BOTH sides, or the arm it keys is never reached",
      ).toBeGreaterThan(1);
    }
  });

  it("the fragment list COVERS every distinct refusal the landed case can return", () => {
    // This is the assertion that makes the two doc cases meaningful. Without it they pin only the
    // arms someone remembered to list — so a new branch returns a string no fragment names, both
    // doc cases stay green, and the docs go stale exactly as they did before.
    const distinct = [...new Set(LANDED_EVIDENCE.map((ev) => selfMarkRefusal({ kind: "landed" }, ev)))];
    expect(distinct.length).toBeGreaterThan(1);

    // EVERY ARM MUST BE REACHED, not merely every field varied (roborev 65762). Per-field variation
    // is necessary and not sufficient: an arm keyed on a CONJUNCTION can stay unreached while both of
    // its fields vary across shapes that never satisfy it together, and then `distinct` is short by
    // one string and no fragment is ever demanded for it. Counting the `return`s in the case body is
    // the check that closes that: one distinct output per arm, or something is unreachable.
    const source = repoFile("packages/core/goalVerify.ts");
    const landedStart = source.indexOf('case "landed":');
    const landedEnd = source.indexOf('case "human":', landedStart);
    const arms = [...source.slice(landedStart, landedEnd).matchAll(/\n\s*return\b/g)].length;
    expect(
      distinct.length,
      `the landed case has ${arms} arms but LANDED_EVIDENCE reaches only ${distinct.length} of them — ` +
        "add the shape that satisfies the missing one",
    ).toBe(arms);
    for (const out of distinct) {
      const claimed = ARMS.some(({ fragment }) => out.toLowerCase().includes(fragment));
      expect(claimed, `no ARMS fragment claims this refusal — list it and quote it in the docs:\n${out}`).toBe(
        true,
      );
    }
    // …and no fragment may name an arm the code no longer returns, or the doc cases would be
    // demanding a quote of a string that does not exist.
    for (const { fragment } of ARMS) {
      const returned = distinct.some((out) => out.toLowerCase().includes(fragment));
      expect(returned, `orphaned fragment, no refusal returns it: ${fragment}`).toBe(true);
    }
  });

  it("every arm the code returns is quoted in the /goal guide", () => {
    const section = between(
      repoFile(".claude/commands/goal.md"),
      "**`landed` you CAN mark met",
      "- **Do not go quiet after a refusal",
    );
    for (const { fragment, evidence } of ARMS) {
      expect(selfMarkRefusal({ kind: "landed" }, evidence).toLowerCase(), fragment).toContain(fragment);
      expect(section, fragment).toContain(fragment);
    }
  });

  it("…and in the sparkle-control SKILL row an agent reads at call time", () => {
    // The MCP tool contract is what an agent has in front of it the moment it calls
    // `set_agent_goal_met`, so it is at least as load-bearing as the /goal guide.
    const row = between(
      repoFile(".agents/skills/sparkle-control/SKILL.md"),
      "| `set_agent_goal_met`",
      "| `send_peer_message`",
    );
    for (const { fragment } of ARMS) {
      expect(row, fragment).toContain(fragment);
    }

    // PRESENCE IS NOT THE INVARIANT — the PAIRING is (roborev 65752). A compressed row that keeps
    // all three quotes but re-attaches "(go merge it)" as the blanket reading of a refusal passes a
    // presence-only check, and that reading is what sends a landed-then-parked agent to open a rival
    // PR. So: any mention of merging as the general answer must sit inside the "never infer" clause…
    // PRESENCE FIRST (roborev 65756): a filter over `go merge it` sentences is satisfied by DELETING
    // the caution — a row that says "a `landed` refusal means the work is not on main — land it."
    // yields an empty filter and passes. So require the caution to exist, and to arrive before the
    // first arm quote, where it governs the reading of all of them.
    expect(row, "the row carries no `never infer` caution").toContain("never infer");
    // Anchored on the FIRST QUOTE IN THE ROW, not on this file's array order (roborev 65759):
    // `ARMS` order is independent of the row's, so anchoring on `ARMS[0]` lets a row that leads with
    // a different arm put the caution after an arm it is supposed to govern and still pass.
    const firstQuoteAt = Math.min(
      ...ARMS.map(({ fragment }) => row.indexOf(fragment)).filter((i) => i >= 0),
    );
    // `Math.min()` of an empty list is Infinity, which sails past a `>= 0` guard (roborev 65762) —
    // so the guard has to be finiteness, not sign.
    expect(Number.isFinite(firstQuoteAt), "no arm quote found in the row").toBe(true);
    expect(
      row.indexOf("never infer"),
      "the caution arrives after an arm it is supposed to govern",
    ).toBeLessThan(firstQuoteAt);
    // …and where merging IS mentioned as a general reading, the caution must LEAD it — co-occurrence
    // is satisfied by "a refusal means go merge it, but never infer more than that."
    for (const sentence of row.split(/(?<=[.;])\s+/).filter((t) => t.includes("go merge it"))) {
      expect(sentence, sentence).toMatch(/never infer[^.;]{0,40}go merge it/);
    }
    // …and the arm that must NOT be answered by merging has to carry its own next move, between its
    // own quote and the next one.
    const from = row.indexOf("nothing has been observed reaching origin/main");
    const to = row.indexOf("your branch's git state has not been read yet", from);
    expect(to, "the two quotes are out of order or missing").toBeGreaterThan(from);
    const arm = row.slice(from, to);
    expect(arm, "the parked arm names no ancestry check").toContain("merge-base --is-ancestor");
    expect(arm, "the parked arm names no concierge exit").toContain("concierge");
    expect(arm, "the parked arm tells the agent to merge").not.toMatch(/go merge it|merge them/);
  });
});

describe("inferGoalVerify — reading the check out of the goal's own words", () => {
  it("infers `landed` from goal text a git ancestry check can answer", () => {
    // The concierge writes goals in exactly this shape, which is the whole reason inference is
    // possible at all. Each of these is decided by `git merge-base --is-ancestor <sha> origin/main`.
    for (const text of [
      "the retry fix is merged to origin/main by ancestry",
      "PR #1148 is merged and its merge commit is an ancestor of origin/main",
      "nudger.rs and nudge_gate.rs have landed on main",
      "the branch lands on main with CI green",
      "the pull request is merged",
      "sparkle-vfkqz's fix is on origin/main",
    ]) {
      expect(inferGoalVerify(text), text).toEqual({ kind: "landed" });
    }
  });

  it("infers NOTHING from a goal only a person can settle", () => {
    // `undefined` means "cannot infer", and the caller's fallback is `human`. Failing closed here is
    // correct — the bug was failing closed on a question GIT ALREADY ANSWERS, not failing closed.
    for (const text of [
      "the founder approves the copy",
      "the new column layout looks right to a human",
      "the founder signs off on the onboarding wording",
      "the design reads as intentional rather than templated",
    ]) {
      expect(inferGoalVerify(text), text).toBeUndefined();
    }
  });

  it("lets a HUMAN-JUDGEMENT word VETO a landing word, rather than the other way round", () => {
    // "the founder approves the PR copy" contains "PR". Inferring `landed` from that would hand an
    // ancestry proof to a goal whose actual criterion is a person's taste — the precise inversion
    // this bug is about, pointed the other way. Precedence: veto wins, and the caller falls back to
    // `human`.
    expect(inferGoalVerify("the founder approves the PR description copy")).toBeUndefined();
    expect(inferGoalVerify("a human signs off that the merged layout looks right")).toBeUndefined();
  });

  it("refuses to infer `landed` for SHIPPED/RELEASED work — a different question with a different check", () => {
    // AGENTS.md is explicit: "it landed" and "it shipped" are different facts with different checks,
    // and they diverge for the whole ~27-minute window a DMG is building. Ancestry against
    // origin/main CANNOT answer the release question, so inferring `landed` here would attach a
    // proof that does not prove the stated goal — and an agent already reported work as released on
    // exactly that mistaken basis.
    for (const text of [
      "the fix is shipped in the next release DMG",
      "v0.61.0 is tagged and the release notes name the build SHA",
      "the change is in a published release tag",
    ]) {
      expect(inferGoalVerify(text), text).toBeUndefined();
    }
  });

  it("infers `landed` from a bare PR reference — the pattern that was DEAD under casefolding", () => {
    // These two cases exist because the PR patterns were written with a literal uppercase `PR` and
    // no `i` flag while `inferGoalVerify` casefolds first, so they could never match (roborev 57794).
    // The test that appeared to cover them passed on `\bmerg…\b` in the same sentence. So each string
    // here is chosen so the PR pattern is the ONLY one that can match: no "merge", no "land", no
    // "main". Delete the PR patterns and these go red.
    expect(inferGoalVerify("PR #1160 is open and green")).toEqual({ kind: "landed" });
    expect(inferGoalVerify("the PR is up for the retry backoff work")).toEqual({ kind: "landed" });
    // …and WITHOUT the hash, which is how half of these get written. Requiring `#` re-created the
    // dead-rule bug in miniature and no test caught it, because every other string here has one.
    expect(inferGoalVerify("pr 1160 is green")).toEqual({ kind: "landed" });
  });

  it("infers nothing from empty or contentless text", () => {
    expect(inferGoalVerify("")).toBeUndefined();
    expect(inferGoalVerify("   ")).toBeUndefined();
  });

  it("is case- and punctuation-insensitive, so wording cannot smuggle a goal past either way", () => {
    expect(inferGoalVerify("MERGED TO ORIGIN/MAIN.")).toEqual({ kind: "landed" });
    expect(inferGoalVerify("Merged to main — but the FOUNDER approves it first")).toBeUndefined();
  });

  it("does not match a landing word buried inside an unrelated one", () => {
    // Substring matching would read "merged" out of nowhere and "land" out of "landscape" or
    // "Netherlands". These must not become ancestry-checked goals.
    expect(inferGoalVerify("the landscape illustration renders in dark mode")).toBeUndefined();
    expect(inferGoalVerify("the highlander casing bug is gone from the parser")).toBeUndefined();
  });
});

describe("agentClosableKind / verifyStrength / mayReplaceVerify — the debt rules' vocabulary", () => {
  const sample = (kind: (typeof GOAL_VERIFY_KINDS)[number]): GoalVerify =>
    kind === "command" ? { kind, cmd: "npm test" } : ({ kind } as GoalVerify);
  // Every question a caller could answer, set to YES — "the most anyone could ever know".
  // `unlandedWork: false` is the most-favourable value for a "is it holding work back" question,
  // which is what "the most anyone could ever know" means for this bit.
  const OMNISCIENT = { landed: true, unlandedWork: false };

  it("AGREES WITH canSelfMarkMet FOR EVERY KIND — the coupling, actually enforced", () => {
    // The docstring used to claim these "cannot drift" while `agentClosableKind` restated
    // `kind === "landed"` that `canSelfMarkMet` hardcoded separately — a property nothing checked
    // (roborev 57806). The day someone wires the command executor and gives `canSelfMarkMet` a
    // `command` arm, this test fails loudly instead of a `command` check silently becoming
    // self-closing while the debt rules still treat it as un-closable. Exhaustive over the union, so
    // a NEW kind cannot be added without answering the question for it.
    for (const kind of GOAL_VERIFY_KINDS) {
      expect(agentClosableKind(kind), kind).toBe(canSelfMarkMet(sample(kind), OMNISCIENT));
    }
  });

  it("ranks human above command above landed", () => {
    expect(verifyStrength("human")).toBeGreaterThan(verifyStrength("command"));
    expect(verifyStrength("command")).toBeGreaterThan(verifyStrength("landed"));
  });

  it("REFUSES every weakening replacement, and allows every strengthening one", () => {
    // The whole rule, stated over the full cross product rather than by example — a per-pair test
    // is how the `human`→`landed` arm got closed while `command`→`landed` stayed open. `sample`
    // gives both `command` ends the SAME cmd, so this covers the rank; the cmd-identity rule gets
    // its own case below.
    for (const from of GOAL_VERIFY_KINDS) {
      for (const to of GOAL_VERIFY_KINDS) {
        const weaker = verifyStrength(to) < verifyStrength(from);
        expect(mayReplaceVerify(sample(from), sample(to)), `${from} -> ${to}`).toBe(!weaker);
      }
    }
    // Named, so the cases that cost five review rounds cannot regress silently.
    expect(mayReplaceVerify({ kind: "human" }, { kind: "landed" })).toBe(false);
    expect(mayReplaceVerify({ kind: "command", cmd: "npm test" }, { kind: "landed" })).toBe(false);
    expect(mayReplaceVerify({ kind: "human" }, { kind: "command", cmd: "echo ok" })).toBe(false);
  });

  it("on the SAME goal, refuses swapping the instrument even when the rank allows it", () => {
    // Two cases the rank gets wrong, both scoped to `sameGoal` (roborev 57813).
    const cmd: GoalVerify = { kind: "command", cmd: "pnpm test parser" };
    const same = { sameGoal: true } as const;
    // Same kind is NOT the same check: `pnpm test parser` -> `true` scores 1 >= 1 and used to sail
    // through, shedding the obligation INSIDE the kind — a self-close on an agent-authored no-op the
    // moment an executor exists.
    expect(mayReplaceVerify(cmd, { kind: "command", cmd: "true" }, same)).toBe(false);
    // Re-stating the IDENTICAL command is not a trade, so it stays allowed.
    expect(mayReplaceVerify(cmd, { kind: "command", cmd: "pnpm test parser" }, same)).toBe(true);
    // Strengthening off a command still works.
    expect(mayReplaceVerify(cmd, { kind: "human" }, same)).toBe(true);
    // `landed` -> `command` ranks as a strengthening but trades git's unforgeable answer for a
    // string the agent wrote, then asks a person to close on it.
    expect(mayReplaceVerify({ kind: "landed" }, { kind: "command", cmd: "echo ok" }, same)).toBe(false);
  });

  it("on NEW goal text those two are ALLOWED — the standing check describes work left behind", () => {
    // The scope is load-bearing in this direction too: refusing here would block an agent that
    // simply started something else from stating a check that fits the new work.
    const cmd: GoalVerify = { kind: "command", cmd: "pnpm test parser" };
    expect(mayReplaceVerify(cmd, { kind: "command", cmd: "pnpm test lexer" })).toBe(true);
    expect(mayReplaceVerify({ kind: "landed" }, { kind: "command", cmd: "pnpm test parser" })).toBe(true);
    // …but the RANK still applies on new text, so a real weakening is refused either way.
    expect(mayReplaceVerify({ kind: "human" }, { kind: "landed" })).toBe(false);
  });

  it("allows ANY check over a goal that has none — adding one is not a trade", () => {
    // roborev 55893 restored this case; the trade rules must not take it away again.
    for (const kind of GOAL_VERIFY_KINDS) {
      expect(mayReplaceVerify(undefined, sample(kind)), kind).toBe(true);
    }
  });
});

describe("describeGoalVerify", () => {
  it("renders every kind, and says so when no check was stated", () => {
    expect(describeGoalVerify({ kind: "command", cmd: "npm test" })).toContain("npm test");
    expect(describeGoalVerify({ kind: "landed" })).toContain("origin/main");
    expect(describeGoalVerify({ kind: "human" })).toContain("person");
    // ABSENT must read as absent, never as a check that exists.
    expect(describeGoalVerify(undefined)).toBe("no check stated");
  });
});
