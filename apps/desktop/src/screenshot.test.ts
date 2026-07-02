// showCaptureWindow is a cross-worker contract (plan Task 2 ⇄ Task 1): the invoke arg must be
// `{ shot: { path, dataUrl } }` — CaptureShot in capture_window.rs is serde camelCase.
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn((..._a: unknown[]) => Promise.resolve<unknown>(null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

beforeEach(() => vi.clearAllMocks());

describe("showCaptureWindow", () => {
  it("invokes show_capture_window with the camelCase shot payload", async () => {
    const { showCaptureWindow } = await import("./screenshot");
    await showCaptureWindow({ path: "/tmp/s.png", dataUrl: "data:image/png;base64,AAA" });
    expect(invoke).toHaveBeenCalledWith("show_capture_window", {
      shot: { path: "/tmp/s.png", dataUrl: "data:image/png;base64,AAA" },
    });
  });
});

describe("captureScreenRegion", () => {
  it("maps the snake_case wire shape and passes null (Esc) through", async () => {
    const { captureScreenRegion } = await import("./screenshot");
    invoke.mockResolvedValueOnce({ path: "/tmp/s.png", data_url: "data:image/png;base64,AAA" });
    expect(await captureScreenRegion()).toEqual({ path: "/tmp/s.png", dataUrl: "data:image/png;base64,AAA" });
    invoke.mockResolvedValueOnce(null);
    expect(await captureScreenRegion()).toBeNull();
  });
});
