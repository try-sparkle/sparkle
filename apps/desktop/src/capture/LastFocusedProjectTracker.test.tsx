// @vitest-environment jsdom
//
// The writer half of the sparkle-last-focused-project contract (the reader half is covered in
// CaptureApp.test.tsx): the tracker records this window's project on mount when the window is
// already focused, on every subsequent DOM `focus`, and never without a project. Rendered
// inside the real CurrentProjectProvider (jsdom URL has no ?label= → main window; the initial
// project resolves from the seeded store).
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentProjectProvider } from "../windowContext";
import { LastFocusedProjectTracker } from "./LastFocusedProjectTracker";
import { LAST_FOCUSED_PROJECT_KEY, readLastFocusedProject } from "./lastFocusedProject";
import { useProjectStore } from "../stores/projectStore";
import type { Project } from "../types";

const projects = [{ id: "proj-1", name: "Alpha", agents: [] }] as unknown as Project[];

const mount = () =>
  render(
    <CurrentProjectProvider>
      <LastFocusedProjectTracker />
    </CurrentProjectProvider>,
  );

beforeEach(() => {
  localStorage.clear();
  useProjectStore.setState({ projects, selectedProjectId: "proj-1" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LastFocusedProjectTracker", () => {
  it("writes immediately on mount when the window is already focused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mount();
    expect(readLastFocusedProject()).toBe("proj-1");
  });

  it("does not write while unfocused, then writes on the window focus event", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    mount();
    expect(localStorage.getItem(LAST_FOCUSED_PROJECT_KEY)).toBeNull();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(readLastFocusedProject()).toBe("proj-1");
  });

  it("never writes without a current project", () => {
    useProjectStore.setState({ projects: [], selectedProjectId: null });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    mount();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(localStorage.getItem(LAST_FOCUSED_PROJECT_KEY)).toBeNull();
  });

  it("stops writing after unmount (focus listener removed)", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { unmount } = mount();
    unmount();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(localStorage.getItem(LAST_FOCUSED_PROJECT_KEY)).toBeNull();
  });
});
