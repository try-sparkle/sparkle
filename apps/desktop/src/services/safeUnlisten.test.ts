import { describe, it, expect, vi } from "vitest";
import { safeUnlisten } from "./safeUnlisten";

// The exact unhandled-rejection text the Tauri teardown race throws (V8 phrasing). The WebKit
// phrasing differs but carries the same `handlerId` token, which is what safeUnlisten matches.
const HANDLER_ID_ERROR = "Cannot read properties of undefined (reading 'handlerId')";

describe("safeUnlisten", () => {
  it("is a no-op for null/undefined", async () => {
    await expect(safeUnlisten(undefined)).resolves.toBeUndefined();
    await expect(safeUnlisten(null)).resolves.toBeUndefined();
  });

  it("calls a plain UnlistenFn", async () => {
    const fn = vi.fn();
    await safeUnlisten(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("awaits and calls a Promise<UnlistenFn>", async () => {
    const fn = vi.fn();
    await safeUnlisten(Promise.resolve(fn));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resolves cleanly when the underlying unlisten throws the handlerId error", async () => {
    const fn = () => {
      throw new Error(HANDLER_ID_ERROR);
    };
    await expect(safeUnlisten(fn)).resolves.toBeUndefined();
  });

  it("swallows the handlerId race even when the listen() promise resolved post-unmount", async () => {
    const fn = () => {
      throw new Error(HANDLER_ID_ERROR);
    };
    await expect(safeUnlisten(Promise.resolve(fn))).resolves.toBeUndefined();
  });

  it("swallows the WebKit phrasing of the same race", async () => {
    const fn = () => {
      throw new Error("undefined is not an object (evaluating 'l.handlerId')");
    };
    await expect(safeUnlisten(fn)).resolves.toBeUndefined();
  });

  // Tauri's real unlisten fn is `async () => _unlisten(event, eventId)`, so the race REJECTS a
  // promise rather than throwing synchronously — even though `UnlistenFn` is typed `() => void`.
  // These pin the async shape. `resolves.toBeUndefined()` alone can't tell "caught" from "escaped"
  // (an un-awaited call resolves cleanly while the rejection leaks), so they assert the swallow
  // actually ran by watching for its debug breadcrumb.
  it("swallows the handlerId race when the unlisten fn rejects instead of throwing", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const fn = async () => {
      throw new Error(HANDLER_ID_ERROR);
    };
    await expect(safeUnlisten(fn)).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("teardown race"), expect.anything());
    debug.mockRestore();
  });

  it("swallows an async handlerId race behind a Promise<UnlistenFn>", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const fn = async () => {
      throw new Error(HANDLER_ID_ERROR);
    };
    await expect(safeUnlisten(Promise.resolve(fn))).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(expect.stringContaining("teardown race"), expect.anything());
    debug.mockRestore();
  });

  it("rethrows an unexpected rejection from an async unlisten fn", async () => {
    const fn = async () => {
      throw new Error("something else entirely");
    };
    await expect(safeUnlisten(fn)).rejects.toThrow("something else entirely");
  });

  // Callers fire-and-forget (`void safeUnlisten(...)`), but anything that DOES await it — a test,
  // or a teardown sequence that must finish before the next step — needs the in-flight unlisten to
  // be done, not merely started.
  it("waits for a slow async unlisten to finish before resolving", async () => {
    let done = false;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fn = async () => {
      await gate;
      done = true;
    };

    const settled = safeUnlisten(fn).then(() => done);
    expect(done).toBe(false);
    release();
    await expect(settled).resolves.toBe(true);
  });

  it("rethrows an unexpected error from the unlisten fn", async () => {
    const fn = () => {
      throw new Error("something else entirely");
    };
    await expect(safeUnlisten(fn)).rejects.toThrow("something else entirely");
  });

  it("rethrows when the listen() promise itself rejects with an unexpected error", async () => {
    await expect(safeUnlisten(Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});
