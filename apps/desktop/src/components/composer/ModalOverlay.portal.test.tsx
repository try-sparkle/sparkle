// @vitest-environment jsdom
//
// ModalOverlay must PORTAL to document.body. This is not a styling preference — it is the only
// thing that makes its `zIndex: 1000` mean "above everything".
//
// The backdrop renders inside Composer → AgentPane, and `paneVisibilityStyle` puts `zIndex: 1` on
// every pane root (to keep the active pane above the inert hidden ones). That makes the pane root a
// stacking context, which squashes this whole backdrop — 1000 and all — to layer 1 of the shell.
// Any shell element with a bigger number then punches through a supposedly app-modal dim: the Build
// column's right-edge pull tabs did, and so did the column itself once the overlay pull tab floated
// it out over the terminal (see components/layers.ts).
//
// jsdom cannot compare paint order, so what is pinned here is the mechanism — the node lands
// outside the host subtree. The visual outcome was verified in a real browser: with the portal, a
// lightbox opened from a pane covers both the concierge column and the floated Build column.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModalOverlay } from "./ModalOverlay";

afterEach(cleanup);

describe("ModalOverlay — portaling", () => {
  it("mounts to document.body, not inside its host's stacking context", () => {
    const host = document.createElement("div");
    // The pane root, as paneVisibilityStyle renders it: a stacking context that would otherwise
    // contain — and demote — everything below it.
    host.style.zIndex = "1";
    host.style.position = "absolute";
    host.dataset.testid = "pane-root";
    document.body.appendChild(host);

    render(
      <ModalOverlay onClose={() => {}}>
        <p>lightbox</p>
      </ModalOverlay>,
      { container: host },
    );

    const overlay = screen.getByTestId("modal-overlay");
    expect(overlay.parentElement).toBe(document.body);
    expect(host.contains(overlay)).toBe(false);
    // Still renders its children, and still claims the top layer.
    expect(overlay.style.zIndex).toBe("1000");
    expect(overlay.style.position).toBe("fixed");
    expect(screen.getByText("lightbox")).toBeTruthy();

    host.remove();
  });

  it("still closes on backdrop click and Escape from its portaled position", () => {
    const onClose = vi.fn();
    render(
      <ModalOverlay onClose={onClose}>
        <p>lightbox</p>
      </ModalOverlay>,
    );

    screen.getByTestId("modal-overlay").click();
    expect(onClose).toHaveBeenCalledTimes(1);

    // The key listener is on `window`, so it is unaffected by where the node lives — but a portal
    // is exactly the kind of move that silently breaks event wiring, so pin it.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  // The portal's other edge. Backgrounded panes are hidden with `visibility: hidden`, which
  // INHERITS — so a lightbox left open in one used to go invisible and inert with its pane. A
  // portaled node escapes that inheritance, and a pane switch needs no user click (selectAgent is
  // called from background events), so without the anchor check a stale modal would sit dimming
  // the app over a pane the user can no longer see.
  it("does not paint when its host pane has been hidden", () => {
    const host = document.createElement("div");
    host.style.visibility = "hidden";
    document.body.appendChild(host);

    render(
      <ModalOverlay onClose={() => {}}>
        <p>lightbox</p>
      </ModalOverlay>,
      { container: host },
    );

    expect(screen.queryByTestId("modal-overlay")).toBeNull();
    host.remove();
  });

  it("paints again when its host pane becomes visible", () => {
    const host = document.createElement("div");
    host.style.visibility = "hidden";
    document.body.appendChild(host);

    const { rerender } = render(
      <ModalOverlay onClose={() => {}}>
        <p>lightbox</p>
      </ModalOverlay>,
      { container: host },
    );
    expect(screen.queryByTestId("modal-overlay")).toBeNull();

    host.style.visibility = "visible";
    rerender(
      <ModalOverlay onClose={() => {}}>
        <p>lightbox</p>
      </ModalOverlay>,
    );
    expect(screen.getByTestId("modal-overlay")).toBeTruthy();
    host.remove();
  });

  it("does not close when the panel itself is clicked", () => {
    const onClose = vi.fn();
    render(
      <ModalOverlay onClose={onClose}>
        <button type="button">inside</button>
      </ModalOverlay>,
    );
    screen.getByRole("button", { name: "inside" }).click();
    expect(onClose).not.toHaveBeenCalled();
  });
});
