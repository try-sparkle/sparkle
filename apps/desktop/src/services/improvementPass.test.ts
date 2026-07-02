import { describe, expect, it } from "vitest";
import {
  hourlyMissionPrompt,
  IMPROVEMENT_INTERVAL_MS,
  parseImproveResult,
  shouldRunImprovementPass,
  type PassGate,
} from "./improvementPass";

const HOUR = IMPROVEMENT_INTERVAL_MS;

function gate(overrides: Partial<PassGate> = {}): PassGate {
  return {
    consent: "case_by_case",
    lastRunAt: 0,
    now: HOUR, // exactly one interval elapsed — due by default
    passRunning: false,
    paneStatus: undefined,
    ...overrides,
  };
}

describe("shouldRunImprovementPass", () => {
  it("runs when an hour has elapsed and nothing blocks", () => {
    expect(shouldRunImprovementPass(gate())).toBe(true);
    expect(shouldRunImprovementPass(gate({ consent: "always" }))).toBe(true);
  });

  it("never runs under 'never' consent", () => {
    expect(shouldRunImprovementPass(gate({ consent: "never" }))).toBe(false);
  });

  it("waits out the hour", () => {
    expect(shouldRunImprovementPass(gate({ now: HOUR - 1 }))).toBe(false);
  });

  it("does not run when a pass is already in flight", () => {
    expect(shouldRunImprovementPass(gate({ passRunning: true }))).toBe(false);
  });

  it("does not run while the interactive pane session is actively working", () => {
    expect(shouldRunImprovementPass(gate({ paneStatus: "working" }))).toBe(false);
    // A quiescent pane (idle/done) doesn't block — the pass resumes cleanly afterwards.
    expect(shouldRunImprovementPass(gate({ paneStatus: "idle" }))).toBe(true);
    expect(shouldRunImprovementPass(gate({ paneStatus: "done" }))).toBe(true);
  });

  it("defers to the scheduler's seeding when the clock was never set", () => {
    expect(shouldRunImprovementPass(gate({ lastRunAt: null }))).toBe(false);
  });
});

describe("parseImproveResult", () => {
  it("parses the trailing marker", () => {
    const text =
      'Did the thing.\nIMPROVE_RESULT: {"submitted": 1, "awaitingApproval": 0, "summary": "fixed retry loop"}';
    expect(parseImproveResult(text)).toEqual({
      submitted: 1,
      awaitingApproval: 0,
      summary: "fixed retry loop",
    });
  });

  it("uses the LAST marker when the model quotes the format earlier", () => {
    const text = [
      'The required line looks like IMPROVE_RESULT: {"submitted": 9, "awaitingApproval": 9, "summary": "example"}.',
      "…work…",
      'IMPROVE_RESULT: {"submitted": 0, "awaitingApproval": 1, "summary": "drafted PR"}',
    ].join("\n");
    expect(parseImproveResult(text)?.awaitingApproval).toBe(1);
    expect(parseImproveResult(text)?.submitted).toBe(0);
  });

  it("fills defaults for missing fields and returns null for absent/broken markers", () => {
    expect(parseImproveResult('IMPROVE_RESULT: {"summary": "no-op"}')).toEqual({
      submitted: 0,
      awaitingApproval: 0,
      summary: "no-op",
    });
    expect(parseImproveResult("no marker here")).toBeNull();
    expect(parseImproveResult("IMPROVE_RESULT: {broken json}")).toBeNull();
  });
});

describe("hourlyMissionPrompt", () => {
  it("always mode instructs auto-submit gated on the scrub script", () => {
    const p = hourlyMissionPrompt("always");
    expect(p).toContain("gh pr create");
    expect(p).toContain("scripts/sparkle-scrub.sh");
    expect(p).toContain("no approval step");
  });

  it("case-by-case mode forbids submission and asks for a presented draft", () => {
    const p = hourlyMissionPrompt("case_by_case");
    expect(p).toContain("do NOT run");
    expect(p).toContain("scripts/sparkle-scrub.sh");
    expect(p).not.toContain("no approval step");
  });

  it("both modes demand the structured trailer", () => {
    for (const mode of ["always", "case_by_case"] as const) {
      expect(hourlyMissionPrompt(mode)).toContain("IMPROVE_RESULT:");
    }
  });
});
