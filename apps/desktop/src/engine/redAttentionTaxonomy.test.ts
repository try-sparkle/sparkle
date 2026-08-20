import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusEngine } from "./statusEngine";
import { isApiErrorLine, isSelfPromptLine, StreamFailureDetector } from "./streamFailure";
import { needsAttention } from "./attention";
import { escalationFor } from "./stallEscalation";
import { bandOfStatus } from "./buildSections";
import { isRedStatus } from "../services/windowStatus";
import { AGENT_STATUS } from "@sparkle/ui";
import { stallReport, type StallCause, type StallInput, type StallReport } from "./agentStall";
import {
  escalateGoal,
  escalationQuotesStaleText,
  markGoalMet,
  newGoal,
  MAX_CONCIERGE_REARMS,
  type AgentGoal,
} from "./agentGoal";
import { humanBlockOf } from "./humanBlock";
import { agentClosableKind } from "@sparkle/core";
import { mightNeedFollowup } from "../services/turnFollowup";
import type { AgentTabStatus } from "../types";

// Cross-surface regression guard for the top-priority "reliable RED needs-you" contract,
// consolidating the
// three beads that make up one subsystem: sparkle-vgub (feature), sparkle-blpf (blocked-on-user),
// sparkle-pqxh (mid-stream API failure). The individual units are covered in depth by their own
// suites (screenClassifier / streamFailure / statusEngine / attention / turnFollowup); this file
// pins the ONE invariant that spans all of them and must never regress:
//
//   FAIL CLOSED — when the agent is actually waiting on the human OR is wedged/errored, its status
//   is in the RED "needs-you" tier (needsAttention() === true); a genuinely finished turn is NOT.
//
// Every leg here drives a REAL classifier surface (the deterministic ones — no LLM), so a future
// refactor that quietly turns any "needs you" case green fails loudly in one readable matrix.

// Drives the engine and records the latest status. `getScreen` supplies the rendered-screen
// snapshot the engine reads on settle (red = a question is on screen, gray = a finished turn).
function makeEngine(getScreen?: () => string) {
  const statuses: AgentTabStatus[] = [];
  const engine = new StatusEngine({ agentId: "t", onStatus: (s) => statuses.push(s), getScreen });
  return { engine, last: () => statuses[statuses.length - 1] };
}

// Claude Code renders AskUserQuestion / ExitPlanMode / permission prompts as its standard bordered
// ❯ numbered selection menu in the PTY — the deterministic marker the engine keys off (no LLM).
const ASK_USER_QUESTION_MENU =
  "╭─ Which date library should we use? ─╮\n│ ❯ 1. date-fns │\n│   2. luxon │\n╰─────────────────────────────────────╯\n";

describe("RED needs-you taxonomy (sparkle-vgub / sparkle-blpf / sparkle-pqxh)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // ── sparkle-blpf: blocked on the user ──────────────────────────────────────────────────────

  it("AskUserQuestion menu → RED (waiting)", () => {
    const { engine, last } = makeEngine();
    engine.ingest(ASK_USER_QUESTION_MENU);
    expect(last()).toBe("waiting");
    expect(needsAttention(last())).toBe(true);
  });

  it("interactive shell prompt → RED (waiting)", () => {
    const { engine, last } = makeEngine();
    engine.ingest("Overwrite existing file? (y/n)\n");
    expect(needsAttention(last())).toBe(true);
  });

  it("prose question / closeout ask → RED via the deterministic fast-path floor", () => {
    // The followup judge is a PRECISION filter, not the floor: when it can't run (no BYOK key — the
    // norm) the deterministic fast-path is what keeps a real ask red. Pin that floor: a closeout ask
    // trips mightNeedFollowup (→ fails closed to `waiting`), a plain report does not.
    expect(mightNeedFollowup("All wired up and the suite is green. Want me to land it now?")).toBe(true);
    expect(mightNeedFollowup("Once you confirm, I'll lay out the remaining sections.")).toBe(true);
  });

  it("self-prompt / churn loop (REPEATED pings) → RED (errored), not green", () => {
    const { engine, last } = makeEngine();
    // Bug A: a self-prompt is a wedge only once it REPEATS with no progress (a single occurrence is
    // a legitimate user utterance / prose quote). Two pings on discrete lines make the loop.
    engine.ingest("Are you still there?\n");
    engine.ingest("Hey, Sparkler.\n");
    expect(last()).toBe("errored");
    expect(needsAttention(last())).toBe(true);
    // And the generic unknown-churn backstop: the same short line repeating with no progress.
    const det = new StreamFailureDetector();
    let tripped = false;
    for (let i = 0; i < 6; i++) tripped = det.observe("ping") || tripped;
    expect(tripped).toBe(true);
  });

  it("errored on a crash exit → RED", () => {
    const { engine, last } = makeEngine();
    engine.ingest("Error: cannot find module 'foo'\n");
    engine.exit();
    expect(last()).toBe("errored");
    expect(needsAttention(last())).toBe(true);
  });

  // ── sparkle-pqxh: mid-stream API failure while the process stays alive ──────────────────────

  it("mid-stream API error → RED (errored)", () => {
    const { engine, last } = makeEngine();
    engine.ingest("API Error: 500 Internal server error\n");
    expect(last()).toBe("errored");
    expect(needsAttention(last())).toBe(true);
  });

  it("rate-limit (429) banner → RED", () => {
    expect(isApiErrorLine("API Error: 429 rate_limit_error · Rate limited")).toBe(true);
    const { engine, last } = makeEngine();
    engine.ingest(
      "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited\n",
    );
    expect(needsAttention(last())).toBe(true);
  });

  it("overloaded (529) banner → RED", () => {
    expect(isApiErrorLine("API Error: 529 overloaded_error")).toBe(true);
    const { engine, last } = makeEngine();
    engine.ingest("API Error: 529 overloaded_error\n");
    expect(needsAttention(last())).toBe(true);
  });

  it("API error that keeps churning under a live spinner still reads RED (spinner is overridden)", () => {
    const SPINNER = "✳ Working… (esc to interrupt)";
    const { engine, last } = makeEngine();
    engine.ingest(SPINNER + "\n"); // spinner seen → would look green
    engine.ingest("API Error: Rate limited\n"); // banner fails closed over the spinner
    expect(last()).toBe("errored");
    expect(needsAttention(last())).toBe(true);
  });

  // ── The other side of fail-closed: a genuinely finished turn must NOT go red ─────────────────

  it("genuine completion → GREEN/GRAY, never RED", () => {
    // Deterministic fast-path: a plain completion report is not an ask.
    expect(mightNeedFollowup("Done. Built the card, removed the tooltip, suite is 1123 passing.")).toBe(
      false,
    );
    // Clean exit settles to `done` (gray), not the attention tier.
    const { engine, last } = makeEngine();
    engine.ingest("All tasks complete. Tests pass.\n");
    engine.exit();
    expect(last()).toBe("done");
    expect(needsAttention(last())).toBe(false);
  });

  it("a quiet, question-free turn settles to idle (gray), not RED", () => {
    const IDLE_SCREEN = "╭───────────────╮\n│ >             │\n╰───────────────╯";
    const { engine, last } = makeEngine(() => IDLE_SCREEN);
    engine.ingest("compiling module A\n");
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("idle");
    expect(needsAttention(last())).toBe(false);
  });

  // Self-check: isSelfPromptLine is the deterministic tell behind the churn-loop red above; keep it
  // pinned so a wording change to the loop detector can't silently drop the signal.
  it("isSelfPromptLine catches the known wedge pings", () => {
    expect(isSelfPromptLine("Are you there?")).toBe(true);
    expect(isSelfPromptLine("Hey, Sparkler. Are you there?")).toBe(true);
    expect(isSelfPromptLine("Running the test suite now.")).toBe(false);
  });
});

// ── The OTHER half of the contract: RED must also mean something ─────────────────────────────────
//
// Everything above pins "a genuine ask stays RED". This block pins the converse, added 2026-08-06
// after the founder spent a day triaging red rows that needed nothing: *"why are they red when they
// don't require my assistance?"* Both rows in his screenshot had spotless worktrees and every PR
// they owned merged, and both wore `auto-continue gave up` in the alarm colour.
//
// ══ THE RULE, EXTENDED 2026-08-07 TO EVERY CAUSE ═════════════════════════════════════════════════
// The 2026-08-06 pass moved ONE cause (`escalated-goal`) and left the rest, so the founder kept
// triaging red rows that needed nothing — at least six more times in one day, in his words: *"Why
// are all these agents red? They don't seem to need anything from me."* and, on one row by name,
// *"Why is Cloud Gate Dead End showing as red?"* — *"When it doesn't need anything from me."* That
// row was red for ONE stranded commit with no PR; the concierge pushed it, opened a PR and merged
// it without him. The founder was not required at any step, and 15 branches were resolved the same
// way that night.
//
// So the rule this file now pins is the general one:
//
//   RED = THE FOUNDER IS THE ONLY ACTOR WHO CAN UNBLOCK THIS.
//
// Everything else is lifecycle bookkeeping — work the concierge or the agent can finish alone — and
// it renders the amber `lapsed` tier. The test for an ambiguous cause is a question with an answer:
// could the concierge or the agent resolve it WITHOUT him? If yes, amber.
//
// BOTH DIRECTIONS ARE PINNED BELOW, deliberately. Making rows less red must not make a genuine
// blocker quiet — Sparkle's standing rule is never to hide a row that needs the founder. So every
// amber cause here proves it is self-resolvable, and the red cause proves nobody else can act.
describe("AMBER lifecycle vs RED needs-you — red is reserved for the human", () => {
  const report = (causes: StallCause[]): StallReport => ({
    verdict: causes.length ? "stalled" : "finished",
    causes,
    detail: "",
  });

  // ── AMBER: every cause another actor can resolve, covered BY NAME ──────────────────────────────
  //
  // Named individually rather than looped, because the point of each is a different sentence about
  // WHO resolves it, and a loop would let a cause silently join the list without that argument
  // being made. The exhaustiveness check that no cause is MISSING is the `satisfies` block below.

  it("auto-continue gave up, nothing outstanding → AMBER, never red", () => {
    // The retry budget ran out. That is a fact about Sparkle's own machinery — how much it was
    // willing to SPEND — not a claim that a human is required. Re-arming it is a concierge action.
    expect(escalationFor(report(["escalated-goal"]))).toBe("lapsed");
    expect(isRedStatus("lapsed")).toBe(false);
    expect(AGENT_STATUS.lapsed.color).not.toBe(AGENT_STATUS.waiting.color);
  });

  it("committed work that never reached main → AMBER — THE CONCIERGE DID EXACTLY THIS, 15 times", () => {
    // The founder's own example, by name: 'Cloud Gate Dead End' was red for one stranded commit
    // with no PR. Push the branch, open a PR, merge it when green — the concierge owns every step
    // and needs him at none of them. This is the single highest-volume false red on the fleet.
    expect(escalationFor(report(["unlanded-work"]))).toBe("lapsed");
    expect(isRedStatus("lapsed")).toBe(false);
  });

  it("uncommitted edits in a worktree → AMBER — the AGENT commits or discards, never the founder", () => {
    expect(escalationFor(report(["uncommitted-changes"]))).toBe("lapsed");
  });

  it("an open PR → AMBER — waiting on CI or a review is not his to press", () => {
    expect(escalationFor(report(["open-pr"]))).toBe("lapsed");
  });

  it("a goal nobody met yet → AMBER — auto-continue is still driving it", () => {
    // `unmet-goal` is the state in which the retry budget is NOT spent (`hasUnmetGoal` gates
    // auto-continue and is true for exactly this state). So the machinery is still on it and the
    // agent has work left to do — his sign-off is not even due yet. Once the budget IS spent the
    // cause becomes `escalated-goal`, which is amber one line above for its own reason.
    expect(escalationFor(report(["unmet-goal"]))).toBe("lapsed");
  });

  it("goal expired, nothing outstanding → still CALM, not amber and not red", () => {
    // `expired-goal` was already cut from the red tier by sparkle-biezi and is UNCHANGED here: it
    // stays calm gray on purpose, because it is the higher-volume cause (every agent outliving its
    // TTL earns one), so routing it to amber would trade a wall of false red for a wall of amber.
    // Gray already satisfies the rule — re-arming the clock is a concierge action, and a calm row
    // makes no claim on him at all. See LIFECYCLE's comment.
    expect(escalationFor(report(["expired-goal"]))).toBe(undefined);
    expect(isRedStatus("idle")).toBe(false);
  });

  it("no combination of self-resolvable causes can add up to RED", () => {
    // The founder's rows carried several at once. Amber + amber must not become red by accident —
    // and a `some()` over the red set is exactly the shape that would do it if a cause were left
    // behind in `OUTSTANDING`.
    const selfResolvable: StallCause[] = [
      "escalated-goal",
      "expired-goal",
      "unmet-goal",
      "open-pr",
      "unlanded-work",
      "uncommitted-changes",
    ];
    expect(escalationFor(report(selfResolvable))).toBe("lapsed");
    expect(isRedStatus(escalationFor(report(selfResolvable)))).toBe(false);
  });

  it("an amber row never becomes a badge or a banner", () => {
    // The "N agents need you" count and the dock badge key off this set, NOT off the colour tier.
    // An amber row that still inflated the count would have moved the false alarm, not removed it.
    expect(needsAttention("lapsed")).toBe(false);
    expect(bandOfStatus("lapsed")).not.toBe("needs_you");
  });

  // ── NOT RED SINCE 2026-08-18: awaiting a review-close is done, not stuck ─────────────────────────

  it("a goal only a PERSON may close, with no retry coming → AMBER, not red", () => {
    // THIS ASSERTED `blocked` FROM 2026-08-07 UNTIL 2026-08-18, and the founder refined the rule that
    // made it red. `human-verified-goal` means: auto-continue has stopped AND the goal's stated check
    // is one no agent may ever discharge (`core.agentClosableKind` says `command`/`human` are
    // un-closable by the claimant). So the work is as finished as it will get and only he can CLOSE
    // it — but the agent is not blocked: it self-reports not-blocked, "no command or permission is
    // needed from me". A red dot is the thing he PHYSICALLY chases, so it must mean STUCK, not
    // "awaiting your review-close". This row is done and awaiting his sign-off, so it is amber.
    expect(escalationFor(report(["human-verified-goal"]))).toBe("lapsed");
    expect(isRedStatus("lapsed")).toBe(false);
    // …and it lands in the `done` band, OFF the "N agents need you" count and out of the red dot.
    expect(bandOfStatus("lapsed")).not.toBe("needs_you");
    expect(bandOfStatus("lapsed")).toBe("done");
  });

  // ── RED: the one cause where NO other actor can proceed AND the work is stuck ────────────────────

  it("a goal it gave up on holding UNLANDED work nobody is coming for → RED", () => {
    // The sole surviving red stall cause. `abandoned-goal` means auto-continue spent its whole re-arm
    // budget AND git shows committed work the default branch does not contain, with no PR carrying it.
    // Sparkle has stopped, the agent will not restart itself, and nobody is coming for the branch — so
    // what is left is a disposition call (land it or drop it) on someone's unfinished work, which is
    // genuinely stuck and genuinely his. That is what a red dot must mean.
    expect(escalationFor(report(["abandoned-goal"]))).toBe("blocked");
    expect(isRedStatus("blocked")).toBe(true);
    expect(bandOfStatus("blocked")).toBe("needs_you");
  });

  it("RED still outranks AMBER when both are true — the safety ordering", () => {
    // DO NOT REGRESS THE OPPOSITE FAILURE. `OUTSTANDING` is tested FIRST, so a row that owes the
    // founder a STUCK-work verdict stays red no matter how much self-resolvable (or merely
    // awaiting-review) bookkeeping sits beside it — `human-verified-goal` included, now that it is
    // amber. `abandoned-goal` is the red anchor.
    for (const c of [
      "human-verified-goal",
      "escalated-goal",
      "expired-goal",
      "unmet-goal",
      "open-pr",
      "unlanded-work",
      "uncommitted-changes",
    ] as const) {
      expect(escalationFor(report(["abandoned-goal", c]))).toBe("blocked");
      // …and in the other input order, so it is the SET that decides and not the array head.
      expect(escalationFor(report([c, "abandoned-goal"]))).toBe("blocked");
      // EVERY red cause outranks, not just the one this loop was written for. `blocked-on-human` is
      // the case the founder actually hit — it coexists with `escalated-goal` on the same row by
      // construction, since the nudger flags agents whose goals auto-continue has handed back — so if
      // the ordering only held for one anchor the fix would not reach his row at all. Both input
      // orders, so it is the SET that decides and not the array head.
      for (const red of ["blocked-on-human", "rearms-exhausted"] as const) {
        expect(escalationFor(report([red, c]))).toBe("blocked");
        expect(escalationFor(report([c, red]))).toBe("blocked");
      }
    }
  });

  it("the asking statuses are untouched — still red, still notified", () => {
    // The founder's other two "must stay red" cases — an unanswered question and an approval
    // prompt — never pass through this module at all: `statusEngine` derives them from the PTY and
    // they are not in `ESCALATABLE`. Pinned here so a future de-redding cannot reach them either.
    for (const s of ["waiting", "approval", "errored", "blocked"] as const) {
      expect(isRedStatus(s)).toBe(true);
    }
    expect(needsAttention("waiting")).toBe(true);
    expect(needsAttention("approval")).toBe(true);
  });

  it("a row with no causes is still calm — amber is not a new default", () => {
    expect(escalationFor(report([]))).toBe(undefined);
    expect(escalationFor(undefined)).toBe(undefined);
  });

  it("EVERY cause is classified, and the partition is non-trivial in both directions", () => {
    // THE EXHAUSTIVENESS GUARD. `satisfies Record<StallCause, ...>` makes a newly added cause a
    // TYPE ERROR at this line rather than an unclassified cause that quietly inherits whichever
    // tier `escalationFor` falls through to. Whoever adds one has to state, here, whether the
    // founder is the only actor who can clear it — which is the decision this whole file exists to
    // force. The expected tier is written out per cause so the answer is reviewable as data.
    const EXPECTED = {
      // RED, added 2026-08-18 on the founder's report of a row that READ blocked-on-human and DREW
      // amber. It is the only cause on this list sourced from the agent's own answer rather than from
      // git, a clock or the goal record — `nudge_ladder` asked it what was blocking it and it named a
      // person — which is what makes it narrow enough to sit here without re-reddening the population
      // the 2026-08-06 demotion cleared. Demotion trigger, stated so it is not rediscovered as a
      // false red: the day a machine actor can answer a `blocked-on-human` row on his behalf.
      "blocked-on-human": "blocked",
      // AMBER since 2026-08-18 (was "blocked"). Awaiting the founder's review-close is done, not
      // stuck: the agent needs nothing to proceed, so it must not wear the red dot he physically
      // chases. It is surfaced — the cause is raised, the "awaiting your sign-off" chip renders — just
      // in the amber `lapsed` tier that bands into `done`, off the "N need you" count.
      //
      // ⚠️ IT IS NOT THE SAME QUESTION AS `blocked-on-human` above, which stays red. That one is the
      // AGENT saying a person is blocking it; this one is the GOAL RECORD saying only a person may
      // close it. An agent in this state self-reports not-blocked, which is exactly why it is amber.
      "human-verified-goal": "lapsed",
      // RED, and the argument is who can clear it AND that the work is stuck: nobody but him. Sparkle
      // has stopped (the re-arm budget is spent and the goal is escalated, so nothing retries it), the
      // agent will not restart itself, and no PR is carrying the work — so what is left is a
      // disposition call on an unfinished branch. It is reachable ONLY through
      // `goalExpiry.decideExpiry`, which clears seven gates first and discharges a clean-and-landed
      // agent three rules earlier, so a finished agent cannot wear it. Demotion trigger, stated so it
      // is not rediscovered as a false red: the day the concierge auto-lands abandoned branches, this
      // becomes "lapsed".
      "abandoned-goal": "blocked",
      // RED, and strictly NARROWER than `escalated-goal` below, which stays amber: this fires only
      // once the concierge has spent every re-arm it is allowed, so the machine actor that would
      // otherwise clear the row has demonstrably run out rather than being assumed absent. The row's
      // own copy already said "this one is yours" in this state while drawing amber.
      "rearms-exhausted": "blocked",
      "unmet-goal": "lapsed",
      "open-pr": "lapsed",
      "unlanded-work": "lapsed",
      "uncommitted-changes": "lapsed",
      "escalated-goal": "lapsed",
      // ⚠️ STILL `undefined`, and this change did NOT touch it. The sibling above is not a promotion
      // of expiry — it is a different cause with a far narrower gate. Expiry remains a fact about the
      // CLOCK that fires on a finished agent and an abandoned one identically, which is exactly why
      // sparkle-biezi cut it from the red tier; see `stallEscalation.OUTSTANDING` for the derivation.
      "expired-goal": undefined,
    } satisfies Record<StallCause, AgentTabStatus | undefined>;

    for (const [cause, tier] of Object.entries(EXPECTED)) {
      expect(escalationFor(report([cause as StallCause]))).toBe(tier);
    }
    // Non-trivial both ways, or every assertion above is vacuous: at least one cause reaches red
    // and at least one does not. A future edit that empties either side fails here.
    const tiers = Object.values(EXPECTED);
    expect(tiers.filter((t) => t === "blocked").length).toBeGreaterThan(0);
    expect(tiers.filter((t) => t !== "blocked").length).toBeGreaterThan(0);
  });
});

// ── The PRODUCER half: the cause must be UNREACHABLE unless a human really is the only closer ──────
//
// `escalationFor` above decides what a cause MEANS (amber, since 2026-08-18). This block pins what
// actually raises it, because the "awaiting your sign-off" chip is only as honest as its producer:
// route a common condition into `human-verified-goal` and every ordinary work goal grows a sign-off
// chip nobody asked for. The provenance guards below are unchanged by the tier move — they still
// keep the cause narrow — only what the cause COLOURS to changed (amber `lapsed`, not red `blocked`).
describe("human-verified-goal — raised only when no other actor can close the goal", () => {
  const T0 = 1_700_000_000_000;
  const quiet = (goal: AgentGoal, now = T0 + 1): StallInput => ({
    status: "idle",
    now,
    goal,
    hasOpenPr: false,
    hasUnlandedWork: false,
    hasUncommittedChanges: false,
  });
  const causesOf = (goal: AgentGoal, now?: number) => stallReport(quiet(goal, now)).causes;

  it("escalated + a CALLER-STATED human sign-off → raised, and the row is AMBER (awaiting review-close)", () => {
    const goal = escalateGoal(newGoal("approve the copy", T0, undefined, { kind: "human" }), T0, "budget spent");
    // `newGoal` is never handed a fallback, so a `verify` reaching it is stated by construction.
    // Asserted rather than assumed: the whole cause turns on this flag being true here and false in
    // the manufactured case below, so if `newGoal` ever stopped recording it, the two would collapse
    // into one another and the guard would be untested in both directions.
    expect(goal.verifyStated).toBe(true);
    expect(causesOf(goal)).toContain("human-verified-goal");
    // Raised — so the chip renders — but AMBER, not the red it was until 2026-08-18: the agent is done
    // and awaiting his review-close, not stuck.
    expect(escalationFor(stallReport(quiet(goal)))).toBe("lapsed");
    expect(isRedStatus("lapsed")).toBe(false);
  });

  it("escalated + a command check → raised too: no executor runs it, so a PERSON closes it", () => {
    // `agentClosableKind` is the authority (packages/core/goalVerify), and it answers NO for
    // `command` as well as `human` — nothing runs a command today, so the goal cannot close without
    // a person either way. Deriving from it rather than testing `kind === "human"` is what keeps
    // this red honest the day an executor lands: `command` becomes agent-closable there, and this
    // cause stops firing for it with no edit here.
    expect(agentClosableKind("human")).toBe(false);
    expect(agentClosableKind("command")).toBe(false);
    expect(agentClosableKind("landed")).toBe(true);
    const goal = escalateGoal(
      newGoal("prove it", T0, undefined, { kind: "command", cmd: "pnpm test" }),
      T0,
      "budget spent",
    );
    expect(causesOf(goal)).toContain("human-verified-goal");
  });

  // ── AND THE FIVE WAYS IT MUST NOT FIRE ─────────────────────────────────────────────────────────

  it("EXPIRED + a human sign-off → NOT raised: a lapsed clock asks for nothing", () => {
    // ⚠️ THE FIRST CUT OF THIS CHANGE RAISED IT HERE, and roborev 60322 was right to call it: expiry
    // is the highest-volume goal cause — every agent outliving its TTL earns one — and it is
    // deliberately calm gray for exactly that reason. Admitting it through a composite cause would
    // have re-reddened that whole population by the back door, which is the specific failure this
    // file exists to prevent. Re-arming the clock is a CONCIERGE action, not his.
    const goal = newGoal("approve the copy", T0, 1000, { kind: "human" });
    expect(causesOf(goal, T0 + 5000)).not.toContain("human-verified-goal");
    expect(causesOf(goal, T0 + 5000)).toEqual(["expired-goal"]);
    expect(escalationFor(stallReport(quiet(goal, T0 + 5000)))).toBe(undefined);
  });

  it("a MANUFACTURED human check → NOT raised, even escalated: nobody asked for it", () => {
    // ⚠️ THE HIGHEST-VALUE GUARD IN THIS BLOCK (roborev 60322). `chargeGoalDebt` manufactures
    // `{kind:"human"}` (`INHERITED_VERIFY`) for any goal text it cannot infer a check for, and marks
    // it `verifyStated: false`. Without the `=== true` term, an agent that inherited a sign-off
    // NOBODY CHOSE would wear the loudest signal the app has — sparkle-vfkqz's population exactly,
    // and a false red of precisely the kind being removed here.
    const goal = escalateGoal(
      { ...newGoal("do the thing", T0), verify: { kind: "human" }, verifyStated: false },
      T0,
      "budget spent",
    );
    expect(causesOf(goal)).not.toContain("human-verified-goal");
    expect(escalationFor(stallReport(quiet(goal)))).toBe("lapsed");
  });

  it("an INHERITED stated human check → NOT raised: it was chosen for OTHER work", () => {
    // ⚠️ THE SECOND CUT MISSED THIS (roborev 60325) and it is the COMMON path, not an edge case.
    // `verifyStated` answers "was a check of this kind ever chosen", and it rides VERBATIM through
    // same-kind inheritance — so an owed stated `human` plus any non-landing-shaped new goal text
    // produces `{kind:"human"}` with `verifyStated: true` on work nobody attached a sign-off to.
    // Since `send_to_agent_terminal` records ordinary work goals with no `verify`, that is how most
    // of them end up carrying one. `verifyInherited` is the narrower bit, and this is the leg that
    // would have caught the gap: the flags differ ONLY in `verifyInherited` from the raised case.
    const goal = escalateGoal(
      {
        ...newGoal("refactor the parser", T0),
        verify: { kind: "human" },
        verifyStated: true,
        verifyInherited: true,
      },
      T0,
      "budget spent",
    );
    expect(causesOf(goal)).not.toContain("human-verified-goal");
    expect(escalationFor(stallReport(quiet(goal)))).toBe("lapsed");
  });

  it("…and that inherited row is still SURFACED — quieter, never silent", () => {
    // ⚠️ THE PRICE OF THE LEG ABOVE, pinned so it stays bounded (roborev 60339). An inherited check
    // still BINDS — no agent can discharge it — so by a pure actor test that row IS founder-only and
    // we are deliberately declining to paint it red. See `agentStall`'s "TERM 3 IS A RELEVANCE
    // JUDGEMENT" block for why the pure test cannot be applied literally (the concierge `verify:
    // null` take-back clears ANY check, so the literal test empties the tier).
    //
    // What makes that call survivable is exactly this: the row does not go quiet. It still reports a
    // cause, still leaves the calm tier, and still renders the marks a reader can find it by. If a
    // future change ever lets this row fall through to gray, THAT is the regression — the amber is
    // the whole justification for the narrowing, so it is asserted rather than assumed.
    const goal = escalateGoal(
      {
        ...newGoal("refactor the parser", T0),
        verify: { kind: "human" },
        verifyStated: true,
        verifyInherited: true,
      },
      T0,
      "budget spent",
    );
    const report = stallReport(quiet(goal));
    expect(report.verdict).toBe("stalled");
    expect(report.causes).toContain("escalated-goal");
    expect(report.detail).toContain("auto-continue gave up");
    // Not calm — the reader still has something to look at.
    expect(escalationFor(report)).not.toBe(undefined);
    expect(isRedStatus(escalationFor(report))).toBe(false);
  });

  it("…and the SAME goal chosen here IS raised — the pair differs only in `verifyInherited`", () => {
    // The control that stops the leg above from passing for the wrong reason. Identical goal,
    // identical check, identical escalation; the one bit that moves is provenance.
    const chosenHere = escalateGoal(
      {
        ...newGoal("refactor the parser", T0),
        verify: { kind: "human" },
        verifyStated: true,
      },
      T0,
      "budget spent",
    );
    expect(chosenHere.verifyInherited).toBe(undefined);
    expect(causesOf(chosenHere)).toContain("human-verified-goal");
    // Raised (chip present), amber tier since 2026-08-18.
    expect(escalationFor(stallReport(quiet(chosenHere)))).toBe("lapsed");
  });

  it("a LEGACY check with no provenance flag → NOT raised: quiet when unsure", () => {
    // `verifyStated` is three-valued and absence means LEGACY. `AgentGoal.verifyStated`'s own rule
    // is that absence fails CLOSED (binding), because there a wrong answer lets an agent launder
    // away a real sign-off. Here a wrong answer only paints a dot, and the installed base is full of
    // persisted `human` checks carrying no flag — so this reads `=== true` and stays quiet. Same
    // field, opposite fail-safe direction, because the two questions have opposite costs.
    const legacy = escalateGoal(
      { ...newGoal("do the thing", T0), verify: { kind: "human" } },
      T0,
      "budget spent",
    );
    expect(legacy.verifyStated).toBe(undefined);
    expect(causesOf(legacy)).not.toContain("human-verified-goal");
    expect(escalationFor(stallReport(quiet(legacy)))).toBe("lapsed");
  });

  it("UNMET + a stated human sign-off → NOT raised: the agent's work is not finished", () => {
    // The volume guard. Every agent carrying a stated sign-off would be red from the moment it went
    // quiet if this fired on `unmet` — and it would be wrong: the agent still has work to do, so his
    // verdict is not owed yet. (Note the reason is the WORK, not "auto-continue is still driving
    // it" — that premise does not hold in a window with no turn-end authority. See OUTSTANDING.)
    const goal = newGoal("approve the copy", T0, undefined, { kind: "human" });
    expect(causesOf(goal)).toEqual(["unmet-goal"]);
    expect(escalationFor(stallReport(quiet(goal)))).toBe("lapsed");
  });

  it("escalated + a LANDED check → NOT raised: git closes it, and the agent can land it", () => {
    const goal = escalateGoal(newGoal("land the PR", T0, undefined, { kind: "landed" }), T0, "budget spent");
    expect(causesOf(goal)).not.toContain("human-verified-goal");
    expect(escalationFor(stallReport(quiet(goal)))).toBe("lapsed");
  });

  it("escalated + NO stated check → NOT raised: an unverified goal is self-markable", () => {
    // Absence is load-bearing (`canSelfMarkMet(undefined)` is true) — a goal that never stated a
    // check was never claiming to be verifiable. This is the majority of goals, and it is exactly
    // the population the founder was triaging.
    const goal = escalateGoal(newGoal("do the thing", T0), T0, "budget spent");
    expect(causesOf(goal)).not.toContain("human-verified-goal");
    expect(escalationFor(stallReport(quiet(goal)))).toBe("lapsed");
  });

  it("a MET goal raises nothing at all, however it was verified", () => {
    const goal = markGoalMet(newGoal("approve the copy", T0, undefined, { kind: "human" }), T0);
    expect(stallReport(quiet(goal)).verdict).toBe("finished");
  });

  it("a RED-tier row is never examined for it — those statuses do not reach this surface", () => {
    // `stallReport` answers `active` for anything outside `idle`/`unmerged`, so an agent already
    // asking a question cannot also be handed a second alarm by this cause.
    const goal = escalateGoal(newGoal("approve the copy", T0, undefined, { kind: "human" }), T0, "spent");
    expect(stallReport({ ...quiet(goal), status: "waiting" }).verdict).toBe("active");
  });
});

// ── THE FOUNDER'S ROW: blocked on a human, drawn AMBER (2026-08-18) ────────────────────────────────
//
// *"I see that the Sparkle CI runner spot auto scaler has a blocked on human issue. By the way the
// dot is amber or yellow and not red. It seems like this should be a red dot so that seems
// problematic that it's not showing as red when it says it's blocked on human."*
//
// THE ROW, exactly as reported: `status: idle`, stall verdict `stalled`, causes `['escalated-goal']`,
// `goal.state: 'escalated'`, `escalationStale: true`. It SAID blocked-on-human — in agent-authored
// prose interpolated into its goal badge — while the colour system, which reads only structural
// causes, saw an escalated goal and correctly rendered the amber `lapsed` tier.
//
// The fix is not to redden `escalated-goal` (that is the 2026-08-06 wall of false red, and this file
// pins it amber above). It is to give the app a STRUCTURAL way to say "a person is the blocker" —
// `engine/humanBlock`, relaying the answer `nudge_ladder.rs` already collects and that nothing read.
describe("blocked-on-human — the agent's own answer reaches the dot", () => {
  const T0 = 1_700_000_000_000;
  /** The founder's row: idle, escalated goal, everything else clean. `humanBlock` is the ONE thing
   *  that varies between the cases below, which is what makes the pair non-vacuous. */
  const row = (humanBlock?: { raisedAtMs: number }): StallInput => ({
    status: "idle",
    now: T0 + 1,
    goal: escalateGoal(newGoal("keep the CI runner autoscaler green", T0), T0, "budget spent"),
    hasOpenPr: false,
    hasUnlandedWork: false,
    hasUncommittedChanges: false,
    ...(humanBlock ? { humanBlock } : {}),
  });

  it("idle + escalated goal + the agent said a person is blocking it → RED", () => {
    const report = stallReport(row({ raisedAtMs: T0 }));
    expect(report.verdict).toBe("stalled");
    expect(report.causes).toContain("blocked-on-human");
    expect(escalationFor(report)).toBe("blocked");
    expect(isRedStatus(escalationFor(report))).toBe(true);
    expect(bandOfStatus("blocked")).toBe("needs_you");
  });

  it("…and the SAME row without that answer is still AMBER — the flag is what moves it", () => {
    // THE PAIRED NEGATIVE, and the assertion that keeps the one above from being vacuous. Every
    // other field is identical, so a green pair proves the human block is doing the work rather than
    // the fixture happening to be red for some unrelated reason. It also pins the half of the
    // founder's 2026-08-06 rule that must NOT regress: an escalated goal on its own stays amber.
    const report = stallReport(row());
    expect(report.causes).toEqual(["escalated-goal"]);
    expect(escalationFor(report)).toBe("lapsed");
    expect(isRedStatus(escalationFor(report))).toBe(false);
    expect(needsAttention("lapsed")).toBe(false);
  });

  it("a STALE escalation does not redden the row on its own — prose is never a colour input", () => {
    // The founder's second instruction the same day: a stale escalation must never be red. His row's
    // escalation sentence quoted a release run that had already terminally failed, so the row
    // asserted a blocker that no longer existed. Pin that the prose has no colour authority at all:
    // a goal whose escalation quotes text it no longer holds is still merely `escalated-goal`.
    const escalated = escalateGoal(newGoal("watch release run 123", T0), T0, "run 123 needs a human");
    const stale = { ...escalated, text: "something else entirely" };
    expect(escalationQuotesStaleText(stale)).toBe(true);
    const report = stallReport({ ...row(), goal: stale });
    expect(report.causes).not.toContain("blocked-on-human");
    expect(escalationFor(report)).toBe("lapsed");
  });

  it("a FRESH answer still reddens a row whose escalation prose is stale — different evidence", () => {
    // The fork the founder settled: staleness is a property of the frozen `escalationReason`
    // SENTENCE, which `chargeGoalDebt` carries onto later goal text so it outlives what it describes.
    // A nudger flag cannot acquire that property — `nudger.rs::apply_flags` clears it the first time
    // the agent moves — so a live flag is current evidence and is not vetoed by stale prose.
    const escalated = escalateGoal(newGoal("watch release run 123", T0), T0, "run 123 needs a human");
    const stale = { ...escalated, text: "something else entirely" };
    const report = stallReport({ ...row({ raisedAtMs: T0 }), goal: stale });
    expect(escalationQuotesStaleText(stale)).toBe(true);
    expect(escalationFor(report)).toBe("blocked");
  });

  it("only the FOUNDER-targeted `blocked-on-human` reply raises it", () => {
    // `Standdown::flag()` routes several blocked-shaped replies to the CONCIERGE on purpose — a
    // task-less agent (sparkle-dfy3d) and an out-of-context one (sparkle-umtx1) were both found
    // raising founder-level rows no person could act on. Reading the reply without the target would
    // re-open that class of false alarm in the module built to avoid it.
    expect(humanBlockOf({ target: "founder", reply: "blocked-on-human", raisedAtMs: T0 })).toEqual({
      raisedAtMs: T0,
    });
    for (const flag of [
      { target: "concierge", reply: "blocked-on-human", raisedAtMs: T0 },
      { target: "founder", reply: "blocked-on-ci", raisedAtMs: T0 },
      { target: "founder", reply: "out-of-context", raisedAtMs: T0 },
      { target: "founder", reply: "no-task-assigned", raisedAtMs: T0 },
      { target: "founder", reply: "not-blocked", raisedAtMs: T0 },
      { target: "founder", reply: null, raisedAtMs: T0 },
      { target: "founder", raisedAtMs: T0 },
    ]) {
      expect(humanBlockOf(flag)).toBeUndefined();
    }
    expect(humanBlockOf(undefined)).toBeUndefined();
  });
});

// ── THE OTHER HALF OF THE SAME COMPLAINT: copy that says "yours" while colouring "not yours" ───────
describe("rearms-exhausted — the state whose label already addressed the founder", () => {
  const T0 = 1_700_000_000_000;
  const rowWith = (conciergeRearms: number): StallInput => ({
    status: "idle",
    now: T0 + 1,
    goal: { ...escalateGoal(newGoal("land the retry PR", T0), T0, "budget spent"), conciergeRearms },
    hasOpenPr: false,
    hasUnlandedWork: false,
    hasUncommittedChanges: false,
  });

  it("every re-arm spent → RED: no machine actor may restart it again", () => {
    const report = stallReport(rowWith(MAX_CONCIERGE_REARMS));
    expect(report.causes).toContain("rearms-exhausted");
    expect(escalationFor(report)).toBe("blocked");
  });

  it("…with re-arms still LEFT it stays AMBER — the concierge is the actor, not him", () => {
    // The paired negative again, and the boundary that keeps this from being "escalated-goal is red"
    // wearing a new name: one re-arm short of the cap the row is still somebody else's to clear.
    const report = stallReport(rowWith(MAX_CONCIERGE_REARMS - 1));
    expect(report.causes).not.toContain("rearms-exhausted");
    expect(escalationFor(report)).toBe("lapsed");
  });

  it("a never-re-armed escalated goal is untouched — the 2026-08-06 demotion still holds", () => {
    const report = stallReport(rowWith(0));
    expect(report.causes).toEqual(["escalated-goal"]);
    expect(escalationFor(report)).toBe("lapsed");
  });
});

// ── THE STATUS PRECONDITION ON `blocked-on-human`, PINNED IN BOTH DIRECTIONS (roborev 65339) ───────
//
// The cause sits below `agentStall`'s `isQuiet` gate, so it is reachable only from a resting status.
// Every other test in this file seeds `idle`, which left the boundary unasserted in either
// direction — and an unasserted boundary is where a later "obvious" hoist lands without anyone
// noticing it changed the roster's verdict.
describe("blocked-on-human is gated on a resting status", () => {
  const T0 = 1_700_000_000_000;
  const at = (status: StallInput["status"]): StallReport =>
    stallReport({
      status,
      now: T0 + 1,
      goal: undefined,
      hasOpenPr: false,
      hasUnlandedWork: false,
      hasUncommittedChanges: false,
      humanBlock: { raisedAtMs: T0 },
    });

  it("a RESTING flagged agent raises it and goes RED", () => {
    for (const s of ["idle", "unmerged"] as const) {
      expect(at(s).causes).toContain("blocked-on-human");
      expect(escalationFor(at(s))).toBe("blocked");
    }
  });

  it("a WORKING or unobserved flagged agent does NOT — the verdict is `active`, not a contradiction", () => {
    // Deliberate, not an oversight. `ESCALATABLE` is idle/unmerged only, so hoisting the cause above
    // the gate would change no dot; and the flag self-corrects (`nudger.rs::apply_flags` clears it
    // the first time the agent moves, and a `working` status means it IS producing output). Reporting
    // `stalled` about a row the app simultaneously calls `working` would put a contradiction into the
    // roster and buy nothing. If this is ever hoisted, it must be a deliberate change with its own
    // evidence — this test is what makes that a decision rather than an accident.
    for (const s of ["working", "stopped"] as const) {
      expect(at(s).verdict).toBe("active");
      expect(at(s).causes).toEqual([]);
    }
  });
});

// ── THE FOUNDER'S 2026-08-18 RULE, END TO END: red = STUCK, not "awaiting your review-close" ───────
//
// The red dot is the signal the founder PHYSICALLY acts on — he goes and checks every one — so it
// must mean the agent is stuck and only he can unblock it. This block drives the full production chain
// `stallReport → escalationFor → bandOfStatus` (the founder-visible DOT is the band, not any
// intermediate) and asserts the classification directly. One negative (the row to calm) and a matched
// set of positives (the reds that must not weaken) — the pairing is the point, so a change that calms
// the negative by emptying the red tier fails on the positives.
describe("verify:human awaiting review-close is NOT red; genuine blockers stay red (band-level)", () => {
  const T0 = 1_700_000_000_000;
  // The final status a resting agent presents, exactly as the sidebar composes it.
  const finalStatus = (input: StallInput): AgentTabStatus =>
    escalationFor(stallReport(input)) ?? input.status;
  // …and the band that drives the row's dot and the "N agents need you" count.
  const finalBand = (input: StallInput) => bandOfStatus(finalStatus(input));
  const restingIdle = (goal: AgentGoal | undefined): StallInput => ({
    status: "idle",
    now: T0 + 1,
    goal,
    hasOpenPr: false,
    hasUnlandedWork: false,
    hasUncommittedChanges: false,
  });

  it("work complete + verify:human + self-reported not-blocked → DONE band, never needs_you", () => {
    // The exact false-alarm row: the agent finished, its `{kind:"human"}` check was chosen for THIS
    // goal, auto-continue then spent its budget asking "is it done?" and escalated — but the agent
    // needs nothing, it is awaiting the founder's review-close. Assert the BAND (the dot), not the
    // status name: it must be `done`, off the red count.
    const goal = escalateGoal(
      newGoal("approve the launch copy", T0, undefined, { kind: "human" }),
      T0,
      "budget spent",
    );
    expect(goal.verifyStated).toBe(true);
    expect(goal.verifyInherited).toBe(undefined); // chosen HERE, so the cause is raised
    expect(stallReport(restingIdle(goal)).causes).toContain("human-verified-goal");
    expect(finalStatus(restingIdle(goal))).toBe("lapsed");
    expect(finalBand(restingIdle(goal))).toBe("done");
    expect(finalBand(restingIdle(goal))).not.toBe("needs_you");
  });

  it("…and it is still SURFACED — the chip cause is raised, so he can find and close it", () => {
    // Not red is not the same as not shown. The affordance survives: the row leaves calm gray and
    // carries the raised cause the "awaiting your sign-off" chip is built from.
    const goal = escalateGoal(
      newGoal("approve the launch copy", T0, undefined, { kind: "human" }),
      T0,
      "budget spent",
    );
    const report = stallReport(restingIdle(goal));
    expect(report.verdict).toBe("stalled");
    expect(report.causes).toContain("human-verified-goal");
    expect(finalStatus(restingIdle(goal))).not.toBe("idle"); // left calm gray, into amber
  });

  // ── PAIRED POSITIVES: every genuine blocker MUST stay in needs_you (red) ────────────────────────

  it("gave up on UNLANDED work nobody is coming for → needs_you (red), the disposition is his", () => {
    // A stranded branch with no PR: auto-continue spent its budget AND git shows committed work the
    // default branch lacks. The agent cannot proceed and only he can dispose of it — genuinely stuck.
    const goal = {
      ...newGoal("finish and land the migration", T0),
      escalatedAt: T0 + 1,
      abandonedAt: T0 + 1,
      abandonedEvidence: "2 commits on the branch, no PR, not in origin/main",
    };
    const input = restingIdle(goal);
    expect(stallReport(input).causes).toContain("abandoned-goal");
    expect(finalStatus(input)).toBe("blocked");
    expect(finalBand(input)).toBe("needs_you");
  });

  it("errored / auth-wall / blocked-on-human / a live question all band needs_you", () => {
    // The genuinely-red PTY statuses `statusEngine` derives (a crash, a sign-in wall surfaced as
    // errored, an approval prompt, a question that halts the turn). They never pass through the stall
    // surface (`stallReport` answers `active` outside idle/unmerged), so they are untouched by the
    // amber change and must stay red. Asserted as the BAND, the thing the dot reads.
    for (const s of ["errored", "waiting", "approval", "blocked"] as const) {
      expect(bandOfStatus(s)).toBe("needs_you");
      expect(isRedStatus(s)).toBe(true);
    }
  });

  it("the negative and the positives really differ — the split is non-vacuous", () => {
    // If a refactor ever collapsed `lapsed` and `blocked` into one band this would catch it: the
    // awaiting-review row and the stuck-work row must land in DIFFERENT bands.
    const awaitingReview = escalateGoal(
      newGoal("approve the launch copy", T0, undefined, { kind: "human" }),
      T0,
      "budget spent",
    );
    const stranded = {
      ...newGoal("finish and land the migration", T0),
      escalatedAt: T0 + 1,
      abandonedAt: T0 + 1,
    };
    expect(finalBand(restingIdle(awaitingReview))).not.toBe(
      finalBand(restingIdle(stranded)),
    );
  });
});
