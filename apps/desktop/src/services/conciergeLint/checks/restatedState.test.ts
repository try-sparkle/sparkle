import { describe, expect, it } from "vitest";
import type { CheckPolicy, LintContext } from "../types";
import { DEFAULT_RESTATED_STATE_THRESHOLD, restatedStateCheck } from "./restatedState";

const ctx = (prevReply: string | null, policy: Partial<CheckPolicy> = {}): LintContext => ({
  roster: [],
  toolCalls: [],
  refusals: [],
  prevReply,
  policy: {
    enabled: true,
    log: false,
    logMatches: false,
    checks: {
      "restated-state": {
        enabled: true,
        severity: "warn",
        autofix: false,
        ...policy,
      },
    },
  },
});

const run = (text: string, prevReply: string | null, policy: Partial<CheckPolicy> = {}) =>
  restatedStateCheck.run(text, ctx(prevReply, policy));

/** A block of unchanged-state prose comfortably past the 200-character default. */
const UNCHANGED = [
  "Kraken Auth is still on step three of the migration and has not committed since 14:02.",
  "Left Pair is idle with a clean worktree. Docs (web) is blocked on the same review it was",
  "blocked on last turn, and nothing else in the fleet has moved.",
].join(" ");

describe("restatedStateCheck", () => {
  it("is a no-op on the first reply of a thread", () => {
    expect(UNCHANGED.length).toBeGreaterThan(DEFAULT_RESTATED_STATE_THRESHOLD);
    expect(run(UNCHANGED, null).violations).toEqual([]);
  });

  it("reports a long verbatim repeat of the previous reply", () => {
    const prev = `Status:\n\n${UNCHANGED}`;
    const { violations } = run(`Still nothing new.\n\n${UNCHANGED}`, prev);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      check: "restated-state",
      severity: "warn",
      action: "warned",
    });
    expect(violations[0]!.span).toBeGreaterThanOrEqual(UNCHANGED.length);
  });

  it("sees through re-wrapping of the repeated block", () => {
    const rewrapped = UNCHANGED.replace(/ /g, "\n");
    expect(run(rewrapped, UNCHANGED).violations).toHaveLength(1);
  });

  it("leaves the reply text untouched — this check never rewrites", () => {
    const reply = `Still nothing new.\n\n${UNCHANGED}`;
    expect(run(reply, UNCHANGED).text).toBe(reply);
  });

  it("stays quiet when the shared run is below the threshold", () => {
    const boilerplate = "Here is where the fleet stands right now."; // 41 chars, well under 200
    expect(boilerplate.length).toBeLessThan(DEFAULT_RESTATED_STATE_THRESHOLD);
    const prev = `${boilerplate} Kraken Auth finished the migration and opened PR #918.`;
    const next = `${boilerplate} Left Pair hit a merge conflict on the theme tokens branch.`;
    expect(run(next, prev).violations).toEqual([]);
  });

  it("uses the policy threshold rather than the default", () => {
    const prev = "Here is where the fleet stands right now, and nothing has changed since.";
    const next = `${prev} Still waiting.`;
    expect(run(next, prev, { threshold: 300 }).violations).toEqual([]);
    expect(run(next, prev, { threshold: 20 }).violations).toHaveLength(1);
  });

  it("carries the policy's severity onto the violation", () => {
    const violations = run(UNCHANGED, UNCHANGED, {
      severity: "block",
    }).violations;
    expect(violations[0]!.severity).toBe("block");
  });

  it("treats an empty previous reply as nothing to repeat", () => {
    expect(run(UNCHANGED, "").violations).toEqual([]);
  });
});
