import { beforeEach, describe, expect, it } from "vitest";
import type { HookEvent } from "./hookEvents";
import {
  COMPACT_PRESSURE_LIMIT,
  COMPACT_WINDOW_MS,
  NO_TOOL_TURN_LIMIT,
  NUDGE_LOOP_LIMIT,
  REPEAT_LIMIT,
  forgetThrash,
  initialThrashState,
  noteThrashEvent,
  reduceThrash,
  resetThrashTracking,
  thrashReport,
  thrashReportFor,
  type ThrashState,
} from "./agentThrash";
import { continuePrompt } from "./goalContinuation";

const T0 = 1_700_000_000_000;

/** A real nudge line at rung `n`. The text is a pure function of a counter and a duration, which is
 *  exactly why consecutive ones are byte-identical — see engine/agentOriginated.NUDGE_PROMPT_MARKER. */
const nudge = (n: number): string =>
  `[sparkle-nudge #${n} · no output for ${n * 5}m] Automated ping, not a new task. Resume your ` +
  `goal. If you are blocked, reply with ONE line: blocked-on-human | blocked-on-ci | ` +
  `blocked-on-quota | not-blocked — <what you need>.`;

/** Fold a whole event stream, as the hook watcher does. */
function run(events: HookEvent[], from: ThrashState = initialThrashState()): ThrashState {
  return events.reduce((s, ev) => reduceThrash(s, ev), from);
}

/** One complete turn: prompt in, optional tools, Stop. */
function turn(prompt: string, tools: string[] = [], ts = T0): HookEvent[] {
  return [
    { event: "UserPromptSubmit", prompt, ts },
    ...tools.map((tool) => ({ event: "PreToolUse", tool, ts })),
    { event: "Stop", ts },
  ];
}

describe("the observed case — agent a0d5dc98, three /compacts", () => {
  it("catches the exact sequence the founder had to read the terminal to find", () => {
    // > /compact  (Compacted) / > /compact / > /compact  (Not enough messages to compact.)
    // Each submission runs no tools, and each triggers a compaction.
    const events: HookEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push({ event: "UserPromptSubmit", prompt: "/compact", ts: T0 + i * 30_000 });
      events.push({ event: "PreCompact", ts: T0 + i * 30_000 });
      events.push({ event: "Stop", ts: T0 + i * 30_000 });
    }
    const report = thrashReport(run(events), T0 + 90_000, {});

    expect(report.thrashing).toBe(true);
    // The CAUSE, not the symptom: it is out of context, and that is why it is looping.
    expect(report.verdict).toBe("context-pressure");
    expect(report.recentCompactions).toBe(3);
    expect(report.repeatedCommand).toEqual({ text: "/compact", count: 3 });
    expect(report.detail).toContain("running out of usable context");
  });

  it("would have caught it on repetition alone, even with no PreCompact events", () => {
    // Defense in depth. PreCompact only started being emitted with this change, and whether a
    // built-in slash command fires UserPromptSubmit at all is Claude Code's business, not ours —
    // so neither signal is allowed to be the only one that works.
    const events = [0, 1, 2].flatMap((i) => turn("/compact", [], T0 + i * 30_000));
    const report = thrashReport(run(events), T0 + 90_000, {});
    expect(report.thrashing).toBe(true);
    expect(report.verdict).toBe("repeating-command");
  });
});

describe("repeated commands", () => {
  // These fixtures use TOOL-LESS turns throughout: a repeat only counts when the turn between the
  // two submissions did nothing (see the sibling describe below), so a run built from turns that
  // ran tools would never accumulate and every assertion here would be vacuous.
  it("stays healthy below the limit — retrying once is ordinary", () => {
    const events = Array.from({ length: REPEAT_LIMIT - 1 }, () => turn("pnpm test")).flat();
    expect(thrashReport(run(events), T0, {}).verdict).toBe("healthy");
  });

  it("flags the run once it reaches the limit", () => {
    const events = Array.from({ length: REPEAT_LIMIT }, () => turn("pnpm test")).flat();
    const r = thrashReport(run(events), T0, {});
    expect(r.verdict).toBe("repeating-command");
    expect(r.repeatedCommand).toEqual({ text: "pnpm test", count: REPEAT_LIMIT });
  });

  it("a DIFFERENT command breaks the run", () => {
    const events = [
      ...Array.from({ length: REPEAT_LIMIT - 1 }, () => turn("same")).flat(),
      ...turn("something else"),
      ...turn("same"),
    ];
    expect(thrashReport(run(events), T0, {}).verdict).toBe("healthy");
  });

  it("ignores whitespace-only differences, so re-typing the same thing still counts", () => {
    const events = [turn("  /compact  "), turn("/compact"), turn("/compact")].flat();
    expect(thrashReport(run(events), T0, {}).repeatedCommand?.count).toBe(3);
  });

  it("an event with no prompt text neither extends nor resets a run", () => {
    // "We didn't observe this one" must not be read as either answer.
    const partial = run([
      ...turn("x"),
      ...turn("x"),
      { event: "UserPromptSubmit", ts: T0 }, // no prompt field
    ]);
    expect(partial.repeatCount).toBe(2);
    expect(partial.lastCommand).toBe("x");
  });
});

describe("the auto-resume banner is excluded from repetition ENTIRELY", () => {
  // THE REAL STRING, produced by the real sender. The previous version of this test hand-wrote a
  // truncated approximation of the banner, so it could not have caught the 2026-07-30 recurrence
  // even in principle — it was testing a string that nothing sends. `continuePrompt` is now the
  // fixture, and `agentOriginated.test.ts` guards the round trip from the other side.
  const RESUME = continuePrompt({
    text: "land the retry PR",
    setAt: 0,
    ttlMs: 4 * 3_600_000,
    continues: 0,
    totalContinues: 0,
  });

  it("this feature's OWN auto-continue prompt does not read as a loop", () => {
    // goalContinuation.continuePrompt is a pure function of goal.text, so every auto-continue for
    // one goal submits a byte-identical string and MAX_CONTINUES_TOTAL permits twenty of them. An
    // agent restarted three times that edited, tested and committed in each turn used to be
    // reported "It is looping, not working" — the precise inverse judgement, on the healthy path
    // of the sibling feature (roborev 55259).
    const events = [0, 1, 2, 3].flatMap(() => turn(RESUME, ["Edit", "Bash"]));
    const r = thrashReport(run(events), T0, { goalOutstanding: true });
    expect(r.verdict).toBe("healthy");
    expect(r.repeatedCommand).toBeUndefined();
  });

  it("stays healthy even when the intervening work is NEVER OBSERVED — agent 0bf08c64", () => {
    // THE ACTUAL 2026-07-30 REGRESSION, and the one the `workHappened` guard could not stop. The
    // agent was working continuously for 46 minutes — writing retraction tests, running typecheck
    // and vitest — but this registry is fed from AgentPane's watcher, so an unmounted pane or a
    // dropped PreToolUse leaves the resumes looking adjacent with no work between them. The old
    // guard read that absence of evidence as evidence of a loop and badged the row
    // `repeating-command`; the human relayed "it is looping and burning turns" to the founder about
    // an agent that was doing real work the whole time.
    //
    // Note there is not a single tool event in this stream: that is the point. The verdict must not
    // depend on our having seen the work, because the banner carries no information either way.
    const events = [0, 1, 2, 3, 4].flatMap((i) => turn(RESUME, [], T0 + i * 60_000));
    const r = thrashReport(run(events), T0 + 300_000, { goalOutstanding: true });
    expect(r.repeatedCommand).toBeUndefined();
    // THE ROW READS CALM — asserted as `thrashing`, not as "the verdict isn't the one I named".
    // A `not.toBe("repeating-command")` passes while the verdict is `no-progress`, which renders a
    // "No progress" chip: the SAME false claim about the same agent, one badge over, and just as
    // relayable to the founder as fact. Absence of observed tool events is not evidence the agent
    // ran none — see `sawToolEver`.
    expect(r.thrashing).toBe(false);
    expect(r.verdict).toBe("healthy");
    expect(r.detail).not.toContain("looping");
  });

  it("a human's repeats stay healthy across resumes when EVERY turn did real work", () => {
    // THE REGRESSION MAKING THE RESUME MERELY INERT WOULD HAVE INTRODUCED. The resume arm preserves
    // `lastTurnRanTool`, but the `Stop` closing the resume's own turn used to overwrite it with
    // that turn's (empty) `toolInCurrentTurn` — destroying the work evidence one event later. A
    // human typing the same command three times, working in every single turn, then accumulated to
    // `repeating-command`: "It is looping, not working", about an agent that ran a tool every turn.
    // Same false-positive class as roborev 55259/55314, reached through the resume door.
    //
    // REPEAT_LIMIT human submissions, deliberately: the earlier two-submission version of this test
    // could not reach the limit and passed byte-identically whether or not the flag survived, so it
    // was vacuous with respect to the property it claimed to guard.
    const events = [
      ...turn("run it", ["Bash"]),
      ...turn(RESUME, []),
      ...turn("run it", ["Bash"]),
      ...turn(RESUME, []),
      ...turn("run it", ["Bash"]),
    ];
    const r = thrashReport(run(events), T0, { goalOutstanding: true });
    expect(r.verdict).toBe("healthy");
    expect(r.repeatedCommand).toBeUndefined();
  });

  it("does not let a resume LAUNDER a real loop — the human's repeats still count across it", () => {
    // The exclusion must be inert, not amnesic. If a resume RESET the run, an agent looping on
    // /compact that happened to be auto-continued between repeats would be scrubbed clean and the
    // detector would go quiet on exactly the case it was built for. The resume is skipped over; the
    // human's own submissions on either side of it still form one run.
    const events = [
      ...turn("/compact", []),
      ...turn(RESUME, []),
      ...turn("/compact", []),
      ...turn(RESUME, []),
      ...turn("/compact", []),
    ];
    const r = thrashReport(run(events), T0, {});
    expect(r.verdict).toBe("repeating-command");
    expect(r.repeatedCommand).toEqual({ text: "/compact", count: REPEAT_LIMIT });
  });

  // ── THE OTHER SYSTEM-AUTHORED PROMPTS (sparkle-sknz2) ────────────────────────────────────────
  //
  // The resume banner was the only one this detector knew about, and it is not the only one that
  // arrives. Measured in a real agent's transcripts (61a5332f, 20 newest sessions): the goal-EXPIRY
  // banner and `<task-notification>` both land as `type:"user"` records — 13 of them — and both were
  // being tallied as things the agent chose to submit.
  //
  // These fixtures are REAL RECORD OPENINGS, not paraphrases, for the reason the RESUME fixture was
  // switched to `continuePrompt`: a hand-written approximation tests a string nothing sends.
  const EXPIRY =
    "Your goal expired unmet and you are resting with work unfinished — nothing is coming to " +
    "finish this for you.";
  const NOTIFICATION =
    '<task-notification> <task-id>b4shdddfs</task-id> <summary>Monitor event: "CI checks on ' +
    "PR #939 completed</summary></task-notification>";

  it.each([
    ["the goal-expiry banner", EXPIRY],
    ["a background-task notification", NOTIFICATION],
  ])("%s does not read as a loop, even unobserved", (_label, banner) => {
    // Byte-identical repeats by construction, and NOT ONE TOOL EVENT — the same shape as the
    // agent 0bf08c64 case above. The verdict must not depend on our having observed the work,
    // because the banner carries no information about the agent either way.
    const events = [0, 1, 2, 3, 4].flatMap((i) => turn(banner, [], T0 + i * 60_000));
    const r = thrashReport(run(events), T0 + 300_000, { goalOutstanding: true });
    // Asserted as `healthy`, never `not.toBe("repeating-command")` — that weaker form passes while
    // the row renders "No progress", which is the same false accusation wearing a different label.
    expect(r.verdict).toBe("healthy");
    expect(r.repeatedCommand).toBeUndefined();
    expect(r.detail).not.toContain("looping");
  });

  it.each([
    ["the goal-expiry banner", EXPIRY],
    ["a background-task notification", NOTIFICATION],
  ])("%s is INERT, not amnesic — a real loop still counts across it", (_label, banner) => {
    // The exclusion must skip the banner without resetting the run. If it scrubbed the streak, an
    // agent genuinely looping on /compact that happened to be interrupted by one of these would go
    // undetected — the detector silenced on exactly the case it exists for. Same contract the
    // resume arm is held to directly above.
    const events = [
      ...turn("/compact", []),
      ...turn(banner, []),
      ...turn("/compact", []),
      ...turn(banner, []),
      ...turn("/compact", []),
    ];
    const r = thrashReport(run(events), T0, {});
    expect(r.verdict).toBe("repeating-command");
    expect(r.repeatedCommand).toEqual({ text: "/compact", count: REPEAT_LIMIT });
  });

  it("a resume that lands MID-TURN does not swallow that turn's work", () => {
    // THE OTHER HALF OF THE EVIDENCE. `repeatOf` reads `lastTurnRanTool || toolInCurrentTurn`
    // precisely because a turn can be interrupted and never close (roborev 55314) — the human
    // presses ESC, or the `Stop` is simply dropped. The resume arm protected the first half and
    // still zeroed the second at submission, so a resume arriving while a turn was open destroyed
    // the very evidence `resumeTurn` was added to protect, one event EARLIER instead of one later.
    // This is the same mistake the `SessionStart{compact}` arm was already fixed for.
    //
    // Every other resume fixture in this file is `turn(RESUME, [])` — i.e. preceded by a Stop — so
    // none of them could reach this. The agent here runs a tool in EVERY turn.
    const events = [0, 1, 2].flatMap((i) => [
      { event: "UserPromptSubmit", prompt: "pnpm test", ts: T0 + i * 60_000 } as HookEvent,
      { event: "PreToolUse", tool: "Bash", ts: T0 + i * 60_000 } as HookEvent,
      // no Stop — the turn is interrupted, exactly the documented production shape
      { event: "UserPromptSubmit", prompt: RESUME, ts: T0 + i * 60_000 } as HookEvent,
      { event: "Stop", ts: T0 + i * 60_000 } as HookEvent,
    ]);
    const r = thrashReport(run(events), T0 + 180_000, { goalOutstanding: true });
    // Both verdicts have to stay clear: the repeat run must not build, AND the swallowed work must
    // still break the no-tool streak (it passes `sawToolEver`, so nothing else would stop it).
    expect(r.verdict).toBe("healthy");
    expect(r.repeatedCommand).toBeUndefined();
    expect(r.turnsWithoutTool).toBeLessThan(NO_TOOL_TURN_LIMIT);
  });

  it("still counts resumed turns toward NO-PROGRESS once this window has SEEN a tool", () => {
    // The exclusion is scoped to REPETITION, deliberately. An agent resumed repeatedly that runs no
    // tools is going nowhere, and that is a true finding the detector must keep making — the rule
    // is that the banner is not evidence FOR a loop, not that it is evidence AGAINST one.
    //
    // But it may only be made once this window has PROVED it receives tool events for this agent,
    // which the opening turn does. Without that proof, "no tools ran" and "no tools reached us" are
    // the same picture — see the partial-observation test above.
    const events = [
      ...turn("start", ["Bash"]),
      ...[0, 1, 2].flatMap((i) => turn(RESUME, [], T0 + i * 60_000)),
    ];
    const r = thrashReport(run(events), T0, { goalOutstanding: true });
    expect(r.turnsWithoutTool).toBe(NO_TOOL_TURN_LIMIT);
    expect(r.verdict).toBe("no-progress");
  });
});

describe("a repeat only counts when the turn between did nothing", () => {

  it("a human typing 'continue' three times while the agent works is healthy", () => {
    const events = [0, 1, 2].flatMap(() => turn("continue", ["Bash"]));
    expect(thrashReport(run(events), T0, { goalOutstanding: true }).verdict).toBe("healthy");
  });

  it("but the same prompt with NO work in between is still a loop", () => {
    // The evidence that separates the two: the /compact case ran no tools in each repeated turn.
    const events = [0, 1, 2].flatMap(() => turn("/compact", []));
    expect(thrashReport(run(events), T0, {}).verdict).toBe("repeating-command");
  });

  it("a loop with NO Stop between the repeats is still a loop", () => {
    // The flag must mean "did anything run SINCE THE LAST SUBMISSION", not "did the last turn that
    // happened to CLOSE run something" (roborev 55296). A built-in slash command produces no
    // assistant turn and therefore no Stop — the observed incident's exact shape — so every repeat
    // read the previous WORKING turn's flag, reset the run, and the loop was never flagged.
    const events: HookEvent[] = [
      ...turn("build the thing", ["Edit", "Bash"]), // a real working turn, which closes
      { event: "UserPromptSubmit", prompt: "/compact", ts: T0 + 1 },
      { event: "UserPromptSubmit", prompt: "/compact", ts: T0 + 2 },
      { event: "UserPromptSubmit", prompt: "/compact", ts: T0 + 3 },
    ];
    const r = thrashReport(run(events), T0 + 4, {});
    expect(r.verdict).toBe("repeating-command");
    expect(r.repeatedCommand).toEqual({ text: "/compact", count: 3 });
  });

  it("an INTERRUPTED working turn is not a loop — tools ran, the Stop just never came", () => {
    // The regression the submit-time clear introduced (roborev 55314). The human presses ESC, so no
    // Stop arrives and `lastTurnRanTool` is never written — but `toolInCurrentTurn` saw the work, and
    // the rule now reads both. Without this the row said "it is looping, not working" about an agent
    // that ran a tool on every one of those turns.
    const events: HookEvent[] = [];
    for (let i = 0; i < REPEAT_LIMIT + 1; i++) {
      events.push({ event: "UserPromptSubmit", prompt: "pnpm test", ts: T0 + i });
      events.push({ event: "PreToolUse", tool: "Bash", ts: T0 + i }); // work, then interrupted
    }
    const r = thrashReport(run(events), T0 + 99, {});
    expect(r.repeatedCommand).toBeUndefined();
    expect(r.verdict).toBe("healthy");
  });

  it("real work in the middle breaks an existing run", () => {
    const events = [
      ...turn("stuck", []),
      ...turn("stuck", []),
      ...turn("stuck", ["Edit"]), // it finally did something
      ...turn("stuck", []),
    ];
    expect(thrashReport(run(events), T0, {}).repeatedCommand).toBeUndefined();
  });
});

describe("turns that do no work", () => {
  it("a turn that runs tools resets the streak", () => {
    const events = [
      ...turn("a", []),
      ...turn("b", []),
      ...turn("c", ["Edit"]), // real work
      ...turn("d", []),
    ];
    expect(run(events).turnsWithoutTool).toBe(1);
  });

  /** A stream that opens with one WORKING turn, then N tool-less ones.
   *
   *  The opening turn is not decoration: `no-progress` reads the ABSENCE of `PreToolUse` as its
   *  evidence, and may only do so once this window has proved it RECEIVES tool events for this
   *  agent (`sawToolEver`). It is also the more production-shaped fixture — a real agent runs
   *  something before it stops running anything. */
  function afterRealWork(prose: number, prompt = (i: number) => `q${i}`): HookEvent[] {
    return [
      ...turn("start", ["Bash"]),
      ...Array.from({ length: prose }, (_, i) => turn(prompt(i), [])).flat(),
    ];
  }

  it("flags N consecutive tool-less turns WHEN a goal is outstanding", () => {
    const r = thrashReport(run(afterRealWork(NO_TOOL_TURN_LIMIT)), T0, { goalOutstanding: true });
    expect(r.verdict).toBe("no-progress");
    expect(r.detail).toContain("Output is not progress");
  });

  it("will NOT alarm when this window has never seen a tool — absence is not evidence", () => {
    // The registry is fed from AgentPane's watcher, so "the agent ran no tools" and "no tool events
    // reached us" are the same picture until one arrives. Alarming on the second is how the
    // `repeating-command` false positive would have simply relabelled itself as "No progress" over
    // the very agent it was fixed for. The streak is still reported; only the alarm is withheld.
    const events = Array.from({ length: NO_TOOL_TURN_LIMIT + 2 }, (_, i) => turn(`q${i}`, [])).flat();
    const r = thrashReport(run(events), T0, { goalOutstanding: true });
    expect(r.turnsWithoutTool).toBe(NO_TOOL_TURN_LIMIT + 2);
    expect(r.verdict).toBe("healthy");
    expect(r.thrashing).toBe(false);
  });

  // ── WHAT THE COVERAGE GATE DOES NOT COVER ───────────────────────────────────────────────────
  // These two tests exist to make the gate's limits a RECORDED DECISION rather than an implicit
  // one. Both assert today's actual behaviour, and both are cases the gate gets wrong in the
  // direction of silence. See `ThrashState.sawToolEver` and bead sparkle-98yth.

  it("KNOWN GAP: mid-stream tool-event loss is NOT covered — the latch is already armed", () => {
    // `sawToolEver` is a lifetime latch, so it only ever guards an accumulator that has seen NO
    // tool. Once one has arrived, dropped tool events later look exactly like an idle agent again
    // and `no-progress` alarms as it did before. If that — rather than a pane unmount — was the
    // mechanism behind the motivating incident, this gate would not have caught it.
    const events = [
      ...turn("start", ["Bash"]), // arms the latch
      ...[0, 1, 2].flatMap((i) => turn(`q${i}`, [], T0 + i * 60_000)), // work happening, unobserved
    ];
    const r = thrashReport(run(events), T0, { goalOutstanding: true });
    expect(r.verdict).toBe("no-progress");
    expect(r.thrashing).toBe(true);
  });

  it("KNOWN GAP: a prose-only agent — the rule's PRIMARY target — can no longer be flagged", () => {
    // An agent talking instead of working runs no tools by definition, so it never satisfies the
    // latch. This is the capability the gate costs, and it is accepted deliberately: a false "No
    // progress" on a hard-working agent misinformed the founder twice, and a detector whose false
    // positives land on working agents gets ignored entirely.
    const events = Array.from({ length: NO_TOOL_TURN_LIMIT + 5 }, (_, i) =>
      turn(`thinking out loud ${i}`, []),
    ).flat();
    const r = thrashReport(run(events), T0, { goalOutstanding: true });
    expect(r.turnsWithoutTool).toBe(NO_TOOL_TURN_LIMIT + 5); // the evidence IS collected
    expect(r.verdict).toBe("healthy"); // ...but never asserted on
  });

  it("does NOT flag ordinary conversation — three questions answered in prose", () => {
    // The rule's premise was always "while a goal is outstanding", but it used to consult no goal
    // and fired on any three prose turns. The founder asking an agent three questions got back
    // "it is producing output without doing anything" (roborev 55259). A detector whose false
    // positives land on conversation gets ignored.
    // Built on `afterRealWork` so the COVERAGE gate is already satisfied and this test isolates the
    // gate it names. Without the opening working turn it would pass for the wrong reason.
    const r = thrashReport(run(afterRealWork(NO_TOOL_TURN_LIMIT + 2)), T0, { goalOutstanding: false });
    expect(r.verdict).toBe("healthy");
    expect(r.thrashing).toBe(false);
    // The streak is still REPORTED — the evidence is not withheld, only the alarm.
    expect(r.turnsWithoutTool).toBe(NO_TOOL_TURN_LIMIT + 2);
  });

  it("an unknown goal state reports the streak without raising the alarm", () => {
    expect(thrashReport(run(afterRealWork(NO_TOOL_TURN_LIMIT)), T0, {}).thrashing).toBe(false);
  });

  it("a subagent's tool call counts as work — delegation is not idleness", () => {
    // Otherwise every orchestrator, the fleet's most valuable agent, reads as no-progress.
    const events = Array.from({ length: NO_TOOL_TURN_LIMIT + 2 }, (_, i) =>
      turn(`q${i}`, ["Task"]),
    ).flat();
    expect(thrashReport(run(events), T0, { goalOutstanding: true }).verdict).toBe("healthy");
  });

  it("a doubled Stop does not charge two no-tool turns for one turn", () => {
    const s = run([{ event: "UserPromptSubmit", prompt: "x" }, { event: "Stop" }, { event: "Stop" }]);
    expect(s.turnsWithoutTool).toBe(1);
  });

  it("an open turn is not yet counted — only a CLOSED turn can have run no tools", () => {
    const s = run([{ event: "UserPromptSubmit", prompt: "x" }]);
    expect(s.turnsWithoutTool).toBe(0);
  });
});

describe("context pressure", () => {
  it("one compaction is healthy housekeeping, but is still reported", () => {
    const r = thrashReport(run([{ event: "PreCompact", ts: T0 }]), T0, {});
    expect(r.verdict).toBe("healthy");
    expect(r.thrashing).toBe(false);
    // Surfaced even while healthy, so the human can see pressure BUILDING.
    expect(r.recentCompactions).toBe(1);
    expect(r.detail).toContain("worth watching");
  });

  it("fires at the limit — before the loop, which is the whole point", () => {
    const events = Array.from({ length: COMPACT_PRESSURE_LIMIT }, (_, i) => ({
      event: "PreCompact",
      ts: T0 + i * 1_000,
    }));
    const r = thrashReport(run(events), T0 + 2_000, {});
    expect(r.verdict).toBe("context-pressure");
    // No command has repeated yet — this is the early warning, not the post-mortem.
    expect(r.repeatedCommand).toBeUndefined();
  });

  it("measures a RATE, not a lifetime total", () => {
    // Two compactions a long way apart is a healthy long session, not a spiral.
    const events = [
      { event: "PreCompact", ts: T0 },
      { event: "PreCompact", ts: T0 + COMPACT_WINDOW_MS * 3 },
    ];
    const r = thrashReport(run(events), T0 + COMPACT_WINDOW_MS * 3, {});
    expect(r.recentCompactions).toBe(1);
    expect(r.verdict).toBe("healthy");
  });

  it("the PRODUCTION stream accumulates the no-tool streak across compactions", () => {
    // The fixture shaped like what actually arrives (roborev 55314). The earlier fixtures interleaved
    // PreCompact and Stop with NO SessionStart between them, which is not the stream Claude Code
    // produces — and the compaction arm used to zero `turnsWithoutTool`, so `no-progress` could never
    // reach its limit for a compacting agent at all. A compaction is not progress.
    // Opens with a real working turn so `sawToolEver` is satisfied — `no-progress` may not alarm on
    // absent tool events until this window has proved it receives them, and a compacting agent that
    // has done real work is the shape this fixture is claiming to model anyway.
    const events: HookEvent[] = [...turn("build it", ["Edit"], T0)];
    for (let i = 0; i < NO_TOOL_TURN_LIMIT; i++) {
      const ts = T0 + i * 1_000;
      events.push({ event: "UserPromptSubmit", prompt: `/compact ${i}`, ts });
      events.push({ event: "PreCompact", ts });
      events.push({ event: "SessionStart", source: "compact", ts });
      events.push({ event: "Stop", ts });
    }
    const state = run(events);
    expect(state.turnsWithoutTool).toBe(NO_TOOL_TURN_LIMIT);
    // Read PAST the compaction window, so `context-pressure` has aged out and cannot mask the verdict
    // under test. Asserting `.thrashing` at T0+9s was vacuous: three compactions 1s apart already trip
    // COMPACT_PRESSURE_LIMIT, so it was true against the UNFIXED reducer too (roborev 55379).
    const past = thrashReport(state, T0 + COMPACT_WINDOW_MS + 60_000, { goalOutstanding: true });
    expect(past.recentCompactions).toBe(0);
    expect(past.verdict).toBe("no-progress");
    expect(past.thrashing).toBe(true);
  });

  it("a mid-turn AUTO-compaction does not charge a working turn as tool-less", () => {
    // An auto-compaction fires mid-turn, so clearing `toolInCurrentTurn` there erased the evidence
    // that the open turn had already run tools and the following Stop pushed the streak the wrong way.
    const events: HookEvent[] = [
      { event: "UserPromptSubmit", prompt: "build it", ts: T0 },
      { event: "PreToolUse", tool: "Edit", ts: T0 },
      { event: "PreCompact", ts: T0 + 1 },
      { event: "SessionStart", source: "compact", ts: T0 + 2 },
      { event: "Stop", ts: T0 + 3 },
    ];
    expect(run(events).turnsWithoutTool).toBe(0);
  });

  it("names the cause ahead of the symptom", () => {
    // An agent both out of context AND repeating must be reported as out of context: sending the
    // human to debug the loop instead of the exhaustion wastes the alert.
    const events = [
      ...[0, 1, 2].flatMap((i) => turn("/compact", [], T0 + i)),
      { event: "PreCompact", ts: T0 },
      { event: "PreCompact", ts: T0 + 1 },
    ];
    const r = thrashReport(run(events), T0 + 2, {});
    expect(r.verdict).toBe("context-pressure");
    // ...but the symptom is still carried, so nothing is lost.
    expect(r.repeatedCommand?.text).toBe("/compact");
  });
});

describe("the per-agent registry", () => {
  beforeEach(() => resetThrashTracking());

  it("an unobserved agent reports undefined, never 'healthy'", () => {
    // Reading calm from an agent nobody is watching is the false negative this must not produce.
    expect(thrashReportFor("never-seen", T0, {})).toBeUndefined();
  });

  it("accumulates across events for one agent, isolated from another", () => {
    for (let i = 0; i < REPEAT_LIMIT; i++) {
      noteThrashEvent("a", { event: "UserPromptSubmit", prompt: "/compact", ts: T0 });
      noteThrashEvent("a", { event: "Stop", ts: T0 });
      noteThrashEvent("b", { event: "UserPromptSubmit", prompt: `distinct-${i}`, ts: T0 });
      noteThrashEvent("b", { event: "PreToolUse", tool: "Edit", ts: T0 });
      noteThrashEvent("b", { event: "Stop", ts: T0 });
    }
    expect(thrashReportFor("a", T0, {})?.verdict).toBe("repeating-command");
    expect(thrashReportFor("b", T0, {})?.verdict).toBe("healthy");
  });

  it("a STARTUP session clears prior context pressure — the remedy must actually work", () => {
    // context-pressure tells the human "it needs a fresh session". If the compaction timestamps
    // survived the restart, the fresh session kept reporting pressure and the module defeated its
    // own advice (roborev 55259).
    noteThrashEvent("a", { event: "PreCompact", ts: T0 });
    noteThrashEvent("a", { event: "PreCompact", ts: T0 + 1_000 });
    expect(thrashReportFor("a", T0 + 2_000, {})?.verdict).toBe("context-pressure");

    noteThrashEvent("a", { event: "SessionStart", source: "startup", ts: T0 + 3_000 });
    const after = thrashReportFor("a", T0 + 4_000, {});
    expect(after?.verdict).toBe("healthy");
    expect(after?.recentCompactions).toBe(0);
  });

  it.each(["compact", undefined] as const)(
    "a SessionStart with source=%s must NOT erase the pressure it is evidence of",
    (source) => {
      // THE BUG THAT KILLED THE DETECTOR (roborev 55296). SessionStart is not only a human restart:
      // Claude Code fires one after every COMPACTION — its matcher vocabulary is
      // `startup|resume|clear|compact` and Sparkle registers the event bare, so it receives all of
      // them. A blanket wipe therefore ran right after every PreCompact and deleted the timestamp
      // just recorded, so `recentCompactions` could never reach the limit and `context-pressure` —
      // the module's headline signal, and the whole reason PreCompact is registered — was dead in
      // production while the suite stayed green, because the fixtures had no SessionStart between
      // the compactions. This is the real production stream.
      //
      // `undefined` is covered by the same rule on purpose: destroying evidence on a guess is what
      // hid the bug, and the genuine-restart path is already covered by `forgetThrash`.
      noteThrashEvent("a", { event: "PreCompact", ts: T0 });
      noteThrashEvent("a", { event: "SessionStart", source, ts: T0 + 1 });
      noteThrashEvent("a", { event: "PreCompact", ts: T0 + 2_000 });
      const r = thrashReportFor("a", T0 + 3_000, {});
      expect(r?.recentCompactions).toBe(COMPACT_PRESSURE_LIMIT);
      expect(r?.verdict).toBe("context-pressure");
    },
  );

  it("a STARTUP session clears a half-built repeat run", () => {
    // Otherwise a session that ended on "pnpm test" made the FIRST identical prompt of the next
    // session trip the limit, reporting a loop off one submission.
    for (let i = 0; i < REPEAT_LIMIT - 1; i++) {
      noteThrashEvent("a", { event: "UserPromptSubmit", prompt: "pnpm test", ts: T0 });
      noteThrashEvent("a", { event: "Stop", ts: T0 });
    }
    noteThrashEvent("a", { event: "SessionStart", source: "startup", ts: T0 + 1 });
    noteThrashEvent("a", { event: "UserPromptSubmit", prompt: "pnpm test", ts: T0 + 2 });
    noteThrashEvent("a", { event: "Stop", ts: T0 + 2 });
    expect(thrashReportFor("a", T0 + 3, {})?.verdict).toBe("healthy");
  });

  it("forgetting an agent drops its accumulator", () => {
    noteThrashEvent("a", { event: "PreCompact", ts: T0 });
    expect(thrashReportFor("a", T0, {})).toBeDefined();
    forgetThrash("a");
    expect(thrashReportFor("a", T0, {})).toBeUndefined();
  });
});

// ── THE NUDGE LOOP (bead sparkle-hpbkw) ──────────────────────────────────────────────────────────
//
// The founder, 2026-08-09, on agent 6d644864 ("Typing Never Wedges"): status `waiting`, needsYou
// TRUE, goal `met` — and thrash `repeating-command`, earned by submitting SPARKLE'S OWN AUTOMATED
// PING four times in a row. The app nudged it, the nudge produced no progress, the app nudged
// again, and the wedge was then reported to him as though he were the blocker.
//
// Excluding the ping from the command tally (engine/agentOriginated) fixes the false verdict but
// must not make the loop INVISIBLE — that agent really was stuck. So the loop gets its own verdict,
// worded as OUR machinery failing rather than the agent's behaviour. His instruction, verbatim:
// *"an automated ping that loops should be detected and reported as a NUDGE FAILURE, never as
// 'needs you'."*
describe("the nudge loop — our own ping going nowhere is OUR failure, not the agent's", () => {
  it("never calls a run of nudges `repeating-command` — that is us talking, not the agent", () => {
    // The exact shape the founder measured: four pings, nothing in between.
    const events = [1, 2, 3, 4].flatMap((n) => turn(nudge(n)));
    const report = thrashReport(run(events), T0, {});
    expect(report.verdict).not.toBe("repeating-command");
    expect(report.repeatedCommand).toBeUndefined();
  });

  it("reports `nudge-loop` once our pings have gone nowhere NUDGE_LOOP_LIMIT times", () => {
    const events = Array.from({ length: NUDGE_LOOP_LIMIT }, (_, i) => turn(nudge(i + 1))).flat();
    const report = thrashReport(run(events), T0, {});
    expect(report.verdict).toBe("nudge-loop");
    expect(report.thrashing).toBe(true);
    expect(report.nudgesWithoutProgress).toBe(NUDGE_LOOP_LIMIT);
  });

  it("says NOTHING IS WAITING ON YOU, in those words — the whole point of the state", () => {
    const events = Array.from({ length: NUDGE_LOOP_LIMIT }, (_, i) => turn(nudge(i + 1))).flat();
    const { detail } = thrashReport(run(events), T0, {});
    // Names US as the actor that failed...
    expect(detail).toContain("Sparkle");
    // ...and says outright that he is not the blocker, so the sentence cannot be read as an ask.
    expect(detail.toLowerCase()).toContain("nothing is waiting on you");
    // ...and never blames the agent for looping, which is the verdict this replaces.
    expect(detail.toLowerCase()).not.toContain("it is looping");
  });

  it("does NOT fire below the limit — one or two unanswered pings is not yet a loop", () => {
    for (let n = 1; n < NUDGE_LOOP_LIMIT; n++) {
      const events = Array.from({ length: n }, (_, i) => turn(nudge(i + 1))).flat();
      expect(thrashReport(run(events), T0, {}).verdict).toBe("healthy");
    }
  });

  it("REAL WORK between pings clears it — a slow agent is not a wedged one", () => {
    // The false-positive guard, and the one that matters most: an agent that is genuinely working
    // between our pings must never reach this verdict, however many pings it takes.
    const events = [1, 2, 3, 4, 5].flatMap((n) => turn(nudge(n), ["Edit"]));
    const report = thrashReport(run(events), T0, {});
    expect(report.verdict).toBe("healthy");
    expect(report.nudgesWithoutProgress).toBe(0);
  });

  it("a HUMAN typing resets it — he intervened, so the loop is over", () => {
    const events = [
      ...Array.from({ length: NUDGE_LOOP_LIMIT }, (_, i) => turn(nudge(i + 1))).flat(),
      ...turn("try the other approach"),
    ];
    const report = thrashReport(run(events), T0, {});
    expect(report.nudgesWithoutProgress).toBe(0);
    expect(report.verdict).not.toBe("nudge-loop");
  });

  it("outranks `no-progress` — those tool-less turns are OUR pings, not the agent talking", () => {
    // Without the priority the founder gets the identical misattribution one badge over: "it is
    // producing output without doing anything" about an agent whose only turns were ones we opened.
    const events = Array.from({ length: NUDGE_LOOP_LIMIT }, (_, i) => turn(nudge(i + 1))).flat();
    const report = thrashReport(run(events), T0, {
      goalOutstanding: true,
    });
    expect(report.turnsWithoutTool).toBeGreaterThanOrEqual(NO_TOOL_TURN_LIMIT);
    expect(report.verdict).toBe("nudge-loop");
  });

  it("still yields to a quota wall and to context pressure — those are the real causes", () => {
    const events = Array.from({ length: NUDGE_LOOP_LIMIT }, (_, i) => turn(nudge(i + 1))).flat();
    const quota = thrashReport(run(events), T0, {
      quotaBlock: {
        message: "You've hit your usage limit",
        at: T0,
        resetAt: T0 + 3_600_000,
        resetParsed: true,
      },
    });
    expect(quota.verdict).toBe("quota-blocked");

    const compacted = run([
      ...events,
      ...Array.from({ length: COMPACT_PRESSURE_LIMIT }, () => ({
        event: "PreCompact" as const,
        ts: T0,
      })),
    ]);
    expect(thrashReport(compacted, T0, {}).verdict).toBe("context-pressure");
  });
});
