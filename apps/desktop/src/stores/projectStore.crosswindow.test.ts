import { describe, it, expect, beforeEach } from "vitest";
import { useProjectStore } from "./projectStore";

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  localStorage.clear();
});

describe("touchProjectOpened", () => {
  it("updates lastOpenedAt without changing selectedProjectId", () => {
    const id = useProjectStore.getState().addProject("P", "/tmp/p");
    // Pin a known-old timestamp + simulate another window being the selected one, so the
    // assertion fails if touchProjectOpened stops bumping the field.
    const old = "2000-01-01T00:00:00.000Z";
    useProjectStore.setState((s) => ({
      selectedProjectId: "other",
      projects: s.projects.map((p) => (p.id === id ? { ...p, lastOpenedAt: old } : p)),
    }));
    useProjectStore.getState().touchProjectOpened(id);
    const after = useProjectStore.getState().projects[0]?.lastOpenedAt ?? "";
    expect(after > old).toBe(true);
    expect(useProjectStore.getState().selectedProjectId).toBe("other");
  });
});
