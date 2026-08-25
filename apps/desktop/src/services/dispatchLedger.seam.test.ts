// THE WHOLE CHAIN, END TO END: a spawn writes a row → the row is searched by subject → the result
// is rendered into the preamble the concierge actually reads.
//
// ══ WHY THIS FILE EXISTS SEPARATELY FROM THE THREE UNIT SUITES ══════════════════════════════════
//
// The three halves of this feature were built CONCURRENTLY by different agents against a frozen
// interface: the write sites, the read path, and the per-turn fold-in. AGENTS.md records exactly
// what that arrangement produces when nobody tests across it (bead `sparkle-16y6h`): *"two agents
// built the two halves in parallel against a frozen field list; both suites passed, the merge was
// clean, and the shipped feature never once ran."*
//
// Every unit suite here is genuinely green, and NONE of them proves the pieces meet. The write suite
// asserts `recordDispatch` was called with the right record — against a mock. The read suite asserts
// the parse and the live join — against hand-built fixture text. The preamble suite asserts
// rendering — against hand-built `RecalledDispatch` objects. Each half is tested against its own
// idea of the other half's output, which is precisely the shape that passes while the seam is
// broken. A single typo'd field name, or a format change on one side, would leave all three green.
//
// So this file uses NO fixture text and NO hand-built records. It starts from the record a real
// spawn site passes to `recordDispatch`, takes the ACTUAL bytes that would be stored, feeds those
// exact bytes to the ACTUAL read path, and renders the ACTUAL result. The only stubs are the
// database and the live agent roster — the two things that are genuinely external.
import { describe, it, expect, vi } from "vitest";

vi.mock("./knownAgents", () => ({ findKnownAgent: vi.fn(), knownAgentLiveness: vi.fn() }));
vi.mock("../stores/runtimeStore", () => ({ useRuntimeStore: { getState: () => ({ status: {} }) } }));
vi.mock("../logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const recordHistoryMock = vi.hoisted(() => vi.fn());
vi.mock("./history", async (orig) => {
  const actual = await orig<typeof import("./history")>();
  return { ...actual, recordHistory: recordHistoryMock, searchHistory: vi.fn(), entriesInRange: vi.fn() };
});

import { recordDispatch, type DispatchRecord } from "./dispatchLedger";
import { recallDispatches, type RecallDeps } from "./dispatchRecall";
import { buildDispatchPreamble, withDispatchPreamble } from "../stores/conciergeDispatchStore";

const NOW = Date.parse("2026-08-22T15:32:00.000Z");
const EIGHT_MIN = 8 * 60_000;

/**
 * Run one delegation through the ENTIRE chain and hand back what the concierge would see.
 *
 * The one thing to preserve if this is ever refactored: `stored` is captured from the recorded
 * entry's own `text`, and that same string is what the fake store hands to the read path. Nothing
 * in between is retyped by hand. The moment a fixture string appears here, this file stops testing
 * the seam and becomes a fourth unit suite.
 */
async function throughTheWholeChain(
  rec: DispatchRecord,
  opts: { query?: string; liveName?: string | null; exists?: boolean } = {},
) {
  recordHistoryMock.mockReset();
  recordHistoryMock.mockResolvedValue({ inserted: true, collided: false });

  // 1. THE WRITE — exactly as a spawn site performs it.
  const landed = await recordDispatch(rec);
  expect(landed, "the write half must actually land a row").toBe(true);
  const entry = recordHistoryMock.mock.calls[0]?.[0];
  const stored: string = entry.text;

  // 2. THE READ — over the bytes the write half really produced, not a fixture.
  const deps: RecallDeps = {
    search: async () => [
      {
        id: entry.id,
        kind: entry.kind,
        source: entry.source,
        projectId: entry.projectId,
        agentId: entry.agentId,
        projectName: entry.projectName,
        agentName: entry.agentName,
        snippet: "…",
        createdAt: entry.createdAt,
        text: stored,
      },
    ],
    recent: async () => [{ text: stored, createdAt: entry.createdAt }],
    liveAgent: () => ({
      name: opts.liveName ?? null,
      exists: opts.exists ?? opts.liveName !== undefined,
    }),
    activity: () => "working",
    now: () => NOW,
  };
  const res = await recallDispatches(
    opts.query === undefined ? {} : { query: opts.query },
    deps,
  );

  // 3. THE RENDER — the actual preamble the concierge reads.
  const preamble = buildDispatchPreamble(res.dispatches, NOW);
  return { entry, stored, res, preamble };
}

describe("the delegation chain, end to end — write → recall by subject → preamble", () => {
  // THE INCIDENT, driven through every layer at once. On 2026-08-22 the founder asked about making
  // preview cards inline; the concierge answered as if it had never heard of the work, eight minutes
  // after spawning this agent to do exactly that. If this test passes, that specific conversation
  // cannot happen again — the delegation is in the prompt before he finishes typing.
  const previewCards: DispatchRecord = {
    targetId: "8f590b78-a474-4572-877e-0380fc7ce2e4",
    channel: "build",
    nameAtDispatch: "Sparkle Preview Card Inline",
    projectId: "ed5d0ece",
    projectName: "sparkle",
    ask: "can we make the preview cards inline, one third width, in chat?",
    brief: "TWO RELATED PROBLEMS WITH THE PREVIEW CARD in the Sparkle desktop app.",
    by: "concierge",
    atMs: NOW - EIGHT_MIN,
  };

  it("a spawn is findable by SUBJECT and lands in the concierge's own prompt", async () => {
    const { res, preamble } = await throughTheWholeChain(previewCards, {
      query: "preview cards",
      liveName: "Sparkle Preview Card Inline",
    });

    expect(res.dispatches).toHaveLength(1);
    expect(res.dispatches[0]?.targetId).toBe(previewCards.targetId);
    expect(res.dispatches[0]?.ageMs).toBe(EIGHT_MIN);

    // The handle has to survive all the way to the rendered line, or "go check on that agent" is
    // not actionable — which was half of what the founder asked for.
    expect(preamble).toContain(previewCards.targetId);
    expect(preamble).toContain("Sparkle Preview Card Inline");
  });

  it("the same delegation is in the prompt with NO query at all — the founder never has to ask", async () => {
    // The recall op is the on-demand half. THIS is the half that makes the failure unreachable: with
    // no query and nobody having thought to look, the open delegation is still folded in.
    const { preamble } = await throughTheWholeChain(previewCards, {
      liveName: "Sparkle Preview Card Inline",
    });
    const composed = withDispatchPreamble(preamble, "can we make preview cards inline in chat?");
    expect(composed).toContain(previewCards.targetId);
    // …and it precedes the founder's message, which is the entire point of a preamble.
    expect(composed.indexOf(previewCards.targetId)).toBeLessThan(
      composed.indexOf("can we make preview cards inline in chat?"),
    );
  });

  it("carries the LIVE name through the chain when the agent has been renamed since", async () => {
    // Three agents have been observed simultaneously named "Worker 13". The stamped name is written
    // by the write half and must be overridden by the read half — a seam only this file crosses.
    const { res, preamble } = await throughTheWholeChain(previewCards, {
      query: "preview cards",
      liveName: "Inline Preview Cards",
    });
    expect(res.dispatches[0]?.renamedSince).toBe(true);
    expect(preamble).toContain("Inline Preview Cards");
  });

  it("every channel a write site uses survives the round trip", async () => {
    // Guards the one failure that would be invisible to the unit suites: a write site emitting a
    // channel token the read half does not recognise. Each is driven through the REAL format.
    for (const channel of ["build", "cloud-build", "research", "plan"] as const) {
      const { res } = await throughTheWholeChain(
        { ...previewCards, channel, targetId: `t-${channel}` },
        { query: "preview cards", liveName: "Some Agent" },
      );
      expect(res.dispatches[0]?.channel, `channel ${channel} did not survive`).toBe(channel);
    }
  });

  it("an unbriefed spawn still produces a findable, renderable delegation", async () => {
    // The "+ New Build Agent" button's shape: a real delegation with no brief. It must not vanish
    // from the chain — "we opened an empty agent for that" is still an answer.
    const { res, preamble } = await throughTheWholeChain(
      { ...previewCards, brief: "", ask: null },
      { liveName: "Build 42" },
    );
    expect(res.dispatches).toHaveLength(1);
    expect(preamble).toContain(previewCards.targetId);
  });

  it("a finished delegation is still recallable, and is NOT in the live preamble", async () => {
    // The two halves of the close-out rule, asserted together because they are one decision:
    // search must still find it (that is "did we ever do that work?"), while the per-turn prompt
    // must not carry it (a prompt is a budget). Testing either alone would let the other regress.
    const { res, preamble } = await throughTheWholeChain(previewCards, {
      query: "preview cards",
      liveName: null,
      exists: false,
    });
    expect(res.dispatches).toHaveLength(1);
    expect(res.dispatches[0]?.status).toBe("closed");
    expect(res.dispatches[0]?.addressable).toBe(false);
    expect(preamble).toBe("");
  });
});
