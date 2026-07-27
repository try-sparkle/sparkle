// Guards the Tauri v2 ACL for the window commands the frontend calls.
//
// `core:window:default` only grants the READ side of the window API (`allow-title`, `allow-outer-position`,
// …). Every mutation — setPosition/setSize/setTitle/setFocus/… — needs its own explicit `allow-set-*`
// entry, or the invoke is rejected at runtime with "Command plugin:window|<cmd> not allowed by ACL".
//
// That failure mode is near-invisible: the call sites reject asynchronously and swallow it (a bare
// `.catch(() => {})` in Workspace's setTitle effect and captureSends' show/unminimize/setFocus trio), and the unit
// tests around them mock `@tauri-apps/api/window` wholesale, so a missing permission type-checks, passes
// CI, and silently no-ops in the shipped app. This test reads the real capability file instead.
import { describe, expect, it } from "vitest";

import capabilities from "../../src-tauri/capabilities/default.json";

/** Window mutation commands invoked from the frontend → the call site that needs them.
 *  set-position / set-size / close are deliberately ABSENT: their only callers died in the
 *  multi-window purge (U7 part 2), and an unused grant is attack surface. */
const REQUIRED_WINDOW_PERMISSIONS: Record<string, string> = {
  "core:window:allow-set-title": "Workspace.tsx — titles the window after its project for the macOS Window menu",
  "core:window:allow-set-focus": "main.tsx boot reveal, useAttentionNotifications, captureSends",
  "core:window:allow-unminimize": "useAttentionNotifications, captureSends — reveal the main window",
  "core:window:allow-show": "main.tsx boot reveal, useAttentionNotifications, captureSends",
  "core:window:allow-hide": "Workspace.tsx finishClose (keep-agents-running hides, never destroys)",
  "core:window:allow-destroy": "Workspace.tsx — the close-confirmed teardown path",
};

/** Grants with no frontend caller — either their callers died in the multi-window purge, or their
 *  driver was always Rust-side (which bypasses the ACL entirely): both real webviews (the helper
 *  island, capture) are built by WebviewWindowBuilder in Rust (helper.rs / capture_window.rs), and
 *  nothing left calls the positioner plugin — the island remembers its own place. Present here so a
 *  revert of the purge (or a copy-paste of the old capability
 *  file) trips a test instead of silently re-widening the ACL — webview-create in particular
 *  would let a compromised renderer spawn an arbitrary-URL webview under any label. The plugin and
 *  webview entries match by FAMILY, not exact string, so an alias grant SPELLED OUT here
 *  (positioner:allow-move-window, core:webview:allow-create-webview) can't restore the same
 *  capability under a different name.
 *
 *  What this does NOT cover (roborev 49295): permission SETS. The guard reads the literal grant
 *  list, so a set that transitively contains a retired permission passes green — today
 *  `core:default` → `core:webview:default` happens not to include allow-create-webview-window
 *  (gen/schemas/acl-manifests.json), but a Tauri bump or any plugin `*:default` could change that
 *  silently. Expanding sets means resolving the manifest at test time; until something actually
 *  grants a `*:default` that matters, the honest scope of this guard is "literal grants". */
const RETIRED_PERMISSIONS: Array<{ label: string; matches: (id: string) => boolean }> = [
  { label: "core:window:allow-set-position", matches: (id) => id === "core:window:allow-set-position" },
  { label: "core:window:allow-set-size", matches: (id) => id === "core:window:allow-set-size" },
  { label: "core:window:allow-close", matches: (id) => id === "core:window:allow-close" },
  { label: "core:webview:allow-create-webview*", matches: (id) => /^core:webview:allow-create-webview/.test(id) },
  { label: "positioner:*", matches: (id) => /^positioner:/.test(id) },
];

describe("default capability", () => {
  // Normalize both grant forms to identifiers: Tauri accepts a bare string OR a scoped object
  // ({ identifier, allow: [...] }) — this file already uses the object form for opener/http, so a
  // string-only read would let an object-form re-grant slip past the retired guard below (and
  // wrongly fail the required check for a grant merely converted to the scoped form).
  const granted = new Set(
    capabilities.permissions.map((p) => (typeof p === "string" ? p : p.identifier)),
  );

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

  it.each(RETIRED_PERMISSIONS)("does not re-grant the retired $label", ({ label, matches }) => {
    const hits = [...granted].filter(matches);
    expect(
      hits,
      `${label} has no frontend caller — its driver is Rust-side (or its callers were purged); do not re-grant it`,
    ).toEqual([]);
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
