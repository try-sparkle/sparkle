import { describe, expect, it } from "vitest";

import {
  type DeathCause,
  type DeathEvidence,
  type DeathVerdict,
  armsOnClock,
  causeOf,
  isResurrectable,
  verdictIsSupported,
} from "./deathTypes";

// Listed by hand rather than derived from the module, so ADDING a variant without deciding its rules
// breaks the build here instead of silently inheriting a default. The `satisfies` clauses are what
// make that true — a new union member makes these arrays incomplete and TypeScript says so.
const ALL_EVIDENCE = [
  "quota-block",
  "transcript-429",
  "api-banner",
  "blocking-tool",
  "goal-met-marked",
  "epoch-dead",
  "pty-exit",
  "session-end-hook",
  "none",
] as const satisfies readonly DeathEvidence[];

const ALL_CAUSES = [
  "transport-transient",
  "wall-session",
  "wall-spend",
  "clean-goal-met",
  "blocked-on-human",
  "app-restart",
  "unknown",
] as const satisfies readonly DeathCause[];

describe("causeOf", () => {
  it("is total over every evidence value", () => {
    for (const e of ALL_EVIDENCE) {
      const got = causeOf(e);
      expect(got === null || ALL_CAUSES.includes(got as (typeof ALL_CAUSES)[number])).toBe(true);
    }
  });

  it("leaves ONLY the two wall evidences undecided, because resetParsed is the discriminator", () => {
    const undecided = ALL_EVIDENCE.filter((e) => causeOf(e) === null);
    expect(undecided).toEqual(["quota-block", "transcript-429"]);
  });

  it("maps no-evidence to unknown, never to a real cause", () => {
    expect(causeOf("none")).toBe("unknown");
  });

  it("does not let a bare PTY exit or SessionEnd claim a cause", () => {
    // The measured trap: a local PTY carries NO exit code, so "the process ended" is compatible with
    // every cause there is. Reading a real cause out of it would fabricate one.
    expect(causeOf("pty-exit")).toBe("unknown");
    expect(causeOf("session-end-hook")).toBe("unknown");
  });
});

describe("verdictIsSupported — the honesty rule", () => {
  it("rejects any cause claimed on no evidence", () => {
    for (const cause of ALL_CAUSES) {
      const v: DeathVerdict = { cause, evidence: "none", goalMetAt: 1 };
      expect(verdictIsSupported(v)).toBe(cause === "unknown");
    }
  });

  it("rejects clean-goal-met without a positive goalMetAt", () => {
    const withoutMark: DeathVerdict = { cause: "clean-goal-met", evidence: "goal-met-marked" };
    expect(verdictIsSupported(withoutMark)).toBe(false);

    const withMark: DeathVerdict = {
      cause: "clean-goal-met",
      evidence: "goal-met-marked",
      goalMetAt: 1_754_531_990_000,
    };
    expect(verdictIsSupported(withMark)).toBe(true);
  });

  it("rejects a wall-spend that carries a resetAt", () => {
    // A spend cap has NO reset instant. `parseResetInstant` returns a bounded 5h re-check fallback
    // for it; persisting that as `resetAt` turns a re-check into a claim about when money appears,
    // and a clock-armed recovery would then fire into a door only a human opens.
    const fabricated: DeathVerdict = {
      cause: "wall-spend",
      evidence: "quota-block",
      wall: {
        message: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
        resetAt: 1_754_552_400_000,
        resetParsed: false,
        observedAt: 1_754_534_400_000,
      },
    };
    expect(verdictIsSupported(fabricated)).toBe(false);

    const honest: DeathVerdict = {
      ...fabricated,
      wall: { ...fabricated.wall!, resetAt: undefined },
    };
    expect(verdictIsSupported(honest)).toBe(true);
  });

  it("lets a session limit keep its parsed reset", () => {
    const v: DeathVerdict = {
      cause: "wall-session",
      evidence: "quota-block",
      wall: {
        message: "You've hit your session limit · resets 10:30pm (America/Los_Angeles)",
        resetAt: 1_754_552_400_000,
        resetParsed: true,
        observedAt: 1_754_534_400_000,
      },
    };
    expect(verdictIsSupported(v)).toBe(true);
  });

  it("rejects a cause its evidence cannot support", () => {
    // A blocking-tool hook cannot mean the goal was met, and an api-banner cannot mean the app died.
    expect(verdictIsSupported({ cause: "clean-goal-met", evidence: "blocking-tool", goalMetAt: 1 })).toBe(
      false,
    );
    expect(verdictIsSupported({ cause: "app-restart", evidence: "api-banner" })).toBe(false);
    expect(verdictIsSupported({ cause: "transport-transient", evidence: "api-banner" })).toBe(true);
  });
});

describe("isResurrectable", () => {
  it("never brings back an agent that finished, or one waiting on a person", () => {
    expect(isResurrectable("clean-goal-met")).toBe(false);
    expect(isResurrectable("blocked-on-human")).toBe(false);
  });

  it("refuses an unclassified death — the one case where being wrong loops on a real fault", () => {
    expect(isResurrectable("unknown")).toBe(false);
  });

  it("DOES resurrect a spend cap, because it is probed rather than waited on", () => {
    // The correction that matters: a spend cap cannot be armed on a clock, but the fleet still comes
    // back by itself the moment a probe succeeds. Notifying the founder is a byproduct, never the
    // resolution.
    expect(isResurrectable("wall-spend")).toBe(true);
  });

  it("resurrects the transient and app-restart cases", () => {
    expect(isResurrectable("transport-transient")).toBe(true);
    expect(isResurrectable("wall-session")).toBe(true);
    expect(isResurrectable("app-restart")).toBe(true);
  });
});

describe("armsOnClock", () => {
  it("is true for exactly one cause, so the revival thread needs no date arithmetic elsewhere", () => {
    const onClock = ALL_CAUSES.filter(armsOnClock);
    expect(onClock).toEqual(["wall-session"]);
  });

  it("never arms a spend cap on a clock", () => {
    expect(armsOnClock("wall-spend")).toBe(false);
  });
});
