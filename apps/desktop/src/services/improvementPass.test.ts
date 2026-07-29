import { describe, expect, it } from "vitest";
import {
  hourlyMissionPrompt,
  hourlySlotStamp,
  IMPROVEMENT_INTERVAL_MS,
  IMPROVEMENT_TICK_MS,
  isHourlySlotDue,
  MAX_SNAP_BACK_MS,
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

  it("holds the slot instead of spending it on a known-offline launch", () => {
    // The slot is due and nothing else blocks — only connectivity does. The pass needs the
    // network from its first step, so running now would buy a certain failure and, because the
    // scheduler stamps the clock at attempt time, forfeit the whole hour.
    expect(shouldRunImprovementPass(gate({ isOnline: false }))).toBe(false);
    expect(shouldRunImprovementPass(gate({ isOnline: true }))).toBe(true);
    // Callers that don't model connectivity read as online, matching connectionStore's own
    // optimistic default — so omitting the field can never silently mute the scheduler.
    expect(shouldRunImprovementPass(gate({ isOnline: undefined }))).toBe(true);
  });

  it("does not let an armed retry fire into a network that is still down", () => {
    // The shape this guards: a machine wakes from sleep, the pass dies unreachable, and the
    // one re-attempt lands minutes later on the same dead network — spending the slot's whole
    // budget without a single request reaching the API.
    const armed = { lastRunAt: 0, now: HOUR / 2, retryDueAt: 0 };
    expect(shouldRunImprovementPass(gate({ ...armed, isOnline: false }))).toBe(false);
    expect(shouldRunImprovementPass(gate({ ...armed, isOnline: true }))).toBe(true);
  });

  it("stays due once connectivity returns, rather than waiting out another hour", () => {
    // The point of skipping is that the clock is untouched, so the same slot is still due on
    // the very next tick — well past the hour, since offline time keeps accruing against it.
    const offline = { lastRunAt: 0, now: HOUR * 3, isOnline: false };
    expect(shouldRunImprovementPass(gate(offline))).toBe(false);
    expect(shouldRunImprovementPass(gate({ ...offline, isOnline: true }))).toBe(true);
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

  // The auto-feedback-on-merge loop files merged workers' retros into the `agent-feedback` beads
  // inbox; the hourly pass must drain it FIRST, before mining logs — the same order the persona
  // uses. Named here too because this prompt is the LAST thing the model reads.
  it("both modes name the agent-feedback inbox and drain it before mining logs", () => {
    for (const mode of ["always", "case_by_case"] as const) {
      const p = hourlyMissionPrompt(mode);
      expect(p).toContain("bd list --label agent-feedback");
      // Ordered ahead of the log-mining sentence.
      expect(p.indexOf("agent-feedback")).toBeLessThan(p.indexOf("session logs"));
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

describe("hourlySlotStamp", () => {
  it("snaps a late tick back to its slot boundary, so lateness is not inherited", () => {
    // The tick noticed the slot 9s after it came due. Recording HOUR + 9_000 would move every
    // later boundary by 9s as well; the boundary itself is HOUR.
    expect(hourlySlotStamp(0, HOUR + 9_000)).toBe(HOUR);
  });

  it("does not drift across many slots, however late each tick lands", () => {
    // The regression this exists for: measured session logs showed the pass walking ~40 minutes
    // later over 30 hours. Replay 30 slots, each noticed a (varying) moment late, and the phase
    // must still be exactly the starting phase.
    let stamp = 0;
    for (let slot = 1; slot <= 30; slot++) {
      const lateBy = (slot % 7) * 20_000; // 0–120s late, inside the snap-back window
      stamp = hourlySlotStamp(stamp, stamp + HOUR + lateBy);
    }
    expect(stamp).toBe(30 * HOUR);
  });

  it("catches up to the LATEST missed boundary, not the first, after a short sleep", () => {
    // Six slots elapsed while the machine slept, and the wake tick landed within the snap-back
    // window. Stamping the FIRST missed boundary would leave five still due and fire five
    // back-to-back passes.
    expect(hourlySlotStamp(0, 6 * HOUR + 30_000)).toBe(6 * HOUR);
  });

  it("never rewinds far enough to let a second pass follow the first", () => {
    // The regression the bound exists for: a 6h55m sleep leaves a 55-minute remainder, and an
    // unbounded snap would stamp 55 minutes ago — so the very next tick sees a due slot and
    // launches a second full pass minutes after the catch-up one.
    const stamp = hourlySlotStamp(0, 6 * HOUR + 55 * 60_000);
    expect(stamp).toBe(6 * HOUR + 55 * 60_000); // kept `now`, not snapped
    expect(isHourlySlotDue(stamp, stamp + IMPROVEMENT_TICK_MS)).toBe(false);
  });

  it("keeps consecutive attempts at least an interval minus the snap-back apart", () => {
    // The guarantee stated on MAX_SNAP_BACK_MS, checked across every remainder at tick
    // granularity rather than at a few hand-picked points.
    for (let extra = 0; extra < HOUR; extra += 60_000) {
      const now = 3 * HOUR + extra;
      const stamp = hourlySlotStamp(0, now);
      expect(now - stamp).toBeLessThanOrEqual(MAX_SNAP_BACK_MS);
    }
  });

  it("leaves an off-grid re-attempt alone", () => {
    // The connectivity retry runs before its slot is due; it has no boundary of its own to snap
    // to, so the tick time stands.
    const midHour = HOUR / 2;
    expect(hourlySlotStamp(0, midHour)).toBe(midHour);
  });

  it("does not push the stamp forward when the clock moves backwards", () => {
    // A backwards clock adjustment makes `lastRunAt` sit in the future. A negative remainder
    // would stamp LATER than now and suppress real slots; `now` is the safe floor.
    expect(hourlySlotStamp(10 * HOUR, 2 * HOUR)).toBe(2 * HOUR);
  });
});
