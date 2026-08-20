// @vitest-environment jsdom
//
// AppBoot's `?agent=` deep-link mount effect: a window opened by a history-search
// "jump to agent" into a fresh window must land directly on that agent (open + select), and must
// silently ignore a closed/unknown agent id (the search row reports "closed" instead). We assert
// on the resulting store state rather than spying, so the test pins behavior, not call shape.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppBoot, UI_HYDRATION_GRACE_MS, useCurrentProjectId } from "./windowContext";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
import { useUiStore } from "./stores/uiStore";
import { useDictationStore } from "./stores/dictationStore";
import type { AgentTab, Project } from "./types";

function mkAgent(id: string): AgentTab {
  return {
    id, name: id, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: false, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null,  };
}
function seedProject(agents: AgentTab[]): void {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: null,
    createdAt: new Date(0).toISOString(), selectedAgentId: null, agents,
  };
  useProjectStore.setState({ projects: [project], selectedProjectId: "p1" } as never);
}

/** Point this "window" at a project + (optional) deep-link agent before mounting the provider. */
function setSearch(search: string): void {
  window.history.replaceState(null, "", `/${search}`);
}

const selectedAgentId = () =>
  useProjectStore.getState().projects.find((p) => p.id === "p1")?.selectedAgentId ?? null;

/** Renders the window's current project id so tests can assert what the window actually shows. */
function ProjectIdProbe() {
  const id = useCurrentProjectId();
  return <span data-testid="pid">{id ?? "none"}</span>;
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
  useRuntimeStore.setState({ openAgentIds: [] } as never);
  // Closable tabs: `null` = never seeded, i.e. every project is open. uiStore is a module singleton,
  // so without this reset one test's closed tabs would decide the next test's boot selection.
  useUiStore.setState({ openProjectIds: null } as never);
  useDictationStore.setState({ phase: "passive" });
});
afterEach(() => {
  cleanup();
  setSearch("");
});

// THE MIC'S ROUTING STATE SURVIVES A RELAUNCH, exactly as its on/off state already does.
//
// `dictationStore` persists BOTH user-facing mic settings — `enabled` (on/off) and `phase` (paused
// vs. actively listening). Boot used to restore only the first and force the second back to
// "passive", which left the two halves inconsistent in the one way the user cannot see: the mic
// came back ARMED AND CAPTURING with routing silently off, so every hold recorded audio and
// transcribed nothing.
//
// That cost the founder a live session (bead sparkle-ysv1gj). Field logs across one 10-minute
// stretch: 49 mic toggles, 0 cloud streams opened, 1 transcript — against 3 toggles / 24 opens on
// the previous launch, with every file in the mic path byte-identical between the two. The reset
// was the whole difference, and nothing on screen said so.
//
// It was not recoverable by the obvious gesture either, which is what made it a trap rather than an
// annoyance: `useMicToggle` (the mic button) cycled off → paused → off and could not reach "active"
// — the single `setPhase("active")` call site was the hover pill's Listening option, so a user who
// did not know about the pill had no way back from the reset. That gesture is now fixed too (bead
// sparkle-yvvu27): a plain mic click arms AND routes (off → active), reaching the routing state
// directly (MicButton.tsx). Restoring the persisted phase still matters — it brings a relaunch back
// to the user's stated intent without a click — which is what these tests pin.
//
// These tests therefore assert that boot LEAVES THE HYDRATED PHASE ALONE, in both directions.
describe("AppBoot — the persisted mic phase survives a relaunch", () => {
  it("keeps a persisted \"active\" phase, so a relaunch comes back listening", () => {
    useDictationStore.setState({ phase: "active" });
    setSearch(""); // no ?label= → the main window
    render(<AppBoot>ok</AppBoot>);
    expect(useDictationStore.getState().phase).toBe("active");
  });

  // THE PAIRED DIRECTION, and it is what stops this from being pinned by a flipped constant: a
  // boot that wrote `setPhase("active")` unconditionally would satisfy the test above and fail
  // here. Only "boot does not write the phase at all" satisfies both.
  it("keeps a persisted \"passive\" phase — boot writes neither value", () => {
    useDictationStore.setState({ phase: "passive" });
    setSearch("");
    render(<AppBoot>ok</AppBoot>);
    expect(useDictationStore.getState().phase).toBe("passive");
  });

  it("leaves the phase alone regardless of URL params — one window, always \"main\"", () => {
    // CM-U7 part 2: there are no secondary windows; the boot hygiene always runs.
    useDictationStore.setState({ phase: "active" });
    setSearch("?label=win-1"); // a stale multi-window era URL must not change behavior
    render(<AppBoot>ok</AppBoot>);
    expect(useDictationStore.getState().phase).toBe("active");
  });

  it("does not clobber the phase when hydration settles AFTER mount", () => {
    // Real localStorage hydrates synchronously in tests, so the tests above exercise the already-
    // hydrated path. Drive the deferred path directly: stub the store as not-yet-hydrated, render,
    // then settle hydration. The removed reset ran on exactly this callback, so this is the arm
    // that would resurrect it — a re-added `onFinishHydration(() => setPhase("passive"))` passes
    // every other test here and fails only this one.
    useDictationStore.setState({ phase: "active" });
    let finishHydration: (() => void) | undefined;
    const hasHydrated = vi.spyOn(useDictationStore.persist, "hasHydrated").mockReturnValue(false);
    const onFinish = vi
      .spyOn(useDictationStore.persist, "onFinishHydration")
      .mockImplementation((fn) => {
        finishHydration = fn as () => void;
        return () => {};
      });

    setSearch(""); // the main window
    render(<AppBoot>ok</AppBoot>);
    expect(useDictationStore.getState().phase).toBe("active");

    // Hydration settles — and still nothing writes the phase.
    finishHydration?.();
    expect(useDictationStore.getState().phase).toBe("active");

    hasHydrated.mockRestore();
    onFinish.mockRestore();
  });
});

describe("AppBoot — ?agent= deep-link", () => {
  it("selects + opens an existing agent named by ?agent= on mount", () => {
    seedProject([mkAgent("a1"), mkAgent("a2")]);
    setSearch("?project=p1&label=win-1&agent=a2");
    render(<AppBoot>ok</AppBoot>);
    expect(selectedAgentId()).toBe("a2");
    expect(useRuntimeStore.getState().isOpen("a2")).toBe(true);
  });

  it("silently ignores a closed/unknown agent id (no select, no open)", () => {
    seedProject([mkAgent("a1")]);
    setSearch("?project=p1&label=win-1&agent=gone");
    render(<AppBoot>ok</AppBoot>);
    expect(selectedAgentId()).toBeNull();
    expect(useRuntimeStore.getState().isOpen("gone")).toBe(false);
    expect(useRuntimeStore.getState().openAgentIds).toEqual([]);
  });

  it("does nothing when no ?agent= param is present", () => {
    seedProject([mkAgent("a1")]);
    setSearch("?project=p1&label=win-1");
    render(<AppBoot>ok</AppBoot>);
    expect(selectedAgentId()).toBeNull();
    expect(useRuntimeStore.getState().openAgentIds).toEqual([]);
  });
});

// Regression: a brand-new secondary window is created with `?project=<id>` and its OS title is
// stamped from the OPENER's store, but zustand's persist applies the hydrated localStorage snapshot
// in a microtask — so the window can run the one-shot `initial` memo BEFORE its own store hydrates,
// find the id absent, and strand at null forever ("amforge" title + "No project open"). The window
// must adopt its deep-linked project the moment it actually appears, while still ignoring an id that
// is genuinely gone.
describe("AppBoot — late-hydration project recovery", () => {
  it("adopts its ?project= id once the store hydrates it after mount", () => {
    // Store is empty at mount (persist snapshot not applied yet); p1 arrives afterward.
    setSearch("?project=p1&label=win-1");
    const { getByTestId } = render(
      <AppBoot>
        <ProjectIdProbe />
      </AppBoot>,
    );
    // One-shot `initial` resolves to null because p1 isn't in the unhydrated store.
    expect(getByTestId("pid").textContent).toBe("none");
    // Hydration lands (or cross-window sync delivers the just-created project).
    act(() => {
      seedProject([]);
    });
    expect(getByTestId("pid").textContent).toBe("p1");
  });

  // Single-window shell (CM-U7): a stale `?project=` no longer strands the app at "no project" —
  // there is one window and every project is a tab, so an unresolvable deep link simply falls back
  // to the persisted selection / the first tab. Only a store with NO projects shows nothing.
  it("falls back to the first tab when its ?project= id never appears (stale/deleted)", () => {
    setSearch("?project=ghost&label=win-1");
    const { getByTestId } = render(
      <AppBoot>
        <ProjectIdProbe />
      </AppBoot>,
    );
    expect(getByTestId("pid").textContent).toBe("none"); // nothing hydrated yet
    // A DIFFERENT project (p1) hydrates — the phantom `ghost` id must not resolve to it, but the
    // shell still lands on a real tab rather than showing an empty window.
    act(() => {
      seedProject([]);
    });
    expect(getByTestId("pid").textContent).toBe("p1");
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
  });

  it("still lands the ?agent= deep-link after the project hydrates late", () => {
    // A "jump to agent" opened into a fresh window carries ?project=+?agent=; both must survive a
    // late store hydration — the recovery path adopts the project AND lands the agent, not just one.
    setSearch("?project=p1&label=win-1&agent=a2");
    const { getByTestId } = render(
      <AppBoot>
        <ProjectIdProbe />
      </AppBoot>,
    );
    expect(getByTestId("pid").textContent).toBe("none");
    expect(useRuntimeStore.getState().isOpen("a2")).toBe(false);
    act(() => {
      seedProject([mkAgent("a1"), mkAgent("a2")]);
    });
    expect(getByTestId("pid").textContent).toBe("p1");
    expect(selectedAgentId()).toBe("a2");
    expect(useRuntimeStore.getState().isOpen("a2")).toBe(true);
  });
});

// The main window (no `?label=`) is the one a cold start restores: computeInitialProjectId reads
// selectedProjectId. So the main window must keep selectedProjectId synced with the project it
// actually shows, or a relaunch reverts to the first ("zero-zero") project. Secondary windows carry
// `?project=` and must NOT claim the shared hint.
describe("AppBoot — main-window restore hint", () => {
  function seedTwo(): void {
    const mk = (id: string): Project => ({
      id, name: id, rootPath: `/tmp/${id}`, defaultBranch: null,
      createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [],
    });
    useProjectStore.setState({ projects: [mk("p1"), mk("p2")] } as never);
  }

  it("main window claims its resolved project as the restore hint on mount", () => {
    // No hint yet → main window resolves to the first project; it must then persist that as the hint.
    seedTwo();
    setSearch(""); // no ?label= → this IS the main window
    const { getByTestId } = render(
      <AppBoot>
        <ProjectIdProbe />
      </AppBoot>,
    );
    expect(getByTestId("pid").textContent).toBe("p1");
    expect(useProjectStore.getState().selectedProjectId).toBe("p1");
  });

  it("restores the last-selected project (not the first) on a fresh main window", () => {
    // Simulate a prior session having left p2 as the selection; a relaunched main window reopens p2.
    seedTwo();
    useProjectStore.setState({ selectedProjectId: "p2" } as never);
    setSearch("");
    const { getByTestId } = render(
      <AppBoot>
        <ProjectIdProbe />
      </AppBoot>,
    );
    expect(getByTestId("pid").textContent).toBe("p2");
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
  });

  // Single-window shell (CM-U7): selectedProjectId is no longer a restore HINT that only the main
  // window may claim — it is the live selection every surface reads, and a `?project=` deep link
  // adopts it for the whole app rather than for one window's private state.
  it("a ?project= deep link adopts the shared selection (no per-window fork)", () => {
    seedTwo();
    useProjectStore.setState({ selectedProjectId: "p1" } as never);
    setSearch("?project=p2&label=win-1");
    const { getByTestId } = render(
      <AppBoot>
        <ProjectIdProbe />
      </AppBoot>,
    );
    expect(getByTestId("pid").textContent).toBe("p2");
    expect(useProjectStore.getState().selectedProjectId).toBe("p2");
  });

  it("the probe follows a later selectProject (tab switch), not just the boot value", () => {
    seedTwo();
    setSearch("");
    const { getByTestId } = render(
      <AppBoot>
        <ProjectIdProbe />
      </AppBoot>,
    );
    expect(getByTestId("pid").textContent).toBe("p1");
    act(() => useProjectStore.getState().selectProject("p2"));
    expect(getByTestId("pid").textContent).toBe("p2");
  });
});

// Closable project tabs: the boot selection must never land on a project the tab bar doesn't list.
// It used to fall back to `projects[0]`, which after that change could restore a CLOSED project and
// show the shell a project with no tab — the exact incoherence the open set exists to prevent.
describe("AppBoot — boot selection respects closed tabs", () => {
  function seedTwo(): void {
    const mk = (id: string): Project => ({
      id, name: id, rootPath: `/tmp/${id}`, defaultBranch: null,
      createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [],
    });
    useProjectStore.setState({ projects: [mk("p1"), mk("p2")] } as never);
  }
  const boot = () =>
    render(
      <AppBoot>
        <ProjectIdProbe />
      </AppBoot>,
    );

  /** Watches the ONE timer the boot resolver owns — the `UI_HYDRATION_GRACE_MS` backstop.
   *
   *  `vi.getTimerCount()` cannot answer "is the backstop armed?", because it is a GLOBAL count and
   *  boot is not the only thing arming timers: jsdom's Storage schedules a `setTimeout(…, 0)` per
   *  `localStorage.setItem` to dispatch the `storage` event (jsdom/living/webstorage/Storage-impl.js
   *  — `setTimeout(this._dispatchStorageEvent.bind(this), 0, …)`), and a single `boot()` writes
   *  storage several times (windowRegistry, plus every `persist`-wrapped store it touches). So the
   *  global count is 2-4 with no boot timer armed at all.
   *
   *  That read is environment-dependent, which is how it passed locally and failed on CI: on Node
   *  >=25 the runtime defines its own `localStorage` global that vitest's jsdom env leaves in place,
   *  `test-setup.ts` feature-detects it as unusable and swaps in MemoryStorage — which arms nothing —
   *  so the count really is 0. CI runs Node 22, which has no such global, so jsdom's real Storage
   *  stays and its timers get counted. Measuring only OUR delay makes the assertion mean the same
   *  thing on both. */
  function traceGraceTimer(): { armed: () => number; pending: () => number; restore: () => void } {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const pending = new Set<unknown>();
    let armed = 0;
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
      if (ms !== UI_HYDRATION_GRACE_MS || typeof handler !== "function")
        return realSetTimeout(handler as never, ms, ...(rest as never[]));
      armed += 1;
      // A timer that FIRES is no longer pending — without this, "still armed" and "already ran"
      // would be indistinguishable and a leak check could never fail honestly.
      const id: unknown = realSetTimeout(
        ((...args: unknown[]) => {
          pending.delete(id);
          (handler as (...a: unknown[]) => void)(...args);
        }) as never,
        ms,
        ...(rest as never[]),
      );
      pending.add(id);
      return id;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((id?: unknown) => {
      pending.delete(id);
      return realClearTimeout(id as never);
    }) as typeof globalThis.clearTimeout;
    return {
      armed: () => armed,
      pending: () => pending.size,
      restore: () => {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
      },
    };
  }

  it("refuses to restore a CLOSED project, taking the first OPEN one instead", () => {
    seedTwo();
    useUiStore.setState({ openProjectIds: ["p2"] } as never); // p1 closed
    useProjectStore.setState({ selectedProjectId: "p1" } as never);
    setSearch("");
    expect(boot().getByTestId("pid").textContent).toBe("p2");
  });

  it("keeps a persisted selection that is still open", () => {
    seedTwo();
    useUiStore.setState({ openProjectIds: ["p1", "p2"] } as never);
    useProjectStore.setState({ selectedProjectId: "p2" } as never);
    setSearch("");
    expect(boot().getByTestId("pid").textContent).toBe("p2");
  });

  it("selects NOTHING when every tab is closed — the welcome state, not a phantom selection", () => {
    seedTwo();
    useUiStore.setState({ openProjectIds: [] } as never);
    useProjectStore.setState({ selectedProjectId: "p1" } as never);
    setSearch("");
    expect(boot().getByTestId("pid").textContent).toBe("none");
    expect(useProjectStore.getState().selectedProjectId).toBeNull();
  });

  it("a ?project= deep link REOPENS a closed project rather than being skipped", () => {
    // A deep link is an explicit "show me this one", so it earns its tab.
    seedTwo();
    useUiStore.setState({ openProjectIds: ["p1"] } as never); // p2 closed
    setSearch("?project=p2");
    expect(boot().getByTestId("pid").textContent).toBe("p2");
    expect(useUiStore.getState().openProjectIds).toContain("p2");
  });

  // The wait on uiStore hydration must be BOUNDED. zustand sets `hasHydrated` inside a `.then()`
  // that its `.catch()` bypasses, and createJSONStorage().getItem JSON.parses with no guard — so a
  // truncated `sparkle-ui` blob, a throwing migrate, or a localStorage that throws leaves
  // `hasHydrated` false forever AND fires no further `set` for the subscription to notice. An
  // unconditional gate would turn that (previously: "you lose your UI preferences") into "the app
  // boots with tabs and nothing selected, and a cold-start notification hand-off is dropped".
  it("settles anyway when uiStore hydration never finishes", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(useUiStore.persist, "hasHydrated").mockReturnValue(false);
    try {
      // No selection yet, so the probe can only read "p1" if the boot resolver actually ran.
      seedTwo();
      setSearch("");
      const { getByTestId } = boot();
      // Still waiting — the gate is real, not decorative.
      expect(getByTestId("pid").textContent).toBe("none");
      expect(useProjectStore.getState().selectedProjectId).toBeNull();
      // …but it gives up, and falls back to the in-memory default (openProjectIds null = all open),
      // which is exactly the state it was waiting to confirm.
      act(() => void vi.advanceTimersByTime(UI_HYDRATION_GRACE_MS));
      expect(getByTestId("pid").textContent).toBe("p1");
      expect(useProjectStore.getState().selectedProjectId).toBe("p1");
    } finally {
      // Restored in `finally`: a failed assertion above would otherwise leave every later test in
      // this file looking at a store that claims it never hydrated.
      spy.mockRestore();
      vi.useRealTimers();
    }
  });

  // The wait must be released by hydration FINISHING, not only by its timeout. A plain
  // `useUiStore.subscribe` cannot do it, and this test models exactly why: zustand applies the
  // stored state with `set(stateFromStorage, true)` in one `.then()` and flips `hasHydrated` in the
  // NEXT one (zustand/esm/middleware.mjs:421 vs :431), so the single `set` hydration ever fires
  // arrives while `hasHydrated()` is still false. Sequenced below in that order on purpose — with
  // the two collapsed, a store-subscription implementation would pass and prove nothing.
  it("settles as soon as hydration FINISHES, without waiting out the grace window", () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const hasHydrated = vi.spyOn(useUiStore.persist, "hasHydrated").mockReturnValue(false);
    const onFinish = vi
      .spyOn(useUiStore.persist, "onFinishHydration")
      .mockImplementation((fn) => {
        finish = fn as () => void;
        return () => {};
      });
    const grace = traceGraceTimer();
    try {
      seedTwo();
      setSearch("");
      const { getByTestId } = boot();
      expect(getByTestId("pid").textContent).toBe("none"); // gated, as intended
      // The backstop IS armed on this path — otherwise "detach() cleared it" below would pass
      // vacuously against a timer that never existed.
      expect(grace.armed()).toBe(1);
      expect(grace.pending()).toBe(1);

      // Step 1 — the state `set` lands while hasHydrated is still FALSE. A store subscriber sees
      // this and must bail; nothing may settle yet.
      act(() => void useUiStore.setState({ openProjectIds: ["p2"] } as never)); // p1 closed
      expect(getByTestId("pid").textContent).toBe("none");

      // Step 2 — hasHydrated flips in the next microtask with NO further `set`; only the
      // finish-hydration listeners are called. This is the signal that has to do the work.
      act(() => {
        hasHydrated.mockReturnValue(true);
        finish?.();
      });

      // Settled against the HYDRATED open set (p1 is closed, so p2), and with no timer advance —
      // a deferred hydrate must not cost the full grace window.
      expect(getByTestId("pid").textContent).toBe("p2");
      expect(useProjectStore.getState().selectedProjectId).toBe("p2");
      expect(grace.pending()).toBe(0); // detach() cleared the backstop
    } finally {
      grace.restore();
      hasHydrated.mockRestore();
      onFinish.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not arm the grace timer at all when uiStore is already hydrated", () => {
    // The normal path: synchronous localStorage means hydration is done before AppBoot's effect
    // runs, so boot selection settles in the first pass with no timer involved.
    vi.useFakeTimers();
    const grace = traceGraceTimer();
    try {
      seedTwo();
      setSearch("");
      expect(boot().getByTestId("pid").textContent).toBe("p1");
      expect(grace.armed()).toBe(0);
    } finally {
      grace.restore();
      vi.useRealTimers();
    }
  });

  // The DEFERRED path: an empty store at mount (persist snapshot not applied yet), a `?project=`
  // naming a closed project, and `projects` arriving afterwards. `markProjectOpen` is a store write,
  // and this effect subscribes to uiStore — so it re-enters the resolver through its own
  // subscription unless `detach()` has already run. Every other AppBoot case seeds `projects` before
  // render, so `resolve()` succeeds synchronously and never subscribes: only this one reaches it.
  it("resolves exactly ONCE when a late-hydrating deep link reopens a closed project", () => {
    useUiStore.setState({ openProjectIds: [] } as never); // p1 exists nowhere yet, but is closed
    setSearch("?project=p1&agent=a2");
    const { getByTestId } = boot();
    expect(getByTestId("pid").textContent).toBe("none"); // nothing to resolve against yet

    const openSpy = vi.spyOn(useRuntimeStore.getState(), "open");
    act(() => {
      const mk = (id: string): Project => ({
        id, name: id, rootPath: `/tmp/${id}`, defaultBranch: null,
        createdAt: new Date(0).toISOString(), selectedAgentId: null, agents: [mkAgent("a2")],
      });
      useProjectStore.setState({ projects: [mk("p1")] } as never);
    });

    expect(getByTestId("pid").textContent).toBe("p1");
    expect(useUiStore.getState().openProjectIds).toEqual(["p1"]);
    // The deep-link landing must run once, not twice. It is idempotent today (runtimeStore.open
    // unions, selectAgent is a plain set), so a double-run is invisible in the resulting state —
    // the call count is what actually pins "resolve ONCE".
    expect(openSpy).toHaveBeenCalledTimes(1);
    openSpy.mockRestore();
  });
});
