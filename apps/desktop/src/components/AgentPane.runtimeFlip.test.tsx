// @vitest-environment jsdom
//
// AgentPane rebuilds the spawn command on a runtime flip AND never binds Terminal to a local PTY with
// a stale command (bead sparkle-amhwp).
//
// Two coupled facts make the cloud→local flip correct, and this file guards the AgentPane half of
// each:
//
//  1. prepare() must RE-RUN on the flip. Its mount effect used to depend on `[agent.id]` only, so an
//     agent flipping runtime on the same id never rebuilt `spawn` — the pane kept the command built
//     for the OLD runtime. Adding `agent.runtime` to the deps fixes that.
//
//  2. Terminal must not be mounted against the STALE command while prepare() catches up. Terminal
//     selects its transport by `runtime` and re-binds on a runtime flip via its OWN effect, which
//     React fires BEFORE this parent's prepare() re-runs (child effects precede parent effects). For
//     a cloud→local flip that would have a LocalTransport spawn the cloud PLACEHOLDER argv (empty) on
//     a real PTY before prepare() rebuilt the real local command. AgentPane now gates the Terminal
//     mount on `spawn.runtime === agent.runtime` (for the local target), so it shows the "preparing"
//     placeholder for the one render the rebuild takes and mounts Terminal ONCE with the correct argv.
//
// This asserts the MOUNT CONTRACT — which Terminal (runtime + argv) AgentPane actually mounts — not
// merely that prepare() re-ran. Because Terminal spawns-on-mount with exactly those props, a mount
// with (runtime="local", localArgs) is the real local spawn; the transport-rebind side is covered by
// Terminal.transportRebind.test.tsx. A SHELL-kind agent is used so the local branch yields a
// deterministic command without the claude worktree/preflight/bridge machinery.
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  mounts: [] as Array<{ command: string; args: string[]; cwd: string; runtime: string }>,
  // Mount/unmount lifecycle counts, so a test can prove the local→cloud flip is an IN-PLACE re-bind
  // (Terminal never unmounts) rather than an unmount/remount that would blank the promoted pane.
  mountCount: 0,
  unmountCount: 0,
  // The `ready` booleans AgentPane publishes to paneReadiness, in order — so a test can prove the pane
  // republishes "starting" (false) across a flip instead of leaving a stale "ready" (true) up while no
  // PTY exists.
  paneReady: [] as boolean[],
  // Every relaunch AgentPane ANNOUNCES, per agent — so a test can prove that a re-prepare which
  // re-spawns nothing (shell/cloud early return) says so, which is what stops restartPaneAwaited
  // reporting it to a human as a restart that happened.
  relaunches: {} as Record<string, number>,
}));

vi.mock("./Terminal", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  return {
    // Every RENDER AgentPane commits is captured in order — a gated-out flip renders the placeholder
    // instead, so nothing is captured for it. The mount effect counts lifecycle transitions and fires
    // onReady() once so `ptyReady` goes true, which is what makes the stale-ready window observable.
    Terminal: (p: { command: string; args: string[]; cwd: string; runtime: string; onReady?: () => void }) => {
      captured.mounts.push({ command: p.command, args: p.args, cwd: p.cwd, runtime: p.runtime });
      // Mount/unmount lifecycle counting is a []-effect.
      React.useEffect(() => {
        captured.mountCount++;
        return () => {
          captured.unmountCount++;
        };
      }, []);
      // onReady fires on mount AND whenever `runtime` changes — mirroring the REAL Terminal, whose
      // spawn effect (deps include `runtime`) re-spawns and re-emits onReady on an in-place runtime
      // rebind, not only on a remount. Keying it on `[runtime]` is what lets a test see readiness
      // recover on the ungated (local→cloud) direction, which does not remount.
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
  setPaneReady: (_id: string, ready: boolean) => captured.paneReady.push(ready),
  setPaneFailed: () => {},
  unregisterPane: () => {},
  notePaneRelaunch: (id: string) => {
    captured.relaunches[id] = (captured.relaunches[id] ?? 0) + 1;
  },
  paneRelaunchCount: (id: string) => captured.relaunches[id] ?? 0,
}));
// Prompt-delivery plumbing fired by the ptyReady flush effect — no-op so it adds no Tauri side effects.
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
import { restartPane } from "../services/paneControl";
import type { AgentTab, Project } from "../types";

const SHELL = "/bin/zsh";
/** The exact argv buildShellSpawnArgs(SHELL, cmd) produces — the REAL local spawn command. */
const localArgs = (cmd: string) => ["-l", "-c", 'eval "$1"; exec "$0" -l', SHELL, cmd];

function shellAgent(runtime: "cloud" | "local", extra: Partial<AgentTab> = {}): AgentTab {
  return {
    id: "a1",
    name: "Runner",
    kind: "shell",
    parentId: null,
    runtime,
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    shellCommand: "echo hi",
    ...extra,
  } as AgentTab;
}

/** A LOCAL claude agent — the population `restart_agent` actually serves, and the one whose
 *  `notePaneRelaunch` call site the whole nothing-to-restart mechanism hinges on. */
function claudeAgent(extra: Partial<AgentTab> = {}): AgentTab {
  return {
    id: "a1",
    name: "Builder",
    kind: "claude",
    parentId: null,
    runtime: "local",
    worktreePath: null,
    branch: null,
    baseBranch: null,
    lastPrompt: "",
    promptHistory: [],
    ...extra,
  } as AgentTab;
}

const project: Project = {
  id: "p1",
  name: "Proj",
  rootPath: "/proj/root",
  defaultBranch: "main",
  createdAt: "",
  agents: [shellAgent("cloud")],
  selectedAgentId: "a1",
};

/** The mount invariant the fix guarantees: a mounted Terminal's argv always matches its runtime — a
 *  cloud mount is the empty placeholder, a local mount is the real shell command. A LOCAL mount with
 *  the empty (cloud placeholder) argv is exactly the stray, wrong-command PTY the gate prevents. */
function assertNoStaleLocalMount() {
  const stale = captured.mounts.filter(
    (m) => m.runtime === "local" && JSON.stringify(m.args) !== JSON.stringify(localArgs("echo hi")),
  );
  expect(stale).toEqual([]);
}

beforeEach(() => {
  captured.mounts.length = 0;
  captured.mountCount = 0;
  captured.unmountCount = 0;
  captured.paneReady.length = 0;
  for (const k of Object.keys(captured.relaunches)) delete captured.relaunches[k];
});
afterEach(() => cleanup());

describe("AgentPane — a runtime flip rebuilds the spawn command and never binds a stale local PTY", () => {
  it("cloud→local flip mounts Terminal with the real local command, never the empty placeholder", async () => {
    const { rerender } = render(<AgentPane project={project} agent={shellAgent("cloud")} visible />);

    // Cloud: attach with the PLACEHOLDER — command present, args EMPTY.
    await waitFor(() => expect(captured.mounts.length).toBeGreaterThan(0));
    await waitFor(() => expect(captured.mounts.at(-1)!.args).toEqual([]));
    expect(captured.mounts.at(-1)!.runtime).toBe("cloud");

    // Flip to local on the SAME id (a new agent object, as the store mints on a real flip).
    rerender(<AgentPane project={project} agent={shellAgent("local")} visible />);

    // SIDE EFFECT: Terminal ends up mounted with the REBUILT local command + local transport.
    await waitFor(() => {
      const last = captured.mounts.at(-1)!;
      expect(last.runtime).toBe("local");
      expect(last.args).toEqual(localArgs("echo hi"));
    });

    // …and the pane NEVER mounted Terminal as local against the stale cloud placeholder argv. Without
    // the mount gate, the flip render binds a LocalTransport to `args: []` (the stray-PTY bug); without
    // the deps fix, the command never rebuilds and this stays a cloud mount so the local assertion
    // above times out. Either regression fails this test.
    assertNoStaleLocalMount();
  });

  it("an unrelated prop change does NOT rebuild the spawn command", async () => {
    const { rerender } = render(<AgentPane project={project} agent={shellAgent("local")} visible />);

    // Establish the initial local mount built from shellCommand "echo hi".
    await waitFor(() => expect(captured.mounts.at(-1)!.args).toEqual(localArgs("echo hi")));

    // Change an unrelated field (name) AND the shellCommand, keeping id + runtime. prepare() reads
    // shellCommand, so if the effect wrongly re-ran the command would rebuild to "echo CHANGED". The
    // deps are [id, runtime] — neither changed — so it must NOT re-run; the command stays "echo hi".
    rerender(
      <AgentPane
        project={project}
        agent={shellAgent("local", { name: "Renamed", shellCommand: "echo CHANGED" })}
        visible
      />,
    );
    // Let any (incorrect) async re-prepare settle before asserting it did not happen.
    await Promise.resolve();
    await Promise.resolve();

    expect(captured.mounts.some((m) => m.args.includes("echo CHANGED"))).toBe(false);
    expect(captured.mounts.at(-1)!.args).toEqual(localArgs("echo hi"));
    assertNoStaleLocalMount();
  });

  it("local→cloud flip re-binds Terminal IN PLACE — it is never unmounted (promotion keeps scrollback)", async () => {
    // The gate is deliberately ASYMMETRIC: it holds the mount only when going TO local. Going to cloud
    // must keep the SAME Terminal mounted so CloudTransport re-binds in place and the promoted pane's
    // scrollback survives (the promotion design; the transport side is Terminal.transportRebind.test.tsx).
    // Tightening the gate to the obvious symmetric form `spawn.runtime === agent.runtime` would blank
    // the promoted pane to the placeholder — this test fails against that regression because it would
    // unmount Terminal on the flip.
    const { rerender } = render(<AgentPane project={project} agent={shellAgent("local")} visible />);
    await waitFor(() => expect(captured.mounts.at(-1)!.runtime).toBe("local"));
    expect(captured.mountCount).toBe(1);
    expect(captured.unmountCount).toBe(0);

    rerender(<AgentPane project={project} agent={shellAgent("cloud")} visible />);

    // The pane ends up showing a cloud Terminal…
    await waitFor(() => expect(captured.mounts.at(-1)!.runtime).toBe("cloud"));
    // …reached WITHOUT ever tearing the terminal down: still one mount, zero unmounts. A symmetric
    // gate would have dropped to the placeholder (unmountCount ≥ 1) before the cloud spawn arrived.
    expect(captured.unmountCount).toBe(0);
    expect(captured.mountCount).toBe(1);
  });

  it("cloud→local flip republishes pane readiness as NOT-ready, so a prompt in the gap is not dropped", async () => {
    // paneReadiness must go back to "starting" across the flip. The old spawn re-prepared, but for a
    // shell agent prepare() returns before the reset block, so `ptyReady` stayed stale-true from the
    // cloud session: paneReadiness kept saying "ready" while the terminal was being torn down and the
    // local PTY did not yet exist, and a prompt dispatched then took conciergeDispatch's `pty-gone`
    // path (dropped) instead of being queued. setPtyReady(false) is now hoisted to the top of
    // prepare() so every re-prepare republishes NOT-ready first.
    const { rerender } = render(<AgentPane project={project} agent={shellAgent("cloud")} visible />);
    // Cloud attaches and the mock fires onReady → the pane publishes ready=true.
    await waitFor(() => expect(captured.paneReady.at(-1)).toBe(true));

    rerender(<AgentPane project={project} agent={shellAgent("local")} visible />);

    // The flip must publish a NOT-ready AFTER that first ready — the "starting" republish. Without the
    // hoisted reset the pane never drops to false on the shell flip, so this index is -1 and the
    // assertion fails.
    await waitFor(() => {
      const firstReady = captured.paneReady.indexOf(true);
      const falseAfter = captured.paneReady.findIndex((r, i) => i > firstReady && r === false);
      expect(falseAfter).toBeGreaterThan(-1);
    });
    // …and it comes back to ready once the local PTY mounts and fires onReady.
    await waitFor(() => expect(captured.paneReady.at(-1)).toBe(true));
  });

  it("a same-runtime re-prepare (restartPane) does NOT latch readiness to not-ready", async () => {
    // The published signal is DERIVED (`ptyReady && spawnMatchesTargetRuntime`), not a flag prepare()
    // flips. That matters here: restartPane re-runs prepare() for a SHELL agent, which takes the early
    // return and never remounts Terminal (same id/runtime/key), so nothing would re-fire onReady to
    // clear a reset flag. An unconditional setPtyReady(false) in prepare() would therefore latch the
    // pane at "starting" forever, silently queuing prompts the flush effect can never drain. Because
    // the signal is derived from the (unchanged) readiness instead, it stays ready across the restart.
    render(<AgentPane project={project} agent={shellAgent("local")} visible />);
    await waitFor(() => expect(captured.paneReady.at(-1)).toBe(true));
    const beforeRestart = captured.paneReady.length;

    // Re-enter prepare() on the SAME runtime, exactly as useAccountSwitch's restart lever does.
    await act(async () => {
      expect(restartPane("a1")).toBe(true);
      await Promise.resolve();
    });

    // Readiness must NOT be stuck false after the restart — no not-ready is published, and the last
    // value stays ready. An unconditional setPtyReady(false) in prepare() would append a false here
    // (and never a true after it, since nothing remounts to restore readiness) → this fails RED.
    expect(captured.paneReady.slice(beforeRestart).includes(false)).toBe(false);
    expect(captured.paneReady.at(-1)).toBe(true);
  });

  // THE OTHER HALF OF THAT SAME FACT, and the one restartPaneAwaited depends on. A shell re-prepare
  // takes the early return: Terminal is never remounted and the PTY is never replaced, so NOTHING
  // was restarted. `notePaneRelaunch` sits below those early returns precisely so this reads as
  // "nothing to restart" rather than being reported to a human as a restart that happened
  // (roborev 64104). Asserted on the production component, because the counter's whole job is to
  // describe what the real prepare() paths do — a unit test with a hand-written lever cannot see it.
  it("does NOT announce a relaunch for a same-runtime shell re-prepare — nothing re-spawns", async () => {
    render(<AgentPane project={project} agent={shellAgent("local")} visible />);
    await waitFor(() => expect(captured.paneReady.at(-1)).toBe(true));
    const before = captured.relaunches["a1"] ?? 0;

    await act(async () => {
      expect(restartPane("a1")).toBe(true);
      await Promise.resolve();
    });

    expect(captured.relaunches["a1"] ?? 0).toBe(before);
  });

  // THE POSITIVE HALF, and the one that matters most: build agents are the population
  // `restart_agent` serves. Without it, deleting `notePaneRelaunch(agent.id)` from AgentPane leaves
  // the suite green while EVERY build-agent restart answers `nothing-to-restart` — which
  // `restartAgent` relays as "was not re-spawned … do not report it as recovered" for a restart
  // that in fact succeeded. That is the false-negative inversion this mechanism exists to remove.
  it("DOES announce a relaunch for a local claude re-prepare — the build-agent path", async () => {
    // Asserted on the ANNOUNCEMENT rather than on readiness: this pane's spawn needs account
    // selection and the orchestration bridge to reach `ready`, neither of which is mocked here, and
    // neither is what this pins. The call site is what the mechanism hinges on.
    render(<AgentPane project={project} agent={claudeAgent()} visible />);
    await waitFor(() => expect(captured.relaunches["a1"] ?? 0).toBeGreaterThan(0));
    const before = captured.relaunches["a1"] ?? 0;

    await act(async () => {
      expect(restartPane("a1")).toBe(true);
      await Promise.resolve();
    });

    // A SECOND announcement: the re-prepare re-spawns, exactly as restartPaneAwaited assumes.
    await waitFor(() => expect(captured.relaunches["a1"] ?? 0).toBeGreaterThan(before));
  });
});
