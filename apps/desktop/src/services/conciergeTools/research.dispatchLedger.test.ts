// THE DELEGATION LEDGER at `research:dispatch` (services/dispatchLedger).
//
// Research is BOTH halves of the 2026-08-22 incident: it is a delegation that must be remembered,
// and it is the act that goes wrong when the memory is missing — the concierge answered a question
// by dispatching fresh research into work it had itself delegated eight minutes earlier. A row per
// dispatched question is what lets a later turn see "I already asked this" before spending another
// metered child on it.
//
// Three outcomes, three different right answers, and the two negatives are what make the positive
// non-vacuous: a suite that only proved "a row is written" passes just as well against a build that
// writes one for every refusal too, which is the false-positive direction — telling the founder work
// is under way that nobody is doing.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { HistoryEntry } from "../history";

const recordHistoryMock = vi.fn(async (_e: HistoryEntry) => ({ inserted: true, collided: false }));
// Mocked at `../history` rather than at the ledger, so these assertions run through the real
// `formatDispatchText` — the row's text is what a recall query has to match.
vi.mock("../history", () => ({
  recordHistory: (e: HistoryEntry) => recordHistoryMock(e),
}));

import { dispatchResearchTask, DISPATCH_ACK_MS, type ResearchDeps } from "./research";
import type { ResearchTask } from "../research/types";

function task(over: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: "r1",
    question: "are preview cards already inline in chat?",
    depth: "quick",
    projectId: "p1",
    projectRoot: "/tmp/demo",
    status: "running",
    createdAt: 1,
    startedAt: 1,
    finishedAt: null,
    findings: null,
    error: null,
    ...over,
  } as ResearchTask;
}

/** A manual clock, so the `not-acknowledged` case is reachable without waiting ten real seconds —
 *  the same seam `research.test.ts` uses, and the reason `ResearchDeps` carries a timer at all. */
function depsWith(over: Partial<ResearchDeps> = {}): ResearchDeps {
  const fns = new Map<number, () => void>();
  let next = 1;
  return {
    dispatch: async () => task(),
    list: async () => [],
    get: async () => null,
    cancel: async () => task(),
    now: () => 0,
    setTimer: (fn) => {
      const h = next++;
      fns.set(h, fn);
      return h;
    },
    clearTimer: (h) => {
      fns.delete(h);
    },
    remember: () => {},
    ...over,
    // Exposed so a test can fire the bound. Kept OUT of the spread above so an override cannot
    // accidentally remove it.
    ...({ _fire: () => fns.forEach((f) => f()) } as unknown as Partial<ResearchDeps>),
  };
}

const rows = () =>
  recordHistoryMock.mock.calls.map((c) => c[0]).filter((e) => e.source === "dispatch");

const INPUT = {
  question: "are preview cards already inline in chat?",
  projectId: "p1",
  projectRoot: "/tmp/demo",
  depth: "quick" as const,
};

beforeEach(() => {
  recordHistoryMock.mockClear();
});

describe("research:dispatch records the delegation", () => {
  it("writes a `research`-channel row keyed on the TASK id and carrying the question", async () => {
    const r = await dispatchResearchTask(INPUT, depsWith({ dispatch: async () => task({ id: "r-42" }) }));

    expect(r.ok).toBe(true);
    expect(rows()).toHaveLength(1);
    const row = rows()[0]!;
    // The task id is the handle a later recall joins on — an agent id and a research task id share
    // the same field precisely so one query answers "what have I delegated about this".
    expect(row.agentId).toBe("r-42");
    expect(row.text).toContain("channel research");
    expect(row.text).toContain("by concierge");
    // THE SUBJECT. The founder asks about "the inline preview work", so the question has to be in
    // the indexed text or the row is unfindable by anything except its id.
    expect(row.text).toContain("are preview cards already inline in chat?");
  });

  it("writes NOTHING when the runner refuses — nothing was created to record", async () => {
    const r = await dispatchResearchTask(
      INPUT,
      depsWith({
        dispatch: async () => {
          throw new Error("runner is down");
        },
      }),
    );

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("dispatch-failed");
    expect(rows()).toEqual([]);
  });

  it("writes NOTHING when the runner never acknowledges — there is no id to key a row on", async () => {
    // The subtle one. The task has very probably STARTED (nothing cancels a command in flight), so
    // this is a delegation that really happened and cannot be recorded: `targetId` is the ledger's
    // only durable handle, and a row naming no target asserts work nobody can look up. The refusal's
    // own remedy is `list`, which is where that task turns up.
    const deps = depsWith({ dispatch: () => new Promise<ResearchTask>(() => {}) });
    const call = dispatchResearchTask(INPUT, deps);
    (deps as unknown as { _fire: () => void })._fire();

    const r = await call;

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("not-acknowledged");
    expect(rows()).toEqual([]);
    // Pinned so the manual clock above cannot silently stop exercising the bound it stands in for.
    expect(DISPATCH_ACK_MS).toBeGreaterThan(0);
  });

  it("refuses an empty question before anything is dispatched, and records nothing", async () => {
    const r = await dispatchResearchTask({ ...INPUT, question: "   " }, depsWith());

    expect(r.ok).toBe(false);
    expect(rows()).toEqual([]);
  });
});
