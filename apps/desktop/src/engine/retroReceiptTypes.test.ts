import { describe, it, expect } from "vitest";
import {
  NO_RETRO_REASONS,
  isNoRetroReason,
  retroSettled,
  RETRO_RECEIPT_STORE_VERSION,
  type RetroReceipt,
} from "./retroReceiptTypes";

describe("the no-retro reason vocabulary is CLOSED", () => {
  // Pinned by value, not by length. The vocabulary is duplicated into the agent persona
  // (buildAgent.retroEmissionProtocol) and into the Rust receipt store's deserializer, so a silent
  // addition here would leave an agent able to declare a reason those two cannot round-trip. When
  // this test fails, that is the signal to update the persona and the Rust enum in the same change
  // — not to widen the expectation.
  it("is exactly the five reasons the persona teaches", () => {
    expect([...NO_RETRO_REASONS]).toEqual([
      "no-changes",
      "absorbed",
      "superseded",
      "nothing-to-report",
      "other",
    ]);
  });

  it("does NOT contain a 'frictionless' escape hatch", () => {
    // The single most important absence in this file. A frictionless run is a retro with
    // `painPoints: []` — a CAPTURED receipt — not an excuse. If a reason code for it ever appears,
    // the most common good outcome silently becomes the one class of claim nothing can verify.
    for (const forbidden of ["frictionless", "no-friction", "nothing-worth-reporting", "clean"]) {
      expect(NO_RETRO_REASONS as readonly string[]).not.toContain(forbidden);
    }
  });

  it("accepts every listed reason and rejects anything else", () => {
    for (const r of NO_RETRO_REASONS) expect(isNoRetroReason(r)).toBe(true);
    for (const bad of ["", "No-Changes", "dunno", "absorbed ", 3, null, undefined, {}]) {
      expect(isNoRetroReason(bad)).toBe(false);
    }
  });
});

describe("retroSettled is FAIL-CLOSED", () => {
  const captured: RetroReceipt = {
    state: "captured",
    at: 1_700_000_000_000,
    source: "pr-marker",
    painPointCount: 0,
  };

  it("treats a missing receipt as NOT settled", () => {
    // "We have not been told" must never read as "it completed the step". Every consumer that
    // recommends retirement keys on this, so an absence that answered `true` would recommend
    // retiring an agent nobody ever heard from.
    expect(retroSettled(undefined)).toBe(false);
  });

  it("treats a NULL receipt as NOT settled — absence arrives from Rust as null (roborev 58719)", () => {
    // The bug this test exists for: `retroSettled` was `receipt !== undefined`, and the receipt is
    // read across the Tauri boundary where a Rust `Option::None` serializes to JSON `null`.
    // `undefined` has no JSON representation, so the ONLY absence this function ever actually sees
    // in production is the one the strict check let through — it answered `true` for every agent
    // with no receipt at all, inverting the fail-closed rule the whole gate rests on.
    expect(retroSettled(null)).toBe(false);
  });

  it("is unfooled by a JSON round-trip, which is how the value really arrives", () => {
    // Belt and braces against the same class: assert on a value that has actually been through
    // JSON, rather than a hand-built literal that only resembles one. A hand-built fixture is what
    // made the original check look correct.
    const fromRust = JSON.parse(JSON.stringify({ receipt: null })) as { receipt: RetroReceipt | null };
    expect(retroSettled(fromRust.receipt)).toBe(false);
    const present = JSON.parse(JSON.stringify({ receipt: captured })) as { receipt: RetroReceipt | null };
    expect(retroSettled(present.receipt)).toBe(true);
  });

  it("counts a retro with ZERO pain points as settled", () => {
    // The whole reason the receipt exists. Before it, a frictionless retro left no trace at all and
    // was indistinguishable on disk from an agent that never ran one.
    expect(captured.painPointCount).toBe(0);
    expect(retroSettled(captured)).toBe(true);
  });

  it("counts an excused and an overridden receipt as settled", () => {
    expect(retroSettled({ state: "excused", at: 1, source: "agent-declared", reasonCode: "no-changes" })).toBe(true);
    expect(retroSettled({ state: "overridden", at: 1, source: "human-override", reasonCode: "other" })).toBe(true);
  });
});

describe("the on-disk store version", () => {
  it("is 1 — bump it only alongside a migration in retro_receipt.rs", () => {
    expect(RETRO_RECEIPT_STORE_VERSION).toBe(1);
  });
});
