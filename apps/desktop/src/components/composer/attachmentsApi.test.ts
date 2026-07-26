// @vitest-environment jsdom
//
// The bulk-download folder prompt must NOT go through @tauri-apps/plugin-dialog's
// `open({ directory: true })`. That call is the path that killed the app in production: AppKit
// returned nil from `+[NSOpenPanel openPanel]`, objc2-app-kit's generated binding unwrapped it and
// panicked, and the plugin panicked a second time on the resulting RecvError. The project-open flow
// moved to our nil-checking `pick_folder` command; this call site did not, so a picker that refused
// to open here still took the process down. These tests pin the contract after the move.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const pickProjectFolder = vi.fn();
vi.mock("../../services/dialog", () => ({
  pickProjectFolder: (...args: unknown[]) => pickProjectFolder(...args),
}));

// The single-file Save dialog (NSSavePanel) is a different class with no observed nil failure and
// stays on the plugin; mocked so importing the module doesn't reach Tauri.
const save = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (...args: unknown[]) => save(...args) }));

import { downloadAttachments } from "./attachmentsApi";
import type { Attachment } from "./attachments";

const att = (name: string): Attachment => ({
  id: `att-${name}`,
  kind: "file",
  path: `/tmp/${name}`,
  name,
});

beforeEach(() => {
  invoke.mockReset();
  pickProjectFolder.mockReset();
  save.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("downloadAttachments", () => {
  it("copies the selection into the folder the picker returned", async () => {
    pickProjectFolder.mockResolvedValue("/tmp/sparkle-downloads");
    invoke.mockResolvedValue(undefined);

    await expect(downloadAttachments([att("a.txt"), att("b.txt")])).resolves.toBe(true);

    expect(pickProjectFolder).toHaveBeenCalledWith("Choose a download folder");
    expect(invoke).toHaveBeenCalledWith("copy_files_to_dir", {
      srcs: ["/tmp/a.txt", "/tmp/b.txt"],
      destDir: "/tmp/sparkle-downloads",
    });
  });

  it("copies nothing when the user cancels the picker", async () => {
    pickProjectFolder.mockResolvedValue(null);
    await expect(downloadAttachments([att("a.txt")])).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("survives a picker that cannot be opened, rather than taking the app down", async () => {
    // pickProjectFolder's contract is that a picker macOS refuses to vend comes back as null, so
    // this is the same shape as a cancel — the point being that it reaches JS at all.
    pickProjectFolder.mockResolvedValue(null);
    await expect(downloadAttachments([att("a.txt")])).resolves.toBe(false);
  });

  it("does not prompt at all for an empty selection", async () => {
    await expect(downloadAttachments([])).resolves.toBe(false);
    expect(pickProjectFolder).not.toHaveBeenCalled();
  });

  it("never imports the plugin's directory picker", async () => {
    // A regression guard with teeth: re-introducing `open` from the dialog plugin here
    // re-introduces the crash. Assert the raw source actually LOADED — swallowing a failed ?raw
    // import would make this an always-green no-op.
    const src = await import("./attachmentsApi?raw");
    expect(typeof src.default, "?raw import must yield the module source").toBe("string");
    // `save` may still be imported from the plugin; `open` may not — and it cannot be CALLED
    // without being imported, so pinning the import is enough. (A literal `directory: true` scan
    // would be wrong here: the comment above the function names the banned call on purpose.)
    const importLine = String(src.default).match(
      /import\s*\{([^}]*)\}\s*from\s*["']@tauri-apps\/plugin-dialog["']/,
    );
    expect(importLine?.[1] ?? "").not.toMatch(/\bopen\b/);
  });
});
