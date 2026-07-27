// The entry-URL parsers, which lost their test file when projectWindows.url was deleted
// (roborev 46485-M). What matters here is the ONE param with a live writer: `?view=`, which Rust
// puts on the helper and capture webviews (src-tauri/src/helper.rs, capture_window.rs) and never
// on the app window — so "no ?view=" is how the app window knows it is the app window.
//
// Assert against the views that EXIST. The previous version of this file pinned `?view=tray`, a
// webview deleted with the menu-bar tray, and said nothing about the helper island that replaced
// it — so it went on passing while `isAppWindowSearch("?view=helper")` silently returned true.
import { describe, expect, it } from "vitest";
import {
  isAppWindowSearch,
  parseAgentIdFromSearch,
  parseProjectIdFromSearch,
  parseSuppressSelfFocus,
  parseViewFromSearch,
} from "./windowIdentity";

describe("parseViewFromSearch / isAppWindowSearch", () => {
  it("names the two auxiliary webviews Rust actually opens", () => {
    expect(parseViewFromSearch("?view=helper")).toBe("helper");
    expect(parseViewFromSearch("?view=capture")).toBe("capture");
    expect(isAppWindowSearch("?view=helper")).toBe(false);
    expect(isAppWindowSearch("?view=capture")).toBe(false);
  });

  it("no longer knows `tray` — the menu-bar webview went with the helper island", () => {
    // Not merely stale-test cleanup: nothing persists a webview URL (no window-state plugin, and
    // the deep-link plugin only emits an event), so `?view=tray` has no writer and no way back.
    // It now takes the unknown-value path below, which is the safe one.
    expect(parseViewFromSearch("?view=tray")).toBeNull();
    expect(isAppWindowSearch("?view=tray")).toBe(false);
  });

  it("treats the bare app-window URL (tauri.conf.json's index.html) as the app window", () => {
    for (const search of ["", "?", "?foo=bar"]) {
      expect(parseViewFromSearch(search)).toBeNull();
      expect(isAppWindowSearch(search)).toBe(true);
    }
  });

  it("FAILS CLOSED on an unknown view value: not a known kind, but not the app window either", () => {
    // parseViewFromSearch still refuses to invent a webview kind…
    expect(parseViewFromSearch("?view=nonsense")).toBeNull();
    // …but isAppWindowSearch keys off `?view=` being ABSENT, not off the value being unrecognized.
    // The app window's URL never carries the param, so anything that does is auxiliary. The old
    // behavior here was `true`, and that is precisely what let `?view=helper` claim to be the app
    // window when the helper island shipped ahead of this module.
    expect(isAppWindowSearch("?view=nonsense")).toBe(false);
    expect(isAppWindowSearch("?view=")).toBe(false);
    expect(isAppWindowSearch("?view=some-future-webview")).toBe(false);
  });

  it("does NOT key off ?label= any more — nothing has minted one since CM-U7 part 2", () => {
    // The old predicate was "no ?label= ⇒ main", which made the helper and capture webviews report
    // themselves as main once their label writer was deleted.
    expect(isAppWindowSearch("?view=helper&label=win-123")).toBe(false);
    expect(isAppWindowSearch("?label=win-123")).toBe(true);
  });
});

describe("deep-link + focus params (parsers kept, no current writer)", () => {
  it("reads a project/agent pair when present", () => {
    expect(parseProjectIdFromSearch("?project=p1&agent=a1")).toBe("p1");
    expect(parseAgentIdFromSearch("?project=p1&agent=a1")).toBe("a1");
  });

  it("treats absent and blank as absent (a blank id must not select nothing-named)", () => {
    for (const search of ["", "?project=&agent=", "?project=%20&agent=%20"]) {
      expect(parseProjectIdFromSearch(search)).toBeNull();
      expect(parseAgentIdFromSearch(search)).toBeNull();
    }
  });

  it("suppresses self-focus only for the exact ?focus=0", () => {
    expect(parseSuppressSelfFocus("?focus=0")).toBe(true);
    expect(parseSuppressSelfFocus("?focus=1")).toBe(false);
    expect(parseSuppressSelfFocus("")).toBe(false);
  });
});
