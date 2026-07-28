import { describe, it, expect } from "vitest";
import {
  reconcileCloudSessions,
  isLiveCloudStatus,
  type CloudSessionSummary,
} from "./reconcile";

const s = (id: string, status: string, extra: Partial<CloudSessionSummary> = {}): CloudSessionSummary => ({
  id,
  status,
  ...extra,
});

describe("isLiveCloudStatus", () => {
  it("treats active/paused/waiting as live and complete/error as terminal", () => {
    expect(isLiveCloudStatus("active")).toBe(true);
    expect(isLiveCloudStatus("paused")).toBe(true);
    expect(isLiveCloudStatus("waiting")).toBe(true);
    expect(isLiveCloudStatus("complete")).toBe(false);
    expect(isLiveCloudStatus("error")).toBe(false);
    expect(isLiveCloudStatus("something-new")).toBe(false);
  });
});

describe("reconcileCloudSessions", () => {
  it("recreates a tab for a live session that has none (laptop reopened)", () => {
    const r = reconcileCloudSessions({
      existingTabIds: [],
      sessions: [s("sess-1", "active", { name: "Cloud task" })],
    });
    expect(r.toCreate.map((c) => c.id)).toEqual(["sess-1"]);
    expect(r.toCreate[0]!.name).toBe("Cloud task");
  });

  it("dedups against existing tabs — a session that already has a tab is not recreated", () => {
    const r = reconcileCloudSessions({
      existingTabIds: ["sess-1", "local-x"],
      sessions: [s("sess-1", "active"), s("sess-2", "paused")],
    });
    expect(r.toCreate.map((c) => c.id)).toEqual(["sess-2"]);
  });

  it("skips terminal sessions (complete/error) — never resurrects a finished agent", () => {
    const r = reconcileCloudSessions({
      existingTabIds: [],
      sessions: [s("done", "complete"), s("bad", "error"), s("live", "active")],
    });
    expect(r.toCreate.map((c) => c.id)).toEqual(["live"]);
  });

  it("de-duplicates repeated ids within the server list", () => {
    const r = reconcileCloudSessions({
      existingTabIds: [],
      sessions: [s("dup", "active"), s("dup", "waiting")],
    });
    expect(r.toCreate.map((c) => c.id)).toEqual(["dup"]);
  });

  it("ignores malformed rows (missing/empty id)", () => {
    const r = reconcileCloudSessions({
      existingTabIds: [],
      sessions: [{ status: "active" } as any, s("", "active"), s("ok", "active")],
    });
    expect(r.toCreate.map((c) => c.id)).toEqual(["ok"]);
  });

  it("preserves server order and accepts a Set for existingTabIds", () => {
    const r = reconcileCloudSessions({
      existingTabIds: new Set(["b"]),
      sessions: [s("a", "active"), s("b", "active"), s("c", "waiting")],
    });
    expect(r.toCreate.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("returns nothing when there are no sessions", () => {
    expect(reconcileCloudSessions({ existingTabIds: ["x"], sessions: [] }).toCreate).toEqual([]);
  });
});
