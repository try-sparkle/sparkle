// DOES A WRITER EXIST? — the question `AgentSidebar.sparkleRow.test.tsx`'s "is GREEN while running"
// structurally cannot ask.
//
// That test's `seed()` writes `useRuntimeStore.setState({ status })` keyed by `SPARKLE_AGENT_ID`
// itself, so it ASSUMES the writer and proves only the render pipeline downstream of it. The bug it
// was green through was a WRITER-COVERAGE HOLE: both existing producers of that key can be absent
// while the pass child keeps working, so the row fell to a gray `?? "stopped"` with nothing able to
// retract it. Every assertion below is therefore on the SIDE EFFECT — the value sitting in
// `runtimeStore.status["__sparkle_self__"]` after the production entry point ran — and nothing here
// seeds that key on the raise paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { AgentTabStatus } from "../types";
import { useRuntimeStore } from "../stores/runtimeStore";
import { SPARKLE_AGENT_ID } from "./sparkleAgent";
import {
  pollImprovePassLiveness,
  resetImprovePassLiveness,
  type ImprovePassLiveness,
} from "./improvePassLiveness";
import {
  resetImproveDutyForTests,
  useImproveDutyStore,
} from "./improveDutySnapshot";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

/** The wire payload, spelled the way the Rust side ACTUALLY sends it: `elapsedMs` is backed by an
 *  `Option<u64>` with no `skip_serializing_if`, so the key is PRESENT and carries `null` when no
 *  pass occupies the slot. Omitting it here would test a shape the wire cannot produce. */
function reading(active: boolean, elapsedMs: number | null): ImprovePassLiveness {
  return { active, elapsedMs };
}

/** Put the store into the state the defect is reported from, WITHOUT touching the sparkle status
 *  key unless a case is explicitly about a value a producer already left there. */
function store(opts: { open?: boolean; status?: AgentTabStatus } = {}): void {
  useRuntimeStore.setState({
    openAgentIds: opts.open ? [SPARKLE_AGENT_ID] : [],
    status: opts.status ? { [SPARKLE_AGENT_ID]: opts.status } : {},
  });
}

const rowStatus = (): AgentTabStatus | undefined =>
  useRuntimeStore.getState().status[SPARKLE_AGENT_ID];

/** What the row's hover text is allowed to say about the pass's age, as this poll publishes it. */
const elapsed = (): number | null => useImproveDutyStore.getState().passElapsedMs;

beforeEach(() => {
  invokeMock.mockReset();
  resetImprovePassLiveness();
  resetImproveDutyForTests();
  store();
});

describe("the pinned Improve Sparkle row's process-driven status writer", () => {
  it("raises the row to working from a live pass child with the pane CLOSED and no status ever written", async () => {
    // The post-reload shape: the child survives, the module latch and every listener are gone, so
    // NOTHING has written this key. Before this writer existed the row read `?? "stopped"` — gray.
    expect(rowStatus()).toBeUndefined();
    invokeMock.mockResolvedValue(reading(true, 12_345));

    await pollImprovePassLiveness();

    expect(invokeMock).toHaveBeenCalledWith("sparkle_improve_active");
    expect(rowStatus()).toBe("working");
  });

  it("raises the row off the resting value a DETACHED pane froze it at", async () => {
    // The other absent-producer shape: the pane unmounted, its status engine detached, and the key
    // is stuck at the last thing it said while the PTY kept running.
    store({ status: "idle" });
    invokeMock.mockResolvedValue(reading(true, 60_000));

    await pollImprovePassLiveness();

    expect(rowStatus()).toBe("working");
  });

  it("does NOT force working when no pass child is alive — the resting status stands", async () => {
    store({ status: "idle" });
    invokeMock.mockResolvedValue(reading(false, null));

    await pollImprovePassLiveness();

    expect(rowStatus()).toBe("idle");
  });

  it("does NOT invent a status when nothing has written one and no child is alive", async () => {
    invokeMock.mockResolvedValue(reading(false, null));

    await pollImprovePassLiveness();

    expect(rowStatus()).toBeUndefined();
  });

  it("releases back to the value it displaced once the child is gone", async () => {
    store({ status: "stopped" });
    invokeMock.mockResolvedValue(reading(true, 1_000));
    await pollImprovePassLiveness();
    expect(rowStatus()).toBe("working");

    invokeMock.mockResolvedValue(reading(false, null));
    await pollImprovePassLiveness();

    // Not pinned green: with the process gone the pre-existing producers' resting value wins again.
    expect(rowStatus()).toBe("stopped");
  });

  it("never retracts a status a REAL producer wrote while it held the row up", async () => {
    invokeMock.mockResolvedValue(reading(true, 1_000));
    await pollImprovePassLiveness();
    expect(rowStatus()).toBe("working");
    // The pass's own transcript watcher speaks mid-flight.
    useRuntimeStore.getState().setStatus(SPARKLE_AGENT_ID, "approval");

    invokeMock.mockResolvedValue(reading(false, null));
    await pollImprovePassLiveness();

    expect(rowStatus()).toBe("approval");
  });

  it("does not overwrite an attention status while the child is alive", async () => {
    store({ status: "blocked" });
    invokeMock.mockResolvedValue(reading(true, 1_000));

    await pollImprovePassLiveness();

    expect(rowStatus()).toBe("blocked");
  });

  it("STILL RAISES for an id that is in openAgentIds — nothing ever removes this one from that set", async () => {
    // The inert-on-arrival trap. There is no `close(SPARKLE_AGENT_ID)` anywhere, the set is
    // persisted across relaunch, and the boot reconcile re-whitelists the main window's own id — so
    // this id stays in `openAgentIds` forever once the pane has been opened even once. A writer that
    // stood down on that signal would ship looking correct and do nothing for most users.
    store({ open: true, status: "idle" });
    invokeMock.mockResolvedValue(reading(true, 1_000));

    await pollImprovePassLiveness();

    expect(rowStatus()).toBe("working");
  });

  it("STILL RETRACTS for an id that is in openAgentIds — a stuck green wedges the hourly pass", async () => {
    // The trap on the other side, and it costs more than a wrong dot: this key is an INPUT to
    // `passHoldReason`, where `working` holds the hourly slot and eventually reads `pane-wedged`. A
    // retraction vetoed on the same never-clearing flag would disable the improvement duty for good
    // and blame a pane that was never the cause.
    store({ open: true });
    invokeMock.mockResolvedValue(reading(true, 1_000));
    await pollImprovePassLiveness();
    expect(rowStatus()).toBe("working");

    invokeMock.mockResolvedValue(reading(false, null));
    await pollImprovePassLiveness();

    expect(rowStatus()).not.toBe("working");
  });

  it("does not retract a `working` a producer RE-ASSERTED — the case no value comparison can see", async () => {
    // THE PANE-MOUNT WINDOW, and the one shape that defeats every reader downstream of the store.
    // `setStatus` bails out on an identical value and zustand then fires NO listener, so the pane's
    // engine reporting `working` on construction over our `working` leaves the map byte-identical
    // and notifies nobody. A guard that compares values — or subscribes for changes — cannot tell it
    // from no write at all, and retracts a live pane's green to a resting value.
    //
    // Note there is exactly ONE write below and it changes nothing observable in the store. Any
    // intermediate value here (idle, then working) would make this the ordinary
    // "a producer spoke since" path, which the value check already covers — i.e. it would route
    // around the case the guard exists for, and pass against an implementation that has the bug.
    invokeMock.mockResolvedValue(reading(true, 1_000));
    await pollImprovePassLiveness();
    expect(rowStatus()).toBe("working");
    const before = useRuntimeStore.getState().status;

    useRuntimeStore.getState().setStatus(SPARKLE_AGENT_ID, "working");
    expect(useRuntimeStore.getState().status).toBe(before); // byte-identical: the store no-op'd

    invokeMock.mockResolvedValue(reading(false, null));
    await pollImprovePassLiveness();

    expect(rowStatus()).toBe("working");
  });

  it("still retracts when the ONLY writer was itself — a raise is not mistaken for a producer", async () => {
    // The other direction of the same counter, and what stops it from being a rubber stamp: a
    // guard that always declined would pin the row green with nothing behind it, which is the
    // hourly-pass wedge two commits back.
    store({ status: "idle" });
    invokeMock.mockResolvedValue(reading(true, 1_000));
    await pollImprovePassLiveness();
    await pollImprovePassLiveness(); // a re-poll while still active must not spend the generation
    expect(rowStatus()).toBe("working");

    invokeMock.mockResolvedValue(reading(false, null));
    await pollImprovePassLiveness();

    expect(rowStatus()).toBe("idle");
  });

  it("never retracts a green it did not write", async () => {
    // A producer already had the row green when we arrived, so we hold nothing and own nothing —
    // writing anything on the falling edge would be retracting somebody else's word.
    store({ status: "working" });
    invokeMock.mockResolvedValue(reading(true, 1_000));
    await pollImprovePassLiveness();

    invokeMock.mockResolvedValue(reading(false, null));
    await pollImprovePassLiveness();

    expect(rowStatus()).toBe("working");
  });

  it("re-raises a row that fell back to gray while the child is still alive", async () => {
    invokeMock.mockResolvedValue(reading(true, 1_000));
    await pollImprovePassLiveness();
    expect(rowStatus()).toBe("working");

    // Something parks the row while the pass is still running — the defect, one poll later.
    useRuntimeStore.getState().setStatus(SPARKLE_AGENT_ID, "stopped");
    await pollImprovePassLiveness();

    expect(rowStatus()).toBe("working");
  });

  it("holds the row up through a reading it could not take — a failed probe is not evidence the child died", async () => {
    // The dangerous half of "fail toward current behaviour": a throw must be treated as NO reading,
    // not as `active: false`. Read as false it would release the hold and drag a genuinely working
    // agent back to gray on nothing more than a transient invoke failure.
    invokeMock.mockResolvedValue(reading(true, 1_000));
    await pollImprovePassLiveness();
    expect(rowStatus()).toBe("working");

    invokeMock.mockRejectedValue(new Error("ipc hiccup"));
    await pollImprovePassLiveness();

    expect(rowStatus()).toBe("working");
  });

  it("fails toward the CURRENT behaviour when the reading cannot be taken", async () => {
    store({ status: "stopped" });
    invokeMock.mockRejectedValue(new Error("command not found"));

    await expect(pollImprovePassLiveness()).resolves.toBeUndefined();

    expect(rowStatus()).toBe("stopped");
  });

  // ── THE AMBER TIER, WHICH IS CALM RATHER THAN ADDRESSED TO ANYONE ────────────────────────────
  it("raises the row off `lapsed` — amber describes the LAST pass, not the live one", () => {
    // `lapsed` means "unfinished, and finishing it is not your job". A row still wearing the
    // previous pass's amber while THIS pass's child is demonstrably alive is describing the wrong
    // pass, and green is the truer answer.
    store({ status: "lapsed" });
    invokeMock.mockResolvedValue(reading(true, 90_000));

    return pollImprovePassLiveness().then(() => {
      expect(rowStatus()).toBe("working");
    });
  });

  // ⚠️ REQUIRED GUARD. A quota wall and a park that has declined the same way three hours running
  // land on this row as `blocked` / `errored`. A green raise over either would hide the ONE state
  // only the founder can clear — and the recurring shape of this bug is exactly a red quietly
  // re-derived into something calmer.
  it.each(["blocked", "errored"] as AgentTabStatus[])(
    "NEVER paints green over a red `%s` row, however alive the child looks",
    async (status) => {
      store({ status });
      invokeMock.mockResolvedValue(reading(true, 5 * 60_000));

      await pollImprovePassLiveness();
      await pollImprovePassLiveness();

      expect(rowStatus()).toBe(status);
    },
  );

  // ── THE HALF OF THE READING THAT USED TO BE THROWN AWAY ──────────────────────────────────────
  describe("the pass's elapsed clock", () => {
    it("publishes how long the live child has been running", async () => {
      expect(elapsed()).toBeNull();
      invokeMock.mockResolvedValue(reading(true, 12 * 60_000));

      await pollImprovePassLiveness();

      // Before this, `active` was read and `elapsedMs` discarded, so a hung pass sat green with no
      // indication at all until STALE_PASS_MAX (35 minutes) flipped `active` to false.
      expect(elapsed()).toBe(12 * 60_000);
    });

    it("clears the clock the moment no child is live", async () => {
      invokeMock.mockResolvedValue(reading(true, 12 * 60_000));
      await pollImprovePassLiveness();

      invokeMock.mockResolvedValue(reading(false, null));
      await pollImprovePassLiveness();

      expect(elapsed()).toBeNull();
    });

    it("does not report a STALE pass's age — past the ceiling it is not a pass this row reports", async () => {
      // Rust keeps sending `elapsedMs` past STALE_PASS_MAX (deliberately, so a caller can tell
      // "nothing running" from "running but stale"). Reporting that number would label a row green
      // that this writer has already released.
      invokeMock.mockResolvedValue(reading(false, 40 * 60_000));

      await pollImprovePassLiveness();

      expect(elapsed()).toBeNull();
    });

    it("keeps the last good reading through a probe it could not take", async () => {
      // Same rule as the status hold above: a failed probe is not evidence the child died, so
      // blanking "12m into this pass" on a transient IPC hiccup would be inventing a fact.
      invokeMock.mockResolvedValue(reading(true, 12 * 60_000));
      await pollImprovePassLiveness();

      invokeMock.mockRejectedValue(new Error("ipc hiccup"));
      await pollImprovePassLiveness();

      expect(elapsed()).toBe(12 * 60_000);
    });

    it("carries a null `elapsedMs` on a live child without inventing a number", async () => {
      // The wire shape says the key is ALWAYS present and may be null. Null means "no age known",
      // and the paint engine's rule 2 is keyed on `!= null` precisely so that reads as no label.
      invokeMock.mockResolvedValue(reading(true, null));

      await pollImprovePassLiveness();

      expect(rowStatus()).toBe("working");
      expect(elapsed()).toBeNull();
    });
  });
});
