// The TypeScript half of the scrubber rail's Rust→TS seam pin (bead sparkle-7m719).
//
// WHY THIS FILE EXISTS. Two suites either side of one wire are both green even when the wire is
// broken: the Rust suite never parses a TS type and the TS suite never sees serde's output, so a
// renamed field is invisible to both and the feature ships silently inert (AGENTS.md records this
// costing two agents an entire parallel build). `apps/desktop/shared/history-range-wire.json` is the
// ONE payload both halves parse — `history.rs`'s `range_row_shapes_match_the_shared_wire_fixture`
// asserts serde PRODUCES it, and this asserts the frontend READS it. Rename a field on either side
// and both go red.
//
// It also pins the two invoke arg maps, which the fixture cannot see: a command whose Rust
// parameter is `from_ms` is called from JS as `fromMs`, and getting that wrong fails at runtime
// only, in the app, with an error nobody's suite ever runs into.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  promptsInRange,
  entriesInRange,
  historyExtent,
  promptDensity,
  type PromptMarkerRow,
  type HistoryRangeRow,
  type HistoryExtent,
  type PromptBucket,
} from "./history";

const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../shared/history-range-wire.json", import.meta.url)),
    "utf8",
  ),
) as {
  version: number;
  promptMarker: Record<string, unknown>;
  rangeRow: Record<string, unknown>;
  // The second wave (bead sparkle-bjbhw6). `historyExtent`'s bounds are `number | null` — NOT
  // `number | undefined` — because that is what a Rust `Option` puts on the wire, and describing it
  // any other way here would defeat the purpose of parsing the shared fixture at all.
  historyExtent: { oldestMs: number | null; newestMs: number | null; count: number };
  historyExtentEmpty: { oldestMs: number | null; newestMs: number | null; count: number };
  promptBucket: {
    index: number;
    startMs: number;
    endMs: number;
    count: number;
    firstAtMs: number;
    newestAtMs: number;
    newestId: string;
    newestTextPrefix: string;
  };
};

beforeEach(() => {
  invoke.mockReset();
});

describe("the shared wire fixture", () => {
  it("is the version both halves are pinned to", () => {
    expect(FIXTURE.version).toBe(1);
  });

  // Read through the DECLARED TYPE, so a field renamed in services/history.ts stops compiling and a
  // field renamed in Rust (and therefore in the fixture) makes these reads `undefined`. Asserting
  // the VALUES rather than `toBeDefined()` is what keeps it non-vacuous: `undefined` is not "you-42".
  it("deserialises into PromptMarkerRow with every field populated", () => {
    const m = FIXTURE.promptMarker as unknown as PromptMarkerRow;
    expect(m.id).toBe("you-42");
    expect(m.createdAt).toBe(1_754_400_000_000);
    expect(m.textPrefix).toContain("Search public data sources");
    // No key may be absent — a Rust `Option` would arrive as an explicit null and `field?: T` would
    // be the wrong type for it. There is no Option in these structs, so there is no null here.
    expect(Object.keys(FIXTURE.promptMarker).sort()).toEqual(["createdAt", "id", "textPrefix"]);
  });

  it("deserialises into HistoryRangeRow with every field populated", () => {
    const r = FIXTURE.rangeRow as unknown as HistoryRangeRow;
    expect(r.id).toBe("you-42");
    expect(r.kind).toBe("prompt");
    expect(r.createdAt).toBe(1_754_400_000_000);
    expect(r.text).toContain("I'm looking for");
    expect(Object.keys(FIXTURE.rangeRow).sort()).toEqual(["createdAt", "id", "kind", "text"]);
  });

  // The rail's tooltip is the reason the prefix exists; a prefix as long as the text would defeat it.
  it("keeps the marker's prefix shorter than the full row's text", () => {
    const m = FIXTURE.promptMarker as unknown as PromptMarkerRow;
    const r = FIXTURE.rangeRow as unknown as HistoryRangeRow;
    expect(m.textPrefix.length).toBeLessThan(r.text.length);
  });
});

describe("promptsInRange", () => {
  it("calls history_prompts_in_range with camelCase args and returns the rows", async () => {
    invoke.mockResolvedValue([FIXTURE.promptMarker]);
    const got = await promptsInRange(1000, 2000, "concierge", 50);
    expect(invoke).toHaveBeenCalledWith("history_prompts_in_range", {
      fromMs: 1000,
      toMs: 2000,
      source: "concierge",
      limit: 50,
    });
    expect(got[0]!.id).toBe("you-42");
  });

  // An omitted limit must reach Rust as absent so `limit.unwrap_or(DEFAULT)` fires. Asserting the
  // OUTGOING shape, not just that the call happened.
  it("omits limit when the caller does not pass one", async () => {
    invoke.mockResolvedValue([]);
    await promptsInRange(1000, 2000, "concierge");
    expect(invoke.mock.calls[0]![1]).toEqual({
      fromMs: 1000,
      toMs: 2000,
      source: "concierge",
      limit: undefined,
    });
  });
});

describe("entriesInRange", () => {
  it("calls history_entries_in_range with camelCase args and returns the rows", async () => {
    invoke.mockResolvedValue([FIXTURE.rangeRow]);
    const got = await entriesInRange(1000, 2000, "concierge", 400);
    expect(invoke).toHaveBeenCalledWith("history_entries_in_range", {
      fromMs: 1000,
      toMs: 2000,
      source: "concierge",
      limit: 400,
    });
    expect(got[0]!.text).toContain("I'm looking for");
  });
});


// ── THE SECOND WAVE (bead sparkle-bjbhw6, defects 3 and 7) ──────────────────────────────────────

describe("historyExtent", () => {
  it("calls history_extent and reads every key the fixture carries", async () => {
    invoke.mockResolvedValue(FIXTURE.historyExtent);
    const got: HistoryExtent = await historyExtent("concierge");
    expect(invoke).toHaveBeenCalledWith("history_extent", { source: "concierge" });
    expect(got.oldestMs).toBe(FIXTURE.historyExtent.oldestMs);
    expect(got.newestMs).toBe(FIXTURE.historyExtent.newestMs);
    expect(got.count).toBe(FIXTURE.historyExtent.count);
  });

  // THE NULL CASE IS THE WHOLE POINT OF THIS ROW, and it is the one shape a `?: number` type cannot
  // describe. A Rust `Option` reaches the wire as an EXPLICIT null, never as an absent key — so a
  // parser typed `oldestMs?: number` (which is `number | undefined`) describes a payload the wire
  // cannot produce. The fixture carries the nulls so both suites fail together (AGENTS.md,
  // bead sparkle-16y6h).
  it("reads an EMPTY store's explicit nulls — not an absent key", async () => {
    expect(Object.keys(FIXTURE.historyExtentEmpty)).toEqual(["oldestMs", "newestMs", "count"]);
    expect(FIXTURE.historyExtentEmpty.oldestMs).toBeNull();
    invoke.mockResolvedValue(FIXTURE.historyExtentEmpty);
    const got: HistoryExtent = await historyExtent("concierge");
    expect(got.oldestMs).toBeNull();
    expect(got.newestMs).toBeNull();
    expect(got.count).toBe(0);
  });
});

describe("promptDensity", () => {
  it("calls history_prompt_density with camelCase args and reads every bucket key", async () => {
    invoke.mockResolvedValue([FIXTURE.promptBucket]);
    const got: PromptBucket[] = await promptDensity(1000, 2000, "concierge", 64);
    expect(invoke).toHaveBeenCalledWith("history_prompt_density", {
      fromMs: 1000,
      toMs: 2000,
      source: "concierge",
      buckets: 64,
    });
    const b = got[0]!;
    // EVERY key, by value from the fixture — a partial read is exactly how a renamed field survives
    // on this side while the Rust suite stays green.
    expect(b.index).toBe(FIXTURE.promptBucket.index);
    expect(b.startMs).toBe(FIXTURE.promptBucket.startMs);
    expect(b.endMs).toBe(FIXTURE.promptBucket.endMs);
    expect(b.count).toBe(FIXTURE.promptBucket.count);
    expect(b.firstAtMs).toBe(FIXTURE.promptBucket.firstAtMs);
    expect(b.newestAtMs).toBe(FIXTURE.promptBucket.newestAtMs);
    expect(b.newestId).toBe(FIXTURE.promptBucket.newestId);
    expect(b.newestTextPrefix).toBe(FIXTURE.promptBucket.newestTextPrefix);
  });

  // NO OPTIONALS ANYWHERE IN THIS SHAPE, deliberately: the Rust struct carries no `Option`, so there
  // is no null for the two halves to disagree about. Asserted rather than merely stated, because the
  // day someone adds one is the day the TS type has to grow a `| null`.
  it("has no nullable field to disagree about", () => {
    for (const [k, v] of Object.entries(FIXTURE.promptBucket)) {
      expect(v, `promptBucket.${k} must not be null`).not.toBeNull();
    }
  });
});
