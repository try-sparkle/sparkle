// @vitest-environment jsdom
//
// selectAndOpen is where a cross-window "needs attention" jump lands in the OWNING window. The bug
// it fixes: the publish side advertises every red agent regardless of kind/mode, but a window's
// sidebar only paints its current mode's rows — so a red agent could be advertised in another
// window yet sit filtered out of view in its own. selectAndOpen must REVEAL it: drop any special
// (Sparkle/board) overlay and switch the chevron to the agent's kind, then select + open it.
import { describe, it, expect, beforeEach, vi } from "vitest";

// useAttentionNotifications pulls in @tauri-apps/api/window at module load; stub it (selectAndOpen
// itself only touches the zustand stores).
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    unminimize: () => Promise.resolve(),
    show: () => Promise.resolve(),
    setFocus: () => Promise.resolve(),
  }),
}));

import { selectAndOpen } from "./useAttentionNotifications";
import { useProjectStore } from "./stores/projectStore";
import { useUiStore } from "./stores/uiStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSettingsStore } from "./stores/settingsStore";
import { useAuthStore } from "./stores/authStore";
import type { AgentTab, Project } from "./types";

const agent = (id: string, kind: AgentTab["kind"]): AgentTab =>
  ({
    id,
    kind,
    name: id,
    parentId: null,
    pinnedIndex: null,
    autoNameVariants: null,
    namePinned: false,
    shellCommand: null,
    baseBranch: null,
  }) as AgentTab;

const project = (agents: AgentTab[]): Project => ({
  id: "p1",
  name: "Sparkle",
  rootPath: "/tmp/p1",
  defaultBranch: null,
  createdAt: new Date(0).toISOString(),
  selectedAgentId: null,
  agents,
});

beforeEach(() => {
  useProjectStore.setState({ projects: [project([agent("a-think", "think"), agent("a-build", "build")])] });
  useRuntimeStore.setState({ openAgentIds: [] });
  // Start from the worst case for visibility: parked on the Plan board, chevron on Build.
  useUiStore.setState({ activeSpecial: "board", workMode: "build" });
  // Brainstorm gate ON by default (entitled + feature flag) so a think reveal can land on Think.
  useSettingsStore.getState().setAllAiFeatures(true);
  useAuthStore.setState({
    me: { clerkUserId: "u", entitled: true, balanceCents: 20000, tokenVersion: 1 },
    tokenPresent: true,
    loading: false,
  });
});

describe("selectAndOpen — reveals a cross-window-focused agent", () => {
  it("leaves the special overlay and switches the chevron to a THINK agent's mode", () => {
    selectAndOpen("p1", "a-think");
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useUiStore.getState().workMode).toBe("think");
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("a-think");
    expect(useRuntimeStore.getState().openAgentIds).toContain("a-think");
  });

  it("switches the chevron to Build for a build/worker/shell agent", () => {
    useUiStore.setState({ activeSpecial: "sparkle", workMode: "think" });
    selectAndOpen("p1", "a-build");
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useUiStore.getState().workMode).toBe("build");
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("a-build");
  });

  it("reveals a think agent as Build when the brainstorm gate is OFF (can't fight reconcile)", () => {
    // No Think chevron exists when gated off, so forcing Think would just be reverted by
    // reconcileWorkMode, re-hiding the agent. Land on Build; the ThinkPanel pane still shows by kind.
    useAuthStore.setState({ me: null, tokenPresent: false, loading: false }); // un-entitled → gate off
    useUiStore.setState({ activeSpecial: "board", workMode: "build" });
    selectAndOpen("p1", "a-think");
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useUiStore.getState().workMode).toBe("build");
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("a-think");
  });

  it("still selects + clears the overlay when the agent isn't found (no mode change)", () => {
    useUiStore.setState({ activeSpecial: "board", workMode: "build" });
    selectAndOpen("p1", "ghost");
    expect(useUiStore.getState().activeSpecial).toBeNull();
    expect(useUiStore.getState().workMode).toBe("build"); // unchanged — kind unknown
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe("ghost");
  });
});
