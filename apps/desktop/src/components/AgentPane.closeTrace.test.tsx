// @vitest-environment jsdom
//
// THE `close:<id>` TRACE MUST BALANCE — a row removed with no pane must leave nothing behind, and a
// row removed WITH one must still be measured end to end (bead sparkle-bxidpw).
//
// `projectStore.removeAgent` opens a `close:<id>` perf trace, and `AgentPane`'s unmount cleanup is
// the only thing that can ever end it. Panes mount LAZILY per project, so removing an agent nobody
// ever opened used to leave an entry in `perfTrace`'s module-scoped map for the life of the process.
// That is not cosmetic: `openTraceKinds()` is the jank monitor's only attribution channel on macOS
// WKWebView, so every stall line for the rest of the session named the ghost instead of the cause —
// measured in a real log as `"during":"close×37"` on every stall for hours, monotonically growing,
// while a user-visible freeze was being diagnosed.
//
// THESE TWO TESTS ARE A PAIR, AND THE PAIR IS THE POINT (AGENTS.md, "an earlier guard
// short-circuits the path"). A single test proving the trace is absent after a no-pane removal is
// ambiguous — it passes just as well against a change that suppressed the trace everywhere, which
// would silently stop measuring closes altogether. The mounted case pins the other side: the SAME
// store call, on a row whose pane IS mounted, still opens the trace and still produces the
// `close … (total)` waterfall on unmount. Only both together say the gate is keyed on the right
// thing.
//
// Both drive the REAL `AgentPane` and the REAL `projectStore` — no stand-in for the mount registry
// and no hand-rolled unmount. A SHELL-kind agent keeps the local branch deterministic without the
// claude worktree/preflight/bridge machinery (same reasoning as AgentPane.runtimeFlip.test.tsx,
// whose mock set this file mirrors).
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./Terminal", () => ({ Terminal: () => null }));
vi.mock("../services/paneReadiness", () => ({
  setPaneReady: () => {},
  setPaneFailed: () => {},
  unregisterPane: () => {},
  notePaneRelaunch: () => {},
  paneRelaunchCount: () => 0,
}));
vi.mock("../services/conciergeDispatch", () => ({
  flushPendingSends: () => Promise.resolve(),
  abandonPendingSends: () => {},
  abandonScreenHeldSends: () => {},
  recordPromptSideEffects: () => {},
}));
vi.mock("./PinnedPrompt", () => ({ PinnedPrompt: () => null }));
vi.mock("./Onboarding", () => ({ Onboarding: () => null }));
vi.mock("./TerminalDropOverlay", () => ({ TerminalDropOverlay: () => null }));
vi.mock("./TerminalDropPill", () => ({ TerminalDropPill: () => null }));
// The shell path fires prewarmProjectCaches before its early return; stub the worktree service so no
// real Tauri invoke is attempted. The rest are never reached here but keep the import resolvable.
vi.mock("../services/worktree", () => ({
  prewarmProjectCaches: vi.fn(),
  warmWorktreePool: vi.fn(() => Promise.resolve()),
  prepareAgentWorkspace: vi.fn(() => Promise.resolve({ path: "/wt", branch: "b" })),
  installWorktreeGuard: vi.fn(() => Promise.resolve()),
  installAgentHooks: vi.fn(() => Promise.resolve("/log")),
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
}));

import { AgentPane } from "./AgentPane";
import { useProjectStore } from "../stores/projectStore";
import {
  __resetMountedPanesForTest,
  isAgentPaneMounted,
} from "../services/agentPaneRegistry";
import { openTraceKinds } from "../perfTrace";
import { log } from "../logger";
import type { AgentTab, Project } from "../types";

const AGENT_ID = "a1";

function shellAgent(): AgentTab {
  return {
    id: AGENT_ID,
    name: "Runner",
    kind: "shell",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    shellCommand: "echo hi",
    namePinned: false,
    autoNameBasis: null,
    autoNameVariants: null,
  } as AgentTab;
}

const project: Project = {
  id: "p1",
  name: "Proj",
  rootPath: "/proj/root",
  defaultBranch: "main",
  createdAt: "",
  agents: [shellAgent()],
  selectedAgentId: AGENT_ID,
};

/** Every `[perf]` message logged during a test, so an assertion can name the waterfall LINE rather
 *  than the fact that some function was called. `perfEnd` is what emits `close unmounted (total)`. */
let perfLines: string[] = [];

beforeEach(() => {
  // The registry is module-scoped and outlives a test, so a pane leaked by an earlier one would
  // make the no-pane case below silently assert the WRONG world. Safe to reset (unlike the traces
  // map): this map models what is mounted, and at the top of a test nothing is.
  __resetMountedPanesForTest();
  perfLines = [];
  vi.spyOn(log, "info").mockImplementation((scope: string, msg: string) => {
    if (scope === "perf") perfLines.push(msg);
  });
  // The REAL store, holding the row the pane is rendered for.
  useProjectStore.setState({ projects: [{ ...project, agents: [shellAgent()] }] } as never);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const closeWaterfall = () => perfLines.filter((m) => m.startsWith("close ") && m.includes("(total)"));

describe("removeAgent's close: trace balances against the pane that ends it", () => {
  // DELIBERATELY NO `__resetTracesForTest()` ANYWHERE IN THIS FILE. That helper empties the very map
  // whose residue IS the defect, so leaning on it in a beforeEach would mask a regression that
  // re-introduced the leak (AGENTS.md; the reset exists for suites asserting on unrelated traces).
  // These tests instead assert the map is exactly as clean as the app should have left it.
  it("leaves NO open close entry when the removed agent's pane was never mounted", () => {
    // The leaking scenario, exactly: an agent removed without its pane ever having been opened —
    // the normal case for any project the user has not visited this session.
    useProjectStore.getState().removeAgent(project.id, AGENT_ID);

    // SIDE EFFECT, not "perfCancel was called": what the jank monitor would actually report. Also
    // pins the shape — `undefined`, never `""` and never `"close×0"`, since the stall line embeds
    // this value verbatim and an empty string reads as a real in-flight interaction with no name.
    expect(openTraceKinds()).toBeUndefined();
    // …and no waterfall was emitted for a close that no one watched.
    expect(closeWaterfall()).toEqual([]);
  });

  it("still emits the close … (total) waterfall when a mounted pane unmounts", () => {
    const { unmount } = render(<AgentPane project={project} agent={shellAgent()} visible />);
    // THE PRECONDITION, ASSERTED RATHER THAN ASSUMED. This used to read
    // `await waitFor(() => expect(perfLines.length).toBeGreaterThanOrEqual(0))` — an array length is
    // never negative, so the `waitFor` resolved on its first attempt and synchronized nothing; it
    // passed only because RTL's `render` already flushes effects inside `act()`. That mattered more
    // than an ordinary vacuous line: four other test files delegate the mounted-pane half of this
    // contract here, so the one assertion proving the gate is not simply switched off rested on a
    // predicate that could not fail.
    //
    // SYNCHRONOUS ON PURPOSE, not `waitFor`. What the store's gate needs is not "registration
    // happens eventually" but "registration has already happened by the time the next statement
    // runs" — a `waitFor` would retry past a registration deferred to a microtask and call that a
    // pass, which is exactly the regression that would make `removeAgent` stop measuring a real
    // close. `render` flushes the mount effect inside `act()`, so this is the fact, asserted.
    expect(isAgentPaneMounted(AGENT_ID)).toBe(true);

    // The store call is IDENTICAL to the one above. Only the world differs: a pane exists.
    useProjectStore.getState().removeAgent(project.id, AGENT_ID);

    // The trace really did open this time — so the gate is keyed on the pane, not switched off.
    expect(openTraceKinds()).toBe("close");
    expect(closeWaterfall()).toEqual([]); // not settled yet — the pane is still up

    // The pane going away is the end of the visible close cost.
    unmount();

    expect(closeWaterfall()).toEqual(["close unmounted (total)"]);
    // …and it is settled, not merely reported: nothing is left in flight.
    expect(openTraceKinds()).toBeUndefined();

    // THE RELEASE HALF OF THE REGISTRY CONTRACT, which nothing else in the tree asserted (roborev
    // 67480). The register half above is guarded; the unregister half was not, anywhere. Delete
    // `unregisterMountedPane(agent.id)` from the pane's cleanup, or break the decrement in
    // `agentPaneRegistry.unregisterMountedPane`, and every other assertion in this file still
    // passes — the tests above never re-read the registry after `unmount()`, and the re-use case
    // below re-registers over the stale entry, so `openTraceKinds()` reads the same either way.
    // The regression that mutant models is bead `sparkle-bxidpw` itself: the id stays "mounted"
    // forever, a later `removeAgent` on a row whose pane is gone opens a `close:` nothing can end,
    // and `during` is poisoned for the rest of the process. This line is the only guard against it.
    //
    // It also pins the CLEANUP ORDERING's postcondition. `perfEnd` runs BEFORE
    // `unregisterMountedPane` (deliberately — see the comment in `AgentPane`'s cleanup), so
    // asserting the settled trace above AND the released registration here proves both halves ran,
    // in that order, off one unmount.
    expect(isAgentPaneMounted(AGENT_ID)).toBe(false);
  });

  it("a re-used agent id restarts cleanly rather than stacking entries", () => {
    // Retry / reopen mints a new agent on the SAME id. `perfStart` overwrites by design, so two
    // removals must never read as two in-flight closes — and the second must still settle.
    const { unmount: unmountFirst } = render(
      <AgentPane project={project} agent={shellAgent()} visible />,
    );
    useProjectStore.getState().removeAgent(project.id, AGENT_ID);
    expect(openTraceKinds()).toBe("close");
    unmountFirst();
    expect(openTraceKinds()).toBeUndefined();

    // Same id, mounted again.
    useProjectStore.setState({ projects: [{ ...project, agents: [shellAgent()] }] } as never);
    const { unmount: unmountSecond } = render(
      <AgentPane project={project} agent={shellAgent()} visible />,
    );
    useProjectStore.getState().removeAgent(project.id, AGENT_ID);
    expect(openTraceKinds()).toBe("close"); // ×1, never ×2
    unmountSecond();
    expect(openTraceKinds()).toBeUndefined();
    expect(closeWaterfall()).toEqual(["close unmounted (total)", "close unmounted (total)"]);
  });
});
