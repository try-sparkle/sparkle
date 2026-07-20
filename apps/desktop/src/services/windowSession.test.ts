// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  readWindowSessions,
  saveWindowSession,
  removeWindowSession,
  clearAllWindowSessions,
  WINDOW_SESSION_KEY,
  type WindowSessionEntry,
} from "./windowSession";

function fakeStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    _raw: () => m.get(WINDOW_SESSION_KEY) ?? null,
  };
}

function entry(over: Partial<WindowSessionEntry> = {}): WindowSessionEntry {
  return { projectId: "p1", isMain: false, x: 0, y: 0, width: 1200, height: 800, focusedAt: 1, ...over };
}

describe("windowSession", () => {
  it("round-trips a saved entry", () => {
    const s = fakeStore();
    const e = entry({ projectId: "p1", x: 10, y: 20, width: 900, height: 600, focusedAt: 42 });
    saveWindowSession(e, s);
    expect(readWindowSessions(s)).toEqual({ p1: e });
  });

  it("save is read-modify-write — sibling entries survive", () => {
    const s = fakeStore();
    saveWindowSession(entry({ projectId: "p1" }), s);
    saveWindowSession(entry({ projectId: "p2", isMain: true }), s);
    const all = readWindowSessions(s);
    expect(Object.keys(all).sort()).toEqual(["p1", "p2"]);
    expect(all.p2?.isMain).toBe(true);
  });

  it("re-saving the same projectId replaces its entry in place", () => {
    const s = fakeStore();
    saveWindowSession(entry({ projectId: "p1", x: 0 }), s);
    saveWindowSession(entry({ projectId: "p1", x: 500 }), s);
    const all = readWindowSessions(s);
    expect(Object.keys(all)).toEqual(["p1"]);
    expect(all.p1?.x).toBe(500);
  });

  it("removeWindowSession drops only the named project", () => {
    const s = fakeStore();
    saveWindowSession(entry({ projectId: "p1" }), s);
    saveWindowSession(entry({ projectId: "p2" }), s);
    removeWindowSession("p1", s);
    expect(Object.keys(readWindowSessions(s))).toEqual(["p2"]);
  });

  it("removing an absent project is a no-op (no write of a wrong shape)", () => {
    const s = fakeStore();
    saveWindowSession(entry({ projectId: "p1" }), s);
    removeWindowSession("nope", s);
    expect(Object.keys(readWindowSessions(s))).toEqual(["p1"]);
  });

  it("clearAllWindowSessions empties the map", () => {
    const s = fakeStore();
    saveWindowSession(entry({ projectId: "p1" }), s);
    clearAllWindowSessions(s);
    expect(readWindowSessions(s)).toEqual({});
  });

  it("a malformed blob reads as empty rather than throwing", () => {
    const s = fakeStore();
    s.setItem(WINDOW_SESSION_KEY, "{not json");
    expect(readWindowSessions(s)).toEqual({});
  });

  it("an array blob reads as empty (not a numeric-keyed shape)", () => {
    const s = fakeStore();
    s.setItem(WINDOW_SESSION_KEY, "[1,2,3]");
    expect(readWindowSessions(s)).toEqual({});
  });
});
