// @vitest-environment jsdom
//
// Last-focused-project tracking (spec §3): every project-bearing window writes
// `sparkle-last-focused-project` on focus; the capture window reads it to pick the
// default send target. Bad/missing/foreign JSON must read as null, never throw.
import { describe, it, expect, beforeEach } from "vitest";
import {
  LAST_FOCUSED_PROJECT_KEY,
  readLastFocusedProject,
  writeLastFocusedProject,
} from "./lastFocusedProject";

describe("lastFocusedProject", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a project id", () => {
    writeLastFocusedProject("proj-1");
    expect(readLastFocusedProject()).toBe("proj-1");
  });

  it("writes the contract JSON shape {projectId, at}", () => {
    writeLastFocusedProject("proj-2");
    const raw = JSON.parse(localStorage.getItem(LAST_FOCUSED_PROJECT_KEY)!);
    expect(raw.projectId).toBe("proj-2");
    expect(typeof raw.at).toBe("number");
  });

  it("returns null when the key is absent", () => {
    expect(readLastFocusedProject()).toBeNull();
  });

  it("returns null on unparseable JSON", () => {
    localStorage.setItem(LAST_FOCUSED_PROJECT_KEY, "{not json");
    expect(readLastFocusedProject()).toBeNull();
  });

  it("returns null when projectId is missing or not a string", () => {
    localStorage.setItem(LAST_FOCUSED_PROJECT_KEY, JSON.stringify({ at: 1 }));
    expect(readLastFocusedProject()).toBeNull();
    localStorage.setItem(LAST_FOCUSED_PROJECT_KEY, JSON.stringify({ projectId: 42, at: 1 }));
    expect(readLastFocusedProject()).toBeNull();
  });

  it("returns null on an empty projectId", () => {
    localStorage.setItem(LAST_FOCUSED_PROJECT_KEY, JSON.stringify({ projectId: "", at: 1 }));
    expect(readLastFocusedProject()).toBeNull();
  });
});
