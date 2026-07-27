import { describe, test, expect, vi, beforeEach } from "vitest";

// The Tauri boundary is the ONE thing mocked here: `invoke` reaches a Rust command that shells out
// to a package manager for ~27 seconds. Everything this module is responsible for — the queue, the
// once-per-worktree guard, the abandon-on-teardown handshake — is real code under test.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  bootstrapWorktreeDeps,
  abandonWorktreeBootstrap,
  resetDepsBootstrapStateForTests,
} from "./depsBootstrap";

/** Let the module's internal promise chain drain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ status: "installed", detail: null, manager: "pnpm" });
  resetDepsBootstrapStateForTests();
});

describe("bootstrapWorktreeDeps", () => {
  test("returns immediately without waiting for the install", async () => {
    // The whole point: opening an agent must not block on a 27-second install. If this regresses,
    // every agent spawn gets half a minute slower and the feature becomes a net loss.
    let released!: () => void;
    invoke.mockImplementation(
      () =>
        new Promise((r) => {
          released = () => r({ status: "installed", detail: null, manager: "pnpm" });
        }),
    );

    const returned = bootstrapWorktreeDeps("/wt/a");
    expect(returned).toBeUndefined();

    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);
    released();
  });

  test("installs once per worktree, not once per agent open", async () => {
    // prepareAgentWorkspace runs on EVERY agent mount and worktree slots are reused, so an
    // unguarded call fires a fresh subprocess every time you open an agent just to discover
    // node_modules is already there.
    bootstrapWorktreeDeps("/wt/a");
    await settle();
    bootstrapWorktreeDeps("/wt/a");
    await settle();

    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("runs one install at a time across concurrent worktrees", async () => {
    // A worker fan-out cuts many worktrees at once. N concurrent installs would hammer one shared
    // package-manager store with N writers; pnpm survives it, but it turns a 27s install into a
    // thrash. Queued means the callers still never wait — they just finish in sequence.
    let inFlight = 0;
    let peak = 0;
    invoke.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { status: "installed", detail: null, manager: "pnpm" };
    });

    bootstrapWorktreeDeps("/wt/a");
    bootstrapWorktreeDeps("/wt/b");
    bootstrapWorktreeDeps("/wt/c");
    await new Promise((r) => setTimeout(r, 60));

    expect(invoke).toHaveBeenCalledTimes(3);
    expect(peak).toBe(1);
  });

  test("a failed install is retried the next time the agent is opened", async () => {
    // Marking on ATTEMPT would poison the path for the rest of the session, and reopening the agent
    // is the user's entire recovery path after fixing whatever broke (missing pnpm, bad lockfile).
    invoke.mockRejectedValueOnce(new Error("pnpm exploded"));

    bootstrapWorktreeDeps("/wt/a");
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);

    bootstrapWorktreeDeps("/wt/a");
    await settle();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test("a failed install never rejects into the spawn path", async () => {
    // The module contract: a broken package manager must not stop anyone opening an agent. An
    // unhandled rejection escaping here would surface as a spawn failure.
    invoke.mockRejectedValue(new Error("boom"));
    expect(() => bootstrapWorktreeDeps("/wt/a")).not.toThrow();
    await settle();
  });

  test("one worktree's failure does not stall the queue behind it", async () => {
    // A rejected promise assigned back to the shared chain would leave every later bootstrap
    // permanently unrun — the failure mode that makes a queue worse than no queue.
    invoke.mockRejectedValueOnce(new Error("first one fails"));

    bootstrapWorktreeDeps("/wt/a");
    bootstrapWorktreeDeps("/wt/b");
    await new Promise((r) => setTimeout(r, 30));

    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test("an empty worktree path is ignored", () => {
    bootstrapWorktreeDeps("");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("abandonWorktreeBootstrap", () => {
  test("a queued install is dropped when its worktree is torn down first", async () => {
    // Teardown deletes the directory. An install that starts after that recreates it, leaving a
    // stray non-empty directory at a slot path that a later `git worktree add` then fails on —
    // the same class of bug the env seeder's abandon handshake exists to prevent.
    let releaseFirst!: () => void;
    invoke.mockImplementationOnce(
      () =>
        new Promise((r) => {
          releaseFirst = () => r({ status: "installed", detail: null, manager: "pnpm" });
        }),
    );

    bootstrapWorktreeDeps("/wt/a"); // occupies the queue
    bootstrapWorktreeDeps("/wt/b"); // waits behind it
    await settle();

    await abandonWorktreeBootstrap("/wt/b");
    releaseFirst();
    await new Promise((r) => setTimeout(r, 30));

    const paths = invoke.mock.calls.map((c) => (c[1] as { worktree: string }).worktree);
    expect(paths).toContain("/wt/a");
    expect(paths).not.toContain("/wt/b");
  });

  test("abandoning clears the guard so a worktree re-cut at the same path installs again", async () => {
    bootstrapWorktreeDeps("/wt/a");
    await settle();
    expect(invoke).toHaveBeenCalledTimes(1);

    await abandonWorktreeBootstrap("/wt/a");

    bootstrapWorktreeDeps("/wt/a");
    await settle();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  test("teardown does not hang on an install that never finishes", async () => {
    // Bounded wait. `pnpm install` has no timeout by design (killing it mid-write is worse than
    // letting it run), so the bound has to live here or closing an agent can hang indefinitely.
    invoke.mockImplementation(() => new Promise(() => {}));

    bootstrapWorktreeDeps("/wt/a");
    await settle();

    await expect(abandonWorktreeBootstrap("/wt/a", 10)).resolves.toBeUndefined();
  });
});
