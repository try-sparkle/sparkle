// The entry-URL parsers, which lost their test file when projectWindows.url was deleted
// (roborev 46485-M). What matters here is the ONE param with a live writer: `?view=`, which Rust
// puts on the tray and capture webviews (src-tauri/src/tray.rs, capture_window.rs) and never on
// the app window — so "no ?view=" is how the app window knows it is the app window.
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
    expect(parseViewFromSearch("?view=tray")).toBe("tray");
    expect(parseViewFromSearch("?view=capture")).toBe("capture");
    expect(isAppWindowSearch("?view=tray")).toBe(false);
    expect(isAppWindowSearch("?view=capture")).toBe(false);
  });

  it("treats the bare app-window URL (tauri.conf.json's index.html) as the app window", () => {
    for (const search of ["", "?", "?foo=bar"]) {
      expect(parseViewFromSearch(search)).toBeNull();
      expect(isAppWindowSearch(search)).toBe(true);
    }
  });

  it("ignores an unknown view value rather than inventing a webview kind", () => {
    expect(parseViewFromSearch("?view=nonsense")).toBeNull();
    // …which means it reads as the app window: an unrecognized value must not silently disable
    // the app window's own boot work.
    expect(isAppWindowSearch("?view=nonsense")).toBe(true);
  });

  it("does NOT key off ?label= any more — nothing has minted one since CM-U7 part 2", () => {
    // The old predicate was "no ?label= ⇒ main", which made the tray and capture webviews report
    // themselves as main once their label writer was deleted.
    expect(isAppWindowSearch("?view=tray&label=win-123")).toBe(false);
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
