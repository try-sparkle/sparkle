import { beforeEach, describe, expect, it } from "vitest";
import { useProjectStore } from "./projectStore";
import { resolveChiefProject } from "../services/chiefScope";
import type { ChiefProject } from "../services/chiefScope";
import type { Project } from "../types";

// setChiefBinding — the ONE store write behind the Chief binding UI (bead `sparkle-8rr0c`).
//
// Every assertion here reads the binding BACK OUT of the store rather than inspecting the argument
// it was handed: the field is persisted and is what `services/chiefScope.resolveChiefProject` runs
// its `includes` check against, so "what ended up stored" is the only fact that matters.

function seed(overrides: Partial<Project> = {}) {
  const project: Project = {
    id: "p1",
    name: "P",
    rootPath: "/tmp/p",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents: [],
    ...overrides,
  };
  useProjectStore.setState({ projects: [project], selectedProjectId: "p1" } as never);
}

const stored = () => useProjectStore.getState().projects.find((p) => p.id === "p1")!;

const bind = (chiefProjectIds: string[], chiefPrimaryId: string | null) =>
  useProjectStore.getState().setChiefBinding("p1", { chiefProjectIds, chiefPrimaryId });

describe("projectStore.setChiefBinding", () => {
  beforeEach(() => seed());

  it("PERSISTS the binding — both ids and the primary survive a read-back", () => {
    bind(["proj_a", "proj_b"], "proj_b");

    expect(stored().chiefProjectIds).toEqual(["proj_a", "proj_b"]);
    expect(stored().chiefPrimaryId).toBe("proj_b");
  });

  it("CORRECTS a primary that is not a member of the bound set to null", () => {
    // The read path treats a primary outside the allowed set as a store-consistency bug and refuses
    // EVERY unnamed call for that project (chiefScope.ts's `out_of_scope` arm). Storing it would
    // therefore not be a slightly-wrong binding — it would be a dead one.
    bind(["proj_a"], "proj_zzz");

    expect(stored().chiefProjectIds).toEqual(["proj_a"]);
    expect(stored().chiefPrimaryId).toBeNull();
  });

  it("the corrected binding is one the SCOPE CHECK accepts — the invariant is not cosmetic", () => {
    // The side effect that matters is downstream: feed the stored binding to the real resolver and
    // assert it answers with a refusal that ASKS rather than the inconsistent-binding refusal.
    bind(["proj_a"], "proj_zzz");
    const p = stored();
    const catalog: ChiefProject[] = [{ project_id: "proj_a", name: "Alpha" }];

    const decision = resolveChiefProject(
      {
        kind: "agent",
        agentId: "a1",
        allowed: p.chiefProjectIds ?? [],
        primary: p.chiefPrimaryId ?? null,
      },
      undefined,
      catalog,
    );

    expect(decision.ok).toBe(false);
    // "ambiguous" = "no default, ask". Had the bad primary been stored, this would be
    // "out_of_scope" with the "binding is inconsistent" message.
    expect(decision.ok === false && decision.reason).toBe("ambiguous");
  });

  it("removing the LAST bound project clears the primary to null", () => {
    bind(["proj_a"], "proj_a");
    expect(stored().chiefPrimaryId).toBe("proj_a");

    bind([], "proj_a");

    expect(stored().chiefProjectIds).toEqual([]);
    expect(stored().chiefPrimaryId).toBeNull();
  });

  it("unbinding entirely leaves an EMPTY set, which the scope check reads as a refusal", () => {
    bind(["proj_a", "proj_b"], "proj_a");
    bind([], null);

    const p = stored();
    expect(p.chiefProjectIds).toEqual([]);

    const decision = resolveChiefProject(
      { kind: "agent", agentId: "a1", allowed: p.chiefProjectIds ?? [], primary: p.chiefPrimaryId ?? null },
      "proj_a",
      [{ project_id: "proj_a", name: "Alpha" }],
    );
    expect(decision.ok === false && decision.reason).toBe("unbound");
  });

  it("de-duplicates and trims ids, and keeps a primary that survives the normalisation", () => {
    bind(["proj_a", " proj_a ", "", "  ", "proj_b"], "proj_a");

    expect(stored().chiefProjectIds).toEqual(["proj_a", "proj_b"]);
    expect(stored().chiefPrimaryId).toBe("proj_a");
  });

  it("re-binding REPLACES rather than merges — a dropped id is gone from the store", () => {
    bind(["proj_a", "proj_b"], "proj_b");
    bind(["proj_a"], null);

    expect(stored().chiefProjectIds).toEqual(["proj_a"]);
    expect(stored().chiefPrimaryId).toBeNull();
  });

  it("touches no other project", () => {
    useProjectStore.setState({
      projects: [
        ...useProjectStore.getState().projects,
        {
          id: "p2",
          name: "Q",
          rootPath: "/tmp/q",
          defaultBranch: null,
          createdAt: new Date(0).toISOString(),
          selectedAgentId: null,
          agents: [],
        } as Project,
      ],
    } as never);

    bind(["proj_a"], "proj_a");

    const other = useProjectStore.getState().projects.find((p) => p.id === "p2")!;
    expect(other.chiefProjectIds).toBeUndefined();
    expect(other.chiefPrimaryId).toBeUndefined();
  });
});
