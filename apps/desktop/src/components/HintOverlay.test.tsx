// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HintOverlay } from "./HintOverlay";

// jsdom gives every element a 0×0 rect and a null offsetParent, which our visibility filter would
// reject. Stub both so tagged controls count as on-screen during the test.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10, y: 10, top: 10, left: 10, right: 50, bottom: 30, width: 40, height: 20,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return document.body;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // restoreAllMocks doesn't undo defineProperty; delete the stubbed accessor.
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetParent;
});

// A clean Control tap = Control keydown then keyup with nothing in between (the default trigger).
function controlTap() {
  fireEvent.keyDown(window, { key: "Control" });
  fireEvent.keyUp(window, { key: "Control" });
}

describe("HintOverlay", () => {
  it("shows no chiclets until a clean Control tap", () => {
    render(
      <>
        <button data-hint="think" onClick={() => {}}>Think</button>
        <HintOverlay />
      </>,
    );
    expect(screen.queryByText("t")).toBeNull();
    controlTap();
    expect(screen.getByText("t")).toBeTruthy();
  });

  it("numbers agent rows by order and fires the target's click on its label key", async () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    render(
      <>
        <div data-hint="agent" onClick={onFirst}>Agent one</div>
        <div data-hint="agent" onClick={onSecond}>Agent two</div>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();

    fireEvent.keyDown(window, { key: "2" });
    await waitFor(() => expect(onSecond).toHaveBeenCalledTimes(1));
    expect(onFirst).not.toHaveBeenCalled();
    // Overlay dismisses after activation.
    await waitFor(() => expect(screen.queryByText("2")).toBeNull());
  });

  it("a second Control tap dismisses without activating anything", () => {
    const onClick = vi.fn();
    render(
      <>
        <button data-hint="build" onClick={onClick}>Build</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("b")).toBeTruthy();
    controlTap();
    expect(screen.queryByText("b")).toBeNull();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("Escape dismisses the overlay", () => {
    render(
      <>
        <button data-hint="changelog" onClick={() => {}}>Changelog</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    expect(screen.getByText("c")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("c")).toBeNull();
  });

  it("does not spuriously open when focus is lost mid-tap (Ctrl held, then app switch)", () => {
    render(
      <>
        <button data-hint="think" onClick={() => {}}>Think</button>
        <HintOverlay />
      </>,
    );
    // Control pressed, then the app loses focus before we ever see a chord (the OS swallows the
    // switch key), then focus returns and Control is released. The blur must have cleared the
    // latent tap candidate so the release doesn't fire a spurious tap.
    fireEvent.keyDown(window, { key: "Control" });
    fireEvent.blur(window);
    fireEvent.keyUp(window, { key: "Control" });
    expect(screen.queryByText("t")).toBeNull();
  });

  it("an unassigned key is a no-op and keeps the overlay open", () => {
    render(
      <>
        <button data-hint="think" onClick={() => {}}>Think</button>
        <HintOverlay />
      </>,
    );
    controlTap();
    fireEvent.keyDown(window, { key: "z" }); // no chiclet uses "z"
    expect(screen.getByText("t")).toBeTruthy(); // still open
  });
});
