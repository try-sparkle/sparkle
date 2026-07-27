// @vitest-environment jsdom
//
// AppBoot's `?agent=` deep-link mount effect: a window opened by a history-search
// "jump to agent" into a fresh window must land directly on that agent (open + select), and must
// silently ignore a closed/unknown agent id (the search row reports "closed" instead). We assert
// on the resulting store state rather than spying, so the test pins behavior, not call shape.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppBoot, useCurrentProjectId } from "./windowContext";
import { useProjectStore } from "./stores/projectStore";
import { useRuntimeStore } from "./stores/runtimeStore";
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
  useDictationStore.setState({ phase: "passive" });
});
afterEach(() => {
  cleanup();
  setSearch("");
});

// The mic's active/paused status is shared + persisted across windows. On a true cold start the
// main window is the only window, so it resets a stale "active" (left over from a previous session)
// back to "passive" — relaunching never resumes mid-dictation. A non-main window must NOT reset, or
// opening a second window mid-session would clobber the live shared status.
describe("AppBoot — cold-start mic phase reset", () => {
  it("main window resets a stale active phase to passive on cold start", () => {
    useDictationStore.setState({ phase: "active" });
    setSearch(""); // no ?label= → the main window
    render(<AppBoot>ok</AppBoot>);
    expect(useDictationStore.getState().phase).toBe("passive");
  });

  it("resets the mic phase regardless of URL params — one window, always \"main\"", () => {
    // CM-U7 part 2: there are no secondary windows; the boot hygiene always runs.
    useDictationStore.setState({ phase: "active" });
    setSearch("?label=win-1"); // a stale multi-window era URL must not change behavior
    render(<AppBoot>ok</AppBoot>);
    expect(useDictationStore.getState().phase).toBe("passive");
  });

  it("main window defers the reset until hydration finishes when not yet hydrated", () => {
    // Real localStorage hydrates synchronously in tests, so the sync (hasHydrated) branch is what
    // the tests above exercise. Drive the async branch directly: stub the store as not-yet-hydrated
    // and capture the onFinishHydration callback, then fire it. The reset must be deferred until the
    // persisted value has landed — otherwise it would be overwritten by hydration.
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
    // Hydration still in flight → reset deferred, phase untouched so far.
    expect(useDictationStore.getState().phase).toBe("active");

    // Hydration settles → the deferred reset fires.
    finishHydration?.();
    expect(useDictationStore.getState().phase).toBe("passive");

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
