// @vitest-environment jsdom
//
// The plans domain. `../beads` and `../sendToBuild` are mocked (the bd shell-out and the handoff's
// store/PTY side effects); `../planView` is kept REAL, because reusing its derivations instead of
// re-implementing them is the whole design claim of this module and a stub would hide a drift.
import { describe, it, expect, vi, beforeEach } from "vitest";

const listBeads = vi.fn();
const beadShow = vi.fn();
const blockedBeadIds = vi.fn();
const createBeadFull = vi.fn();
const capacityMock = vi.fn(() => ({ atCapacity: false, used: 1, limit: 8, live: 1, basis: "test" }));

vi.mock("../beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../beads")>();
  return {
    ...actual,
    listBeads: (...a: unknown[]) => listBeads(...a),
    beadShow: (...a: unknown[]) => beadShow(...a),
    blockedBeadIds: (...a: unknown[]) => blockedBeadIds(...a),
  };
});

vi.mock("../tasks", () => ({ createBeadFull: (...a: unknown[]) => createBeadFull(...a) }));

// The create path's REAL seam now. `beadsCommands` is the typed wrapper over the Rust command that
// creates AND probes; only the two functions the plans domain calls are stubbed, and everything
// else — `toBeadsError`, `isWriteDropped`, `isNoWorkspace`, the `WRITE_DROPPED_MARKER` itself — is
// kept REAL, because those are the classifiers under test. Stubbing them would make every verdict
// assertion below a test of the stub.
const beadsCreate = vi.fn();
const beadsQuery = vi.fn();
vi.mock("../beadsCommands", async (orig) => ({
  ...(await orig<typeof import("../beadsCommands")>()),
  beadsCreate: (...a: unknown[]) => beadsCreate(...a),
  beadsQuery: (...a: unknown[]) => beadsQuery(...a),
}));
vi.mock("../agentCapacity", async (orig) => ({
  ...(await orig<typeof import("../agentCapacity")>()),
  localAgentCapacity: () => capacityMock(),
}));

const sendToBuildMock = vi.fn(() => "agent-new");
vi.mock("../sendToBuild", async (orig) => ({
  ...(await orig<typeof import("../sendToBuild")>()),
  sendToBuild: (...a: unknown[]) => sendToBuildMock(...(a as [])),
}));

const {
  PLANS_OPS,
  PLANS_RISK,
  listPlans,
  getPlan,
  createPlan,
  createFailureVerdict,
  promotePlanToBuild,
} = await import("./plans");
const { WRITE_DROPPED_MARKER, CREATE_PLAN_DEDUPE_BUDGET_MS, CREATE_PLAN_TOTAL_BUDGET_MS } =
  await import("../beadsCommands");
const { useProjectStore } = await import("../../stores/projectStore");
const { AtCapacityError } = await import("../sendToBuild");

const ROOT = "/repo";
/** `createPlan` takes the project id as a PARAMETER now (roborev 65858) rather than reverse-deriving
 *  it from the path, so these tests name one. Nothing in this file depends on it matching a seeded
 *  project — the goal generation it feeds is stubbed out at the module boundary. */
const PLANS_TEST_PROJECT_ID = "p-plans-test";

function bead(id: string, over: Partial<import("../beads").Bead> = {}): import("../beads").Bead {
  return {
    id,
    title: `title ${id}`,
    description: "",
    status: "open",
    labels: [],
    parent: null,
    commentCount: 0,
    ...over,
  };
}

const epic = (id: string, over = {}) => bead(id, { type: "epic", ...over });
const child = (id: string, parent: string, over = {}) => bead(id, { parent, ...over });

function seedProject(): string {
  return useProjectStore.getState().addProject("Demo", ROOT);
}

beforeEach(() => {
  vi.clearAllMocks();
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  listBeads.mockResolvedValue([]);
  beadShow.mockResolvedValue(null);
  blockedBeadIds.mockResolvedValue(new Set<string>());
  createBeadFull.mockResolvedValue("sparkle-plan");
  beadsCreate.mockResolvedValue({ id: "sparkle-plan", title: "Ship auth" });
  // NOTHING already filed, by default — the dedupe read runs on every create, so a suite-wide
  // default that returned a match would silently turn every other case into the duplicate path.
  beadsQuery.mockResolvedValue({ beads: [], total: 0, omitted: 0, omittedIds: [], limit: 50 });
  capacityMock.mockReturnValue({ atCapacity: false, used: 1, limit: 8, live: 1, basis: "test" });
  sendToBuildMock.mockReturnValue("agent-new");
});

describe("classification", () => {
  it("classifies every op", () => {
    for (const op of PLANS_OPS) expect(PLANS_RISK[op]).toBeTruthy();
  });

  // Promotion starts an agent, which costs a slot but destroys nothing — the same shape as
  // spawn_build_agent, and equally undoable by closing the agent.
  it("rates promotion routine and the reads read-only", () => {
    expect(PLANS_RISK.promote_plan_to_build).toBe("routine");
    expect(PLANS_RISK.list_plans).toBe("read-only");
    expect(PLANS_RISK.get_plan).toBe("read-only");
  });
});

describe("list_plans", () => {
  it("returns only EPICS, with status rolled up from their children", async () => {
    const projectId = seedProject();
    listBeads.mockResolvedValue([
      epic("e1"),
      child("c1", "e1", { status: "closed" }),
      child("c2", "e1", { status: "closed" }),
      epic("e2"),
      child("c3", "e2"),
      bead("loose"), // a task with no epic — not a plan
    ]);

    const r = await listPlans(ROOT, projectId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.map((p) => p.id)).toEqual(["e1", "e2"]);
    // Rolled up by the REAL planView.epicStatus: all children closed → done.
    expect(r.data.find((p) => p.id === "e1")?.status).toBe("done");
    // ...and e2's single child is still open, so it is PLANNING — a written plan nobody started,
    // which the concierge must be able to tell apart from an epic with no children at all.
    expect(r.data.find((p) => p.id === "e2")?.status).toBe("planning");
    expect(r.data.find((p) => p.id === "e1")?.childCount).toBe(2);
  });

  // The orchestrator link is what tells the human "somebody is already on this" — and it is the
  // state promote_plan_to_build changes, so a wrong answer here would produce a duplicate handoff.
  it("names the build agent bound to a plan, and null when nobody is on it", async () => {
    const projectId = seedProject();
    const store = useProjectStore.getState();
    const agentId = store.addAgent(projectId, { kind: "build", name: "Auth Work" })!;
    store.setAgentEpicId(projectId, agentId, "e1");
    listBeads.mockResolvedValue([epic("e1"), epic("e2")]);

    const r = await listPlans(ROOT, projectId);
    expect(r.ok && r.data.find((p) => p.id === "e1")?.orchestrator).toBe("Auth Work");
    expect(r.ok && r.data.find((p) => p.id === "e2")?.orchestrator).toBeNull();
  });

  // THE REGRESSION THIS CHANGE EXISTS FOR. Eight parents in the real store are typed
  // feature/bug/task and carry 2 to 19 children apiece; keying epic-ness on `type` made every one
  // of them invisible here while their children rendered as loose tasks. Asserting the SIDE EFFECT
  // — the plan is listed, with its children counted and its status rolled up — not merely that some
  // predicate returns true.
  it("lists a parent bead that is NOT typed 'epic' as a plan, with its children", async () => {
    const projectId = seedProject();
    listBeads.mockResolvedValue([
      bead("f1", { type: "feature" }), // a de-facto epic: never typed 'epic', but things point at it
      child("f1c1", "f1", { status: "closed" }),
      child("f1c2", "f1", { status: "in_progress" }),
      bead("b1", { type: "bug" }), // a bug that is also a parent
      child("b1c1", "b1"),
      bead("solo", { type: "task" }), // parentless and childless — NOT a plan, and that is normal
    ]);

    const r = await listPlans(ROOT, projectId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.map((p) => p.id).sort()).toEqual(["b1", "f1"]);
    const f1 = r.data.find((p) => p.id === "f1");
    expect(f1?.childCount).toBe(2);
    // Rolled up by the REAL planView.epicStatus — a mix of closed and in_progress is in_progress.
    expect(f1?.status).toBe("in_progress");
  });

  // The dotted id is bd's display form of the same edge, so it must confer plan-hood identically.
  it("lists a parent whose children carry only dotted ids", async () => {
    const projectId = seedProject();
    listBeads.mockResolvedValue([bead("d1", { type: "chore" }), bead("d1.1"), bead("d1.2")]);

    const r = await listPlans(ROOT, projectId);
    expect(r.ok && r.data.map((p) => p.id)).toEqual(["d1"]);
    expect(r.ok && r.data.find((p) => p.id === "d1")?.childCount).toBe(2);
  });

  // C, in the founder's words: "Every bead doesn't absolutely need to have an epic." A backlog of
  // parentless tasks must produce NO plans rather than a board full of one-bead epics.
  it("returns no plans at all when nothing has children and nothing is typed 'epic'", async () => {
    const projectId = seedProject();
    listBeads.mockResolvedValue([bead("t1"), bead("t2", { type: "bug" }), bead("t3", { type: "feature" })]);

    const r = await listPlans(ROOT, projectId);
    expect(r.ok && r.data).toEqual([]);
  });

  it("reports a project without beads as a supported state", async () => {
    const projectId = seedProject();
    listBeads.mockRejectedValue(new Error("no beads database found for /repo"));

    const r = await listPlans(ROOT, projectId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.reason, /bd init/.test(r.message)]).toEqual(["beads-unavailable", true]);
  });
});

describe("get_plan", () => {
  it("returns the plan with its children, workers and board columns", async () => {
    const projectId = seedProject();
    const store = useProjectStore.getState();
    const worker = store.addAgent(projectId, { kind: "worker", name: "W1", beadId: "c1" })!;
    expect(worker).toBeTruthy();

    beadShow.mockResolvedValue(epic("e1"));
    listBeads.mockResolvedValue([epic("e1"), child("c1", "e1"), child("c2", "e1")]);
    blockedBeadIds.mockResolvedValue(new Set(["c2"]));

    const r = await getPlan(ROOT, projectId, "e1");
    expect(r.ok).toBe(true);
    if (!r.ok || !r.data) return;
    expect(r.data.plan.id).toBe("e1");
    expect(r.data.children.map((c) => c.id)).toEqual(["c1", "c2"]);
    // Workers come from the REAL planView.epicChildViews.
    expect(r.data.children.find((c) => c.id === "c1")?.workers).toEqual(["W1"]);
    // …and the column agrees with the board domain, since both use columnFor.
    expect(r.data.children.find((c) => c.id === "c2")?.column).toBe("blocked");
    expect(r.data.children.find((c) => c.id === "c2")?.blocked).toBe(true);
  });

  it("returns null for an id the project does not hold", async () => {
    const projectId = seedProject();
    const r = await getPlan(ROOT, projectId, "nope");
    expect(r.ok && r.data).toBeNull();
  });

  // "I can't find it" and "that's a task, not a plan" are different mistakes, and a model deciding
  // whether to retry needs to tell them apart.
  it("refuses a bead that exists but is not a plan", async () => {
    const projectId = seedProject();
    beadShow.mockResolvedValue(bead("t1", { type: "task" }));

    const r = await getPlan(ROOT, projectId, "t1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.reason, /board tools/.test(r.message)]).toEqual(["not-a-plan", true]);
  });
});

describe("create_plan", () => {
  // ASSERTS THE THING THAT RESULTS, not the input to a mock.
  //
  // The first version of this test checked `createBead` was called with (root, title, body) and
  // passed against a call that filed a TASK — `bd create` with no `-t` takes bd's default type, so
  // nothing create_plan produced was ever a plan: invisible to list_plans, refused as `not-a-plan`
  // by get_plan and promote. The whole create → inspect → promote workflow dead-ended at step one
  // and the suite was green (roborev 55131). So: pin the type, then round-trip the created id back
  // through list_plans and require it to show up.
  it("files an EPIC — and the result is visible as a plan", async () => {
    const r = await createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "the body");
    expect(beadsCreate).toHaveBeenCalledWith(ROOT, {
      title: "Ship auth",
      description: "the body",
      issueType: "epic",
    });
    expect(r.ok && r.data).toEqual({ id: "sparkle-plan", title: "Ship auth", outcome: "created" });

    // Round-trip: a bead carrying the type the create path asked for IS listed as a plan.
    const projectId = seedProject();
    listBeads.mockResolvedValue([bead("sparkle-plan", { type: "epic", title: "Ship auth" })]);
    const listed = await listPlans(ROOT, projectId);
    expect(listed.ok && listed.data.map((p) => p.id)).toEqual(["sparkle-plan"]);
  });

  // Guards the inverse: had create_plan kept filing tasks, this is what the user would have seen.
  it("a TASK-typed bead is NOT a plan, which is why the type matters", async () => {
    const projectId = seedProject();
    listBeads.mockResolvedValue([bead("sparkle-plan", { type: "task", title: "Ship auth" })]);
    const listed = await listPlans(ROOT, projectId);
    expect(listed.ok && listed.data).toEqual([]);
  });

  // ── THE PATH ITSELF ──────────────────────────────────────────────────────────────────────────
  //
  // `createBeadFull` reaches `notes.rs::create_bead_full` → `run_bd`, a hard 30s bound with NO
  // read-back: a create the store dropped is reported as SUCCESS and a create that merely timed out
  // is reported as FAILURE, with nothing able to tell either from the truth. `beadsCreate` probes
  // the store for the row before reporting. Asserting the seam is not ceremony — it is the entire
  // change, and it is invisible in the result shape.
  it("goes through the CONFIRMING create, never the unverified one", async () => {
    await createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "the body");
    expect(beadsCreate).toHaveBeenCalledTimes(1);
    expect(createBeadFull).not.toHaveBeenCalled();
  });

  // ── DEDUPE ───────────────────────────────────────────────────────────────────────────────────
  it("returns the EXISTING epic instead of filing a second one for the same title", async () => {
    beadsQuery.mockResolvedValue({
      beads: [{ id: "", title: "  ship   AUTH " }],
      total: 1,
      omitted: 0,
      omittedIds: [],
      limit: 50,
    });
    const r = await createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "the body");
    // The SIDE EFFECT, not the reply: nothing may be written on this path.
    expect(beadsCreate).not.toHaveBeenCalled();
    expect(r.ok && r.data).toEqual({
      id: "",
      title: "Ship auth",
      outcome: "already-filed",
    });
  });

  it("asks only about OPEN, TYPED epics — a matching task must not suppress a real epic", async () => {
    await createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "");
    expect(beadsQuery).toHaveBeenCalledWith(ROOT, {
      issueType: "epic",
      titleContains: "Ship auth",
      includeClosed: false,
      limit: 50,
    });
  });

  it("still files when the title merely OVERLAPS an existing epic", async () => {
    // `titleContains` is a substring match, so the query returns near-misses too. Suppressing on
    // one would refuse to file a genuinely new epic, which is the worse of the two mistakes.
    beadsQuery.mockResolvedValue({
      beads: [{ id: "", title: "Ship auth and billing" }],
      total: 1,
      omitted: 0,
      omittedIds: [],
      limit: 50,
    });
    const r = await createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "");
    expect(beadsCreate).toHaveBeenCalledTimes(1);
    expect(r.ok && r.data.outcome).toBe("created");
  });

  it("FAILS OPEN when the dedupe read itself errors — an unreadable store is not a duplicate", async () => {
    beadsQuery.mockRejectedValue({ kind: "storeBusy", message: "locked", exitCode: null });
    const r = await createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "");
    expect(beadsCreate).toHaveBeenCalledTimes(1);
    expect(r.ok && r.data.outcome).toBe("created");
  });

  it("ABANDONS a hung dedupe read and files anyway, instead of spending the bridge's whole budget", async () => {
    // `create_plan` is THREE bd invocations inside ONE bridge call, and the bridge kills the call at
    // 50s. On the full BD_TIMEOUT the chain is 30 + 30 + 10 = 70s, so an unbounded dedupe read
    // reintroduces the exact failure the confirmation probe was added to remove: the call killed for
    // an epic that is sitting in the store. The read is abandoned and the create proceeds — failing
    // open, which is what the dedupe already does for an error.
    vi.useFakeTimers();
    try {
      beadsQuery.mockReturnValue(new Promise(() => {})); // never settles
      const pending = createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "the body");
      await vi.advanceTimersByTimeAsync(CREATE_PLAN_DEDUPE_BUDGET_MS + 1);
      const r = await pending;
      expect(beadsCreate).toHaveBeenCalledTimes(1);
      expect(r.ok && r.data.outcome).toBe("created");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting on a hung CREATE before the bridge would cut the call off, and says UNKNOWN", async () => {
    // The chain carries ONE wall-clock deadline because summing bd's internal budgets under-counted
    // TWICE — first missing this feature's own dedupe read, then missing READER_DRAIN_GRACE, which
    // adds up to 2x5s to every completed bd invocation. What matters is not that the arithmetic is
    // now right; it is that the call cannot outlive the bridge whatever the arithmetic turns out to
    // be.
    //
    // ASSERTS THE VERDICT, NOT JUST THAT IT RETURNED. Expiring must produce `outcome-unknown` — the
    // honest answer, since bd may be finishing the write right now — and never `not-created`, which
    // would invite the retry that duplicates the epic.
    vi.useFakeTimers();
    try {
      beadsCreate.mockReturnValue(new Promise(() => {})); // never settles
      const pending = createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "the body");
      await vi.advanceTimersByTimeAsync(CREATE_PLAN_TOTAL_BUDGET_MS + 1);
      const r = await pending;
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("outcome-unknown");
        expect(r.message).toMatch(/list_plans/);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("measures the deadline from the START of the chain, not from the start of the CREATE", async () => {
    // THE LINE THIS EXISTS FOR: `remaining = CREATE_PLAN_TOTAL_BUDGET_MS - (Date.now() - startedAt)`.
    // That subtraction is the only thing making the budget a TOTAL rather than a per-stage bound,
    // and every other test here lets the dedupe resolve instantly — so elapsed is ~0, `remaining`
    // equals the whole constant, and replacing the subtraction with a bare
    // `CREATE_PLAN_TOTAL_BUDGET_MS` keeps them all green while the real worst case becomes
    // dedupe + total = 47s under a 50s ceiling. The contract test cannot see it either: it asserts
    // against the constant, not against what the code does with it. That is the same under-count
    // this whole design removed, arriving through a different door.
    //
    // So the discriminating window is between TOTAL and TOTAL + DEDUPE, measured cumulatively from
    // the first call: correct code has already expired there, the per-stage bug has not.
    vi.useFakeTimers();
    try {
      beadsQuery.mockReturnValue(new Promise(() => {})); // dedupe hangs, then fails open on expiry
      beadsCreate.mockReturnValue(new Promise(() => {})); // create never answers either
      let settled = false;
      const pending = createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "the body").then((r) => {
        settled = true;
        return r;
      });

      // THE WINDOW IS DERIVED FROM THE DEDUPE BUDGET, NOT HARD-CODED, and that is load-bearing.
      // With a literal margin the test only discriminates while the dedupe budget exceeds it: the
      // per-stage mutant expires at `D + total`, so once `D` shrinks below the margin the mutant
      // has settled by the final checkpoint too, `settled` is true either way, and the ONE test
      // that catches this bug goes vacuous with nothing to say so. `D` is freely shrinkable — the
      // only other constraint on it is an UPPER bound in the contract test — so that is a real
      // drift, and it is precisely the failure class this whole design exists to close: a
      // guarantee that reads as pinned while nothing fails when its premise moves.
      //
      // A quarter of the budget keeps `margin < D` true by construction for any sane `D`.
      const margin = Math.max(2, Math.floor(CREATE_PLAN_DEDUPE_BUDGET_MS / 4));
      expect(margin, "the window must stay strictly inside the dedupe budget to discriminate")
        .toBeLessThan(CREATE_PLAN_DEDUPE_BUDGET_MS);

      // Burn the dedupe budget. The read is abandoned and the create starts.
      await vi.advanceTimersByTimeAsync(CREATE_PLAN_DEDUPE_BUDGET_MS + 1);
      expect(settled).toBe(false);

      // Just short of the cumulative total — nothing may have given up yet, in either version.
      await vi.advanceTimersByTimeAsync(
        CREATE_PLAN_TOTAL_BUDGET_MS - CREATE_PLAN_DEDUPE_BUDGET_MS - margin,
      );
      expect(settled).toBe(false);

      // Now at cumulative `TOTAL + 1 + margin`: past the total, but still short of the per-stage
      // mutant's `DEDUPE + TOTAL` because `margin < DEDUPE`. Correct code has expired here; a
      // per-stage bound has not.
      await vi.advanceTimersByTimeAsync(2 * margin);
      expect(
        settled,
        "the deadline is measured from the start of the CHAIN — a create that gets its own full " +
          "budget after the dedupe already spent some makes the tool call outlive the bridge",
      ).toBe(true);
      const r = await pending;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("outcome-unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT expire a create that answers inside the budget", async () => {
    // The paired direction. A deadline that fired early — or one wired to the wrong clock — would
    // pass the test above while breaking every ordinary create, and nothing else here would notice.
    vi.useFakeTimers();
    try {
      let settle: (v: unknown) => void = () => {};
      beadsCreate.mockReturnValue(new Promise((res) => (settle = res)));
      const pending = createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "the body");
      await vi.advanceTimersByTimeAsync(CREATE_PLAN_TOTAL_BUDGET_MS - 1_000);
      settle({ id: "sparkle-plan", title: "Ship auth" });
      const r = await pending;
      expect(r.ok && r.data.outcome).toBe("created");
    } finally {
      vi.useRealTimers();
    }
  });

  // ── THREE OUTCOMES, NOT ONE ──────────────────────────────────────────────────────────────────
  //
  // The old path collapsed every failure onto `beads-failed`, which a model reads as "nothing
  // happened". Under a store shared by every worktree and polled every 5s, losing a race is the
  // ORDINARY failure — and a create killed on its own timeout may well have landed. Reporting that
  // as "not filed" invites a retry, and the retry is how one epic becomes two.
  it("says NOT-CREATED only when the store proves the write never landed", async () => {
    beadsCreate.mockRejectedValue({
      kind: "badOutput",
      message: `bd reported creating sparkle-x, but sparkle-x does not read back — ${WRITE_DROPPED_MARKER}, so nothing was filed`,
      exitCode: 0,
    });
    const r = await createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("not-created");
      expect(r.message).toMatch(/safe to try again/);
    }
  });

  it("says UNKNOWN for a timeout — the create may have landed after we stopped waiting", async () => {
    beadsCreate.mockRejectedValue({ kind: "timeout", message: "bd timed out", exitCode: null });
    const r = await createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("outcome-unknown");
      // The remedy has to be IN the message: a model told only "unknown" retries, which is the one
      // thing that must not happen here.
      expect(r.message).toMatch(/list_plans/);
    }
  });

  it("still reports a missing work graph as the supported state it is", async () => {
    beadsCreate.mockRejectedValue({
      kind: "noWorkspace",
      message: "no beads database found",
      exitCode: 1,
    });
    const r = await createPlan(ROOT, PLANS_TEST_PROJECT_ID, "Ship auth", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("beads-unavailable");
  });

  // The classifier on its own, over EVERY kind — so a kind added in Rust without a decision here
  // lands in the fail-safe bucket rather than silently claiming a create did not happen.
  it("classifies every beads failure kind, defaulting to UNKNOWN", () => {
    const verdict = (kind: string, message = "boom") =>
      createFailureVerdict({ kind, message, exitCode: null });
    expect(verdict("binaryNotFound")).toBe("unavailable");
    expect(verdict("noWorkspace")).toBe("unavailable");
    expect(verdict("invalidInput")).toBe("not-created");
    expect(verdict("badOutput", `x — ${WRITE_DROPPED_MARKER}, so nothing was filed`)).toBe(
      "not-created",
    );
    // badOutput WITHOUT the marker is version skew or a partial read, which proves nothing.
    expect(verdict("badOutput", "unparseable json")).toBe("unknown");
    expect(verdict("timeout")).toBe("unknown");
    expect(verdict("storeBusy")).toBe("unknown");
    expect(verdict("bdFailed")).toBe("unknown");
    // A rejection that is not a BeadsError at all must not read as proof of anything either.
    expect(createFailureVerdict(new Error("ipc down"))).toBe("unknown");
  });
});

describe("promote_plan_to_build", () => {
  // The point of the section: promoting must not produce a blank agent the human then has to
  // brief. sendToBuild owns building the seed prompt from the epic + PRD, so this delegates.
  it("delegates to sendToBuild, carrying the plan and its PRD", async () => {
    const projectId = seedProject();
    beadShow.mockResolvedValue(epic("e1"));

    const r = await promotePlanToBuild(ROOT, projectId, "e1", "PRD/thing.md");
    expect(sendToBuildMock).toHaveBeenCalledWith({
      projectId,
      epicId: "e1",
      prdPath: "PRD/thing.md",
      mode: "epic",
      // This is the concierge's TOOL layer, so the seed is machine-authored (roborev 55721). It bites
      // on the reuse path, where the seed would otherwise release a resumed orchestrator's goal debt.
      humanAuthored: false,
      // …and for the same reason it opts into being declined: an LLM promoting a plan must not pull
      // the founder out of a terminal he is typing in (engine/attentionGuard). Pinned in the EXACT
      // args rather than an objectContaining, so dropping the flag — which would silently restore
      // the steal on the one path that can cause it — fails here.
      attention: "auto",
    });
    expect(r.ok && r.data).toEqual({ agentId: "agent-new", epicId: "e1", reused: false });
  });

  it("passes a null PRD through rather than blocking on a file that isn't there", async () => {
    const projectId = seedProject();
    beadShow.mockResolvedValue(epic("e1"));
    await promotePlanToBuild(ROOT, projectId, "e1", null);
    expect(sendToBuildMock).toHaveBeenCalledWith(expect.objectContaining({ prdPath: null }));
  });

  // sendToBuild enforces ONE ORCHESTRATOR PER EPIC by reusing the bound agent. Reported so the
  // concierge can say "picking that back up" instead of implying it started something new — and
  // read BEFORE the handoff, since afterwards the two cases are indistinguishable.
  it("reports reuse when an orchestrator is already bound to the plan", async () => {
    const projectId = seedProject();
    const store = useProjectStore.getState();
    const agentId = store.addAgent(projectId, { kind: "build", name: "Auth Work" })!;
    store.setAgentEpicId(projectId, agentId, "e1");
    beadShow.mockResolvedValue(epic("e1"));
    sendToBuildMock.mockReturnValue(agentId);

    const r = await promotePlanToBuild(ROOT, projectId, "e1", null);
    expect(r.ok && r.data.reused).toBe(true);
  });

  it("refuses an unknown plan, and a bead that is not a plan, without handing anything off", async () => {
    const projectId = seedProject();

    const missing = await promotePlanToBuild(ROOT, projectId, "ghost", null);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("unknown-plan");

    beadShow.mockResolvedValue(bead("t1", { type: "task" }));
    const notPlan = await promotePlanToBuild(ROOT, projectId, "t1", null);
    expect(notPlan.ok).toBe(false);
    if (!notPlan.ok) expect(notPlan.reason).toBe("not-a-plan");

    expect(sendToBuildMock).not.toHaveBeenCalled();
  });

  // sendToBuild reaches store.addAgent DIRECTLY, and addAgent has no capacity check — the
  // machine-wide gate lives in spawnBuildAgentInProject / spawn_build_agent, neither of which this
  // path touches. Without a gate here, a concierge refused spawn_build_agent at the ceiling could
  // create a build agent anyway by promoting any unbound plan (roborev 55131).
  it("translates sendToBuild's at-capacity throw into a typed refusal", async () => {
    const projectId = seedProject();
    beadShow.mockResolvedValue(epic("e1"));
    sendToBuildMock.mockImplementation(() => {
      throw new AtCapacityError("all slots taken");
    });

    const r = await promotePlanToBuild(ROOT, projectId, "e1", null);
    expect(r.ok).toBe(false);
    // `at-capacity`, NOT the generic `action-failed` — the concierge can reason about the first and
    // cannot about the second. The GATE itself lives in sendToBuild so every caller is covered; what
    // is tested here is the translation.
    if (!r.ok) expect([r.reason, r.message]).toEqual(["at-capacity", "all slots taken"]);
  });

  it("turns a sendToBuild throw into a refusal rather than propagating it", async () => {
    const projectId = seedProject();
    beadShow.mockResolvedValue(epic("e1"));
    sendToBuildMock.mockImplementation(() => {
      throw new Error("project vanished");
    });

    const r = await promotePlanToBuild(ROOT, projectId, "e1", null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect([r.reason, r.message]).toEqual(["action-failed", "project vanished"]);
  });
});
