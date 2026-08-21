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
  type PromptMarkerRow,
  type HistoryRangeRow,
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
