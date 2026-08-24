// The TypeScript half of the `history_record` Rust→TS seam pin, plus the defensive-parse contract.
//
// WHY THIS FILE EXISTS. Two suites either side of one wire stay green even when the wire is broken:
// the Rust suite never parses a TS type and the TS suite never sees serde's output, so a re-cased
// field is invisible to both and the feature ships silently inert. AGENTS.md records that costing
// two agents an entire parallel build (bead sparkle-16y6h).
// `apps/desktop/shared/history-record-outcome.fixture.json` is the ONE payload both halves parse —
// `history.rs`'s `record_outcome_matches_the_shared_fixture` asserts serde PRODUCES and CONSUMES
// it, and this asserts the frontend READS it. Re-case a field on either side and BOTH go red.
//
// The second half of the file is the asymmetry that makes the alarm worth having: `collided: true`
// means "we threw away something the founder said", so a payload the parser merely failed to
// understand must never raise it.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { recordHistory, parseRecordOutcome, type RecordOutcome, type HistoryEntry } from "./history";

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../shared/history-record-outcome.fixture.json", import.meta.url)),
    "utf8",
  ),
) as {
  version: number;
  outcomes: { case: string; why: string; wire: Record<string, unknown> }[];
};

/** The verdict each fixture case is supposed to mean, spelled out here rather than read off the
 *  fixture — so a fixture whose booleans were swapped cannot agree with itself into green. */
const EXPECTED: Record<string, RecordOutcome> = {
  inserted: { inserted: true, collided: false },
  duplicateIdenticalText: { inserted: false, collided: false },
  collidedDifferentText: { inserted: false, collided: true },
};

const entry = (id: string, text: string): HistoryEntry => ({
  id,
  kind: "prompt",
  source: "concierge",
  projectId: null,
  agentId: null,
  projectName: null,
  agentName: null,
  text,
  createdAt: 1_754_400_000_000,
});

beforeEach(() => {
  invoke.mockReset();
});

describe("the shared record-outcome fixture", () => {
  it("is the version both halves are pinned to", () => {
    expect(FIXTURE.version).toBe(1);
  });

  it("pins exactly the three reachable states, and never the unrepresentable fourth", () => {
    expect(FIXTURE.outcomes.map((o) => o.case).sort()).toEqual(
      ["collidedDifferentText", "duplicateIdenticalText", "inserted"].sort(),
    );
    // `inserted: true, collided: true` is unconstructable in Rust; it must never be pinned as real.
    expect(
      FIXTURE.outcomes.some((o) => o.wire.inserted === true && o.wire.collided === true),
    ).toBe(false);
  });

  // Reading the VALUES, not `toBeDefined()`: a field re-cased in the fixture (or in Rust, which is
  // the same edit) makes the parser see no `inserted`/`collided` key at all, so every case would
  // read {false,false} — and `inserted` and `collidedDifferentText` both go red on that.
  it("parses into the exact RecordOutcome each case means", () => {
    for (const o of FIXTURE.outcomes) {
      const expected = EXPECTED[o.case];
      expect(expected, `unknown fixture case ${o.case} — add it here deliberately`).toBeDefined();
      expect(parseRecordOutcome(o.wire), o.case).toEqual(expected);
    }
  });

  it("carries no nulls — both fields are plain Rust bools, never Options", () => {
    for (const o of FIXTURE.outcomes) {
      expect(Object.keys(o.wire).sort(), o.case).toEqual(["collided", "inserted"]);
      expect(typeof o.wire.inserted, o.case).toBe("boolean");
      expect(typeof o.wire.collided, o.case).toBe("boolean");
    }
  });
});

describe("recordHistory", () => {
  it("surfaces collided=true to its caller", async () => {
    invoke.mockResolvedValue({ inserted: false, collided: true });
    await expect(recordHistory(entry("m1", "beta replacement lines"))).resolves.toEqual({
      inserted: false,
      collided: true,
    });
    expect(invoke).toHaveBeenCalledWith("history_record", { entry: entry("m1", "beta replacement lines") });
  });

  it("surfaces a landed write and a benign identical re-capture distinctly", async () => {
    invoke.mockResolvedValue({ inserted: true, collided: false });
    await expect(recordHistory(entry("m1", "alpha"))).resolves.toEqual({
      inserted: true,
      collided: false,
    });
    invoke.mockResolvedValue({ inserted: false, collided: false });
    await expect(recordHistory(entry("m1", "alpha"))).resolves.toEqual({
      inserted: false,
      collided: false,
    });
  });

  // THE POINT OF THE DEFENSIVE PARSE. An older backend returns `null` from a command declared
  // `Result<(), String>`; a future one might return something else again. None of that is data
  // loss, and none of it may be reported as data loss.
  it.each([
    ["an older backend returning null", null],
    ["undefined", undefined],
    ["a bare string", "ok"],
    ["a number", 0],
    ["an empty object", {}],
    ["only one field", { inserted: true }],
    ["truthy-but-not-true values", { inserted: "true", collided: 1 }],
    ["null fields", { inserted: null, collided: null }],
    ["the unrepresentable both-true", { inserted: true, collided: true }],
  ])("yields the neutral outcome for %s, and does not throw", async (_label, payload) => {
    invoke.mockResolvedValue(payload);
    await expect(recordHistory(entry("m1", "alpha"))).resolves.toEqual({
      inserted: false,
      collided: false,
    });
  });

  it("propagates an invoke rejection (the store, not the service, decides to swallow it)", async () => {
    invoke.mockRejectedValue(new Error("history: DB unavailable (init failed at boot)"));
    await expect(recordHistory(entry("m1", "alpha"))).rejects.toThrow("DB unavailable");
  });
});
