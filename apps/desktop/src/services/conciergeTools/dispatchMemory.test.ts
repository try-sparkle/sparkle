// @vitest-environment jsdom
//
// The DISPATCH MEMORY domain, driven END TO END — through `dispatchConciergeTool`, the same entry
// the model's `sparkle_dispatch_memory` call arrives at, down to real ledger row TEXT.
//
// ── WHAT IS AND IS NOT FAKED, AND WHY IT MATTERS HERE MORE THAN USUAL ───────────────────────────
// Only `services/history` is faked, and it is faked as a STORE (rows in, rows matched out) rather
// than as an echo. Everything between the wire and it is the real thing: the zod schema, the route,
// `recallDispatchesOp`, `recallDispatches`, `parseDispatchText`, the live join, the
// `includeClosed` default, the newest-first sort.
//
// That is deliberate, and it is AGENTS.md's "defaulted seam" warning applied to this feature. If
// the domain module took a `{ recall }` façade and these tests injected one, the assertions would
// pass over a route that never reached the ledger at all — and the ONE property this whole feature
// exists for (the founder's words find the agent) would be guarded by nothing. So the fake is put
// as far down as it can go.
//
// ── THE REGRESSION THESE EXIST TO PREVENT (measured, 2026-08-22) ────────────────────────────────
// The founder asked the concierge about making preview cards inline in chat. It answered as if it
// had never heard of the work and dispatched fresh research — eight minutes after it had itself
// spawned an agent ("Sparkle Preview Card Inline") to do exactly that. The first test below is that
// conversation, replayed against this op.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async () => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [])) }));
// bd is not available in a unit test; unrelated routes in the spine fire a best-effort `bd create`.
vi.mock("../tasks", () => ({ createBeadFull: vi.fn(async () => "bd-new") }));

/**
 * The ledger, as a store.
 *
 * `search` stands in for the FTS5 index: a row matches when EVERY word of the query appears in its
 * text. Crude next to FTS5 and deliberately so — it is enough to make "does the founder's phrasing
 * reach the row" a real question, and it fails exactly when the route mangles, drops or replaces
 * the query, which is the failure worth catching. `recent` is the no-query, time-ordered arm.
 */
const rows: { text: string; createdAt: number }[] = [];
const searchHistory = vi.fn(async (query: string, limit: number) => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return rows
    .filter((r) => words.every((w) => r.text.toLowerCase().includes(w)))
    .slice(0, limit)
    .map((r) => ({
      id: `h-${r.createdAt}`,
      kind: "prompt" as const,
      source: "dispatch" as const,
      projectId: null,
      agentId: null,
      projectName: null,
      agentName: null,
      snippet: "",
      createdAt: r.createdAt,
      text: r.text,
    }));
});
const entriesInRange = vi.fn(async (fromMs: number, toMs: number, _source: string, limit: number) =>
  rows
    .filter((r) => r.createdAt >= fromMs && r.createdAt <= toMs)
    .slice(0, limit)
    .map((r) => ({
      id: `h-${r.createdAt}`,
      kind: "prompt" as const,
      source: "dispatch" as const,
      projectId: null,
      agentId: null,
      projectName: null,
      agentName: null,
      text: r.text,
      createdAt: r.createdAt,
    })),
);
vi.mock("../history", async (orig) => ({
  ...(await orig<typeof import("../history")>()),
  searchHistory: (...a: unknown[]) => searchHistory(...(a as [string, number])),
  entriesInRange: (...a: unknown[]) => entriesInRange(...(a as [number, number, string, number])),
}));

import { formatDispatchText } from "../dispatchLedger";
import { dispatchConciergeTool, type ConciergeToolReply } from "./registry";
import { DISPATCH_MEMORY_OPS, DISPATCH_MEMORY_RISK, recallDispatchesOp } from "./dispatchMemory";
import { defaultDecisionFor } from "./policy";
import { useProjectStore } from "../../stores/projectStore";
import { useRuntimeStore } from "../../stores/runtimeStore";
import type { RecalledDispatch } from "../dispatchRecall";

// The real ids and words from the incident, so a reader can match this file to the bug report.
const PREVIEW_AGENT_ID = "8f590b78-3d21-4a71-9c1d-7d0a5b6e2f44";
const PREVIEW_NAME = "Sparkle Preview Card Inline";
const PREVIEW_ASK = "can we make the preview cards inline, like one-third width, in the chat?";
const NOW = 1_756_000_000_000;

/** Seed one ledger row, rendered through the PRODUCTION formatter — not a hand-written string. A
 *  fixture written by hand would drift from `formatDispatchText` and these tests would then be
 *  asserting against a row shape the app never writes. */
function seedDispatch(over: Partial<Parameters<typeof formatDispatchText>[0]> = {}): string {
  const rec = {
    targetId: PREVIEW_AGENT_ID,
    channel: "build" as const,
    nameAtDispatch: PREVIEW_NAME,
    projectId: "p1",
    projectName: "Sparkle",
    ask: PREVIEW_ASK,
    brief: "Make the preview cards render inline in the chat column at one-third width.",
    by: "concierge" as const,
    atMs: NOW - 8 * 60 * 1000,
    ...over,
  };
  rows.push({ text: formatDispatchText(rec), createdAt: rec.atMs });
  return rec.targetId;
}

async function recallThroughTheTool(args: Record<string, unknown>): Promise<ConciergeToolReply> {
  return dispatchConciergeTool({
    domain: "dispatch_memory",
    op: "recall_dispatches",
    args,
    toolCallId: "tc-dispatch-memory",
  });
}

/** Narrow the reply to its delegations, failing loudly (with the refusal) when it is not ok. */
function dispatchesOf(r: ConciergeToolReply): RecalledDispatch[] {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return (r.data as { dispatches: RecalledDispatch[] }).dispatches;
}

beforeEach(() => {
  vi.clearAllMocks();
  // `ageMs` and the recent-window are derived from `Date.now()` at read time, so the clock is the
  // one input these assertions cannot leave to chance.
  vi.useFakeTimers();
  rows.length = 0;
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  useRuntimeStore.setState({
    status: {},
    openAgentIds: [],
    branchStatus: {},
    workflowStage: {},
    attentionScreen: {},
  } as never);
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------
// 1. THE REGRESSION. This is the test the feature exists for.
// ---------------------------------------------------------------------------------------------

describe("the 2026-08-22 preview-card failure", () => {
  it("finds the agent from the founder's own SUBJECT words, through the tool spine", async () => {
    const id = seedDispatch();

    const r = await recallThroughTheTool({ query: "preview cards" });

    // THE SIDE EFFECT: the right delegation comes back, identified by the handle that survives a
    // rename — not by a name the founder has never seen.
    const found = dispatchesOf(r);
    expect(found.map((d) => d.targetId)).toEqual([id]);
    // And it carries the words it was dispatched with, which is what lets the concierge say WHAT
    // that agent is doing rather than merely that one exists.
    expect(found[0]!.ask).toContain("preview cards");
    expect(found[0]!.nameAtDispatch).toBe(PREVIEW_NAME);
    // Eight minutes, the exact gap in the incident — reported as an age derived at read time.
    expect(found[0]!.ageMs).toBe(8 * 60 * 1000);
  });

  it("passes the founder's phrasing to the index VERBATIM — it is not rewritten or dropped", async () => {
    seedDispatch();

    await recallThroughTheTool({ query: "the inline preview work" });

    // The retrieval path IS the feature: a route that quietly substituted an agent name, an id, or
    // its own paraphrase would still return rows here (the fake matches on words) but would stop
    // matching the moment the founder's wording differs from the row's. Assert the string itself.
    expect(searchHistory).toHaveBeenCalledWith(
      "the inline preview work",
      expect.any(Number),
      // …narrowed to the ledger, with the WHOLE row text: an FTS snippet carries `<b>` markers and
      // ellipses, and parsing one would corrupt every field it produced.
      expect.objectContaining({ sources: ["dispatch"], includeText: true }),
    );
    // And the query is echoed back, so "nothing about X" can name X honestly.
    const r = await recallThroughTheTool({ query: "the inline preview work" });
    expect((r as { data: { query: string } }).data.query).toBe("the inline preview work");
  });

  it("does NOT invent delegations for a subject nobody was sent on", async () => {
    seedDispatch();

    const r = await recallThroughTheTool({ query: "stripe checkout" });

    // The other half of the pair: a matcher that returned everything would pass every assertion
    // above while telling the founder work is under way that is not.
    expect(dispatchesOf(r)).toEqual([]);
    expect((r as { data: { matched: number } }).data.matched).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// 2. THE DEFAULT. "Did we ever do that work?" is answered by a FINISHED delegation.
// ---------------------------------------------------------------------------------------------

describe("closed delegations", () => {
  it("come back when includeClosed is not passed at all — the founder's usual question", async () => {
    // No agent seeded into the project store, so the target no longer resolves: `closed`.
    const id = seedDispatch();

    const found = dispatchesOf(await recallThroughTheTool({ query: "preview cards" }));

    expect(found.map((d) => d.targetId)).toEqual([id]);
    expect(found[0]!.status).toBe("closed");
    // Nothing is draining a finished agent's inbox, so the concierge must not offer to message it.
    expect(found[0]!.addressable).toBe(false);
  });

  it("are filtered out ONLY when the caller explicitly says so", async () => {
    seedDispatch();

    const found = dispatchesOf(
      await recallThroughTheTool({ query: "preview cards", includeClosed: false }),
    );

    // THE PAIRED ASSERTION. On its own, "closed rows come back" would still pass for a route that
    // ignored `includeClosed` entirely; on its own, this one would still pass for a route that
    // dropped every closed row. Together they pin the default to TRUE and prove the flag is live.
    expect(found).toEqual([]);
  });

  it("reports how many matched before the closed filter, so an empty list is explainable", async () => {
    seedDispatch();

    const r = await recallThroughTheTool({ query: "preview cards", includeClosed: false });

    expect((r as { data: { matched: number } }).data.matched).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. THE LIVE JOIN. Everything mutable is re-derived at read time, never read out of the row.
// ---------------------------------------------------------------------------------------------

describe("a delegation whose agent is still alive", () => {
  /** Mint a real agent in the store, name it `liveName`, and file a ledger row against it whose
   *  stamped name is `nameAtDispatch`. Returns the id the store actually minted. */
  function seedLiveAgent(liveName: string, nameAtDispatch: string): string {
    const store = useProjectStore.getState();
    const projectId = store.addProject("Sparkle", "/tmp/sparkle");
    const agentId = store.addAgent(projectId, { kind: "build" })!;
    store.renameAgent(projectId, agentId, liveName);
    seedDispatch({ targetId: agentId, nameAtDispatch });
    useRuntimeStore.setState({ status: { [agentId]: "working" } } as never);
    return agentId;
  }

  it("reports the LIVE name and flags the rename, and says the agent can be messaged", async () => {
    seedLiveAgent("Renamed Since", "Old Name");

    const found = dispatchesOf(await recallThroughTheTool({ query: "preview cards" }));

    expect(found).toHaveLength(1);
    // The live name, not the stamped one — the founder's own correction was that being told a name
    // he cannot see on screen is worse than being told nothing.
    expect(found[0]!.name).toBe("Renamed Since");
    expect(found[0]!.nameAtDispatch).toBe("Old Name");
    expect(found[0]!.renamedSince).toBe(true);
    // Derived from the runtime store at answer time, not stamped in the row.
    expect(found[0]!.status).toBe("working");
    // The whole point of surfacing `targetId`: "go check on that agent" has to be actionable.
    expect(found[0]!.addressable).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. THE TOOL SURFACE. Freely callable, strictly validated.
// ---------------------------------------------------------------------------------------------

describe("the op's classification and argument schema", () => {
  it("is read-only and auto-allowed — an approval card here would reproduce the incident", () => {
    // The op is only useful if the model reaches for it BEFORE answering. An `ask` tier would make
    // it the expensive path and it would be skipped, with the ledger sitting right there.
    expect(DISPATCH_MEMORY_RISK.recall_dispatches).toBe("read-only");
    expect(defaultDecisionFor("recall_dispatches")).toBe("allow");
  });

  it("accepts a call with NO arguments — 'what have you got going?' is a real question", async () => {
    seedDispatch();

    const found = dispatchesOf(await recallThroughTheTool({}));

    // No query means the recent, time-ordered arm rather than the index.
    expect(entriesInRange).toHaveBeenCalled();
    expect(searchHistory).not.toHaveBeenCalled();
    expect(found.map((d) => d.targetId)).toEqual([PREVIEW_AGENT_ID]);
  });

  it("returns the newest delegation first, whatever order the store hands rows back in", async () => {
    const older = seedDispatch({ targetId: "older-agent", atMs: NOW - 60 * 60 * 1000 });
    const newer = seedDispatch({ targetId: "newer-agent", atMs: NOW - 60 * 1000 });

    const found = dispatchesOf(await recallThroughTheTool({}));

    // Recency is the ordering under which the eight-minute-old delegation is line 1.
    expect(found.map((d) => d.targetId)).toEqual([newer, older]);
  });

  it("refuses an unrecognised argument rather than passing it through", async () => {
    const r = await recallThroughTheTool({ query: "preview cards", agentName: "Sparkle Preview" });

    expect(r.ok).toBe(false);
    // `.strict()`, like every other domain — and this one matters: `agentName` is precisely the
    // argument a model would invent, and silently ignoring it would return the wrong rows.
    expect((r as { code: string }).code).toBe("bad-args");
  });

  it("publishes exactly one op, so the name cannot silently collide with another domain's", () => {
    expect([...DISPATCH_MEMORY_OPS]).toEqual(["recall_dispatches"]);
  });
});

// ---------------------------------------------------------------------------------------------
// 5. The domain function's own contract.
// ---------------------------------------------------------------------------------------------

describe("recallDispatchesOp", () => {
  it("refuses rather than throwing when the read path blows up", async () => {
    const res = await recallDispatchesOp({ query: "preview cards" }, {
      search: () => {
        throw new Error("history.db is on fire");
      },
      recent: async () => [],
      liveAgent: () => ({ name: null, exists: false }),
      activity: () => "unknown",
      now: () => NOW,
    });

    // `recallDispatches` swallows its own failures, so this arm is defensive — but a domain that
    // can reject is a domain that can fail the founder's whole turn.
    expect(res.ok).toBe(true);
    expect(res.ok && (res.data as { dispatches: unknown[] }).dispatches).toEqual([]);
  });
});
