import { describe, it, expect, vi } from "vitest";
import { killProjectAgents, planWindowClose } from "./windowClose";
import type { Project } from "../types";

const project = {
  id: "p1",
  name: "P",
  rootPath: "/p",
  defaultBranch: null,
  createdAt: "",
  lastOpenedAt: "",
  selectedAgentId: null,
  agents: [{ id: "a1" }, { id: "a2" }],
} as unknown as Project;

describe("killProjectAgents", () => {
  it("kills, closes, and removes every agent", async () => {
    const kill = vi.fn(async () => {});
    const close = vi.fn();
    const removeAgent = vi.fn();
    await killProjectAgents(project, { kill, close, removeAgent });
    expect(kill).toHaveBeenCalledWith("a1");
    expect(kill).toHaveBeenCalledWith("a2");
    expect(close).toHaveBeenCalledWith("a1");
    expect(removeAgent).toHaveBeenCalledWith("p1", "a2");
  });

  it("swallows a PTY kill error and still removes the agent", async () => {
    const kill = vi.fn(async () => {
      throw new Error("gone");
    });
    const close = vi.fn();
    const removeAgent = vi.fn();
    await killProjectAgents(project, { kill, close, removeAgent });
    expect(removeAgent).toHaveBeenCalledWith("p1", "a1");
  });
});

describe("planWindowClose", () => {
  // Signature: planWindowClose(mode, isLast, isMain)
  it("keep + last → hide (headless survival), keep agents + registry", () => {
    expect(planWindowClose("keep", true, false)).toEqual({
      killAgents: false,
      hide: true,
      clearRegistry: false,
    });
  });

  it("secondary keep + not last → destroy + clear registry, agents survive", () => {
    expect(planWindowClose("keep", false, false)).toEqual({
      killAgents: false,
      hide: false,
      clearRegistry: true,
    });
  });

  it("secondary kill → destroy + clear registry + kill agents", () => {
    expect(planWindowClose("kill", false, false)).toEqual({
      killAgents: true,
      hide: false,
      clearRegistry: true,
    });
  });

  it("MAIN window while others remain → hide (never destroyed), keep registry", () => {
    // Both keep and kill hide the main window when it isn't last (it hosts Sparkle + the "main"
    // label). kill still tears down its agents.
    expect(planWindowClose("keep", false, true)).toEqual({
      killAgents: false,
      hide: true,
      clearRegistry: false,
    });
    expect(planWindowClose("kill", false, true)).toEqual({
      killAgents: true,
      hide: true,
      clearRegistry: false,
    });
  });

  it("main window that IS last → destroy on kill (app quits), hide on keep", () => {
    expect(planWindowClose("kill", true, true)).toEqual({
      killAgents: true,
      hide: false,
      clearRegistry: true,
    });
    expect(planWindowClose("keep", true, true)).toEqual({
      killAgents: false,
      hide: true,
      clearRegistry: false,
    });
  });
});
