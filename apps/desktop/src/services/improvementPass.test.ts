import { describe, expect, it } from "vitest";
import {
  hourlyMissionPrompt,
  IMPROVEMENT_INTERVAL_MS,
  isTransientPassFailure,
  PASS_BUDGET_MINUTES,
  PASS_TIMEOUT_MS,
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

  it("an armed retry runs before the hour is up, but only once it comes due", () => {
    const midHour = { lastRunAt: 0, now: HOUR / 2 };
    expect(shouldRunImprovementPass(gate({ ...midHour }))).toBe(false);
    expect(shouldRunImprovementPass(gate({ ...midHour, retryDueAt: HOUR / 2 + 1 }))).toBe(false);
    expect(shouldRunImprovementPass(gate({ ...midHour, retryDueAt: HOUR / 2 }))).toBe(true);
  });

  it("a due retry still respects the guards that protect the worktree", () => {
    const armed = { lastRunAt: 0, now: HOUR / 2, retryDueAt: 0 };
    expect(shouldRunImprovementPass(gate(armed))).toBe(true);
    expect(shouldRunImprovementPass(gate({ ...armed, consent: "never" }))).toBe(false);
    expect(shouldRunImprovementPass(gate({ ...armed, passRunning: true }))).toBe(false);
    expect(shouldRunImprovementPass(gate({ ...armed, paneStatus: "working" }))).toBe(false);
    expect(shouldRunImprovementPass(gate({ ...armed, lastRunAt: null }))).toBe(false);
  });
});

describe("isTransientPassFailure", () => {
  it("recognizes the connectivity shapes a failed pass reports", () => {
    // The exact phrasing seen in the field when the network drops mid-pass.
    expect(isTransientPassFailure("API Error: Unable to connect to API (ENOTFOUND)")).toBe(true);
    expect(isTransientPassFailure("read ECONNRESET")).toBe(true);
    expect(isTransientPassFailure("socket hang up")).toBe(true);
    expect(isTransientPassFailure("getaddrinfo EAI_AGAIN api.example")).toBe(true);
  });

  it("recognizes a stream that died partway through", () => {
    // The dominant failure in practice, verbatim as the pass reports it: the API WAS reached
    // and the response was cut off, so none of the pre-flight connectivity patterns match.
    expect(
      isTransientPassFailure(
        "API Error: Connection closed mid-response. The response above may be incomplete.",
      ),
    ).toBe(true);
    expect(
      isTransientPassFailure(
        "API Error: Response stalled mid-stream. The response above may be incomplete.",
      ),
    ).toBe(true);
  });

  it("leaves real failures to wait out the hour", () => {
    expect(isTransientPassFailure("exited with code 1")).toBe(false);
    expect(isTransientPassFailure("pass timed out after 30 minutes and was killed")).toBe(false);
    expect(isTransientPassFailure("")).toBe(false);
    // A spend/usage limit would fail again immediately — burning the retry on it helps nobody.
    expect(isTransientPassFailure("You've hit your monthly spend limit")).toBe(false);
    expect(isTransientPassFailure("Claude usage limit reached")).toBe(false);
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

  // The mission prompt is the LAST thing the model reads, so it must not contradict the persona's
  // propose-only override on the one instruction that cannot succeed.
  it("drops the submit instruction entirely when this machine cannot open PRs", () => {
    const p = hourlyMissionPrompt("always", "noPush");
    expect(p).toContain("PROPOSE-ONLY");
    expect(p).toContain("Do not run `gh pr create`");
    expect(p).not.toContain("no approval step");
    expect(p).toContain("IMPROVE_RESULT:"); // still a structured, non-failing outcome
  });

  it("keeps the normal submit instruction when the probe was inconclusive", () => {
    expect(hourlyMissionPrompt("always", "unknown")).toContain("no approval step");
    expect(hourlyMissionPrompt("always", "canSubmit")).toContain("no approval step");
  });

  // The worktree is reused, so a pass killed mid-run leaves its edits and branch behind for the
  // next one to trip over. Both modes must be told, and told BEFORE the disposition that decides
  // what happens to a commit — a leftover edit folded into a PR is the failure being prevented.
  it("both modes warn that a killed pass may have left the worktree dirty", () => {
    for (const mode of ["always", "case_by_case"] as const) {
      const p = hourlyMissionPrompt(mode);
      expect(p).toContain("git status");
      expect(p).toContain("leftovers");
      expect(p).toContain("origin/main");
      expect(p.indexOf("leftovers")).toBeLessThan(p.indexOf("scripts/sparkle-scrub.sh"));
    }
  });

  // The pass runs against a hard watchdog wall. Left unstated, it budgets as if time were
  // unbounded and the SIGKILL takes everything it hadn't committed — and strands the worktree
  // for the next pass on top of that.
  it("both modes state the time budget and how to survive it", () => {
    for (const mode of ["always", "case_by_case"] as const) {
      const p = hourlyMissionPrompt(mode);
      expect(p).toContain(`about ${PASS_BUDGET_MINUTES} minutes`);
      expect(p).toContain("watchdog kills this pass");
      expect(p).toContain("committing each self-contained piece"); // durable-as-you-go
      expect(p).toContain("smaller change"); // land the finished narrow one
    }
  });

  // The number the prompt promises and the number the watchdog fires at must be ONE value: a
  // budget stated as 30 against a wall that fires at 20 is worse than stating none, because the
  // agent plans against a deadline it doesn't have. The prompt interpolates PASS_BUDGET_MINUTES,
  // so pinning that constant to the watchdog's own arithmetic is what keeps the two in step.
  it("states the budget the watchdog actually enforces", () => {
    expect(PASS_BUDGET_MINUTES).toBe(PASS_TIMEOUT_MS / 60000);
    expect(hourlyMissionPrompt("always")).toContain(
      `about ${PASS_TIMEOUT_MS / 60000} minutes`,
    );
  });
});
