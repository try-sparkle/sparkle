// The pending-attachments handoff: paths queued for an agent whose composer hasn't mounted
// yet (drop on "+ New Build Agent" → spawn → the new composer drains its entry on mount).
import { beforeEach, describe, expect, it } from "vitest";
import { usePendingAttachmentsStore } from "./pendingAttachmentsStore";

const store = () => usePendingAttachmentsStore.getState();

beforeEach(() => usePendingAttachmentsStore.setState({ pending: {} }));

describe("pendingAttachmentsStore", () => {
  it("drains exactly what was added, in order, then is empty", () => {
    store().add("a1", ["/tmp/one.png", "/tmp/two.pdf"]);
    expect(store().drain("a1")).toEqual(["/tmp/one.png", "/tmp/two.pdf"]);
    expect(store().drain("a1")).toEqual([]);
  });

  it("accumulates repeated adds for the same agent", () => {
    store().add("a1", ["/tmp/one.png"]);
    store().add("a1", ["/tmp/two.png"]);
    expect(store().drain("a1")).toEqual(["/tmp/one.png", "/tmp/two.png"]);
  });

  it("keeps other agents' entries when one drains", () => {
    store().add("a1", ["/tmp/mine.png"]);
    store().add("a2", ["/tmp/theirs.png"]);
    expect(store().drain("a1")).toEqual(["/tmp/mine.png"]);
    expect(store().drain("a2")).toEqual(["/tmp/theirs.png"]);
  });

  it("drain of an unknown agent is an empty array (no entry created)", () => {
    expect(store().drain("nope")).toEqual([]);
    expect(store().pending).toEqual({});
  });
});
