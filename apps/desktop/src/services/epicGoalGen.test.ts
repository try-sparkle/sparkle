// @vitest-environment jsdom
//
// The async epic-goal generator (bead `sparkle-wab4lm`).
//
// Two things are pinned here, and the second matters more than the feature:
//
//   1. ON FAILURE, NO GOAL. Every failure shape — a throw, a timeout, an unparseable reply, text
//      that fails the shared bounds, a verify kind an epic cannot carry — asserts BOTH the outcome
//      AND that `setEpicGoal` was never called. Asserting only the outcome would pass for an
//      implementation that wrote a hallucinated goal and then reported `failed`.
//   2. THE PRODUCTION SEAM IS WIRED. `epicGoalGenDeps` is the object the real call site passes, and
//      the "production path" block below drives it against the REAL project store with only the
//      paid call replaced at the module boundary — so the line that supplies each real backend is
//      covered by a test rather than by every test injecting past it (AGENTS.md, "A defaulted seam
//      every test injects, so the production call site is untested by construction").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GOAL_MAX_LEN, GOAL_MIN_LEN } from "@sparkle/core";

// The two paid/IO seams, replaced at the MODULE boundary rather than at the deps object, so
// `epicGoalGenDeps` itself stays the production object in every test below.
const listBeadsMock = vi.fn();
vi.mock("./beads", async (orig) => ({
  ...(await orig<typeof import("./beads")>()),
  listBeads: (...a: unknown[]) => listBeadsMock(...a),
}));
const structuredJsonMock = vi.fn();
vi.mock("./anthropic", async (orig) => ({
  ...(await orig<typeof import("./anthropic")>()),
  structuredJson: (...a: unknown[]) => structuredJsonMock(...a),
}));
// createPlan's own two seams (the plans domain's create + dedupe reads), for the fire-and-forget
// block at the bottom. Everything else in `beadsCommands` is kept real.
const beadsCreate = vi.fn();
const beadsQuery = vi.fn();
vi.mock("./beadsCommands", async (orig) => ({
  ...(await orig<typeof import("./beadsCommands")>()),
  beadsCreate: (...a: unknown[]) => beadsCreate(...a),
  beadsQuery: (...a: unknown[]) => beadsQuery(...a),
}));
vi.mock("./sendToBuild", async (orig) => ({
  ...(await orig<typeof import("./sendToBuild")>()),
  sendToBuild: vi.fn(() => "agent-new"),
}));

const {
  EPIC_GOAL_GEN_TIMEOUT_MS,
  EPIC_GOAL_MAX_TOKENS,
  epicGoalGenDeps,
  epicGoalGenKey,
  epicGoalSystemPrompt,
  epicGoalUserPrompt,
  requestEpicGoal,
  __resetEpicGoalGenStateForTests,
} = await import("./epicGoalGen");
type EpicGoalGenDeps = import("./epicGoalGen").EpicGoalGenDeps;
const { listBeads } = await import("./beads");
const { structuredJson } = await import("./anthropic");
const { useProjectStore } = await import("../stores/projectStore");
const { useSettingsStore } = await import("../stores/settingsStore");
const { createPlan } = await import("./conciergeTools/plans");

type Bead = import("./beads").Bead;

const PROJECT = "p1";
const ROOT = "/repo";
const EPIC = "sparkle-e1";
/** Clears GOAL_MIN_LEN, sits under GOAL_MAX_LEN, and reads as an end state rather than a task. */
const GOOD_GOAL = "Every project row shows its repository name, and `pnpm verify` is green.";

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return {
    title: `title ${partial.id}`,
    description: "",
    status: "open",
    labels: [],
    parent: null,
    ...partial,
  };
}

const EPIC_BEAD = bead({ id: EPIC, type: "epic", title: "Show repo names", description: "why" });

/** Read a spy's recorded arguments without threading vitest's generic Mock type through every
 *  cast — the deps members are declared as plain functions, which is the point of the interface. */
function callArgs(fn: unknown, index = 0): unknown[] {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls[index] ?? [];
}

/** A deps object whose every member is a spy — for the gate/failure cases, where the point is what
 *  was and was not CALLED. The production object is driven separately, further down. */
function fakeDeps(over: Partial<EpicGoalGenDeps> = {}): EpicGoalGenDeps {
  return {
    mayGenerate: vi.fn(() => true),
    aiEnabled: vi.fn(() => true),
    readBeads: vi.fn(async () => [EPIC_BEAD]),
    structuredJson: vi.fn(async () => ({ goal: GOOD_GOAL, verify: { kind: "human" } })) as never,
    setEpicGoal: vi.fn(),
    noteFailure: vi.fn(),
    logError: vi.fn(),
    ...over,
  };
}

const ARGS = { projectId: PROJECT, projectPath: ROOT, epicId: EPIC };

beforeEach(() => {
  vi.clearAllMocks();
  __resetEpicGoalGenStateForTests();
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  listBeadsMock.mockResolvedValue([EPIC_BEAD]);
  structuredJsonMock.mockResolvedValue({ goal: GOOD_GOAL, verify: { kind: "human" } });
  beadsCreate.mockResolvedValue({ id: EPIC, title: "Show repo names" });
  beadsQuery.mockResolvedValue({ beads: [], total: 0, omitted: 0, omittedIds: [], limit: 50 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let already-resolved promises settle without advancing any clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

// ── The three gates, each of which must spend NOTHING ──────────────────────────────────────────

describe("requestEpicGoal — gates", () => {
  it("refuses `latched` and fires no paid call when the store says the machine may not generate", async () => {
    const deps = fakeDeps({ mayGenerate: vi.fn(() => false) });
    expect(await requestEpicGoal(deps, ARGS)).toBe("latched");
    expect(deps.structuredJson).not.toHaveBeenCalled();
    expect(deps.readBeads).not.toHaveBeenCalled();
    // A latch is not a failure: nothing is written at all, in either direction.
    expect(deps.setEpicGoal).not.toHaveBeenCalled();
    expect(deps.noteFailure).not.toHaveBeenCalled();
  });

  it("passes `force` through to the latch, which is the only thing that beats it", async () => {
    const mayGenerate = vi.fn(() => true);
    await requestEpicGoal(fakeDeps({ mayGenerate }), { ...ARGS, force: true });
    expect(mayGenerate).toHaveBeenCalledWith(PROJECT, EPIC, true);
  });

  it("defaults `force` to false when the caller omits it", async () => {
    const mayGenerate = vi.fn(() => true);
    await requestEpicGoal(fakeDeps({ mayGenerate }), ARGS);
    expect(mayGenerate).toHaveBeenCalledWith(PROJECT, EPIC, false);
  });

  it("refuses `ai-off` and fires no paid call when the master AI gate is off", async () => {
    const deps = fakeDeps({ aiEnabled: vi.fn(() => false) });
    expect(await requestEpicGoal(deps, ARGS)).toBe("ai-off");
    expect(deps.structuredJson).not.toHaveBeenCalled();
    expect(deps.setEpicGoal).not.toHaveBeenCalled();
    expect(deps.noteFailure).not.toHaveBeenCalled();
  });

  it("reads the latch BEFORE the AI gate, so a latched epic is refused as latched", async () => {
    // Order matters for the reply the UI shows: `ai-off` is a fixable setting, `latched` is a
    // decision. An epic that is both must report the decision.
    const deps = fakeDeps({ mayGenerate: vi.fn(() => false), aiEnabled: vi.fn(() => false) });
    expect(await requestEpicGoal(deps, ARGS)).toBe("latched");
  });

  it("refuses a SECOND concurrent request for the same epic with `in-flight`, spending once", async () => {
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const deps = fakeDeps({
      structuredJson: vi.fn(async () => {
        await gate;
        return { goal: GOOD_GOAL, verify: { kind: "human" } };
      }) as never,
    });
    const first = requestEpicGoal(deps, ARGS);
    // Let the first call get past readBeads and into the paid call before the second arrives.
    await vi.waitFor(() => expect(deps.structuredJson).toHaveBeenCalledTimes(1));
    expect(await requestEpicGoal(deps, ARGS)).toBe("in-flight");
    expect(deps.structuredJson).toHaveBeenCalledTimes(1);
    release(undefined);
    expect(await first).toBe("generated");
    expect(deps.setEpicGoal).toHaveBeenCalledTimes(1);
  });

  it("does NOT dedupe a different epic in the same project", async () => {
    const other = bead({ id: "sparkle-e2", type: "epic" });
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => {
      release = r;
    });
    const deps = fakeDeps({
      readBeads: vi.fn(async () => [EPIC_BEAD, other]),
      structuredJson: vi.fn(async () => {
        await gate;
        return { goal: GOOD_GOAL, verify: { kind: "human" } };
      }) as never,
    });
    const first = requestEpicGoal(deps, ARGS);
    await vi.waitFor(() => expect(deps.structuredJson).toHaveBeenCalledTimes(1));
    const second = requestEpicGoal(deps, { ...ARGS, epicId: "sparkle-e2" });
    await vi.waitFor(() => expect(deps.structuredJson).toHaveBeenCalledTimes(2));
    release(undefined);
    expect(await first).toBe("generated");
    expect(await second).toBe("generated");
  });

  it("releases the in-flight key in a `finally`, so a later request runs", async () => {
    const deps = fakeDeps();
    expect(await requestEpicGoal(deps, ARGS)).toBe("generated");
    expect(await requestEpicGoal(deps, ARGS)).toBe("generated");
    expect(deps.structuredJson).toHaveBeenCalledTimes(2);
  });

  it("releases the in-flight key even when the paid call THROWS", async () => {
    const deps = fakeDeps({
      structuredJson: vi.fn(async () => {
        throw new Error("provider down");
      }) as never,
    });
    expect(await requestEpicGoal(deps, ARGS)).toBe("failed");
    expect(await requestEpicGoal(deps, ARGS)).toBe("failed");
    expect(deps.structuredJson).toHaveBeenCalledTimes(2);
  });

  it("keys the in-flight guard on project AND epic", () => {
    expect(epicGoalGenKey("a", "b")).toBe(epicGoalGenKey("a", "b"));
    expect(epicGoalGenKey("a", "b")).not.toBe(epicGoalGenKey("a", "c"));
    expect(epicGoalGenKey("a", "b")).not.toBe(epicGoalGenKey("b", "b"));
  });
});

// ── The success path ───────────────────────────────────────────────────────────────────────────

describe("requestEpicGoal — success", () => {
  it("writes the goal with source `auto` and the model's verify", async () => {
    const deps = fakeDeps();
    expect(await requestEpicGoal(deps, ARGS)).toBe("generated");
    expect(deps.setEpicGoal).toHaveBeenCalledWith(PROJECT, EPIC, GOOD_GOAL, "auto", {
      kind: "human",
    });
    expect(deps.noteFailure).not.toHaveBeenCalled();
  });

  it("carries a `command` verify through with its cmd", async () => {
    const deps = fakeDeps({
      structuredJson: vi.fn(async () => ({
        goal: GOOD_GOAL,
        verify: { kind: "command", cmd: "pnpm verify" },
      })) as never,
    });
    expect(await requestEpicGoal(deps, ARGS)).toBe("generated");
    expect(deps.setEpicGoal).toHaveBeenCalledWith(PROJECT, EPIC, GOOD_GOAL, "auto", {
      kind: "command",
      cmd: "pnpm verify",
    });
  });

  it("writes a goal with NO verify when the model omitted one", async () => {
    const deps = fakeDeps({
      structuredJson: vi.fn(async () => ({ goal: GOOD_GOAL })) as never,
    });
    expect(await requestEpicGoal(deps, ARGS)).toBe("generated");
    expect(deps.setEpicGoal).toHaveBeenCalledWith(PROJECT, EPIC, GOOD_GOAL, "auto", undefined);
  });

  it("meters the call as background epic-goal work for this project", async () => {
    const deps = fakeDeps();
    await requestEpicGoal(deps, ARGS);
    const [, , maxTokens, metering] = callArgs(deps.structuredJson);
    expect(maxTokens).toBe(EPIC_GOAL_MAX_TOKENS);
    expect(metering).toEqual({ purpose: "epic-goal", project: ROOT, background: true });
  });
});

// ── Every failure shape writes NO goal text ────────────────────────────────────────────────────

describe("requestEpicGoal — failures never write goal text", () => {
  /** Run one failure shape and assert the invariant that matters: outcome `failed`, a recorded
   *  reason, and NOTHING written to the goal field. */
  async function expectFailure(over: Partial<EpicGoalGenDeps>, reasonFragment: string) {
    const deps = fakeDeps(over);
    expect(await requestEpicGoal(deps, ARGS)).toBe("failed");
    expect(deps.setEpicGoal).not.toHaveBeenCalled();
    expect(deps.noteFailure).toHaveBeenCalledTimes(1);
    const [projectId, epicId, rawReason] = callArgs(deps.noteFailure);
    const reason = String(rawReason);
    expect(projectId).toBe(PROJECT);
    expect(epicId).toBe(EPIC);
    expect(reason.toLowerCase()).toContain(reasonFragment.toLowerCase());
    // One short sentence — the reason is painted on a card, not in a log.
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason.includes(String.fromCharCode(10))).toBe(false);
    return deps;
  }

  it("fails when the paid call throws", async () => {
    await expectFailure(
      { structuredJson: vi.fn(async () => Promise.reject(new Error("provider down"))) as never },
      "provider down",
    );
  });

  it("fails when the bead read throws", async () => {
    await expectFailure(
      { readBeads: vi.fn(async () => Promise.reject(new Error("bd is not installed"))) as never },
      "bd is not installed",
    );
  });

  it("fails when the epic is not in the work graph", async () => {
    await expectFailure({ readBeads: vi.fn(async () => []) }, "not in the work graph");
  });

  it("fails on a reply with no `goal` at all", async () => {
    await expectFailure({ structuredJson: vi.fn(async () => ({})) as never }, "empty");
  });

  it("fails on a non-string `goal`", async () => {
    await expectFailure({ structuredJson: vi.fn(async () => ({ goal: 42 })) as never }, "empty");
  });

  it("fails on goal text under the shared GOAL_MIN_LEN", async () => {
    const short = "ab ".repeat(3).trim().slice(0, GOAL_MIN_LEN - 1);
    await expectFailure(
      { structuredJson: vi.fn(async () => ({ goal: short })) as never },
      "too short",
    );
  });

  it("fails on goal text over the shared GOAL_MAX_LEN", async () => {
    const long = "long goal ".repeat(GOAL_MAX_LEN);
    await expectFailure({ structuredJson: vi.fn(async () => ({ goal: long })) as never }, "too long");
  });

  it("fails on a `landed` verify — an epic has no branch that could ever answer it", async () => {
    // Deliberately a FAILURE and not a narrowing to `human`: the model was told the two legal
    // kinds, so a third one means the reply is not the shape we asked for.
    await expectFailure(
      {
        structuredJson: vi.fn(async () => ({
          goal: GOOD_GOAL,
          verify: { kind: "landed" },
        })) as never,
      },
      "landed",
    );
  });

  it("fails on an unknown verify kind", async () => {
    await expectFailure(
      {
        structuredJson: vi.fn(async () => ({ goal: GOOD_GOAL, verify: { kind: "vibes" } })) as never,
      },
      "verify",
    );
  });

  it("fails on a `command` verify with no cmd", async () => {
    await expectFailure(
      {
        structuredJson: vi.fn(async () => ({
          goal: GOOD_GOAL,
          verify: { kind: "command" },
        })) as never,
      },
      "verify",
    );
  });

  it("fails on a verify that is not an object", async () => {
    await expectFailure(
      { structuredJson: vi.fn(async () => ({ goal: GOOD_GOAL, verify: "human" })) as never },
      "verify",
    );
  });

  it("TIMES OUT rather than waiting, and writes no goal", async () => {
    // A timeout is a FAILURE, not a wait — the founder's constraint. The paid call never settles.
    vi.useFakeTimers();
    const deps = fakeDeps({ structuredJson: vi.fn(() => new Promise(() => {})) as never });
    const pending = requestEpicGoal(deps, ARGS);
    // Let the bead read settle so the bound is actually armed.
    await flush();
    await vi.advanceTimersByTimeAsync(EPIC_GOAL_GEN_TIMEOUT_MS + 1);
    expect(await pending).toBe("failed");
    expect(deps.setEpicGoal).not.toHaveBeenCalled();
    expect(String(callArgs(deps.noteFailure)[2])).toContain("timed out");
  });

  it("does NOT time out a call that answers inside the bound", async () => {
    vi.useFakeTimers();
    let settle: (v: unknown) => void = () => {};
    const deps = fakeDeps({
      structuredJson: vi.fn(
        () =>
          new Promise((r) => {
            settle = r;
          }),
      ) as never,
    });
    const pending = requestEpicGoal(deps, ARGS);
    await flush();
    await vi.advanceTimersByTimeAsync(EPIC_GOAL_GEN_TIMEOUT_MS - 1000);
    settle({ goal: GOOD_GOAL, verify: { kind: "human" } });
    expect(await pending).toBe("generated");
    expect(deps.noteFailure).not.toHaveBeenCalled();
  });
});

// ── The prompt ─────────────────────────────────────────────────────────────────────────────────

describe("the prompt", () => {
  it("asks for ONE sentence naming the observable end state, not the title or the tasks", () => {
    const system = epicGoalSystemPrompt().toLowerCase();
    expect(system).toContain("one sentence");
    expect(system).toContain("observable end state");
    expect(system).toContain("do not restate the title");
    expect(system).toContain("do not list the tasks");
  });

  it("states the SHARED length bounds, so the model is told the gate it must pass", () => {
    const system = epicGoalSystemPrompt();
    expect(system).toContain(String(GOAL_MIN_LEN));
    expect(system).toContain(String(GOAL_MAX_LEN));
  });

  it("offers `command` only when a command proves it, else `human`", () => {
    const system = epicGoalSystemPrompt();
    expect(system).toContain('"kind":"command"');
    expect(system).toContain('"kind":"human"');
    // `landed` is not offered: nothing could ever supply the evidence for an epic.
    expect(system).not.toContain("landed");
  });

  it("shows the epic's title, body and child titles", () => {
    const user = epicGoalUserPrompt(
      bead({ id: EPIC, title: "Show repo names", description: "each row names its repo" }),
      [
        bead({ id: "c1", title: "resolve the repo key" }),
        bead({ id: "c2", title: "paint the badge" }),
      ],
    );
    expect(user).toContain("Show repo names");
    expect(user).toContain("each row names its repo");
    expect(user).toContain("resolve the repo key");
    expect(user).toContain("paint the badge");
  });

  it("hands the model the epic's OWN children, not every bead in the project", async () => {
    const kid = bead({ id: "c1", title: "resolve the repo key", parent: EPIC });
    const stranger = bead({ id: "z9", title: "unrelated chore" });
    const deps = fakeDeps({ readBeads: vi.fn(async () => [EPIC_BEAD, kid, stranger]) });
    await requestEpicGoal(deps, ARGS);
    const user = String(callArgs(deps.structuredJson)[1]);
    expect(user).toContain("resolve the repo key");
    expect(user).not.toContain("unrelated chore");
  });

  it("sends a coherent CHILDLESS prompt — the shape the create path actually produces", async () => {
    // roborev 65858. `createPlan` files a typed epic and its own docstring says children are added
    // later by the board domain, so on the ONLY create-time path `childrenOf` is always `[]` — and
    // the child-items half of the prompt never runs. That is fine (the child half serves the
    // `force` path from the concierge and the Generate button, where children DO exist), but it
    // has to be ASSERTED, because the test above injects a roster production cannot be in.
    const deps = fakeDeps({ readBeads: vi.fn(async () => [EPIC_BEAD]) });
    expect(await requestEpicGoal(deps, ARGS)).toBe("generated");
    const user = String(callArgs(deps.structuredJson)[1]);
    expect(user).toContain("Show repo names");
    // No empty section header left dangling where the children would have been.
    expect(user).not.toMatch(/CHILD ITEMS[\s:]*$/);
  });

  it("a bad verify reports PROSE, not the parser's machine slug", async () => {
    // roborev 65858. The reason string is stored as `generationFailureReason` and shown on a card,
    // so `unusable verify — verify-cmd-missing` reached the user verbatim. The assertion names a
    // fragment only the prose can contain, so the slug cannot satisfy it.
    const deps = fakeDeps({
      structuredJson: vi.fn(async () => ({ goal: GOOD_GOAL, verify: { kind: "command" } })) as never,
    });
    expect(await requestEpicGoal(deps, ARGS)).toBe("failed");
    const reason = String(callArgs(deps.noteFailure)[2]);
    expect(reason).not.toMatch(/verify-[a-z-]+/);
    expect(reason.toLowerCase()).toContain("cmd");
  });
});

// ── THE PRODUCTION SEAM ────────────────────────────────────────────────────────────────────────
// Everything above injects a fake deps object. That alone leaves the line that supplies each REAL
// backend covered by nothing. These drive `epicGoalGenDeps` itself.

/** Put a real project in the real store. */
function seedProject(): void {
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT,
        name: "repo",
        rootPath: ROOT,
        defaultBranch: "main",
        createdAt: new Date(0).toISOString(),
        agents: [],
        selectedAgentId: null,
      },
    ],
    selectedProjectId: PROJECT,
  } as never);
}

/** The master AI gate, as the real `aiFeatureMode` reads it. */
function setAiFeatures(on: boolean): void {
  useSettingsStore.setState({
    aiAutoRename: on,
    cloudDictation: on,
    aiComposer: on,
    aiSuggestedActions: on,
    aiAutoApprove: on,
    aiConcierge: on,
  } as never);
}

function storedGoal() {
  return useProjectStore.getState().projects.find((p) => p.id === PROJECT)?.epicGoals?.[EPIC];
}

describe("epicGoalGenDeps — the production object", () => {
  beforeEach(() => {
    seedProject();
    setAiFeatures(true);
  });

  it("wires the real backends, not stand-ins", () => {
    // The bead read and the paid call are module-level bindings, so identity is checkable directly.
    expect(epicGoalGenDeps.readBeads).toBe(listBeads);
    expect(epicGoalGenDeps.structuredJson).toBe(structuredJson);
  });

  it("writes through to the REAL project store on success", async () => {
    expect(await requestEpicGoal(epicGoalGenDeps, ARGS)).toBe("generated");
    expect(storedGoal()?.text).toBe(GOOD_GOAL);
    expect(storedGoal()?.source).toBe("auto");
    expect(storedGoal()?.verify).toEqual({ kind: "human" });
  });

  it("reads the REAL latch: a human-written goal is never regenerated over", async () => {
    useProjectStore
      .getState()
      .setEpicGoal(PROJECT, EPIC, "A person wrote this objective down.", "human");
    expect(await requestEpicGoal(epicGoalGenDeps, ARGS)).toBe("latched");
    expect(storedGoal()?.text).toBe("A person wrote this objective down.");
    expect(structuredJsonMock).not.toHaveBeenCalled();
  });

  it("reads the REAL master AI gate", async () => {
    setAiFeatures(false);
    expect(await requestEpicGoal(epicGoalGenDeps, ARGS)).toBe("ai-off");
    expect(structuredJsonMock).not.toHaveBeenCalled();
  });

  it("records a REAL failure with no goal text when the paid call fails", async () => {
    structuredJsonMock.mockRejectedValue(new Error("provider down"));
    expect(await requestEpicGoal(epicGoalGenDeps, ARGS)).toBe("failed");
    expect(storedGoal()?.text).toBe("");
    expect(storedGoal()?.generationFailedAt).toBeGreaterThan(0);
    expect(storedGoal()?.generationFailureReason).toContain("provider down");
  });

  it("refuses to auto-retry after a recorded failure, but honours an explicit force", async () => {
    structuredJsonMock.mockRejectedValueOnce(new Error("provider down"));
    expect(await requestEpicGoal(epicGoalGenDeps, ARGS)).toBe("failed");
    expect(await requestEpicGoal(epicGoalGenDeps, ARGS)).toBe("latched");
    expect(await requestEpicGoal(epicGoalGenDeps, { ...ARGS, force: true })).toBe("generated");
    expect(storedGoal()?.text).toBe(GOOD_GOAL);
  });
});

// ── The call site: createPlan must NOT await this ──────────────────────────────────────────────

describe("createPlan fires generation without awaiting it", () => {
  beforeEach(() => {
    seedProject();
    setAiFeatures(true);
  });

  it("returns the created epic while generation is still in flight, then fills the goal later", async () => {
    // The founder's latency constraint: a call of this latency must not sit synchronously on the
    // epic-creation path. The paid call is held OPEN across the create's return — if `createPlan`
    // awaited it, this test could not reach its first assertion at all.
    let settle: (v: unknown) => void = () => {};
    structuredJsonMock.mockImplementation(
      () =>
        new Promise((r) => {
          settle = r;
        }),
    );
    const result = await createPlan(ROOT, PROJECT, "Show repo names", "body");
    expect(result.ok).toBe(true);
    expect(result.ok && result.data.outcome).toBe("created");
    // Generation DID start — the create fired it, it did not merely skip it.
    await vi.waitFor(() => expect(structuredJsonMock).toHaveBeenCalledTimes(1));
    expect(storedGoal()).toBeUndefined();
    settle({ goal: GOOD_GOAL, verify: { kind: "human" } });
    await vi.waitFor(() => expect(storedGoal()?.text).toBe(GOOD_GOAL));
  });

  it("still reports the create as successful when generation fails outright", async () => {
    structuredJsonMock.mockRejectedValue(new Error("provider down"));
    const result = await createPlan(ROOT, PROJECT, "Show repo names", "body");
    expect(result.ok).toBe(true);
    await vi.waitFor(() => {
      expect(storedGoal()?.generationFailureReason).toContain("provider down");
      expect(storedGoal()?.text).toBe("");
    });
  });
});
