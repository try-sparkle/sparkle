// @vitest-environment jsdom
// ── THE ONE THING THIS FILE HAS TO PROVE ─────────────────────────────────────────────────────
// A childless declared epic ends up PICKABLE BY THE REAL `pickEpicsToDecompose`, through the real
// `sweepEpics`, with nothing faked in between except the IO seams.
//
// It is written that way because of the exact vacuous-test shape this change was most at risk of.
// `pickEpicsToDecompose` is guarded by an EARLIER gate — the `decompose:requested` opt-in — and for
// the whole life of the feature NOTHING in the app wrote that label, so every existing test of the
// picker passed by handing it a fixture with the label already on it. That proves the picker works
// and says NOTHING about whether any code path can reach it. A test here that asserted "the sweep
// called setLabel" would have the same hole from the other side: it would stay green if the label
// string, the pipeline-label set, or the picker's own clauses drifted, and the pipeline would be
// just as unreachable as it was before.
//
// So every positive case below ends at `pickEpicsToDecompose(bucketBeads(beads))`, reading the
// beads the sweep actually mutated, and every negative case asserts the SAME function does not pick
// it. The two directions are paired on purpose: a picker that returns everything satisfies half of
// them, and one that returns nothing satisfies the other half.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Same module-boundary mocks the sibling suite uses: `sweepEpics` resolves its production `restart`
// and `notify` defaults at call time, and those defaults reach a real agent mount and a real
// concierge sink. Every case here injects its own, but the mocks keep an accidental default from
// touching either.
const sendToBuildMock = vi.fn(async (_args: unknown) => ({
  agentId: "agent-1",
  verdict: "restarted" as const,
}));
vi.mock("./sendToBuild", async (orig) => ({
  ...(await orig<typeof import("./sendToBuild")>()),
  sendToBuildAwaited: (args: unknown) => sendToBuildMock(args),
}));
const notifyConciergeMock = vi.fn((_t: string, _k?: string) => true);
const availableMock = vi.fn(() => true);
vi.mock("./conciergeNotifier", async (orig) => ({
  ...(await orig<typeof import("./conciergeNotifier")>()),
  notifyConcierge: (t: string, k?: string) => notifyConciergeMock(t, k),
  conciergeNotifierAvailable: () => availableMock(),
}));

import { sweepEpics, DECOMPOSE_REQUEST_ENABLED } from "./epicSweepRunner";
import {
  DECOMPOSE_FAILED_LABEL,
  DECOMPOSE_REQUESTED_LABEL,
  DECOMPOSED_LABEL,
  DECOMPOSING_LABEL,
  pickEpicsToDecompose,
} from "./epicDecompose";
import {
  isDecomposeRequested,
  isInDecomposePipeline,
  requestDecomposeMessage,
  requestDecomposeNote,
} from "./epicDecomposeRequest";
import {
  bucketBeads,
  DELIVERED_LABEL,
  NO_AUTO_RESTART_LABEL,
  PROMOTED_LABEL,
  STALLED_LABEL,
  type Bead,
} from "./beads";
import { EPIC_HOLLOW_SETTLE_MS, EPIC_MAX_STALL_AGE_MS } from "../engine/epicContinuation";
import type { AgentTab } from "../types";

const NOW = 1_700_000_000_000;
const iso = (t: number) => new Date(t).toISOString();
/** Past the grace period — the epic has been a bare title long enough that nothing is coming. */
const HOLLOW = NOW - EPIC_HOLLOW_SETTLE_MS - 60_000;

const bead = (over: Partial<Bead> & { id: string }): Bead => ({
  title: over.id,
  description: "",
  status: "open",
  labels: [],
  parent: null,
  commentCount: 0,
  ...over,
});

/** THE SHAPE THE FOUNDER MEASURED 33 OF: declared an epic, handed to Build, and holding nothing. */
const hollowEpic = (over: Partial<Bead> = {}): Bead =>
  bead({
    id: "e1",
    title: "Ship the thing",
    type: "epic",
    labels: [PROMOTED_LABEL],
    updatedAt: iso(HOLLOW),
    ...over,
  });

const buildAgent = (over: Partial<AgentTab> & { id: string }): AgentTab =>
  ({ name: over.id, kind: "build", ...over }) as AgentTab;

function scenario(
  over: {
    beads?: Bead[];
    agents?: AgentTab[];
    alive?: (id: string) => boolean | undefined;
    requestDecomposeEnabled?: boolean;
    /** Make the label write fail, to prove a failed request never notifies. */
    labelThrows?: boolean;
  } = {},
) {
  const beads = over.beads ?? [hollowEpic()];
  const agents = over.agents ?? [];
  // THE LABEL WRITE ACTUALLY MUTATES THE FIXTURE. That is the whole apparatus: the assertion at the
  // end of each positive case reads the SAME bead list back through the real picker, so a sweep
  // that merely "called setLabel" without producing a bead the picker accepts fails here.
  const setLabel = vi.fn(
    async (_path: string, action: "add" | "remove", id: string, label: string) => {
      if (over.labelThrows) throw new Error("locked by another dolt process");
      const b = beads.find((x) => x.id === id);
      if (!b) return;
      b.labels =
        action === "add"
          ? [...b.labels.filter((l) => l !== label), label]
          : b.labels.filter((l) => l !== label);
    },
  );
  const mark = vi.fn(async (path: string, action: "add" | "remove", id: string) =>
    setLabel(path, action, id, STALLED_LABEL),
  );
  const restart = vi.fn(async (_projectId: string, _epicId: string) => ({
    agentId: "new-agent",
    verdict: "restarted" as const,
  }));
  const notify = vi.fn((_text: string) => true);
  const audit = vi.fn(async (_path: string, _id: string, _text: string) => {});
  const run = (now = NOW) =>
    sweepEpics({
      now,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents }],
      beadsFor: () => beads,
      aliveFor: over.alive ?? (() => false),
      restartEnabled: true,
      requestDecomposeEnabled: over.requestDecomposeEnabled ?? true,
      restart,
      mark,
      setLabel,
      notify,
      audit,
      auditBackoffMs: 0,
    });
  /** The board the auto-decompose watcher would see on its very next poll. */
  const boardAfterSweep = () => bucketBeads(beads);
  return { run, beads, setLabel, mark, restart, notify, audit, boardAfterSweep };
}

/** The ONE assertion that matters, said once: is this epic reachable by the real picker? */
const pickable = (s: ReturnType<typeof scenario>) =>
  pickEpicsToDecompose(s.boardAfterSweep()).map((b) => b.id);

beforeEach(() => {
  availableMock.mockReturnValue(true);
  notifyConciergeMock.mockClear();
});

describe("the missing prompt — a hollow epic reaches the real decompose picker", () => {
  it("makes a childless promoted epic PICKABLE by pickEpicsToDecompose", async () => {
    const s = scenario();
    // BEFORE: the state the founder's store is in for 33 epics. The pipeline is complete and this
    // epic is invisible to it, because nothing has ever written the opt-in.
    expect(pickable(s)).toEqual([]);

    const out = await s.run();

    // THE SIDE EFFECT, through the real picker — not "setLabel was called".
    expect(pickable(s)).toEqual(["e1"]);
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("decompose-requested");
    expect(s.beads[0]?.labels).toContain(DECOMPOSE_REQUESTED_LABEL);
    // …and it did NOT reach for an agent slot. A hollow epic has no plan to hand anybody.
    expect(s.restart).not.toHaveBeenCalled();
  });

  it("PAIRED: an epic WITH children is never asked about and never becomes pickable", async () => {
    // The other half of the pair. Without it, a rule that simply requested every promoted epic
    // would pass the case above — and would fire a paid call against work that is already planned.
    const s = scenario({
      beads: [
        hollowEpic(),
        bead({ id: "e1.1", parent: "e1", updatedAt: iso(NOW - 60_000) }),
        bead({ id: "e1.2", parent: "e1", updatedAt: iso(NOW - 60_000) }),
      ],
    });
    await s.run();
    expect(s.beads[0]?.labels).not.toContain(DECOMPOSE_REQUESTED_LABEL);
    expect(pickable(s)).toEqual([]);
  });

  it("tells the founder what it asked for, naming the opt-out that actually works", async () => {
    const s = scenario();
    await s.run();
    const text = s.notify.mock.calls[0]?.[0] ?? "";
    expect(text).toContain("e1");
    // Remedy copy is an instruction the reader will follow, so the label it names is pinned to the
    // constant the engine vetoes on rather than proofread as prose.
    expect(text).toContain(NO_AUTO_RESTART_LABEL);
    expect(s.notify).toHaveBeenCalledTimes(1);
  });

  it("leaves a durable note on the epic saying why", async () => {
    const s = scenario();
    await s.run();
    expect(s.audit).toHaveBeenCalledTimes(1);
    const [, id, text] = s.audit.mock.calls[0] ?? [];
    expect(id).toBe("e1");
    expect(text).toContain(DECOMPOSE_REQUESTED_LABEL);
  });
});

describe("asking at most once", () => {
  const alreadyLabeled = (label: string) =>
    scenario({ beads: [hollowEpic({ labels: [PROMOTED_LABEL, label] })] });

  it("does not re-ask an epic that is already requested", async () => {
    const s = alreadyLabeled(DECOMPOSE_REQUESTED_LABEL);
    const out = await s.run();
    expect(out.find((o) => o.epicId === "e1")?.reason).toBe("decompose-pending");
    // It was ALREADY pickable, and stays exactly as pickable — no second request, no second notice.
    expect(pickable(s)).toEqual(["e1"]);
    expect(s.notify).not.toHaveBeenCalled();
    expect(s.audit).not.toHaveBeenCalled();
  });

  for (const label of [DECOMPOSING_LABEL, DECOMPOSED_LABEL, DECOMPOSE_FAILED_LABEL]) {
    it(`does not re-ask an epic already carrying \`${label}\``, async () => {
      const s = alreadyLabeled(label);
      const out = await s.run();
      expect(out.find((o) => o.epicId === "e1")?.reason).toBe("decompose-pending");
      expect(s.beads[0]?.labels).not.toContain(DECOMPOSE_REQUESTED_LABEL);
      // The picker's own pipeline exclusion agrees: even if the label HAD been written, this epic
      // is not a fresh candidate. Asserting both sides is what stops the two lists drifting apart.
      expect(pickable(s)).toEqual([]);
      expect(s.notify).not.toHaveBeenCalled();
    });
  }

  it("does not ask twice across two consecutive ticks", async () => {
    // The label write mutates the fixture, so the second run reads exactly what the first wrote —
    // which is the only way this can catch a request that re-arms itself every ten minutes forever.
    const s = scenario();
    await s.run();
    await s.run(NOW + 60_000);
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.beads[0]?.labels.filter((l) => l === DECOMPOSE_REQUESTED_LABEL)).toHaveLength(1);
  });
});

describe("what it must never ask about", () => {
  const refuses = async (s: ReturnType<typeof scenario>, reason: string) => {
    const out = await s.run();
    expect(out.find((o) => o.epicId === "e1")?.reason).toBe(reason);
    expect(s.beads[0]?.labels).not.toContain(DECOMPOSE_REQUESTED_LABEL);
    expect(pickable(s)).toEqual([]);
    expect(s.notify).not.toHaveBeenCalled();
  };

  it("an epic never promoted to Build — the watch gate IS the spend gate", async () => {
    // The founder's own statement that he wants the thing delivered is what authorizes the spend.
    // Without this, shipping would fire a paid call against every hollow epic in the store at once.
    await refuses(scenario({ beads: [hollowEpic({ labels: [] })] }), "not-watched");
  });

  it("an epic the founder vetoed", async () => {
    await refuses(
      scenario({ beads: [hollowEpic({ labels: [PROMOTED_LABEL, NO_AUTO_RESTART_LABEL] })] }),
      "opted-out",
    );
  });

  it("a CLOSED childless epic — which the roll-up status cannot see", async () => {
    // `rollupEpicStatus` answers `unplanned` for a closed childless epic exactly as for an open one
    // (it rolls up CHILDREN, and there are none), so the engine's `done` branch never sees this.
    // Without the separate `epicClosed` fact the sweep asks for a paid decomposition of finished
    // work — and `pickEpicsToDecompose` would then refuse it, so the spend buys literally nothing.
    await refuses(
      scenario({ beads: [hollowEpic({ status: "closed", labels: [PROMOTED_LABEL] })] }),
      "already-done",
    );
  });

  it("an epic filed moments ago, which may be about to receive its children", async () => {
    await refuses(scenario({ beads: [hollowEpic({ updatedAt: iso(NOW - 1_000) })] }), "too-soon");
  });

  it("an epic hollow for longer than the sweep reaches", async () => {
    // The blast-radius bound on the existing backlog: a hollow epic nobody has touched in over a
    // fortnight is a decision, not a stall. It re-enters the moment anyone touches it, because the
    // window is measured from the epic's own `updatedAt` and a promotion bumps that.
    await refuses(
      scenario({ beads: [hollowEpic({ updatedAt: iso(NOW - EPIC_MAX_STALL_AGE_MS - 60_000) })] }),
      "too-old",
    );
  });

  it("an epic with no readable timestamp at all — fails closed", async () => {
    await refuses(
      scenario({ beads: [hollowEpic({ updatedAt: undefined, createdAt: undefined })] }),
      "unknown-age",
    );
  });

  it("an epic a build agent is on right now — it may be writing the plan this second", async () => {
    await refuses(
      scenario({
        agents: [buildAgent({ id: "a1", epicId: "e1" })],
        alive: () => true,
      }),
      "orchestrator-alive",
    );
  });
});

describe("the bounds on what one tick spends", () => {
  const twoHollow = () => [
    hollowEpic(),
    hollowEpic({ id: "e2", title: "Ship the other thing" }),
  ];

  it("asks about ONE hollow epic per tick, and gets to the second on the next", async () => {
    // Thirty-three hollow epics becoming eligible at once is the failure this cap exists for: it is
    // the difference between a recovery and thirty-three paid calls while nobody is looking.
    const s = scenario({ beads: twoHollow() });
    const first = await s.run();
    expect(pickable(s)).toEqual(["e1"]);
    expect(first.find((o) => o.epicId === "e2")?.note).toBe("capped");

    await s.run(NOW + 60_000);
    expect(pickable(s).sort()).toEqual(["e1", "e2"]);
  });

  it("writes nothing from a window that could never report it", async () => {
    // Mirrors the restart branch. In a satellite window the concierge sink is null for the life of
    // the window, so the notice is permanently undeliverable rather than transiently dropped —
    // spending money there tells him nothing, ever. Nothing is written, so the epic stays fully
    // eligible for the next sweep in a window that can speak.
    availableMock.mockReturnValue(false);
    const s = scenario();
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: [] }],
      beadsFor: () => s.beads,
      aliveFor: () => false,
      restartEnabled: true,
      restart: s.restart,
      mark: s.mark,
      setLabel: s.setLabel,
      audit: s.audit,
      auditBackoffMs: 0,
      // `notify` and `canNotify` both left to production: `conciergeNotifierAvailable` is mocked
      // above, which is the seam the real sweep consults.
    });
    expect(out.find((o) => o.epicId === "e1")?.note).toBe("cannot-notify");
    expect(pickable(s)).toEqual([]);
    expect(notifyConciergeMock).not.toHaveBeenCalled();
  });

  it("a failed label write never notifies and never counts as asked", async () => {
    // The sentence says "I have asked for it to be broken down". Sending it when the write never
    // landed points the founder at a plan that is not coming.
    const s = scenario({ labelThrows: true });
    const out = await s.run();
    expect(out.find((o) => o.epicId === "e1")?.note).toBe("write-failed");
    expect(pickable(s)).toEqual([]);
    expect(s.notify).not.toHaveBeenCalled();
    expect(s.audit).not.toHaveBeenCalled();
  });

  it("the kill switch stops the write without consuming the tick's one action", async () => {
    const s = scenario({
      beads: [
        hollowEpic(),
        // A second epic that IS actionable, so a suppressed request stealing the tick's budget
        // would show up as this one going unhandled.
        hollowEpic({ id: "e2", title: "Ship the other thing" }),
      ],
      requestDecomposeEnabled: false,
    });
    const out = await s.run();
    expect(out.find((o) => o.epicId === "e1")?.note).toBe("disabled");
    expect(out.find((o) => o.epicId === "e2")?.note).toBe("disabled");
    expect(pickable(s)).toEqual([]);
    // It ships ON, so the shipped configuration is the one the rest of this file exercises.
    expect(DECOMPOSE_REQUEST_ENABLED).toBe(true);
  });
});

// ── THE COLUMN THE PICKER COULD NOT SEE ──────────────────────────────────────────────────────
// `epicDecompose.boardBeads` flattened FOUR of the board's six columns, omitting `blocked` and
// `archived`. That list is the only thing `pickEpicsToDecompose` and `childrenOf` ever see, so each
// omission was a set of beads that provably did not exist to this module — and "swept to Blocked
// and stuck there" is the exact fate the founder measured for hollow epics.
describe("blocked and archived beads are part of the board", () => {
  it("picks a requested epic sitting in the BLOCKED column", () => {
    // `columnFor` routes an open bead to `blocked` for the epic sweep's own `stalled` label. Before
    // the fix, an epic the sweep had escalated could never be decomposed — the population this
    // whole change exists to rescue was the one population the picker was blind to.
    const epic = bead({
      id: "e1",
      type: "epic",
      labels: [DECOMPOSE_REQUESTED_LABEL, STALLED_LABEL],
    });
    const board = bucketBeads([epic]);
    expect(board.blocked.map((b) => b.id)).toEqual(["e1"]);
    expect(pickEpicsToDecompose(board).map((b) => b.id)).toEqual(["e1"]);
  });

  it("does NOT pick a requested epic whose only children are blocked", () => {
    // The expensive direction of the same bug: invisible children made an already-planned epic read
    // as hollow, so it would be decomposed a SECOND time and grow a duplicate set of children.
    const epic = bead({ id: "e1", type: "epic", labels: [DECOMPOSE_REQUESTED_LABEL] });
    const child = bead({ id: "e1.1", parent: "e1", labels: [STALLED_LABEL] });
    const board = bucketBeads([epic, child]);
    expect(board.blocked.map((b) => b.id)).toEqual(["e1.1"]);
    expect(pickEpicsToDecompose(board)).toEqual([]);
  });
});

// ── ZERO CHILDREN vs ALL CHILDREN CLOSED — TWO STATES A COUNT CONFLATES ──────────────────────
// Measured across the whole store today: of 37 open epics, 25 have fewer than three OPEN children
// and 19 have literally zero children, ever. So this is not an edge case — the hollow epic is the
// MAJORITY state, and that makes the distinction below load-bearing rather than pedantic.
//
// "No open children" is satisfied by both of these, and they are opposite situations:
//   • ZERO CHILDREN EVER  → nobody has decided what the work is. Ask for a plan.
//   • EVERY CHILD CLOSED  → the work was planned AND finished. Asking would fire a paid call and
//     then file a second, duplicate set of children under completed work.
// A rule written as "does this epic have any open children?" — the obvious reading of the measured
// number — treats the second as the first. Both layers are pinned here, because either one alone
// getting it right is not enough: the sweep must not ASK, and the picker must not SPEND even if
// something else were to write the label.
describe("zero children vs all children closed", () => {
  const closedChild = (id: string) =>
    bead({ id, parent: "e1", status: "closed" as const, updatedAt: iso(NOW - 60_000) });

  it("ASKS about an epic with zero children — nobody has decided what the work is", async () => {
    const s = scenario();
    const out = await s.run();
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("decompose-requested");
    expect(pickable(s)).toEqual(["e1"]);
  });

  it("does NOT ask about an epic whose children are ALL CLOSED — that work is finished", async () => {
    const s = scenario({ beads: [hollowEpic(), closedChild("e1.1"), closedChild("e1.2")] });
    const out = await s.run();
    // The roll-up calls this `done`, and the engine answers with the finished-work rule — NOT the
    // hollow rule. Same visible "no open children", opposite decision.
    expect(out.find((o) => o.epicId === "e1")?.reason).toBe("already-done");
    expect(s.beads[0]?.labels).not.toContain(DECOMPOSE_REQUESTED_LABEL);
    expect(pickable(s)).toEqual([]);
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("does not ask about a PARTLY finished epic either — one open child is still a plan", async () => {
    // The other half of the measured number: "fewer than three open children" includes epics that
    // are simply most of the way done. A plan exists; re-decomposing would duplicate it.
    const s = scenario({
      beads: [
        hollowEpic(),
        closedChild("e1.1"),
        bead({ id: "e1.2", parent: "e1", updatedAt: iso(NOW - 60_000) }),
      ],
    });
    await s.run();
    expect(s.beads[0]?.labels).not.toContain(DECOMPOSE_REQUESTED_LABEL);
    expect(pickable(s)).toEqual([]);
  });

  // ── THE PICKER'S OWN ANSWER, INDEPENDENT OF THE SWEEP ──────────────────────────────────────
  // Asserted directly, with the opt-in label already applied, because the sweep refusing is only
  // half the guarantee. The picker is what SPENDS, and a future writer of that label — a human
  // adding it by hand, a concierge tool, the UI affordance still to be built — must not be able to
  // make it decompose finished work. These two cases differ ONLY in whether the children exist.
  it("the picker itself separates them, even with the opt-in already written", () => {
    const requested = (labels: string[] = [DECOMPOSE_REQUESTED_LABEL]) =>
      bead({ id: "e1", type: "epic", labels });

    // Zero children ever ⇒ pickable.
    expect(pickEpicsToDecompose(bucketBeads([requested()])).map((b) => b.id)).toEqual(["e1"]);

    // Every child closed ⇒ NOT pickable. `childrenOf(...).length === 0` is the clause that gets
    // this right; a count of OPEN children would report zero here and decompose finished work.
    const finished = bucketBeads([requested(), closedChild("e1.1"), closedChild("e1.2")]);
    expect(finished.done.map((b) => b.id)).toEqual(["e1.1", "e1.2"]);
    expect(pickEpicsToDecompose(finished)).toEqual([]);
  });

  it("a closed child is still a child even when it landed in the SHIPPED column", () => {
    // `columnFor` routes a closed bead carrying `delivered` away from `done`, and `boardBeads` has
    // to see that column too or the epic reads as hollow and gets rebuilt. This is the same class
    // of bug as the blocked-column omission below, on the finished-work side.
    const epic = bead({ id: "e1", type: "epic", labels: [DECOMPOSE_REQUESTED_LABEL] });
    const shipped = bead({
      id: "e1.1",
      parent: "e1",
      status: "closed" as const,
      labels: [DELIVERED_LABEL],
    });
    const board = bucketBeads([epic, shipped]);
    expect(board.delivered.map((b) => b.id)).toEqual(["e1.1"]);
    expect(pickEpicsToDecompose(board)).toEqual([]);
  });
});

describe("the label predicates", () => {
  it("reads the opt-in and the pipeline as two different questions", () => {
    expect(isDecomposeRequested({ labels: [DECOMPOSE_REQUESTED_LABEL] })).toBe(true);
    expect(isInDecomposePipeline({ labels: [DECOMPOSE_REQUESTED_LABEL] })).toBe(false);
    expect(isInDecomposePipeline({ labels: [DECOMPOSING_LABEL] })).toBe(true);
    expect(isInDecomposePipeline({ labels: [DECOMPOSED_LABEL] })).toBe(true);
    expect(isInDecomposePipeline({ labels: [DECOMPOSE_FAILED_LABEL] })).toBe(true);
    expect(isInDecomposePipeline({ labels: [] })).toBe(false);
  });

  it("states the measured hollow duration, and says so honestly when there is none", () => {
    const epic = { id: "e1", title: "Ship the thing" };
    expect(requestDecomposeNote(epic, NOW - 3 * 60 * 60 * 1000, NOW)).toContain("3h");
    // "we could not read a date" must never render as "0h", which reads as a measurement.
    expect(requestDecomposeNote(epic, null, NOW)).not.toContain("0h");
  });

  it("names the epic and the working opt-out in the notice", () => {
    const text = requestDecomposeMessage({ id: "e1", title: "Ship the thing" }, NO_AUTO_RESTART_LABEL);
    expect(text).toContain("e1");
    expect(text).toContain("Ship the thing");
    expect(text).toContain(NO_AUTO_RESTART_LABEL);
  });
});
