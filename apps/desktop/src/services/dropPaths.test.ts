// The drop whose event carries NO paths — the founder-blocking case, and the one no test covered.
//
// Every drop listener used to guard with a bare `if (paths.length === 0) return;`. That is the
// exact line that swallowed "we can no longer drag photos or files into the Compose window": wry's
// macOS handler reads only the deprecated NSFilenamesPboardType, so a drag from Photos / a browser
// / Slack / the screenshot thumbnail arrives with `paths: []`, and the app discarded it in silence.
//
// WHY THE EXISTING SUITE WENT GREEN THROUGH ALL OF IT — worth stating, because the shape recurs
// (AGENTS.md "Tests must assert the SIDE EFFECT"). Composer.dropTarget.test.tsx hand-authors the
// payloads it fires, and every one of them carries a non-empty `paths` array. The empty-paths
// payload — the only one that actually happens in the failure — was never fired, so the branch that
// broke was never entered. The mock supplied the precondition that made the test vacuous.
import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveDropPaths } from "./dropPaths";
import { log } from "../logger";

beforeEach(() => {
  invoke.mockReset();
  vi.mocked(log.info).mockClear();
  vi.mocked(log.warn).mockClear();
  vi.mocked(log.error).mockClear();
});

describe("resolveDropPaths", () => {
  it("passes the event's own paths straight through, without asking Rust", async () => {
    // The Finder case, which always worked and must not now take an IPC hop per drop.
    await expect(resolveDropPaths(["/tmp/a.png"], "concierge-box")).resolves.toEqual([
      "/tmp/a.png",
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  // THE REGRESSION ITSELF. Before the fix this resolved to [] and the caller returned silently.
  it("recovers the paths from the drag pasteboard when the event carried none", async () => {
    invoke.mockResolvedValue(["/Users/x/Screenshot 2026-07-30 at 10.14.02.png"]);
    await expect(resolveDropPaths([], "concierge-box")).resolves.toEqual([
      "/Users/x/Screenshot 2026-07-30 at 10.14.02.png",
    ]);
    expect(invoke).toHaveBeenCalledWith("recover_drag_paths");
  });

  it("recovers when `paths` is absent entirely, not merely empty", async () => {
    invoke.mockResolvedValue(["/tmp/b.png"]);
    await expect(resolveDropPaths(undefined, "composer")).resolves.toEqual(["/tmp/b.png"]);
  });

  // THE DIAGNOSTIC HOLE — the reason this cost a debugging session rather than a glance at the log.
  // A drop that yields nothing must SAY so; silence is what made a 100%-broken feature look like a
  // no-op. Asserting the warning, not merely the empty return: the empty return was already true
  // before the fix, so a test that only checked the value would be vacuous.
  it("WARNS when nothing can be recovered, instead of discarding the drop in silence", async () => {
    invoke.mockResolvedValue([]);
    await expect(resolveDropPaths([], "terminal")).resolves.toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      "composer",
      "a file was dropped but the drag carried no readable path",
      { where: "terminal" },
    );
  });

  it("names the surface in the warning, so a support log says WHERE the drop died", async () => {
    invoke.mockResolvedValue([]);
    await resolveDropPaths([], "new-build-agent");
    expect(vi.mocked(log.warn).mock.calls[0]?.[2]).toEqual({ where: "new-build-agent" });
  });

  // Recovery is a backstop; its own failure must degrade to the warning rather than reject into a
  // drop handler that has no catch (which would surface as an unhandled rejection and, again,
  // no attachment and no explanation).
  it("survives the recovery command failing, and still warns", async () => {
    invoke.mockRejectedValue(new Error("command not found"));
    await expect(resolveDropPaths([], "composer")).resolves.toEqual([]);
    expect(log.error).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("logs the recovery at info with kinds and counts, never raw paths", async () => {
    // The log ships with support tickets; a recovered path carries the account name and the file's
    // own title. Same rule the other drop lines follow (services/logSafePaths).
    invoke.mockResolvedValue(["/Users/someone/private-thing.png"]);
    await resolveDropPaths([], "concierge-box");
    const [, message, detail] = vi.mocked(log.info).mock.calls[0]!;
    expect(message).toContain("recovered 1");
    expect(JSON.stringify(detail)).not.toContain("private-thing");
    expect(detail).toMatchObject({ where: "concierge-box", count: 1, kinds: { png: 1 } });
  });
});
