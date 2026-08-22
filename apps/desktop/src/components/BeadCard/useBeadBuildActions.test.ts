// @vitest-environment jsdom
//
// The build handoffs, tested directly.
//
// These three orderings were each a shipped bug once, and until now every one of them was pinned
// only INDIRECTLY, through BoardView.test.tsx rendering a whole board. That is a thin thread: the
// logic moved out of BoardView into this hook precisely so the concierge could share it, and a
// board-level test would not notice the concierge inheriting a broken ordering.
//
//   * the preflight runs BEFORE `claimBead`, so a refusal at capacity leaves the bead unclaimed
//     (a claimed bead with no orchestrator is in_progress forever) — roborev 55139;
//   * the preflight runs INSIDE the batch loop, so a ceiling reached partway leaves the remaining
//     epics untouched rather than throwing out of the middle;
//   * `buildTask` passes mode "task", so the refusal does not call a single-bead build a plan —
//     roborev 55145;
//   * a dispatch that THROWS after the claim releases it again, because the preflight above cannot
//     cover a throw that happens after it and until `unclaimBead` there was no edge from
//     in_progress back to open at all — the strand was permanent (sparkle-tsyh5u).
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendToBuild = vi.fn();
const blockedReason = vi.fn<(p: string, e: string, m?: string) => string | null>(() => null);
vi.mock("../../services/sendToBuild", async (orig) => ({
  // SPREAD THE REAL MODULE FIRST, so a class the hook reaches for is the REAL class. `buildAllPrd`
  // does `e instanceof AtCapacityError` to keep the batch's refusal typed, and a factory listing
  // only the two functions makes that import resolve to nothing — vitest answers `No
  // "AtCapacityError" export`, which surfaces as an unrelated-looking assertion failure three
  // tests away from the mock. Only the two seams a test drives are overridden.
  ...(await orig<typeof import("../../services/sendToBuild")>()),
  sendToBuild: (...a: unknown[]) => sendToBuild(...a),
  // Forwards ALL args so a test can assert the MODE. A factory that dropped them is how a call
  // site that never passed "task" went unnoticed (roborev 55145).
  sendToBuildBlockedReason: (...a: [string, string, string?]) => blockedReason(...a),
}));

const claimBead = vi.fn().mockResolvedValue(undefined);
const unclaimBead = vi.fn().mockResolvedValue(undefined);
vi.mock("../../services/beads", async (orig) => ({
  ...(await orig<typeof import("../../services/beads")>()),
  claimBead: (...a: unknown[]) => claimBead(...a),
  unclaimBead: (...a: unknown[]) => unclaimBead(...a),
}));

import { AtCapacityError } from "../../services/sendToBuild";
import { useBeadBuildActions } from "./useBeadBuildActions";
import { useProjectStore } from "../../stores/projectStore";
import { useBeadsStore } from "../../stores/beadsStore";
import type { Bead, Board } from "../../services/beads";

const emptyBoard = (): Board => ({
  backlog: [],
  blocked: [],
  inProgress: [],
  done: [],
  delivered: [],
  archived: [],
});

/** Seed the beads snapshot the hook reads its blocked lane from. */
function seedBoard(board: Partial<Board>) {
  useBeadsStore.setState({
    byProject: { p1: { beads: [], board: { ...emptyBoard(), ...board }, loadedAt: 0 } },
  });
}

const PRD = "PRD file: PRD/2026-06-27-build-the-app.md";

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: "t",
    description: "",
    status: "open",
    labels: [],
    parent: null,
    commentCount: 0,
    ...over,
  };
}

const epic1 = bead({ id: "e1", type: "epic", description: PRD });
const epic2 = bead({ id: "e2", type: "epic", description: PRD });
const task1 = bead({ id: "t1", type: "task", description: PRD });

beforeEach(() => {
  sendToBuild.mockReset();
  claimBead.mockClear();
  // mockReset, not mockClear: one test below makes the unclaim REJECT, and a leaked rejection
  // would turn a later test's best-effort cleanup into an unhandled one.
  unclaimBead.mockReset();
  unclaimBead.mockResolvedValue(undefined);
  blockedReason.mockReset();
  blockedReason.mockReturnValue(null);
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "Demo",
        rootPath: "/tmp/demo",
        defaultBranch: "main",
        createdAt: "2026-01-01",
        agents: [],
        selectedAgentId: null,
      },
    ],
    selectedProjectId: "p1",
  });
});

afterEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useBeadsStore.setState({ byProject: {} });
});

function hook(b: Bead, all: Bead[] = [epic1, epic2, task1]) {
  return renderHook(() => useBeadBuildActions({ bead: b, projectId: "p1", allBeads: all }));
}

describe("useBeadBuildActions — which action a bead deserves", () => {
  it("gives an epic buildEpic and a task buildTask", async () => {
    const e = hook(epic1);
    await act(async () => {
      await e.result.current.buildIt?.();
    });
    expect(sendToBuild).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: "e1", mode: "epic" }),
    );

    sendToBuild.mockClear();
    const t = hook(task1);
    await act(async () => {
      await t.result.current.buildIt?.();
    });
    // MODE "task" — without it the preflight's "epic" default makes a one-bead build announce
    // itself as a plan (roborev 55145).
    expect(sendToBuild).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: "t1", mode: "task" }),
    );
  });

  // ══ WHICH TYPES OFFER BUILD IT — THE FOUNDER'S CALL, PINNED ═════════════════════════════════
  // This replaces a test that asserted the OPPOSITE ("gives a bead that is neither NO build action
  // at all"). That assertion was correct about the code and wrong about the product: it pinned a
  // type gate that left 1,753 of 2,074 open beads — every bug, every feature — with no Build It on
  // any surface. Asked to choose, the founder chose EVERY OPEN BEAD.
  //
  // EVERY TYPE IS DRIVEN IN ONE TEST, deliberately. A per-type test that only ever mounts its own
  // type can pass while the gate is keyed to the wrong side of the question entirely; the
  // assertion with power is the one that names all the candidates at once and says what each gets.
  const EVERY_TYPE = ["task", "bug", "feature", "chore", "epic", undefined] as const;

  it.each(EVERY_TYPE)("offers Build It on an open bead of type %s", async (type) => {
    const b = bead({ id: `x-${type ?? "untyped"}`, type });
    const { result } = hook(b, [b]);
    expect(result.current.buildIt).not.toBeNull();

    // THE SIDE EFFECT, not the precondition. "buildIt is non-null" only proves a function came
    // back; what the founder is owed is a handoff that actually reaches the orchestrator, with the
    // mode that decides whether the seed prompt tells the agent to fan out or to build one bead.
    await act(async () => {
      await result.current.buildIt?.();
    });
    expect(claimBead).toHaveBeenCalledWith("/tmp/demo", b.id);
    expect(sendToBuild).toHaveBeenCalledWith(
      expect.objectContaining({ epicId: b.id, mode: type === "epic" ? "epic" : "task" }),
    );
  });

  // ══ AND WHICH STATES DO NOT — "only before work starts" ═════════════════════════════════════
  // The PAIRED half of the test above, and it needs to be a pair: "buildIt is null" on its own is
  // ambiguous evidence, because it is also what a bead of an unbuildable TYPE returned before this
  // change. Same bead, same type, only the status moved — so the null can only be the status gate.
  it.each(["in_progress", "closed"] as const)("offers NO Build It once a bead is %s", (status) => {
    for (const type of EVERY_TYPE) {
      const open = bead({ id: "s1", type });
      const started = bead({ id: "s1", type, status });
      expect(hook(open, [open]).result.current.buildIt, `open/${type}`).not.toBeNull();
      expect(hook(started, [started]).result.current.buildIt, `${status}/${type}`).toBeNull();
    }
  });

  // ══ "OPEN" IS NOT THE SAME AS "NOT STARTED" — three lanes that are open and unstartable ══════
  // Each of these shipped briefly as offered-and-pressable and was caught by review. Every case is
  // PAIRED with the same bead minus the one disqualifying fact, because "buildIt is null" on its
  // own cannot say WHICH rule produced it — and a gate keyed to the wrong lane returns null too.

  it("refuses a DEPENDENCY-BLOCKED bead, whose prerequisites are not met", () => {
    const b = bead({ id: "blk", type: "bug" });
    seedBoard({ blocked: [b] });
    expect(hook(b, [b]).result.current.buildIt).toBeNull();
    // Same bead, same store, only the blocked lane emptied.
    seedBoard({ backlog: [b] });
    expect(hook(b, [b]).result.current.buildIt).not.toBeNull();
  });

  it("refuses a STALLED bead — the sweep already gave up on re-handing it off", () => {
    const stalled = bead({ id: "st", type: "task", labels: ["stalled"] });
    const plain = bead({ id: "st", type: "task", labels: [] });
    expect(hook(stalled, [stalled]).result.current.buildIt).toBeNull();
    expect(hook(plain, [plain]).result.current.buildIt).not.toBeNull();
  });

  it("refuses an open epic whose children have ALL closed — that is finished work", () => {
    const e = bead({ id: "ep", type: "epic" });
    const closedKid = bead({ id: "ep.1", type: "task", parent: "ep", status: "closed" });
    const openKid = bead({ id: "ep.2", type: "task", parent: "ep" });
    // The epic bead itself is `open` in BOTH cases — only the roll-up differs, so the refusal can
    // only be the roll-up.
    expect(hook(e, [e, closedKid]).result.current.buildIt).toBeNull();
    expect(hook(e, [e, closedKid, openKid]).result.current.buildIt).not.toBeNull();
  });

  it("hides the PRD batch on a started epic too, so the card cannot contradict itself", () => {
    // Both epics still share the PRD — only THIS one has been picked up. Were the batch left
    // ungated, a card showing no "Build It" would still show the louder "Build all 2 epics in this
    // PRD", whose one press claims and hands off every epic in it.
    const started = bead({ id: "e1", type: "epic", description: PRD, status: "in_progress" });
    expect(hook(started, [started, epic2]).result.current.buildAllPrd).toBeNull();
    expect(hook(epic1).result.current.buildAllPrd).not.toBeNull();
  });

  // The gate that belongs here rather than at each call site: a non-epic carrying a PRD back-link
  // resolves a non-empty prdEpics, and both surfaces independently shipped a length-only check that
  // offered "Build all N epics in this PRD" from a card for a bead that is not one of them.
  it("offers the batch ONLY for an epic with siblings in its PRD", () => {
    expect(hook(epic1).result.current.buildAllPrd).not.toBeNull();
    // Same PRD, same NON-EMPTY prdEpics — but a task. The non-emptiness is the whole point: it is
    // the only state in which the `epic` half of the gate is observably doing work, so a perf
    // change that emptied it would leave `epic &&` deletable with every test still green
    // (roborev 65605).
    expect(hook(task1).result.current.prdEpics.length).toBeGreaterThan(1);
    expect(hook(task1).result.current.buildAllPrd).toBeNull();
    // An epic alone in its PRD is not a batch either.
    const lone = bead({ id: "e9", type: "epic", description: "PRD file: PRD/other.md" });
    expect(hook(lone, [lone]).result.current.buildAllPrd).toBeNull();
  });
});

// ══ THE BATCH ANSWERS TO THE SAME RULE AS THE CARD ═══════════════════════════════════════════════
// The three exclusions originally gated only the PRESSED bead, while `buildAllPrd` claimed every
// sibling in `prdEpics` regardless — so one press on a healthy epic's card started a stalled,
// dependency-blocked or already-finished one (roborev 65607). A `closed` sibling is the sharpest
// case: it gets REOPENED to in_progress with an orchestrator against finished work.
describe("useBeadBuildActions — the PRD batch skips siblings that are not startable", () => {
  const startableEpic = bead({ id: "ok", type: "epic", description: PRD });

  it.each([
    ["stalled", bead({ id: "bad", type: "epic", description: PRD, labels: ["stalled"] })],
    ["closed", bead({ id: "bad", type: "epic", description: PRD, status: "closed" })],
    ["in progress", bead({ id: "bad", type: "epic", description: PRD, status: "in_progress" })],
  ])("does not claim or hand off a %s sibling", async (_label, bad) => {
    const all = [startableEpic, bad];
    const { result } = hook(startableEpic, all);
    // Only ONE startable epic remains, so there is no batch left to offer — which is itself the
    // fix: the count and the loop now read the same filtered list.
    expect(result.current.prdEpics.map((b) => b.id)).toEqual(["ok"]);
    expect(result.current.buildAllPrd).toBeNull();
    // ...and the healthy one is still individually buildable, so the null above is the SIBLING
    // being excluded and not the whole hook going quiet.
    await act(async () => {
      await result.current.buildIt?.();
    });
    expect(sendToBuild).toHaveBeenCalledTimes(1);
    expect(claimBead).toHaveBeenCalledTimes(1);
    expect(claimBead).toHaveBeenCalledWith("/tmp/demo", "ok");
  });

  it("still runs the batch over the siblings that ARE startable", async () => {
    const other = bead({ id: "ok2", type: "epic", description: PRD });
    const bad = bead({ id: "bad", type: "epic", description: PRD, status: "closed" });
    const { result } = hook(startableEpic, [startableEpic, other, bad]);
    expect(result.current.buildAllPrd).not.toBeNull();
    await act(async () => {
      await result.current.buildAllPrd?.();
    });
    // Exactly the two healthy epics — the closed one is never claimed and never handed off.
    expect(claimBead.mock.calls.map((c) => c[1]).sort()).toEqual(["ok", "ok2"]);
    expect(sendToBuild).toHaveBeenCalledTimes(2);
  });

  it("refuses a dependency-blocked sibling read from the board's blocked lane", async () => {
    const blocked = bead({ id: "dep", type: "epic", description: PRD });
    seedBoard({ blocked: [blocked] });
    const { result } = hook(startableEpic, [startableEpic, blocked]);
    expect(result.current.prdEpics.map((b) => b.id)).toEqual(["ok"]);
    // Paired: empty the lane and the same sibling comes back into the batch.
    seedBoard({ backlog: [blocked] });
    const again = hook(startableEpic, [startableEpic, blocked]);
    expect(again.result.current.prdEpics.map((b) => b.id).sort()).toEqual(["dep", "ok"]);
  });
});

describe("useBeadBuildActions — the preflight runs BEFORE the claim", () => {
  // A claimed bead with no orchestrator sits in_progress forever with nothing building it, so the
  // refusal has to happen while nothing has been written yet (roborev 55139).
  it("does not claim the bead when the preflight refuses", async () => {
    blockedReason.mockReturnValue("At capacity.");
    const { result } = hook(epic1);
    await act(async () => {
      // It REJECTS with the refusal rather than swallowing it — that is the change of shape from
      // the old DetailOverlay, which set a local error string. The card's `runBuild` catches this
      // and renders the sentence beside the button, so the reason still reaches the reader.
      await expect(result.current.buildIt?.()).rejects.toThrow("At capacity.");
    });
    // THE ASSERTION THAT MATTERS, and the reason the ordering is what it is: nothing was written.
    expect(claimBead).not.toHaveBeenCalled();
    expect(sendToBuild).not.toHaveBeenCalled();
  });

  it("claims and hands off when it does not", async () => {
    const { result } = hook(epic1);
    await act(async () => {
      await result.current.buildIt?.();
    });
    expect(claimBead).toHaveBeenCalledWith("/tmp/demo", "e1");
    expect(sendToBuild).toHaveBeenCalledTimes(1);
  });
});

describe("useBeadBuildActions — the batch checks the ceiling on every iteration", () => {
  // The ceiling can be reached PARTWAY through a batch. Checking once up front would claim epics it
  // then could not hand off; throwing out of the middle would leave the caller unable to say how far
  // it got. It stops cleanly and reports.
  it("stops at the ceiling and leaves the remaining epics unclaimed", async () => {
    // First epic passes, second is refused.
    blockedReason.mockReturnValueOnce(null).mockReturnValueOnce("At capacity.");
    const { result } = hook(epic1);

    await act(async () => {
      await expect(result.current.buildAllPrd?.()).rejects.toThrow(/Started 1 of 2/);
    });

    // Exactly one handoff, and the refused epic was never claimed.
    expect(sendToBuild).toHaveBeenCalledTimes(1);
    expect(claimBead).toHaveBeenCalledTimes(1);
    expect(claimBead).toHaveBeenCalledWith("/tmp/demo", "e1");
    expect(claimBead).not.toHaveBeenCalledWith("/tmp/demo", "e2");
  });

  it("hands off every epic when none is refused", async () => {
    const { result } = hook(epic1);
    await act(async () => {
      await result.current.buildAllPrd?.();
    });
    expect(sendToBuild).toHaveBeenCalledTimes(2);
    expect(claimBead).toHaveBeenCalledTimes(2);
  });
});

describe("useBeadBuildActions — a dispatch that never binds an orchestrator releases the claim", () => {
  // ══ WHY THE ASSERTION IS THE UNCLAIM AND NOT THE CLAIM ══════════════════════════════════════
  // `claimBead` was already called here before this change — asserting it proves nothing about the
  // fix. The SIDE EFFECT is the release: the claim was written, the handoff then threw, and the
  // bead has to come back to `open`. Until `unclaimBead` existed there was no path from
  // in_progress back to open ANYWHERE in the app, so the strand was permanent — measured at 129
  // beads sitting in_progress on one machine, 35 of them older than 14 days (sparkle-tsyh5u).
  //
  // The preflight cannot cover this. It answers CAPACITY only — it returns null for an unknown
  // project — and it is a preflight, so anything throwing after it strands the claim regardless.

  it("unclaims the bead when the handoff throws, AFTER having claimed it", async () => {
    sendToBuild.mockImplementationOnce(() => {
      throw new Error("Unknown project.");
    });
    const { result } = hook(epic1);

    await act(async () => {
      // The ORIGINAL error still reaches the caller — that is the sentence the card renders.
      await expect(result.current.buildIt?.()).rejects.toThrow("Unknown project.");
    });

    expect(unclaimBead).toHaveBeenCalledWith("/tmp/demo", "e1");
    expect(unclaimBead).toHaveBeenCalledTimes(1);
    // ...and it ran AFTER the claim, not instead of it. A release that raced the write it undoes
    // would leave the bead claimed just the same.
    // Both defaults fail the assertion if the call is missing, so an absent claim or an absent
    // release cannot read as a satisfied ordering.
    const claimedAt = claimBead.mock.invocationCallOrder[0] ?? Infinity;
    const releasedAt = unclaimBead.mock.invocationCallOrder[0] ?? -Infinity;
    expect(releasedAt).toBeGreaterThan(claimedAt);
  });

  // THE PAIRED HALF. One test proving the release happens is ambiguous on its own — a hook that
  // unclaimed unconditionally would pass it while destroying every real handoff. This pins the
  // cause: the release is the FAILURE path, and a build that took keeps its claim.
  it("does NOT unclaim when the handoff succeeds", async () => {
    const { result } = hook(epic1);
    await act(async () => {
      await result.current.buildIt?.();
    });
    expect(claimBead).toHaveBeenCalledWith("/tmp/demo", "e1");
    expect(sendToBuild).toHaveBeenCalledTimes(1);
    expect(unclaimBead).not.toHaveBeenCalled();
  });

  // Nor on the preflight refusal, which never claimed in the first place — there is nothing to
  // release, and an unclaim there would write to a bead this press never touched.
  it("does NOT unclaim when the preflight refuses before the claim", async () => {
    blockedReason.mockReturnValue("At capacity.");
    const { result } = hook(epic1);
    await act(async () => {
      await expect(result.current.buildIt?.()).rejects.toThrow("At capacity.");
    });
    expect(claimBead).not.toHaveBeenCalled();
    expect(unclaimBead).not.toHaveBeenCalled();
  });

  it("lets the DISPATCH error through even when the cleanup itself fails", async () => {
    // Best-effort, and this is why: the user needs to know why the build refused, not why the
    // tidy-up did. A throwing unclaim that displaced the real error would make the failure
    // unreadable at exactly the moment it matters.
    sendToBuild.mockImplementationOnce(() => {
      throw new Error("Unknown project.");
    });
    unclaimBead.mockRejectedValueOnce(new Error("bd not found"));
    const { result } = hook(epic1);

    await act(async () => {
      await expect(result.current.buildIt?.()).rejects.toThrow("Unknown project.");
    });
    expect(unclaimBead).toHaveBeenCalledWith("/tmp/demo", "e1");
  });

  it("releases only the epic whose dispatch threw, leaving its started siblings claimed", async () => {
    // The batch's sentence is "Started N of M; the rest are untouched" — the epic that failed has
    // to be one of the untouched ones or the copy lies. Its already-dispatched siblings really ARE
    // building, so their claims stand.
    sendToBuild.mockImplementationOnce(() => {}).mockImplementationOnce(() => {
      throw new Error("Unknown project.");
    });
    const { result } = hook(epic1);

    await act(async () => {
      await expect(result.current.buildAllPrd?.()).rejects.toThrow(/Started 1 of 2/);
    });

    expect(claimBead.mock.calls.map((c) => c[1])).toEqual(["e1", "e2"]);
    expect(unclaimBead.mock.calls.map((c) => c[1])).toEqual(["e2"]);
  });

  // ══ THE BATCH REWRAP KEEPS THE ERROR'S CLASS — BOTH ARMS, OR NEITHER IS PINNED ═══════════════
  // `buildAllPrd` appends "Started N of M; the rest are untouched." to whatever `sendToBuild` threw,
  // and appending means CONSTRUCTING A NEW ERROR — which is where a class goes to die. It matters
  // because `AtCapacityError` exists so callers "can map it to their own vocabulary … instead of
  // string-matching a generic Error", and `epicSweepRunner` / `conciergeTools/plans` both establish
  // `instanceof AtCapacityError` as the house pattern. `buildOne`, one arm up, rethrows UNWRAPPED —
  // so a flattening rewrap here would make two sibling paths disagree about the identical refusal.
  //
  // Every other test on this path throws a plain `Error`, so collapsing the ternary back to
  // `new Error(...)` left the whole suite green: the true arm never ran. These two drive both.

  it("keeps AtCapacityError's CLASS through the partial-batch rewrap, sentence and all", () => {
    const atCapacity = new AtCapacityError("Starting this plan would need another agent.");
    sendToBuild.mockImplementationOnce(() => {}).mockImplementationOnce(() => {
      throw atCapacity;
    });
    const { result } = hook(epic1);

    return act(async () => {
      const thrown = await result.current
        .buildAllPrd?.()
        .then(() => null)
        .catch((e: unknown) => e);
      // BOTH HALVES. The class alone would pass for a rethrow that dropped the batch sentence, and
      // the sentence alone is what the plain-Error case already proves.
      expect(thrown).toBeInstanceOf(AtCapacityError);
      expect((thrown as Error).message).toContain("Started 1 of 2");
      expect((thrown as Error).message).toContain("would need another agent");
    });
  });

  it("does NOT promote a plain Error into an AtCapacityError", () => {
    // The other direction. Without this, `throw new AtCapacityError(sentence)` unconditionally —
    // which is a real way to "fix" the test above — would pass, and every unrelated dispatch failure
    // would start reporting itself to the concierge as a capacity refusal.
    sendToBuild.mockImplementationOnce(() => {}).mockImplementationOnce(() => {
      throw new Error("Unknown project.");
    });
    const { result } = hook(epic1);

    return act(async () => {
      const thrown = await result.current
        .buildAllPrd?.()
        .then(() => null)
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(AtCapacityError);
      expect((thrown as Error).message).toContain("Started 1 of 2");
      // `cause` is what keeps the original reachable once the message has been rebuilt.
      expect((thrown as Error).cause).toBeInstanceOf(Error);
    });
  });
});

describe("the epic index is beads.ts's, not a second private copy", () => {
  // ══ THE ASSERTION IS THE DIVERGENCE, NOT THE CALL COUNT ══════════════════════════════════════
  // This hook used to keep its OWN `WeakMap<readonly Bead[], EpicIndex>` over `buildEpicIndex`,
  // beside the one `beads.ts` exports as `epicIndexOf` and that `Card`/`DetailOverlay` resolve
  // through. Two builds per snapshot is the cheap half of that bug. The half that changes an
  // ANSWER is staleness: `beads.ts` stores `beads.length` next to its index and rebuilds when it
  // moves; the private copy had no such guard, so an in-place `push` left this hook answering from
  // an index the card beside it had already replaced (roborev 65768).
  //
  // So the test mutates ONE array in place — same identity, new length — and asserts the hook's
  // verdict MOVES. Against the private WeakMap it cannot: the index is looked up by identity, the
  // identity did not change, and `buildIt` stays null forever. A "was buildEpicIndex called once"
  // spy would not catch it, because both caches are hit exactly once each and the wrong answer is
  // the one that survives.
  it("re-reads an in-place push, so it cannot disagree with the card beside it", () => {
    // An epic whose only child is CLOSED: `isStartable` refuses it — `rollupEpicStatus` says
    // "done", i.e. finished work whose epic bead nobody closed. Build It must be withheld.
    const e = bead({ id: "e9", type: "epic" });
    const doneKid = bead({ id: "e9.1", parent: "e9", status: "closed" });
    const all = [e, doneKid];

    const r = renderHook(
      ({ list }) => useBeadBuildActions({ bead: e, projectId: "p1", allBeads: list }),
      { initialProps: { list: all as Bead[] } },
    );
    expect(r.result.current.buildIt).toBeNull();

    // A NEW open child arrives by in-place push — the same array object, length 2 -> 3. The epic is
    // no longer finished, so Build It must come back.
    all.push(bead({ id: "e9.2", parent: "e9", status: "open" }));
    r.rerender({ list: all });

    expect(r.result.current.buildIt).not.toBeNull();
  });

  // THE SIBLING CACHE, asserted separately because `buildIt` cannot see it. `prdEpicsByPath` was
  // the other identity-only WeakMap in this file, and the fix above did not reach it — so the same
  // in-place push left `startable` fresh and `prdEpics` assembled from the RETIRED index, one
  // scope down from the bug that was just closed (roborev 65775). `prdEpics` is the observable:
  // it is what `buildAllPrd` iterates and what the card counts in "Build all N epics in this PRD".
  it("regroups PRD epics on an in-place push too, so buildAllPrd cannot under-count", () => {
    const a = bead({ id: "pa", type: "epic", description: PRD });
    const all = [a];

    const r = renderHook(
      ({ list }) => useBeadBuildActions({ bead: a, projectId: "p1", allBeads: list }),
      { initialProps: { list: all as Bead[] } },
    );
    // One epic in its own PRD is not a batch — `buildAllPrd` needs more than one.
    expect(r.result.current.prdEpics).toHaveLength(1);
    expect(r.result.current.buildAllPrd).toBeNull();

    // A SECOND epic on the same PRD arrives by in-place push — same array object, length 1 -> 2.
    all.push(bead({ id: "pb", type: "epic", description: PRD }));
    r.rerender({ list: all });

    expect(r.result.current.prdEpics).toHaveLength(2);
    expect(r.result.current.buildAllPrd).not.toBeNull();
  });

  // THE THIRD READER, and the one whose staleness is not advisory. `epic` is not a display flag:
  // `buildIt` picks `buildTask` vs `buildEpic` from it, so a stale `false` dispatches sendToBuild
  // in "task" MODE against work that now has children — the exact wrong-mode bug roborev 55145
  // closed, re-entered through a cache. The subject MUST be a non-epic that BECOMES one; the two
  // tests above both use `type: "epic"`, where the answer is true before and after the push and
  // the memo's dep list cannot matter (roborev 65777).
  it("re-reads epic-ness on an in-place push, so a bead that gains a child is not built as a task", async () => {
    const t = bead({ id: "tk", type: "task" });
    const all = [t];

    const r = renderHook(
      ({ list }) => useBeadBuildActions({ bead: t, projectId: "p1", allBeads: list }),
      { initialProps: { list: all as Bead[] } },
    );
    await act(async () => {
      await r.result.current.buildIt?.();
    });
    expect(sendToBuild).toHaveBeenCalledWith(expect.objectContaining({ epicId: "tk", mode: "task" }));

    // It acquires its first child by in-place push — same array object, length 1 -> 2. `isEpic`
    // keys on CHILDREN, not on `type`, so this bead is an epic from here on.
    sendToBuild.mockClear();
    all.push(bead({ id: "tk.1", parent: "tk", status: "open" }));
    r.rerender({ list: all });

    await act(async () => {
      await r.result.current.buildIt?.();
    });
    expect(sendToBuild).toHaveBeenCalledWith(expect.objectContaining({ epicId: "tk", mode: "epic" }));
  });
});
