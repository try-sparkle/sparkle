// @vitest-environment jsdom
//
// Startup re-attach wiring: opening a project reconciles its tabs against the server's LIVE cloud
// sessions. The store halves are real (projectStore/authStore) so the dedup is asserted against the
// actual tab list; only the network client is faked.
import { describe, it, expect, beforeEach, vi } from "vitest";

const listSessions = vi.fn();
const listProjects = vi.fn();
const createProject = vi.fn();
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  cloudApi: {
    listSessions: (...a: unknown[]) => listSessions(...a),
    listProjects: (...a: unknown[]) => listProjects(...a),
    createProject: (...a: unknown[]) => createProject(...a),
  },
}));

import { reattachProjectOnOpen } from "./startup";
import { useProjectStore } from "../../stores/projectStore";
import { useAuthStore } from "../../stores/authStore";

const me = (cloud: boolean) => ({
  clerkUserId: "u",
  entitled: true,
  balanceCents: 5000,
  tokenVersion: 1,
  ...(cloud ? { cloudAgentsEnabled: true } : {}),
});

function seedProject(over: { cloudProjectId?: string } = {}): string {
  const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  if (over.cloudProjectId) useProjectStore.getState().setCloudProjectId(pid, over.cloudProjectId);
  return pid;
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useAuthStore.setState({ me: me(true), tokenPresent: true, loading: false });
  listSessions.mockReset().mockResolvedValue([]);
  listProjects.mockReset().mockResolvedValue([]);
  createProject.mockReset();
});

describe("reattachProjectOnOpen", () => {
  it("recreates a tab for each live cloud session that lost one", async () => {
    const pid = seedProject({ cloudProjectId: "srv-1" });
    listSessions.mockResolvedValue([
      { id: "sess-a", status: "active", name: "Refactor" },
      { id: "sess-b", status: "waiting" },
    ]);

    await expect(reattachProjectOnOpen(pid)).resolves.toEqual(["sess-a", "sess-b"]);
    const agents = useProjectStore.getState().projects[0]!.agents;
    expect(agents.map((a) => a.id)).toEqual(["sess-a", "sess-b"]);
    expect(agents.every((a) => a.runtime === "cloud")).toBe(true);
    expect(agents[0]!.name).toBe("Refactor");
    expect(listSessions).toHaveBeenCalledWith("srv-1"); // keyed by the SERVER project id
  });

  it("dedups against tabs that already exist — no second row, no duplicate creates", async () => {
    const pid = seedProject({ cloudProjectId: "srv-1" });
    useProjectStore.getState().addAgent(pid, { id: "sess-a", kind: "build", runtime: "cloud" });
    listSessions.mockResolvedValue([
      { id: "sess-a", status: "active" },
      { id: "sess-new", status: "active" },
    ]);

    await expect(reattachProjectOnOpen(pid)).resolves.toEqual(["sess-new"]);
    const ids = useProjectStore.getState().projects[0]!.agents.map((a) => a.id);
    expect(ids).toEqual(["sess-a", "sess-new"]);

    // Running it twice (a re-open, a second window) must not add anything either.
    await expect(reattachProjectOnOpen(pid)).resolves.toEqual([]);
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(2);
  });

  it("skips terminal sessions — a finished agent is not resurrected", async () => {
    const pid = seedProject({ cloudProjectId: "srv-1" });
    listSessions.mockResolvedValue([
      { id: "done", status: "complete" },
      { id: "boom", status: "error" },
      { id: "live", status: "paused" },
    ]);
    await expect(reattachProjectOnOpen(pid)).resolves.toEqual(["live"]);
  });

  it("does nothing at all — not one request — when the capability isn't advertised", async () => {
    const pid = seedProject({ cloudProjectId: "srv-1" });
    useAuthStore.setState({ me: me(false), tokenPresent: true });
    // null = "never got a useful answer" — the caller keeps the project eligible for a retry,
    // because on a cold boot this same shape means "auth hasn't settled yet".
    await expect(reattachProjectOnOpen(pid)).resolves.toBeNull();
    expect(listSessions).not.toHaveBeenCalled();
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("does nothing when signed out", async () => {
    const pid = seedProject({ cloudProjectId: "srv-1" });
    useAuthStore.setState({ me: me(true), tokenPresent: false });
    await expect(reattachProjectOnOpen(pid)).resolves.toBeNull();
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("never CREATES a server project row just because a project was opened", async () => {
    const pid = seedProject(); // no cloudProjectId, and no same-named server row
    await expect(reattachProjectOnOpen(pid)).resolves.toEqual([]);
    expect(createProject).not.toHaveBeenCalled();
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("binds to a same-named server row on a fresh machine and re-attaches its sessions", async () => {
    const pid = seedProject(); // never used cloud on THIS Mac
    listProjects.mockResolvedValue([{ id: "srv-demo", name: "Demo" }]);
    listSessions.mockResolvedValue([{ id: "sess-a", status: "active" }]);

    await expect(reattachProjectOnOpen(pid)).resolves.toEqual(["sess-a"]);
    // …and the binding is cached so the next launch skips the lookup.
    expect(useProjectStore.getState().projects[0]!.cloudProjectId).toBe("srv-demo");
  });

  it("is silent and harmless when the lookup or the listing fails (offline)", async () => {
    // BOTH failures are retryable (roborev 49295). The listing one is the common shape and was the
    // one reported as `[]`: once a project has a cached cloudProjectId, findCloudProjectId answers
    // from the cache without a request, so listSessions is the ONLY call left that can fail — and
    // `[]` ("asked, nothing to do") settles the project for the whole session.
    const pid = seedProject({ cloudProjectId: "srv-1" });
    listSessions.mockRejectedValue(new Error("Failed to fetch"));
    await expect(reattachProjectOnOpen(pid)).resolves.toBeNull();

    const pid2 = seedProject();
    listProjects.mockRejectedValue(new Error("Failed to fetch"));
    // The lookup never answered — null keeps the project retryable once back online.
    await expect(reattachProjectOnOpen(pid2)).resolves.toBeNull();
  });

  it("no-ops for a project this window doesn't have", async () => {
    await expect(reattachProjectOnOpen("nope")).resolves.toBeNull();
    expect(listSessions).not.toHaveBeenCalled();
  });
});
