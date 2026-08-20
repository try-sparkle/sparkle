import { describe, it, expect } from "vitest";

import { GOAL_MAX_LEN, GOAL_MIN_LEN } from "@sparkle/core";

import {
  EPIC_GOAL_VERIFY_KINDS,
  epicGoalTextRejection,
  epicVerifyOf,
  failedEpicGoal,
  hasEpicGoalText,
  inferEpicVerify,
  isEpicVerifyKind,
  mayAutoGenerate,
  newEpicGoal,
  type EpicGoal,
} from "./epicGoal";

const NOW = 1_700_000_000_000;
const OK_TEXT = "every epic on the board shows a goal a human can read";

describe("epicVerifyOf — the ONE narrowing of the inherited vocabulary", () => {
  it("keeps command and human", () => {
    expect(epicVerifyOf({ kind: "command", cmd: "pnpm verify" })).toEqual({
      kind: "command",
      cmd: "pnpm verify",
    });
    expect(epicVerifyOf({ kind: "human" })).toEqual({ kind: "human" });
  });

  it("REFUSES landed — an epic has no branch, so nothing could ever supply the evidence", () => {
    expect(epicVerifyOf({ kind: "landed" })).toEqual({ kind: "human" });
  });

  it("falls back to human rather than DROPPING the check — dropping would be a widening", () => {
    // A dropped check leaves the goal self-markable. The repo's standing rule is that inference may
    // only ever move a goal TOWARD a machine-checkable check, never away from one; `human` is the
    // only direction available here, and `undefined` would be the wrong one.
    expect(epicVerifyOf({ kind: "landed" })).not.toBeUndefined();
  });

  it("leaves an absent check absent", () => {
    expect(epicVerifyOf(undefined)).toBeUndefined();
  });

  it("its kind list and its predicate cannot drift apart", () => {
    for (const k of EPIC_GOAL_VERIFY_KINDS) expect(isEpicVerifyKind(k)).toBe(true);
    expect(isEpicVerifyKind("landed")).toBe(false);
  });
});

describe("inferEpicVerify — landing words must not buy an epic an ancestry proof", () => {
  it("landing-shaped text that would infer `landed` for an agent infers `human` for an epic", () => {
    const v = inferEpicVerify("the epic goal PR is merged to main");
    expect(v).toEqual({ kind: "human" });
  });

  it("ordinary text still infers nothing", () => {
    expect(inferEpicVerify("the board feels calmer to use")).toBeUndefined();
  });
});

describe("epicGoalTextRejection — one hallucinated word is not a goal", () => {
  it("accepts usable text", () => {
    expect(epicGoalTextRejection(OK_TEXT)).toBeNull();
  });

  it("rejects empty and whitespace", () => {
    expect(epicGoalTextRejection("")).toBe("empty");
    expect(epicGoalTextRejection("   \n ")).toBe("empty");
  });

  it("rejects text under the shared worker-goal floor", () => {
    expect(epicGoalTextRejection("x".repeat(GOAL_MIN_LEN - 1))).toMatch(/too short/);
    expect(epicGoalTextRejection("x".repeat(GOAL_MIN_LEN))).toBeNull();
  });

  it("rejects text over the shared ceiling", () => {
    expect(epicGoalTextRejection("x".repeat(GOAL_MAX_LEN + 1))).toMatch(/too long/);
  });
});

describe("newEpicGoal", () => {
  it("records the source, and stamps the human latch ONLY for a human", () => {
    expect(newEpicGoal(OK_TEXT, NOW, "auto").humanEditedAt).toBeUndefined();
    expect(newEpicGoal(OK_TEXT, NOW, "human").humanEditedAt).toBe(NOW);
  });

  it("narrows the verify it is handed", () => {
    expect(newEpicGoal(OK_TEXT, NOW, "human", { kind: "landed" }).verify).toEqual({ kind: "human" });
  });

  it("omits the verify KEY entirely when none was stated", () => {
    // Not `verify: undefined` — only the absent key survives a JSON round-trip through the
    // persisted store identically, and the absence is what marks a goal as unverified.
    expect("verify" in newEpicGoal(OK_TEXT, NOW, "auto")).toBe(false);
  });

  it("throws rather than storing a goal nobody could act on", () => {
    expect(() => newEpicGoal("  ", NOW, "human")).toThrow(/usable text/);
    expect(() => newEpicGoal("tiny", NOW, "auto")).toThrow(/too short/);
  });
});

describe("failedEpicGoal — an empty field is honest, a hallucinated one is worse than nothing", () => {
  it("writes NO text, and records why", () => {
    const f = failedEpicGoal(NOW, "the model call timed out");
    expect(f.text).toBe("");
    expect(f.generationFailedAt).toBe(NOW);
    expect(f.generationFailureReason).toBe("the model call timed out");
    expect(hasEpicGoalText(f)).toBe(false);
  });

  it("a failed generation NEVER erases the human latch", () => {
    const prior: EpicGoal = newEpicGoal(OK_TEXT, NOW - 1_000, "human");
    expect(failedEpicGoal(NOW, "boom", prior).humanEditedAt).toBe(prior.humanEditedAt);
  });

  it("…nor his TEXT — a failed FORCE regenerate records the failure BESIDE the goal", () => {
    // roborev 65849, and this is the finding that mattered. `mayAutoGenerate` refuses a record that
    // already has text unless FORCED, so the only way to reach here holding a goal is a person
    // asking to regenerate one they can see. Returning a bare `text: ""` meant "regenerate this" +
    // a timeout DESTROYED his wording — the exact failure this module exists to prevent, arriving
    // through the feature meant to protect it. The old assertion (latch only) passed either way.
    const prior: EpicGoal = newEpicGoal(OK_TEXT, NOW - 1_000, "human", { kind: "command", cmd: "pnpm verify" });
    const after = failedEpicGoal(NOW, "the model call timed out", prior);
    expect(after.text).toBe(prior.text);
    expect(after.verify).toEqual(prior.verify);
    expect(after.source).toBe("human");
    // …and `setAt` follows the TEXT, not the failure: a goal that survived was not re-set.
    expect(after.setAt).toBe(prior.setAt);
    expect(after.generationFailedAt).toBe(NOW);
    expect(hasEpicGoalText(after)).toBe(true);
  });

  it("…nor a MET mark — a failed regenerate says nothing about whether the goal was achieved", () => {
    // roborev 65856. `metAt` is part of EpicGoalShared and is written by `setEpicGoalMet`, so
    // dropping it meant a goal a human had marked met, then asked to regenerate, silently reverted
    // to UNMET the instant the call timed out — while showing the identical text. The prior test
    // builds `prior` without `metAt`, so it passes against both behaviours; this one cannot.
    const prior: EpicGoal = { ...newEpicGoal(OK_TEXT, NOW - 1_000, "human"), metAt: NOW - 500 };
    expect(failedEpicGoal(NOW, "boom", prior).metAt).toBe(NOW - 500);
  });

  it("a failure over an epic with NO prior goal carries no met mark from nowhere", () => {
    // The paired direction, so the rule above cannot pass by always emitting a `metAt`.
    expect(failedEpicGoal(NOW, "boom").metAt).toBeUndefined();
    expect("metAt" in failedEpicGoal(NOW, "boom")).toBe(false);
  });
});

describe("mayAutoGenerate — the latch", () => {
  it("generates for an epic that has no record at all", () => {
    expect(mayAutoGenerate(undefined)).toBe(true);
  });

  it("REFUSES once a human has written the goal — permanently", () => {
    expect(mayAutoGenerate(newEpicGoal(OK_TEXT, NOW, "human"))).toBe(false);
  });

  it("still refuses after a human's text is later cleared — the latch outlives the text", () => {
    // The distinction from `source === "human"`: a human clear leaves an empty auto-shaped record,
    // and reading only `source` would re-open the door to the machine overwriting his wording.
    const clearedByHuman: EpicGoal = { text: "", setAt: NOW, source: "auto", humanEditedAt: NOW - 1 };
    expect(mayAutoGenerate(clearedByHuman)).toBe(false);
  });

  it("does not regenerate over an auto goal that already has text", () => {
    expect(mayAutoGenerate(newEpicGoal(OK_TEXT, NOW, "auto"))).toBe(false);
  });

  it("does not retry a failed generation on its own", () => {
    expect(mayAutoGenerate(failedEpicGoal(NOW, "timed out"))).toBe(false);
  });

  it("force overrides EVERY refusal — an explicit human ask is the one thing that beats the latch", () => {
    for (const rec of [
      newEpicGoal(OK_TEXT, NOW, "human"),
      newEpicGoal(OK_TEXT, NOW, "auto"),
      failedEpicGoal(NOW, "timed out"),
      undefined,
    ]) {
      expect(mayAutoGenerate(rec, true)).toBe(true);
    }
  });
});
