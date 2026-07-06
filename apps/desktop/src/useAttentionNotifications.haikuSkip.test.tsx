// @vitest-environment jsdom
//
// Phase-2b behavioral guard: when an agent has a FRESH self-report, the notification body uses it
// and the paid Haiku summarize_attention scrape is SKIPPED; when it doesn't, Haiku is called exactly
// as before, and a Haiku miss still degrades to the generic banner copy. This renders the real hook
// against the real stores, spying only on the two attention.ts boundaries (summarizeAttention =
// the paid call; notifyAttention = the macOS banner) so the precedence + cost-saving is proven
// end-to-end, not just at the pure-helper layer.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    unminimize: () => Promise.resolve(),
    show: () => Promise.resolve(),
    setFocus: () => Promise.resolve(),
  }),
}));

// Spy the attention.ts boundary. summarizeAttention is the credit-metered call we want to skip;
// notifyAttention is the banner whose `body` we assert. The other exports the hook imports are
// no-op stubs (they only invoke Tauri, absent under jsdom).
const summarizeAttention = vi.fn<(screen: string) => Promise<string | null>>();
const notifyAttention = vi.fn();
vi.mock("./services/attention", () => ({
  reportAttentionCount: vi.fn(),
  notifyAttention: (...a: unknown[]) => notifyAttention(...a),
  summarizeAttention: (s: string) => summarizeAttention(s),
  onFocusAgent: () => Promise.resolve(() => {}),
}));

// The phone relay fires alongside the banner but is a separate device — stub it so the test stays
// focused on the banner body + the paid-call gate.
vi.mock("./services/relayClient", () => ({
  emitAttention: vi.fn(),
  emitResolved: vi.fn(),
}));

import { useAttentionNotifications } from "./useAttentionNotifications";
import { CurrentProjectProvider } from "./windowContext";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useSettingsStore } from "./stores/settingsStore";
import type { AgentTab, Project } from "./types";

const AGENT_ID = "agent-1";

const agent = (activity?: string): AgentTab =>
  ({
    id: AGENT_ID,
    kind: "build",
    name: "Builder",
    parentId: null,
    pinnedIndex: null,
    autoNameVariants: null,
    namePinned: false,
    shellCommand: null,
    baseBranch: null,
    ...(activity !== undefined ? { activity } : {}),
  }) as AgentTab;

const project = (agents: AgentTab[]): Project => ({
  id: "p1",
  name: "Sparkle",
  rootPath: "/tmp/p1",
  defaultBranch: null,
  createdAt: new Date(0).toISOString(),
  selectedAgentId: null, // not the notified agent → banner never suppressed
  agents,
});

function Harness() {
  useAttentionNotifications();
  return null;
}

/** Seed a project with one agent, mount the hook (baseline pass), and return the render handle. */
function mountWith(a: AgentTab) {
  useProjectStore.setState({ projects: [project([a])], selectedProjectId: "p1" });
  useRuntimeStore.setState({ status: { [AGENT_ID]: "working" }, attentionScreen: {} });
  return render(
    <CurrentProjectProvider>
      <Harness />
    </CurrentProjectProvider>,
  );
}

/** Set the agent's activity narration (a store change the hook observes as a fresh update). */
function setActivity(text: string) {
  useProjectStore.setState((s) => ({
    projects: s.projects.map((p) =>
      p.id === "p1" ? { ...p, agents: p.agents.map((ag) => ({ ...ag, activity: text })) } : p,
    ),
  }));
}

/** Drive the agent into `waiting`, optionally with an ask-screen snapshot for the Haiku path. */
function goWaiting(screen?: string) {
  useRuntimeStore.setState((s) => ({
    status: { ...s.status, [AGENT_ID]: "waiting" },
    attentionScreen: screen ? { ...s.attentionScreen, [AGENT_ID]: screen } : s.attentionScreen,
  }));
}

beforeEach(() => {
  summarizeAttention.mockReset();
  notifyAttention.mockReset();
  // Default notify prefs already enable waiting/approval; make sure the store is at its defaults.
  useSettingsStore.setState({ notifyStatuses: { ...useSettingsStore.getState().notifyStatuses, waiting: true } });
});

afterEach(() => {
  cleanup();
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ status: {}, attentionScreen: {} });
});

describe("Phase-2b — fresh self-report skips the paid Haiku scrape", () => {
  it("uses a FRESH self-report as the banner body and does NOT call summarizeAttention", async () => {
    mountWith(agent()); // baseline: no activity yet
    await act(async () => {
      setActivity("Refactoring the auth middleware"); // observed as a fresh change
      goWaiting("some ask-screen text that Haiku would otherwise summarize");
      await Promise.resolve();
    });
    expect(summarizeAttention).not.toHaveBeenCalled(); // the cost saving
    expect(notifyAttention).toHaveBeenCalledTimes(1);
    expect(notifyAttention.mock.calls[0]![0]).toMatchObject({
      agentId: AGENT_ID,
      body: "Refactoring the auth middleware",
    });
  });

  it("calls summarizeAttention (as today) when there is NO self-report", async () => {
    summarizeAttention.mockResolvedValue("Approve deleting build/?");
    mountWith(agent()); // never narrates
    await act(async () => {
      goWaiting("● Bash(rm -rf build)\nProceed?");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(summarizeAttention).toHaveBeenCalledTimes(1);
    expect(notifyAttention.mock.calls[0]![0]).toMatchObject({ body: "Approve deleting build/?" });
  });

  it("falls back to the generic banner copy when Haiku returns null", async () => {
    summarizeAttention.mockResolvedValue(null); // no key / network / empty
    mountWith(agent());
    await act(async () => {
      goWaiting("● Bash(rm -rf build)\nProceed?");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(summarizeAttention).toHaveBeenCalledTimes(1);
    // notificationFor(waiting) → "Needs your answer · Sparkle".
    expect(notifyAttention.mock.calls[0]![0]!.body).toBe("Needs your answer · Sparkle");
  });

  it("ignores a STALE self-report (present but not recently updated) and calls Haiku", async () => {
    summarizeAttention.mockResolvedValue("Haiku says hi");
    // Activity present from the FIRST sighting = unknown age (persisted-restore) → treated as stale.
    mountWith(agent("Stale line from a previous session"));
    await act(async () => {
      goWaiting("ask-screen text");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(summarizeAttention).toHaveBeenCalledTimes(1);
    expect(notifyAttention.mock.calls[0]![0]).toMatchObject({ body: "Haiku says hi" });
  });
});
