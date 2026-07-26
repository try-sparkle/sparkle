// Direct tests for the shared single-owner window election. It is reached through two independent
// callers (capture://send routing and the orchestration spin_down gate), both of which act
// DESTRUCTIVELY on a true verdict — so the module's own edge cases are pinned here rather than only
// through whichever caller happens to exercise them.
//
// The two properties under test are a pair, and each half has its own failure mode:
//   at-most-one  — two windows both acting means a doubled teardown (N killPty, N worktree removes).
//   at-least-one — every window declining means the request is silently dropped and its caller
//                  blocks until the bridge times out.
import { describe, it, expect, vi } from "vitest";
import {
  routeToOwningWindow,
  shouldHandleInThisWindow,
  type WindowDispatchDeps,
} from "./windowOwnership";

/** Build deps over a mutable fake registry (label -> displayed project id). `alive` lists the
 *  labels whose windows still exist, so a crash is modelled by a registry entry with no
 *  corresponding live label. */
function deps(
  myLabel: string,
  isMain: boolean,
  registry: Record<string, string>,
  alive: string[] = [],
  overrides: Partial<WindowDispatchDeps> = {},
): WindowDispatchDeps {
  return {
    myLabel,
    isMain,
    findWindowForProject: (pid) => Object.entries(registry).find(([, v]) => v === pid)?.[0] ?? null,
    isWindowAlive: async (l) => alive.includes(l),
    evictWindow: (l) => {
      delete registry[l];
    },
    ...overrides,
  };
}

describe("routeToOwningWindow", () => {
  it("the registered owner handles it", () => {
    expect(routeToOwningWindow("p1", deps("win-a", false, { "win-a": "p1" }))).toBe(true);
  });

  it("a window that is not the owner declines", () => {
    expect(
      routeToOwningWindow("p1", deps("win-b", false, { "win-a": "p1", "win-b": "p2" })),
    ).toBe(false);
  });

  it("main declines while another window owns the project", () => {
    expect(routeToOwningWindow("p1", deps("main", true, { "win-a": "p1", main: "p2" }))).toBe(false);
  });

  it("main adopts a project no window has registered", () => {
    expect(routeToOwningWindow("p3", deps("main", true, { "win-a": "p1" }))).toBe(true);
  });

  it("a non-main window never adopts an unowned project", () => {
    expect(routeToOwningWindow("p3", deps("win-a", false, { "win-a": "p1" }))).toBe(false);
  });

  it("exactly one window answers true for a given project", () => {
    // The at-most-one property stated directly: poll every open window about one project.
    const registry = { "win-a": "p1", "win-b": "p2", main: "p3" };
    const verdicts = Object.keys(registry).map((l) =>
      routeToOwningWindow("p1", deps(l, l === "main", registry)),
    );
    expect(verdicts.filter(Boolean).length).toBe(1);
  });
});

describe("shouldHandleInThisWindow (stale-owner self-heal)", () => {
  it("main stays out while the registered owner is alive", async () => {
    const registry = { "win-a": "p1", main: "p2" };
    await expect(shouldHandleInThisWindow("p1", deps("main", true, registry, ["win-a"]))).resolves.toBe(
      false,
    );
    expect(registry["win-a"]).toBe("p1"); // a live owner is never evicted
  });

  it("main evicts a dead owner and adopts the orphan", async () => {
    const registry = { "win-dead": "p1", main: "p2" };
    await expect(shouldHandleInThisWindow("p1", deps("main", true, registry, []))).resolves.toBe(true);
    expect(registry["win-dead"]).toBeUndefined();
  });

  it("a crash + Replace leaves two labels on one project; the LIVE one wins, main stays out", async () => {
    // Object key order puts the dead label first, so main resolves it, evicts it, and must then
    // re-resolve to the live replacement rather than adopting on the first eviction.
    const registry: Record<string, string> = { "win-dead": "p1", "win-alive": "p1", main: "p2" };
    await expect(
      shouldHandleInThisWindow("p1", deps("main", true, registry, ["win-alive"])),
    ).resolves.toBe(false);
    expect(registry["win-dead"]).toBeUndefined();
    expect(registry["win-alive"]).toBe("p1");
  });

  it("an inconclusive liveness probe is treated as ALIVE, so main does not double up", async () => {
    // The owner already answered true in its own window; assuming dead here would mean two handlers.
    const registry = { "win-a": "p1", main: "p2" };
    const d = deps("main", true, registry, [], {
      isWindowAlive: () => Promise.reject(new Error("ipc hiccup")),
    });
    await expect(shouldHandleInThisWindow("p1", d)).resolves.toBe(false);
    expect(registry["win-a"]).toBe("p1"); // never evicted on an inconclusive probe
  });

  it("a non-main window never self-heals, even when the owner is dead", async () => {
    const evictWindow = vi.fn();
    const d = deps("win-b", false, { "win-dead": "p1", "win-b": "p2" }, [], { evictWindow });
    await expect(shouldHandleInThisWindow("p1", d)).resolves.toBe(false);
    expect(evictWindow).not.toHaveBeenCalled();
  });

  it("the owner itself short-circuits without ever probing liveness", async () => {
    const isWindowAlive = vi.fn(async () => true);
    const d = deps("win-a", false, { "win-a": "p1" }, ["win-a"], { isWindowAlive });
    await expect(shouldHandleInThisWindow("p1", d)).resolves.toBe(true);
    expect(isWindowAlive).not.toHaveBeenCalled();
  });
});
