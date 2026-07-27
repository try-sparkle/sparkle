// @vitest-environment jsdom
//
// pickProjectFolder routes through our own `pick_folder` command rather than
// @tauri-apps/plugin-dialog, because the plugin path took the app down in production (AppKit
// returned nil from +[NSOpenPanel openPanel] → an unwrap panic → a second RecvError panic). The
// contract these tests pin is the one that fix depends on: a choice comes back, a cancel is null,
// and a REJECTED command is null too — never a thrown error escaping into the caller.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { basename, pickFiles, pickProjectFolder } from "./dialog";

/** pickProjectFolder only reaches the native path when it believes it is inside Tauri. */
function inTauri() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

beforeEach(() => {
  inTauri();
  invoke.mockReset();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("pickProjectFolder", () => {
  it("returns the chosen path and passes the title through to the command", async () => {
    invoke.mockResolvedValue("/Users/ada/projects/looper");
    const path = await pickProjectFolder("Pick a folder");
    expect(path).toBe("/Users/ada/projects/looper");
    expect(invoke).toHaveBeenCalledWith("pick_folder", { title: "Pick a folder" });
  });

  it("returns null when the user cancels (the command resolves null)", async () => {
    invoke.mockResolvedValue(null);
    expect(await pickProjectFolder()).toBeNull();
  });

  it("returns null rather than throwing when the picker cannot be opened", async () => {
    // The production failure mode: macOS refuses to vend a panel. The command rejects with a
    // user-facing message; the caller must survive it, because every call site treats null as
    // "stay where you are".
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockRejectedValue("macOS could not open the folder picker.");
    await expect(pickProjectFolder()).resolves.toBeNull();
    expect(err).toHaveBeenCalled();
  });

  it("treats an empty-string result as no selection", async () => {
    invoke.mockResolvedValue("");
    expect(await pickProjectFolder()).toBeNull();
  });

  it("does NOT go through @tauri-apps/plugin-dialog", async () => {
    // A regression guard with teeth: re-introducing the plugin's open() here re-introduces the
    // crash. If this module ever imports it again, this fails.
    // Match the IMPORT form specifically — the module's comments name the plugin on purpose,
    // explaining why we no longer use it.
    // Assert the raw source actually LOADED. Swallowing a failed ?raw import would turn this
    // guard into an always-green no-op, which is worse than not having it.
    const src = await import("./dialog?raw");
    expect(typeof src.default, "?raw import must yield the module source").toBe("string");
    expect(String(src.default)).not.toMatch(/from\s+["']@tauri-apps\/plugin-dialog["']/);
    invoke.mockResolvedValue("/tmp/x");
    await pickProjectFolder();
    expect(invoke).toHaveBeenCalledWith("pick_folder", expect.anything());
  });
});

// The file picker is the SAME command family for the same reason: +[NSOpenPanel openPanel] is one
// class method serving directories and files alike, so the nil it can return kills either caller.
describe("pickFiles", () => {
  it("returns every chosen path and passes the extension filter through", async () => {
    invoke.mockResolvedValue(["/tmp/a.png", "/tmp/b.png"]);
    const paths = await pickFiles("Attach images", ["png", "jpg"]);
    expect(paths).toEqual(["/tmp/a.png", "/tmp/b.png"]);
    expect(invoke).toHaveBeenCalledWith("pick_files", {
      title: "Attach images",
      extensions: ["png", "jpg"],
    });
  });

  it("sends a null filter — not an empty list — when no extensions are given", async () => {
    // An empty list must read as "unfiltered" on the Rust side; sending [] where the command expects
    // Option<Vec<String>> would be a panel narrowed to nothing if that ever changed meaning.
    invoke.mockResolvedValue([]);
    await pickFiles("Attach files");
    expect(invoke).toHaveBeenCalledWith("pick_files", { title: "Attach files", extensions: null });
    await pickFiles("Attach files", []);
    expect(invoke).toHaveBeenLastCalledWith("pick_files", {
      title: "Attach files",
      extensions: null,
    });
  });

  it("returns an empty list when the user cancels", async () => {
    invoke.mockResolvedValue([]);
    expect(await pickFiles("Attach files")).toEqual([]);
  });

  it("returns an empty list rather than throwing when the picker cannot be opened", async () => {
    // The production failure mode, now on the file path too.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockRejectedValue("macOS could not open the file picker.");
    await expect(pickFiles("Attach files")).resolves.toEqual([]);
    expect(err).toHaveBeenCalled();
  });

  it("drops a non-string or empty entry rather than staging a bogus path", async () => {
    invoke.mockResolvedValue(["/tmp/a.png", "", null, 7, "/tmp/b.png"]);
    expect(await pickFiles("Attach files")).toEqual(["/tmp/a.png", "/tmp/b.png"]);
  });

  it("returns an empty list outside Tauri, where there is no native panel", async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    expect(await pickFiles("Attach files")).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("basename", () => {
  it("takes the last path segment and tolerates a trailing separator", () => {
    expect(basename("/Users/ada/projects/looper")).toBe("looper");
    expect(basename("/Users/ada/projects/looper/")).toBe("looper");
  });
});
