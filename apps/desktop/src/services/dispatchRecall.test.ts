// The delegation ledger's READ half — the part the founder called "the whole feature".
//
// Two properties are on trial here and everything else is detail:
//   1. A delegation is findable from the SUBJECT, in his words, months later.
//   2. Nothing mutable is read out of the row. The name, the status and whether the agent still
//      exists are re-derived on every call — because the bug class this feature sits inside is
//      state stamped once and never re-derived.
import { describe, it, expect, vi } from "vitest";

vi.mock("./knownAgents", () => ({ findKnownAgent: vi.fn(), knownAgentLiveness: vi.fn() }));
vi.mock("../stores/runtimeStore", () => ({ useRuntimeStore: { getState: () => ({ status: {} }) } }));
vi.mock("../logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { formatDispatchText, type DispatchRecord } from "./dispatchLedger";
import { recallDispatches, openDispatches, type RecallDeps } from "./dispatchRecall";

const NOW = Date.parse("2026-08-22T15:32:00.000Z");
const MIN = 60_000;

/** The real one. Agent id, name and timestamp are the measured values from the incident. */
const PREVIEW_CARDS: DispatchRecord = {
  targetId: "8f590b78-a474-4572-877e-0380fc7ce2e4",
  channel: "build",
  nameAtDispatch: "Sparkle Preview Card Inline",
  projectId: "ed5d0ece",
  projectName: "sparkle",
  ask: "can we make the preview cards inline, one third width, in chat?",
  brief: "TWO RELATED PROBLEMS WITH THE PREVIEW CARD in the Sparkle desktop app.",
  by: "concierge",
  atMs: NOW - 8 * MIN,
};

function row(rec: DispatchRecord) {
  return { text: formatDispatchText(rec), createdAt: rec.atMs ?? NOW };
}

/** Every live seam stubbed; nothing here touches a database, a store or an app. */
function deps(over: Partial<RecallDeps> = {}): RecallDeps {
  return {
    search: async () => [],
    recent: async () => [],
    liveAgent: () => ({ name: null, exists: false }),
    activity: () => "idle",
    now: () => NOW,
    ...over,
  };
}

/** A `search` stub shaped like the real one: full `text` present, because the live path asks for it. */
function searching(...recs: DispatchRecord[]): RecallDeps["search"] {
  return async () =>
    recs.map((r, i) => ({
      id: `h${i}`,
      kind: "prompt" as const,
      source: "dispatch" as const,
      projectId: r.projectId ?? null,
      agentId: r.targetId,
      projectName: r.projectName ?? null,
      agentName: r.nameAtDispatch ?? null,
      snippet: "…",
      createdAt: r.atMs ?? NOW,
      text: formatDispatchText(r),
    }));
}

describe("THE REGRESSION — 2026-08-22, the failure this whole feature exists to prevent", () => {
  // He asked about preview cards. The concierge answered as if it had never heard of the work and
  // dispatched fresh research — eight minutes after spawning this very agent to do exactly that.
  // He typed a SUBJECT. He did not know, and had no way to know, the agent's name or its id.
  it("returns the right agent when the founder searches the subject in his own words", async () => {
    const res = await recallDispatches(
      { query: "preview cards" },
      deps({
        search: searching(PREVIEW_CARDS),
        liveAgent: () => ({ name: "Sparkle Preview Card Inline", exists: true }),
        activity: () => "working",
      }),
    );
    expect(res.dispatches).toHaveLength(1);
    expect(res.dispatches[0]?.targetId).toBe("8f590b78-a474-4572-877e-0380fc7ce2e4");
    expect(res.dispatches[0]?.status).toBe("working");
    expect(res.dispatches[0]?.ageMs).toBe(8 * MIN);
    // And it is actionable, which is what he asked for: "go check on that agent".
    expect(res.dispatches[0]?.addressable).toBe(true);
  });

  it("still answers 'did we ever do that work?' once the agent is long gone", async () => {
    // The founder's MOST COMMON question is about finished work, so a closed delegation is a
    // first-class answer and is included by DEFAULT. A ledger that pruned finished delegations —
    // or a default of includeClosed:false — would answer this wrongly while looking healthy.
    const res = await recallDispatches(
      { query: "preview cards" },
      deps({ search: searching({ ...PREVIEW_CARDS, atMs: NOW - 40 * 24 * 60 * MIN }) }),
    );
    expect(res.dispatches).toHaveLength(1);
    expect(res.dispatches[0]?.status).toBe("closed");
    expect(res.dispatches[0]?.name).toBe("Sparkle Preview Card Inline");
    // Nothing can be sent to a retired agent, and saying so is what stops the concierge offering
    // the founder a channel that does not exist.
    expect(res.dispatches[0]?.addressable).toBe(false);
  });
});

describe("nothing mutable is trusted from the row", () => {
  it("reports the LIVE name, not the one stamped at dispatch, and says it changed", async () => {
    // Three agents have been observed simultaneously named "Worker 13", so a stamped name identifies
    // nobody. Quoting one at the founder is worse than useless — his own correction was that a name
    // he cannot see on screen "doesn't mean anything to me".
    const res = await recallDispatches(
      { query: "preview" },
      deps({
        search: searching(PREVIEW_CARDS),
        liveAgent: () => ({ name: "Inline Preview Cards", exists: true }),
      }),
    );
    expect(res.dispatches[0]?.name).toBe("Inline Preview Cards");
    expect(res.dispatches[0]?.nameAtDispatch).toBe("Sparkle Preview Card Inline");
    expect(res.dispatches[0]?.renamedSince).toBe(true);
  });

  it("does not call it a rename merely because the agent is gone", async () => {
    const res = await recallDispatches({ query: "preview" }, deps({ search: searching(PREVIEW_CARDS) }));
    expect(res.dispatches[0]?.renamedSince).toBe(false);
    expect(res.dispatches[0]?.name).toBe("Sparkle Preview Card Inline");
  });

  // `unknown` must never collapse into `idle`. runtimeStore.status is written only by a MOUNTED
  // pane, so after a relaunch a perfectly healthy agent has no entry — and reporting that as idle
  // tells the founder work has stopped when it is running.
  it("keeps 'unknown' distinct from 'idle' for a live agent with no mounted pane", async () => {
    const res = await recallDispatches(
      { query: "preview" },
      deps({
        search: searching(PREVIEW_CARDS),
        liveAgent: () => ({ name: "Sparkle Preview Card Inline", exists: true }),
        activity: () => "unknown",
      }),
    );
    expect(res.dispatches[0]?.status).toBe("unknown");
  });

  it("treats an unresolvable research task as unknown, never as closed", async () => {
    // Its findings are still readable through research({op:"get"}); calling it closed would tell the
    // founder the answer is gone when it is sitting there.
    const research = { ...PREVIEW_CARDS, channel: "research" as const, targetId: "task-77" };
    const res = await recallDispatches({ query: "preview" }, deps({ search: searching(research) }));
    expect(res.dispatches[0]?.status).toBe("unknown");
    // …but there is no inbox to reach it on.
    expect(res.dispatches[0]?.addressable).toBe(false);
  });
});

describe("ordering and filtering", () => {
  const old = { ...PREVIEW_CARDS, targetId: "aaa-oldest", nameAtDispatch: "Aardvark", atMs: NOW - 5 * 24 * 60 * MIN };
  const mid = { ...PREVIEW_CARDS, targetId: "mmm-middle", nameAtDispatch: "Mongoose", atMs: NOW - 2 * 60 * MIN };
  const recent = { ...PREVIEW_CARDS, targetId: "zzz-newest", nameAtDispatch: "Zebra", atMs: NOW - 8 * MIN };

  // NEWEST FIRST, never alphabetically — and the fixture is built so the two orders DISAGREE, or the
  // assertion would pass by luck. This is not a preference: the sibling memory store applies its cap
  // after an alphabetical key sort, which measurably hides 17 of the founder's 42 facts from the
  // prompt. The delegation this feature exists to surface was eight minutes old.
  it("returns newest first even when the store hands them back in another order", async () => {
    const res = await recallDispatches({ query: "preview" }, deps({ search: searching(old, recent, mid) }));
    expect(res.dispatches.map((d) => d.targetId)).toEqual(["zzz-newest", "mmm-middle", "aaa-oldest"]);
  });

  it("filters to open delegations only when asked, and counts what it dropped", async () => {
    const res = await recallDispatches(
      { query: "preview", includeClosed: false },
      deps({
        search: searching(old, recent),
        // Only the recent one still exists.
        liveAgent: (id) => ({ name: "Zebra", exists: id === "zzz-newest" }),
      }),
    );
    expect(res.dispatches.map((d) => d.targetId)).toEqual(["zzz-newest"]);
    // `matched` counts BEFORE the filter, so "2 matched, 1 still open" is sayable and a
    // closed-only result never reads to the model as no result at all.
    expect(res.matched).toBe(2);
  });

  it("narrows to one target when an id is already in hand", async () => {
    const res = await recallDispatches(
      { query: "preview", targetId: "mmm-middle" },
      deps({ search: searching(old, recent, mid) }),
    );
    expect(res.dispatches.map((d) => d.targetId)).toEqual(["mmm-middle"]);
  });

  it("honours sinceMs", async () => {
    const res = await recallDispatches(
      { query: "preview", sinceMs: NOW - 60 * MIN },
      deps({ search: searching(old, recent, mid) }),
    );
    expect(res.dispatches.map((d) => d.targetId)).toEqual(["zzz-newest"]);
  });

  it("reads the time-ordered ledger when there is no query", async () => {
    const res = await recallDispatches({}, deps({ recent: async () => [row(mid), row(recent)] }));
    expect(res.query).toBeNull();
    expect(res.dispatches.map((d) => d.targetId)).toEqual(["zzz-newest", "mmm-middle"]);
  });

  it("openDispatches returns only what is live", async () => {
    const open = await openDispatches(
      12,
      deps({
        recent: async () => [row(old), row(recent)],
        liveAgent: (id) => ({ name: "Zebra", exists: id === "zzz-newest" }),
      }),
    );
    expect(open.map((d) => d.targetId)).toEqual(["zzz-newest"]);
  });
});

describe("degrading honestly", () => {
  // Called on the concierge's answer path. An unreadable ledger must degrade to "I have no record",
  // which is at least true, rather than failing the founder's turn.
  it("returns empty rather than throwing when the store is unreadable", async () => {
    const res = await recallDispatches(
      { query: "preview" },
      deps({
        search: async () => {
          throw new Error("database is locked");
        },
      }),
    );
    expect(res).toEqual({ dispatches: [], query: "preview", matched: 0 });
  });

  it("skips a hit whose text was not fetched rather than parsing the snippet", async () => {
    // A snippet is 12 tokens around the match, wrapped in <b> markers and ellipses. Parsing one
    // would yield a record whose every field was a display artefact — worse than no record, because
    // it would look like an answer.
    const res = await recallDispatches(
      { query: "preview" },
      deps({
        search: async () => [
          {
            id: "h0",
            kind: "prompt",
            source: "dispatch",
            projectId: null,
            agentId: "x",
            projectName: null,
            agentName: null,
            snippet: "…<b>preview</b> cards…",
            createdAt: NOW,
            text: null,
          },
        ],
      }),
    );
    expect(res.dispatches).toEqual([]);
  });
});
