// The advisor pass's CORE, driven with no AI call, no Tauri and no clock — dependency-injected
// exactly like `services/epicDecompose`.
//
// Every assertion here is on a SIDE EFFECT: which label was written, which comment, whether a
// dispatch happened, whether the latch flipped. Asserting that the deps were configured a certain
// way would pass against the code as it was before this feature existed, which is the vacuous shape
// AGENTS.md names as the #1 fleet-wide finding.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiBusyError, AiTransientError, ClaudeAuthError, ClaudeMissingError, ClaudeUsageLimitError } from "../anthropic";
import { DEFAULT_MODEL_ID, type ClaudeModelOption } from "../models";
import { heldVerdict, resetHeldVerdicts, type AdvisorVerdict } from "./findings";
import {
  ADVISOR_REVIEWED_LABEL,
  ADVISOR_SKIPPED_LABEL,
  ensureAdvisorVerdict,
  parseAdvisorFindings,
  runAdvisorPass,
  resetAdvisorPassState,
  settleAdvisorPass,
  type AdvisorLatch,
  type AdvisorPassArgs,
  type AdvisorPassDeps,
} from "./pass";
import type { UsagePayloadForGate } from "./spendGate";

const PLANNER = "claude-sonnet-4-6";
const opt = (id: string): ClaudeModelOption => ({ id, label: id, short: id });
const CATALOG = [opt(DEFAULT_MODEL_ID), opt("claude-opus-5"), opt(PLANNER)];

const DISARMED: UsagePayloadForGate = { extraUsage: { isEnabled: false, usedCredits: 5 } };

interface Harness {
  deps: AdvisorPassDeps;
  labels: Array<{ action: "add" | "remove"; label: string }>;
  comments: string[];
  dispatches: Array<{ model: string; question: string }>;
  latchState: { latched: boolean; reason: string | null; before: number | null; measured: boolean };
}

function harness(over: Partial<AdvisorPassDeps> = {}, usage: UsagePayloadForGate | null = DISARMED): Harness {
  const labels: Harness["labels"] = [];
  const comments: string[] = [];
  const dispatches: Harness["dispatches"] = [];
  const latchState = { latched: false, reason: null as string | null, before: null as number | null, measured: false };
  const latch: AdvisorLatch = {
    isLatched: () => latchState.latched,
    latch: (reason) => {
      latchState.latched = true;
      latchState.reason = reason;
    },
    creditsBefore: () => latchState.before,
    recordCreditsBefore: (v) => {
      if (latchState.before === null && v !== null) latchState.before = v;
    },
    measured: () => latchState.measured,
    markMeasured: () => {
      latchState.measured = true;
    },
  };
  const deps: AdvisorPassDeps = {
    readUsage: async () => usage,
    plannerModel: async () => PLANNER,
    catalog: () => CATALOG,
    config: () => ({ enabled: true, model: "claude-opus-5" }),
    dispatchResearch: async (i) => {
      dispatches.push({ model: i.model, question: i.question });
      return { id: `task-${dispatches.length}` };
    },
    labelBead: async (_p, action, _id, label) => {
      labels.push({ action, label });
    },
    commentBead: async (_p, _id, text) => {
      comments.push(text);
    },
    latch,
    ...over,
  };
  return { deps, labels, comments, dispatches, latchState };
}

const ARGS: AdvisorPassArgs = {
  projectPath: "/repo",
  projectRoot: "/repo",
  projectId: "proj",
  epicId: "sparkle-epic1",
  epicTitle: "An epic",
  planText: "do the thing",
};

beforeEach(() => {
  resetHeldVerdicts();
  // The audit and in-flight caches are module-level, so without this a previous test's write leaks
  // in and a genuine duplicate reads as correctly deduped — the dedupe tests below would pass
  // against code that does not dedupe at all.
  resetAdvisorPassState();
});

describe("the spend gate decides whether a pass is dispatched AT ALL", () => {
  it("dispatches on the model resolution when credits are disarmed", async () => {
    const h = harness();
    const out = await runAdvisorPass(h.deps, ARGS);
    expect(out).toEqual({ state: "dispatched", taskId: "task-1", model: "claude-opus-5" });
    // THE SIDE EFFECT: a child was actually asked for, on a model that is not the planner's.
    expect(h.dispatches).toHaveLength(1);
    expect(h.dispatches[0]!.model).toBe("claude-opus-5");
    expect(h.dispatches[0]!.model).not.toBe(PLANNER);
  });

  it("dispatches NOTHING when credits are ARMED", async () => {
    const h = harness({}, { extraUsage: { isEnabled: true } });
    const out = await runAdvisorPass(h.deps, ARGS);
    expect(out.state).toBe("skipped");
    expect(out.state === "skipped" && out.reason).toContain("ARMED");
    // The assertion that has teeth — no call was made, not merely that a verdict says so.
    expect(h.dispatches).toEqual([]);
  });

  it("dispatches NOTHING when the usage payload is UNREADABLE", async () => {
    for (const unreadable of [null, { extraUsage: {} }, { extraUsage: null }] as const) {
      const h = harness({}, unreadable);
      const out = await runAdvisorPass(h.deps, ARGS);
      expect(out.state).toBe("skipped");
      expect(h.dispatches).toEqual([]);
    }
  });

  it("dispatches NOTHING when the usage READ ITSELF throws — fail closed, not fail open", async () => {
    const h = harness({ readUsage: async () => { throw new Error("network down"); } });
    const out = await runAdvisorPass(h.deps, ARGS);
    expect(out.state).toBe("skipped");
    expect(h.dispatches).toEqual([]);
  });

  it("dispatches NOTHING when the spend limit is reached, even with credits disarmed", async () => {
    const h = harness({}, { extraUsage: { isEnabled: false, spendLimitReached: true } });
    const out = await runAdvisorPass(h.deps, ARGS);
    expect(out.state).toBe("skipped");
    expect(h.dispatches).toEqual([]);
  });

  it("dispatches NOTHING once the advisor has LATCHED ITSELF OFF", async () => {
    const h = harness();
    h.latchState.latched = true;
    const out = await runAdvisorPass(h.deps, ARGS);
    expect(out.state).toBe("skipped");
    expect(out.state === "skipped" && out.reason).toContain("LATCHED OFF");
    expect(h.dispatches).toEqual([]);
  });

  it("dispatches NOTHING when [advisor].enabled is false", async () => {
    const h = harness({ config: () => ({ enabled: false, model: null }) });
    expect((await runAdvisorPass(h.deps, ARGS)).state).toBe("skipped");
    expect(h.dispatches).toEqual([]);
  });

  it("dispatches NOTHING when no model distinct from the planner resolves", async () => {
    const h = harness({ catalog: () => [opt(DEFAULT_MODEL_ID), opt(PLANNER)] });
    const out = await runAdvisorPass(h.deps, ARGS);
    expect(out.state).toBe("skipped");
    expect(out.state === "skipped" && out.reason).toContain("self-review");
    expect(h.dispatches).toEqual([]);
  });
});

describe("the failure contract — Err means NO VERDICT EXISTS", () => {
  // Every AI-layer error class the brief names. All of them must end the same way: the pass is
  // skipped, NOTHING is painted, and the caller is handed a plain outcome rather than a throw.
  const classes: Array<[string, () => Error]> = [
    ["ClaudeMissingError", () => new ClaudeMissingError()],
    ["ClaudeAuthError", () => new ClaudeAuthError()],
    ["ClaudeUsageLimitError", () => new ClaudeUsageLimitError()],
    ["AiBusyError", () => new AiBusyError()],
    ["AiTransientError", () => new AiTransientError("ai_timeout")],
    ["a plain Error", () => new Error("something else")],
  ];

  for (const [name, make] of classes) {
    it(`${name} => advisor:skipped, a comment, and the ORIGINAL PLAN RETURNED UNCHANGED`, async () => {
      const h = harness({
        dispatchResearch: async () => {
          throw make();
        },
      });
      // It must not throw — `prepareHandoff` is a synchronous click path.
      const record = await ensureAdvisorVerdict(h.deps, ARGS, () => null);
      expect(record.terminal).toBe("skipped");
      expect(h.labels).toContainEqual({ action: "add", label: ADVISOR_SKIPPED_LABEL });
      expect(h.labels).not.toContainEqual({ action: "add", label: ADVISOR_REVIEWED_LABEL });
      expect(h.comments).toHaveLength(1);
      expect(h.comments[0]).toContain("advisor: skipped");
      // THE CLAUSE THAT MATTERS: no verdict is held, so `appendFindingsToBrief` returns the plan
      // untouched. A reassuring sentence about a review that did not happen is the failure this
      // whole contract exists to prevent.
      expect(heldVerdict(ARGS.epicId)).toBeNull();
      expect(h.comments[0]).toContain("NO VERDICT EXISTS");
      // The note must DENY approval, never assert it. A skipped pass that read as "approved" is the
      // exact incident `judge.rs` records; the negation has to be present and the affirmation absent.
      expect(h.comments[0]).toContain("this is not an approval");
      expect(h.comments[0]).not.toMatch(/\b(approved|passed|looks good|no issues)\b/i);
    });
  }
});

describe("the TERMINAL-STATE INVARIANT", () => {
  it("records BOTH terminal labels — a reviewed epic and a skipped epic, in one test", async () => {
    // ASSERTING ONLY THE HAPPY PATH PROVES NOTHING ABOUT THE BRANCH. Both epics run through the same
    // function in the same test, so a change that collapsed the two branches into one label — in
    // either direction — fails here rather than passing half the suite.
    const verdict: AdvisorVerdict = {
      model: "claude-opus-5",
      taskId: "task-9",
      findings: [{ lens: "scope", severity: "medium", summary: "task 3 is really two" }],
    };

    // (a) a REVIEWED epic: a verdict is already held.
    const reviewed = harness();
    const rec1 = await ensureAdvisorVerdict(reviewed.deps, ARGS, () => verdict);
    expect(rec1.terminal).toBe("reviewed");
    expect(reviewed.labels).toContainEqual({ action: "add", label: ADVISOR_REVIEWED_LABEL });
    expect(reviewed.comments[0]).toContain("advisor: reviewed");
    expect(reviewed.comments[0]).toContain("claude-opus-5");
    expect(reviewed.comments[0]).toContain("task 3 is really two");
    // No pass is dispatched for an epic already reviewed — re-deriving an answer on the bead would
    // spend quota for nothing.
    expect(reviewed.dispatches).toEqual([]);

    // (b) a SKIPPED epic: nothing held, and the gate refuses.
    const skipped = harness({}, { extraUsage: { isEnabled: true } });
    const rec2 = await ensureAdvisorVerdict(skipped.deps, { ...ARGS, epicId: "sparkle-epic2" }, () => null);
    expect(rec2.terminal).toBe("skipped");
    expect(skipped.labels).toContainEqual({ action: "add", label: ADVISOR_SKIPPED_LABEL });
    expect(skipped.comments[0]).toContain("advisor: skipped");

    // …and the two are genuinely different outcomes, not one label written twice.
    expect(rec1.terminal).not.toBe(rec2.terminal);
    expect(reviewed.labels.some((l) => l.label === ADVISOR_SKIPPED_LABEL && l.action === "add")).toBe(false);
    expect(skipped.labels.some((l) => l.label === ADVISOR_REVIEWED_LABEL && l.action === "add")).toBe(false);
  });

  it("records SKIPPED when a pass was dispatched but had not answered, and hands the dispatch back", async () => {
    const h = harness();
    const rec = await ensureAdvisorVerdict(h.deps, ARGS, () => null);
    expect(rec.terminal).toBe("skipped");
    expect(rec.reason).toContain("had not answered");
    // The task id and model travel on the record, so the caller can register the watch without
    // parsing a sentence written for a human.
    expect(rec.dispatched).toEqual({ taskId: "task-1", model: "claude-opus-5" });
    expect(h.labels).toContainEqual({ action: "add", label: ADVISOR_SKIPPED_LABEL });
  });

  it("dispatches AT MOST ONCE per handoff", async () => {
    const h = harness();
    await ensureAdvisorVerdict(h.deps, ARGS, () => null);
    expect(h.dispatches).toHaveLength(1);
  });

  it("SWAPS rather than adds when a verdict finally arrives — never both labels at once", async () => {
    const h = harness();
    await settleAdvisorPass(h.deps, {
      projectPath: "/repo",
      epicId: ARGS.epicId,
      taskId: "task-1",
      model: "claude-opus-5",
      findingsText: '```json\n{"findings":[{"lens":"goal","severity":"low","summary":"fine"}]}\n```',
    });
    // The removal is what makes "exactly one terminal label" true rather than "at least one" — an
    // epic carrying both would be a record that contradicts itself.
    expect(h.labels).toContainEqual({ action: "remove", label: ADVISOR_SKIPPED_LABEL });
    expect(h.labels).toContainEqual({ action: "add", label: ADVISOR_REVIEWED_LABEL });
    expect(heldVerdict(ARGS.epicId)?.findings).toHaveLength(1);
  });

  it("records SKIPPED when the child answered but its findings could not be read", async () => {
    const h = harness();
    await settleAdvisorPass(h.deps, {
      projectPath: "/repo",
      epicId: ARGS.epicId,
      taskId: "task-1",
      model: "claude-opus-5",
      findingsText: "I looked at everything and it seems fine to me.",
    });
    expect(h.labels).toContainEqual({ action: "add", label: ADVISOR_SKIPPED_LABEL });
    expect(h.labels).not.toContainEqual({ action: "add", label: ADVISOR_REVIEWED_LABEL });
    // AND NOTHING IS HELD: an unreadable answer is not "the advisor raised nothing". Holding an
    // empty verdict here would put a reassuring "a second model reviewed this" header in front of
    // the orchestrator on the strength of prose nobody parsed.
    expect(heldVerdict(ARGS.epicId)).toBeNull();
  });

  it("records SKIPPED when the pass failed or was cancelled before answering", async () => {
    const h = harness();
    await settleAdvisorPass(h.deps, {
      projectPath: "/repo",
      epicId: ARGS.epicId,
      taskId: "task-1",
      model: "claude-opus-5",
      findingsText: null,
    });
    expect(h.labels).toContainEqual({ action: "add", label: ADVISOR_SKIPPED_LABEL });
    expect(heldVerdict(ARGS.epicId)).toBeNull();
  });

  it("a persistently failing bead store does NOT fail the handoff", async () => {
    // Best-effort by contract: by the time this runs the orchestrator is already bound, and a
    // locked store must not turn a real handoff into a reported failure.
    const h = harness({
      labelBead: async () => {
        throw new Error("locked by another dolt process");
      },
      commentBead: async () => {
        throw new Error("locked by another dolt process");
      },
    });
    await expect(ensureAdvisorVerdict(h.deps, ARGS, () => null)).resolves.toMatchObject({
      terminal: "skipped",
    });
  });

  it("retries a TRANSIENT store lock, and does NOT retry anything else", async () => {
    let calls = 0;
    const h = harness({
      commentBead: async () => {
        calls += 1;
        throw new Error("locked by another dolt process");
      },
    });
    await ensureAdvisorVerdict(h.deps, ARGS, () => null);
    expect(calls).toBe(3); // ADVISOR_AUDIT_ATTEMPTS

    let other = 0;
    const h2 = harness({
      commentBead: async () => {
        other += 1;
        // A TIMEOUT is deliberately absent from the lock list: `bd comment` has no idempotency key,
        // so a timed-out write is genuinely ambiguous and retrying it would duplicate the note.
        throw new Error("timed out waiting for bd");
      },
    });
    await ensureAdvisorVerdict(h2.deps, ARGS, () => null);
    expect(other).toBe(1);
  });
});

describe("the empirical used_credits latch", () => {
  it("LATCHES the advisor off when the meter moved across the first approved call", async () => {
    let read = 0;
    const h = harness({
      readUsage: async () => {
        read += 1;
        // BEFORE the call: 5. AFTER: 7. The meter moved on a call the gate approved.
        return { extraUsage: { isEnabled: false, usedCredits: read === 1 ? 5 : 7 } };
      },
    });
    await runAdvisorPass(h.deps, ARGS); // takes the "before" reading
    expect(h.latchState.before).toBe(5);

    await settleAdvisorPass(h.deps, {
      projectPath: "/repo",
      epicId: ARGS.epicId,
      taskId: "task-1",
      model: "claude-opus-5",
      findingsText: '```json\n{"findings":[]}\n```',
    });

    expect(h.latchState.latched).toBe(true);
    expect(h.latchState.reason).toContain("2"); // the delta
    // …and it RAISES it durably, naming the delta.
    expect(h.comments.some((c) => c.includes("LATCHED OFF"))).toBe(true);
    expect(h.comments.some((c) => c.includes("RAISE THIS"))).toBe(true);

    // The latch is what stops the NEXT pass — the side effect, not the flag.
    const next = await runAdvisorPass(h.deps, ARGS);
    expect(next.state).toBe("skipped");
    expect(h.dispatches).toHaveLength(1);
  });

  it("does NOT latch when the meter held still", async () => {
    const h = harness();
    await runAdvisorPass(h.deps, ARGS);
    await settleAdvisorPass(h.deps, {
      projectPath: "/repo",
      epicId: ARGS.epicId,
      taskId: "task-1",
      model: "claude-opus-5",
      findingsText: '```json\n{"findings":[]}\n```',
    });
    expect(h.latchState.latched).toBe(false);
    expect(h.latchState.measured).toBe(true);
  });

  it("does NOT latch on an UNREADABLE reading — 'cannot say' is not 'it moved'", async () => {
    // Latching here would disable the advisor permanently on the first account whose payload omits
    // the field, which is a different failure from the one the latch guards.
    const h = harness({}, { extraUsage: { isEnabled: false, usedCredits: null } });
    await runAdvisorPass(h.deps, ARGS);
    await settleAdvisorPass(h.deps, {
      projectPath: "/repo",
      epicId: ARGS.epicId,
      taskId: "task-1",
      model: "claude-opus-5",
      findingsText: '```json\n{"findings":[]}\n```',
    });
    expect(h.latchState.latched).toBe(false);
    expect(h.latchState.measured).toBe(false); // still unmeasured, so a later pass can try
  });

  it("does not RE-BASELINE the 'before' reading on a later pass", async () => {
    // Re-baselining every pass would make a slow drift permanently invisible: each pass would
    // compare against a number that already included the previous pass's spend.
    let n = 0;
    const h = harness({
      readUsage: async () => {
        n += 1;
        return { extraUsage: { isEnabled: false, usedCredits: n } };
      },
    });
    await runAdvisorPass(h.deps, ARGS);
    await runAdvisorPass(h.deps, ARGS);
    expect(h.latchState.before).toBe(1);
  });
});

describe("parseAdvisorFindings", () => {
  it("reads the fenced json block, tagged or not", () => {
    const body = '{"findings":[{"lens":"collision","severity":"high","summary":"s","evidence":"e"}]}';
    for (const text of ["```json\n" + body + "\n```", "```\n" + body + "\n```"]) {
      expect(parseAdvisorFindings(text)).toEqual([
        { lens: "collision", severity: "high", summary: "s", evidence: "e" },
      ]);
    }
  });

  it("takes the LAST block, since the prose may quote the format it was asked for", () => {
    const text = [
      "Here is the shape I was asked for:",
      '```json\n{"findings":[{"lens":"scope","severity":"high","summary":"EXAMPLE"}]}\n```',
      "And here is my actual answer:",
      '```json\n{"findings":[{"lens":"goal","severity":"low","summary":"REAL"}]}\n```',
    ].join("\n");
    expect(parseAdvisorFindings(text)?.[0]?.summary).toBe("REAL");
  });

  it("returns NULL — not [] — for anything it cannot read", () => {
    // The distinction is the failure contract: `[]` means "the advisor ran and raised nothing",
    // `null` means "we could not tell what it said". Only the first is an observation.
    for (const text of [null, "", "just prose", "```json\nnot json\n```", '```json\n{"findings":3}\n```']) {
      expect(parseAdvisorFindings(text)).toBeNull();
    }
    expect(parseAdvisorFindings('```json\n{"findings":[]}\n```')).toEqual([]);
  });

  it("DROPS a finding whose lens or severity is off-contract rather than coercing it", () => {
    // An invented `high` would fire the one revision round at the decompose seam on nothing.
    const text =
      '```json\n{"findings":[' +
      '{"lens":"style","severity":"high","summary":"a"},' +
      '{"lens":"scope","severity":"critical","summary":"b"},' +
      '{"lens":"scope","severity":"high","summary":""},' +
      '{"lens":"scope","severity":"high","summary":"kept"}' +
      "]}\n```";
    expect(parseAdvisorFindings(text)).toEqual([
      { lens: "scope", severity: "high", summary: "kept" },
    ]);
  });
});

describe("the advisor's brief to the child", () => {
  it("names all three lenses, feeds the collision lens real facts, and defers on the goal rules", async () => {
    const h = harness();
    await runAdvisorPass(h.deps, {
      ...ARGS,
      siblingEpics: ["sparkle-other"],
      agentClaims: ["worker-1: sparkle-bead9"],
    });
    const q = h.dispatches[0]!.question;
    expect(q).toContain("pr-file-overlap.sh");
    // The brief must describe the script it actually calls. pr-file-overlap.sh's in-flight verdict
    // is 13 — another live worktree changing one of the plan's files, including work it has not
    // committed — and a brief enumerating only 10/12/11 leaves the child reading the one verdict
    // that fires at DISPATCH time as unexplained noise (sparkle-7h6q47).
    expect(q).toMatch(/exit 13 =/);
    expect(q).toContain("10 > 13 > 12 > 11");
    expect(q).toContain("sparkle-other");
    expect(q).toContain("worker-1: sparkle-bead9");
    // DEFERS to the gate rather than restating its rules — a second, drifting copy of the goal
    // contract in a prompt is the thing being avoided.
    expect(q).toContain("goalGate.ts");
    expect(q).toContain("DEFER");
    // Duplicate-bead detection is explicitly OUT OF SCOPE (PR #2150 owns it at filing time).
    expect(q).toMatch(/NOT whether any bead duplicates/);
    // And it must not be told to rewrite anything.
    expect(q).toContain("must NOT rewrite the plan");
  });
});

describe("advisorHandoffHook never lets a failure escape", () => {
  it("resolves even when every dep throws", async () => {
    const spy = vi.fn();
    const h = harness({
      readUsage: async () => { throw new Error("x"); },
      plannerModel: async () => { throw new Error("y"); },
      labelBead: async () => { throw new Error("z"); },
      commentBead: async () => { throw new Error("w"); },
      logError: spy,
    });
    await expect(ensureAdvisorVerdict(h.deps, ARGS, () => null)).resolves.toBeTruthy();
  });
});

// ── ONE DISPATCH PER EPIC IN FLIGHT, NOT ONE PER HANDOFF ────────────────────────────────────────
//
// The property that bounds concurrent second-opinion children. `prepareHandoff` is reached from the
// board's Start and Build It buttons, `promote_plan_to_build`, and the sweep's `sendToBuildAwaited`
// — and the research child takes minutes — so "nothing is held yet" is true for every handoff inside
// that window. Each assertion is on the DISPATCH COUNT, which is the thing that costs something.
describe("in-flight dedupe", () => {
  it("a SECOND handoff during the window dispatches no second child", async () => {
    const h = harness();
    const first = await ensureAdvisorVerdict(h.deps, ARGS, heldVerdict);
    expect(first.dispatched).toBeDefined();
    expect(h.dispatches).toHaveLength(1);

    await ensureAdvisorVerdict(h.deps, ARGS, heldVerdict);
    await ensureAdvisorVerdict(h.deps, ARGS, heldVerdict);
    // THE SIDE EFFECT. Not "the record says in-flight" — no further child was asked for.
    expect(h.dispatches).toHaveLength(1);
  });

  it("…and still records a terminal verdict, so the invariant survives the dedupe", async () => {
    // The dedupe must not create a reachable state where an epic hits execution with no verdict.
    const h = harness();
    await ensureAdvisorVerdict(h.deps, ARGS, heldVerdict);
    const second = await ensureAdvisorVerdict(h.deps, ARGS, heldVerdict);
    expect(second.terminal).toBe("skipped");
    expect(second.reason).toContain("already in flight");
    expect(h.labels.some((l) => l.action === "add" && l.label === ADVISOR_SKIPPED_LABEL)).toBe(true);
  });

  it("a DIFFERENT epic is not blocked by the first epic's in-flight pass", async () => {
    // THE PAIRED HALF, and it is what stops the test above passing for the wrong reason. A dedupe
    // keyed on nothing at all — or a flag that simply latches off after one dispatch — would satisfy
    // "no second child" while breaking every other epic on the board.
    const h = harness();
    await ensureAdvisorVerdict(h.deps, ARGS, heldVerdict);
    await ensureAdvisorVerdict(h.deps, { ...ARGS, epicId: "sparkle-epic2" }, heldVerdict);
    expect(h.dispatches).toHaveLength(2);
  });

  it("SETTLING releases the epic, so a later handoff can dispatch again", async () => {
    // The other direction: a dedupe that never releases would permanently prevent a re-review of an
    // epic whose plan has since changed, and nothing observable would say so.
    const h = harness();
    await ensureAdvisorVerdict(h.deps, ARGS, heldVerdict);
    await settleAdvisorPass(h.deps, {
      projectPath: "/repo",
      epicId: ARGS.epicId,
      taskId: "task-1",
      model: "claude-opus-5",
      findingsText: null, // failed pass: nothing is held, so the next handoff runs the gate again
    });
    await ensureAdvisorVerdict(h.deps, ARGS, heldVerdict);
    expect(h.dispatches).toHaveLength(2);
  });
});

// ── THE AUDIT NOTE IS A RECORD OF A STATE, SO IT IS WRITTEN ONCE PER STATE ──────────────────────
//
// `bd comment` APPENDS, against a single-writer store the desktop board re-reads every 5 seconds.
// Labels are idempotent and cost nothing to re-stamp; comments are not.
describe("audit note idempotence", () => {
  it("re-handing off an already-reviewed epic does not append a second identical note", async () => {
    const h = harness();
    const verdict: AdvisorVerdict = {
      model: "claude-opus-5",
      taskId: "t",
      findings: [{ lens: "scope", severity: "medium", summary: "too big" }],
    };
    const held = () => verdict;
    await ensureAdvisorVerdict(h.deps, ARGS, held);
    await ensureAdvisorVerdict(h.deps, ARGS, held);
    await ensureAdvisorVerdict(h.deps, ARGS, held);
    expect(h.comments).toHaveLength(1);
    // The LABEL is still re-stamped every time — that is the deliberate asymmetry, not an oversight.
    expect(h.labels.filter((l) => l.action === "add" && l.label === ADVISOR_REVIEWED_LABEL).length)
      .toBeGreaterThan(1);
  });

  it("a note whose CONTENT changed is still written", async () => {
    // The paired half. Deduping on the epic id alone would silence the transition that matters most
    // — skipped, then reviewed once the child answered — leaving the bead's record frozen at the
    // first thing that happened.
    const h = harness();
    await ensureAdvisorVerdict(h.deps, ARGS, () => null);
    expect(h.comments).toHaveLength(1);
    await settleAdvisorPass(h.deps, {
      projectPath: "/repo",
      epicId: ARGS.epicId,
      taskId: "task-1",
      model: "claude-opus-5",
      findingsText: '```json\n{"findings":[{"lens":"scope","severity":"high","summary":"far too big"}]}\n```',
    });
    expect(h.comments).toHaveLength(2);
    expect(h.comments[1]).toContain("far too big");
  });

  it("a FAILED write is not remembered as written, so the next handoff retries it", async () => {
    // The bookkeeping must record success, not intent. Remembering a failed write would leave the
    // bead with no audit note at all and nothing to notice it.
    let fail = true;
    const h = harness({
      commentBead: async (_p, _id, text) => {
        if (fail) throw new Error("boom");
        h.comments.push(text);
      },
    });
    await ensureAdvisorVerdict(h.deps, ARGS, () => null);
    expect(h.comments).toEqual([]);
    fail = false;
    resetAdvisorPassState();
    await ensureAdvisorVerdict(h.deps, { ...ARGS, epicId: "sparkle-epic9" }, () => null);
    expect(h.comments).toHaveLength(1);
  });
});
