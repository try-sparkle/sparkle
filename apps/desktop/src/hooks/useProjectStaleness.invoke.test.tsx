// @vitest-environment jsdom
//
// The `invoke("repo_root_staleness")` BOUNDARY (bead sparkle-cuv2h).
//
// WHY THIS EXISTS SEPARATELY FROM useProjectStaleness.test.ts. That suite proves `toBadge` maps a
// reading correctly — a pure function, no boundary crossed. Nothing asserted that the hook actually
// CALLS the backend, with the right command name and the right argument shape. So the whole feature
// could be inert — wrong command name, wrong arg key, result never wired to state — and all 15,030
// desktop tests would still be green. That is precisely the vacuous-coverage shape this repo treats
// as its #1 finding: a passing suite guarding a feature that never runs.
//
// The command name and the `{ root }` argument key are a CONTRACT with the Rust side
// (`repo_freshness::repo_root_staleness(root: String)`), and a rename on either side is silent at
// runtime — `invoke` of an unknown command rejects, which this hook deliberately swallows as
// "unknown". Pinning both here is what makes that rename fail loudly in CI instead of quietly
// removing the badge.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

// Imported AFTER the mock is registered so the hook binds to it.
const { useProjectStaleness } = await import("./useProjectStaleness");

afterEach(() => {
  invokeMock.mockReset();
  vi.useRealTimers();
});

const STALE = {
  behind: 1696,
  stale: true,
  threshold: 25,
  headBranch: "main",
  base: "origin/main",
  unknown: false,
};

/**
 * The `repo_root_staleness` calls ONLY — this suite is about that one command by name.
 *
 * The hook now issues a SECOND command against the same `invoke` for stale projects
 * (`repo_stale_diagnose`, the unattended fast-forward path, bead sparkle-7h01z), so a bare
 * `toHaveBeenCalledTimes` here would count the measurement AND the diagnosis together and would
 * read as "the poll fired twice" the moment either changed. Filtering by command keeps each
 * assertion pinned to the thing it names — the count and the roots below are still exact, so a
 * project that stopped being measured still fails this.
 */
function staleCalls(): { root: string }[] {
  return invokeMock.mock.calls
    .filter((c) => c[0] === "repo_root_staleness")
    .map((c) => c[1] as { root: string });
}

describe("useProjectStaleness — the invoke boundary", () => {
  it("calls repo_root_staleness with { root } for each project and badges the result", async () => {
    invokeMock.mockResolvedValue(STALE);
    const { result } = renderHook(() =>
      useProjectStaleness([{ id: "p1", rootPath: "/repo/one" }]),
    );

    await waitFor(() => expect(result.current.p1).toBeTruthy());

    // The COMMAND NAME and ARG KEY are the contract with Rust — a rename on either side is silent.
    expect(invokeMock).toHaveBeenCalledWith("repo_root_staleness", { root: "/repo/one" });
    // ...and the reading actually reached the badge, rather than being fetched and dropped.
    expect(result.current.p1).toEqual({ behind: 1696, base: "origin/main" });
  });

  it("queries every open project, not just the first", async () => {
    invokeMock.mockResolvedValue(STALE);
    renderHook(() =>
      useProjectStaleness([
        { id: "p1", rootPath: "/repo/one" },
        { id: "p2", rootPath: "/repo/two" },
      ]),
    );
    await waitFor(() => expect(staleCalls()).toHaveLength(2));
    const roots = staleCalls().map((a) => a.root).sort();
    expect(roots).toEqual(["/repo/one", "/repo/two"]);
  });

  it("a rejected invoke leaves the project unbadged rather than throwing", async () => {
    // The fail-closed path across the boundary: a backend that errors (not a git repo, command
    // missing after a rename) must read as "nothing to say", never as a crash or a stale badge.
    invokeMock.mockRejectedValue(new Error("no such command"));
    const { result } = renderHook(() =>
      useProjectStaleness([{ id: "p1", rootPath: "/repo/one" }]),
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(result.current.p1).toBeUndefined();
  });

  it("skips a project with no rootPath instead of invoking on an empty string", async () => {
    invokeMock.mockResolvedValue(STALE);
    renderHook(() => useProjectStaleness([{ id: "p1", rootPath: "" }]));
    // Give the effect a chance to run before asserting the negative.
    await new Promise((r) => setTimeout(r, 0));
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("re-measures on the poll interval — staleness is a property of the moment", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValue(STALE);
    renderHook(() => useProjectStaleness([{ id: "p1", rootPath: "/repo/one" }], 1000));
    await vi.advanceTimersByTimeAsync(0);
    expect(staleCalls()).toHaveLength(1);
    // A one-shot read would leave the badge frozen for the whole session, which is the failure the
    // poll exists to prevent — so the SECOND call is the assertion that matters.
    await vi.advanceTimersByTimeAsync(1000);
    expect(staleCalls()).toHaveLength(2);
  });

  it("stops polling after unmount", async () => {
    vi.useFakeTimers();
    invokeMock.mockResolvedValue(STALE);
    const { unmount } = renderHook(() =>
      useProjectStaleness([{ id: "p1", rootPath: "/repo/one" }], 1000),
    );
    await vi.advanceTimersByTimeAsync(0);
    unmount();
    const after = staleCalls().length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(staleCalls()).toHaveLength(after);
  });
});
