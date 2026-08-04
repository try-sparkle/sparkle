// The ONE property: a goal's check is explicit, and a `human`-verified goal cannot be closed by the
// agent that claimed it.
//
// SCOPE, stated honestly because the first version of this header got it wrong: `canSelfMarkMet` is
// the rule `set_agent_goal_met` is INTENDED to gate on, and at the time of writing nothing outside
// this module calls it (roborev 55842 — the header claimed the wiring in the present tense while
// `.claude/commands/goal.md` in the same commit said the opposite). These tests pin the RULE. The
// commit that wires it is what makes the gate real; until then this is a rule with no enforcer.
import { describe, it, expect } from "vitest";
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
  type VerifyVerdict,
} from "./goalVerify";

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
    const notLanded = selfMarkRefusal({ kind: "landed" }, { landed: false });
    const unread = selfMarkRefusal({ kind: "landed" }, {});
    expect(notLanded).toMatch(/not (yet )?on origin\/main|is not on origin\/main/i);
    expect(unread).toMatch(/has not been read|not been polled|no reading/i);
    expect(notLanded).not.toEqual(unread);
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
  const OMNISCIENT = { landed: true };

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
