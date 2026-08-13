// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChiefBindingPicker, CHIEF_PICKER_VISIBLE_CAP } from "./ChiefBindingPicker";
import { useProjectStore } from "../stores/projectStore";
import type { ChiefProject } from "../services/chiefScope";
import type { Project } from "../types";

// ChiefBindingPicker (bead `sparkle-8rr0c`).
//
// Every behavioural assertion here reads the SIDE EFFECT — the binding as it ended up in the store,
// or the exact arguments the setter was called with — never merely that a row rendered. A row
// rendering proves the catalog arrived, which was already true before the click.
//
// No assertion touches layout or class-derived computed style: jsdom neither lays out nor loads the
// stylesheet, so those are silently inert (docs/jsdom-test-caveats.md). Plain DOM matchers
// throughout — this repo does not load jest-dom.

// The store is a module SINGLETON, so a test that swaps `setChiefBinding` for a spy leaves the spy
// installed for every test after it — which silently turns the store-state assertions below into
// assertions about a mock that writes nothing. Captured once here and restored in beforeEach.
const REAL_SET_CHIEF_BINDING = useProjectStore.getState().setChiefBinding;

function seed(overrides: Partial<Project> = {}) {
  const project: Project = {
    id: "p1",
    name: "P",
    rootPath: "/tmp/p",
    defaultBranch: null,
    createdAt: new Date(0).toISOString(),
    selectedAgentId: null,
    agents: [],
    ...overrides,
  };
  useProjectStore.setState({ projects: [project], selectedProjectId: "p1" } as never);
}

const stored = () => useProjectStore.getState().projects.find((p) => p.id === "p1")!;
const text = (testId: string) => screen.getByTestId(testId).textContent ?? "";
const rows = () => screen.queryAllByTestId(/^chief-binding-row-/);

const CATALOG: ChiefProject[] = [
  { project_id: "prj_alpha", name: "Alpha Corp", description: "Retainer work" },
  { project_id: "prj_bravo", name: "Bravo Ltd", description: "Website rebuild" },
  { project_id: "prj_charlie", name: "Charlie Inc", description: "Discovery" },
];

/** A catalog the size of the real one — 348 projects is the case the filter exists for. The needle
 *  sits at index 300, i.e. FAR past the visible cap, so "the filter found it" cannot be satisfied
 *  by it having been on screen all along. */
const NEEDLE_AT = 300;
function bigCatalog(n = 348): ChiefProject[] {
  return Array.from({ length: n }, (_, i) => ({
    project_id: `prj_${i}`,
    name: i === NEEDLE_AT ? "Needle Industries" : `Client ${i}`,
    description: i === NEEDLE_AT ? "the one we are looking for" : `Engagement ${i}`,
  }));
}

async function renderPicker(load: () => Promise<ChiefProject[]> = async () => CATALOG) {
  render(<ChiefBindingPicker projectId="p1" loadChiefProjects={load} />);
  // The mount fetch is async; nothing below is meaningful until it settles.
  await waitFor(() => expect(screen.queryByTestId("chief-binding-loading")).toBeNull());
}

beforeEach(() => {
  useProjectStore.setState({ setChiefBinding: REAL_SET_CHIEF_BINDING } as never);
  seed();
});
afterEach(() => cleanup());

describe("ChiefBindingPicker — choosing a project", () => {
  it("binding a project WRITES it to the store, and marks it primary because it is the first", async () => {
    await renderPicker();
    expect(stored().chiefProjectIds ?? []).toEqual([]);

    fireEvent.click(screen.getByTestId("chief-binding-toggle-prj_bravo"));

    expect(stored().chiefProjectIds).toEqual(["prj_bravo"]);
    // The first bound project becomes primary: a bound project with no primary still refuses every
    // unnamed call, which reads as the control not having worked.
    expect(stored().chiefPrimaryId).toBe("prj_bravo");
  });

  it("calls setChiefBinding with EXACTLY the expected arguments", async () => {
    const spy = vi.fn();
    seed({ chiefProjectIds: ["prj_alpha"], chiefPrimaryId: "prj_alpha" });
    useProjectStore.setState({ setChiefBinding: spy } as never);
    await renderPicker();

    fireEvent.click(screen.getByTestId("chief-binding-toggle-prj_charlie"));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("p1", {
      chiefProjectIds: ["prj_alpha", "prj_charlie"],
      chiefPrimaryId: "prj_alpha",
    });
  });

  it("binds MANY — one Sparkle project to several Chief projects", async () => {
    await renderPicker();

    fireEvent.click(screen.getByTestId("chief-binding-toggle-prj_alpha"));
    fireEvent.click(screen.getByTestId("chief-binding-toggle-prj_charlie"));

    expect(stored().chiefProjectIds).toEqual(["prj_alpha", "prj_charlie"]);
    expect(stored().chiefPrimaryId).toBe("prj_alpha");
  });

  it("'Make primary' moves the primary, and binds the project if it wasn't bound", async () => {
    seed({ chiefProjectIds: ["prj_alpha"], chiefPrimaryId: "prj_alpha" });
    await renderPicker();

    fireEvent.click(screen.getByTestId("chief-binding-primary-prj_charlie"));

    expect(stored().chiefProjectIds).toEqual(["prj_alpha", "prj_charlie"]);
    expect(stored().chiefPrimaryId).toBe("prj_charlie");
  });
});

describe("ChiefBindingPicker — the current binding, and unbinding", () => {
  it("renders the binding it already has, naming the primary in the terms an agent meets it", async () => {
    seed({ chiefProjectIds: ["prj_alpha", "prj_charlie"], chiefPrimaryId: "prj_charlie" });
    await renderPicker();

    const current = text("chief-binding-current");
    expect(current).toContain("Alpha Corp");
    expect(current).toContain("Charlie Inc");
    // Not "default" — the word that invites reading it as a fallback for a lookup that missed.
    expect(current).toContain("names no project gets");
    expect(screen.queryByTestId("chief-binding-unbound")).toBeNull();
  });

  it("un-checking the PRIMARY clears the primary rather than promoting a neighbour", async () => {
    seed({ chiefProjectIds: ["prj_alpha", "prj_charlie"], chiefPrimaryId: "prj_alpha" });
    await renderPicker();

    fireEvent.click(screen.getByTestId("chief-binding-remove-prj_alpha"));

    expect(stored().chiefProjectIds).toEqual(["prj_charlie"]);
    // Promoting Charlie would silently change which project an unnamed call reads.
    expect(stored().chiefPrimaryId).toBeNull();
  });

  it("removing a NON-primary project leaves the primary exactly where it was", async () => {
    // THE PAIRED CASE for the test above, and it is the one that actually pins the component's
    // rule. Un-checking the PRIMARY can't distinguish "the picker cleared it" from "the store's
    // invariant corrected it", because a dropped id makes the old primary out-of-set either way —
    // so that test alone stays green even if the picker's condition is inverted. Dropping a
    // non-primary is where the two answers diverge: the invariant has nothing to correct, so only
    // the picker's own logic decides, and an inverted condition nulls a primary that must survive.
    seed({ chiefProjectIds: ["prj_alpha", "prj_charlie"], chiefPrimaryId: "prj_alpha" });
    await renderPicker();

    fireEvent.click(screen.getByTestId("chief-binding-remove-prj_charlie"));

    expect(stored().chiefProjectIds).toEqual(["prj_alpha"]);
    expect(stored().chiefPrimaryId).toBe("prj_alpha");
  });

  it("removing the LAST bound project clears the primary to null", async () => {
    seed({ chiefProjectIds: ["prj_alpha"], chiefPrimaryId: "prj_alpha" });
    await renderPicker();

    fireEvent.click(screen.getByTestId("chief-binding-remove-prj_alpha"));

    expect(stored().chiefProjectIds).toEqual([]);
    expect(stored().chiefPrimaryId).toBeNull();
    expect(screen.getByTestId("chief-binding-unbound")).toBeTruthy();
  });

  it("'Unbind all' empties the binding in one action", async () => {
    seed({ chiefProjectIds: ["prj_alpha", "prj_bravo"], chiefPrimaryId: "prj_bravo" });
    await renderPicker();

    fireEvent.click(screen.getByTestId("chief-binding-unbind-all"));

    expect(stored().chiefProjectIds).toEqual([]);
    expect(stored().chiefPrimaryId).toBeNull();
  });

  it("says UNBOUND means refused, so an empty binding doesn't read as 'reaches everything'", async () => {
    await renderPicker();
    expect(text("chief-binding-unbound").toLowerCase()).toContain("refused");
  });
});

describe("ChiefBindingPicker — the filter", () => {
  it("narrows a 348-project catalog down to the match", async () => {
    await renderPicker(async () => bigCatalog());

    // Before filtering: capped, and the cap is STATED rather than silently truncating.
    expect(rows()).toHaveLength(CHIEF_PICKER_VISIBLE_CAP);
    expect(text("chief-binding-overflow")).toContain("of 348");
    expect(screen.queryByTestId("chief-binding-row-prj_300")).toBeNull();

    fireEvent.change(screen.getByTestId("chief-binding-filter"), { target: { value: "needle" } });

    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId("chief-binding-row-prj_300")).toBeTruthy();
    expect(screen.queryByTestId("chief-binding-overflow")).toBeNull();
  });

  it("filters on description and on the opaque id too", async () => {
    await renderPicker();

    fireEvent.change(screen.getByTestId("chief-binding-filter"), { target: { value: "rebuild" } });
    expect(rows()).toHaveLength(1);
    expect(screen.getByTestId("chief-binding-row-prj_bravo")).toBeTruthy();

    fireEvent.change(screen.getByTestId("chief-binding-filter"), {
      target: { value: "prj_charlie" },
    });
    expect(screen.getByTestId("chief-binding-row-prj_charlie")).toBeTruthy();
    expect(screen.queryByTestId("chief-binding-row-prj_alpha")).toBeNull();
  });

  it("a filter that matches nothing says so — and is NOT the same message as an empty account", async () => {
    await renderPicker();

    fireEvent.change(screen.getByTestId("chief-binding-filter"), { target: { value: "zzzz" } });

    const empty = text("chief-binding-empty");
    expect(empty).toContain("No project matches");
    expect(empty).not.toContain("reaches no projects");
  });

  it("a project filtered out of view is still shown as BOUND — reach never depends on scroll", async () => {
    seed({ chiefProjectIds: ["prj_alpha"], chiefPrimaryId: "prj_alpha" });
    await renderPicker();

    fireEvent.change(screen.getByTestId("chief-binding-filter"), { target: { value: "bravo" } });

    expect(screen.queryByTestId("chief-binding-row-prj_alpha")).toBeNull();
    expect(screen.getByTestId("chief-binding-chip-prj_alpha")).toBeTruthy();
  });
});

describe("ChiefBindingPicker — loading and failure", () => {
  it("shows a loading state while the fetch is in flight, and no list", async () => {
    let release!: (v: ChiefProject[]) => void;
    render(
      <ChiefBindingPicker
        projectId="p1"
        loadChiefProjects={() => new Promise<ChiefProject[]>((r) => (release = r))}
      />,
    );

    expect(screen.getByTestId("chief-binding-loading")).toBeTruthy();
    expect(screen.queryByTestId("chief-binding-list")).toBeNull();
    expect(screen.queryByTestId("chief-binding-error")).toBeNull();

    release(CATALOG);
    await waitFor(() => expect(screen.getByTestId("chief-binding-list")).toBeTruthy());
  });

  it("a FAILED load shows an error state, DISTINCT from the empty state", async () => {
    await renderPicker(async () => {
      throw new Error("network unreachable");
    });

    expect(text("chief-binding-error")).toContain("network unreachable");
    // The whole point: a failed call must not render as "this token reaches no projects".
    expect(screen.queryByTestId("chief-binding-empty")).toBeNull();
    expect(screen.queryByTestId("chief-binding-list")).toBeNull();
  });

  it("an EMPTY account shows the empty state, DISTINCT from the error state", async () => {
    await renderPicker(async () => []);

    expect(text("chief-binding-empty")).toContain("reaches no projects");
    expect(screen.queryByTestId("chief-binding-error")).toBeNull();
  });

  it("a failed load leaves the EXISTING binding on screen and intact in the store", async () => {
    seed({ chiefProjectIds: ["prj_alpha"], chiefPrimaryId: "prj_alpha" });
    await renderPicker(async () => {
      throw new Error("boom");
    });

    expect(screen.getByTestId("chief-binding-chip-prj_alpha")).toBeTruthy();
    expect(stored().chiefProjectIds).toEqual(["prj_alpha"]);
  });

  it("Retry re-runs the loader and recovers into the list", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(CATALOG) as unknown as () => Promise<ChiefProject[]>;
    await renderPicker(load);

    fireEvent.click(screen.getByTestId("chief-binding-retry"));

    await waitFor(() => expect(screen.getByTestId("chief-binding-list")).toBeTruthy());
    expect(load).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("chief-binding-error")).toBeNull();
  });
});

describe("ChiefBindingPicker — the loader seam", () => {
  // WHY THERE IS NO "THE PAT" TEST HERE. The token-safety claim — this component never sees the
  // Chief PAT — is STRUCTURAL, not behavioural: the props type declares exactly two fields, neither
  // of which is a secret, and ProjectModal owns the closure that holds the keychain read. A runtime
  // assertion cannot prove a negative about a parameter that does not exist, and an earlier version
  // of this file tried anyway with two assertions that were both VACUOUS:
  //
  //   expect(ChiefBindingPicker.length).toBe(1)   // arity of a destructured-props component is 1
  //                                               // regardless of what fields the object carries —
  //                                               // adding `pat` to the props would not move it.
  //   expect(document.body.textContent).not.toMatch(/sk-|Bearer/)  // nothing in the test ever
  //                                               // supplied a secret, so nothing could match.
  //
  // Neither could fail for the reason it named, which is the repo's #1 finding shape. Deleted rather
  // than dressed up. What IS observable at runtime is the SHAPE OF THE SEAM that keeps the token
  // out — a loader the component calls with nothing and cannot re-parameterise — so that is what
  // these two assert, and both have a failure mode a real refactor would reach.

  // …AND THE STRUCTURAL CLAIM GETS A STRUCTURAL CHECK (roborev 63069). The paragraph above is right
  // that a runtime assertion cannot prove a negative about a parameter that does not exist — which
  // is the argument for moving the guard to the type level, not for dropping it. Deleting the two
  // vacuous assertions left the header's "THE PAT IS NEVER HERE… nothing in this component renders,
  // logs, accepts or can reach it" asserting a property that nothing enforced: adding `chiefPat:
  // string` to the props and destructuring it would leave every test AND typecheck green.
  //
  // The prop surface is statically knowable and CI already runs `pnpm -r typecheck`, so this line is
  // enforced on every PR. It fails to COMPILE the moment a third prop appears — `keyof Props` widens
  // and stops being assignable — which is exactly the refactor the deleted test pretended to catch.
  // Note it is a compile-time guard, so `mutation-check` cannot judge it; the check IS the
  // assignment, and the `expect` below only exists to keep it inside a case a reader will find.
  it("declares exactly two props, neither of which could carry the token", () => {
    type PickerProps = Parameters<typeof ChiefBindingPicker>[0];
    const propSurface: "projectId" | "loadChiefProjects" = null as unknown as keyof PickerProps;
    expect(propSurface).toBeNull();
  });

  it("invokes the loader with NO arguments — the component has nothing to hand it", async () => {
    const load = vi.fn(async () => CATALOG);
    await renderPicker(load);

    // Deliberately the whole ARGUMENT LIST, not `toHaveBeenCalled()`. A refactor that threaded a
    // token, a `ChiefClient`, or the filter string through this seam lands right here.
    expect(load.mock.calls).toEqual([[]]);
  });

  it("does not refetch while the human types or clicks — the 348-project fetch happens once", async () => {
    const load = vi.fn(async () => bigCatalog());
    await renderPicker(load);
    expect(load).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByTestId("chief-binding-filter"), { target: { value: "Need" } });
    fireEvent.change(screen.getByTestId("chief-binding-filter"), { target: { value: "Needle" } });
    fireEvent.click(screen.getByTestId("chief-binding-toggle-prj_300"));

    // Filtering is CLIENT-side over a catalog fetched once. Were it server-side the loader would
    // need the needle as an argument — the shape the test above refuses — and every keystroke would
    // re-fetch 348 projects. The binding write proves the component still works after the filtering,
    // so "it never refetched" can't be satisfied by it having stopped working.
    expect(load).toHaveBeenCalledTimes(1);
    expect(stored().chiefProjectIds).toEqual(["prj_300"]);
  });
});
