import { describe, it, expect } from "vitest";
import {
  needsAttention,
  countAttention,
  newlyEntered,
  notificationFor,
  type StatusMap,
} from "./attention";
import type { AgentTabStatus } from "../types";

// The notification "enabled" set used across the newlyEntered tests — the default-on tier
// (red + finished). working/blocked/stopped are deliberately excluded.
const ENABLED = new Set<AgentTabStatus>(["waiting", "approval", "errored", "idle", "done"]);

describe("needsAttention", () => {
  it("is true only for the red statuses (waiting, approval)", () => {
    expect(needsAttention("waiting")).toBe(true);
    expect(needsAttention("approval")).toBe(true);
  });

  // errored is RED but deliberately NOT an attention status — a crashed agent stands out
  // visually but must not fire the dock badge/notification (it's not asking you anything).
  it("is false for every non-attention status (incl. red 'errored') and for undefined", () => {
    for (const s of ["working", "idle", "blocked", "errored", "done", "stopped"] as const) {
      expect(needsAttention(s)).toBe(false);
    }
    expect(needsAttention(undefined)).toBe(false);
  });
});

describe("countAttention", () => {
  const status: StatusMap = {
    a: "waiting",
    b: "working",
    c: "approval",
    d: "idle",
    e: "waiting",
  };

  it("counts only the owned ids that need attention", () => {
    expect(countAttention(status, ["a", "b", "c", "d", "e"])).toBe(3);
  });

  it("ignores ids not in the owned set (e.g. another window's project)", () => {
    // `c` (approval) and `e` (waiting) exist in status but aren't owned here.
    expect(countAttention(status, ["a", "b", "d"])).toBe(1);
  });

  it("is zero when nobody is waiting", () => {
    expect(countAttention({ x: "working", y: "idle" }, ["x", "y"])).toBe(0);
  });

  it("counts a missing-status id as not needing attention", () => {
    expect(countAttention(status, ["a", "zzz"])).toBe(1);
  });
});

describe("newlyEntered", () => {
  it("returns agents that transitioned INTO an enabled status", () => {
    const prev: StatusMap = { a: "working", b: "working", c: "idle" };
    const next: StatusMap = { a: "waiting", b: "done", c: "idle" };
    // a → waiting and b → done are fresh enabled transitions; c stayed idle (no re-fire).
    expect(newlyEntered(prev, next, ["a", "b", "c"], ENABLED)).toEqual([
      { id: "a", status: "waiting" },
      { id: "b", status: "done" },
    ]);
  });

  it("ignores transitions into a NON-enabled status (e.g. working)", () => {
    expect(newlyEntered({ a: "idle" }, { a: "working" }, ["a"], ENABLED)).toEqual([]);
  });

  it("fires for errored now that it's enabled", () => {
    expect(newlyEntered({ a: "working" }, { a: "errored" }, ["a"], ENABLED)).toEqual([
      { id: "a", status: "errored" },
    ]);
  });

  it("treats an id absent from prev but already in an enabled status as a fresh transition", () => {
    expect(newlyEntered({}, { a: "waiting" }, ["a"], ENABLED)).toEqual([
      { id: "a", status: "waiting" },
    ]);
  });

  it("does not re-fire while an agent stays in the same status", () => {
    const s: StatusMap = { a: "waiting" };
    expect(newlyEntered(s, s, ["a"], ENABLED)).toEqual([]);
  });

  it("fires again when the status changes to a DIFFERENT enabled one (waiting → approval)", () => {
    expect(newlyEntered({ a: "waiting" }, { a: "approval" }, ["a"], ENABLED)).toEqual([
      { id: "a", status: "approval" },
    ]);
  });

  it("only considers owned ids", () => {
    const prev: StatusMap = { a: "working", b: "working" };
    const next: StatusMap = { a: "waiting", b: "waiting" };
    expect(newlyEntered(prev, next, ["a"], ENABLED)).toEqual([{ id: "a", status: "waiting" }]);
  });

  it("respects a narrowed enabled set (only red, not done)", () => {
    const onlyRed = new Set<AgentTabStatus>(["waiting", "approval", "errored"]);
    const prev: StatusMap = { a: "working", b: "working" };
    const next: StatusMap = { a: "done", b: "errored" };
    expect(newlyEntered(prev, next, ["a", "b"], onlyRed)).toEqual([{ id: "b", status: "errored" }]);
  });
});

describe("notificationFor", () => {
  it("uses the agent name as the title and a reason + project in the body", () => {
    expect(notificationFor("waiting", "Fixer", "sparkle")).toEqual({
      title: "Fixer",
      body: "Needs your answer · sparkle",
    });
    expect(notificationFor("errored", "Builder", "web")).toEqual({
      title: "Builder",
      body: "Errored — it crashed · web",
    });
    expect(notificationFor("done", "Cleanup", "web")).toEqual({
      title: "Cleanup",
      body: "Done · web",
    });
  });

  it("omits the ' · project' suffix when there's no project name", () => {
    expect(notificationFor("idle", "Worker", "")).toEqual({
      title: "Worker",
      body: "Finished — your turn",
    });
  });

  it("has copy for every status in the taxonomy (no blank banners)", () => {
    const all: AgentTabStatus[] = [
      "working",
      "idle",
      "waiting",
      "approval",
      "blocked",
      "errored",
      "done",
      "stopped",
    ];
    for (const s of all) expect(notificationFor(s, "A", "P").body).not.toBe(" · P");
  });
});
