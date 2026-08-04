// The read side of sparkle-zm0c8: a queued message must be READABLE by the surfaces that render it.
//
// Every assertion here is on the SIDE EFFECT — what a surface can now show — rather than on a helper
// having been called. Before this store existed nothing in the app read the Level 2 queue at all
// (`inbox_peek` did not exist and `fleetWatch` reads only counts, only for idle candidates), so none
// of these could pass against the code as it stood.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetInboxForTests,
  __setInboxPeekForTests,
  inFlight,
  pendingCount,
  readAgentInbox,
  refreshInbox,
  useInboxStore,
  watch,
} from "./inboxStore";
import type { InboxEntry, InboxView } from "../services/conciergeTools/fleet";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../logger", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

function entry(over: Partial<InboxEntry> & { id: string }): InboxEntry {
  return {
    ts: 1_000,
    from: "concierge",
    text: `text for ${over.id}`,
    severity: "fyi",
    state: "pending",
    ackedAt: null,
    ackNote: null,
    ...over,
  };
}

let restore: () => void = () => {};

beforeEach(() => {
  __resetInboxForTests();
});
afterEach(() => {
  restore();
  __resetInboxForTests();
});

describe("inboxStore", () => {
  it("publishes the TEXT of a queued message, which is the thing that was invisible", async () => {
    restore = __setInboxPeekForTests(async (ids) => [
      {
        agentId: ids[0]!,
        entries: [entry({ id: "m1", text: "rebase before you verify" })],
      },
    ]);

    watch("agent-1");
    await refreshInbox();

    const got = readAgentInbox("agent-1");
    expect(got.map((e) => e.text)).toEqual(["rebase before you verify"]);
    expect(pendingCount(got)).toBe(1);
  });

  it("polls EXACTLY the agents someone is rendering, in one call", async () => {
    const calls: string[][] = [];
    restore = __setInboxPeekForTests(async (ids) => {
      calls.push([...ids]);
      return ids.map((agentId) => ({ agentId, entries: [] }));
    });

    const releaseA = watch("agent-a");
    watch("agent-b");
    await refreshInbox();

    expect(calls).toHaveLength(1);
    expect([...calls[0]!].sort()).toEqual(["agent-a", "agent-b"]);

    // A released agent stops being read: nothing polls an inbox no surface is showing.
    releaseA();
    await refreshInbox();
    expect(calls[1]).toEqual(["agent-b"]);

    // …and with nothing watched, the poll makes no call at all rather than asking for an empty batch
    // (which `inbox_peek` would refuse, turning a quiet fleet into a recurring error).
    __resetInboxForTests();
    await refreshInbox();
    expect(calls).toHaveLength(2);
  });

  it("one malformed id does not take every badge in the fleet down with it", async () => {
    // `inbox_peek` refuses the WHOLE batch on the first bad id (all-or-nothing is right there — a
    // partly-served probe is a worse answer than a refusal). The batch here is every agent on screen,
    // so without a filter one bad id anywhere in the window would silently freeze every badge: the
    // read throws, the store keeps its last snapshot by design, and nothing looks wrong. That is this
    // bead's own failure mode reached through its fix.
    const seen: string[][] = [];
    restore = __setInboxPeekForTests(async (ids) => {
      seen.push([...ids]);
      // Behave as the command does, so the test fails for the real reason if the filter is removed.
      if (ids.some((i) => i === "" || i.includes("/") || i.includes(".."))) {
        throw new Error('inbox: invalid agent id');
      }
      return ids.map((agentId) => ({ agentId, entries: [entry({ id: `for-${agentId}` })] }));
    });

    watch("agent-good");
    watch("../escape");
    await refreshInbox();

    expect(seen[0]).toEqual(["agent-good"]);
    expect(readAgentInbox("agent-good")).toHaveLength(1);
    // …and the malformed one is simply unknown, never invented. Such an id cannot have an inbox:
    // `enqueue` refuses to create one.
    expect(readAgentInbox("../escape")).toEqual([]);
  });

  it("keeps the last known inbox when a read FAILS, instead of reporting an empty one", async () => {
    // A badge that vanished on a transient IPC error would recreate the exact invisibility this
    // store exists to fix — and it would do it at the moment the app is least able to explain itself.
    restore = __setInboxPeekForTests(async (ids) => [
      { agentId: ids[0]!, entries: [entry({ id: "m1", text: "main has moved" })] },
    ]);
    watch("agent-1");
    await refreshInbox();
    expect(readAgentInbox("agent-1")).toHaveLength(1);

    restore();
    restore = __setInboxPeekForTests(async () => {
      throw new Error("bridge request timeout");
    });
    await refreshInbox();

    expect(readAgentInbox("agent-1").map((e) => e.text)).toEqual(["main has moved"]);
    expect(useInboxStore.getState().error).toContain("bridge request timeout");
  });

  it("hands back the SAME array while the inbox is unchanged, and a new one when it moves", async () => {
    // Rows are memoized on identity. A fresh array per tick re-renders every agent row in the fleet
    // every ten seconds, forever, for an inbox that has not changed.
    let view: InboxView[] = [
      { agentId: "agent-1", entries: [entry({ id: "m1", state: "pending" })] },
    ];
    restore = __setInboxPeekForTests(async () => view);

    watch("agent-1");
    await refreshInbox();
    const first = readAgentInbox("agent-1");
    await refreshInbox();
    expect(readAgentInbox("agent-1")).toBe(first);

    // The stage moving IS a change — the thread renders it — so identity must break here.
    view = [{ agentId: "agent-1", entries: [entry({ id: "m1", state: "delivered" })] }];
    await refreshInbox();
    expect(readAgentInbox("agent-1")).not.toBe(first);
    expect(readAgentInbox("agent-1")[0]!.state).toBe("delivered");
  });

  it("distinguishes NOT YET POLLED from POLLED AND EMPTY", async () => {
    // "I don't know" and "there is nothing" are the two facts this whole bug is about conflating.
    restore = __setInboxPeekForTests(async (ids) => ids.map((agentId) => ({ agentId, entries: [] })));

    expect(useInboxStore.getState().polledAgents["agent-1"]).toBeUndefined();
    watch("agent-1");
    await refreshInbox();
    expect(useInboxStore.getState().polledAgents["agent-1"]).toBe(true);
    expect(readAgentInbox("agent-1")).toEqual([]);
  });

  describe("the derived reads the surfaces use", () => {
    const entries = [
      entry({ id: "m1", state: "pending" }),
      entry({ id: "m2", state: "delivered" }),
      entry({ id: "m3", state: "acknowledged", ackedAt: 2_000, ackNote: "read" }),
    ];

    it("counts only PENDING for the row badge — delivered is no longer waiting on a turn", () => {
      expect(pendingCount(entries)).toBe(1);
    });

    it("keeps DELIVERED in flight for the thread, and drops ACKNOWLEDGED", () => {
      // Delivered means the text was handed over; until the agent confirms, "did it land?" is still
      // open, and that open question is precisely what the founder could not see. An ack is written
      // evidence, so the thread stops owing the reader a placeholder for it.
      expect(inFlight(entries).map((e) => e.id)).toEqual(["m1", "m2"]);
      expect(inFlight([]).length).toBe(0);
    });

    it("returns the SAME array when nothing is acknowledged, so the thread does not re-render", () => {
      const live = [entry({ id: "m1" }), entry({ id: "m2", state: "delivered" })];
      expect(inFlight(live)).toBe(live);
    });
  });
});
