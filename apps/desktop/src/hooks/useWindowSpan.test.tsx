// @vitest-environment jsdom
//
// useWindowSpan — the ONE action path for window spanning (bead sparkle-6b96h).
//
// The pane's own tests (components/WindowSpanControls.test.tsx) drive its three buttons. What is
// NOT covered there, and is what this hook added, is:
//   • `toggle()` — the branch selection, and that it reads the CURRENT flag rather than a closure
//     captured at mount;
//   • the PRECONDITIONS. They used to live only in each caller's `disabled` prop, which meant the
//     invariant "windowIsSpanned has one writer that cannot be wrong" depended on every future
//     surface remembering to re-implement it. `span_window` returns Ok under macOS separate Spaces
//     WITHOUT having spanned, so a caller that gets past the gate writes a flag that is a lie, and
//     useDisplayRespan then re-fires spanWindow on every display change.
//
// Every assertion is on the side effect — an invoke that happened, or a store value after the fact.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

const invoke = vi.fn();
const listen = vi.fn<(...a: unknown[]) => unknown>(() => Promise.resolve(() => {}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: (...args: unknown[]) => listen(...args) }));

import { useWindowSpan } from "./useWindowSpan";
import { useSettingsStore } from "../stores/settingsStore";
import type { DisplayLayout } from "../services/displaySpan";

const TWO: DisplayLayout = {
  displays: [
    {
      name: "Color LCD",
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      work_area: { x: 0, y: 25, width: 1512, height: 957 },
      scale_factor: 2,
    },
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
    return Promise.resolve({ x: 0, y: 0, width: 1200, height: 800 });
  });
}

/** Render the hook and wait until the layout has actually been read, so gates are live. */
async function mounted(layout: DisplayLayout) {
  withLayout(layout);
  const h = renderHook(() => useWindowSpan());
  await waitFor(() => expect(h.result.current.displayCount).toBe(layout.displays.length));
  return h;
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

describe("toggle() picks its direction from the CURRENT flag", () => {
  it("spans when the window is not spanned, and records it", async () => {
    const h = await mounted(TWO);

    await act(async () => void (await h.result.current.toggle()));

    expect(invoke).toHaveBeenCalledWith("span_window", { mode: "safe" });
    expect(invoke).not.toHaveBeenCalledWith("fit_window_to_current_display");
    expect(useSettingsStore.getState().windowIsSpanned).toBe(true);
  });

  it("fits when the window IS spanned, and clears the flag", async () => {
    useSettingsStore.setState({ windowIsSpanned: true });
    const h = await mounted(TWO);

    await act(async () => void (await h.result.current.toggle()));

    expect(invoke).toHaveBeenCalledWith("fit_window_to_current_display");
    expect(invoke).not.toHaveBeenCalledWith("span_window", expect.anything());
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });

  // The direction must come from the store on EVERY call. A `toggle` that closed over the value it
  // saw at mount would span twice here and never come back.
  it("flips on the second call rather than repeating the first", async () => {
    const h = await mounted(TWO);

    await act(async () => void (await h.result.current.toggle()));
    await waitFor(() => expect(useSettingsStore.getState().windowIsSpanned).toBe(true));
    invoke.mockClear();
    withLayout(TWO);

    await act(async () => void (await h.result.current.toggle()));

    expect(invoke).toHaveBeenCalledWith("fit_window_to_current_display");
    expect(invoke).not.toHaveBeenCalledWith("span_window", expect.anything());
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });
});

describe("the preconditions are the HOOK's, not each caller's", () => {
  // `span_window` does not consult `spanning_enabled` — it applies the geometry and returns Ok. So
  // without this gate the promise resolves, the flag is written true, and the window never spanned.
  it("refuses to span under macOS separate Spaces, and writes no flag", async () => {
    const h = await mounted({ ...TWO, spanning_enabled: false });

    await act(async () => void (await h.result.current.span()));

    expect(invoke).not.toHaveBeenCalledWith("span_window", expect.anything());
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });

  it("refuses via toggle() too — the gate is not on one entry point", async () => {
    const h = await mounted({ ...TWO, spanning_enabled: false });

    await act(async () => void (await h.result.current.toggle()));

    expect(invoke).not.toHaveBeenCalledWith("span_window", expect.anything());
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });

  // POSITIVE CONTROL: the two refusals above prove nothing unless the same call succeeds when the
  // only thing that changed is the flag they gate on.
  it("spans when separate Spaces is off — only that flag differs", async () => {
    const h = await mounted(TWO);

    await act(async () => void (await h.result.current.span()));

    expect(invoke).toHaveBeenCalledWith("span_window", { mode: "safe" });
    expect(useSettingsStore.getState().windowIsSpanned).toBe(true);
  });

  // Un-spanning works under separate Spaces, and is the only way out of a stranded geometry.
  it("still fits under separate Spaces", async () => {
    useSettingsStore.setState({ windowIsSpanned: true });
    const h = await mounted({ ...TWO, spanning_enabled: false });

    await act(async () => void (await h.result.current.toggle()));

    expect(invoke).toHaveBeenCalledWith("fit_window_to_current_display");
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });

  // GETTING OUT IS NEVER GATED, and this is the case that matters: the header button stays visible
  // and enabled while spanned even with no readable layout, so a gate on `fit` here would make that
  // click a silent no-op — leaving the window at a geometry no display can show while
  // useDisplayRespan keeps re-spanning it. `fit`/`reset` don't consume the layout, so nothing is
  // gained by refusing.
  it("refuses to SPAN with an unreadable layout but still lets the window out", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "display_layout"
        ? Promise.reject(new Error("read monitors: backend gone"))
        : Promise.resolve({ x: 0, y: 0, width: 1200, height: 800 }),
    );
    useSettingsStore.setState({ windowIsSpanned: true });
    const h = renderHook(() => useWindowSpan());
    await waitFor(() => expect(h.result.current.readError).toBeTruthy());
    invoke.mockClear();

    // Spanning needs a layout to be meaningful, and writing the flag off a span that cannot have
    // happened is what arms auto-respan wrongly.
    await act(async () => void (await h.result.current.span()));
    expect(invoke).not.toHaveBeenCalledWith("span_window", expect.anything());
    expect(useSettingsStore.getState().windowIsSpanned).toBe(true);

    // …but the way back must still work, and must clear the flag.
    await act(async () => void (await h.result.current.fit()));
    expect(invoke).toHaveBeenCalledWith("fit_window_to_current_display");
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);

    // BOTH ways back. `reset` lost its gate in the same edit as `fit`, and this is the only
    // assertion in the frontend suite that invokes `reset_window_size` at all — without it,
    // re-introducing `if (noLayout) return` there would keep everything green.
    useSettingsStore.setState({ windowIsSpanned: true });
    await act(async () => void (await h.result.current.reset()));
    expect(invoke).toHaveBeenCalledWith("reset_window_size");
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
  });
});

describe("the flag follows the ACTION, never a measurement", () => {
  it("writes nothing when the action rejects", async () => {
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "display_layout") return Promise.resolve(TWO);
      return Promise.reject(new Error("window server said no"));
    });
    const h = renderHook(() => useWindowSpan());
    await waitFor(() => expect(h.result.current.displayCount).toBe(2));

    await act(async () => void (await h.result.current.span()));

    expect(invoke).toHaveBeenCalledWith("span_window", { mode: "safe" });
    expect(useSettingsStore.getState().windowIsSpanned).toBe(false);
    expect(h.result.current.actionError).toMatch(/window server said no/);
  });

  it("uses the mode from Settings rather than nominating one", async () => {
    useSettingsStore.setState({ windowSpanMode: "full" });
    const h = await mounted(TWO);

    await act(async () => void (await h.result.current.span()));

    expect(invoke).toHaveBeenCalledWith("span_window", { mode: "full" });
    expect(invoke).not.toHaveBeenCalledWith("span_window", { mode: "safe" });
  });
});
