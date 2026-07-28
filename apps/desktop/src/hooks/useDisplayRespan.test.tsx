// @vitest-environment jsdom
//
// The auto-respan gates. This hook paints no UI and fails invisibly, so nothing else would catch a
// regression here — and both of its conditions encode a decision that is easy to "simplify" away:
// re-spanning on ANY display change would resize windows the user deliberately sized small.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const listen = vi.fn();
const spanWindow = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({ listen: (...a: unknown[]) => listen(...a) }));
vi.mock("../services/displaySpan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/displaySpan")>();
  return {
    ...actual,
    spanWindow: (...a: unknown[]) => spanWindow(...a),
    // Capture the handler the hook registers so the test can fire a display change directly.
    onDisplaysChanged: (handler: () => void) => {
      fired = handler;
      return Promise.resolve(() => {});
    },
  };
});

import { useDisplayRespan } from "./useDisplayRespan";
import { useSettingsStore } from "../stores/settingsStore";

let fired: (() => void) | null = null;

function Harness() {
  useDisplayRespan();
  return null;
}

beforeEach(() => {
  fired = null;
  spanWindow.mockReset();
  spanWindow.mockResolvedValue({ x: 0, y: 0, width: 1, height: 1 });
  useSettingsStore.setState({
    windowAutoRespan: true,
    windowIsSpanned: true,
    windowSpanMode: "safe",
  });
});

afterEach(cleanup);

describe("useDisplayRespan", () => {
  it("re-spans when the preference is on and the window is spanned", () => {
    render(<Harness />);
    fired?.();
    expect(spanWindow).toHaveBeenCalledWith("safe");
  });

  it("passes the CURRENT span mode, not the one at mount", () => {
    render(<Harness />);
    // The hook subscribes once and reads the store at fire time; a stale closure here would silently
    // re-span with the wrong rectangle forever.
    useSettingsStore.setState({ windowSpanMode: "full" });
    fired?.();
    expect(spanWindow).toHaveBeenCalledWith("full");
  });

  it("does nothing when the user turned auto-respan off", () => {
    useSettingsStore.setState({ windowAutoRespan: false });
    render(<Harness />);
    fired?.();
    expect(spanWindow).not.toHaveBeenCalled();
  });

  it("does nothing when the window was never spanned", () => {
    // The load-bearing case: attaching a monitor must not stretch a deliberately small window.
    useSettingsStore.setState({ windowIsSpanned: false });
    render(<Harness />);
    fired?.();
    expect(spanWindow).not.toHaveBeenCalled();
  });

  it("does nothing when both gates are off", () => {
    useSettingsStore.setState({ windowAutoRespan: false, windowIsSpanned: false });
    render(<Harness />);
    fired?.();
    expect(spanWindow).not.toHaveBeenCalled();
  });

  it("swallows a failed re-span instead of surfacing an unhandled rejection", async () => {
    spanWindow.mockRejectedValue(new Error("window server said no"));
    render(<Harness />);
    expect(() => fired?.()).not.toThrow();
    // Let the rejection settle; an unhandled one would fail the run.
    await Promise.resolve();
  });
});
