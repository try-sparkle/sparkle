import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordConciergePrompt, recordConciergeReply } from "./conciergeHistory";
import { useHistoryStore } from "../stores/historyStore";
import type { HistoryEntry } from "./history";

let recorded: HistoryEntry[];

beforeEach(() => {
  recorded = [];
  vi.spyOn(useHistoryStore, "getState").mockReturnValue({
    ...useHistoryStore.getState(),
    record: async (e: HistoryEntry) => {
      recorded.push(e);
    },
  } as ReturnType<typeof useHistoryStore.getState>);
});

afterEach(() => vi.restoreAllMocks());

describe("indexing the concierge conversation", () => {
  // THE REGRESSION THIS PINS (bead sparkle-yd1ud): every row in the history index used to be
  // build-agent traffic, so `search_history` could answer "did an agent ACT on this" and nothing
  // else — indistinguishable from "you never asked" for the two items that never produced an agent.
  it("records what the founder said, tagged as concierge conversation", () => {
    recordConciergePrompt("build me ten homepage designs");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      kind: "prompt",
      source: "concierge",
      text: "build me ten homepage designs",
    });
  });

  it("records what the concierge replied", () => {
    recordConciergeReply("I'll get that started.");
    expect(recorded[0]).toMatchObject({ kind: "response", source: "concierge" });
  });

  it("claims no agent or project, rather than borrowing a pinned one", () => {
    // A borrowed id would make the palette's jump-to-source routing open an unrelated agent, with
    // nothing on screen to say it was a guess.
    recordConciergePrompt("build me ten homepage designs");
    expect(recorded[0]).toMatchObject({ agentId: null, projectId: null, projectName: null });
  });

  it("carries a unique id and a timestamp so entries are prunable and de-duplicable", () => {
    recordConciergePrompt("build ten homepage designs");
    recordConciergePrompt("research the Gary Tan ideas");
    expect(recorded[0]!.id).not.toBe(recorded[1]!.id);
    expect(recorded[0]!.createdAt).toBeGreaterThan(0);
  });

  it("writes nothing for empty or whitespace-only text", () => {
    recordConciergePrompt("");
    recordConciergePrompt("   \n  ");
    recordConciergeReply("");
    expect(recorded).toEqual([]);
  });

  // THE REGRESSION THIS PINS. These calls sit on the dispatch path directly ahead of
  // `startConciergeTurn`, so a SYNCHRONOUS throw here does not lose an index row — it aborts the
  // send and the founder's message is never delivered. The first version called `crypto.randomUUID()`
  // unguarded and hung the concierge's queue-drain path for its full 15s timeout.
  it("cannot throw into the turn when the store itself is broken", () => {
    vi.spyOn(useHistoryStore, "getState").mockImplementation(() => {
      throw new Error("store not initialised");
    });
    expect(() => recordConciergePrompt("build ten homepage designs")).not.toThrow();
    expect(() => recordConciergeReply("on it")).not.toThrow();
  });

  // roborev 61903: a missing `randomUUID` (non-secure context) is PERMANENT, so swallowing the row
  // would kill the index for every turn from then on. The id only needs to be unique enough for the
  // store's INSERT OR IGNORE, so falling back costs nothing and keeps the entry.
  it("still records with a fallback id when crypto.randomUUID is unavailable", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new TypeError("randomUUID is not a function");
    });
    expect(() => recordConciergePrompt("build ten homepage designs")).not.toThrow();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.id).toBeTruthy();
    expect(recorded[0]!.text).toBe("build ten homepage designs");
  });

  it("gives distinct fallback ids to two entries in the same turn", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      throw new TypeError("randomUUID is not a function");
    });
    recordConciergePrompt("build ten homepage designs");
    recordConciergeReply("on it, spawning that now");
    expect(recorded[0]!.id).not.toBe(recorded[1]!.id);
  });

  it("trims, so a leading newline does not become part of the indexed text", () => {
    recordConciergePrompt("\n  build ten homepage designs  \n");
    expect(recorded[0]!.text).toBe("build ten homepage designs");
  });
});
