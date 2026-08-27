// THE BINDING'S TWO PROMISES: every push is verified, and the concierge is a real target.
//
// These assert the SIDE EFFECT — what actually reached the transport, and what `send` reported back
// — rather than that the deps object has the right keys. `deps.send` resolving true is the event
// that spends one of four hourly slots and advances a four-hour cooldown, so a false positive costs
// a real message about a real condition; that is the thing worth pinning.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOCKER_ASK } from "@sparkle/core";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { buildPusherDeps, CONCIERGE_RECIPIENT_ID } from "./pusherMount";
import { useProjectStore } from "../stores/projectStore";
import {
  _resetConciergeNotifierForTests,
  setConciergeNotifier,
  notifyConcierge,
  conciergeNotifierAvailable,
  clearConciergeNotifier,
} from "./conciergeNotifier";

/** `inbox_send` accepts and `inbox_status` reports the id pending — the happy path. */
function transportDelivers() {
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "inbox_send") return "msg-1";
    if (cmd === "inbox_status") {
      const ids = args.agentIds as string[];
      return ids.map((agentId) => ({ agentId, pending: 1, pendingIds: ["msg-1"], delivered: 0 }));
    }
    throw new Error(`unexpected ${cmd}`);
  });
}

beforeEach(() => {
  invoke.mockReset();
  _resetConciergeNotifierForTests();
});
afterEach(() => {
  _resetConciergeNotifierForTests();
});

describe("pushing a build agent — verified, or it did not happen", () => {
  it("queues the push and confirms the id is really in that agent's queue", async () => {
    transportDelivers();
    const ok = await buildPusherDeps().send("a1", "Your goal expired 3h 12m ago.");
    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("inbox_send", expect.objectContaining({ agentId: "a1" }));
    expect(invoke).toHaveBeenCalledWith("inbox_status", { agentIds: ["a1"] });
  });

  it("reports FAILURE when the id is not in the queue we just wrote to", async () => {
    // The exact shape of sparkle-bbghz: ok:true with a distinct messageId, and a follow-up status
    // read showing pending 0. Before this check the Pusher would have spent a slot and advanced a
    // four-hour cooldown for a message that does not exist.
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "inbox_send") return "msg-1";
      return (args.agentIds as string[]).map((agentId) => ({
        agentId,
        pending: 0,
        pendingIds: [],
        delivered: 0,
      }));
    });
    expect(await buildPusherDeps().send("a1", "text")).toBe(false);
  });

  it("counts an already-CLAIMED message as delivered, not as lost", async () => {
    // The one benign way the id can be missing from pendingIds: the agent's Stop hook drained it
    // between our write and our read. Treating that as a failure would re-send a message the agent
    // has already read.
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "inbox_send") return "msg-1";
      return (args.agentIds as string[]).map((agentId) => ({
        agentId,
        pending: 0,
        pendingIds: [],
        delivered: 1,
      }));
    });
    expect(await buildPusherDeps().send("a1", "text")).toBe(true);
  });

  it("reports FAILURE when the queue could not be read — could not look is not did not land", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "inbox_send") return "msg-1";
      throw new Error("bridge request timeout: inbox_status");
    });
    expect(await buildPusherDeps().send("a1", "text")).toBe(false);
  });

  it("reports FAILURE when the send itself is refused, without claiming a read", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "inbox_send") throw new Error("inbox: a1 already has 50 undelivered messages");
      throw new Error("should not have looked");
    });
    expect(await buildPusherDeps().send("a1", "text")).toBe(false);
  });

  it("appends the blocker ask, so the answer comes back machine-readable", async () => {
    // Without this the challenge lands, the agent narrates, and nothing reads what it said — which
    // is the half of the loop that did not exist.
    transportDelivers();
    await buildPusherDeps().send("a1", "Your branch has held unlanded work for 41 minutes.");
    const [, args] = invoke.mock.calls.find(([c]) => c === "inbox_send")!;
    const text = (args as { text: string }).text;
    expect(text).toContain("Your branch has held unlanded work for 41 minutes.");
    expect(text).toContain(BLOCKER_ASK);
    expect(text).toContain("```sparkle-blocker");
  });
});

describe("pushing the concierge — the target that did not exist", () => {
  it("routes to the registered sink instead of an inbox the concierge does not have", async () => {
    const seen: string[] = [];
    setConciergeNotifier((t) => {
      seen.push(t);
      return true;
    });
    const ok = await buildPusherDeps().send(CONCIERGE_RECIPIENT_ID, "Agent A is quota-walled.");
    expect(ok).toBe(true);
    expect(seen).toEqual(["Agent A is quota-walled."]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does NOT append the blocker ask — the concierge is not the one being asked", async () => {
    const seen: string[] = [];
    setConciergeNotifier((t) => {
      seen.push(t);
      return true;
    });
    await buildPusherDeps().send(CONCIERGE_RECIPIENT_ID, "Agent A is quota-walled.");
    expect(seen[0]).not.toContain("```sparkle-blocker");
  });

  it("reports FAILURE when no window is listening, so the finding stays owed", async () => {
    expect(await buildPusherDeps().send(CONCIERGE_RECIPIENT_ID, "anything")).toBe(false);
  });

  it("reports FAILURE when the sink is listening but REFUSES the finding", async () => {
    // THE HOLE THIS CLOSES (bead sparkle-qogah). A registered sink was proof enough: `notifyConcierge`
    // called it and returned `true` whatever it did, so a scheduler that discarded the text on its
    // own `disposed` guard — or by truncating its owed list — was reported here as a delivery.
    // `sweepPushers` takes the `delivered` branch on that `true`: it spends one of four hourly slots
    // and stamps the condition as reported for FOUR HOURS. So the destroyed finding was ALSO
    // suppressed at source, by the very call that destroyed it.
    //
    // Asserted on what `send` reports — the value `sweepPushers` actually branches on — rather than
    // on the sink having been called, which was true in the broken build too.
    setConciergeNotifier(() => false);
    expect(await buildPusherDeps().send(CONCIERGE_RECIPIENT_ID, "Agent A is quota-walled.")).toBe(
      false,
    );
  });

  it("still reports SUCCESS when the sink accepts, so a real delivery is not retried forever", async () => {
    // The other half of the same contract: an honest `false` is only worth anything if `true` still
    // means what it says. A sink that accepts must not be re-offered the same finding next sweep.
    setConciergeNotifier(() => true);
    expect(await buildPusherDeps().send(CONCIERGE_RECIPIENT_ID, "Agent A is quota-walled.")).toBe(
      true,
    );
  });

  it("every project reports to the concierge", () => {
    const deps = buildPusherDeps();
    expect(deps.reportRecipient("p1")).toBe(CONCIERGE_RECIPIENT_ID);
    expect(deps.reportRecipient("p2")).toBe(CONCIERGE_RECIPIENT_ID);
  });

  it("reads the concierge's mailbox as EMPTY, or the report would yield every cycle", async () => {
    // `sweepPushers` treats an ABSENT usage entry as FULL (fail-closed), and the concierge has no
    // inbox to report one. Left absent, the fleet report would be suppressed forever and the
    // concierge would never be told anything — silent, and indistinguishable from a calm fleet.
    invoke.mockResolvedValue([{ agentId: "a1", pending: 3 }]);
    const usage = await buildPusherDeps().inboxUsage(["a1"]);
    expect(usage.get("a1")).toBe(3);
    expect(usage.get(CONCIERGE_RECIPIENT_ID)).toBe(0);
  });

  it("costs ONE batched status call for the whole fleet", async () => {
    invoke.mockResolvedValue([]);
    await buildPusherDeps().inboxUsage(["a1", "a2", "a3"]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("inbox_status", { agentIds: ["a1", "a2", "a3"] });
  });
});

describe("the notifier registration", () => {
  it("says so when nobody is listening rather than swallowing the push", () => {
    expect(conciergeNotifierAvailable()).toBe(false);
    expect(notifyConcierge("hello")).toBe(false);
  });

  it("treats a throwing sink as a failed delivery, not a crashed sweep", () => {
    setConciergeNotifier(() => {
      throw new Error("scheduler is gone");
    });
    expect(notifyConcierge("hello")).toBe(false);
  });

  it("survives a remount, where the new mount runs before the old cleanup", () => {
    // React's strict-mode double-invoke and any remount order the effects this way. An unguarded
    // clear would leave the SURVIVOR unregistered — the concierge silently unreachable for the rest
    // of the session, which is the failure this whole branch is about.
    const oldSink = vi.fn(() => true);
    const newSink = vi.fn(() => true);
    setConciergeNotifier(oldSink);
    setConciergeNotifier(newSink); // new mount
    clearConciergeNotifier(oldSink); // old cleanup, arriving late
    expect(notifyConcierge("hello")).toBe(true);
    // The KIND rides along now (services/conciergeProactive.NoticeKind). A Pusher finding is the
    // default, and asserting it here rather than loosening the matcher keeps this test's real
    // subject — WHICH sink survived the remount — while pinning that the default did not drift:
    // a report reaching the Pusher's "act on each one now" preamble would tell the concierge to
    // go and undo work that already finished.
    // The third slot is the delivery-time revalidator (bead sparkle-st06sq): absent for this notice.
    expect(newSink).toHaveBeenCalledWith("hello", "pusher", undefined);
    expect(oldSink).not.toHaveBeenCalled();
  });

  it("a sink that clears itself really is cleared", () => {
    const sink = vi.fn();
    setConciergeNotifier(sink);
    clearConciergeNotifier(sink);
    expect(notifyConcierge("hello")).toBe(false);
  });
});

describe("the sweep's receipt cache — warmed for EVERY project, not just the open one", () => {
  it("asks for each project's receipts before mapping snapshots", async () => {
    // roborev 59899. `retirableAgents` now requires an affirmative `retroSettled`, and the lookup
    // reads a module cache the SIDEBAR fills — inside a `projectId`-scoped effect, so only the open
    // project is ever loaded. The Pusher sweeps every project, so for all the others the lookup
    // answered `undefined` (⇒ false) and `done-not-retired` was permanently silent regardless of
    // what was on disk. FAILS against the pre-change binding, which issued no `retro_receipt_all`
    // at all.
    invoke.mockImplementation(async () => ({}));
    useProjectStore.setState({
      projects: [
        { id: "p1", name: "One", rootPath: "/tmp/one", defaultBranch: "main",
          createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [] },
        { id: "p2", name: "Two", rootPath: "/tmp/two", defaultBranch: "main",
          createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [] },
      ],
    } as never);

    buildPusherDeps().snapshots();

    // The SIDE EFFECT — which projects were actually asked about — not that the dep exists.
    const asked = invoke.mock.calls
      .filter(([cmd]) => cmd === "retro_receipt_all")
      .map(([, args]) => (args as { projectId: string }).projectId);
    expect(new Set(asked)).toEqual(new Set(["p1", "p2"]));
  });
});
