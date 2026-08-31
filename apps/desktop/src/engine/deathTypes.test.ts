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
  "goal-discharged-on-git-proof",
  "epoch-dead",
  "session-vanished",
  "user-stop",
  "pty-exit",
  "session-end-hook",
  "startup-silent",
  "none",
] as const satisfies readonly DeathEvidence[];

const ALL_CAUSES = [
  "transport-transient",
  "wall-session",
  "wall-spend",
  "clean-goal-met",
  "blocked-on-human",
  "app-restart",
  "process-gone",
  "startup-no-show",
  "human-stopped",
  "unknown",
] as const satisfies readonly DeathCause[];

/**
 * THE LISTS ABOVE MUST COVER THE UNIONS, AND `satisfies` DOES NOT CHECK THAT (roborev 61705).
 *
 * The comment above claims a new union member "makes these arrays incomplete and TypeScript says
 * so". It does not. `as const satisfies readonly DeathCause[]` asserts every ENTRY is a valid
 * cause; it is silent about a MISSING one. So when `process-gone` was added to the union,
 * `ALL_CAUSES` quietly stopped being exhaustive and every list-driven assertion below began proving
 * its policy over a strict subset — "rejects any cause claimed on no evidence" never evaluated the
 * new cause, and "armsOnClock is true for exactly one cause" became a claim about 7 of 8 members.
 * Nothing failed, which is the whole problem: a guard enumerated by VALUE goes stale in silence.
 *
 * This asks the other direction — is the UNION assignable to the listed members? A missing member
 * makes `[Union] extends [Listed]` false, the type resolves to `never`, and `= true` stops
 * compiling. Compile-time, so `tsc --noEmit` catches it even if nobody runs this suite.
 */
type CoversUnion<Union, Listed extends Union> = [Union] extends [Listed] ? true : never;
const _allCausesAreExhaustive: CoversUnion<DeathCause, (typeof ALL_CAUSES)[number]> = true;
const _allEvidenceIsExhaustive: CoversUnion<DeathEvidence, (typeof ALL_EVIDENCE)[number]> = true;

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

  it("RECOVERS an unexplained death — and refuses the deliberate stop that used to hide inside it", () => {
    // ⚠️ THIS ASSERTION WAS INVERTED UNTIL 2026-08-13, and the inversion was never about `unknown`.
    // `agent_life::mark_stopped_at` — the ledger half of "the user clicked stop" — wrote
    // `{cause: unknown, evidence: pty-exit}`, and an ordinary crash lands on the same pair. One
    // cause, two meanings, so the only safe policy over the union was to refuse both. The cost, on
    // the founder's v0.95.0 install: 25 of 76 records were exactly that pair and every one was
    // structurally unrecoverable, painting red at a human who could do nothing about it.
    //
    // The two are asserted TOGETHER because neither is safe alone. The flip is only defensible
    // because the stop now has somewhere else to live.
    expect(isResurrectable("unknown")).toBe(true);
    expect(isResurrectable("human-stopped")).toBe(false);
  });

  it("gives the stop its own evidence, so nothing has to INFER it from a closed PTY", () => {
    // `user-stop` is written from inside the stop path by the code performing it; `pty-exit` is what
    // a window sees from outside and is compatible with every cause there is. Keeping `pty-exit`
    // pointed at `unknown` is the other half — re-point it and every crash becomes unrecoverable
    // again, with the whole change bought for nothing.
    expect(causeOf("user-stop")).toBe("human-stopped");
    expect(causeOf("pty-exit")).toBe("unknown");
    expect(verdictIsSupported({ cause: "human-stopped", evidence: "user-stop" })).toBe(true);
    expect(verdictIsSupported({ cause: "human-stopped", evidence: "pty-exit" })).toBe(false);
    expect(verdictIsSupported({ cause: "unknown", evidence: "user-stop" })).toBe(false);
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

  it("DOES resurrect a vanished process — and no longer needs an asymmetry with `unknown` to do it", () => {
    // This used to be the PAIR `process-gone: true` / `unknown: false`, which read as a
    // contradiction (both are "the agent is gone and nothing explained why") and was defended by a
    // discriminator about WHO WAS WATCHING: `process-gone` is inferred from an absence with no
    // observer, which is the one case a deliberate stop cannot produce — so it escaped a refusal
    // that existed only to protect the stop hiding inside `unknown`.
    //
    // It was a workaround, and the workaround is gone: the stop has its own cause, so both are
    // simply eligible. The distinction survives for a different reason — the two recover at
    // different PACES — which is what the second assertion pins.
    expect(isResurrectable("process-gone")).toBe(true);
    expect(isResurrectable("unknown")).toBe(true);
    // Still a real distinction, and collapsing them would slow every reaped agent to the 30-minute
    // rung for nothing.
    expect(causeOf("session-vanished")).toBe("process-gone");
    expect(causeOf("pty-exit")).toBe("unknown");
  });

  it("pairs `process-gone` with the evidence that is its ONLY support", () => {
    // The invariant `verdictIsSupported` enforces, asserted from both ends so the cause and its
    // evidence cannot drift apart (roborev 61705): the reaper's evidence supports this cause and
    // nothing else, and the cause is supported by that evidence and nothing else. The first
    // version shared `pty-exit`, which made this predicate FALSE for every record the reaper
    // writes — the module's honesty rule stated but untrue.
    expect(causeOf("session-vanished")).toBe("process-gone");
    expect(verdictIsSupported({ cause: "process-gone", evidence: "session-vanished" })).toBe(true);
    // `pty-exit` means a window WATCHED the close, so it can never support an unobserved inference.
    expect(verdictIsSupported({ cause: "process-gone", evidence: "pty-exit" })).toBe(false);
    expect(verdictIsSupported({ cause: "unknown", evidence: "session-vanished" })).toBe(false);
  });

  it("never arms `process-gone` on a clock — it falls to the ladder", () => {
    expect(armsOnClock("process-gone")).toBe(false);
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
