// @vitest-environment jsdom
//
// THE PANE'S READINESS ACROSS A LAUNCH IT GAVE UP ON — asserted as BEHAVIOUR, because three rounds of
// source greps could not catch the two regressions that shipped here.
//
// The sequence this file exists for: Terminal's spawn chain REJECTS (its own failure, which never
// touches AgentPane's `phase`), the pane must publish `failed`; then a retry SUCCEEDS and the pane
// must publish `ready` again.
//
// Both halves shipped broken behind passing greps:
//   * writing `setPaneFailed` directly from that path broke paneReadiness's derivability contract, so
//     the value was either reverted to "starting" by a later derive or STUCK on "failed"; and
//   * clearing the `gaveUp` latch only in `prepare()` made it permanent, because Terminal's own
//     "Start again" is an internal attempt bump that never re-enters `prepare()`.
// The greps stayed green through both: the calls were all present and correctly named, and only their
// PLACEMENT was wrong. Nothing but observing the published value can see that.
//
// THE FIRST ARM DELIBERATELY LEAVES `ptyReady` TRUE. That is the React-bailout case that made the
// second regression permanent: the recovering `setPtyReady(true)` is a no-op when the value is already
// true, so nothing re-renders and a derive keyed only on `ptyReady`/`phase` never re-runs. A test that
// gave up before ready would pass against the broken code.
//
// A SHELL-kind agent is used for the same reason as the sibling runtimeFlip file: the local branch
// then yields a deterministic command with no claude worktree/preflight/bridge machinery.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Only what this file's one arm actually reads. The runtimeFlip harness these mocks are borrowed from
// also captures `mounts`/`mountCount`/`unmountCount`/`paneReady` to prove things about a cloud→local
// FLIP; none of that is asserted here and there is no flip in this file, so carrying them would
// advertise coverage that does not exist — the defect the last several commits have been sweeping.
const captured = vi.hoisted(() => ({
  // The readiness VALUES in order, so a test can assert the transition rather than a final snapshot.
  published: [] as string[],
  // Handles onto the live Terminal props, so a test can drive the two signals by hand.
  handles: { onReady: undefined as undefined | (() => void), onSpawnFailed: undefined as undefined | (() => void) },
}));

vi.mock("./Terminal", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    Terminal: (p: {
      command: string;
      args: string[];
      cwd: string;
      runtime: string;
      onReady?: () => void;
      onSpawnFailed?: () => void;
    }) => {
      // Expose BOTH signals. The real Terminal owns the spawn rejection; this file drives it directly
      // so the pane's reaction is observable without a real PTY.
      captured.handles.onReady = p.onReady;
      captured.handles.onSpawnFailed = p.onSpawnFailed;
      // Keyed on `[runtime]` to mirror the REAL Terminal, whose spawn effect deps include `runtime` and
      // which therefore re-emits onReady on an in-place rebind, not only on a remount. Nothing in this
      // file flips runtime today, so the deps are inert here — they are kept for FIDELITY, so the next
      // author (e.g. writing the arm tracked as `sparkle-t2lvl`) debugs the pane rather than the mock.
      //
      // NOTE for that author: a re-fired `onReady` clears the gave-up latch. An arm that flips runtime
      // to re-run the pane's derive effect while `gaveUp` is true must account for that, or it proves
      // nothing — which is exactly how the deleted attempt failed.
      React.useEffect(() => {
        p.onReady?.();
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [p.runtime]);
      return null;
    },
  };
});
// Capture the pane-readiness signal AgentPane publishes (setPaneReady(id, ready)).
vi.mock("../services/paneReadiness", () => ({
  setPaneReady: (_id: string, ready: boolean) => captured.published.push(ready ? "ready" : "starting"),
  setPaneFailed: () => captured.published.push("failed"),
  unregisterPane: () => {},
}));
// Prompt-delivery plumbing fired by the ptyReady flush effect — no-op so it adds no Tauri side effects.
vi.mock("../services/conciergeDispatch", () => ({
  flushPendingSends: () => Promise.resolve(),
  abandonPendingSends: () => {},
  recordPromptSideEffects: () => {},
}));
vi.mock("./PinnedPrompt", () => ({ PinnedPrompt: () => null }));
vi.mock("./Onboarding", () => ({ Onboarding: () => null }));
vi.mock("./TerminalDropOverlay", () => ({ TerminalDropOverlay: () => null }));
vi.mock("./TerminalDropPill", () => ({ TerminalDropPill: () => null }));
// The shell path calls prewarmProjectCaches (fire-and-forget) before the shell early-return; stub the
// worktree service so no real Tauri invoke is attempted. The other exports are never reached on this
// path but are provided so the import resolves.
vi.mock("../services/worktree", () => ({
  prewarmProjectCaches: vi.fn(),
  warmWorktreePool: vi.fn(() => Promise.resolve()),
  prepareAgentWorkspace: vi.fn(() => Promise.resolve({ path: "/wt", branch: "b" })),
  installWorktreeGuard: vi.fn(() => Promise.resolve()),
  installAgentHooks: vi.fn(() => Promise.resolve("/log")),
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
}));

import { act } from "react";
import { AgentPane } from "./AgentPane";
import type { AgentTab, Project } from "../types";

function shellAgent(): AgentTab {
  return {
    id: "a1",
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
  } as unknown as AgentTab;
}

const project: Project = {
  id: "p1",
  name: "Proj",
  rootPath: "/proj/root",
  defaultBranch: "main",
  createdAt: "",
  agents: [shellAgent()],
  selectedAgentId: "a1",
};

beforeEach(() => {
  captured.published.length = 0;
  captured.handles.onReady = undefined;
  captured.handles.onSpawnFailed = undefined;
});
afterEach(() => cleanup());

describe("AgentPane — pane readiness across a launch the terminal gave up on", () => {
  it("publishes failed on a spawn rejection, then RECOVERS to ready when a retry succeeds", async () => {
    render(<AgentPane project={project} agent={shellAgent()} visible />);
    // The mock fires onReady on mount, so the pane is up and `ptyReady` is TRUE before we start.
    await waitFor(() => expect(captured.published).toContain("ready"));
    expect(captured.handles.onSpawnFailed).toBeDefined();

    // The terminal's own spawn chain rejects — never touching `phase`.
    await act(async () => {
      captured.handles.onSpawnFailed!();
    });
    await waitFor(() => expect(captured.published.at(-1)).toBe("failed"));

    // The retry succeeds. `ptyReady` is ALREADY true, so `setPtyReady(true)` is a no-op and only the
    // gave-up latch clearing can re-render — which is precisely what the permanent-failed bug got
    // wrong. Against that code this stays "failed" forever and the wait below times out.
    await act(async () => {
      captured.handles.onReady!();
    });
    await waitFor(() => expect(captured.published.at(-1)).toBe("ready"));
  });

  // THE REVERT DIRECTION IS NOT PINNED HERE, and saying so is the point of this comment.
  //
  // The arm above pins the STUCK direction (failed never recovers). It does not pin the other one:
  // its `waitFor(... toBe("failed"))` returns on the first passing poll, so a revert to "starting"
  // landing after that instant goes unseen, and "eventually ready" is satisfied by a
  // failed → starting → ready sequence.
  //
  // TWO ATTEMPTS AT THAT ARM WERE DELETED RATHER THAN SHIPPED, because neither could fail:
  //   * `await act(async () => {})` re-renders nothing at all; and
  //   * re-rendering with a flipped `agent.runtime` — which looks like it should change
  //     `spawnMatchesTargetRuntime`, a real dep — produces NO further publish here. Measured: the
  //     sequence ends ["starting","starting","ready","failed"] with nothing after the flip, so the
  //     derive effect does not re-run and the assertion passes for the wrong reason.
  // An earlier version instead claimed the gap was covered by AgentPane.runtimeFlip.test.tsx. It is
  // not — that file stubs `setPaneFailed` to a no-op that records nothing, and its Terminal mock does
  // not declare `onSpawnFailed` at all. Asserting as-built what was never built is worse than the
  // hole, so the claim is retracted here rather than repeated.
  //
  // Driving a genuine derive re-run while `gaveUp` is true needs a handle this harness does not have.
  // Tracked as bead `sparkle-t2lvl`. The regression that direction guards against is not currently
  // live: the derive effect reads `gaveUp`, so a re-run republishes `failed`.
});
