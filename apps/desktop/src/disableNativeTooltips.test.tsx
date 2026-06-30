// @vitest-environment jsdom
//
// Covers the global native-tooltip kill-switch: a capture-phase `mouseover` listener that strips
// `title=` from the hovered element AND its ancestors before the webview can show the OS tooltip,
// while preserving the accessible name for icon-only controls.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disableNativeTooltips } from "./disableNativeTooltips";

// One listener per call; jsdom has no removeAllListeners, so register once and reuse across tests.
beforeEach(() => {
  document.body.innerHTML = "";
});
let installed = false;
function install() {
  if (!installed) {
    disableNativeTooltips();
    installed = true;
  }
}
afterEach(() => {
  document.body.innerHTML = "";
});

function hover(el: Element) {
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
}

describe("disableNativeTooltips", () => {
  it("strips title from the hovered element", () => {
    install();
    const btn = document.createElement("button");
    btn.setAttribute("title", "Zoom in");
    btn.textContent = "+";
    document.body.appendChild(btn);

    hover(btn);
    expect(btn.hasAttribute("title")).toBe(false);
  });

  it("strips title from an ancestor when a child is hovered", () => {
    install();
    const parent = document.createElement("div");
    parent.setAttribute("title", "Parent tip");
    const child = document.createElement("span");
    child.textContent = "x";
    parent.appendChild(child);
    document.body.appendChild(parent);

    hover(child);
    expect(parent.hasAttribute("title")).toBe(false);
  });

  it("preserves an icon-only control's name by moving title → aria-label", () => {
    install();
    // No text, no aria-label: the title IS the accessible name.
    const btn = document.createElement("button");
    btn.setAttribute("title", "Close");
    document.body.appendChild(btn);

    hover(btn);
    expect(btn.hasAttribute("title")).toBe(false);
    expect(btn.getAttribute("aria-label")).toBe("Close");
  });

  it("does NOT add aria-label when the control already has a name", () => {
    install();
    const btn = document.createElement("button");
    btn.setAttribute("title", "Zoom out (⌘−)");
    btn.textContent = "Zoom out"; // visible text already names it
    document.body.appendChild(btn);

    hover(btn);
    expect(btn.hasAttribute("title")).toBe(false);
    expect(btn.hasAttribute("aria-label")).toBe(false);
  });
});
