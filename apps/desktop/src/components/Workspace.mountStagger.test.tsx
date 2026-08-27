// @vitest-environment jsdom
//
// N AGENT PANES MUST NOT MOUNT IN ONE COMMIT — bead sparkle-pqss6.
//
// Two thirds of all observed UI freezes landed within 70 seconds of an app start (20 of 28 hang
// detections against 14 starts), so restarting to clear a freeze reliably produced another one.
// Renderer render-attribution on those stalls shows `AgentPane` rendered 93, 92 and 91 times inside
// a SINGLE stall: the fleet restore mounted every open agent's pane in one synchronous burst — N
// xterms, N WebGL contexts, N sets of pane effects — and every agent's terminal is laid out at all
// times, so a hidden pane still costs renderer-wide layout.
//
// THE SAME BURST HAPPENS NOWHERE NEAR BOOT, which is why the fix is not a startup special case and
// why this file drives BOTH shapes through the same entry point. The non-startup instance studied in
// the bead was a 7-agent BATCH SPAWN whose seven status transitions were 1.2s apart while
// `requestAnimationFrame` and `setInterval` were starved for 10.2 seconds. Boot and batch spawn are
// the same code path — `Workspace`'s `live` memo gaining ids — so the batch case gets its own
// describe block below and would fail independently of the restore case.
//
// ── WHAT THESE TESTS ASSERT, AND WHAT WOULD BE VACUOUS ─────────────────────────────────────────
// "A stagger helper exists" and "the scheduler was called" are both true of a completely inert
// implementation. The assertions below are all on the SIDE EFFECT — how many `AgentPane`s actually
// ran their mount effect in a given frame — counted through the real `Workspace` shell, with the
// real `live` memo, driven by the real store writes a restore and a spawn perform.
//
// The regression check that makes them worth having: put `panes={live}` back at the
// `MemoAgentPaneList` call site (that IS the bug) and every test in the first three blocks fails —
// all N panes appear in the first commit, so the initial count, the per-frame ceiling and the frame
// count are all wrong at once.
//
// ── WHY THERE IS NO INJECTED SCHEDULER, AND WHY THAT IS THE POINT ──────────────────────────────
// `useStaggeredPaneMounts` takes no scheduler parameter and `scheduleMountRelease` takes no
// override. Its only seam is the environment's own `requestAnimationFrame`, so there is no
// "defaulted seam" for a suite to strand: the line that supplies the real clock is the ONLY line
// there is, and deleting it would fail every test here rather than leaving them green. Most blocks
// still replace `requestAnimationFrame` with a hand-driven queue, because a frame you release by
// hand is the only way to count mounts PER FRAME rather than in total — and the last block replaces
// nothing at all, running against the environment's own rAF and its own timers, so the untouched
// path is exercised too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

import { PANES_PER_MOUNT_RELEASE } from "../services/paneMountScheduler";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: () => Promise.resolve(() => {}),
    setTitle: () => Promise.resolve(),
  }),
  getAllWindows: () => Promise.resolve([{}]),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));
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
vi.mock("../services/sparkleAgent", async (orig) => ({
  ...(await orig<typeof import("../services/sparkleAgent")>()),
  sparkleAgentIdFor: () => "sparkle",
  sparkleOpenSetWhitelist: () => [],
  shouldWarmSparkleAtLaunch: () => false,
}));

/** THE MOUNT LEDGER. `order` is every mount effect that has run, in the order it ran — the exact
 *  thing an xterm + WebGL context + pane effects cost on the real pane, and the only observation
 *  that can tell "spread over frames" from "all in one commit". */
const mounts = vi.hoisted(() => ({ order: [] as string[], unmounts: [] as string[] }));

vi.mock("./AgentPane", async () => {
  const { useEffect, createElement } = await import("react");
  const Pane = ({ agent, visible }: { agent: { id: string }; visible: boolean }) => {
    useEffect(() => {
      mounts.order.push(agent.id);
      return () => {
        mounts.unmounts.push(agent.id);
      };
    }, [agent.id]);
    return createElement("div", {
      "data-testid": `pane-${agent.id}`,
      "data-visible": String(visible),
    });
  };
  return { AgentPane: Pane };
});
vi.mock("./AgentSidebar", () => ({ AgentSidebar: () => <div data-testid="sidebar" /> }));
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

function mkAgent(id: string): AgentTab {
  return {
    id,
    name: id,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  };
}
function mkProject(id: string, agents: AgentTab[]): Project {
  return {
    id,
    name: id.toUpperCase(),
    rootPath: `/tmp/${id}`,
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: agents[0]!.id,
    agents,
  };
}

/** A restored fleet. Twelve is deliberately well past `PANES_PER_MOUNT_RELEASE` so "at most K per
 *  frame" is a real ceiling with several frames under it, not an off-by-one. */
const RESTORED = Array.from({ length: 12 }, (_, i) => `a${i}`);
/** The agent the window is showing — the one pane that must NOT wait for a frame. */
const VISIBLE = RESTORED[0]!;

/** Seed the stores exactly as a fleet restore leaves them: every agent open, its project visited. */
function seedFleet(ids: readonly string[]) {
  useProjectStore.setState({
    projects: [mkProject("p1", ids.map(mkAgent))],
    selectedProjectId: "p1",
  } as never);
  useRuntimeStore.setState({ openAgentIds: [...ids], status: {} } as never);
  markProjectVisited("p1");
}

beforeEach(() => {
  mounts.order.length = 0;
  mounts.unmounts.length = 0;
  localStorage.clear();
  useUiStore.setState({
    activeSpecial: null,
    workModeBySide: { left: "build", right: "build" },
    pinnedProjectId: null,
    openProjectIds: null,
    pairAssignment: {},
    leftProjectId: null,
  } as never);
  useSettingsStore.setState({ beadsEnabled: true } as never);
  useAuthStore.setState({ me: null, tokenPresent: false, loading: false } as never);
  useConnectionStore.setState({ isOnline: true } as never);
  resetVisitedProjects();
  seedFleet(RESTORED);
  resetCable();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetCable();
  localStorage.clear();
});

// ── THE HAND-DRIVEN FRAME CLOCK ────────────────────────────────────────────────────────────────
// Replacing `requestAnimationFrame` with a queue nobody drains until asked is what turns "mounted
// eventually" into "mounted in THIS frame and no sooner". Note what it does NOT do: it does not
// replace `setTimeout`, so `scheduleMountRelease`'s fallback arm is live throughout — it simply
// never wins, because every test drains its frames in well under the fallback's 200ms.
let queued: Array<{ id: number; cb: FrameRequestCallback }> = [];
let nextFrameId = 0;

function installFrameClock() {
  queued = [];
  nextFrameId = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++nextFrameId;
    queued.push({ id, cb });
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queued = queued.filter((f) => f.id !== id);
  });
}

/** Run exactly the frame callbacks outstanding right now. A callback that schedules another frame
 *  does NOT get to run in this one — that is the whole point, and it is why the pump's next release
 *  needs its own `frame()` call rather than falling out of a single flush. */
async function frame() {
  const due = queued;
  queued = [];
  await act(async () => {
    for (const f of due) f.cb(0);
  });
}

/** Render and settle React.lazy's `AgentPane` chunk. NO frame is released here, so what this leaves
 *  on screen is exactly the first commit — which is the measurement the bead is about. */
async function paint() {
  render(<Workspace />);
  await act(async () => {
    // The mocked chunk is already resolved, so microtasks are all `lazy` needs. Deliberately not a
    // `waitFor`: this must not burn wall-clock in which a real frame could slip through.
    await Promise.resolve();
    await Promise.resolve();
  });
}

const mounted = () => [...mounts.order];

/** Drain frames until nothing new mounts, returning how many panes each frame admitted. Bounded so
 *  a pump that stalls fails as a wrong count rather than hanging the suite. */
async function drain(maxFrames = 60): Promise<number[]> {
  const perFrame: number[] = [];
  for (let i = 0; i < maxFrames; i++) {
    const before = mounts.order.length;
    await frame();
    const gained = mounts.order.length - before;
    if (gained === 0 && queued.length === 0) break;
    perFrame.push(gained);
  }
  return perFrame;
}

describe("a fleet restore does not mount every pane in one commit", () => {
  beforeEach(installFrameClock);

  it("paints with ONLY the visible pane mounted — not all twelve", async () => {
    await paint();

    // THE REGRESSION, STATED: before the mount queue this was all 12, in one commit, which is the
    // 93-AgentPane-renders-inside-one-stall the bead measured.
    expect(mounted()).toEqual([VISIBLE]);
  });

  it("admits at most PANES_PER_MOUNT_RELEASE panes per frame", async () => {
    await paint();

    const perFrame = await drain();

    // The ceiling — the actual fix, asserted as a property of every frame rather than of the total.
    for (const gained of perFrame) expect(gained).toBeLessThanOrEqual(PANES_PER_MOUNT_RELEASE);
    // …and it genuinely took that many frames. Without this a "stagger" that released everything on
    // the first frame would satisfy the loop above vacuously (one entry, and the loop over a
    // single-element array says nothing about spreading).
    expect(perFrame.length).toBeGreaterThanOrEqual(
      Math.ceil((RESTORED.length - 1) / PANES_PER_MOUNT_RELEASE),
    );
  });

  it("still mounts every restored agent — a pane that never mounts is a frozen status", async () => {
    // `runtimeStore.status` is live-only with a MOUNTED `AgentPane` as its ONLY writer, so an agent
    // whose pane is skipped has no status, no attention notifications and no observed activity for
    // as long as it waits. The queue is therefore only ever allowed to DELAY a mount. This is the
    // test that would catch a "virtualise: mount only what is on screen" fix, which would spread the
    // burst perfectly and silently freeze eleven agents' status.
    await paint();

    await drain();

    expect(new Set(mounted())).toEqual(new Set(RESTORED));
    // Exactly once each: a queue that re-released an id would remount a pane, and a real pane
    // remount kills and respawns its PTY.
    expect(mounted()).toHaveLength(RESTORED.length);
    expect(mounts.unmounts).toEqual([]);
  });

  it("mounts the pane the user is LOOKING at without waiting for a frame", async () => {
    // The cost of staggering, capped: a queued mount the user is staring at is a blank stage. So the
    // stage's own selection bypasses the queue — asserted by selecting an agent that is provably
    // still queued and finding it mounted in the same commit, with no frame released.
    await paint();
    const late = RESTORED[RESTORED.length - 1]!;
    expect(mounted()).not.toContain(late);

    act(() => {
      useProjectStore.setState({
        projects: [
          { ...useProjectStore.getState().projects[0]!, selectedAgentId: late },
        ],
      } as never);
    });

    expect(mounted()).toContain(late);
    expect(screen.getByTestId(`pane-${late}`).dataset.visible).toBe("true");
  });

  it("keeps a pane that was admitted for being VISIBLE when it stops being visible", async () => {
    // THE EXPENSIVE FAILURE MODE OF THE PRIORITY BYPASS, and one the first draft of this hook
    // actually had. A pane admitted only because its stage was showing it must become STICKY, or it
    // is dropped again the moment the selection moves — and a `Terminal` unmount KILLS ITS PTY, so
    // the agent respawns and loses its scrollback. Silent, too: the pane reappears instantly on the
    // next selection, as a brand-new instance.
    await paint();
    expect(mounted()).toEqual([VISIBLE]);
    const next = RESTORED[1]!;

    act(() => {
      useProjectStore.setState({
        projects: [{ ...useProjectStore.getState().projects[0]!, selectedAgentId: next }],
      } as never);
    });

    expect(mounts.unmounts).toEqual([]);
    expect(screen.getByTestId(`pane-${VISIBLE}`)).toBeTruthy();
    // …and it is the SAME mount, not a replacement — the pane never ran its effect twice.
    expect(mounted().filter((id) => id === VISIBLE)).toHaveLength(1);
  });

  it("still tears a pane down the instant its agent closes", async () => {
    // The inverse. A queue that held ids after they left `live` would leak a PTY per closed tab, and
    // every other test in this file would stay green while it did.
    await paint();
    await drain();

    act(() => {
      useRuntimeStore.setState({
        openAgentIds: RESTORED.filter((id) => id !== "a5"),
      } as never);
    });

    expect(mounts.unmounts).toEqual(["a5"]);
    expect(screen.queryByTestId("pane-a5")).toBeNull();
  });
});

describe("a BATCH SPAWN outside startup is staggered by the same gate", () => {
  beforeEach(installFrameClock);

  // The half of the bead a boot-only fix would miss: seven agents spawned together, 10.2 seconds of
  // starved rAF, nowhere near an app start. It reaches the pane list through the same `live` memo,
  // so it is the same store write — agents appended to the project, ids appended to `openAgentIds`.
  const BATCH = Array.from({ length: 7 }, (_, i) => `b${i}`);

  /** Spawn all seven in ONE commit, exactly as a batch spawn does. */
  const spawnBatch = () =>
    act(() => {
      const p = useProjectStore.getState().projects[0]!;
      useProjectStore.setState({
        projects: [{ ...p, agents: [...p.agents, ...BATCH.map(mkAgent)] }],
      } as never);
      useRuntimeStore.setState({ openAgentIds: [...RESTORED, ...BATCH] } as never);
    });

  it("mounts none of the batch in the commit that spawns it", async () => {
    await paint();
    await drain();
    const settled = mounted().length;

    spawnBatch();

    // Before the fix this commit mounted all seven at once. None of them is the visible pane, so
    // none of them may skip the queue.
    expect(mounted()).toHaveLength(settled);
  });

  it("admits at most PANES_PER_MOUNT_RELEASE of the batch per frame, and all of them in the end", async () => {
    await paint();
    await drain();
    const settled = mounted().length;

    spawnBatch();
    const perFrame = await drain();

    for (const gained of perFrame) expect(gained).toBeLessThanOrEqual(PANES_PER_MOUNT_RELEASE);
    expect(perFrame.length).toBeGreaterThanOrEqual(
      Math.ceil(BATCH.length / PANES_PER_MOUNT_RELEASE),
    );
    // Every spawned agent ends up with a pane — same status argument as the restore case.
    expect(mounted()).toHaveLength(settled + BATCH.length);
    for (const id of BATCH) expect(mounted()).toContain(id);
    expect(mounts.unmounts).toEqual([]);
  });
});

describe("the DEFAULT wiring — no stubbed clock anywhere", () => {
  // NOTHING is replaced in this block: no `requestAnimationFrame`, no `cancelAnimationFrame`, no
  // timers. `scheduleMountRelease` reads the environment's own rAF and its own `setTimeout`, which
  // is the only supply of the real clock the production code has. If that line were deleted the
  // queue would never drain and this block would fail — which is what stops the blocks above, with
  // their hand-driven frames, from being the only coverage the scheduler has.
  it("drains the whole restored fleet on the environment's own clock", async () => {
    await paint();

    // Still staggered on the real clock: a frame has not been produced yet, so only the visible pane
    // is up. `paint` deliberately spends microtasks rather than wall-clock, so no real frame (~16ms)
    // can have landed by here.
    expect(mounted()).toEqual([VISIBLE]);

    await waitFor(() => expect(mounts.order).toHaveLength(RESTORED.length));

    expect(new Set(mounted())).toEqual(new Set(RESTORED));
    expect(mounts.unmounts).toEqual([]);
  });
});
