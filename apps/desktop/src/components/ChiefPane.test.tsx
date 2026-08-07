// @vitest-environment jsdom
//
// The Chief settings pane (sparkle-ojgvp). What is pinned here is the pane's two jobs, both of
// which the app previously could not do at all: SAY WHY the sync is not running, and SAY WHERE it
// is running to. The second is what makes a split library — two Sparkle projects each auto-linked
// to their own Chief project by name matching, each holding half the docs — visible at all.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listProjects = vi.fn();
vi.mock("../services/chief", () => ({ listProjects: (...a: unknown[]) => listProjects(...a) }));

import { ChiefPane } from "./ChiefPane";
import { useSettingsStore } from "../stores/settingsStore";
import { useProjectStore } from "../stores/projectStore";
import { useChiefSyncStore, __resetChiefSyncStore } from "../stores/chiefSyncStore";

const PROJECTS = [
  { project_id: "chief_desktop", name: "sparkle-desktop" },
  { project_id: "chief_sparkle", name: "sparkle" },
];

/** Seed two Sparkle projects so the split-library case is representable. */
function seedProjects() {
  const add = useProjectStore.getState().addProject;
  return { a: add("sparkle", "/root/a"), b: add("sparkle-desktop", "/root/b") };
}

beforeEach(() => {
  listProjects.mockReset();
  listProjects.mockResolvedValue(PROJECTS);
  __resetChiefSyncStore();
  useProjectStore.setState({ projects: [] });
  useSettingsStore.setState({
    keychainChiefPat: "pat_x",
    chiefPat: "",
    runtimeChiefPat: "",
    chiefProjectByProject: {},
    chiefDocStateByProject: {},
  });
});
afterEach(cleanup);

describe("ChiefPane", () => {
  it("says nothing is being sent, and why, when there is no PAT", () => {
    useSettingsStore.setState({ keychainChiefPat: "", chiefPat: "", runtimeChiefPat: "" });
    seedProjects();
    render(<ChiefPane />);
    expect(screen.getByText(/No Chief API key is configured/i)).toBeTruthy();
    // With no key there is nothing to list — asking would be a guaranteed-failing request.
    expect(listProjects).not.toHaveBeenCalled();
  });

  it("shows a DISTINCT reason per project rather than one blanket state", async () => {
    const { a, b } = seedProjects();
    useChiefSyncStore.getState().noteBlocked(a, "project_gone", "gone");
    useChiefSyncStore.getState().noteSuccess(b, {
      chiefProjectId: "chief_desktop",
      uploaded: 3,
      deleted: 1,
    });

    render(<ChiefPane />);

    expect(screen.getByTestId(`chief-status-${a}`).textContent).toMatch(/no longer exists/i);
    expect(screen.getByTestId(`chief-status-${b}`).textContent).toMatch(/wrote 3/);
    await waitFor(() => expect(listProjects).toHaveBeenCalledWith("pat_x"));
  });

  it("names WHICH Chief library each project writes to — the split made visible", async () => {
    const { a, b } = seedProjects();
    useSettingsStore.setState({
      chiefProjectByProject: { [a]: "chief_sparkle", [b]: "chief_desktop" },
    });

    render(<ChiefPane />);

    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    const selA = (await screen.findByTestId(`chief-link-${a}`)) as HTMLSelectElement;
    const selB = (await screen.findByTestId(`chief-link-${b}`)) as HTMLSelectElement;
    await waitFor(() => expect(selA.value).toBe("chief_sparkle"));
    expect(selB.value).toBe("chief_desktop");
  });

  it("re-points a project onto another library and drops the outgoing ledger", async () => {
    const { a } = seedProjects();
    useSettingsStore.setState({
      chiefProjectByProject: { [a]: "chief_sparkle" },
      chiefDocStateByProject: { chief_sparkle: { "PRD/x.md": { hash: "h", assetId: "old" } } },
    });

    render(<ChiefPane />);
    const sel = (await screen.findByTestId(`chief-link-${a}`)) as HTMLSelectElement;
    await waitFor(() => expect(sel.disabled).toBe(false));
    fireEvent.change(sel, { target: { value: "chief_desktop" } });

    expect(useSettingsStore.getState().chiefProjectByProject[a]).toBe("chief_desktop");
    // Asset ids from the old library must not survive the move.
    expect(useSettingsStore.getState().chiefDocStateByProject["chief_sparkle"]).toBeUndefined();
  });

  it("keeps a DELETED link selectable instead of silently rendering as unlinked", async () => {
    // The case the founder will hit after consolidating two libraries: the stored id is not in the
    // listing any more. Falling back to the empty option would hide the exact state they came to fix.
    const { a } = seedProjects();
    useSettingsStore.setState({ chiefProjectByProject: { [a]: "chief_deleted" } });

    render(<ChiefPane />);

    const sel = (await screen.findByTestId(`chief-link-${a}`)) as HTMLSelectElement;
    await waitFor(() => expect(sel.value).toBe("chief_deleted"));
    expect(screen.getByText(/no longer exists/i)).toBeTruthy();
  });

  it("unlinks when the empty option is chosen", async () => {
    const { a } = seedProjects();
    useSettingsStore.setState({ chiefProjectByProject: { [a]: "chief_sparkle" } });

    render(<ChiefPane />);
    const sel = (await screen.findByTestId(`chief-link-${a}`)) as HTMLSelectElement;
    await waitFor(() => expect(sel.disabled).toBe(false));
    fireEvent.change(sel, { target: { value: "" } });

    expect(useSettingsStore.getState().chiefProjectByProject[a]).toBeUndefined();
  });

  it("a failed listing reports the error, keeps the picker USABLE, and does not cry 'deleted'", async () => {
    // roborev caught the first version of this test passing BECAUSE of a bug: the only element
    // carrying the stored id was an option mislabelled "no longer exists", so asserting the value
    // was satisfied by the defect. All three assertions below are now on distinct behaviours.
    const { a } = seedProjects();
    useSettingsStore.setState({ chiefProjectByProject: { [a]: "chief_sparkle" } });
    listProjects.mockRejectedValue(new Error("Load failed"));

    render(<ChiefPane />);

    expect(await screen.findByText(/Could not load your Chief projects/i)).toBeTruthy();
    const sel = (await screen.findByTestId(`chief-link-${a}`)) as HTMLSelectElement;
    expect(sel.value).toBe("chief_sparkle");
    // A failed listing says nothing about whether the link still exists — claiming it was deleted
    // is both false and alarming.
    expect(screen.queryByText(/no longer exists/i)).toBeNull();
    // And the pane must stay usable on exactly the path a user opens it to fix.
    await waitFor(() => expect(sel.disabled).toBe(false));
  });

  it("marks a library another project already uses, and refuses to double-link it", async () => {
    // Sharing one library is MUTUALLY DESTRUCTIVE under the current-state model: each project
    // deletes the other's docs every round. The option is disabled so the store's refusal is never
    // a silent no-op on something the UI offered.
    const { a, b } = seedProjects();
    useSettingsStore.setState({ chiefProjectByProject: { [b]: "chief_desktop" } });

    render(<ChiefPane />);
    const sel = (await screen.findByTestId(`chief-link-${a}`)) as HTMLSelectElement;
    await waitFor(() => expect(sel.disabled).toBe(false));
    const claimed = Array.from(sel.options).find((o) => o.value === "chief_desktop")!;
    expect(claimed.disabled).toBe(true);
    expect(claimed.textContent).toMatch(/already used by sparkle-desktop/i);

    fireEvent.change(sel, { target: { value: "chief_desktop" } });
    expect(useSettingsStore.getState().chiefProjectByProject[a]).toBeUndefined();
    expect(useSettingsStore.getState().chiefProjectByProject[b]).toBe("chief_desktop");
  });

  it("a REFUSED change leaves the existing reason intact instead of faking a clean slate", async () => {
    // The pane clears the sync record on a successful re-link so a fixed problem stops being
    // asserted. On a REFUSED one it must not: erasing a real project_gone and replacing it with an
    // honest-looking zero-state is worse than the stale reason, because nothing is wrong-looking.
    const { a, b } = seedProjects();
    useSettingsStore.setState({
      chiefProjectByProject: { [a]: "chief_deleted", [b]: "chief_desktop" },
    });
    useChiefSyncStore.getState().noteBlocked(a, "project_gone", "gone");

    render(<ChiefPane />);
    const sel = (await screen.findByTestId(`chief-link-${a}`)) as HTMLSelectElement;
    await waitFor(() => expect(sel.disabled).toBe(false));
    fireEvent.change(sel, { target: { value: "chief_desktop" } }); // claimed by b -> refused

    expect(useSettingsStore.getState().chiefProjectByProject[a]).toBe("chief_deleted");
    expect(screen.getByTestId(`chief-status-${a}`).textContent).toMatch(/no longer exists/i);
  });

  it("stops asserting project_gone the moment the user re-links", async () => {
    const { a } = seedProjects();
    useSettingsStore.setState({ chiefProjectByProject: { [a]: "chief_deleted" } });
    useChiefSyncStore.getState().noteBlocked(a, "project_gone", "gone");
    expect(screen.queryByText(/no longer exists/i)).toBeNull(); // nothing rendered yet

    render(<ChiefPane />);
    expect(screen.getByTestId(`chief-status-${a}`).textContent).toMatch(/no longer exists/i);

    const sel = (await screen.findByTestId(`chief-link-${a}`)) as HTMLSelectElement;
    await waitFor(() => expect(sel.disabled).toBe(false));
    fireEvent.change(sel, { target: { value: "chief_desktop" } });

    // Without forgetChiefSync the line would keep accusing the link for up to an hour after the
    // user performed the exact fix this pane exists to offer.
    await waitFor(() =>
      expect(screen.getByTestId(`chief-status-${a}`).textContent).not.toMatch(/no longer exists/i),
    );
  });
});
