// @vitest-environment jsdom
//
// The concierge header's span-all-displays shortcut (bead sparkle-6b96h).
//
// What is worth pinning here is NOT that a button exists — it is that this control is genuinely a
// shortcut to the Settings pane's action rather than a lookalike:
//   • it invokes the SAME backend commands, with the mode the user chose in Settings;
//   • it writes `windowIsSpanned`, the flag `useDisplayRespan` gates on — a shortcut that spanned
//     without it would silently disable auto-respan, and that failure is invisible on screen;
//   • it TOGGLES, and the icon changes with the state;
//   • it does not offer itself when there is nothing to span across.
//
// Every assertion below is on the SIDE EFFECT (an invoke, a store write, a changed icon), never on
// a precondition the component was handed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const invoke = vi.fn();
// `listen` returns whatever THIS says — see the last describe, which is about a subscribe that is
// not a promise at all. Default: the real contract.
const listen = vi.fn<(...a: unknown[]) => unknown>(() => Promise.resolve(() => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listen(...args) }));

import { WindowSpanButton } from "./WindowSpanButton";
import { useSettingsStore } from "../../stores/settingsStore";
import type { DisplayLayout } from "../../services/displaySpan";

const ONE: DisplayLayout = {
  displays: [
    {
      name: "Color LCD",
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      work_area: { x: 0, y: 25, width: 1512, height: 957 },
      scale_factor: 2,
    },
  ],
  safe: { x: 0, y: 25, width: 1512, height: 957 },
  full: { x: 0, y: 25, width: 1512, height: 957 },
  spanning_enabled: true,
};

/** Two displays of different heights — so `safe` and `full` differ and the mode is observable. */
const TWO: DisplayLayout = {
  displays: [
    ...ONE.displays,
    {
      name: "PM161Q J",
      bounds: { x: 1512, y: 0, width: 1920, height: 1080 },
      work_area: { x: 1512, y: 0, width: 1920, height: 1080 },
      scale_factor: 1,
    },
  ],
  safe: { x: 0, y: 25, width: 3432, height: 957 },
  full: { x: 0, y: 0, width: 3432, height: 1080 },
  spanning_enabled: true,
};

function withLayout(layout: DisplayLayout) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "display_layout") return Promise.resolve(layout);
    // Deliberately NOT an echo of the target rect: the flag must follow which ACTION ran, never a
    // comparison of the reply against what was asked for. See WindowSpanControls.test.tsx.
    return Promise.resolve({ x: 0, y: 0, width: 1200, height: 800 });
  });
}

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  listen.mockImplementation(() => Promise.resolve(() => {}));
  useSettingsStore.setState({
    windowSpanMode: "safe",
    windowAutoRespan: true,
    windowIsSpanned: false,
  });
});
afterEach(cleanup);

const button = () => screen.findByTestId("concierge-span-toggle");

describe("the header's span shortcut runs the SAME action as Settings", () => {
  it("spans with the mode the user chose, and records it so auto-respan stays armed", async () => {
    withLayout(TWO);
    render(<WindowSpanButton />);

    await userEvent.click(await button());

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("span_window", { mode: "safe" }));
    // THE FLAG IS THE POINT. `useDisplayRespan` re-fits on a display change only when this is true,
    // so a shortcut that spanned without writing it would look right and silently kill auto-respan.
    expect(useSettingsStore.getState().windowIsSpanned).toBe(true);
  });

  it("uses `full` when that is what Settings says — it never picks its own mode", async () => {
    withLayout(TWO);
    useSettingsStore.setState({ windowSpanMode: "full" });
    render(<WindowSpanButton />);

    await userEvent.click(await button());

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("span_window", { mode: "full" }));
    expect(invoke).not.toHaveBeenCalledWith("span_window", { mode: "safe" });
  });

  it("leaves the flag alone when the span fails, so a window that never moved isn't re-stretched", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "display_layout") return Promise.resolve(TWO);
      return Promise.reject(new Error("window server said no"));
    });
    render(<WindowSpanButton />);

    await userEvent.click(await button());

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("span_window", { mode: "safe" }));
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });
});

describe("it TOGGLES rather than only spanning", () => {
  it("returns the window to the current display when it is already spanned", async () => {
    withLayout(TWO);
    useSettingsStore.setState({ windowIsSpanned: true });
    render(<WindowSpanButton />);

    await userEvent.click(await button());

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fit_window_to_current_display"));
    expect(invoke).not.toHaveBeenCalledWith("span_window", expect.anything());
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });

  it("goes out and back on two clicks of the one control", async () => {
    withLayout(TWO);
    render(<WindowSpanButton />);

    const b = await button();
    await userEvent.click(b);
    await waitFor(() => expect(useSettingsStore.getState().windowIsSpanned).toBe(true));

    await userEvent.click(b);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fit_window_to_current_display"));
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });

  it("shows a DIFFERENT icon and a different name in each state", async () => {
    withLayout(TWO);
    const { unmount } = render(<WindowSpanButton />);
    const out = await button();
    const outIcon = out.querySelector("svg")!.innerHTML;
    const outLabel = out.getAttribute("aria-label");
    expect(out.getAttribute("aria-pressed")).toBe("false");
    unmount();

    useSettingsStore.setState({ windowIsSpanned: true });
    render(<WindowSpanButton />);
    const back = await button();
    expect(back.querySelector("svg")!.innerHTML).not.toBe(outIcon);
    expect(back.getAttribute("aria-label")).not.toBe(outLabel);
    expect(back.getAttribute("aria-pressed")).toBe("true");
    // Both names say what the NEXT click does, which is the founder's "tell at a glance" ask.
    expect(outLabel).toMatch(/span/i);
    expect(back.getAttribute("aria-label")).toMatch(/return/i);
    // Icon only — the header row is deliberately silent (bead sparkle-ircc3).
    expect(back.textContent).toBe("");
  });
});

describe("it does not offer an action that would do nothing", () => {
  it("renders nothing on a single display", async () => {
    withLayout(ONE);
    const { unmount } = render(<WindowSpanButton />);
    // The layout arrives asynchronously, so wait for it to have been READ before concluding
    // absence — otherwise this passes on the first render for the wrong reason.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("display_layout"));
    await waitFor(() => expect(screen.queryByTestId("concierge-span-toggle")).toBeNull());

    // POSITIVE CONTROL, in the same harness: an absence assertion proves nothing unless something
    // could have made it present. Only the display COUNT differs here.
    unmount();
    withLayout(TWO);
    render(<WindowSpanButton />);
    expect(await screen.findByTestId("concierge-span-toggle")).toBeTruthy();
  });

  it("renders nothing when the displays can't be read at all", async () => {
    invoke.mockRejectedValue(new Error("read monitors: backend gone"));
    render(<WindowSpanButton />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("display_layout"));
    await waitFor(() => expect(screen.queryByTestId("concierge-span-toggle")).toBeNull());
  });

  // Unplug a monitor while spanned and the count drops to 1 with the window still at a geometry the
  // remaining display can't show. Hiding on the count alone would take away the only control that
  // undoes that — auto-respan is opt-out, so it cannot be relied on to clear it.
  it("stays mounted on a single display while the window is still spanned", async () => {
    withLayout(ONE);
    useSettingsStore.setState({ windowIsSpanned: true });
    render(<WindowSpanButton />);

    await userEvent.click(await button());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fit_window_to_current_display"));
  });

  // The button is deliberately kept visible while spanned even when the layout can't be read — so
  // the click it offers there has to DO something. A precondition gate on `fit` made this a silent
  // no-op: nothing invoked, no flag cleared, no error shown, while auto-respan kept re-spanning the
  // window the user was trying to bring back. The control must never be a button that lies.
  it("un-spans even when the layout can't be read — the visible button is not a no-op", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "display_layout"
        ? Promise.reject(new Error("read monitors: backend gone"))
        : Promise.resolve({ x: 0, y: 0, width: 1200, height: 800 }),
    );
    useSettingsStore.setState({ windowIsSpanned: true });
    render(<WindowSpanButton />);

    const b = await button();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("display_layout"));
    expect(b.hasAttribute("disabled")).toBe(false);

    await userEvent.click(b);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fit_window_to_current_display"));
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });

  // ── IT MUST NOT BE ABLE TO TAKE ITS HOST DOWN ────────────────────────────────────────────────
  // This control mounts INSIDE the concierge header, so an exception thrown from its subscribe
  // effect unmounts the whole column — every message, the compose box, the lot. That is not
  // hypothetical: `listen` is only contractually a promise, and a surface whose double returns
  // `undefined` turned `.catch` into a TypeError that killed nine tests in
  // ConciergeHost.lintEndToEnd.test.tsx the moment the header grew this button.
  //
  // The sibling renders and asserts the row is still there, which is the actual stake — a bare
  // `render()` that threw would fail on the button lookup alone and wouldn't show that.
  it("survives a subscribe that isn't a promise, and does not take the row with it", async () => {
    withLayout(TWO);
    listen.mockImplementation(() => undefined);
    render(
      <div>
        <WindowSpanButton />
        <span data-testid="sibling">still here</span>
      </div>,
    );
    expect(await button()).toBeTruthy();
    expect(screen.getByTestId("sibling").textContent).toBe("still here");
    // …and it is still a working control, not merely a rendered one.
    await userEvent.click(await button());
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("span_window", { mode: "safe" }));
  });

  it("survives a subscribe that throws outright", async () => {
    withLayout(TWO);
    listen.mockImplementation(() => {
      throw new Error("no event bridge");
    });
    render(
      <div>
        <WindowSpanButton />
        <span data-testid="sibling">still here</span>
      </div>,
    );
    expect(await button()).toBeTruthy();
    expect(screen.getByTestId("sibling").textContent).toBe("still here");
  });

  it("disables itself, and says why, when macOS keeps displays in separate Spaces", async () => {
    withLayout({ ...TWO, spanning_enabled: false });
    render(<WindowSpanButton />);

    const b = await button();
    // The button exists from the first render, so wait for the DISABLED state rather than sampling
    // it — otherwise this asserts the pre-layout default and pins nothing.
    await waitFor(() => expect(b.hasAttribute("disabled")).toBe(true));
    expect(b.getAttribute("title")).toMatch(/separate Spaces/i);
    await userEvent.click(b);
    expect(invoke).not.toHaveBeenCalledWith("span_window", expect.anything());
  });

  // Separate Spaces blocks SPANNING, not un-spanning — and `isSpanned && blockedBySpaces` is
  // reachable, because the macOS setting takes effect on restart with the window already spanned.
  // Disabling on the flag alone would refuse the un-span, stranding the window at a geometry no
  // single display can show while `windowIsSpanned` stays true and auto-respan keeps re-spanning it.
  it("still un-spans under separate Spaces — the block is on the direction, not the control", async () => {
    withLayout({ ...TWO, spanning_enabled: false });
    useSettingsStore.setState({ windowIsSpanned: true });
    render(<WindowSpanButton />);

    const b = await button();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("display_layout"));
    expect(b.hasAttribute("disabled")).toBe(false);
    // The name must describe the un-span it will actually do, not the span it is refusing.
    expect(b.getAttribute("title")).toMatch(/return/i);

    await userEvent.click(b);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fit_window_to_current_display"));
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });
});

describe("a failed action is not silent", () => {
  it("says the attempt failed, instead of rendering exactly as it did before the click", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "display_layout") return Promise.resolve(TWO);
      return Promise.reject(new Error("window server said no"));
    });
    render(<WindowSpanButton />);

    const b = await button();
    const before = b.getAttribute("title");
    await userEvent.click(b);

    // The flag stays false (a span that errored must not arm auto-respan) — but the user has to be
    // able to TELL, and the only surface this control has is its own name.
    await waitFor(() => expect(b.getAttribute("data-error")).toBe("window server said no"));
    expect(b.getAttribute("title")).not.toBe(before);
    expect(b.getAttribute("title")).toMatch(/window server said no/);
    expect(b.getAttribute("aria-label")).toMatch(/window server said no/);
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });
});
