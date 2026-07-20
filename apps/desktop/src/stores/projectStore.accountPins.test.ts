import { beforeEach, describe, expect, it, vi } from "vitest";

// accountStore reaches Tauri for its command wrappers; the pin surface under test is pure +
// localStorage, so a stub invoke keeps the import side-effect-free.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useProjectStore } from "./projectStore";
import { getPin, setPin, clearAllPins } from "../services/accountStore";
import type { AgentTab, Project } from "../types";

// Closing an agent must also drop its persisted account pin. Pins outlive the session now
// (sparkle-gms0 persisted them to localStorage), so without this they accumulate forever and can
// keep naming an account the user later removed.

function mkAgent(over: Partial<AgentTab> & { id: string }): AgentTab {
  return {
    name: over.id.toUpperCase(), kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, pinnedIndex: null,
    ...over,
  };
}

function mkProject(over: Partial<Project> & { id: string }): Project {
  return {
    name: "P", rootPath: "/tmp/p", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    freshBuildAgentId: null, agents: [], ...over,
  };
}

describe("projectStore — account pins are cleaned up on agent removal", () => {
  beforeEach(() => {
    clearAllPins();
    useProjectStore.setState({
      projects: [
        mkProject({
          id: "p1",
          agents: [
            mkAgent({ id: "build1" }),
            mkAgent({ id: "worker1", kind: "worker", parentId: "build1" }),
            mkAgent({ id: "other" }),
          ],
        }),
      ],
    } as never);
  });

  it("removing an agent clears its pin", () => {
    setPin("build1", "acctX");
    useProjectStore.getState().removeAgent("p1", "build1");
    expect(getPin("build1")).toBeUndefined();
  });

  it("removing a build agent also clears its workers' pins (they close with it)", () => {
    setPin("build1", "acctX");
    setPin("worker1", "acctY");
    useProjectStore.getState().removeAgent("p1", "build1");
    expect(getPin("worker1")).toBeUndefined();
  });

  it("leaves other agents' pins alone", () => {
    setPin("build1", "acctX");
    setPin("other", "acctZ");
    useProjectStore.getState().removeAgent("p1", "build1");
    expect(getPin("other")).toBe("acctZ");
  });
});
