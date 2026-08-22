import { beforeEach, describe, expect, it } from "vitest";
import { PASS_HOLD_TEXT } from "./pusherSnapshots";
import {
  LADDER_RETIREMENT_EXPLANATION,
  countLadderEscalateIt,
  PRIORITY_PROHIBITION,
  RETIRED_PRIORITY_LADDER_INSTRUCTION,
} from "./retiredLadderWordingTestUtils";
import {
  notePaneStatus,
  paneBusySinceAt,
  PANE_BUSY_HOLD_LIMIT_MS,
  resetPaneBusyForTests,
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
  passHoldReason,
} from "./improvementPass";
// The leaf the failure→colour rule lives in. Imported DIRECTLY (not through the service's
// re-export) so the identity assertion below has two genuinely independent references to compare.
import {
  classifyPassFailure,
  isTransientPassFailure as leafIsTransientPassFailure,
  passFailureStatus,
} from "../engine/passFailureStatus";

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

  // THE PREDICATE MOVED, THE EXPORT DID NOT. It now lives in the leaf `engine/passFailureStatus`
  // (the classifier needs it, and defining it here would make the two modules import each other);
  // this module re-exports it, so every importer above is unchanged. Pinned because a re-export is
  // exactly the kind of line a later tidy-up deletes as redundant.
  it("is the very function the classifier asks — one predicate, not two copies", () => {
    expect(isTransientPassFailure).toBe(leafIsTransientPassFailure);
  });
});

// ── WHAT COLOUR A FAILED PASS EARNS ─────────────────────────────────────────────────────────────
//
// The mapping itself is `engine/passFailureStatus`'s to prove; what this suite owns is that the two
// modules AGREE — that the transient list this service re-attempts and the transient class the
// classifier paints amber are the same set. Split across two files they could drift silently: a
// pattern added here would keep earning a retry while the row it produces stayed... also amber, and
// nobody would notice until a shape earned a retry AND a red row at the same time.
describe("the transient shapes and the amber tier are the same set", () => {
  const AT = Date.UTC(2026, 7, 22, 12, 0, 0);

  it.each([
    "API Error: Unable to connect to API (ENOTFOUND)",
    "read ECONNRESET",
    "socket hang up",
    "getaddrinfo EAI_AGAIN api.example",
    "API Error: Connection closed mid-response. The response above may be incomplete.",
    "API Error: Response stalled mid-stream. The response above may be incomplete.",
  ])("%j earns a re-attempt AND the amber row that says another actor is coming", (message) => {
    expect(isTransientPassFailure(message)).toBe(true);
    expect(passFailureStatus(classifyPassFailure(message, AT))).toBe("lapsed");
  });

  it("a failure that earns NO re-attempt is still amber — the hourly slot is the other actor", () => {
    // The 30-minute watchdog and the unknown shapes. Nothing is armed, and the row is amber anyway:
    // "another actor clears it" is satisfied by the next hourly pass, not only by an armed retry.
    for (const message of ["pass timed out after 30 minutes and was killed", "exited with code 1"]) {
      expect(isTransientPassFailure(message)).toBe(false);
      expect(passFailureStatus(classifyPassFailure(message, AT))).toBe("lapsed");
    }
  });

  it("an ACCOUNT WALL is the one shape that earns neither a re-attempt nor amber", () => {
    // Both halves matter: no retry (it would fail again) and RED (nothing in this app clears it).
    const wall = "You've hit your session limit · resets 8:40am (America/Bogota)";
    expect(isTransientPassFailure(wall)).toBe(false);
    expect(passFailureStatus(classifyPassFailure(wall, AT))).toBe("blocked");
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
      expect(p).toContain("agent-feedback");
      // Ordered ahead of the log-mining sentence.
      expect(p.indexOf("agent-feedback")).toBeLessThan(p.indexOf("session logs"));
    }
  });

  // ROUTED THROUGH TRIAGE, not a raw `bd list` — this prompt is the production consumer of the
  // inbox, so a ranking the script computes but the prompt never invokes is a feature that reaches
  // nobody. Triage is also the only thing that marks the beads whose fix already MERGED or already
  // LANDED on main; without it the pass picks finished work and re-investigates it, which is the
  // exact cost the script was written to remove.
  it("drains the inbox through retro-inbox-triage.sh rather than a raw bd list", () => {
    for (const mode of ["always", "case_by_case"] as const) {
      const p = hourlyMissionPrompt(mode);
      expect(p).toContain("scripts/retro-inbox-triage.sh");
      expect(p).not.toContain("bd list --label agent-feedback");
      // The ranking is worthless if the pass does not know what it is being told.
      expect(p).toMatch(/MERGED|LANDED/);
      // Ahead of the log-mining fallback, same as the drain itself.
      expect(p.indexOf("retro-inbox-triage.sh")).toBeLessThan(p.indexOf("session logs"));
    }
  });

  // ...AND WITH `--apply`, which is the half that was missing. Triage's age-out is the ONLY
  // mechanism that has ever removed a bead from this queue, and it is gated behind a flag the
  // prompt used to talk the pass OUT of ("a dry run that writes nothing, so it is always safe").
  // Every pass obeyed that, so the mechanism shipped and then never executed once: inflow ran at
  // roughly a pain point per pass while outflow stayed at zero, and the inbox went 415 -> 1500+.
  // Pin the flag ON THE INVOCATION, not merely somewhere in the prompt — a loose `--apply` in
  // adjacent prose is exactly the wording an agent does not act on.
  it("invokes triage with --apply, so the inbox is not a one-way queue", () => {
    for (const mode of ["always", "case_by_case"] as const) {
      const p = hourlyMissionPrompt(mode);
      expect(p).toContain("scripts/retro-inbox-triage.sh --apply");
      // The retired claim must be GONE, not merely contradicted later in the paragraph.
      expect(p).not.toMatch(/dry run that writes nothing/);
      expect(p).not.toMatch(/always safe to run/);
    }
  });

  // A RECURRENCE IS RECORDED, NOT ESCALATED — the same contract `sparkleAgent.test.ts` pins on the
  // other live prompt, asserted here so BOTH halves are defended rather than one. This prompt read
  // "(bumping its priority on recurrence)" until the ladder was retired 2026-08-09 (bead
  // sparkle-mzgqt): a comment count silently driving priority is what the founder ruled out, so
  // priority is set by a human and the sighting count feeds a separate (still unbuilt) severity
  // score. Leaving this half unguarded is precisely how the tenth site survived nine sweep passes —
  // unpinned prompt copy drifts back, and nothing goes red when it does. Positive AND negative on
  // purpose: the negative alone is vacuous (any rewrite satisfies it) and the positive alone would
  // pass with the retired instruction still sitting beside it. The negative is the SHARED pattern
  // (`retiredLadderWordingTestUtils.ts`), not a locally hand-written one — two guards for one contract drift
  // apart exactly the way two prompts do, which is the failure this whole sweep is about.
  it("tells the pass to RECORD a recurrence, never to bump the bead's priority", () => {
    for (const mode of ["always", "case_by_case"] as const) {
      const p = hourlyMissionPrompt(mode);
      expect(p).toContain("RECORD the recurrence");
      expect(p).toMatch(/priority is set by a human/i);
      // THE PROHIBITION AND ITS POLARITY, pinned as a positive because the negative structurally
      // cannot reach it. `/priority is set by a human/` is descriptive prose about who sets
      // priority, not an instruction to the agent — delete the "Do NOT move its priority" clause
      // and it still passes, `RECORD the recurrence` still passes (different sentence), and the
      // negative matches nothing because there is nothing left to match. All green, prompt no
      // longer telling the agent not to escalate. `move` can never join the negative's verb list
      // either, since it would fire on this very clause.
      expect(p).toMatch(PRIORITY_PROHIBITION);
      // ...AND the explanatory clause, which is load-bearing rather than decorative: "escalate IT"
      // is the exact wording that keeps `escalat` from colliding with the prompt's own prose, and
      // it is the only thing making `escalat` safe to have in the negative's verb list. A positive
      // cannot prove the absence of a contradictory sibling, so an "escalate it when the count
      // grows" added beside the prohibition would pass everything else — pinning the clause is what
      // stops the constraint being reworded away without anyone noticing it was carrying weight.
      expect(p).toMatch(LADDER_RETIREMENT_EXPLANATION);
      // EXACTLY ONCE. Pinning the clause stops it being reworded away; it does not stop a SECOND
      // "escalate it" being added beside it, which is the one re-entry no positive and no negative
      // can see. The phrase is licensed once — in the explanatory clause — so a second occurrence
      // in that context is by definition not that clause.
      //
      // NOT every second occurrence: only sibling phrasings whose next word is one of
      // LADDER_ESCALATION_TRAILING_WORDS (when/on/as/once/after/every) are counted, because a bare
      // count fires on ordinary escalation prose and a guard that reds on correct copy gets
      // deleted. So "— escalate it, since a repeated signal matters" is NOT caught here. That
      // residual is real; see THE HONEST LIMIT in the module header rather than assuming this
      // assertion is total.
      expect(countLadderEscalateIt(p)).toBe(1);
      expect(p).not.toMatch(RETIRED_PRIORITY_LADDER_INSTRUCTION);
    }
  });

  // A bead whose fix already landed is retired by CLOSING it with the sha — the `Refs:` trailer
  // that demotes it in triage expires with the 500-commit scan window, so an open bead simply
  // returns to the top of the ranking and is re-investigated again. Landed rows reached seen-6
  // this way: the same finished work re-derived from scratch by six separate passes.
  it("tells the pass to close an item it confirms is already fixed", () => {
    for (const mode of ["always", "case_by_case"] as const) {
      const p = hourlyMissionPrompt(mode);
      expect(p).toContain("bd close");
      expect(p).toMatch(/sha/);
      // Confirmation first: LANDED is a read-the-commit marker, never a closure on its own.
      expect(p).toMatch(/confirmed|read and confirmed/);
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

// ── WHICH ARM DECLINED ──────────────────────────────────────────────────────────────────────────
// The 33 tests above assert `shouldRunImprovementPass(...) === false`, which is true for EVERY arm,
// so they cannot tell "pane-busy" from "offline". That boolean is not the product surface any more:
// the STRING is, and it is quoted verbatim to the founder through PASS_HOLD_TEXT. A mislabelled or
// reordered arm would tell them to un-wedge a pane when the machine is simply offline, and nothing
// above would go red (roborev 57323).
describe("passHoldReason", () => {
  const T = 1_700_000_000_000;
  const gate = (over: Partial<Parameters<typeof passHoldReason>[0]> = {}) => ({
    consent: "always" as const,
    lastRunAt: T - 2 * 60 * 60 * 1000,
    now: T,
    passRunning: false,
    paneStatus: undefined,
    isOnline: true,
    ...over,
  });

  it("names each arm", () => {
    expect(passHoldReason(gate({ consent: "never" }))).toBe("consent-off");
    expect(passHoldReason(gate({ passRunning: true }))).toBe("already-running");
    expect(passHoldReason(gate({ paneStatus: "working" }))).toBe("pane-busy");
    expect(passHoldReason(gate({ lastRunAt: null }))).toBe("clock-unseeded");
    expect(passHoldReason(gate({ isOnline: false }))).toBe("offline");
  });

  it("is null when nothing is holding it", () => {
    expect(passHoldReason(gate())).toBeNull();
  });

  // Precedence is not cosmetic: it decides which cause the founder is told to act on.
  it("reports the FIRST holder when several apply at once", () => {
    expect(
      passHoldReason(gate({ consent: "never", passRunning: true, paneStatus: "working" })),
    ).toBe("consent-off");
    expect(passHoldReason(gate({ passRunning: true, paneStatus: "working" }))).toBe("already-running");
    expect(passHoldReason(gate({ paneStatus: "working", isOnline: false }))).toBe("pane-busy");
  });

  // The boolean must stay exactly the negation of "held", or the two drift and a surface explains a
  // hold that is no longer in force.
  it("agrees with the boolean on every arm", () => {
    for (const g of [
      gate({ consent: "never" }),
      gate({ passRunning: true }),
      gate({ paneStatus: "working" }),
      gate({ paneStatus: "working", paneBusySince: T - PANE_BUSY_HOLD_LIMIT_MS }),
      gate({ lastRunAt: null }),
      gate({ isOnline: false }),
    ]) {
      expect(passHoldReason(g)).not.toBeNull();
      expect(shouldRunImprovementPass(g)).toBe(false);
    }
  });

  // ── THE BOUND ON THE SELF-SUSTAINING HOLD ──────────────────────────────────────────────────────
  // The failure this exists for is silence, not a wrong boolean: a wedged pane held the hourly duty
  // for a whole morning while the only thing describing it read exactly the same as a two-minute
  // interactive session. So the assertion that matters is that the REASON changes with age — a test
  // that only re-checked `shouldRunImprovementPass(...) === false` would have passed before this
  // existed, since the pass was held either way.
  describe("a pane that has been working for several slots", () => {
    const working = (sinceMsAgo: number) =>
      gate({ paneStatus: "working" as const, paneBusySince: T - sinceMsAgo });

    it("escalates to pane-wedged past the limit, and stays pane-busy under it", () => {
      expect(passHoldReason(working(PANE_BUSY_HOLD_LIMIT_MS - 1))).toBe("pane-busy");
      expect(passHoldReason(working(PANE_BUSY_HOLD_LIMIT_MS))).toBe("pane-wedged");
      expect(passHoldReason(working(4 * PANE_BUSY_HOLD_LIMIT_MS))).toBe("pane-wedged");
    });

    // Escalating must not become a way to run: two `claude` processes in one worktree is the exact
    // failure the hold prevents, and a stuck status line is not evidence the process is gone.
    it("still holds the pass", () => {
      expect(shouldRunImprovementPass(working(4 * PANE_BUSY_HOLD_LIMIT_MS))).toBe(false);
      // Even with the connectivity retry armed and long overdue, which short-circuits the hourly wait.
      expect(
        shouldRunImprovementPass({ ...working(4 * PANE_BUSY_HOLD_LIMIT_MS), retryDueAt: T - 1 }),
      ).toBe(false);
    });

    // A caller that does not model the distinction, and every tick before the latch is first
    // sampled, must land on the ordinary hold rather than accusing a live session of being wedged.
    it("reads an unknown start as a fresh hold", () => {
      expect(passHoldReason(gate({ paneStatus: "working" }))).toBe("pane-busy");
      expect(passHoldReason(gate({ paneStatus: "working", paneBusySince: null }))).toBe("pane-busy");
    });

    // The escalation is only worth anything if it SAYS something different — the two strings are
    // the whole product surface here (see the header above this describe block).
    it("is quoted to the founder as a different sentence", () => {
      expect(PASS_HOLD_TEXT["pane-wedged"]).not.toBe(PASS_HOLD_TEXT["pane-busy"]);
      expect(PASS_HOLD_TEXT["pane-wedged"]).not.toBe("");
    });
  });
});

// The latch is what turns a status with no timestamp into an age. Its one real rule: a run of
// `working` must be UNBROKEN, because busy-in-aggregate is ordinary and only one continuous run is
// the wedge.
describe("notePaneStatus", () => {
  const T = 1_700_000_000_000;
  beforeEach(() => resetPaneBusyForTests());

  it("holds the start of an unbroken working run", () => {
    expect(notePaneStatus("working", T)).toBe(T);
    expect(notePaneStatus("working", T + 60_000)).toBe(T);
    expect(paneBusySinceAt()).toBe(T);
  });

  it("restarts the clock when the run breaks", () => {
    notePaneStatus("working", T);
    expect(notePaneStatus("idle", T + 60_000)).toBeNull();
    expect(notePaneStatus("working", T + 120_000)).toBe(T + 120_000);
  });

  it("reads a never-opened pane as not working", () => {
    expect(notePaneStatus(undefined, T)).toBeNull();
    expect(paneBusySinceAt()).toBeNull();
  });

  // The end-to-end claim: sampling a pane that never stops working eventually makes the gate say
  // something new. Nothing else in this file connects the latch to the reason.
  it("ages a pinned pane into the escalated reason", () => {
    notePaneStatus("working", T);
    const at = (now: number) =>
      passHoldReason({
        consent: "always",
        lastRunAt: T - 2 * 60 * 60 * 1000,
        now,
        passRunning: false,
        paneStatus: "working",
        paneBusySince: notePaneStatus("working", now),
        isOnline: true,
      });
    expect(at(T + IMPROVEMENT_INTERVAL_MS)).toBe("pane-busy");
    expect(at(T + PANE_BUSY_HOLD_LIMIT_MS)).toBe("pane-wedged");
  });
});
