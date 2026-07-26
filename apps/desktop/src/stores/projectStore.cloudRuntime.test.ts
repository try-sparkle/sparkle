// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useProjectStore } from "./projectStore";
import { usageTelemetry } from "../services/usageTelemetry";

// addAgent gained a pre-issued `id` + `runtime` for cloud agents (Service B, W5). These cover the
// cloud-specific invariants: the server session id becomes the tab id, runtime is honored, and a
// duplicate pre-issued id (a create racing the startup re-attach) never inserts a second tab.
describe("addAgent — cloud id + runtime", () => {
  beforeEach(() => useProjectStore.setState({ projects: [], selectedProjectId: null }));

  it("creates a tab whose id is the caller-supplied session id, with runtime cloud", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const id = useProjectStore.getState().addAgent(pid, {
      id: "sess-123",
      kind: "build",
      runtime: "cloud",
    })!;
    expect(id).toBe("sess-123");
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === "sess-123")!;
    expect(agent.runtime).toBe("cloud");
    expect(agent.kind).toBe("build");
  });

  it("defaults runtime to local and mints a v4 uuid (version/variant nibbles) when neither is supplied", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    const id = useProjectStore.getState().addAgent(pid)!;
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.id === id)!;
    expect(agent.runtime).toBe("local");
    // A real crypto.randomUUID v4: pin the version (4) and variant (8/9/a/b) nibbles, not just shape.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("returns null and creates nothing when the project id is unknown", () => {
    const spawnSpy = vi.spyOn(usageTelemetry, "trackAgentSpawned").mockResolvedValue(undefined);
    try {
      // A window whose project was removed (or a cloud re-attach for a project this window doesn't
      // have) must NOT report success: mapProject silently no-ops on an unknown id, so returning an
      // id here would hand the caller a tab that does not exist — createCloudAgent would then
      // selectAgent + open() a phantom id (blank pane), and re-attach would count phantom creates.
      const id = useProjectStore
        .getState()
        .addAgent("no-such-project", { id: "sess-x", runtime: "cloud" });
      expect(id).toBeNull();
      expect(useProjectStore.getState().projects).toHaveLength(0);
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it("dedups a repeated pre-issued id: no 2nd tab, existing record + selection + telemetry untouched", () => {
    const spawnSpy = vi.spyOn(usageTelemetry, "trackAgentSpawned").mockResolvedValue(undefined);
    try {
      const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
      const first = useProjectStore.getState().addAgent(pid, {
        id: "sess-dup",
        runtime: "cloud",
        name: "Original name",
      })!;
      // Move selection elsewhere; the dedup no-op must NOT yank it back (background-reconcile invariant).
      useProjectStore.getState().selectAgent(pid, null);
      spawnSpy.mockClear();

      const second = useProjectStore.getState().addAgent(pid, {
        id: "sess-dup",
        runtime: "cloud",
        name: "Different name",
      })!;

      expect(second).toBe(first);
      const agents = useProjectStore.getState().projects[0]!.agents.filter((a) => a.id === "sess-dup");
      expect(agents).toHaveLength(1);
      // The existing record is untouched — the second call's name/opts are ignored.
      expect(agents[0]!.name).toBe("Original name");
      // Selection is left exactly as it was (the no-op does not re-select).
      expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBeNull();
      // No duplicate spawn telemetry for the no-op.
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
