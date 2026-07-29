// @vitest-environment jsdom
//
// The primitive itself. Deliberately THIN — the assertions that matter for the bug this exists to
// fix are in `ModalLayer.wiring.test.tsx`, which renders the real modal inside the real lifted
// column. This file only pins the two properties that file depends on: the node leaves its host,
// and it stops painting when its host is hidden.
//
// jsdom cannot compare paint order, so what is pinned here is the MECHANISM — where the node lands.
// A test that asserted a z-index instead would have stayed green through the entire defect, because
// every one of those z-indexes was already correct and already ignored.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ModalLayer } from "./ModalLayer";

afterEach(cleanup);

/** A host that is a stacking context, exactly as the shell's lifted containers are: the concierge
 *  column (`position: relative` + `CONCIERGE_LIFT_Z`) and every agent pane root (`zIndex: 1` from
 *  `paneVisibilityStyle`). Anything rendered inside one is confined to that host's single layer. */
function liftedHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.position = "relative";
  host.style.zIndex = "3";
  document.body.appendChild(host);
  return host;
}

describe("ModalLayer", () => {
  it("parents its children to document.body, escaping a lifted host's stacking context", () => {
    const host = liftedHost();

    render(
      <ModalLayer>
        <div data-testid="surface" style={{ position: "fixed", inset: 0, zIndex: 41 }} />
      </ModalLayer>,
      { container: host },
    );

    const surface = screen.getByTestId("surface");
    expect(surface.parentElement).toBe(document.body);
    expect(host.contains(surface)).toBe(false);

    host.remove();
  });

  it("portals every child, so a backdrop + card fragment travels as one", () => {
    const host = liftedHost();

    render(
      <ModalLayer>
        <div data-testid="backdrop" />
        <div data-testid="card" />
      </ModalLayer>,
      { container: host },
    );

    // Both halves must leave together. A modal whose card escapes while its scrim stays behind is
    // worse than one that never escaped: the dim would be trapped under the tab it was meant to
    // cover, and the card would float over an undimmed app.
    expect(screen.getByTestId("backdrop").parentElement).toBe(document.body);
    expect(screen.getByTestId("card").parentElement).toBe(document.body);

    host.remove();
  });

  // The portal's other edge, and the reason this component is more than a one-line `createPortal`.
  // Backgrounded agent panes are NOT unmounted — they are hidden with `visibility: hidden`, which
  // INHERITS. A portaled node escapes that inheritance and would keep dimming the whole app over
  // whatever pane is now active. Reaching that state needs no user click: `selectAgent` fires from
  // background events.
  it("does not paint when its host has been hidden", () => {
    const host = document.createElement("div");
    host.style.visibility = "hidden";
    document.body.appendChild(host);

    render(
      <ModalLayer>
        <div data-testid="surface" />
      </ModalLayer>,
      { container: host },
    );

    expect(screen.queryByTestId("surface")).toBeNull();
    host.remove();
  });

  it("paints again once its host becomes visible", () => {
    const host = document.createElement("div");
    host.style.visibility = "hidden";
    document.body.appendChild(host);

    const { rerender } = render(
      <ModalLayer>
        <div data-testid="surface" />
      </ModalLayer>,
      { container: host },
    );
    expect(screen.queryByTestId("surface")).toBeNull();

    host.style.visibility = "visible";
    rerender(
      <ModalLayer>
        <div data-testid="surface" />
      </ModalLayer>,
    );
    expect(screen.getByTestId("surface")).toBeTruthy();

    host.remove();
  });

  it("leaves nothing behind in the host tree but an out-of-layout anchor", () => {
    // The anchor is how the visibility check above reads the HOST's inherited style, so it has to
    // stay in the original tree — but it must not affect that tree's layout. `display: none` is the
    // whole contract, and a future refactor that gave the anchor a box would push the concierge
    // header around by a stray inline element.
    const host = liftedHost();
    render(
      <ModalLayer>
        <div data-testid="surface" />
      </ModalLayer>,
      { container: host },
    );

    const anchors = Array.from(host.querySelectorAll("span"));
    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.style.display).toBe("none");
    expect(anchor.getAttribute("aria-hidden")).toBe("true");

    host.remove();
  });
});
