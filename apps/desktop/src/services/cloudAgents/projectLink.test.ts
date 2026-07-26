import { describe, it, expect, vi } from "vitest";
import { ensureCloudProjectId, findCloudProjectId, type ProjectLinkDeps } from "./projectLink";

function harness(projects: Array<{ id: string; name: string; chiefProjectId?: string | null }> = []) {
  const listProjects = vi.fn(async () =>
    projects.map((p) => ({ ...p, chiefProjectId: p.chiefProjectId ?? null })),
  );
  const createProject = vi.fn(async (name: string, _chiefProjectId?: string) => ({
    id: `srv-${name}`,
  }));
  const remember = vi.fn();
  const deps: ProjectLinkDeps = { api: { listProjects, createProject }, remember };
  return { deps, listProjects, createProject, remember };
}

describe("ensureCloudProjectId", () => {
  it("trusts a cached id without touching the network", async () => {
    const { deps, listProjects, createProject, remember } = harness();
    await expect(
      ensureCloudProjectId({ id: "local", name: "Demo", cloudProjectId: "srv-1" }, deps),
    ).resolves.toBe("srv-1");
    expect(listProjects).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
    expect(remember).not.toHaveBeenCalled();
  });

  it("binds to an existing same-named server row instead of forking a duplicate", async () => {
    const { deps, createProject, remember } = harness([
      { id: "srv-other", name: "Other" },
      { id: "srv-demo", name: "  DEMO " }, // trimmed + case-insensitive match
    ]);
    await expect(ensureCloudProjectId({ id: "local", name: "Demo" }, deps)).resolves.toBe("srv-demo");
    expect(createProject).not.toHaveBeenCalled();
    // Cached so the next start doesn't re-list.
    expect(remember).toHaveBeenCalledWith("local", "srv-demo");
  });

  it("takes the FIRST match in server order when names collide (deterministic)", async () => {
    const { deps } = harness([
      { id: "srv-a", name: "Demo" },
      { id: "srv-b", name: "demo" },
    ]);
    await expect(ensureCloudProjectId({ id: "local", name: "Demo" }, deps)).resolves.toBe("srv-a");
  });

  it("creates a server row when nothing matches — claimed with the LOCAL id — and remembers it", async () => {
    const { deps, createProject, remember } = harness([{ id: "srv-other", name: "Other" }]);
    await expect(ensureCloudProjectId({ id: "local", name: "Demo" }, deps)).resolves.toBe("srv-Demo");
    expect(createProject).toHaveBeenCalledWith("Demo", "local");
    expect(remember).toHaveBeenCalledWith("local", "srv-Demo");
  });

  it("does not name-match a blank local name (never binds to some other unnamed row)", async () => {
    const { deps, createProject } = harness([{ id: "srv-blank", name: "   " }]);
    await expect(ensureCloudProjectId({ id: "local", name: "  " }, deps)).resolves.toBe("srv-  ");
    expect(createProject).toHaveBeenCalled();
  });

  it("prefers the row THIS local project claimed (chiefProjectId) over any name match", async () => {
    const { deps, createProject, remember } = harness([
      { id: "srv-name", name: "Demo", chiefProjectId: null },
      { id: "srv-mine", name: "Renamed Later", chiefProjectId: "local" },
    ]);
    await expect(ensureCloudProjectId({ id: "local", name: "Demo" }, deps)).resolves.toBe("srv-mine");
    expect(createProject).not.toHaveBeenCalled();
    expect(remember).toHaveBeenCalledWith("local", "srv-mine");
  });

  it("two local projects with the SAME name get two server rows (never adopt a sibling's row)", async () => {
    // roborev 46302: local names are folder-derived; ~work/frontend and ~clients/frontend must not
    // share a server row (and each other's cloud sessions).
    const { deps, createProject } = harness([
      { id: "srv-a", name: "frontend", chiefProjectId: "local-a" },
    ]);
    deps.localProjectIds = new Set(["local-a", "local-b"]); // the claimer is a SIBLING here
    await expect(ensureCloudProjectId({ id: "local-b", name: "frontend" }, deps)).resolves.toBe(
      "srv-frontend",
    );
    expect(createProject).toHaveBeenCalledWith("frontend", "local-b");
  });

  it("a SECOND MAC re-binds to the row a previous install claimed (roborev 46383)", async () => {
    // The claimer's local id does not exist in this store — that's another install of the same
    // user, and refusing the row would strand their running (billing) sessions.
    const { deps, createProject, remember } = harness([
      { id: "srv-a", name: "frontend", chiefProjectId: "old-install-uuid" },
    ]);
    deps.localProjectIds = new Set(["local-b"]);
    await expect(ensureCloudProjectId({ id: "local-b", name: "frontend" }, deps)).resolves.toBe(
      "srv-a",
    );
    expect(createProject).not.toHaveBeenCalled();
    expect(remember).toHaveBeenCalledWith("local-b", "srv-a");
  });

  // Adoption doesn't rewrite the row's chiefProjectId, so the SECOND same-named project on that
  // fresh install re-runs the identical predicate against an unchanged row — only the store knows
  // the first one already took it (roborev 46881).
  it("two same-named locals on a SECOND MAC don't both adopt the one foreign-claimed row", async () => {
    const rows = [{ id: "srv-a", name: "frontend", chiefProjectId: "old-install-uuid" }];
    // A stand-in for the store: `remember` records the binding, the thunk reads it back.
    const bound = new Map<string, string>();
    const boundFor = (self: string) => () =>
      new Set([...bound].filter(([lid]) => lid !== self).map(([, sid]) => sid));

    const first = harness(rows);
    first.deps.localProjectIds = new Set(["local-c", "local-d"]);
    first.deps.boundCloudProjectIds = boundFor("local-c");
    first.deps.remember = (lid, sid) => void bound.set(lid, sid);
    await expect(
      ensureCloudProjectId({ id: "local-c", name: "frontend" }, first.deps),
    ).resolves.toBe("srv-a");

    const second = harness(rows);
    second.deps.localProjectIds = new Set(["local-c", "local-d"]);
    second.deps.boundCloudProjectIds = boundFor("local-d");
    second.deps.remember = (lid, sid) => void bound.set(lid, sid);
    await expect(
      ensureCloudProjectId({ id: "local-d", name: "frontend" }, second.deps),
    ).resolves.toBe("srv-frontend");
    expect(second.createProject).toHaveBeenCalledWith("frontend", "local-d");
  });

  // reattachProjectOnOpen fires per project WITHOUT awaiting, so the two lookups overlap: both
  // start before either list resolves. A bound set snapshotted at call time is empty for both and
  // they both adopt the same row — the thunk is read after the await instead (roborev 46918).
  it("stays safe when the two lookups INTERLEAVE (bound set read after the list resolves)", async () => {
    const rows = [{ id: "srv-a", name: "frontend", chiefProjectId: "old-install-uuid" }];
    const bound = new Map<string, string>();
    const boundFor = (self: string) => () =>
      new Set([...bound].filter(([lid]) => lid !== self).map(([, sid]) => sid));

    // Both listProjects calls are issued before either resolves; C's resolves first.
    // (Manual resolver pattern — Promise.withResolvers needs an es2024 lib target.)
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    const gateC = deferred();
    const gateD = deferred();
    const mk = (self: string, gate: Promise<void>) => {
      const h = harness(rows);
      h.deps.localProjectIds = new Set(["local-c", "local-d"]);
      h.deps.boundCloudProjectIds = boundFor(self);
      h.deps.remember = (lid, sid) => void bound.set(lid, sid);
      h.deps.api.listProjects = async () => {
        await gate;
        return rows.map((r) => ({ ...r, chiefProjectId: r.chiefProjectId ?? null }));
      };
      return h;
    };
    const c = mk("local-c", gateC.promise);
    const d = mk("local-d", gateD.promise);

    const pC = ensureCloudProjectId({ id: "local-c", name: "frontend" }, c.deps);
    const pD = ensureCloudProjectId({ id: "local-d", name: "frontend" }, d.deps);
    gateC.resolve();
    await expect(pC).resolves.toBe("srv-a");
    gateD.resolve(); // D's list resolves only AFTER C has adopted
    await expect(pD).resolves.toBe("srv-frontend");
    expect(bound.get("local-c")).toBe("srv-a");
    expect(bound.get("local-d")).toBe("srv-frontend");
  });

  it("without a sibling set, claimed rows stay off-limits (conservative default)", async () => {
    const { deps, createProject } = harness([
      { id: "srv-a", name: "frontend", chiefProjectId: "someone" },
    ]);
    await expect(ensureCloudProjectId({ id: "local-b", name: "frontend" }, deps)).resolves.toBe(
      "srv-frontend",
    );
    expect(createProject).toHaveBeenCalledWith("frontend", "local-b");
  });

  it("propagates a lookup failure rather than starting against a guessed id", async () => {
    const { deps } = harness();
    deps.api.listProjects = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });
    await expect(ensureCloudProjectId({ id: "local", name: "Demo" }, deps)).rejects.toThrow(
      /Failed to fetch/,
    );
  });
});

describe("findCloudProjectId (re-attach path)", () => {
  it("never creates a server row — returns null when there's nothing to attach to", async () => {
    const { deps, createProject } = harness([{ id: "srv-other", name: "Other" }]);
    await expect(findCloudProjectId({ id: "local", name: "Demo" }, deps)).resolves.toBeNull();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("still resolves the cached id and the same-name match", async () => {
    const cached = harness();
    await expect(
      findCloudProjectId({ id: "l", name: "Demo", cloudProjectId: "srv-x" }, cached.deps),
    ).resolves.toBe("srv-x");

    const matched = harness([{ id: "srv-demo", name: "Demo" }]);
    await expect(findCloudProjectId({ id: "l", name: "Demo" }, matched.deps)).resolves.toBe("srv-demo");
    expect(matched.remember).toHaveBeenCalledWith("l", "srv-demo");
  });
});
