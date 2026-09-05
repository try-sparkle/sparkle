// @vitest-environment jsdom
//
// THE MOUNT GATE, DRIVEN THROUGH THE REAL SHELL (bead `sparkle-ftapmp`).
//
// `services/agentCapacity` stopped spending a RESIDENTS-denominated memory ceiling against a count
// of ROWS. The comment that had defended that mismatch gave exactly one reason — "a dormant row
// becomes resident the moment its tab is clicked, WITH NO GATE IN BETWEEN" — so overturning it meant
// supplying that gate, and this file is what proves the gate is actually WIRED.
//
// ── WHY A WORKSPACE TEST AND NOT ONLY THE UNIT ONES ────────────────────────────────────────────
// `paneResidencyAdmission.test.ts` proves the decision and `usePaneResidencyAdmission.test.tsx`
// proves the hook. Neither can see the seam that matters: whether `Workspace` actually consults the
// verdict when it builds `stagedLive`. Delete that one `residency.admitted.has(...)` clause and BOTH
// of those suites stay green while the hole is wide open again — the "defaulted seam every test
// injects" shape AGENTS.md names. So these drive the real component, with the real memory cache
// behind a controllable `invoke`, and assert on the panes that do and do not mount.
//
// The harness is `Workspace.paneMounting.test.tsx`'s, with ONE change: `invoke` is a vi.fn rather
// than a stub returning null, because the whole subject is what the app does with a real
// `memory_admission` payload.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    setTitle: () => Promise.resolve(),
  }),
  getAllWindows: () => Promise.resolve([{}]),
}));
// THE ONE HARNESS DIFFERENCE. Every other tauri command in the shell still resolves to null; only
// `memory_admission` is answered, and only when a test has seeded a reading. A blanket null would
// make `refreshMemoryAdmission` treat every poll as a malformed payload, so no reading could ever
// reach the gate and every assertion below would pass for the wrong reason.
const memoryPayload = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string) =>
    Promise.resolve(cmd === "memory_admission" ? memoryPayload.value : null),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../windowContext", async () => {
  const { useProjectStore } = await import("../stores/projectStore");
  return {
    useCurrentProjectId: () => useProjectStore((s) => s.selectedProjectId),
    useIsMainWindow: () => false,
    useCurrentWindowLabel: () => "main",
  };
});
vi.mock("../services/orchestrationListener", () => ({
  startOrchestrationListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/controlListener", () => ({
  startControlListener: () => Promise.resolve(() => {}),
}));
vi.mock("../services/crossWindowSync", () => ({ subscribeToCrossWindowSync: () => () => {} }));
vi.mock("../services/cloudAgents/startup", () => ({
  reattachProjectOnOpen: async () => [] as string[],
}));
// Spread the original: this module gained `SPARKLE_AGENT_ID` on main, and a wholesale stub silently
// drops exports added later, so the shell fails to COLLECT for a reason unrelated to the test.
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));

/** The PTY ledger. `spawns` counts mounts; `kills` counts effect cleanups — the exact thing
 *  `Terminal`'s unmount does to a real PTY. `instances` records the identity token a pane minted on
 *  the mount it is currently living in. */
const pty = vi.hoisted(() => ({
  spawns: new Map<string, number>(),
  kills: new Map<string, number>(),
  instances: new Map<string, object>(),
}));

vi.mock("./AgentPane", async () => {
  const { useEffect, useState, createElement } = await import("react");
  const Pane = ({ agent, visible }: { agent: { id: string }; visible: boolean }) => {
    // One token per MOUNT. A remount mints a new object; a move keeps this one.
    const [token] = useState(() => ({}));
    useEffect(() => {
      pty.spawns.set(agent.id, (pty.spawns.get(agent.id) ?? 0) + 1);
      pty.instances.set(agent.id, token);
      // THE PTY KILL. Cleanup runs on unmount and on nothing else, which is precisely why it is the
      // right probe: React has no other way to tell a move from a remount from the outside.
      return () => {
        pty.kills.set(agent.id, (pty.kills.get(agent.id) ?? 0) + 1);
      };
    }, [agent.id, token]);
    return createElement("div", {
      "data-testid": `pane-${agent.id}`,
      "data-visible": String(visible),
    });
  };
  return { AgentPane: Pane };
});
vi.mock("./AgentSidebar", () => ({
  AgentSidebar: () => <div data-testid="sidebar" />,
}));
vi.mock("./ConciergeHost", () => ({ ConciergeHost: () => <div data-testid="concierge" /> }));
vi.mock("./OfflineBanner", () => ({ OfflineBanner: () => null }));
vi.mock("./ZeroCreditBanner", () => ({ ZeroCreditBanner: () => null }));
vi.mock("./SparkleAgentPane", () => ({ SparkleAgentPane: () => null }));
vi.mock("./ProjectModal", () => ({ ProjectModal: () => null }));
vi.mock("./ClosePrompt", () => ({ ClosePrompt: () => null }));
vi.mock("./BoardView", () => ({ BoardView: () => null }));
vi.mock("./Concierge/KebabMenu", () => ({ ConciergeTopRight: () => null }));
vi.mock("./OpenPrMenu", () => ({ OpenPrMenu: () => null, agentLinkForBranch: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./StatusStrip", () => ({ StatusStrip: () => null }));
vi.mock("./NewCloudAgentDialog", () => ({ NewCloudAgentDialog: () => null }));

import { Workspace } from "./Workspace";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useAuthStore } from "../stores/authStore";
import { useConnectionStore } from "../stores/connectionStore";
import { markProjectVisited, resetVisitedProjects } from "../services/sessionProjects";
import { resetCable } from "../stores/cableStore";
import type { AgentTab, Project } from "../types";
import { refreshMemoryAdmission, resetMemoryAdmission } from "../services/memoryAdmission";
import { PANE_RESIDENCY_BANNER_TESTID } from "./PaneResidencyBanner";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,
  };
}
function mkProject(id: string, agents: AgentTab[]): Project {
  return {
    id, name: id.toUpperCase(), rootPath: `/tmp/${id}`, defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: agents[0]!.id, agents,
  };
}

/** Three projects, two agents each — enough that "a pair closed and everything moved" is a real
 *  migration rather than a single element changing parents. */
const PROJECTS = ["p1", "p2", "p3"];
const AGENTS = PROJECTS.flatMap((p) => [`${p}-a`, `${p}-b`]);

beforeEach(() => {
  pty.spawns.clear();
  pty.kills.clear();
  pty.instances.clear();
  localStorage.clear();
  useProjectStore.setState({
    projects: PROJECTS.map((p) => mkProject(p, [mkAgent(`${p}-a`), mkAgent(`${p}-b`)])),
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: AGENTS, status: {} } as never);
  useUiStore.setState({
    activeSpecial: null, workModeBySide: { left: "build", right: "build" }, pinnedProjectId: null, openProjectIds: null,
    pairAssignment: {}, leftProjectId: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  // The memory cache is module state and outlives a component tree, so one test's reading would
  // otherwise decide the next one's mount set.
  memoryPayload.value = null;
  resetMemoryAdmission();
  // Every project counts as visited, so all six panes are mounted before the first move. The pane
  // list is lazy by design (`live` skips never-visited projects) and a project that had no panes
  // could not lose any — which would make every assertion below pass for the wrong reason.
  for (const p of PROJECTS) markProjectVisited(p);
  resetCable();
});
afterEach(() => {
  cleanup();
  resetCable();
  resetMemoryAdmission();
  memoryPayload.value = null;
  localStorage.clear();
});


/** Seed the memory cache the way `App.tsx`'s poll does — through the real refresh path, with the
 *  real resident count, so nothing here reaches around the wiring under test.
 *
 *  `memoryAdmitted` is in RESIDENTS, which is the denomination the whole bead is about: it is what
 *  Rust's `sampled_admission` returns and what `residentAdmissionCeiling` reads. `static_max` is
 *  deliberately larger, so a narrowing reading is a MEASUREMENT and not the static prediction — the
 *  gate is inert on the latter by design.
 *
 *  `inUse: 0` IS THE HONEST VALUE HERE, not a convenience (roborev 81145 flagged the shape). These
 *  tests seed the reading BEFORE rendering, so at that instant this window has no pane mounted at
 *  all — which is exactly what `pollMemoryAdmission` would send, since the gate publishes its
 *  mounted count and it is zero. A fixture claiming residents that do not exist is the "verified
 *  against a fiction" shape; this one describes a real moment in the app's life (a cold start with
 *  rows restored and nothing running yet). */
async function seedMemory(memoryAdmitted: number, staticMax: number, inUse: number) {
  memoryPayload.value = {
    effective: memoryAdmitted,
    static_max: staticMax,
    static_bound: "cpu",
    bound: "available",
    basis: `refused: only 2.0 GiB of memory is available right now — room for ${memoryAdmitted - inUse} more on top of the ${inUse} running`,
    memory_admitted: memoryAdmitted,
    memory_basis: "refused: only 2.0 GiB of memory is available right now",
    load_headroom: 0,
    sampled: true,
    sample: null,
  };
  useSettingsStore.setState({
    beadsEnabled: true,
    maxConcurrentWorkers: staticMax,
    effectiveMaxConcurrentWorkers: staticMax,
    machineMaxConcurrentWorkers: staticMax,
    concurrencyBasis: "CPU-bound: 6 cores × 2 agents per core",
    concurrencyBound: "cpu",
  } as never);
  await act(async () => {
    await refreshMemoryAdmission(inUse);
  });
}

/** Render and wait until the pane set has SETTLED — the stagger queue releases two per frame, so a
 *  test that measured the first commit would see a held-back fleet whatever the gate did. */
async function mountAndSettle(expected: number) {
  render(<Workspace />);
  await waitFor(() => expect(screen.getAllByTestId(/^pane-/)).toHaveLength(expected), {
    timeout: 8000,
  });
}

const mountedIds = () =>
  screen
    .getAllByTestId(/^pane-/)
    .map((el) => el.dataset.testid!.replace(/^pane-/, ""))
    .sort();

describe("the residency gate is WIRED into the pane list", () => {
  it("mounts every pane when memory has said nothing — the byte-for-byte old behaviour", async () => {
    // THE BASELINE, and the reason every assertion below is about the gate rather than about a
    // shell that was never mounting six panes anyway.
    await mountAndSettle(AGENTS.length);
    expect(mountedIds()).toEqual([...AGENTS].sort());
    expect(screen.queryByTestId(PANE_RESIDENCY_BANNER_TESTID)).toBeNull();
  });

  it("mounts every pane when a reading arrives in which memory did NOT narrow", async () => {
    // The paired case for the one below: a static ceiling is a PREDICTION, not a measurement of
    // residency, so a healthy machine must defer nothing. Only `memory_admitted` differs.
    await seedMemory(9, 9, 0);
    await mountAndSettle(AGENTS.length);
    expect(mountedIds()).toEqual([...AGENTS].sort());
    expect(screen.queryByTestId(PANE_RESIDENCY_BANNER_TESTID)).toBeNull();
  });

  it("HOLDS BACK the panes past the residents ceiling once memory narrows", async () => {
    // The gate itself. Six open agents, memory admitting three residents against a static ceiling of
    // nine: three panes mount, three wait. Under the pre-gate shell all six mount — which is exactly
    // the over-commit that made counting dormant rows against a residents ceiling look prudent.
    await seedMemory(3, 9, 0);
    await mountAndSettle(3);
    expect(mountedIds()).toEqual(["p1-a", "p1-b", "p2-a"]);
  });

  it("SAYS SO on screen — a held-back pane is never silent", async () => {
    // The founder's constraint on this gate, in as many words: "a pane that silently never mounts is
    // worse than the bug." A frozen status with no explanation reads as a dead fleet.
    await seedMemory(3, 9, 0);
    await mountAndSettle(3);
    const banner = screen.getByTestId(PANE_RESIDENCY_BANNER_TESTID);
    expect(banner.textContent).toContain("3 agents are waiting to start");
    expect(banner.textContent).toContain("memory can hold");
  });

  it("names MEMORY on the bar, not the cores — through the real wiring", async () => {
    // roborev 81141, High. The bar took its `basis` from `localAgentCapacity().basis`, which explains
    // the ROW ceiling and is only replaced by a memory sentence when the ROW comparison narrowed —
    // a DIFFERENT condition from the one this gate fires on. Here they come apart exactly as they do
    // in the bead's measured shape: six rows, none of them resident when the sample was taken,
    // memory admitting three. The row ceiling is `6 + (3 - 0) = 9`, which IS the static ceiling, so
    // it did not narrow and `basis` stays the CPU string — while the residents ceiling is a live 3.
    // The bar would have read "…at the number of agents its memory can hold (CPU-bound: …)".
    //
    // Asserted HERE rather than only in the hook's own suite because nothing else reads the sentence
    // the real component actually renders, and that is where the wrong one was.
    await seedMemory(3, 9, 0);
    await mountAndSettle(3);
    const text = screen.getByTestId(PANE_RESIDENCY_BANNER_TESTID).textContent ?? "";
    expect(text).toContain("only 2.0 GiB of memory is available right now");
    expect(text).not.toContain("CPU-bound");
  });

  it("RELEASES them when the next poll grants room, with no gesture from the user", async () => {
    // The recoverability half. Nothing in the component tree changes when a module-level cache is
    // refreshed, so this is also the test that the subscription in `memoryAdmission` is real.
    await seedMemory(3, 9, 0);
    await mountAndSettle(3);

    await seedMemory(9, 9, 3); // the machine recovers; memory stops narrowing

    await waitFor(() => expect(screen.getAllByTestId(/^pane-/)).toHaveLength(AGENTS.length), {
      timeout: 8000,
    });
    expect(mountedIds()).toEqual([...AGENTS].sort());
    expect(screen.queryByTestId(PANE_RESIDENCY_BANNER_TESTID)).toBeNull();
  });

  it("NEVER unmounts a pane that is already up when the ceiling drops", async () => {
    // A `Terminal` unmount KILLS ITS PTY. A gate that re-derived its answer from the budget alone
    // would evict live agents to save memory it had already spent — destroying work to protect a
    // machine that is already holding it.
    await mountAndSettle(AGENTS.length);
    const tokens = AGENTS.map((id) => pty.instances.get(id));

    await seedMemory(1, 9, 6); // the machine tightens hard, under the fleet that is already up

    expect([...pty.kills.values()]).toEqual([]);
    expect(AGENTS.map((id) => pty.instances.get(id))).toEqual(tokens);
    expect(screen.getAllByTestId(/^pane-/)).toHaveLength(AGENTS.length);
  });
});
