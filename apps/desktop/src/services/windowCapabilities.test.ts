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

  // Read-side window commands (monitor queries, title, position getters) come free with
  // `core:window:default` via `core:default` — see core:window.default_permission in
  // gen/schemas/acl-manifests.json. Only the `allow-set-*` MUTATIONS need enumerating, which is
  // what the map above is for. Do not add read-side commands to it: they would be redundant
  // grants that this test then makes impossible to clean up.

  it.each(Object.entries(REQUIRED_WINDOW_PERMISSIONS))("grants %s", (permission, callSite) => {
    expect(granted, `${permission} is invoked by ${callSite} but is not granted by the default capability`).toContain(
      permission,
    );
  });

  it("grants core:default, which is what covers the READ-side window commands", () => {
    // HelperApp calls availableMonitors()/currentMonitor(); those are granted by
    // core:window:default (reached via core:default), NOT by any allow-set-* entry — see
    // core:window.default_permission in gen/schemas/acl-manifests.json. Adding them explicitly is
    // a no-op, so the invariant worth guarding is that core:default is still here: dropping it
    // would silently re-reject every monitor read, park the island against a zero rect, and leave
    // the rest of the suite green.
    expect(granted).toContain("core:default");
  });

  it("covers exactly the single-window shell's webviews — and no runtime windows", () => {
    // A window whose label matches no capability gets ZERO permissions in Tauri v2 — including
    // `event.listen`, which fails at RUNTIME with "event.listen not allowed on window <label>" and
    // is invisible to typecheck and to any test that mocks @tauri-apps/api. That is exactly how the
    // helper island shipped broken for one commit: the window was created in Rust, its React tree
    // mounted fine, and every subscription silently rejected.
    //
    // So when you add a webview, add its label BOTH here and in default.json. The
    // single-window shell (CM-U7 part 2) has no runtime window creation, so the win-* glob is
    // GONE on purpose — its reappearance would mean multi-window crept back in.
    //
    // Membership, not ORDER: reordering the JSON array changes nothing about what is granted, and
    // pinning order turns a harmless edit into a failing test (roborev 46485-L). The win-* check
    // is stated separately because it is the part that actually matters.
    expect(new Set(capabilities.windows)).toEqual(new Set(["main", "helper", "capture"]));
    expect(capabilities.windows.some((w: string) => w.includes("*"))).toBe(false);
  });
});
