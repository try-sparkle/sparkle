// @vitest-environment jsdom
//
// The RECEIVING half of every cross-webview "show me this" click: a notification, a capture-window
// Open, a helper-island chiclet. It is load-bearing — nothing else raises the app window.
//
// Three events, three contracts:
//   attention://focus-agent    → validate, raise, select the tab, mount + select the agent
//   attention://select-project → validate, raise, select the tab, and touch NOTHING else
//   attention://focus-tier     → raise and narrow the sidebar to a tier; mount NOTHING
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusAgentPayload, SelectProjectPayload } from "./services/attention";

const bringToFront = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: () => {
      bringToFront();
      return Promise.resolve();
    },
    setFocus: () => Promise.resolve(),
    unminimize: () => Promise.resolve(),
    isMinimized: () => Promise.resolve(false),
  }),
}));

// Capture the handlers the hook registers, so a test can play the broadcast.
let onFocus: ((p: FocusAgentPayload) => void) | null = null;
let onSelect: ((p: SelectProjectPayload) => void) | null = null;
let onTier: ((p: { band: StatusBand }) => void) | null = null;
vi.mock("./services/attention", () => ({
  reportAttentionCount: vi.fn(),
  notifyAttention: vi.fn(),
  summarizeAttention: vi.fn(async () => null),
  onFocusAgent: (cb: (p: FocusAgentPayload) => void) => {
    onFocus = cb;
    return Promise.resolve(() => {});
  },
  onSelectProject: (cb: (p: SelectProjectPayload) => void) => {
    onSelect = cb;
    return Promise.resolve(() => {});
  },
  // The helper island's P0/P1 chiclet broadcast.
  onFocusTier: (cb: (p: { band: StatusBand }) => void) => {
    onTier = cb;
    return Promise.resolve(() => {});
  },
  emitFocusTier: vi.fn(),
  publishWindowRoster: vi.fn(),
  clearWindowRoster: vi.fn(),
  getRoster: vi.fn(async () => null),
  onRosterChanged: vi.fn(() => Promise.resolve(() => {})),
  emitFocusAgent: vi.fn(),
  emitSelectProject: vi.fn(),
}));
vi.mock("./services/relayClient", () => ({
  emitAttention: vi.fn(),
  emitResolved: vi.fn(),
  pushRoster: vi.fn(),
}));
vi.mock("./services/terminalScrollback", () => ({ getAgentScrollback: vi.fn(async () => "") }));

import { useAttentionNotifications } from "./useAttentionNotifications";
import { AppBoot } from "./windowContext";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useUiStore } from "./stores/uiStore";
import type { AgentTab, Project } from "./types";
import type { StatusBand } from "./engine/buildSections";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,  };
}
function mkProject(id: string, agents: AgentTab[]): Project {
  return {
    id, name: id, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents,
  };
}

function Harness() {
  useAttentionNotifications();
  return null;
}

async function mount() {
  const view = render(
    <AppBoot>
      <Harness />
    </AppBoot>,
  );
  await waitFor(() => expect(onFocus).toBeTruthy());
  await waitFor(() => expect(onSelect).toBeTruthy());
  return view;
}

beforeEach(() => {
  onFocus = null;
  onSelect = null;
  bringToFront.mockClear();
  useProjectStore.setState({
    projects: [mkProject("p1", [mkAgent("a1")]), mkProject("p2", [mkAgent("a2")])],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: [] } as never);
  useUiStore.getState().setActiveSpecial(null);
  useUiStore.getState().setWorkMode("build");
});
afterEach(cleanup);

describe("focus-agent routing", () => {
  it("reveals an agent in ANOTHER project: raises, selects the tab, mounts the agent", async () => {
    await mount();
    onFocus!({ projectId: "p2", agentId: "a2" });
    await waitFor(() => expect(bringToFront).toHaveBeenCalled());
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    expect(useProjectStore.getState().projects.find((p) => p.id === "p2")?.selectedAgentId).toBe("a2");
    expect(useRuntimeStore.getState().isOpen("a2")).toBe(true);
  });

  it("reveals an agent in the CURRENT project without re-selecting the tab", async () => {
    await mount();
    onFocus!({ projectId: "p1", agentId: "a1" });
    await waitFor(() => expect(useRuntimeStore.getState().isOpen("a1")).toBe(true));
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
  });

  it("a STALE AGENT id still raises and lands on its project — but opens no phantom agent", async () => {
    // roborev 46328-M3: the user clicked a notification. A deleted agent must not put a phantom
    // id in the open set, but the window must still come forward and show the agent's project.
    await mount();
    onFocus!({ projectId: "p2", agentId: "deleted-agent" });
    await waitFor(() => expect(bringToFront).toHaveBeenCalled());
    await waitFor(() => expect(useProjectStore.getState().selectedProjectId).toBe("p2"));
    expect(useRuntimeStore.getState().openAgentIds).toEqual([]);
  });

  it("an unknown PROJECT neither raises nor selects while it stays unknown", async () => {
    // roborev 46328-M2 + 46485-L: the id may belong to a project added in another webview that
    // hasn't rehydrated here yet, so the payload is DEFERRED rather than dropped — but the raise
    // waits with it. Jumping the window to the front is an interruption; it is owed to a payload
    // that names something we can actually show, not to any id that arrives on the channel.
    await mount();
    onFocus!({ projectId: "deleted-project", agentId: "a2" });
    await new Promise((r) => setTimeout(r, 20));
    expect(bringToFront).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().openAgentIds).toEqual([]);
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
  });

  it("a project that rehydrates late raises and reveals THEN (focus-agent)", async () => {
    await mount();
    onFocus!({ projectId: "late-p", agentId: "late-a" });
    await new Promise((r) => setTimeout(r, 20));
    expect(bringToFront).not.toHaveBeenCalled();
    // The project (with its agent) lands via the coalesced cross-window rehydrate…
    useProjectStore.setState((s) => ({
      projects: [...s.projects, mkProject("late-p", [mkAgent("late-a")])],
    }));
    // …and only now does the window come forward, with the full reveal.
    await waitFor(() => expect(bringToFront).toHaveBeenCalled());
    await waitFor(() => expect(useProjectStore.getState().selectedProjectId).toBe("late-p"));
    expect(useRuntimeStore.getState().isOpen("late-a")).toBe(true);
  });

  it("an IMMEDIATE click also supersedes a pending deferral (roborev 46897)", async () => {
    // The dedup lived inside awaitInStore, so it only covered deferral-vs-deferral. The
    // focus-agent FAST path (the project is already here) reveals inline, so an earlier deferral
    // survived it and re-pointed the tab the moment its own project rehydrated.
    await mount();
    onFocus!({ projectId: "late-p", agentId: "late-a" }); // deferred: not in the store yet
    onFocus!({ projectId: "p2", agentId: "a2" }); // immediate: p2/a2 exist
    await waitFor(() => expect(useProjectStore.getState().selectedProjectId).toBe("p2"));
    // …now the superseded click's project arrives. It must NOT steal the tab back.
    useProjectStore.setState((s) => ({
      projects: [...s.projects, mkProject("late-p", [mkAgent("late-a")])],
    }));
    await new Promise((r) => setTimeout(r, 20));
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    expect(useRuntimeStore.getState().isOpen("late-a")).toBe(false);
  });

  it("keeps only the NEWEST deferral — an older pending click can't win the tab", async () => {
    // roborev 46485-M: un-deduped deferrals meant the tab you landed on was whichever project
    // rehydrated last, not the notification you clicked most recently.
    await mount();
    onFocus!({ projectId: "late-a-proj", agentId: "x" });
    onSelect!({ projectId: "late-b-proj" });
    useProjectStore.setState((s) => ({
      projects: [...s.projects, mkProject("late-b-proj", []), mkProject("late-a-proj", [])],
    }));
    await waitFor(() => expect(useProjectStore.getState().selectedProjectId).toBe("late-b-proj"));
    // The superseded first click never fires, even though its project also arrived.
    await new Promise((r) => setTimeout(r, 20));
    expect(useProjectStore.getState().selectedProjectId).toBe("late-b-proj");
  });

  it("a deferral pending at unmount never fires (roborev 46485-M)", async () => {
    const view = await mount();
    onSelect!({ projectId: "arrives-after-unmount" });
    view.unmount();
    useProjectStore.setState((s) => ({
      projects: [...s.projects, mkProject("arrives-after-unmount", [])],
    }));
    await new Promise((r) => setTimeout(r, 20));
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
    expect(bringToFront).not.toHaveBeenCalled();
  });
});

describe("focus-tier routing (helper island chiclets)", () => {
  beforeEach(() => useUiStore.getState().showAllStatusBands());

  it("raises the window and isolates the clicked band in the sidebar filter", async () => {
    await mount();
    onTier!({ band: "needs_you" });
    await waitFor(() => expect(bringToFront).toHaveBeenCalled());
    // Writes the SAME statusFilter the sidebar chips render, so the click's effect is visible in
    // the chip bar and clearable by the ordinary "Show all" — not an invisible mode with its own
    // bespoke dismiss control (which is what the retired attentionTierFocus needed).
    expect(useUiStore.getState().statusFilter).toEqual({
      needs_you: true,
      running: false,
      done: false,
    });
  });

  it("does NOT mount an agent — a band is not an agent", async () => {
    await mount();
    onTier!({ band: "running" });
    await waitFor(() => expect(useUiStore.getState().statusFilter.running).toBe(true));
    // Same contract as select-project: no PTY is spawned for a click that asked to SEE a band.
    expect(useRuntimeStore.getState().openAgentIds).toEqual([]);
  });

  it("replaces the previous band rather than accumulating", async () => {
    await mount();
    onTier!({ band: "needs_you" });
    await waitFor(() => expect(useUiStore.getState().statusFilter.needs_you).toBe(true));
    onTier!({ band: "running" });
    await waitFor(() =>
      expect(useUiStore.getState().statusFilter).toEqual({
        needs_you: false,
        running: true,
        done: false,
      }),
    );
  });
});

describe("select-project routing", () => {
  it("selects the tab and raises the window — and opens NO agent", async () => {
    await mount();
    onSelect!({ projectId: "p2" });
    await waitFor(() => expect(bringToFront).toHaveBeenCalled());
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
    // The whole point of the separate event: no PTY is spawned for a click that asked to SEE a
    // project, and the work mode the user chose is left alone.
    expect(useRuntimeStore.getState().openAgentIds).toEqual([]);
    expect(useProjectStore.getState().projects.find((p) => p.id === "p2")?.selectedAgentId).toBeNull();
  });

  it("works for a project with no agents at all", async () => {
    useProjectStore.setState({
      projects: [mkProject("p1", [mkAgent("a1")]), mkProject("empty", [])],
      selectedProjectId: "p1",
    } as never);
    await mount();
    onSelect!({ projectId: "empty" });
    await waitFor(() => expect(useProjectStore.getState().selectedProjectId).toBe("empty"));
    expect(bringToFront).toHaveBeenCalled();
  });

  it("an unknown project neither raises nor moves the selection", async () => {
    // roborev 46328-M2 + 46485-L: deferred, not dropped — but nothing visible happens until (and
    // unless) the id actually lands. A ghost id must not steal the window.
    await mount();
    onSelect!({ projectId: "ghost" });
    await new Promise((r) => setTimeout(r, 20));
    expect(bringToFront).not.toHaveBeenCalled();
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
  });

  it("DEFERS selection for a project that rehydrates just after the event (the cross-webview race)", async () => {
    await mount();
    onSelect!({ projectId: "late-p" });
    await new Promise((r) => setTimeout(r, 20));
    expect(bringToFront).not.toHaveBeenCalled();
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
    // The project arrives with the (coalesced) cross-window rehydrate…
    useProjectStore.setState((s) => ({
      projects: [...s.projects, mkProject("late-p", [])],
    }));
    // …and the deferred raise + selection fire together.
    await waitFor(() => expect(useProjectStore.getState().selectedProjectId).toBe("late-p"));
    expect(bringToFront).toHaveBeenCalled();
  });
});
