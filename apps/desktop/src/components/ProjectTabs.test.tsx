// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectTabs, pinTitle, tabPriority } from "./ProjectTabs";

const projects = [
  { id: "sparkle", name: "sparkle" },
  { id: "website", name: "drodio-website" },
];

afterEach(() => {
  cleanup();
  // The stylesheet is injected into the shared jsdom <head> and persists across tests; remove it so
  // the "injected exactly once" test genuinely exercises the dedupe guard from a clean slate.
  document.getElementById("concierge-tabs-styles")?.remove();
});

function renderTabs(overrides: Partial<Parameters<typeof ProjectTabs>[0]> = {}) {
  const onSelect = vi.fn();
  const onTogglePin = vi.fn();
  const onAddProject = vi.fn();
  render(
    <ProjectTabs
      projects={projects}
      selectedProjectId="sparkle"
      pinnedProjectId={null}
      countsByProject={{}}
      onSelect={onSelect}
      onTogglePin={onTogglePin}
      onAddProject={onAddProject}
      {...overrides}
    />,
  );
  return { onSelect, onTogglePin, onAddProject };
}

describe("pure helpers", () => {
  it("pinTitle describes the action (pin vs unpin)", () => {
    expect(pinTitle(false)).toMatch(/disregard all other project alerts/i);
    expect(pinTitle(true)).toMatch(/across all projects again/i);
  });
  it("tabPriority: p0 beats p1 beats null", () => {
    expect(tabPriority(undefined)).toBeNull();
    expect(tabPriority({ p0: 0, p1: 0 })).toBeNull();
    expect(tabPriority({ p0: 0, p1: 2 })).toBe("p1");
    expect(tabPriority({ p0: 1, p1: 2 })).toBe("p0");
  });
});

describe("ProjectTabs", () => {
  it("renders a tab per project and marks the selected one", () => {
    renderTabs();
    expect(screen.getByTestId("tab-sparkle").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("tab-website").getAttribute("aria-selected")).toBe("false");
  });

  it("clicking a tab selects that project", () => {
    const { onSelect } = renderTabs();
    fireEvent.click(screen.getByTestId("tab-website"));
    expect(onSelect).toHaveBeenCalledWith("website");
  });

  it("clicking the pin toggles pin and does NOT select the tab", () => {
    const { onSelect, onTogglePin } = renderTabs();
    fireEvent.click(screen.getByTestId("pin-website"));
    expect(onTogglePin).toHaveBeenCalledWith("website");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows a P0 count badge when a project has P0 work", () => {
    renderTabs({ countsByProject: { website: { p0: 2, p1: 1 } } });
    expect(screen.getByTestId("count-website").textContent).toContain("2·P0");
  });

  it("shows a P1 badge when there is P1 but no P0", () => {
    renderTabs({ countsByProject: { website: { p0: 0, p1: 3 } } });
    expect(screen.getByTestId("count-website").textContent).toContain("3·P1");
  });

  it("shows no badge when a project is calm", () => {
    renderTabs({ countsByProject: { sparkle: { p0: 0, p1: 0 } } });
    expect(screen.queryByTestId("count-sparkle")).toBeNull();
  });

  it("renders the add-project button and the top-right cluster", () => {
    const { onAddProject } = renderTabs({ topRight: <div data-testid="kebab" /> });
    fireEvent.click(screen.getByTestId("tab-add"));
    expect(onAddProject).toHaveBeenCalled();
    expect(screen.queryByTestId("kebab")).not.toBeNull();
  });

  it("marks the pinned project's pin visible (data-pinned) and others not", () => {
    renderTabs({ pinnedProjectId: "website" });
    expect(screen.getByTestId("pin-website").getAttribute("data-pinned")).toBe("true");
    expect(screen.getByTestId("pin-sparkle").getAttribute("data-pinned")).toBe("false");
  });

  it("injects the hover-reveal stylesheet exactly once", () => {
    renderTabs();
    renderTabs(); // a second mount must not duplicate the <style>
    expect(document.querySelectorAll("#concierge-tabs-styles").length).toBe(1);
    // the reveal is CSS-driven, not inline opacity (the inline-opacity bug that hid pins on hover).
    expect(document.getElementById("concierge-tabs-styles")!.textContent).toMatch(/:hover .concierge-tab-pin/);
  });

  it("is keyboard-operable: Enter on a tab selects it", () => {
    const { onSelect } = renderTabs();
    fireEvent.keyDown(screen.getByTestId("tab-website"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("website");
  });
});
