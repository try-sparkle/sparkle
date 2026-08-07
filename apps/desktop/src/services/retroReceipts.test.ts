import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  cachedReceipt,
  loadRetroReceipts,
  recordRetroCaptured,
  recordRetroExcused,
  recordRetroOverridden,
  __resetRetroReceiptsForTest,
} from "./retroReceipts";

const PID = "p1";
const AID = "a1";
/** Long enough and specific enough to pass muster — see engine/retroMuster. */
const GOOD_REASON = "Absorbed into the parent branch before this agent committed anything of its own.";

beforeEach(() => {
  vi.clearAllMocks();
  __resetRetroReceiptsForTest();
  invoke.mockResolvedValue(undefined);
});

describe("recordRetroExcused ENFORCES muster — the excuse is the one state an agent writes about itself", () => {
  it("refuses a reason that fails muster and writes NOTHING", async () => {
    // The doc used to say "callers MUST run the muster check first" and nothing held anyone to it.
    // `state: "excused"` is self-reported by the agent being judged, so an unchecked excuse is the
    // one write that can retire a row on the strength of a sentence nobody vetted.
    const r = await recordRetroExcused(PID, AID, { reasonCode: "other", reasonText: "n/a" });

    // The VERDICT, not a boolean (roborev 59215): a rejected wording and a failed write need
    // opposite remedies, and `why` is what makes the re-ping actionable.
    expect(r.status).toBe("rejected");
    expect(r.status === "rejected" && r.why).toMatch(/too brief/);
    // Not "it returned false" — nothing reached disk and nothing reached the cache. A refusal that
    // still wrote would be the bug wearing a return value.
    //
    // Asserted against the COMMAND, not against "invoke was never called": `log.warn` forwards to
    // Rust through the same `invoke`, so a bare not-toHaveBeenCalled() here fails on the refusal's
    // own log line and would push the next person to delete the logging rather than the write.
    expect(invoke).not.toHaveBeenCalledWith("retro_receipt_record", expect.anything());
    expect(cachedReceipt(PID, AID)).toBeUndefined();
  });

  it("refuses a reason carrying a leaked SECRET, without recording it", async () => {
    // Assembled so no contiguous secret-shaped literal sits in this file. The receipt is written to
    // disk and rendered in a dialog, so muster's PII/secret filter is doing real work here.
    const leak = `Superseded; the old ${"AKIA"}${"JQ7RTNVX2PLMD3WB"} was rotated out before this.`;
    const r = await recordRetroExcused(PID, AID, { reasonCode: "superseded", reasonText: leak });

    expect(r.status).toBe("rejected");
    expect(r.status === "rejected" && r.why).toMatch(/key-shaped token/);
    expect(invoke).not.toHaveBeenCalledWith("retro_receipt_record", expect.anything());
  });

  it("records a well-formed reason", async () => {
    const r = await recordRetroExcused(PID, AID, {
      reasonCode: "absorbed",
      reasonText: GOOD_REASON,
    });

    expect(r.status).toBe("recorded");
    expect(cachedReceipt(PID, AID)).toMatchObject({
      state: "excused",
      source: "agent-declared",
      reasonCode: "absorbed",
    });
  });
});

describe("every failure reads as HAS NOT REPORTED", () => {
  it("does not cache a receipt whose write FAILED", async () => {
    // Optimistic caching would show RETIREMENT RECOMMENDED for a step that was never durably
    // recorded — and the row can be retired long after this process is gone.
    invoke.mockRejectedValue(new Error("disk full"));
    const ok = await recordRetroCaptured(PID, AID, { source: "pr-marker", painPointCount: 2 });

    expect(ok).toBe(false);
    expect(cachedReceipt(PID, AID)).toBeUndefined();
  });

  it("keeps receipts it already holds when a LOAD fails", async () => {
    invoke.mockResolvedValue(undefined);
    await recordRetroOverridden(PID, AID, { reasonText: "retired by the founder" });
    expect(cachedReceipt(PID, AID)).toBeTruthy();

    // A read failure must not manufacture a settled reading — and must not erase one either.
    invoke.mockRejectedValue(new Error("offline"));
    await loadRetroReceipts(PID);

    expect(cachedReceipt(PID, AID)).toMatchObject({ state: "overridden" });
  });

  it("REPLACES a project's map on a successful load rather than merging into it", async () => {
    invoke.mockResolvedValue(undefined);
    await recordRetroOverridden(PID, "stale", { reasonText: "retired by the founder" });

    invoke.mockResolvedValue({ fresh: { state: "captured", at: 1, source: "pr-marker", painPointCount: 0 } });
    await loadRetroReceipts(PID);

    expect(cachedReceipt(PID, "fresh")).toBeTruthy();
    // Merging would keep a stale entry alive if the store were ever reset out from under us.
    expect(cachedReceipt(PID, "stale")).toBeUndefined();
  });

  it("tells a failed WRITE apart from a rejected WORDING — the remedies are opposite", async () => {
    // Both used to be `false`. An agent handed the same message for both retries the exact wording
    // that was just refused, which is the one thing it must not do.
    invoke.mockRejectedValue(new Error("disk full"));
    const r = await recordRetroExcused(PID, AID, { reasonCode: "absorbed", reasonText: GOOD_REASON });

    expect(r.status).toBe("write-failed");
    expect(cachedReceipt(PID, AID)).toBeUndefined();
  });

  it("a zero pain-point retro is CAPTURED, not missing", async () => {
    // The whole reason the receipt exists: before it, a frictionless retro was indistinguishable on
    // disk from an agent that never ran one.
    const ok = await recordRetroCaptured(PID, AID, { source: "result-json", painPointCount: 0 });

    expect(ok).toBe(true);
    expect(cachedReceipt(PID, AID)).toMatchObject({ state: "captured", painPointCount: 0 });
  });
});
