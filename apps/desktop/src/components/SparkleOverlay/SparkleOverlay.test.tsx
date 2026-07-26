// @vitest-environment jsdom
//
// Component-level behavior: the flag gate (hard no-op when off), the controller surface
// (setState/hear/reply/dismiss), orb-text visibility per state, presize-before-typing,
// the click-anywhere dismiss, and the reduced-motion caret branch. jsdom has no 2d
// canvas, so the paint loop self-disables — exactly the pure-logic surface under test;
// pixels are never asserted (the particle math is covered in engine.test.ts).
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SparkleOverlay,
  useSparkleOverlayController,
  type SparkleOverlayController,
} from "./SparkleOverlay";

function renderOverlay(extra: Partial<Parameters<typeof SparkleOverlay>[0]> = {}) {
  let controller: SparkleOverlayController | null = null;
  const utils = render(
    <SparkleOverlay
      enabled
      controllerRef={(c) => {
        controller = c;
      }}
      {...extra}
    />,
  );
  if (!controller) throw new Error("controller never attached");
  return { ...utils, controller: controller as SparkleOverlayController };
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // Tests that stub matchMedia restore jsdom's default (absent).
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("feature flag gate", () => {
  it("renders NOTHING when the flag is off (default env)", () => {
    const { container } = render(<SparkleOverlay />);
    expect(container.firstChild).toBeNull();
    expect($("[data-sparkle-overlay]")).toBeNull();
  });

  it("mounts when explicitly enabled", () => {
    renderOverlay();
    expect($("[data-sparkle-overlay]")).not.toBeNull();
  });
});

describe("controller state machine", () => {
  it("starts at perch/still with no veil and a hidden bubble", () => {
    renderOverlay();
    const root = $("[data-sparkle-overlay]")!;
    expect(root.dataset.anchor).toBe("perch");
    expect(root.dataset.mode).toBe("still");
    expect($("[data-sparkle-veil]")).toBeNull();
    expect($("[data--text]")!.style.display).toBe("none");
  });

  it("setState drives anchor/mode; the dim veil exists ONLY front-and-center", () => {
    const { controller } = renderOverlay();
    act(() => controller.setState("center", "speaking"));
    const root = $("[data-sparkle-overlay]")!;
    expect(root.dataset.anchor).toBe("center");
    expect(root.dataset.mode).toBe("speaking");
    expect($("[data-sparkle-veil]")).not.toBeNull();
    expect($("[data--text]")!.style.display).toBe("flex");

    act(() => controller.setState("card", "still"));
    expect($("[data-sparkle-veil]")).toBeNull();
    expect($("[data--text]")!.style.display).toBe("flex");

    act(() => controller.setState("perch", "still"));
    expect($("[data--text]")!.style.display).toBe("none");
  });

  it("shows the bubble at perch only while listening (what you say prints below the bar)", () => {
    const { controller } = renderOverlay();
    act(() => controller.setState("perch", "listening"));
    expect($("[data--text]")!.style.display).toBe("flex");
    act(() => controller.setState("perch", "still"));
    expect($("[data--text]")!.style.display).toBe("none");
  });

  it("renders the motionless infused glow over an injected card rect on 'card'", () => {
    const { controller } = renderOverlay({
      getCardRect: () => ({ left: 300, top: 200, width: 230, height: 90 }),
    });
    expect($("[data-sparkle-overlay] div[style*='box-shadow']")).toBeNull();
    act(() => controller.setState("card", "still"));
    const glow = $("[data-sparkle-overlay] div[style*='box-shadow']");
    expect(glow).not.toBeNull();
    expect(glow!.style.left).toBe("300px");
    expect(glow!.style.width).toBe("230px");
  });
});

describe("hear / reply typing", () => {
  it("hear presizes FIRST (locked box, emptied) and then streams the text in", async () => {
    vi.useFakeTimers();
    const { controller } = renderOverlay();
    act(() => controller.setState("perch", "listening"));
    const heard = $("[data-sparkle-heard]")!;
    const p = controller.hear("How are my agents doing?");
    // Presize already ran synchronously: box locked + emptied before the first tick.
    expect(heard.style.display).toBe("block");
    expect(heard.style.minWidth).not.toBe("");
    expect(heard.style.minHeight).not.toBe("");
    expect(heard.textContent).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await p;
    expect(heard.textContent).toBe("How are my agents doing?");
  });

  it("reply types with a blinking caret mid-stream, then resolves with full text", async () => {
    vi.useFakeTimers();
    const { controller } = renderOverlay();
    act(() => controller.setState("center", "speaking"));
    const reply = $("[data-sparkle-reply]")!;
    const p = controller.reply("Hey DROdio");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(26); // one tick: partial text + caret
    });
    expect(reply.textContent!.length).toBeGreaterThan(0);
    const caret = reply.querySelector("span")!;
    expect(caret).not.toBeNull();
    expect(caret.style.animation).toContain("sparkle-caret-blink");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await p;
    expect(reply.textContent).toBe("Hey DROdio");
    expect(reply.querySelector("span")).toBeNull(); // caret gone once typing ends
  });

  it("a superseded run RESOLVES (never hangs) and stops writing", async () => {
    vi.useFakeTimers();
    const { controller } = renderOverlay();
    act(() => controller.setState("center", "speaking"));
    const p = controller.reply("This reply gets dismissed midway through typing");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(52);
    });
    act(() => controller.dismiss());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await expect(p).resolves.toBeUndefined();
    expect($("[data-sparkle-reply]")!.textContent).toBe("");
  });
});

describe("reduced motion", () => {
  it("drops the caret blink when prefers-reduced-motion is set", async () => {
    (window as { matchMedia?: unknown }).matchMedia = (query: string) =>
      ({ matches: true, media: query }) as MediaQueryList;
    vi.useFakeTimers();
    const { controller } = renderOverlay();
    act(() => controller.setState("center", "speaking"));
    const p = controller.reply("Hey DROdio");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(26);
    });
    const caret = $("[data-sparkle-reply]")!.querySelector("span")!;
    expect(caret).not.toBeNull();
    expect(caret.style.animation).toBe("");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await p;
  });
});

describe("dismiss", () => {
  it("controller.dismiss returns home motionless and clears the bubble", () => {
    const { controller } = renderOverlay();
    act(() => controller.setState("center", "listening"));
    act(() => controller.dismiss());
    const root = $("[data-sparkle-overlay]")!;
    expect(root.dataset.anchor).toBe("perch");
    expect(root.dataset.mode).toBe("still");
    expect($("[data--text]")!.style.display).toBe("none");
  });

  it("click anywhere dismisses while out front (and notifies), but never at the perch", () => {
    const onDismiss = vi.fn();
    const { controller } = renderOverlay({ onDismiss });
    act(() => controller.setState("perch", "listening"));
    act(() => {
      fireEvent.pointerDown(document.body);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    expect($("[data-sparkle-overlay]")!.dataset.mode).toBe("listening");

    act(() => controller.setState("center", "speaking"));
    act(() => {
      fireEvent.pointerDown(document.body);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect($("[data-sparkle-overlay]")!.dataset.anchor).toBe("perch");
    expect($("[data-sparkle-overlay]")!.dataset.mode).toBe("still");
  });
});

describe("useSparkleOverlayController", () => {
  it("no-ops safely before the overlay attaches (flag off ⇒ callers never crash)", async () => {
    function Probe() {
      const sparkle = useSparkleOverlayController();
      // Overlay intentionally NOT rendered — the flag-off world.
      return (
        <button
          data-testid="probe"
          onClick={() => {
            sparkle.setState("center", "speaking");
            void sparkle.hear("hi");
            void sparkle.reply("there");
            sparkle.dismiss();
          }}
        >
          {sparkle.getState().anchor}
        </button>
      );
    }
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("probe").textContent).toBe("perch");
    fireEvent.click(getByTestId("probe")); // must not throw
  });

  it("forwards to the mounted overlay through .ref", () => {
    function Host() {
      const sparkle = useSparkleOverlayController();
      return (
        <>
          <SparkleOverlay enabled controllerRef={sparkle.ref} />
          <button
            data-testid="go"
            onClick={() => sparkle.setState("card", "speaking")}
          />
        </>
      );
    }
    const { getByTestId } = render(<Host />);
    fireEvent.click(getByTestId("go"));
    expect($("[data-sparkle-overlay]")!.dataset.anchor).toBe("card");
    expect($("[data-sparkle-overlay]")!.dataset.mode).toBe("speaking");
  });
});
