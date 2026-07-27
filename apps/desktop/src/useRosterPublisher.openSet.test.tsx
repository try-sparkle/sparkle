// @vitest-environment jsdom
//
// What actually leaves the machine. The hook publishes to two consumers — the phone relay
// (pushRoster) and the Rust tray aggregator (publishWindowRoster) — and the single-window shell
// briefly made that "every project in the store", including never-opened ones whose agents carry
// real prompt text (roborev 46258-M1/M2). This drives the REAL hook, timer and all.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushRoster = vi.fn();
const publishWindowRoster = vi.fn();
vi.mock("./services/relayClient", () => ({
  pushRoster: (...a: unknown[]) => pushRoster(...a),
  emitAttention: vi.fn(),
  emitResolved: vi.fn(),
}));
vi.mock("./services/attention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./services/attention")>()),
  publishWindowRoster: (...a: unknown[]) => publishWindowRoster(...a),
}));

import { useRosterPublisher } from "./useRosterPublisher";
import { AppBoot } from "./windowContext";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { markProjectVisited, resetVisitedProjects } from "./services/sessionProjects";
import type { AgentTab, Project } from "./types";

function mkProject(id: string, agentId: string): Project {
  return {
    id, name: id, rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [
      {
        id: agentId, name: agentId, kind: "build", parentId: null, runtime: "local",
        worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
        promptHistory: [], namePinned: false, autoNameBasis: null,
        autoNameVariants: null, shellCommand: null, pinnedIndex: null,
      } as AgentTab,
    ],
  };
}

function Harness() {
  useRosterPublisher();
  return null;
}

/** Render the hook and let its 250ms debounce fire. */
async function publish() {
  render(
    <AppBoot>
      <Harness />
    </AppBoot>,
  );
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
}

const publishedIds = () =>
  (pushRoster.mock.calls.at(-1)?.[0] as { projects: { id: string }[] } | undefined)?.projects.map(
    (p) => p.id,
  );

beforeEach(() => {
  vi.useFakeTimers();
  pushRoster.mockClear();
  publishWindowRoster.mockClear();
  resetVisitedProjects();
  useProjectStore.setState({
    projects: [mkProject("live", "a1"), mkProject("dormant", "a2"), mkProject("touched", "a3")],
    selectedProjectId: null,
  } as never);
  useRuntimeStore.setState({ openAgentIds: [] } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useRosterPublisher — only OPEN projects leave the machine", () => {
  it("publishes a project with a live agent", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] } as never);
    await publish();
    expect(publishedIds()).toEqual(["live"]);
  });

  it("publishes a project whose tab was selected this session, even with nothing running", async () => {
    markProjectVisited("touched");
    await publish();
    expect(publishedIds()).toEqual(["touched"]);
  });

  it("NEVER publishes a project that was never opened and has nothing running", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] } as never);
    await publish();
    expect(publishedIds()).not.toContain("dormant");
  });

  it("sends the roster aggregator the same slice as the relay", async () => {
    useRuntimeStore.setState({ openAgentIds: ["a1"] } as never);
    markProjectVisited("touched");
    await publish();
    const aggregated = publishWindowRoster.mock.calls.at(-1)?.[1] as { id: string }[];
    expect(aggregated.map((p) => p.id)).toEqual(publishedIds());
  });

  it("re-publishes when a tab is selected for the first time (the visited set is not a store)", async () => {
    await publish();
    expect(publishedIds()).toEqual([]);
    // Two acts: the first lets the subscription re-render the hook (which re-arms its debounce),
    // the second fires that new timer.
    await act(async () => markProjectVisited("touched"));
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(publishedIds()).toEqual(["touched"]);
  });
});
