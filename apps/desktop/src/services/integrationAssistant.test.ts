// The integration assistant's pure decisions, and the four command names its wrappers send.
//
// The rule under test that matters most is `nextActionable`: a SEQUENTIAL plan is only safe when it
// is executed sequentially, and "show me what's green" is the rendering that breaks it.
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  GATE_BLOCKED,
  GATE_READY,
  gateBranch,
  gateTone,
  isReady,
  mergeBranch,
  nextActionable,
  planIntegration,
  readIntegrationStatus,
  summarizeQueue,
  type GateReport,
  type QueueEntry,
} from "./integrationAssistant";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
const invokeMock = vi.mocked(invoke);

function gate(verdict: string, extra: Partial<GateReport> = {}): GateReport {
  return {
    branch: "b",
    pr: 1,
    verdict,
    reason: verdict === GATE_READY ? null : "because",
    checks: "pass",
    roborevBlocking: 0,
    localGate: "not-run",
    ...extra,
  };
}

function entry(branch: string, position: number, over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    branch,
    pr: position,
    position,
    changedFiles: 1,
    overlapsWith: [],
    externalOverlap: null,
    prDraft: null,
    gate: null,
    outcome: null,
    busy: false,
    ...over,
  };
}

describe("isReady / gateTone — asked as a property, never as membership", () => {
  it("treats only the ready verdict as a pass, and an unrecognised one as unknown", () => {
    expect(isReady(gate(GATE_READY))).toBe(true);
    expect(isReady(gate(GATE_BLOCKED))).toBe(false);
    // THE DIRECTION THAT MATTERS: a verdict this build has never heard of must not read as green.
    // `verdict !== "blocked"` would have passed it, and would stop covering the moment a fourth
    // verdict is added on the Rust side.
    expect(isReady(gate("wibble"))).toBe(false);
    expect(gateTone(gate("wibble"))).toBe("unknown");
    expect(isReady(null)).toBe(false);
    expect(gateTone(null)).toBe("unknown");
    expect(gateTone(gate(GATE_READY))).toBe("ready");
    expect(gateTone(gate(GATE_BLOCKED))).toBe("blocked");
  });
});

describe("nextActionable — the head of the queue is the only candidate", () => {
  it("refuses to offer a READY branch further down while an earlier one is unmerged", () => {
    // THE WHOLE POINT. Position 1 is blocked, position 3 is green. A UI that offered position 3
    // would invite exactly the out-of-order merge the plan's ORDER exists to prevent — every merge
    // moves the base under the rest of the queue, so position 3's green verdict is evidence about
    // a base that stops existing the moment 1 and 2 land.
    const entries = [
      entry("first", 1, { gate: gate(GATE_BLOCKED) }),
      entry("second", 2, { gate: null }),
      entry("third", 3, { gate: gate(GATE_READY) }),
    ];
    const { entry: actionable, reason } = nextActionable(entries);
    expect(actionable).toBeNull();
    expect(reason).toContain("first");
    expect(reason).toContain("blocked");
    // …and it says WHY nothing behind it can go first, which is the part a reader needs to not
    // conclude the panel is broken.
    expect(reason).toContain("moves the base");
  });

  it("offers the head once it is ready, and moves on after the head has LANDED", () => {
    // The positive pair. Without it, the test above would pass for a function that always answers
    // null — which is the failure mode a purely negative assertion cannot see.
    const ready = entry("first", 1, { gate: gate(GATE_READY) });
    expect(nextActionable([ready, entry("second", 2, { gate: gate(GATE_READY) })]).entry?.branch).toBe(
      "first",
    );

    // LANDED means ancestry proved it. A merge outcome that did NOT land keeps the head where it
    // is: the merge command's own claim is not what advances the queue.
    const claimed = entry("first", 1, {
      gate: gate(GATE_READY),
      outcome: { branch: "first", pr: 1, landed: false, refusal: null, headSha: "a", cleanup: "x" },
    });
    expect(nextActionable([claimed, entry("second", 2, { gate: gate(GATE_READY) })]).entry?.branch).toBe(
      "first",
    );
    const landed = {
      ...claimed,
      outcome: { branch: "first", pr: 1, landed: true, refusal: null, headSha: "a", cleanup: "x" },
    };
    expect(nextActionable([landed, entry("second", 2, { gate: gate(GATE_READY) })]).entry?.branch).toBe(
      "second",
    );
  });

  it("holds while the head is ungated or already running, naming which entry holds the line", () => {
    expect(nextActionable([entry("first", 1)]).reason).toContain("has not been gated");
    expect(nextActionable([entry("first", 1, { gate: gate(GATE_READY), busy: true })]).entry).toBeNull();
    expect(nextActionable([]).reason).toBe("nothing is queued");
  });
});

describe("summarizeQueue", () => {
  it("counts landed by ancestry, not by a merge having been attempted", () => {
    const entries = [
      entry("a", 1, {
        gate: gate(GATE_READY),
        outcome: { branch: "a", pr: 1, landed: true, refusal: null, headSha: null, cleanup: "" },
      }),
      // Attempted and refused: NOT landed, and not counted as ready either.
      entry("b", 2, {
        gate: gate(GATE_BLOCKED),
        outcome: {
          branch: "b",
          pr: 2,
          landed: false,
          refusal: { reason: "r", remedy: "m" },
          headSha: null,
          cleanup: "",
        },
      }),
      entry("c", 3, { gate: gate(GATE_READY) }),
      entry("d", 4),
    ];
    expect(summarizeQueue(entries)).toBe("4 queued · 1 landed · 1 ready · 1 not ready · 1 ungated");
  });
});

describe("IPC wrappers", () => {
  it("send the four registered command names with the arguments the Rust side declares", async () => {
    // A wrapper that sends the wrong command name compiles clean and fails only at runtime with
    // "command not found" — the exact hole `scripts/lib/tauri-handler-guard.sh` exists for on the
    // other side of the wire. Pin the strings.
    invokeMock.mockClear();
    await planIntegration({ root: "/r", projectId: "p", base: "origin/main", candidates: [] });
    await gateBranch({ root: "/r", branch: "b", pr: 9 });
    await mergeBranch({ root: "/r", projectId: "p", branch: "b", pr: 9 });
    await readIntegrationStatus("/r");
    expect(invokeMock.mock.calls.map((c) => c[0])).toEqual([
      "integration_plan",
      "integration_gate",
      "integration_merge",
      "integration_status",
    ]);
    expect(invokeMock.mock.calls[0]?.[1]).toEqual({
      root: "/r",
      projectId: "p",
      base: "origin/main",
      candidates: [],
    });
    expect(invokeMock.mock.calls[3]?.[1]).toEqual({ root: "/r" });
  });
});
