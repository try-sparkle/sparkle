import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusEngine } from "./statusEngine";
import { isApiErrorLine, isSelfPromptLine, StreamFailureDetector } from "./streamFailure";
import { needsAttention } from "./attention";
import { escalationFor } from "./stallEscalation";
import { bandOfStatus } from "./buildSections";
import { isRedStatus } from "../services/windowStatus";
import { AGENT_STATUS } from "@sparkle/ui";
import type { StallCause, StallReport } from "./agentStall";
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
// A taxonomy where red means two different things is a taxonomy that means one thing: go look.
// These cases fail if `escalated-goal` is ever put back in `OUTSTANDING`.
describe("AMBER lifecycle vs RED needs-you — red is reserved for the human", () => {
  const report = (causes: StallCause[]): StallReport => ({
    verdict: causes.length ? "stalled" : "finished",
    causes,
    detail: "",
  });

  it("auto-continue gave up, nothing outstanding → AMBER, never red", () => {
    expect(escalationFor(report(["escalated-goal"]))).toBe("lapsed");
    expect(isRedStatus("lapsed")).toBe(false);
    expect(AGENT_STATUS.lapsed.color).not.toBe(AGENT_STATUS.waiting.color);
  });

  it("a lapsed goal never becomes a badge or a banner", () => {
    // The "N agents need you" count and the dock badge key off this set, NOT off the colour tier.
    // An amber row that still inflated the count would have moved the false alarm, not removed it.
    expect(needsAttention("lapsed")).toBe(false);
    expect(bandOfStatus("lapsed")).not.toBe("needs_you");
  });

  it("goal expired, nothing outstanding → still CALM, not amber and not red", () => {
    // `expired-goal` was already cut from the red tier by sparkle-biezi, and it stays calm here on
    // purpose: it is the higher-volume cause (every agent outliving its TTL earns one), so routing
    // it to amber would trade a wall of false red for a wall of amber. See LIFECYCLE's comment.
    expect(escalationFor(report(["expired-goal"]))).toBe(undefined);
  });

  // ── DO NOT REGRESS THE OPPOSITE FAILURE ────────────────────────────────────────────────────────
  // Sparkle's standing rule is never to hide a row that needs the founder. `OUTSTANDING` is tested
  // FIRST, so real work still outranks the amber tier whatever else is true of the row.
  it("gave up AND still holds unlanded work → STILL RED", () => {
    expect(escalationFor(report(["escalated-goal", "unlanded-work"]))).toBe("blocked");
    expect(isRedStatus("blocked")).toBe(true);
  });

  it("every OUTSTANDING cause still outranks a lifecycle one", () => {
    for (const c of ["unmet-goal", "open-pr", "unlanded-work", "uncommitted-changes"] as const) {
      expect(escalationFor(report(["escalated-goal", c]))).toBe("blocked");
    }
  });

  it("the asking statuses are untouched — still red, still notified", () => {
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
});
