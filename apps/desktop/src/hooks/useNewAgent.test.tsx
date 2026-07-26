// @vitest-environment jsdom
//
// The one "+ New Build Agent" action, runtime-aware. Local must stay EXACTLY today's behavior
// (spawn a tab synchronously, return its id); Cloud must not spawn anything locally — it opens the
// create dialog, because the server has to start the session before a tab can exist.
import { act, renderHook } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

// The local spawn path fires a best-effort `bd create`; keep it off IPC in jsdom.
vi.mock("../services/tasks", () => ({ createBeadFull: vi.fn(async () => "bd-1") }));

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
  useUiStore.setState({ newAgentRuntime: "local", cloudCreateOpen: false, activeSpecial: null });
});

describe("useNewAgent", () => {
  it("spawns a LOCAL build agent and returns its id (unchanged behavior)", () => {
    const project = seedProject();
    const { result } = renderHook(() => useNewAgent(project));
    let id: string | null = null;
    act(() => {
      id = result.current();
    });
    expect(id).toBeTruthy();
    const agents = useProjectStore.getState().projects[0]!.agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]!.runtime).toBe("local");
    expect(useUiStore.getState().cloudCreateOpen).toBe(false);
  });

  it("opens the cloud dialog instead of spawning when the runtime is cloud", () => {
    const project = seedProject();
    useUiStore.setState({ newAgentRuntime: "cloud" });
    const { result } = renderHook(() => useNewAgent(project));
    let id: string | null = "not-null";
    act(() => {
      id = result.current();
    });
    // No agent yet — the server has to start the session first.
    expect(id).toBeNull();
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
    expect(useUiStore.getState().cloudCreateOpen).toBe(true);
  });

  it("does nothing with no project open, in either runtime", () => {
    useUiStore.setState({ newAgentRuntime: "cloud" });
    const { result } = renderHook(() => useNewAgent(null));
    let id: string | null = "not-null";
    act(() => {
      id = result.current();
    });
    expect(id).toBeNull();
    expect(useUiStore.getState().cloudCreateOpen).toBe(false);
  });
});
