// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { StatusBand } from "../engine/buildSections";
import { ProjectTabs, pinTitle, tabBand, TAB_LABEL_MAX_WIDTH } from "./ProjectTabs";

/** Counts with only the named bands set — a tab takes the full per-band Record. */
function counts(over: Partial<Record<StatusBand, number>> = {}): Record<StatusBand, number> {
  return { needs_you: 0, running: 0, done: 0, ...over };
}

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
  it("tabBand: only Needs-you badges — running and done never do", () => {
    expect(tabBand(undefined)).toBeNull();
    expect(tabBand(counts())).toBeNull();
    expect(tabBand(counts({ needs_you: 1 }))).toBe("needs_you");
    // A tab that glowed while anything was merely working would glow permanently, and a signal
    // that is always on is not a signal.
    expect(tabBand(counts({ running: 4, done: 9 }))).toBeNull();
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

  it("badges a project whose agents need you, agreeing in number", () => {
    renderTabs({ countsByProject: { website: counts({ needs_you: 2, running: 1 }) } });
    expect(screen.getByTestId("count-website").textContent).toBe("2 Need you");
  });

  it("uses the singular verb for exactly one", () => {
    renderTabs({ countsByProject: { website: counts({ needs_you: 1 }) } });
    expect(screen.getByTestId("count-website").textContent).toBe("1 Needs you");
  });

  it("shows no badge for a project that is only running or done", () => {
    renderTabs({ countsByProject: { website: counts({ running: 3, done: 5 }) } });
    expect(screen.queryByTestId("count-website")).toBeNull();
  });

  it("shows no badge when a project is calm", () => {
    renderTabs({ countsByProject: { sparkle: counts() } });
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

// A long folder name used to WRAP, making that one tab two rows tall while its neighbours stayed
// one row — the bar grew and the tabs stopped lining up. Names must ellipsize on a single line.
describe("ProjectTabs — long names truncate rather than wrap", () => {
  const longName = "sparkle-desktop-experimental-rewrite-with-a-very-long-folder-name";

  it("clamps the label to one line with an ellipsis", () => {
    renderTabs({ projects: [{ id: "long", name: longName }] });
    const label = screen.getByTestId("tab-label-long");
    expect(label.style.whiteSpace).toBe("nowrap");
    expect(label.style.textOverflow).toBe("ellipsis");
    expect(label.style.overflow).toBe("hidden");
    expect(label.style.maxWidth).toBe(`${TAB_LABEL_MAX_WIDTH}px`);
  });

  it("keeps the FULL name available on hover, so truncation loses nothing", () => {
    renderTabs({ projects: [{ id: "long", name: longName }] });
    expect(screen.getByTestId("tab-label-long").textContent).toBe(longName);
    expect(screen.getByTestId("tab-long").getAttribute("title")).toContain(longName);
  });

  it("applies the same clamp to short names, so every tab is exactly one row tall", () => {
    renderTabs();
    for (const p of projects) {
      expect(screen.getByTestId(`tab-label-${p.id}`).style.whiteSpace).toBe("nowrap");
    }
  });
});
