// @vitest-environment jsdom
//
// IMPROVE SPARKLE MUST HAVE ITS TERMINAL. This file exists because the founder asked for it in as
// many words:
//
//   *"You added a secondary composed window to improve sparkle I don't need that. You can take it
//   out. I just didn't have the actual terminal last time, and now it's back. Just make sure that
//   that doesn't go away."*  — 2026-08-12
//
// ── WHY A WHOLE FILE FOR "IT RENDERS" ──────────────────────────────────────────────────────────
//
// Because the last time it did not, nothing noticed, and the cost was not one missing pane — it was
// a chain of decisions made to work around it. The terminal went missing; the founder reported
// "there's no row to type into"; an input row was built and shipped to give him one; he saw it and
// said he did not want it. Every step of that was reasonable given what the previous step knew, and
// none of it would have happened if a test had said "this pane stopped rendering its Terminal".
//
// So the guard is not about the component being important. It is about this pane's terminal being a
// thing that has ALREADY silently disappeared once, in a pane whose other tests all mock `Terminal`
// away — `noComposer`, `drop`, `readiness` and `spawn` each capture its props to assert something
// else, and every one of them would still pass if the element were never rendered at all, because
// they read a captured array rather than the tree. A mock that records props is not a test that the
// thing renders.
//
// ── WHAT IT ASSERTS, AND WHY EACH ONE IS SEPARATE ──────────────────────────────────────────────
//
//   1. the pane reaches `ready` and mounts a Terminal at all;
//   2. it is mounted with THIS agent's id and the prepared spawn command — a Terminal rendered for
//      the wrong agent is a terminal the founder cannot type to, which from his seat is the same
//      defect;
//   3. it is INSIDE the pane's drop region, so the box that reports "pasted, not sent" is the box
//      the terminal lives in;
//   4. it survives the pane being hidden — `paneVisibilityStyle` hides without `display: none`
//      precisely so the PTY is not torn down, and a change to `visible ? <Terminal/> : null` would
//      kill a live session every time the user looked at another agent.
//
// The mock is a real rendered element carrying a testid, NOT a props-capture only: the whole point
// is that something is in the tree. Mounting the real Terminal would drag in xterm and a PTY.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  terminal: [] as Array<{ agentId?: string; command?: string; args?: string[]; cwd?: string }>,
}));

// ── THE MOCK BLOCK MIRRORS `SparkleAgentPane.drop.test.tsx` ────────────────────────────────────
// Same pane, same async `prepare()` chain, so the same set of seams has to be stubbed to reach
// `ready`. PARTIAL mocks (`importOriginal`) wherever the module has other exports the tree needs —
// a wholesale `vi.mock` of `../preflight` silently removes `checkPrereqs`, which `Onboarding` pulls
// in through `SetupChecklist`, and the failure surfaces as an unrelated render error two components
// away (bead sparkle-m1dmm is this exact hazard).
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: () => new Promise<() => void>(() => {}),
  }),
}));
vi.mock("./Terminal", async (importOriginal) => {
  const real = await importOriginal<typeof import("./Terminal")>();
  return {
    ...real,
    Terminal: (props: {
      agentId?: string;
      command?: string;
      args?: string[];
      cwd?: string;
      focusRef?: { current: (() => void) | null };
    }) => {
      captured.terminal.push({
        agentId: props.agentId,
        command: props.command,
        args: props.args,
        cwd: props.cwd,
      });
      if (props.focusRef) props.focusRef.current = () => {};
      // A REAL ELEMENT IN THE TREE — the one thing this file's mock may not do is return null.
      // Every other test of this pane mocks `Terminal` to nothing and asserts off a captured props
      // array, which is exactly why they would all pass with the pane rendering no terminal at all.
      return <div data-testid="sparkle-terminal" />;
    },
  };
});
vi.mock("./Onboarding", () => ({ Onboarding: () => null }));
vi.mock("./SparkleConsentBanner", () => ({ SparkleConsentBanner: () => null }));
vi.mock("../services/worktree", () => ({
  createAgentWorktree: vi.fn(() =>
    Promise.resolve({ path: "/wt/sparkle-self", branch: "sparkle/agent-self" }),
  ),
  installWorktreeGuard: vi.fn(() => Promise.resolve()),
  installInboxDrainHooks: vi.fn(() => Promise.resolve("/app-data/hook-events/__sparkle_self__.jsonl")),
  assertWorkspaceIntegrity: vi.fn(() => Promise.resolve()),
  // Worktree lease heartbeat (bead sparkle-hc7hvm): the pane claims/refreshes/releases it while
  // mounted so the hourly park won't reset this shared worktree out from under the live session.
  acquireWorktreeLease: vi.fn(() => Promise.resolve()),
  releaseWorktreeLease: vi.fn(() => Promise.resolve()),
}));
vi.mock("../preflight", () => ({
  checkClaude: vi.fn(() => Promise.resolve({ installed: true, path: "/usr/local/bin/claude" })),
  claudeHasSession: vi.fn(() => Promise.resolve(false)),
}));
vi.mock("../services/sparkleAgent", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/sparkleAgent")>();
  return {
    ...real,
    ensureSparkleRepo: vi.fn(() =>
      Promise.resolve({
        repoPath: "/app-data/",
        logDir: "/app-data/logs/sparkle",
        defaultBranch: "main",
      }),
    ),
  };
});
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SparkleAgentPane } from "./SparkleAgentPane";
import { sparkleAgentIdFor } from "../services/sparkleAgent";
import { APP_WINDOW_LABEL } from "../windowContext";

/** Improve Sparkle is per-window, so the id is derived rather than typed — a literal would drift
 *  from `sparkleAgentIdFor` and the "mounts it for THIS agent" assertion would stop meaning it. */
const SPARKLE_ID = sparkleAgentIdFor(APP_WINDOW_LABEL);

beforeEach(() => {
  captured.terminal.length = 0;
});
afterEach(() => cleanup());

/** Render the pane and wait for it to reach the phase that mounts the terminal. */
async function readyPane(visible = true) {
  const view = render(<SparkleAgentPane visible={visible} agentId={SPARKLE_ID} />);
  await waitFor(() => expect(screen.queryByTestId("sparkle-terminal")).not.toBeNull());
  return view;
}

describe("Improve Sparkle keeps its terminal (founder, 2026-08-12)", () => {
  it("RENDERS a terminal — the assertion the missing-terminal episode had nobody making", async () => {
    await readyPane();
    // In the TREE, not in a captured props array. See this file's header for why that distinction
    // is the whole point: every other test of this pane would pass with nothing rendered.
    expect(screen.getByTestId("sparkle-terminal")).toBeTruthy();
  });

  it("mounts it for THIS agent, with the prepared command — not merely some terminal", async () => {
    await readyPane();
    const last = captured.terminal[captured.terminal.length - 1]!;
    expect(last.agentId).toBe(SPARKLE_ID);
    // The spawn is a real shell exec built by `buildClaudeExec`; a terminal wired to nothing would
    // render fine and be just as unusable as one that is absent.
    expect(last.command).toBeTruthy();
    expect(last.args?.length).toBeGreaterThan(0);
    expect(last.cwd).toBeTruthy();
  });

  it("puts it inside the pane's drop region, so a dropped path lands in the terminal", async () => {
    await readyPane();
    const region = document.querySelector("[data-dnd-target]");
    expect(region).not.toBeNull();
    expect(region!.contains(screen.getByTestId("sparkle-terminal"))).toBe(true);
  });

  it("KEEPS it mounted when the pane is hidden — hiding must never kill the PTY", async () => {
    // `paneVisibilityStyle` hides without `display: none` for exactly this reason. A refactor to
    // `visible ? <Terminal/> : null` would look tidier and would end a live Claude session every
    // time the user glanced at another agent — the same class of loss as the terminal going missing,
    // arrived at from the other direction.
    const view = await readyPane(true);
    await act(async () => {
      view.rerender(<SparkleAgentPane visible={false} agentId={SPARKLE_ID} />);
    });
    expect(screen.getByTestId("sparkle-terminal")).toBeTruthy();
  });

  it("renders NO second compose surface beside it — the founder took that back out", async () => {
    // The other half of the same message: *"You added a secondary composed window … I don't need
    // that."* Paired with the assertions above deliberately — "no textbox" alone is satisfied by a
    // pane that renders nothing at all, which is the state the whole detour began in.
    await readyPane();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });
});
