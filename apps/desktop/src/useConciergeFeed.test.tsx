// @vitest-environment jsdom
// The hook is a thin subscription shell over buildConciergeFeed (exhaustively tested in
// services/conciergeFeed.test.ts) — these tests cover only the wiring: store subscriptions
// produce a live feed, mute-rule changes re-render it, and the pin opt scopes it. Outside Tauri
// the tray fetch/subscription are no-ops (services/attention), so no mocking is needed.
import { describe, it, expect, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useConciergeFeed, selectAndOpen } from "./useConciergeFeed";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSparklePrefsStore } from "./stores/sparklePrefsStore";
import type { AgentTab, Project } from "./types";

function agent(id: string, over: Partial<AgentTab> = {}): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, promptHistory: [],
    runtime: "local", worktreePath: null, ...over,
  } as AgentTab;
}

function project(id: string, agents: AgentTab[]): Project {
  return {
    id, name: `Proj ${id}`, rootPath: `/${id}`, defaultBranch: "main",
    createdAt: "", agents, selectedAgentId: null,
  } as Project;
}

beforeEach(() => {
  useProjectStore.setState({
    projects: [project("pA", [agent("a1")]), project("pB", [agent("b1")])],
  });
  useRuntimeStore.setState({ status: { a1: "waiting", b1: "working" } });
  useSparklePrefsStore.setState({ rules: {} });
});

describe("useConciergeFeed", () => {
  it("returns the live feed and re-renders when a status changes", () => {
    const { result } = renderHook(() => useConciergeFeed());
    // a1 waiting → needs_you; b1 working → running.
    expect(result.current.scopedCounts).toEqual({ needs_you: 1, running: 1, done: 0 });

    act(() => {
      useRuntimeStore.setState({ status: { a1: "waiting", b1: "blocked" } });
    });
    // b1 moved out of Running and joined a1 in Needs-you — `blocked` is no longer its own tier.
    expect(result.current.scopedCounts).toEqual({ needs_you: 2, running: 0, done: 0 });
  });

  it("re-renders when a mute rule lands, dimming the item out of the scoped counts", () => {
    const { result } = renderHook(() => useConciergeFeed());
    expect(result.current.scopedCounts.needs_you).toBe(1);

    act(() => {
      useSparklePrefsStore.getState().setInterruptPreference("a1", "mute");
    });
    expect(result.current.scopedCounts.needs_you).toBe(0);
    const a1 = result.current.projects[0]!.agents.find((a) => a.id === "a1")!;
    expect(a1.muted).toBe(true); // still listed — the UI dims it, the concierge stays quiet
  });

  it("scopes to the pinned project while still listing everything", () => {
    const { result } = renderHook(() => useConciergeFeed({ pinnedProjectId: "pB" }));
    expect(result.current.scopedCounts).toEqual({ needs_you: 0, running: 1, done: 0 }); // pA is out of scope
    expect(result.current.counts).toEqual({ needs_you: 1, running: 1, done: 0 }); // full truth unchanged
    expect(result.current.projects).toHaveLength(2);
  });

  it("re-exports selectAndOpen as the jump action", () => {
    expect(typeof selectAndOpen).toBe("function");
  });
});
