// @vitest-environment jsdom
// §11 — project tabs are keyboard-switchable through the existing Ctrl-tap hint overlay. The overlay
// finds its targets by scanning for [data-hint] and activates one by firing that element's own
// click, so all this component owes it is the attribute on the element that already selects the tab.
// Kept in its own file rather than appended to ProjectTabs.test.tsx: this tab bar is under active
// concurrent rewrite, and a separate file can't conflict with it.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectTabs } from "./ProjectTabs";
import { PROJECT_TAB_HINT } from "../keyboardHints/hintTargets";

const projects = [
  { id: "sparkle", name: "sparkle" },
  { id: "website", name: "drodio-website" },
];

afterEach(() => {
  cleanup();
  document.getElementById("concierge-tabs-styles")?.remove();
});

function renderTabs() {
  const onSelect = vi.fn();
  render(
    <ProjectTabs
      projects={projects}
      selectedProjectId="sparkle"
      pinnedProjectId={null}
      countsByProject={{}}
      onSelect={onSelect}
      onTogglePin={vi.fn()}
    />,
  );
  return { onSelect };
}

describe("ProjectTabs — keyboard-hint targets", () => {
  it("tags every tab as a hint target", () => {
    renderTabs();
    const tagged = document.querySelectorAll(`[data-hint="${PROJECT_TAB_HINT}"]`);
    expect(tagged.length).toBe(projects.length);
    // The attribute must sit on the TAB itself, not a wrapper — the overlay anchors its badge to the
    // tagged element's rect and clicks that element.
    expect(screen.getByTestId("tab-sparkle").dataset.hint).toBe(PROJECT_TAB_HINT);
    expect(screen.getByTestId("tab-website").dataset.hint).toBe(PROJECT_TAB_HINT);
  });

  it("routes a hint activation through the tab's existing onSelect, not a second path", () => {
    const { onSelect } = renderTabs();
    // Exactly what HintOverlay does on a label keypress: el.click() on the tagged element.
    (screen.getByTestId("tab-website") as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith("website");
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("does not tag the pin or close controls, which would steal the tab's own letter", () => {
    render(
      <ProjectTabs
        projects={projects}
        selectedProjectId="sparkle"
        pinnedProjectId="sparkle"
        countsByProject={{}}
        onSelect={vi.fn()}
        onTogglePin={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    for (const id of ["pin-sparkle", "close-sparkle"]) {
      expect(screen.getByTestId(id).dataset.hint).toBeUndefined();
    }
  });

  it("keeps the add-project button on its own chrome mnemonic, distinct from the tabs", () => {
    render(
      <ProjectTabs
        projects={projects}
        selectedProjectId="sparkle"
        pinnedProjectId={null}
        countsByProject={{}}
        onSelect={vi.fn()}
        onTogglePin={vi.fn()}
        onAddProject={vi.fn()}
      />,
    );
    // "open" is a fixed CHROME_HINTS mnemonic ("o"); it must not join the lettered tab stream.
    expect(screen.getByTestId("tab-add").dataset.hint).toBe("open");
  });
});

// Deliberately NOT asserted here, because it is not this component's job: the letters themselves.
// Which letter a tab gets — and the guarantee that it can never equal an agent row's overflow
// letter — is proved in keyboardHints/hintTargets.test.ts, where the shared stream lives.
// Also note the hint badge does NOT collide with the tab's "needs you" count badge: chiclets render
// into HintOverlay's fixed portal on document.body, a different layer from the tab's own DOM.
