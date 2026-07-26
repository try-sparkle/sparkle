// @vitest-environment jsdom
//
// Seeding a fresh worktree with its project's `.env*` files. The behavior under test is mostly
// about what must NOT happen: seeding must never block a spawn, never fail one, never run when the
// user hasn't opted in, never run twice for the same worktree, never run two `op` calls at once,
// and never write into a worktree that is being torn down.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./onepassword", () => ({ opSeedWorktree: vi.fn() }));

import { opSeedWorktree } from "./onepassword";
import { useSettingsStore } from "../stores/settingsStore";
import {
  abandonWorktreeSeed,
  envSeedEnabled,
  resetEnvSeedStateForTests,
  seedWorktreeEnv,
} from "./envSeed";

const mockSeed = vi.mocked(opSeedWorktree);

/** The fully opted-in state: tool on, seeding on, vault chosen. */
function seedReady() {
  useSettingsStore.setState({
    onepasswordEnabled: true,
    onepasswordSeedWorktrees: true,
    onepasswordVaultId: "vault-abc",
  });
}

/** A promise this test controls the settling of — stands in for a slow `op`. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resetEnvSeedStateForTests();
  seedReady();
  mockSeed.mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe("envSeedEnabled — all three conditions are required", () => {
  it("is true only when the tool is on, seeding is on, and a vault is chosen", () => {
    expect(envSeedEnabled()).toBe(true);
  });

  it("is false when the tool is off, even with seeding on and a vault set", () => {
    useSettingsStore.setState({ onepasswordEnabled: false });
    expect(envSeedEnabled()).toBe(false);
  });

  it("is false when the user hasn't asked for worktree seeding", () => {
    // Backing files up and having them written into every new worktree are separate consents.
    useSettingsStore.setState({ onepasswordSeedWorktrees: false });
    expect(envSeedEnabled()).toBe(false);
  });

  it("is false when no vault has been chosen", () => {
    useSettingsStore.setState({ onepasswordVaultId: null });
    expect(envSeedEnabled()).toBe(false);
  });
});

describe("seedWorktreeEnv", () => {
  it("restores using the vault id and the project NAME the titles are keyed on", async () => {
    seedWorktreeEnv("sparkle", "/tmp/wt/agent-1");
    await vi.waitFor(() =>
      expect(mockSeed).toHaveBeenCalledWith("vault-abc", "sparkle", "/tmp/wt/agent-1"),
    );
  });

  it("hands the RAW store name to the boundary, which owns the normalization", async () => {
    // opSeedWorktree normalizes (see onepassword.test.ts, which pins that the name crossing the IPC
    // boundary is the same segment backupTitle wrote). This layer must not pre-mangle it.
    seedWorktreeEnv("  acme/web  ", "/tmp/wt/agent-2");
    await vi.waitFor(() =>
      expect(mockSeed).toHaveBeenCalledWith("vault-abc", "  acme/web  ", "/tmp/wt/agent-2"),
    );
  });

  it("does nothing at all when seeding is not enabled", async () => {
    useSettingsStore.setState({ onepasswordSeedWorktrees: false });
    seedWorktreeEnv("sparkle", "/tmp/wt/agent-1");
    await Promise.resolve();
    expect(mockSeed).not.toHaveBeenCalled();
  });

  it("returns synchronously without awaiting the restore — a spawn must never wait on it", () => {
    // A never-settling restore stands in for a slow network / a Touch ID prompt / a hung `op`.
    // If seedWorktreeEnv awaited it, it could not hand back a plain value at all — it would have
    // to return a pending promise, and opening an agent would hang with it.
    mockSeed.mockReturnValue(new Promise<string[]>(() => {}));
    expect(seedWorktreeEnv("sparkle", "/tmp/wt/agent-1")).toBeUndefined();
  });

  it("swallows a rejected restore — a locked vault must not fail the spawn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSeed.mockRejectedValue(new Error("1Password is locked"));

    // The call itself must not throw...
    expect(() => seedWorktreeEnv("sparkle", "/tmp/wt/agent-1")).not.toThrow();
    // ...and the rejection must be handled, not left to become an unhandled rejection.
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it("logs a count, never the restored paths", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    mockSeed.mockResolvedValue([".env.local", "apps/web/.env.local"]);

    seedWorktreeEnv("sparkle", "/tmp/wt/agent-1");
    await vi.waitFor(() => expect(info).toHaveBeenCalled());

    const logged = info.mock.calls.flat().join(" ");
    expect(logged).toContain("2");
    // An env file's path is exactly what must stay out of a log line.
    expect(logged).not.toContain(".env.local");
    expect(logged).not.toContain("/tmp/wt/agent-1");
    info.mockRestore();
  });

  it("stays quiet when nothing was restored", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    mockSeed.mockResolvedValue([]);
    seedWorktreeEnv("sparkle", "/tmp/wt/agent-1");
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalled());
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });
});

describe("seedWorktreeEnv — cost guards", () => {
  it("seeds a given worktree ONCE per session, however many times it is opened", async () => {
    // prepareAgentWorkspace runs on every agent mount, not just on a fresh cut. Without this guard
    // every open pays an `op item list` — and possibly a Touch ID prompt — to find nothing to do.
    seedWorktreeEnv("sparkle", "/tmp/wt/agent-1");
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(1));
    seedWorktreeEnv("sparkle", "/tmp/wt/agent-1");
    seedWorktreeEnv("sparkle", "/tmp/wt/agent-1");
    await Promise.resolve();
    expect(mockSeed).toHaveBeenCalledTimes(1);
  });

  it("runs one `op` at a time — a worker fan-out must not stack biometric prompts", async () => {
    // `op` is a single-user CLI behind one prompt; N concurrent seeds would stack N of them.
    const first = deferred<string[]>();
    mockSeed.mockReturnValueOnce(first.promise).mockResolvedValue([]);

    seedWorktreeEnv("sparkle", "/tmp/wt/w-1");
    seedWorktreeEnv("sparkle", "/tmp/wt/w-2");
    seedWorktreeEnv("sparkle", "/tmp/wt/w-3");

    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(1));
    expect(mockSeed).toHaveBeenCalledWith("vault-abc", "sparkle", "/tmp/wt/w-1");

    first.resolve([]);
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(3));
  });

  it("does not let one failed seed poison the queue", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSeed.mockRejectedValueOnce(new Error("boom")).mockResolvedValue([]);
    seedWorktreeEnv("sparkle", "/tmp/wt/w-1");
    seedWorktreeEnv("sparkle", "/tmp/wt/w-2");
    await vi.waitFor(() =>
      expect(mockSeed).toHaveBeenCalledWith("vault-abc", "sparkle", "/tmp/wt/w-2"),
    );
    warn.mockRestore();
  });
});

describe("seedWorktreeEnv — a FAILED seed stays retryable", () => {
  it("retries on the next open after a locked vault, instead of poisoning the path", async () => {
    // Marking the path done on ATTEMPT meant one transient failure — a locked 1Password, an
    // unanswered Touch ID prompt, a 20s timeout — silently disabled seeding for that worktree until
    // the app restarted. Unlock-and-reopen is the user's whole recovery path; it has to work.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSeed.mockRejectedValueOnce(new Error("1Password is locked")).mockResolvedValue([".env"]);

    seedWorktreeEnv("sparkle", "/tmp/wt/agent-1");
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    seedWorktreeEnv("sparkle", "/tmp/wt/agent-1"); // the user unlocked and reopened the agent
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(2));
    warn.mockRestore();
  });

  it("stops retrying once a seed has SUCCEEDED", async () => {
    seedWorktreeEnv("sparkle", "/tmp/wt/agent-1");
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(1));
    seedWorktreeEnv("sparkle", "/tmp/wt/agent-1");
    await Promise.resolve();
    expect(mockSeed).toHaveBeenCalledTimes(1);
  });
});

describe("abandonWorktreeSeed — teardown must win over an in-flight seed", () => {
  it("skips a QUEUED seed IMMEDIATELY — teardown holds the repo lock, so it must not wait", async () => {
    // The wait happens inside withRepoLock: blocking here on the seeds AHEAD of this one in the
    // queue would stall unrelated prepares/removes on the same project for the full timeout.
    const first = deferred<string[]>();
    mockSeed.mockReturnValueOnce(first.promise).mockResolvedValue([]);
    seedWorktreeEnv("sparkle", "/tmp/wt/w-1");
    seedWorktreeEnv("sparkle", "/tmp/wt/doomed");
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(1));

    let settled = false;
    void abandonWorktreeSeed("/tmp/wt/doomed", 60_000).then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    // The seed ahead of it is still running, and the timeout is a minute — yet this resolved.
    expect(settled).toBe(true);
    first.resolve([]);
  });

  it("skips a seed still queued behind another when its worktree is removed", async () => {
    // The dangerous ordering: the seed's turn comes up AFTER `git worktree remove` deleted the
    // directory, so `op` would recreate the tree git just tore down.
    const first = deferred<string[]>();
    mockSeed.mockReturnValueOnce(first.promise).mockResolvedValue([]);

    seedWorktreeEnv("sparkle", "/tmp/wt/w-1");
    seedWorktreeEnv("sparkle", "/tmp/wt/doomed");
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(1));

    void abandonWorktreeSeed("/tmp/wt/doomed");
    first.resolve([]);
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(1));
    expect(mockSeed).not.toHaveBeenCalledWith("vault-abc", "sparkle", "/tmp/wt/doomed");
  });

  it("waits for a RUNNING seed before letting teardown proceed", async () => {
    const running = deferred<string[]>();
    mockSeed.mockReturnValue(running.promise);
    seedWorktreeEnv("sparkle", "/tmp/wt/w-1");
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(1));

    let settled = false;
    const wait = abandonWorktreeSeed("/tmp/wt/w-1").then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false); // still writing — teardown must not delete under it

    running.resolve([]);
    await wait;
    expect(settled).toBe(true);
  });

  it("gives up on a STUCK seed rather than hanging teardown", async () => {
    mockSeed.mockReturnValue(new Promise<string[]>(() => {})); // never settles
    seedWorktreeEnv("sparkle", "/tmp/wt/w-1");
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(1));
    // A hung `op` (or a Touch ID prompt nobody answers) must not wedge closing an agent.
    await expect(abandonWorktreeSeed("/tmp/wt/w-1", 1)).resolves.toBeUndefined();
  });

  it("does NOT mark a torn-down worktree as seeded, even if its op call then succeeds", async () => {
    // Abandon un-marks the path, but the running seed used to re-add it on success — so a worktree
    // re-cut at that path was skipped for the rest of the session, defeating the very thing abandon
    // exists for.
    const running = deferred<string[]>();
    mockSeed.mockReturnValueOnce(running.promise).mockResolvedValue([]);
    seedWorktreeEnv("sparkle", "/tmp/wt/slot-1");
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(1));

    const wait = abandonWorktreeSeed("/tmp/wt/slot-1");
    running.resolve([".env"]); // the op call finishes AFTER the teardown
    await wait;

    seedWorktreeEnv("sparkle", "/tmp/wt/slot-1"); // re-cut at the same slot
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(2));
  });

  it("lets a re-cut worktree queue a seed even when the abandoned one was never started", async () => {
    // The queued entry used to sit in the in-flight map until its turn came up (potentially many
    // 20s `op` calls later), so the re-cut path was turned away by a stale entry that was only ever
    // going to no-op — neither seed happened, silently.
    const first = deferred<string[]>();
    mockSeed.mockReturnValueOnce(first.promise).mockResolvedValue([]);
    seedWorktreeEnv("sparkle", "/tmp/wt/w-1");
    seedWorktreeEnv("sparkle", "/tmp/wt/slot-2");
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(1));

    await abandonWorktreeSeed("/tmp/wt/slot-2"); // still queued, never started
    seedWorktreeEnv("sparkle", "/tmp/wt/slot-2"); // re-cut at the same slot

    first.resolve([]);
    await vi.waitFor(() =>
      expect(mockSeed).toHaveBeenCalledWith("vault-abc", "sparkle", "/tmp/wt/slot-2"),
    );
  });

  it("lets a worktree re-cut at the same path seed again", async () => {
    seedWorktreeEnv("sparkle", "/tmp/wt/slot-1");
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(1));
    await abandonWorktreeSeed("/tmp/wt/slot-1");

    seedWorktreeEnv("sparkle", "/tmp/wt/slot-1");
    await vi.waitFor(() => expect(mockSeed).toHaveBeenCalledTimes(2));
  });
});
