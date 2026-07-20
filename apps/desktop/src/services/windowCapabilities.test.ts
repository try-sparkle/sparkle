// Guards the Tauri v2 ACL for the window commands the frontend calls.
//
// `core:window:default` only grants the READ side of the window API (`allow-title`, `allow-outer-position`,
// …). Every mutation — setPosition/setSize/setTitle/setFocus/… — needs its own explicit `allow-set-*`
// entry, or the invoke is rejected at runtime with "Command plugin:window|<cmd> not allowed by ACL".
//
// That failure mode is near-invisible: the call sites reject asynchronously and swallow it (a bare
// `.catch(() => {})` in Workspace's setTitle effect, a `console.debug` in runWindowRestore), and the unit
// tests around them mock `@tauri-apps/api/window` wholesale, so a missing permission type-checks, passes
// CI, and silently no-ops in the shipped app. This test reads the real capability file instead.
import { describe, expect, it } from "vitest";

import capabilities from "../../src-tauri/capabilities/default.json";

/** Window mutation commands invoked from the frontend → the call site that needs them. */
const REQUIRED_WINDOW_PERMISSIONS: Record<string, string> = {
  "core:window:allow-set-position": "runWindowRestore (windowRestoreRun.ts) — restores saved main geometry",
  "core:window:allow-set-size": "runWindowRestore (windowRestoreRun.ts) — restores saved main geometry",
  "core:window:allow-set-title": "Workspace.tsx — titles each window after its project for the macOS Window menu",
  "core:window:allow-set-focus": "focusTarget (windowRestoreRun.ts), windowRegistry",
  "core:window:allow-unminimize": "windowRegistry — reveal an existing project window",
  "core:window:allow-show": "windowRegistry, projectWindows",
  "core:window:allow-hide": "projectWindows",
  "core:window:allow-close": "projectWindows, windowRegistry",
  "core:window:allow-destroy": "projectWindows",
};

describe("default capability", () => {
  const granted = new Set(capabilities.permissions.filter((p): p is string => typeof p === "string"));

  it.each(Object.entries(REQUIRED_WINDOW_PERMISSIONS))("grants %s", (permission, callSite) => {
    expect(granted, `${permission} is invoked by ${callSite} but is not granted by the default capability`).toContain(
      permission,
    );
  });

  it("covers the main window and the runtime win-* windows", () => {
    // A window whose label matches no capability gets ZERO permissions in Tauri v2.
    expect(capabilities.windows).toContain("main");
    expect(capabilities.windows).toContain("win-*");
  });
});
