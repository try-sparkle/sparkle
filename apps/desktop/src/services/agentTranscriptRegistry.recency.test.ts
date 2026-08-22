// @vitest-environment jsdom
//
// THE PERSISTED BINDING'S RECENCY MUST TRACK LAST-*SEEN*, NOT LAST-*CHANGED*.
//
// `persist()` keeps the tail of the map — `[...sessionIds.entries()].slice(-MAX_AGENTS_PERSISTED)` —
// and its comment calls that "the recently-active set". It was not. `noteAgentSessionId` returns
// early on an id it already holds, so before the touch branch existed an entry only moved to the
// tail when it CHANGED. A busy, stable agent — ONE session id, hundreds of hook events, working
// right now — therefore never refreshed its recency and was pushed out by every newly-created agent.
//
// MEASURED ON THE FOUNDER'S MACHINE: this blob was saturated at exactly 400, and his live agent's
// binding was ABSENT in one read and PRESENT minutes later — the binding of an agent that is working
// at this moment coming and going. When it was absent, the mounted pane read "No conversation with
// <name> yet." forever, because the reader fails closed on an unknown binding.
//
// ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────────────────────────
// It saturates the registry with 400+ agents. Module state is per test FILE in vitest, so keeping it
// here means no sibling suite's hydration is decided by this one's leftovers.
//
// ── WHY IT ASSERTS ACROSS A HYDRATE, NOT ON THE MAP ─────────────────────────────────────────────
// The in-memory map is uncapped; the eviction happens in `persist()` and only becomes visible on the
// next process. Asserting on `agentSessionIds()` in this process would be green against the bug.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentSessionIds,
  noteAgentSessionId,
  subscribeAgentSessionIds,
} from "./agentTranscriptRegistry";

/** Mirrors `MAX_AGENTS_PERSISTED` in the module under test. Not exported — persisting an internal
 *  bound as public surface would be a promise this module does not want to make — so it is restated
 *  here, and `saturate()` below overshoots it rather than depending on the exact number. */
const CAP = 400;

/** The agent the founder is looking at: created FIRST, hence oldest by creation, and stable — one
 *  session id for its whole life, which is the shape the old rule could not keep. */
const BUSY = "ag-busy";
/** Created immediately after it, and NEVER seen again. The control: it must be the one evicted. */
const IDLE = "ag-idle";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

/** Create `n` fresh agents, each with a genuinely new id, exactly as a fleet filling up does. */
function saturate(n: number, prefix: string): void {
  for (let i = 0; i < n; i++) noteAgentSessionId(`${prefix}-${i}`, `sess-${prefix}-${i}`);
}

describe("persisted recency — a working agent is not evicted by newer ones", () => {
  it("keeps an agent that is merely RE-SEEN and drops one that genuinely went quiet", async () => {
    noteAgentSessionId(BUSY, "sess-busy");
    noteAgentSessionId(IDLE, "sess-idle");

    // The fleet fills up to EXACTLY the cap around them: 2 + (CAP - 2) entries, nothing evicted yet.
    saturate(CAP - 2, "early");

    // ── THE ONE LINE UNDER TEST ────────────────────────────────────────────────────────────────
    // The busy agent emits another hook event carrying the SAME session id it already has — which is
    // what hundreds of hook events look like for an agent that has not restarted. Nothing about its
    // binding CHANGES, so the old code returned early here and left it at the HEAD of the order.
    // `IDLE` deliberately does not do this; it is the control.
    noteAgentSessionId(BUSY, "sess-busy");

    // Two more agents are created, so exactly the two oldest entries fall off the front of the
    // slice. Under the old rule those two are `BUSY` and `IDLE`; under last-SEEN they are `IDLE` and
    // the oldest `early`. Sized deliberately tight — a big overflow would evict `BUSY` under BOTH
    // rules and the row would be green against the bug.
    saturate(2, "late");

    // A fresh import is this process's stand-in for a relaunch: new module state, same localStorage.
    vi.resetModules();
    const fresh = await import("./agentTranscriptRegistry");

    // THE SIDE EFFECT, and the one the pane actually reads: the binding survived the restart.
    expect(fresh.agentSessionIds(BUSY)).toEqual(["sess-busy"]);
    // THE PAIRED NEGATIVE, without which this test would pass on a build that simply never evicts
    // anything (raising the cap, dropping the slice) — a change that would not fix the founder's bug
    // and would grow the blob without bound.
    expect(fresh.agentSessionIds(IDLE)).toBeUndefined();
  });

  // THE TOUCH MUST STAY INVISIBLE. Both properties the early return protected are load-bearing: hook
  // events arrive continuously, so a notification per event would re-render the mounted pane on
  // every one, and a fresh array identity would hand `useSyncExternalStore` a new snapshot each time
  // — which React treats as an infinite loop. So the fix had to reorder the Map WITHOUT doing either.
  it("re-seeing a known id notifies nobody and returns the SAME array identity", () => {
    const seen = vi.fn();
    const off = subscribeAgentSessionIds(seen);
    try {
      noteAgentSessionId("ag-identity", "sess-a");
      expect(seen).toHaveBeenCalledTimes(1);
      const before = agentSessionIds("ag-identity");

      noteAgentSessionId("ag-identity", "sess-a");
      noteAgentSessionId("ag-identity", "sess-a");

      expect(seen).toHaveBeenCalledTimes(1);
      expect(agentSessionIds("ag-identity")).toBe(before);
    } finally {
      off();
    }
  });
});
