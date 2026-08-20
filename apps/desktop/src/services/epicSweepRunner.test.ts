import { describe, it, expect, vi } from "vitest";

// `sendToBuild` is mocked so ONE test can drive the sweep's PRODUCTION restart seam — the
// `opts.restart ?? (...)` default — instead of every case injecting its own function and leaving
// that default executed by nothing. That gap is what let two separate "reported success,
// relaunched nothing" defects reach review: a green suite and a clean mutation PASS are both
// consistent with a default no caller ever runs.
// It is `sendToBuildAwaited`, NOT `sendToBuild`, and swapping which one this mock names is what
// makes the fix visible here. The sweep is the caller that spends a one-shot budget and then tells a
// human, and `sendToBuild`'s relaunch reports a DISPATCH RECEIPT while its seed is swallowed by the
// resume path — so a sweep wired to it can report a restart that neither happened nor arrived.
// Mocking the awaited entry point means a regression back to the synchronous one shows up as this
// mock never being called, rather than as a still-green suite.
const sendToBuildMock = vi.fn(async (_args: unknown) => ({
  agentId: "agent-1",
  verdict: "restarted" as const,
}));
vi.mock("./sendToBuild", async (orig) => ({
  ...(await orig<typeof import("./sendToBuild")>()),
  sendToBuildAwaited: (args: unknown) => sendToBuildMock(args),
}));

// …and the NOTIFIER, for the same reason. `scenario()` injects `notify`, so the production default
// — `opts.notify ?? ((t) => notifyConcierge(t, "pusher"))` — was executed by no test at all. Every
// case asserting `noticed` was really asserting that a mock returned what the mock was told to
// return, and the regression that reintroduces the bug this commit exists to fix
// (`(text) => { notifyConcierge(text); return true; }`) type-checks cleanly and leaves the whole
// suite green. Mocked at the module boundary so ONE test can drive the real wiring.
const notifyConciergeMock = vi.fn((_t: string, _k?: string) => true);
const availableMock = vi.fn(() => true);
vi.mock("./conciergeNotifier", async (orig) => ({
  ...(await orig<typeof import("./conciergeNotifier")>()),
  notifyConcierge: (t: string, k?: string) => notifyConciergeMock(t, k),
  conciergeNotifierAvailable: () => availableMock(),
}));
import {
  sweepEpics,
  candidateFor,
  lastChildProgressAt,
  restartMessage,
  escalateMessage,
  MAX_ACTIONS_PER_SWEEP,
  RESTART_ENABLED,
  auditNote,
  startEpicSweepRunner,
  stopEpicSweepRunner,
  isEpicSweepRunnerRunning,
} from "./epicSweepRunner";
import {
  NO_AUTO_RESTART_LABEL,
  PROMOTED_LABEL,
  STALLED_LABEL,
  SWEEP_NO_AUTO_LABEL,
  SWEEP_RESTART_PREFIX,
  columnFor,
  type Bead,
} from "./beads";
import { EPIC_STALL_MS } from "../engine/epicContinuation";
import { MountRefusedError } from "./sendToBuild";
import type { AgentTab } from "../types";

const NOW = 1_700_000_000_000;
const iso = (t: number) => new Date(t).toISOString();
const STALE = NOW - EPIC_STALL_MS - 60_000;

const bead = (over: Partial<Bead> & { id: string }): Bead => ({
  title: over.id,
  description: "",
  status: "open",
  labels: [],
  parent: null,
  commentCount: 0,
  ...over,
});

const buildAgent = (over: Partial<AgentTab> & { id: string }): AgentTab =>
  ({ name: over.id, kind: "build", ...over }) as AgentTab;

/** The same epic, but already carrying the sweep's own restart marker at `at` — i.e. its one
 *  automatic restart has been spent. */
const markedBeads = (at: number): Bead[] => [
  bead({
    id: "e1",
    title: "Ship the thing",
    type: "epic",
    labels: [`${SWEEP_RESTART_PREFIX}${at}`],
  }),
  bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
];

/** A project with one epic that was promoted, planned, and then abandoned — the case the sweep
 *  exists for. Each test overrides only the field it is about. */
function scenario(over: {
  beads?: Bead[];
  agents?: AgentTab[];
  alive?: (id: string) => boolean | undefined;
  /** Which configuration this case is about. Defaults to `false` — NOT because that is what ships
   *  (the flag ships `true`), but because these cases predate the flip and each one states its own
   *  subject explicitly. A case about the ON path must pass `true`; do not read the default as
   *  production. */
  restartEnabled?: boolean;
} = {}) {
  const beads = over.beads ?? [
    bead({ id: "e1", title: "Ship the thing", type: "epic" }),
    bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
    bead({ id: "e1.2", parent: "e1", updatedAt: iso(STALE) }),
  ];
  const agents = over.agents ?? [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })];
  // Typed parameters, not bare `vi.fn(() => …)`: an untyped mock records its calls as `[]`, so
  // `mock.calls[0][0]` is a type error and, worse, `toHaveBeenCalledWith(...)` cannot be checked
  // against the real signature.
  const restart = vi.fn(async (_projectId: string, _epicId: string) => ({
  agentId: "new-agent",
  verdict: "restarted" as const,
}));
  const notify = vi.fn((_text: string) => true);
  // THE LABEL WRITES ACTUALLY MUTATE THE FIXTURE, which is the difference between a test that can
  // catch the infinite-restart bug and one that cannot. A mock that merely RECORDS the write leaves
  // the next sweep reading the same pre-write beads, so the loop looks like it terminates when it
  // does not. Both label seams apply their effect to `beads` here, so a second `run()` sees exactly
  // what the first one wrote.
  const setLabel = vi.fn(
    async (_path: string, action: "add" | "remove", id: string, label: string) => {
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
  const run = (now = NOW) =>
    sweepEpics({
      now,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents }],
      beadsFor: () => beads,
      aliveFor: over.alive ?? (() => false),
      restartEnabled: over.restartEnabled ?? false,
      restart,
      mark,
      setLabel,
      notify,
    });
  return { run, restart, mark, setLabel, notify, beads };
}

// ── THE SHAPE PRODUCTION WAS ACTUALLY IN ────────────────────────────────────────────────────────
// Every case in this file hands `scenario()` an agent list containing the binding, so the whole
// suite was green while the sweep could not act on a single real epic. These drive the sweep with
// `agents: []` — the state the founder's install had been in since v0.114.0 — and assert the SIDE
// EFFECT (a restart dispatched, a notice sent), not the decision alone.
describe("sweepEpics with NO agent bound — the inert-sweep regression", () => {
  const promotedEpic = (labels: string[] = [PROMOTED_LABEL]): Bead[] => [
    bead({ id: "e1", title: "Ship the thing", type: "epic", labels }),
    bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
  ];

  it("restarts a label-watched epic that has no agent bound at all", async () => {
    const s = scenario({ beads: promotedEpic(), agents: [], restartEnabled: true });
    const out = await s.run();
    const o = out.find((x) => x.epicId === "e1");
    expect(o?.action).toBe("restart");
    // THE SIDE EFFECT, not the decision: before this fix the decision itself was `not-watched`,
    // and a test asserting only `action` could be satisfied by a sweep that dispatched nothing.
    expect(o?.performed).toBe("restarted");
    expect(s.restart).toHaveBeenCalledTimes(1);
    expect(s.restart.mock.calls[0]?.[1]).toBe("e1");
    expect(s.notify).toHaveBeenCalledTimes(1);
  });

  it("does nothing for the same epic without the label — proving the label is what watches it", async () => {
    const s = scenario({ beads: promotedEpic([]), agents: [], restartEnabled: true });
    const out = await s.run();
    expect(out.find((x) => x.epicId === "e1")?.reason).toBe("not-watched");
    expect(s.restart).not.toHaveBeenCalled();
  });

  // ── A VETO MUST NOT FREEZE A STALE ALARM IN THE BLOCKED LANE ────────────────────────────────
  // The first cut checked the veto immediately after the watch gate, which reads as "leave a vetoed
  // epic entirely alone" and is wrong: `clear` is not something done TO the epic, it is the
  // retraction of a `stalled` mark THIS SWEEP wrote, and the board routes that mark to Blocked.
  // Vetoing the retraction stranded a false "this needs you" flag in front of the founder forever,
  // on an epic he had just switched off — it could never be cleared again, because every later tick
  // returned at the veto.
  it("still clears a stale escalation on a vetoed epic that has recovered", async () => {
    const s = scenario({
      beads: [
        bead({
          id: "e1",
          title: "Ship the thing",
          type: "epic",
          labels: [PROMOTED_LABEL, NO_AUTO_RESTART_LABEL, STALLED_LABEL],
        }),
        // Moving again — inside the stall window, so this epic has recovered.
        bead({ id: "e1.1", parent: "e1", updatedAt: iso(NOW - 60_000) }),
      ],
      agents: [],
      restartEnabled: true,
    });
    const out = await s.run();
    expect(out.find((x) => x.epicId === "e1")?.action).toBe("clear");
    // THE SIDE EFFECT: the mark actually comes off, so the Blocked lane empties.
    expect(s.beads.find((b) => b.id === "e1")?.labels).not.toContain(STALLED_LABEL);
    // …and it still starts nothing, which is what the veto is for.
    expect(s.restart).not.toHaveBeenCalled();
  });

  // ── A LOST STAMP MUST COST A TICK, NOT THE EPIC ─────────────────────────────────────────────
  // `sendToBuild` writes the marker fire-and-forget, and `bd` writes queue behind a single writer.
  // Without this heal a lost write is PERMANENT and silent: the case the fix addresses is precisely
  // "nobody hands this epic over again", so no later handoff would re-stamp it.
  it("re-stamps a missing watch marker when a bound agent proves the epic was handed over", async () => {
    const s = scenario({
      beads: [
        bead({ id: "e1", title: "Ship the thing", type: "epic", labels: [] }),
        bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
      ],
      agents: [buildAgent({ id: "a1", epicId: "e1" })],
      restartEnabled: true,
    });
    await s.run();
    expect(s.setLabel).toHaveBeenCalledWith("/proj", "add", "e1", PROMOTED_LABEL);
    expect(s.beads.find((b) => b.id === "e1")?.labels).toContain(PROMOTED_LABEL);
  });

  it("does not re-stamp an epic that has no bound agent — the label is not invented from nothing", async () => {
    const s = scenario({ beads: promotedEpic([]), agents: [], restartEnabled: true });
    await s.run();
    expect(s.setLabel).not.toHaveBeenCalledWith("/proj", "add", "e1", PROMOTED_LABEL);
  });

  it("honours the founder's veto and dispatches nothing", async () => {
    const s = scenario({
      beads: promotedEpic([PROMOTED_LABEL, NO_AUTO_RESTART_LABEL]),
      agents: [],
      restartEnabled: true,
    });
    const out = await s.run();
    expect(out.find((x) => x.epicId === "e1")?.reason).toBe("opted-out");
    expect(s.restart).not.toHaveBeenCalled();
    // A veto must be SILENT as well as inert — an epic he switched off must not keep notifying.
    expect(s.notify).not.toHaveBeenCalled();
  });

  // ── THE OTHER DIRECTION, AND IT IS THE ONE A LATER MOVE WOULD BREAK SILENTLY ─────────────────
  // The veto's placement is load-bearing in TWO directions: below the three `clear` branches, and
  // above BOTH the escalate and restart branches. The case above only reaches `restart`, because
  // its epic carries no `sweep-restarted:` marker — so moving the veto three lines further down
  // would keep the whole suite green while a vetoed epic got `STALLED_LABEL` written and a notice
  // fired, the exact opposite of the property the case above claims to protect. One direction
  // passing is half the evidence.
  it("does not ESCALATE a vetoed epic whose restart was already spent", async () => {
    const s = scenario({
      // markedBeads carries the sweep's own restart marker, so the budget is spent and the engine
      // would otherwise decide `escalate` rather than `restart`.
      beads: markedBeads(NOW - 60_000).map((b) =>
        b.id === "e1"
          ? { ...b, labels: [...b.labels, PROMOTED_LABEL, NO_AUTO_RESTART_LABEL] }
          : b,
      ),
      agents: [],
      restartEnabled: true,
    });
    const out = await s.run();
    expect(out.find((x) => x.epicId === "e1")?.reason).toBe("opted-out");
    expect(s.mark).not.toHaveBeenCalledWith("/proj", "add", "e1");
    expect(s.notify).not.toHaveBeenCalled();
    expect(s.beads.find((b) => b.id === "e1")?.labels).not.toContain(STALLED_LABEL);
  });
});

describe("sweepEpics — the case it exists for", () => {
  // THE DECISION IS STILL `restart`; the DEED is an escalation, because RESTART_ENABLED is false —
  // handing an epic back needs a relaunch-and-deliver mechanism that does not exist yet (see the
  // constant's doc). Asserting both halves keeps "what it decided" and "what it did" legible apart,
  // which is exactly what flipping that constant later will change.
  it("surfaces an abandoned plan to the founder, and does not claim to have restarted it", async () => {
    const s = scenario();
    const out = await s.run();
    const o = out.find((x) => x.epicId === "e1");
    expect(o?.action).toBe("restart");
    expect(o?.performed).toBe("escalated");
    expect(s.restart).not.toHaveBeenCalled();
    // The notice is half the requirement, so its absence would be a failure, not a cosmetic gap.
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify.mock.calls[0]?.[0]).toContain("e1");
    expect(s.notify.mock.calls[0]?.[0]).not.toMatch(/I restarted it/i);
  });

  it("escalates instead when a restart was already spent and bought nothing", async () => {
    const s = scenario({
      // The SWEEP's own marker is newer than any child movement ⇒ its one restart is spent.
      beads: markedBeads(NOW - 60_000),
    });
    const out = await s.run();
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("escalated");
    expect(s.restart).not.toHaveBeenCalled();
    expect(s.mark).toHaveBeenCalledWith("/proj", "add", "e1");
  });

  it("puts an escalated epic in the Blocked lane", async () => {
    // The end-to-end consequence of the mark, asserted through the real `columnFor` rather than by
    // trusting that a label somewhere implies a column.
    const epic = bead({ id: "e1", labels: [STALLED_LABEL] });
    expect(columnFor(epic)).toBe("blocked");
    expect(columnFor(bead({ id: "e2" }))).toBe("backlog");
  });
});

// ── THE PROPERTY THE WHOLE DESIGN RESTS ON: THE SWEEP TERMINATES ────────────────────────────────
//
// This is the test that would have caught the bug review found, and the reason it did not exist
// before is instructive: every earlier test injected its own `restart` mock and asserted ONE sweep,
// so the production consequence — that `sendToBuild` REUSES the bound build agent, leaving the
// timestamp the budget was read from frozen forever — was invisible. The budget is now a marker the
// sweep writes itself, and these cases run the sweep REPEATEDLY against a store that keeps what it
// wrote, so an unbounded loop shows up as a failing count rather than as a passing single tick.
describe("sweepEpics — it stops", () => {
  it("restarts once and then escalates, over consecutive sweeps", async () => {
    const s = scenario({ restartEnabled: true });
    expect((await s.run(NOW)).find((o) => o.epicId === "e1")?.performed).toBe("restarted");
    // ...a later tick, with the work still not moving. The marker the first sweep wrote is what the
    // second one reads.
    const later = NOW + 10 * EPIC_STALL_MS;
    expect((await s.run(later)).find((o) => o.epicId === "e1")?.performed).toBe("escalated");
    expect(s.restart).toHaveBeenCalledTimes(1);
  });

  it("never restarts again, however many ticks pass", async () => {
    // The literal shape of the bug: a ten-minute timer restarting the same dead epic forever, each
    // time telling the founder it would stop. Ten ticks, one restart.
    const s = scenario({ restartEnabled: true });
    for (let i = 0; i < 10; i++) await s.run(NOW + i * EPIC_STALL_MS * 3);
    expect(s.restart).toHaveBeenCalledTimes(1);
    // ...and exactly one notice per real event: the restart, and the escalation. Not ten.
    expect(s.notify).toHaveBeenCalledTimes(2);
  });

  it("keeps exactly one restart marker on the epic, never a growing pile", async () => {
    const s = scenario({ restartEnabled: true });
    await s.run(NOW);
    const epic = s.beads.find((b) => b.id === "e1");
    expect(epic?.labels.filter((l) => l.startsWith(SWEEP_RESTART_PREFIX))).toHaveLength(1);
  });

  it("stamps the marker BEFORE handing over, so a failed handoff cannot loop", async () => {
    // Ordering is the safety property: a handoff that succeeded while the stamp failed is exactly
    // the un-bounded state the marker exists to prevent. Stamping first can at worst cost the epic
    // one restart it was owed; stamping last can cost an agent every tick, forever.
    const s = scenario({ restartEnabled: true });
    s.restart.mockImplementation(() => {
      throw new Error("boom");
    });
    await s.run(NOW);
    const epic = s.beads.find((b) => b.id === "e1");
    expect(epic?.labels.some((l) => l.startsWith(SWEEP_RESTART_PREFIX))).toBe(true);
  });
});

// ── "TELL YOU" IS HALF THE REQUIREMENT ─────────────────────────────────────────────────────────
// `notifyConcierge` returns false when the text was DROPPED — no sink in this window, a sink
// refusing at its ceiling, a throwing one. Its own header records why that distinction exists:
// treating "a sink exists" as "the message was delivered" is what made findings die silently.
// Ignoring it here would mean the sweep restarts an agent, tells nobody, and reports success — the
// same shape three review rounds found elsewhere in this file.
describe("sweepEpics — a dropped notice is not a delivered one", () => {
  it("records that the founder was NOT told, rather than reporting a clean restart", async () => {
    const s = scenario({ restartEnabled: true });
    s.notify.mockReturnValue(false);
    const out = await s.run();
    const o = out.find((x) => x.epicId === "e1");
    // The restart really did happen, so it is still reported as such...
    expect(o?.performed).toBe("restarted");
    // ...but the half of the requirement that did NOT happen is not claimed.
    expect(o?.noticed).toBe(false);
  });

  it("records a delivered notice as delivered", async () => {
    const s = scenario({ restartEnabled: true });
    const out = await s.run();
    expect(out.find((x) => x.epicId === "e1")?.noticed).toBe(true);
  });

  it("does the same for a dropped ESCALATION notice", async () => {
    // Less bad — the label DID land, so the epic is in the Blocked lane where he looks. Still two
    // different facts, and only one of them is proven.
    const s = scenario({ beads: markedBeads(NOW - 60_000) });
    s.notify.mockReturnValue(false);
    const out = await s.run();
    const o = out.find((x) => x.epicId === "e1");
    expect(o?.performed).toBe("escalated");
    expect(o?.noticed).toBe(false);
  });

  it("claims no notice at all on a path that owes none", async () => {
    // `clear` is silent by design — taking a stale mark off is not news. It needs an epic that is
    // ACTUALLY escalated (carrying the stalled label, which is what `alreadyEscalated` reads) and
    // moving again; the restart marker alone is a different fact and does not reach this branch.
    const escalated = [
      bead({ id: "e1", title: "Ship the thing", type: "epic", labels: [STALLED_LABEL] }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
    ];
    const s = scenario({ beads: escalated, alive: () => true });
    const out = await s.run();
    const o = out.find((x) => x.epicId === "e1");
    expect(o?.performed).toBe("cleared");
    expect(o?.noticed).toBeUndefined();
    expect(s.notify).not.toHaveBeenCalled();
  });
});

describe("sweepEpics — the bounds that keep it from running away", () => {
  it("does not touch an epic the founder never promoted to Build", async () => {
    const s = scenario({ agents: [] });
    const out = await s.run();
    expect(out.find((o) => o.epicId === "e1")?.reason).toBe("not-watched");
    expect(s.restart).not.toHaveBeenCalled();
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("restarts at most one epic per sweep however many qualify", async () => {
    // The founder spent a session retiring twenty agents. A project that has been closed for a week
    // can cross the line on several epics at once, and starting all of them is a surprise, not a
    // recovery.
    const beads: Bead[] = [];
    const agents: AgentTab[] = [];
    for (const n of ["e1", "e2", "e3"]) {
      beads.push(bead({ id: n, type: "epic" }));
      beads.push(bead({ id: `${n}.1`, parent: n, updatedAt: iso(STALE) }));
      agents.push(buildAgent({ id: `a-${n}`, epicId: n, createdAt: STALE - 60_000 }));
    }
    const s = scenario({ beads, agents, restartEnabled: true });
    const out = await s.run();
    expect(s.restart).toHaveBeenCalledTimes(MAX_ACTIONS_PER_SWEEP);
    // ...and the ones it did NOT start are reported as capped, not as skipped — a sweep that
    // silently drops work cannot be told from one that decided against it.
    expect(out.filter((o) => o.note === "capped")).toHaveLength(2);
  });

  it("leaves an epic alone while a build agent is on it", async () => {
    const s = scenario({ alive: () => true });
    const out = await s.run();
    expect(out.find((o) => o.epicId === "e1")?.reason).toBe("orchestrator-alive");
    expect(s.restart).not.toHaveBeenCalled();
  });

  it("treats UNKNOWN liveness as alive rather than as dead", async () => {
    // A wrong "alive" costs one skipped tick. A wrong "dead" starts a rival orchestrator against an
    // epic somebody is already building.
    const s = scenario({ alive: () => undefined });
    const out = await s.run();
    expect(out.find((o) => o.epicId === "e1")?.reason).toBe("orchestrator-alive");
  });

  it("skips a project whose board has not loaded, rather than reading it as empty", async () => {
    // An unloaded board would make every epic look childless, i.e. `nothing-planned` — silence
    // dressed as a decision.
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: [] }],
      beadsFor: () => null,
      restart: vi.fn(),
      mark: vi.fn(async () => {}),
      notify: vi.fn(() => true),
    });
    expect(out).toEqual([]);
  });

  it("does nothing in a window that does not own the project", async () => {
    const s = scenario();
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => false,
      projects: [{ id: "p1", rootPath: "/proj", agents: [] }],
      beadsFor: () => s.beads,
      restart: s.restart,
      mark: s.mark,
      notify: s.notify,
    });
    expect(out).toEqual([]);
    expect(s.restart).not.toHaveBeenCalled();
  });
});

describe("sweepEpics — failures must not lie", () => {
  it("does not consume the epic's one restart when the fleet is at capacity", async () => {
    const s = scenario({ restartEnabled: true });
    s.restart.mockImplementation(() => {
      throw new Error("at capacity");
    });
    const out = await s.run();
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("none");
    // Nothing was handed over, so nothing is claimed to the founder either.
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("does not announce an escalation whose label write failed", async () => {
    // The sentence says "I moved it to Blocked". Sending it when the label never landed points the
    // founder at a lane the epic is not in.
    const s = scenario({ beads: markedBeads(NOW - 60_000) });
    s.mark.mockRejectedValue(new Error("bd is locked"));
    const out = await s.run();
    expect(out.find((o) => o.epicId === "e1")?.note).toBe("write-failed");
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("none");
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("never throws out of the sweep", async () => {
    const s = scenario({ restartEnabled: true });
    s.restart.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(s.run()).resolves.toBeInstanceOf(Array);
  });
});

describe("lastChildProgressAt", () => {
  it("takes the newest child timestamp", () => {
    const beads = [
      bead({ id: "e", type: "epic" }),
      bead({ id: "e.1", parent: "e", updatedAt: iso(1000) }),
      bead({ id: "e.2", parent: "e", updatedAt: iso(5000) }),
    ];
    expect(lastChildProgressAt(beads, "e")).toBe(5000);
  });

  it("IGNORES the epic's own timestamp", () => {
    // Load-bearing: escalating writes a label to the EPIC, bumping its updatedAt. If that counted,
    // the sweep's own escalation would reset the staleness clock it had just measured and the epic
    // would read as freshly active forever after.
    const beads = [
      bead({ id: "e", type: "epic", updatedAt: iso(NOW) }),
      bead({ id: "e.1", parent: "e", updatedAt: iso(1000) }),
    ];
    expect(lastChildProgressAt(beads, "e")).toBe(1000);
  });

  it("is null when no child carries a readable timestamp — not 0 and not now", () => {
    const beads = [bead({ id: "e", type: "epic" }), bead({ id: "e.1", parent: "e" })];
    expect(lastChildProgressAt(beads, "e")).toBeNull();
  });

  it("falls back to createdAt when a child has no updatedAt", () => {
    const beads = [
      bead({ id: "e", type: "epic" }),
      bead({ id: "e.1", parent: "e", createdAt: iso(2000) }),
    ];
    expect(lastChildProgressAt(beads, "e")).toBe(2000);
  });
});

describe("candidateFor", () => {
  const beads = [
    bead({ id: "e", type: "epic" }),
    bead({ id: "e.1", parent: "e", updatedAt: iso(STALE) }),
  ];

  it("is unpromoted when no build agent was ever bound to the epic", () => {
    const c = candidateFor(beads, [buildAgent({ id: "a", epicId: "other" })], beads[0]!, () => false);
    expect(c.promoted).toBe(false);
  });

  it("is promoted on the strength of the BINDING, with no timestamp needed", () => {
    // The watch gate asks a yes/no question. It used to be derived from the bound agent's createdAt,
    // which conflated it with the restart budget — and that conflation was the bug: `sendToBuild`
    // reuses the bound agent, so the timestamp never advanced and the budget never ran out.
    const c = candidateFor(beads, [buildAgent({ id: "a", epicId: "e" })], beads[0]!, () => false);
    expect(c.promoted).toBe(true);
    expect(c.lastSweepRestartAt).toBeNull();
  });

  it("reads the sweep's own restart marker off the epic's labels", () => {
    const marked = [
      bead({ id: "e", type: "epic", labels: [`${SWEEP_RESTART_PREFIX}4242`] }),
      beads[1]!,
    ];
    const agents = [buildAgent({ id: "a", epicId: "e" })];
    expect(candidateFor(marked, agents, marked[0]!, () => false).lastSweepRestartAt).toBe(4242);
  });

  it("reads the stalled label as an existing escalation", () => {
    const marked = [bead({ id: "e", type: "epic", labels: [STALLED_LABEL] }), beads[1]!];
    expect(candidateFor(marked, [], marked[0]!, () => false).alreadyEscalated).toBe(true);
  });

  // ── THE REGRESSION THAT WOULD HAVE CAUGHT THE INERT SWEEP ────────────────────────────────────
  // Measured on the founder's live store: 39 epics, 28 persisted build agents, NOT ONE carrying an
  // `epicId` — so `promoted` was false for every epic, `decideEpicSweep` answered `not-watched` on
  // its first check every tick, and the sweep could not act on anything from v0.114.0 onward. The
  // whole suite was green throughout, because every case handed `candidateFor` an agent list with
  // the binding already in it. THE EMPTY AGENT LIST IS THE POINT: it is the production shape.
  it("stays watched with NO agent bound, on the strength of the durable label", () => {
    const promoted = [bead({ id: "e", type: "epic", labels: [PROMOTED_LABEL] }), beads[1]!];
    expect(candidateFor(promoted, [], promoted[0]!, () => false).promoted).toBe(true);
  });

  it("is NOT watched with no agent and no label — the label is doing the work, not the empty list", () => {
    // The paired negative. Without it the assertion above passes for a `promoted` hard-wired to
    // true, which would put the sweep on every epic in the store including the thousands of
    // label-only retro beads the watch gate exists to keep it away from.
    expect(candidateFor(beads, [], beads[0]!, () => false).promoted).toBe(false);
  });

  it("reads the founder's opt-out label as a veto", () => {
    const vetoed = [
      bead({ id: "e", type: "epic", labels: [PROMOTED_LABEL, NO_AUTO_RESTART_LABEL] }),
      beads[1]!,
    ];
    const c = candidateFor(vetoed, [], vetoed[0]!, () => false);
    expect(c.promoted).toBe(true); // still watched…
    expect(c.optedOut).toBe(true); // …but vetoed, which is what stops it
  });

  it("leaves optedOut false when the epic carries the sweep's OWN stand-in marker", () => {
    // `SWEEP_NO_AUTO_LABEL` is the sweep's bookkeeping, not the founder's veto, and the two are one
    // easy substitution apart. Wiring the opt-out onto it would let the sweep silently cancel the
    // epic it had just deferred.
    const standIn = [
      bead({ id: "e", type: "epic", labels: [PROMOTED_LABEL, SWEEP_NO_AUTO_LABEL] }),
      beads[1]!,
    ];
    expect(candidateFor(standIn, [], standIn[0]!, () => false).optedOut).toBe(false);
  });
});

describe("the messages", () => {
  const epic = bead({ id: "e1", title: "Ship the thing" });
  it("name the epic so the founder knows which one", () => {
    expect(restartMessage(epic)).toContain("e1");
    expect(restartMessage(epic)).toContain("Ship the thing");
    expect(escalateMessage(epic, true)).toContain("e1");
  });
  it("say that the escalation has STOPPED retrying, not merely that something is slow", () => {
    // An escalation that reads like a status update gets treated as one.
    expect(escalateMessage(epic, true)).toMatch(/stopped retrying/i);
  });

  // While RESTART_ENABLED is false this is EVERY escalation, so a message that claimed a restart
  // would make every notice a false statement to the person deciding what to do about the epic.
  it("never claim a restart that was not spent", () => {
    expect(escalateMessage(epic, false)).not.toMatch(/I restarted it/i);
    expect(escalateMessage(epic, false)).toMatch(/do not restart epics on my own yet/i);
    expect(escalateMessage(epic, false)).toContain("e1");
  });
  // REMEDY COPY IS AN INSTRUCTION THE READER WILL FOLLOW, so it is audited like a branch rather
  // than proofread like prose. Two drafts have already been wrong here:
  //   1. "the next time it stalls I will ask you instead" — false; the sweep went silent instead.
  //   2. "close that agent" — true of the ROSTER-derived watch gate, and made false by the durable
  //      one (`beads.PROMOTED_LABEL`). This test failed when that landed, which is the test working:
  //      the sentence it pinned had become an instruction that silently does nothing.
  // It now pins the opt-out against the CONSTANT the engine actually vetoes on, so the copy and the
  // behaviour cannot drift apart again without this going red.
  it("offer an opt-out the code actually implements", () => {
    expect(restartMessage(epic)).toContain(NO_AUTO_RESTART_LABEL);
    expect(restartMessage(epic)).not.toMatch(/I will ask you/i);
    // The retired instruction must not survive anywhere in the sentence — telling him to close the
    // agent is now advice that leaves the sweep restarting the epic regardless.
    expect(restartMessage(epic)).not.toMatch(/close that agent/i);
  });

  // …and the copy's claim is only worth pinning if the ENGINE honours it. Asserting the sentence
  // alone would pass against a `NO_AUTO_RESTART_LABEL` nothing reads — the vacuous shape this repo
  // treats as the #1 fleet-wide finding. This ties the two together.
  it("names a label the engine actually vetoes on", () => {
    const vetoed = bead({
      id: "e1",
      type: "epic",
      labels: [PROMOTED_LABEL, NO_AUTO_RESTART_LABEL],
    });
    const kids = [bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) })];
    const c = candidateFor([vetoed, ...kids], [], vetoed, () => false);
    expect(restartMessage(epic)).toContain(NO_AUTO_RESTART_LABEL);
    expect(c.optedOut).toBe(true);
  });
});


// ── THE PRODUCTION SEAM, DRIVEN ────────────────────────────────────────────────────────────────
// Every other case here injects `restart`, so the real default was reachable by nothing. These run
// the sweep WITHOUT that injection.
describe("sweepEpics — the real handoff seam", () => {
  it("hands off without taking the view, and never as human-authored", () => {
    // reveal:false is what stops a ten-minute timer yanking the founder off what he is reading;
    // humanAuthored:false is what stops a machine handoff un-latching an escalated orchestrator's
    // goal debt as a side effect. Both are properties of the DEFAULT, so only this test can see them.
    const beads = [
      bead({ id: "e1", title: "Ship the thing", type: "epic" }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
    ];
    const agents = [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })];
    sendToBuildMock.mockClear();
    return sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents }],
      beadsFor: () => beads,
      aliveFor: () => false,
      restartEnabled: true,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify: vi.fn(() => true),
    }).then(() => {
      expect(sendToBuildMock).toHaveBeenCalledTimes(1);
      expect(sendToBuildMock.mock.calls[0]?.[0]).toMatchObject({
        projectId: "p1",
        epicId: "e1",
        mode: "epic",
        reveal: false,
        humanAuthored: false,
      });
    });
  });

  it("says NOTHING to the founder when the handoff could not relaunch anything", async () => {
    // The refusal `sendToBuild` throws when nothing can mount the agent. A notice here would tell
    // him "I restarted your epic" about a relaunch that did not happen — the exact defect three
    // review rounds each found a version of.
    const beads = [
      bead({ id: "e1", title: "Ship the thing", type: "epic" }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
    ];
    const agents = [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })];
    const notify = vi.fn((_t: string) => true);
    sendToBuildMock.mockImplementationOnce(() => {
      throw new MountRefusedError("nothing can mount agent-1");
    });
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents }],
      beadsFor: () => beads,
      aliveFor: () => false,
      restartEnabled: true,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify,
    });
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("none");
    expect(out.find((o) => o.epicId === "e1")?.note).toBe("spawn-failed");
    expect(notify).not.toHaveBeenCalled();
  });
});


// ── THE PRODUCTION NOTIFY SEAM, DRIVEN ─────────────────────────────────────────────────────────
// These omit `opts.notify` entirely, so the default really does run.
// ── THE AUDIT TRAIL ────────────────────────────────────────────────────────────────────────────
// The founder's requirement was "log what it restarted and why, so a human can audit it after the
// fact". A console line dies with the app session and the `sweep-restarted` label carries only an
// epoch, so the durable answer is a comment on the epic itself.
describe("sweepEpics — the restart is recorded where a human will find it", () => {
  const stalled = () => ({
    beads: [
      bead({ id: "e1", title: "Ship the thing", type: "epic" }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
      bead({ id: "e1.2", parent: "e1", updatedAt: iso(STALE) }),
    ],
    agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })],
  });

  it("writes a note onto the epic naming why, what moved, and that the budget is spent", async () => {
    const p = stalled();
    const audit = vi.fn(async () => {});
    await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: p.agents }],
      beadsFor: () => p.beads,
      aliveFor: () => false,
      restartEnabled: true,
      restart: vi.fn(async () => ({ agentId: "a1", verdict: "restarted" as const })),
      audit,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify: vi.fn(() => true),
    });
    expect(audit).toHaveBeenCalledTimes(1);
    const [projectPath, epicId, text] = audit.mock.calls[0] as unknown as [string, string, string];
    expect(projectPath).toBe("/proj");
    expect(epicId).toBe("e1");
    // The three facts the note exists to carry. Asserted on CONTENT, not on "audit was called" —
    // a note that said nothing would satisfy the call count and none of the requirement.
    expect(text).toContain("2 filed"); // the children it counted
    expect(text).toContain("a1"); // the orchestrator it relaunched
    expect(text).toMatch(/ONE automatic restart is now spent/);
    expect(text).toMatch(/\d+h/); // how long it had been idle
  });

  it("does NOT write a note when no restart happened", async () => {
    // The note claims a restart. An escalation that produced one would be a false record, and the
    // record is the thing a human trusts when the chat notice has long scrolled away.
    const p = stalled();
    const audit = vi.fn(async () => {});
    await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: p.agents }],
      beadsFor: () => p.beads,
      aliveFor: () => false,
      restartEnabled: true,
      canNotify: () => false, // refuses the restart with `cannot-notify`
      restart: vi.fn(async () => ({ agentId: "a1", verdict: "restarted" as const })),
      audit,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify: vi.fn(() => true),
    });
    expect(audit).not.toHaveBeenCalled();
  });

  it("still reports the restart when the note cannot be written", async () => {
    // The beads store is single-writer and shared by every worktree, so a `bd comment` can simply be
    // locked. By the time it runs the restart has ALREADY happened and is irreversible — turning a
    // real handoff into a reported failure over a failed note would spend the epic's budget and then
    // tell the founder nothing was done.
    const p = stalled();
    const notify = vi.fn((_t: string) => true);
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: p.agents }],
      beadsFor: () => p.beads,
      aliveFor: () => false,
      restartEnabled: true,
      restart: vi.fn(async () => ({ agentId: "a1", verdict: "restarted" as const })),
      audit: vi.fn(async () => {
        throw new Error("locked by another dolt process");
      }),
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify,
    });
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("restarted");
    expect(notify).toHaveBeenCalled();
  });
});

// ── THE AUDIT NOTE SURVIVES A TRANSIENT LOCK ───────────────────────────────────────────────────
// The store is single-writer and shared by every worktree, so a `bd comment` frequently loses the
// race and bd rejects with a lock phrase. A SINGLE attempt dropped ~15 notes/day — the durable
// record the founder is meant to read next week. The write is now retried a bounded few times on a
// transient lock, without changing the best-effort contract: a persistently locked store still ends
// in log.warn + continue, never a thrown error or a failed restart.
describe("sweepEpics — the audit note is retried through a transient store lock", () => {
  const stalled = () => ({
    beads: [
      bead({ id: "e1", title: "Ship the thing", type: "epic" }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
      bead({ id: "e1.2", parent: "e1", updatedAt: iso(STALE) }),
    ],
    agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })],
  });

  const sweepWithAudit = async (
    audit: ReturnType<typeof vi.fn>,
    over: { auditAttempts?: number; notify?: ReturnType<typeof vi.fn> } = {},
  ) => {
    const p = stalled();
    const notify = over.notify ?? vi.fn((_t: string) => true);
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: p.agents }],
      beadsFor: () => p.beads,
      aliveFor: () => false,
      restartEnabled: true,
      restart: vi.fn(async () => ({ agentId: "a1", verdict: "restarted" as const })),
      audit,
      auditAttempts: over.auditAttempts ?? 3,
      auditBackoffMs: 0, // no real timers — the retry is what's under test, not the delay
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify,
    });
    return { out, notify };
  };

  it("re-issues the write until it lands, so the note is actually WRITTEN", async () => {
    // Locked for the first two tries, clear on the third. The side effect that matters is that the
    // note ends up written — asserted on the CONTENT of the attempt that succeeded, not on a call
    // count alone, so a version that reported success while writing nothing would fail here.
    let calls = 0;
    const audit = vi.fn(async (_pp: string, _id: string, _text: string) => {
      calls += 1;
      if (calls < 3) throw new Error("locked by another dolt process");
    });
    const { out, notify } = await sweepWithAudit(audit, { auditAttempts: 3 });

    expect(audit).toHaveBeenCalledTimes(3); // it retried the transient lock
    // The LAST (successful) attempt carried the real note — the durable write happened.
    const text = (audit.mock.calls[2] as unknown as [string, string, string])[2];
    expect(text).toContain("a1"); // the orchestrator it relaunched
    expect(text).toMatch(/ONE automatic restart is now spent/);
    // A brief lock is not a failure: the restart is still reported and the founder still notified.
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("restarted");
    expect(notify).toHaveBeenCalled();
  });

  it("gives up after a BOUNDED number of attempts and still reports the restart", async () => {
    // A permanently locked store must not wedge the sweep, and must not undo an irreversible
    // restart. Assert the bound is hard (exactly `auditAttempts` calls — never unbounded) and the
    // restart is still counted with the notice delivered.
    const audit = vi.fn(async () => {
      throw new Error("locked by another dolt process");
    });
    const { out, notify } = await sweepWithAudit(audit, { auditAttempts: 3 });

    expect(audit).toHaveBeenCalledTimes(3); // the bound held — not a 4th, not an unbounded spin
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("restarted");
    expect(notify).toHaveBeenCalled();
  });

  it("does NOT retry a NON-lock error — a wait cannot fix a malformed write", async () => {
    // Only a transient lock is retried. A structural error (bad id, bd missing) will never clear by
    // waiting, so spinning on it would only stall the fleet — one attempt, then give up.
    const audit = vi.fn(async () => {
      throw new Error("invalid bead id: not found");
    });
    const { out, notify } = await sweepWithAudit(audit, { auditAttempts: 3 });

    expect(audit).toHaveBeenCalledTimes(1); // classified non-transient → no retry
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("restarted");
    expect(notify).toHaveBeenCalled();
  });
});

// ── THE FALSE CLAIM, RELOCATED ─────────────────────────────────────────────────────────────────
// Fixing the mount layer so it stops reporting relaunches that did not happen moved the problem up
// here: `already-live` is a real handoff (the epic WAS handed back) but not a restart, and both the
// notice and the durable audit note used to call it one.
describe("sweepEpics — an orchestrator that was already running is not called a restart", () => {
  const stalled = () => ({
    beads: [
      bead({ id: "e1", title: "Ship the thing", type: "epic" }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
    ],
    agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })],
  });

  const sweepWith = async (verdict: "restarted" | "already-live") => {
    const p = stalled();
    const notify = vi.fn((_t: string) => true);
    const audit = vi.fn(async () => {});
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: p.agents }],
      beadsFor: () => p.beads,
      aliveFor: () => false,
      restartEnabled: true,
      restart: vi.fn(async () => ({ agentId: "a1", verdict })),
      audit,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify,
    });
    return { out, notify, audit };
  };

  it("tells the founder it HANDED IT BACK, never that it restarted it", async () => {
    const { out, notify } = await sweepWith("already-live");
    const o = out.find((x) => x.epicId === "e1");
    expect(o?.performed).toBe("restarted"); // the epic WAS handed back — the budget is spent
    expect(o?.relaunched).toBe(false); // …but nothing was relaunched
    const text = notify.mock.calls[0]?.[0] ?? "";
    expect(text).not.toMatch(/I restarted/i);
    expect(text).toMatch(/already running/i);
    // THE WHOLE OPENING CLAUSE, not just a keyword. A keyword assertion is green against garbled
    // prose — an earlier cut factored out a shared fragment ending in a full stop and produced
    // "I handed **e1 — Ship the thing**. Its plan was written…", a sentence with no object, which
    // passed a `/already running/` check perfectly well. This is copy the founder reads to decide
    // what to do, so the test reads it the way he would.
    expect(text).toMatch(/^I handed \*\*e1 — Ship the thing\*\* back to its orchestrator\./);
  });

  it("does not write `relaunched` into the DURABLE record either", async () => {
    // The note outlives the notice, so a false word here is the one that survives.
    const { audit } = await sweepWith("already-live");
    const text = (audit.mock.calls[0] as unknown as [string, string, string])[2];
    expect(text).toContain("ALREADY RUNNING");
    expect(text).not.toMatch(/relaunched orchestrator/);
  });

  it("STILL says restarted when it really did restart one", async () => {
    // The paired positive. Without it, both assertions above are satisfied by prose that never
    // claims a restart under any circumstances — which would be its own kind of lie.
    const { out, notify, audit } = await sweepWith("restarted");
    expect(out.find((x) => x.epicId === "e1")?.relaunched).toBe(true);
    expect(notify.mock.calls[0]?.[0] ?? "").toMatch(
      /^I restarted \*\*e1 — Ship the thing\*\*\. Its plan was written/,
    );
    expect((audit.mock.calls[0] as unknown as [string, string, string])[2]).toContain(
      "relaunched orchestrator",
    );
  });
});

describe("auditNote", () => {
  const beads = [
    bead({ id: "e1", title: "Ship the thing", type: "epic" }),
    bead({ id: "e1.1", parent: "e1", updatedAt: iso(NOW - 71 * 60 * 60 * 1000) }),
  ];

  it("reports the idle time actually measured, not a fixed phrase", () => {
    // Pinned against a REAL number so the note cannot drift into boilerplate that says "a while".
    const text = auditNote(beads[0]!, "agent-x", NOW, beads);
    expect(text).toContain("71h");
    expect(text).toContain("1 filed");
    expect(text).toContain("agent-x");
  });

  it("does not claim an idle time when no child carries a timestamp", () => {
    // `null` and `0` are opposite facts: "nothing has ever moved" versus "something just moved".
    // Formatting the first as `0h` would state, in the durable record, the exact opposite of what
    // was observed.
    const noTs = [
      bead({ id: "e2", type: "epic" }),
      { ...bead({ id: "e2.1", parent: "e2" }), updatedAt: undefined, createdAt: undefined },
    ];
    const text = auditNote(noTs[0]!, "agent-y", NOW, noTs);
    expect(text).not.toMatch(/\d+h/);
    expect(text).toContain("none carries a timestamp");
  });
});

describe("sweepEpics — the real notify seam", () => {
  const stalledProject = () => {
    const beads = [
      bead({ id: "e1", title: "Ship the thing", type: "epic" }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
    ];
    return {
      beads,
      agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })],
    };
  };
  const runReal = (p: ReturnType<typeof stalledProject>) =>
    sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: p.agents }],
      beadsFor: () => p.beads,
      aliveFor: () => false,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      // notify DELIBERATELY omitted — that is the whole point of this block.
    });

  it("reports NOT-noticed when the real notifier says the text was dropped", async () => {
    notifyConciergeMock.mockReturnValue(false);
    const out = await runReal(stalledProject());
    expect(out.find((o) => o.epicId === "e1")?.noticed).toBe(false);
  });

  it("reports noticed when the real notifier says it was delivered", async () => {
    notifyConciergeMock.mockReturnValue(true);
    const out = await runReal(stalledProject());
    expect(out.find((o) => o.epicId === "e1")?.noticed).toBe(true);
  });

  it("actually calls notifyConcierge, rather than something shaped like it", async () => {
    notifyConciergeMock.mockClear();
    notifyConciergeMock.mockReturnValue(true);
    await runReal(stalledProject());
    expect(notifyConciergeMock).toHaveBeenCalledTimes(1);
    expect(notifyConciergeMock.mock.calls[0]?.[0]).toContain("e1");
  });
});

// ── A WINDOW THAT CAN NEVER TELL HIM MUST NOT SPEND THE BUDGET ─────────────────────────────────
// A satellite window renders no ConciergeHost, so its `sink` is null for the window's whole life —
// and `routeToOwningWindow` hands a torn-out project's ownership TO that satellite, so no window
// that COULD notify will ever sweep it. Restarting there burns an agent slot and the epic's
// one-shot budget with the founder never told, ever.
describe("sweepEpics — will not spend what it cannot report", () => {
  it("skips the restart when no notice can reach the founder from this window", async () => {
    const s = scenario({ restartEnabled: true });
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })] }],
      beadsFor: () => s.beads,
      aliveFor: () => false,
      restartEnabled: true,
      canNotify: () => false,
      restart: s.restart,
      mark: s.mark,
      setLabel: s.setLabel,
      notify: s.notify,
    });
    expect(out.find((o) => o.epicId === "e1")?.note).toBe("cannot-notify");
    expect(s.restart).not.toHaveBeenCalled();
    // ...and THE BUDGET was not spent, so the epic stays fully eligible for a window that can
    // report. Asserted against the restart marker specifically rather than "no label was written
    // at all": the watch-marker self-heal also writes here, and it is deliberately unconditional —
    // it starts nothing and tells nobody, so an un-notifiable window is exactly as entitled to
    // repair a lost marker as any other. The subject of this test is the BUDGET.
    const stamped = s.setLabel.mock.calls.map((c) => c[3]);
    expect(stamped.some((l) => String(l).startsWith(SWEEP_RESTART_PREFIX))).toBe(false);
    expect(stamped).not.toContain(STALLED_LABEL);
  });

  it("still ESCALATES from such a window — the label is the durable signal, not the notice", async () => {
    const s = scenario({ beads: markedBeads(NOW - 60_000) });
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })] }],
      beadsFor: () => s.beads,
      aliveFor: () => false,
      canNotify: () => false,
      restart: s.restart,
      mark: s.mark,
      setLabel: s.setLabel,
      notify: s.notify,
    });
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("escalated");
    expect(s.mark).toHaveBeenCalledWith("/proj", "add", "e1");
  });
});


// ── THE SHIPPED CONFIGURATION ──────────────────────────────────────────────────────────────────
// Everything above injects `restartEnabled`, so the production default — `opts.restartEnabled ??
// RESTART_ENABLED` — ran in no test at all. That matters more here than anywhere else in the file,
// because the whole subject of this change is that one constant: wiring the option to the wrong
// value type-checks cleanly and leaves the entire suite green while shipping the un-wired restart.
describe("sweepEpics — the shipped configuration, with nothing injected", () => {
  const stalledProject = () => ({
    beads: [
      bead({ id: "e1", title: "Ship the thing", type: "epic" }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
    ],
    agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })],
  });

  it("pins the flag itself, rather than implying it", () => {
    // INVERTED by bead sparkle-7d3985, and pinned rather than implied for the same reason it was
    // pinned when it was false: this one constant IS the feature, and a change to it that no test
    // names would be indistinguishable from an accident.
    expect(RESTART_ENABLED).toBe(true);
  });

  it("decides restart and PERFORMS one, handing the epic back", async () => {
    // THE SHIPPED DEFAULT, with `restartEnabled` deliberately omitted so `?? RESTART_ENABLED` runs.
    // Before the flag flipped, this asserted the exact opposite — an escalation with `restart` never
    // called. Keeping the shape and inverting the expectation is what makes the flip visible here
    // rather than merely consistent with itself.
    const p = stalledProject();
    const restart = vi.fn(async (_a: string, _b: string) => ({ agentId: "x", verdict: "restarted" as const }));
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: p.agents }],
      beadsFor: () => p.beads,
      aliveFor: () => false,
      // restartEnabled DELIBERATELY omitted — that is the seam under test.
      restart,
      audit: vi.fn(async () => {}),
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify: vi.fn(() => true),
    });
    const o = out.find((x) => x.epicId === "e1");
    expect(o?.action).toBe("restart");
    expect(o?.performed).toBe("restarted");
    expect(restart).toHaveBeenCalledWith("p1", "e1");
  });

  it("BOUNDS the escalations too — one epic per tick, not all of them", async () => {
    // REGRESSION. The cap used to live inside the restart branch, so with the restart gated off it
    // governed nothing: the first production tick would label every in-window stalled epic and fire
    // a notice for each, all at once. The 14-day reach cap does not help — it only shaves the tail.
    const beads: Bead[] = [];
    const agents: AgentTab[] = [];
    for (const n of ["e1", "e2", "e3"]) {
      beads.push(bead({ id: n, type: "epic" }));
      beads.push(bead({ id: `${n}.1`, parent: n, updatedAt: iso(STALE) }));
      agents.push(buildAgent({ id: `a-${n}`, epicId: n, createdAt: STALE - 60_000 }));
    }
    const notify = vi.fn((_t: string) => true);
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents }],
      beadsFor: () => beads,
      aliveFor: () => false,
      // restartEnabled EXPLICIT now. It used to be omitted, because `false` was the shipped
      // default; since bead sparkle-7d3985 the default is `true`, so leaning on it here would test
      // the opposite of what this case is about. The OFF path is still reachable in production —
      // someone can flip the constant back — so it keeps its own coverage.
      restartEnabled: false,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify,
    });
    expect(out.filter((o) => o.performed === "escalated")).toHaveLength(MAX_ACTIONS_PER_SWEEP);
    expect(out.filter((o) => o.note === "capped")).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(MAX_ACTIONS_PER_SWEEP);
  });

  it("marks a STAND-IN escalation so the owed restart is not burned forever", async () => {
    // THE ONE THAT MAKES THE FLAG FLIPPABLE. `alreadyEscalated` (STALLED_LABEL) is terminal for the
    // engine, so without a second marker every epic stalling while the restart is off would consume
    // the restart it never received — and turning the feature on later could help none of them.
    const p = stalledProject();
    const written: string[] = [];
    await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: p.agents }],
      beadsFor: () => p.beads,
      aliveFor: () => false,
      restartEnabled: false, // the OFF path is this case's subject; the default is now `true`
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async (_p: string, a: "add" | "remove", _i: string, l: string) => {
        if (a === "add") written.push(l);
      }),
      notify: vi.fn(() => true),
    });
    expect(written).toContain(SWEEP_NO_AUTO_LABEL);
  });

  it("...and an epic carrying that marker is still OWED its restart", async () => {
    // The engine must not read a stand-in as a spent budget: the decision stays `restart`.
    const beads = [
      bead({
        id: "e1",
        title: "Ship the thing",
        type: "epic",
        labels: [STALLED_LABEL, SWEEP_NO_AUTO_LABEL],
      }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
    ];
    const agents = [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })];
    const restart = vi.fn(async (_a: string, _b: string) => ({ agentId: "x", verdict: "restarted" as const }));
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents }],
      beadsFor: () => beads,
      aliveFor: () => false,
      restartEnabled: true, // explicit: this case is about the ON path specifically
      restart,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify: vi.fn(() => true),
    });
    // TWO STEPS, deliberately: this tick RETRACTS the stand-in (both labels off), and the next one
    // sees a clean epic and decides `restart`. One sweep of latency, and no engine change.
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("cleared");
    expect(restart).not.toHaveBeenCalled();
  });

  it("never tells the founder it restarted something on the gated path", async () => {
    const p = stalledProject();
    const notify = vi.fn((_t: string) => true);
    await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: p.agents }],
      beadsFor: () => p.beads,
      aliveFor: () => false,
      restartEnabled: false, // the OFF path is this case's subject; the default is now `true`
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify,
    });
    expect(notify.mock.calls[0]?.[0]).not.toMatch(/I restarted it/i);
  });

  // ROUNDS 7-8 (roborev 65117, then 65126 on the fix for it) — a comment-only commit replaced a
  // stale claim with a WRONG one: that once the flag ships `true`, "both wordings occur". It is the
  // opposite. The engine escalates only on `lastSweepRestartAt > lastChildProgressAt`, which is
  // exactly the predicate the runner recomputes as `afterRestart`, and the degrade branch that
  // could escalate WITHOUT a spent restart requires the flag OFF. So with the flag on,
  // `afterRestart` is necessarily true and the no-restart wording is unreachable.
  //
  // FOUR cases, and the count kept growing because each round's table named the wrong mechanism.
  // What actually selects the wording is the SPENT test — `spent > progressed`, i.e. the sweep
  // restarted this epic MORE RECENTLY than anything moved on it. `standIn` does not select it; what
  // `standIn` does is make an escalation OCCUR AT ALL for an epic the engine wanted to restart.
  //
  //   marker  | recency          | flag | wording        | why
  //   --------|------------------|------|----------------|------------------------------------
  //   spent   | newer than work  | ON   | "restarted"    | engine's own escalate branch
  //   spent   | newer than work  | OFF  | "restarted"    | same branch — the flag is not the cause
  //   spent   | OLDER than work  | OFF  | "no restart"   | engine wants `restart`; standIn degrades
  //   none    | —                | OFF  | "no restart"   | engine wants `restart`; standIn degrades
  //
  // The third row is the one that distinguishes "a marker exists" from "a restart was spent", and
  // it is the row that matters most: without it the sweep could tell the founder "I restarted it
  // once" about a NEW stall nothing was ever handed back for. Both `false` rows need the flag OFF,
  // which is why the `false` arm is unreachable in the shipped configuration.
  //
  // WHY NEITHER TERM OF `afterRestart` IS INDIVIDUALLY FALSIFIABLE, measured rather than argued.
  // `afterRestart` is `spent > progressed && !standIn`, and those two COINCIDE on every reachable
  // state, so each masks the other:
  //   • drop `&& !standIn`      -> 67/67 still green (the comparison covers it)
  //   • weaken `spent > progressed` to `spent !== null` -> 67/67 still green (standIn covers it)
  //   • drop BOTH               -> RED, and only on the third row above
  // The proof of the coincidence: `escalate` has exactly two producers. The engine's own branch
  // requires `lastSweepRestartAt > lastChildProgressAt` (so `spent > progressed`, so `standIn` is
  // false); the degrade branch requires the engine to have wanted `restart` (so NOT
  // `spent > progressed`, and `standIn` true). There is no third producer.
  //
  // So do NOT read a green mutation of either term as "this term is dead code". The conjunction is
  // deliberately belt-and-braces: it is redundant today and fails CLOSED — no false "I restarted it
  // once" — if a future engine change ever breaks the coincidence. The third row is what keeps the
  // conjunction falsifiable at all, which is the whole reason it earns its place.
  it("uses the RESTARTED wording for every escalation once the flag is on", async () => {
    // The one escalation shape reachable with the flag ON: the marker is newer than child progress,
    // so this epic's single restart was spent and bought nothing.
    const notify = vi.fn((_t: string) => true);
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })] }],
      beadsFor: () => markedBeads(NOW - 1_000),
      aliveFor: () => false,
      restartEnabled: true,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify,
    });
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("escalated");
    // The SIDE EFFECT — which sentence the founder actually receives — not merely that we escalated.
    expect(notify.mock.calls[0]?.[0]).toMatch(/I restarted it once/i);
    expect(notify.mock.calls[0]?.[0]).not.toMatch(/do not restart epics on my own yet/i);
  });

  // THE MARKER SELECTS THE WORDING, NOT THE FLAG — this case is what proves it, and it is the case
  // the first version of this pair was missing (roborev 65126). Same MARKED fixture as the test
  // above, flag flipped OFF: the engine still takes its own escalate branch (the marker is newer
  // than child progress), so `standIn` is false and the founder still gets "I restarted it once".
  // Without this case the pair varied the marker AND the flag at once, so it could not support any
  // claim about which one drives the wording.
  it("keeps the RESTARTED wording with the flag OFF when a restart was genuinely spent", async () => {
    const notify = vi.fn((_t: string) => true);
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })] }],
      beadsFor: () => markedBeads(NOW - 1_000),
      aliveFor: () => false,
      restartEnabled: false,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify,
    });
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("escalated");
    expect(notify.mock.calls[0]?.[0]).toMatch(/I restarted it once/i);
  });

  it("says NO RESTART when the marker is OLDER than the work — a marker is not a spent restart", async () => {
    // THE ROW THAT PINS THE RECENCY COMPARISON. Marker at STALE - 60s, children at STALE, so a
    // restart WAS handed back once but work happened after it and the epic has since stalled AGAIN.
    // Nothing was handed back for THIS stall, so "I restarted it once" would be a false sentence
    // about a new stall — the exact thing the two-wording split exists to prevent.
    //
    // Reachable only with the flag OFF: with it ON the engine's `restart` decision is performed
    // rather than degraded, so no escalation notice is produced to inspect.
    const notify = vi.fn((_t: string) => true);
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })] }],
      beadsFor: () => markedBeads(STALE - 60_000),
      aliveFor: () => false,
      restartEnabled: false,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify,
    });
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("escalated");
    expect(notify.mock.calls[0]?.[0]).toMatch(/do not restart epics on my own yet/i);
    expect(notify.mock.calls[0]?.[0]).not.toMatch(/I restarted it once/i);
  });

  it("reaches the no-restart wording ONLY through the gated degrade branch", async () => {
    // NO marker at all, so the spent test fails on `spent === null`. The engine wants to `restart`
    // and the flag degrades that to an escalation, which is what makes this epic produce a notice
    // at all — but the WORDING is chosen by the spent test, not by the degrade.
    const notify = vi.fn((_t: string) => true);
    await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [{ id: "p1", rootPath: "/proj", agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })] }],
      beadsFor: () => [
        bead({ id: "e1", title: "Ship the thing", type: "epic" }),
        bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
      ],
      aliveFor: () => false,
      restartEnabled: false,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify,
    });
    expect(notify.mock.calls[0]?.[0]).toMatch(/do not restart epics on my own yet/i);
  });
});


// ── THE GATED PATH MUST TERMINATE TOO ──────────────────────────────────────────────────────────
// Round 6 found that the stand-in marker, routed through `alreadyEscalated`, made the gated
// escalation NON-terminal — the epic read as un-escalated next tick, was decided `restart` again,
// converted to `escalate` again, and re-marked and re-notified every ten minutes forever. Nothing
// caught it because no test drove a SECOND tick on the gated path, even though `scenario()`'s
// setLabel mutates the fixture precisely so a second run would see the first one's writes.
describe("sweepEpics — the gated escalation is terminal", () => {
  it("escalates once and then goes quiet, over many ticks", async () => {
    const s = scenario(); // the OFF path — scenario()'s default, no longer what ships
    const first = await s.run(NOW);
    expect(first.find((o) => o.epicId === "e1")?.performed).toBe("escalated");
    for (let i = 1; i < 8; i++) await s.run(NOW + i * EPIC_STALL_MS);
    // ONE notice, not eight. And the later ticks skip for the engine's own reason.
    expect(s.notify).toHaveBeenCalledTimes(1);
    const last = await s.run(NOW + 20 * EPIC_STALL_MS);
    expect(last.find((o) => o.epicId === "e1")?.reason).toBe("already-escalated");
  });

  it("CLEARS a stand-in-marked epic that recovers, removing both labels", async () => {
    // The other half of round 6: `clear` was unreachable for exactly these epics, so a recovered
    // one kept a false alarm in the Blocked lane permanently — the state the engine's own comment
    // calls worse than no escalation.
    const s = scenario();
    await s.run(NOW);
    const epic = () => s.beads.find((b) => b.id === "e1");
    expect(epic()?.labels).toContain(STALLED_LABEL);

    // ...an orchestrator picks it back up.
    const recovered = scenario({ beads: s.beads, alive: () => true });
    const out = await recovered.run(NOW + EPIC_STALL_MS);
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("cleared");
    expect(epic()?.labels).not.toContain(STALLED_LABEL);
    expect(epic()?.labels).not.toContain(SWEEP_NO_AUTO_LABEL);
  });

  it("RESETS a stand-in once the restart becomes available, so the owed restart is restored", async () => {
    // The stand-in is terminal while gated — which must not become permanent when the flag flips.
    const s = scenario();
    await s.run(NOW);
    expect(s.beads.find((b) => b.id === "e1")?.labels).toContain(SWEEP_NO_AUTO_LABEL);

    const enabled = scenario({ beads: s.beads, restartEnabled: true });
    const out = await enabled.run(NOW + EPIC_STALL_MS);
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("cleared");
    const after = s.beads.find((b) => b.id === "e1");
    expect(after?.labels).not.toContain(STALLED_LABEL);
    expect(after?.labels).not.toContain(SWEEP_NO_AUTO_LABEL);

    // ...and the NEXT tick sees a clean epic and decides restart, which is the point of resetting.
    const next = scenario({ beads: s.beads, restartEnabled: true });
    const out2 = await next.run(NOW + 2 * EPIC_STALL_MS);
    expect(out2.find((o) => o.epicId === "e1")?.action).toBe("restart");
    expect(next.restart).toHaveBeenCalledWith("p1", "e1");
  });

  it("does NOT cap a clear behind an escalation — a retraction spends nothing", async () => {
    // Round 6, third finding: hoisting the cap also capped `clear`, so a recovered epic's stale
    // mark waited behind whatever escalation was first in board order, reported as `capped` and
    // indistinguishable from a suppressed action. With one action per tick and several stalled
    // epics, that starves the cleanup indefinitely.
    // ORDER IS THE WHOLE TEST. The first version put the clear-owed epic FIRST, so it was processed
    // with `acted === 0` and passed the cap guard whether or not clears were exempt — deleting the
    // exemption left it green. That is the vacuous shape the repo guidance calls the #1 fleet-wide
    // finding. The stalled epic that consumes the tick's single action must come FIRST, so the
    // clear behind it is the thing under test.
    const beads = [
      // consumes the tick's one action…
      bead({ id: "e0", type: "epic" }),
      bead({ id: "e0.1", parent: "e0", updatedAt: iso(STALE) }),
      // …and THIS one, already marked and now moving again, must still be cleared behind it
      bead({ id: "e1", type: "epic", labels: [STALLED_LABEL] }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(NOW) }),
    ];
    const agents = [
      buildAgent({ id: "a0", epicId: "e0", createdAt: STALE - 60_000 }),
      buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 }),
    ];
    const s = scenario({ beads, agents });
    const out = await s.run(NOW);
    expect(out.find((o) => o.epicId === "e0")?.performed).toBe("escalated");
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("cleared");
    expect(out.find((o) => o.epicId === "e1")?.note).toBeUndefined();
  });

  it("leaves an OUT-OF-REACH marked epic exactly as it is when the flag flips", async () => {
    // The retraction must not erase the founder-facing signal for an epic the engine skipped for a
    // reason of its own. A `too-old` epic is still stalled — the ordering in decideEpicSweep exists
    // so its flag is KEPT — and un-marking it would drop it out of Blocked with nothing able to put
    // it back, since the next tick answers `too-old` with the mark gone.
    const ancient = NOW - 20 * 24 * 60 * 60 * 1000;
    const beads = [
      bead({ id: "e1", type: "epic", labels: [STALLED_LABEL, SWEEP_NO_AUTO_LABEL] }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(ancient) }),
    ];
    const s = scenario({ beads, restartEnabled: true });
    const out = await s.run(NOW);
    expect(out.find((o) => o.epicId === "e1")?.reason).toBe("too-old");
    expect(s.beads.find((b) => b.id === "e1")?.labels).toContain(STALLED_LABEL);
    expect(s.beads.find((b) => b.id === "e1")?.labels).toContain(SWEEP_NO_AUTO_LABEL);
  });

  it("retracts at most ONE stand-in per tick, matching the rate a restart can follow", async () => {
    // A genuine clear retracts a FALSE alarm and is rightly uncapped. A stand-in reset retracts a
    // TRUE one — the epic is still stalled — and the restart meant to follow is one per tick. Left
    // exempt, the tick after the flag flips would de-escalate the whole gated backlog at once while
    // the restarts trickle behind, leaving epics 2..N with no mark, no agent and `capped`: the
    // "clean and invisible" state, bounded in time rather than permanent, and worst exactly when a
    // large backlog makes the flip matter most.
    const beads: Bead[] = [];
    const agents: AgentTab[] = [];
    for (const n of ["e1", "e2", "e3"]) {
      beads.push(bead({ id: n, type: "epic", labels: [STALLED_LABEL, SWEEP_NO_AUTO_LABEL] }));
      beads.push(bead({ id: `${n}.1`, parent: n, updatedAt: iso(STALE) }));
      agents.push(buildAgent({ id: `a-${n}`, epicId: n, createdAt: STALE - 60_000 }));
    }
    const s = scenario({ beads, agents, restartEnabled: true });
    const out = await s.run(NOW);
    expect(out.filter((o) => o.performed === "cleared")).toHaveLength(MAX_ACTIONS_PER_SWEEP);
    expect(out.filter((o) => o.note === "capped")).toHaveLength(2);
    // ...and the ones not reset still carry BOTH labels, so they stay visible in Blocked.
    const untouched = beads.filter((b) => b.id !== "e1" && !b.id.includes("."));
    for (const b of untouched) {
      expect(b.labels).toContain(STALLED_LABEL);
      expect(b.labels).toContain(SWEEP_NO_AUTO_LABEL);
    }
  });

  it("still lets a GENUINE recovery clear past the cap", async () => {
    // The exemption must survive: a recovered epic's stale mark is a false alarm and must not wait
    // behind an escalation. Distinguishing the two kinds of clear is the whole point.
    const beads = [
      bead({ id: "e0", type: "epic" }),
      bead({ id: "e0.1", parent: "e0", updatedAt: iso(STALE) }),
      bead({ id: "e1", type: "epic", labels: [STALLED_LABEL] }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(NOW) }),
    ];
    const agents = [
      buildAgent({ id: "a0", epicId: "e0", createdAt: STALE - 60_000 }),
      buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 }),
    ];
    const s = scenario({ beads, agents });
    const out = await s.run(NOW);
    expect(out.find((o) => o.epicId === "e0")?.performed).toBe("escalated");
    expect(out.find((o) => o.epicId === "e1")?.performed).toBe("cleared");
  });

  it("does not retract a stand-in from a window that could never follow through", async () => {
    // The same destruction the previous round's High named, reached on a different axis. A window
    // that cannot notify refuses the restart — so retracting the mark there would strip both labels
    // and then refuse the restart forever after, leaving the epic clean and invisible: never
    // re-escalated (alreadyEscalated false) and never restarted (refused every tick) until it ages
    // out at 14 days. The mark is the durable signal that SURVIVED the un-notifiable window.
    const beads = [
      bead({ id: "e1", type: "epic", labels: [STALLED_LABEL, SWEEP_NO_AUTO_LABEL] }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
    ];
    const s = scenario({ beads, restartEnabled: true });
    const out = await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [
        { id: "p1", rootPath: "/proj", agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })] },
      ],
      beadsFor: () => beads,
      aliveFor: () => false,
      restartEnabled: true,
      canNotify: () => false,
      restart: s.restart,
      mark: s.mark,
      setLabel: s.setLabel,
      notify: s.notify,
    });
    expect(out.find((o) => o.epicId === "e1")?.performed).not.toBe("cleared");
    expect(beads.find((b) => b.id === "e1")?.labels).toContain(STALLED_LABEL);
    expect(beads.find((b) => b.id === "e1")?.labels).toContain(SWEEP_NO_AUTO_LABEL);
  });

  it("leaves an UNWATCHED marked epic alone too — closing the orchestrator is the opt-out", async () => {
    const beads = [
      bead({ id: "e1", type: "epic", labels: [STALLED_LABEL, SWEEP_NO_AUTO_LABEL] }),
      bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
    ];
    const s = scenario({ beads, agents: [], restartEnabled: true });
    const out = await s.run(NOW);
    expect(out.find((o) => o.epicId === "e1")?.reason).toBe("not-watched");
    expect(s.beads.find((b) => b.id === "e1")?.labels).toContain(STALLED_LABEL);
  });
});

describe("the mount", () => {
  it("is idempotent and tears down", () => {
    startEpicSweepRunner(60_000);
    startEpicSweepRunner(60_000);
    expect(isEpicSweepRunnerRunning()).toBe(true);
    stopEpicSweepRunner();
    expect(isEpicSweepRunnerRunning()).toBe(false);
    stopEpicSweepRunner(); // idempotent
    expect(isEpicSweepRunnerRunning()).toBe(false);
  });
});
