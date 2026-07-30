import { beforeEach, describe, expect, it } from "vitest";
import type { HookEvent } from "./hookEvents";
import {
  COMPACT_PRESSURE_LIMIT,
  COMPACT_WINDOW_MS,
  NO_TOOL_TURN_LIMIT,
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

const T0 = 1_700_000_000_000;

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

describe("a repeat only counts when the turn between did nothing", () => {
  it("this feature's OWN auto-continue prompt does not read as a loop", () => {
    // goalContinuation.continuePrompt is a pure function of goal.text, so every auto-continue for
    // one goal submits a byte-identical string and MAX_CONTINUES_TOTAL permits twenty of them. An
    // agent restarted three times that edited, tested and committed in each turn used to be
    // reported "It is looping, not working" — the precise inverse judgement, on the healthy path
    // of the sibling feature (roborev 55259).
    const prompt = "Your turn ended but your goal is not met yet, so you are being resumed...";
    const events = [0, 1, 2, 3].flatMap(() => turn(prompt, ["Edit", "Bash"]));
    const r = thrashReport(run(events), T0, { goalOutstanding: true });
    expect(r.verdict).toBe("healthy");
    expect(r.repeatedCommand).toBeUndefined();
  });

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

  it("flags N consecutive tool-less turns WHEN a goal is outstanding", () => {
    const events = Array.from({ length: NO_TOOL_TURN_LIMIT }, (_, i) => turn(`q${i}`, [])).flat();
    const r = thrashReport(run(events), T0, { goalOutstanding: true });
    expect(r.verdict).toBe("no-progress");
    expect(r.detail).toContain("Output is not progress");
  });

  it("does NOT flag ordinary conversation — three questions answered in prose", () => {
    // The rule's premise was always "while a goal is outstanding", but it used to consult no goal
    // and fired on any three prose turns. The founder asking an agent three questions got back
    // "it is producing output without doing anything" (roborev 55259). A detector whose false
    // positives land on conversation gets ignored.
    const events = Array.from({ length: NO_TOOL_TURN_LIMIT + 2 }, (_, i) => turn(`q${i}`, [])).flat();
    const r = thrashReport(run(events), T0, { goalOutstanding: false });
    expect(r.verdict).toBe("healthy");
    expect(r.thrashing).toBe(false);
    // The streak is still REPORTED — the evidence is not withheld, only the alarm.
    expect(r.turnsWithoutTool).toBe(NO_TOOL_TURN_LIMIT + 2);
  });

  it("an unknown goal state reports the streak without raising the alarm", () => {
    const events = Array.from({ length: NO_TOOL_TURN_LIMIT }, (_, i) => turn(`q${i}`, [])).flat();
    expect(thrashReport(run(events), T0, {}).thrashing).toBe(false);
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
    const events: HookEvent[] = [];
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
