// @vitest-environment jsdom
//
// §13 — clicking "+ New Build Agent" must LAND the user in the new agent: its sidebar row scrolls
// into view and the caret goes to the one compose surface, so you can type without clicking first.
// Selection alone was already there (selectAgent + open) and was NOT the missing piece.
//
// Both of the two "+ New Build Agent" buttons (the sidebar row and the Workspace empty state) go
// through useNewAgent → useSpawnBuildAgent, so the behavior lives in the shared hook and these
// tests exercise it from both entry points — including the two paths that create NO agent (cloud,
// and a project that vanished mid-click), which must NOT reveal or steal the caret.
import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

// The spawn path fires a best-effort `bd create`; keep it off IPC in jsdom.
vi.mock("../services/tasks", () => ({ createBeadFull: vi.fn(async () => "bd-1") }));

import { useSpawnBuildAgent } from "./useSpawnBuildAgent";
import { useNewAgent } from "./useNewAgent";
import { useUiStore } from "../stores/uiStore";
import { useProjectStore } from "../stores/projectStore";
import type { Project } from "../types";

function seedProject(): Project {
  const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  return useProjectStore.getState().projects.find((p) => p.id === pid)!;
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useUiStore.setState({
    newAgentRuntime: "local",
    cloudCreateOpen: false,
    activeSpecial: null,
    revealAgentId: null,
    composeFocusSeq: 0,
  });
});

describe("useSpawnBuildAgent — reveal + focus the new agent", () => {
  it("asks the sidebar to reveal the new row and hands the caret to the compose box", () => {
    const project = seedProject();
    const { result } = renderHook(() => useSpawnBuildAgent(project));
    let id: string | null = null;
    act(() => {
      id = result.current();
    });
    expect(id).toBeTruthy();
    expect(useUiStore.getState().revealAgentId).toBe(id);
    // A monotonic token, so a second spawn re-focuses rather than being swallowed as "no change".
    expect(useUiStore.getState().composeFocusSeq).toBe(1);
  });

  it("re-fires for a SECOND spawn (the request is one-shot, not a latch)", () => {
    const project = seedProject();
    const { result } = renderHook(() => useSpawnBuildAgent(project));
    let first: string | null = null;
    let second: string | null = null;
    act(() => {
      first = result.current();
    });
    // Simulate the row consuming the first request.
    act(() => useUiStore.getState().clearRevealAgent(first!));
    expect(useUiStore.getState().revealAgentId).toBeNull();
    act(() => {
      second = result.current();
    });
    expect(second).not.toBe(first);
    expect(useUiStore.getState().revealAgentId).toBe(second);
    expect(useUiStore.getState().composeFocusSeq).toBe(2);
  });

  it("does NOT reveal or focus with no project open", () => {
    const { result } = renderHook(() => useSpawnBuildAgent(null));
    act(() => {
      expect(result.current()).toBeNull();
    });
    expect(useUiStore.getState().revealAgentId).toBeNull();
    expect(useUiStore.getState().composeFocusSeq).toBe(0);
  });

  it("does NOT reveal or focus when the project went away mid-click (addAgent → null)", () => {
    const project = seedProject();
    const { result } = renderHook(() => useSpawnBuildAgent(project));
    // The project is closed (another window) between the render and the click: the hook still holds
    // the stale Project object, but addAgent finds nothing and creates nothing (roborev 46278).
    act(() => {
      useProjectStore.setState({ projects: [], selectedProjectId: null });
    });
    act(() => {
      expect(result.current()).toBeNull();
    });
    expect(useUiStore.getState().revealAgentId).toBeNull();
    expect(useUiStore.getState().composeFocusSeq).toBe(0);
  });
});

describe("useNewAgent — the cloud path has no agent to land in", () => {
  it("opens the cloud dialog without revealing or stealing the caret", () => {
    const project = seedProject();
    useUiStore.setState({ newAgentRuntime: "cloud" });
    const { result } = renderHook(() => useNewAgent(project));
    act(() => {
      expect(result.current()).toBeNull();
    });
    expect(useUiStore.getState().cloudCreateOpen).toBe(true);
    expect(useUiStore.getState().revealAgentId).toBeNull();
    expect(useUiStore.getState().composeFocusSeq).toBe(0);
  });

  it("reveals + focuses on the LOCAL path (the shared hook, reached through useNewAgent)", () => {
    const project = seedProject();
    const { result } = renderHook(() => useNewAgent(project));
    let id: string | null = null;
    act(() => {
      id = result.current();
    });
    expect(useUiStore.getState().revealAgentId).toBe(id);
    expect(useUiStore.getState().composeFocusSeq).toBe(1);
  });
});
